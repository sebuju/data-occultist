"""High-frame-rate burst capturer for transient on-screen values (e.g. damage numbers).

The normal collection pipeline grabs ONE frame, OCRs it, confirms it over several
frames, then stores — fine for static windows, far too slow for a number that flashes
for a few frames and is gone. This module does the opposite trade-off: it **captures as
fast as the source allows (target 144 fps) and does NO processing in the loop**. Every
frame lands raw in a preallocated ring buffer with a high-resolution timestamp; OCR,
diffing, parsing — anything — happens *afterwards* by draining the ring. Capture latency
is the only thing this file optimises.

Design for speed:

- **Decoupled.** The capture thread's entire per-frame job is: grab → (optional convert)
  → copy into the next ring slot → stamp time/seq. No OCR, no locks held across the grab,
  no Python object churn. Consumers drain on their own thread/cadence.
- **Zero steady-state allocation.** The ring is N numpy buffers allocated once (lazily, on
  the first frame, since the frame shape isn't known until then). Each capture ``copyto``s
  into an existing slot — no per-frame ``np.empty``/GC pressure that would jitter pacing.
- **Backend-agnostic, reuse-only.** The source is any registered ``CaptureBackend`` built
  by name (``wgc`` recommended: DWM-composited, no per-grab game re-render hitch). When the
  backend exposes a monotonic ``frame_seq`` (WGC does), the loop **dedups** — it only stores
  a slot when a genuinely new frame arrived, so polling far above the refresh rate costs
  almost nothing and never fills the ring with identical frames. No capture logic is copied
  from the backends; this composes them.
- **Precise pacing.** On Windows ``time.sleep`` granularity is ~15 ms; we raise the timer
  resolution (``timeBeginPeriod(1)``) for the run and use a sleep-then-spin hybrid so the
  realised cadence actually tracks ``target_fps`` instead of quantising to 64 fps.

Nothing here is wired into the collector or registry yet — it's a standalone tool. Build a
:class:`FastCaptureConfig`, make a :class:`FastCapturer`, ``start(window)``, let it run,
then ``drain()`` / ``snapshot()`` the frames for downstream processing.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field

import numpy as np

from ..registry import build_capture
from ..types import Frame, FractionBox, PixelBox, WindowInfo

# perf_counter is monotonic and the highest-resolution clock available; every
# timestamp in this module comes from it so frame spacing is meaningful even when
# the wall clock is adjusted mid-run.
_now = time.perf_counter


# --------------------------------------------------------------------------- config


@dataclass
class FastCaptureConfig:
    """Every knob for a capture run. Defaults target 144 fps off a WGC stream.

    Source selection:
        ``backend``   registered capture-backend name. ``"wgc"`` (DWM-composited, costs the
                      game ~nothing per grab and exposes ``frame_seq`` for dedup) is the right
                      choice for high FPS; ``"printwindow"`` works but forces a re-render each
                      grab; ``"mss"`` grabs a raw screen region.
        ``source``    ``"window"`` grabs the located window's client area via
                      ``grab_window``; ``"region"`` grabs a fixed absolute-screen
                      ``region_px`` via ``grab`` (use with ``mss`` for a HUD corner).
        ``region``    optional sub-rectangle to keep, as a :class:`FractionBox` of the
                      grabbed client area (e.g. the damage-number corner). ``None`` keeps the
                      whole frame. Cropping less area = less to copy = higher ceiling.
        ``region_px`` absolute-screen :class:`PixelBox` for ``source="region"``.

    Rate / duration:
        ``target_fps``   pacing target; ``0`` means uncapped (spin as fast as possible).
        ``duration_s``   auto-stop after this many seconds (``None`` = until ``stop()``).
        ``max_frames``   auto-stop after this many STORED frames (``None`` = unlimited).
        ``warmup_frames``discard this many initial frames (let a WGC session spin up before
                         timing/recording).

    Ring buffer:
        ``ring_frames``  preallocated slot count. The ring holds the most recent N frames;
                         size it to ``target_fps * seconds_you_need_to_keep``.
        ``on_full``      ``"overwrite"`` (drop oldest, keep capturing — for live monitoring),
                         ``"stop"`` (end the run when the ring fills — for a fixed burst), or
                         ``"block"`` (wait for a consumer to drain; only safe with an active
                         drainer or you deadlock the capture thread).

    Per-frame transform (kept minimal — heavy work belongs in the consumer):
        ``grayscale``    store a single luma channel (1/3 the bytes to copy & keep).
        ``downscale``    integer factor to subsample by (``2`` = half W/H via stride slice;
                         cheap, no interpolation). ``1`` = none.
        ``dedup``        when the backend reports ``frame_seq``, skip storing a frame whose
                         seq hasn't advanced (no new composited frame). Counts as a dupe, not
                         a stored frame. Set ``False`` to force-store every poll.

    Pacing / scheduling:
        ``pace``         ``"hybrid"`` (sleep to ~1 ms before the deadline, then spin — precise
                         and low-CPU), ``"spin"`` (busy-wait the whole interval — most precise,
                         pins a core), or ``"sleep"`` (plain ``time.sleep`` — least precise).
        ``hi_res_timer`` raise the OS timer resolution for the run (Windows ``timeBeginPeriod``).
        ``thread_priority`` raise the capture thread to time-critical (Windows) to fight
                         scheduler-induced frame gaps.

    Hooks:
        ``on_frame``     optional callback ``(seq, t, image) -> None`` invoked IN the capture
                         thread per stored frame. Keep it trivial (a counter, an event set);
                         anything heavy reintroduces the latency this module exists to avoid.
    """

    # source
    backend: str = "wgc"
    source: str = "window"          # "window" | "region"
    region: FractionBox | None = None
    region_px: PixelBox | None = None

    # rate / duration
    target_fps: float = 144.0
    duration_s: float | None = None
    max_frames: int | None = None
    warmup_frames: int = 0

    # ring
    ring_frames: int = 288          # ~2 s at 144 fps
    on_full: str = "overwrite"      # "overwrite" | "stop" | "block"

    # per-frame transform
    grayscale: bool = False
    downscale: int = 1
    dedup: bool = True

    # pacing / scheduling
    pace: str = "hybrid"            # "hybrid" | "spin" | "sleep"
    hi_res_timer: bool = True
    thread_priority: bool = True

    # hooks
    on_frame: Callable[[int, float, np.ndarray], None] | None = None

    def interval(self) -> float:
        """Seconds per frame for the target rate; ``0`` when uncapped."""
        return 1.0 / self.target_fps if self.target_fps and self.target_fps > 0 else 0.0


# --------------------------------------------------------------------------- frame + ring


@dataclass(frozen=True)
class CapturedFrame:
    """One ring entry handed to a consumer.

    ``image`` is a copy owned by the consumer (drained out of the ring), so the capture
    thread may safely overwrite its slot afterwards. ``t`` is a ``perf_counter`` stamp at
    grab time; ``seq`` is this capturer's stored-frame index; ``src_seq`` is the backend's
    own frame counter (``-1`` if it doesn't report one).
    """

    seq: int
    t: float
    image: np.ndarray
    src_seq: int


class _Ring:
    """Preallocated ring of uint8 image buffers + parallel timestamp/seq arrays.

    Buffers are allocated lazily on the first ``write`` (shape unknown before then) and
    reused thereafter; a frame whose shape changes (window resize) triggers a one-off
    reallocation. All public methods are cheap and lock-guarded; the capture thread holds
    the lock only for the ``copyto`` + index bump, never across a grab.
    """

    def __init__(self, capacity: int) -> None:
        self._cap = max(1, capacity)
        self._buf: list[np.ndarray] | None = None
        self._shape: tuple[int, ...] | None = None
        self._t = np.zeros(self._cap, dtype=np.float64)
        self._seq = np.full(self._cap, -1, dtype=np.int64)
        self._src = np.full(self._cap, -1, dtype=np.int64)
        self._head = 0          # next slot to write
        self._count = 0         # live frames (<= cap)
        self._written = 0       # total ever written (monotonic)
        self._lock = threading.Lock()

    @property
    def capacity(self) -> int:
        return self._cap

    def _alloc(self, shape: tuple[int, ...]) -> None:
        self._buf = [np.empty(shape, dtype=np.uint8) for _ in range(self._cap)]
        self._shape = shape

    def full(self) -> bool:
        with self._lock:
            return self._count >= self._cap

    def write(self, image: np.ndarray, t: float, seq: int, src_seq: int) -> None:
        """Copy ``image`` into the next slot (drop-oldest). Reallocates if shape changed."""
        with self._lock:
            if self._buf is None or image.shape != self._shape:
                self._alloc(image.shape)
            np.copyto(self._buf[self._head], image)
            self._t[self._head] = t
            self._seq[self._head] = seq
            self._src[self._head] = src_seq
            self._head = (self._head + 1) % self._cap
            self._count = min(self._count + 1, self._cap)
            self._written += 1

    def _ordered_indices(self) -> list[int]:
        # Oldest -> newest physical slot order for the currently-live frames.
        if self._count < self._cap:
            return list(range(self._count))
        return [(self._head + i) % self._cap for i in range(self._cap)]

    def drain(self) -> list[CapturedFrame]:
        """Remove and return all live frames, oldest first. Copies pixels out."""
        with self._lock:
            out = [
                CapturedFrame(int(self._seq[i]), float(self._t[i]),
                              self._buf[i].copy(), int(self._src[i]))
                for i in self._ordered_indices()
            ]
            self._count = 0
            self._head = 0
            return out

    def snapshot(self) -> list[CapturedFrame]:
        """Copy out all live frames WITHOUT clearing the ring (oldest first)."""
        with self._lock:
            return [
                CapturedFrame(int(self._seq[i]), float(self._t[i]),
                              self._buf[i].copy(), int(self._src[i]))
                for i in self._ordered_indices()
            ]

    def latest(self) -> CapturedFrame | None:
        with self._lock:
            if self._count == 0:
                return None
            i = (self._head - 1) % self._cap
            return CapturedFrame(int(self._seq[i]), float(self._t[i]),
                                 self._buf[i].copy(), int(self._src[i]))

    def written(self) -> int:
        with self._lock:
            return self._written


# --------------------------------------------------------------------------- stats


@dataclass
class CaptureStats:
    """Measured outcome of a run — read live or after ``stop()``."""

    stored: int = 0          # frames written to the ring
    polls: int = 0           # loop iterations (grabs attempted)
    dupes: int = 0           # grabs skipped as unchanged (dedup)
    empty: int = 0           # grabs that returned no pixels (minimized / not ready)
    dropped: int = 0         # frames overwritten before a consumer drained them
    started: float = 0.0
    stopped: float = 0.0
    first_t: float = field(default=0.0)
    last_t: float = field(default=0.0)

    @property
    def elapsed(self) -> float:
        end = self.stopped or _now()
        return max(0.0, end - self.started) if self.started else 0.0

    @property
    def fps(self) -> float:
        """Realised store rate over the span of stored frames."""
        span = self.last_t - self.first_t
        return (self.stored - 1) / span if self.stored > 1 and span > 0 else 0.0

    @property
    def poll_fps(self) -> float:
        e = self.elapsed
        return self.polls / e if e > 0 else 0.0


# --------------------------------------------------------------------------- pacing


def _spin_until(deadline: float) -> None:
    while _now() < deadline:
        pass


def _pace_wait(deadline: float, mode: str) -> None:
    """Block until ``deadline`` per the pacing mode (see :class:`FastCaptureConfig`)."""
    if mode == "spin":
        _spin_until(deadline)
        return
    remaining = deadline - _now()
    if remaining <= 0:
        return
    if mode == "sleep":
        time.sleep(remaining)
        return
    # hybrid: sleep most of it, spin the last ~1 ms where sleep is too coarse.
    if remaining > 0.0015:
        time.sleep(remaining - 0.0010)
    _spin_until(deadline)


class _TimerResolution:
    """Context manager raising the Windows multimedia timer to 1 ms for the run.

    No-op (and silent) off Windows or if winmm is unavailable, so callers don't branch.
    """

    def __init__(self, enabled: bool, ms: int = 1) -> None:
        self._enabled = enabled
        self._ms = ms
        self._winmm = None

    def __enter__(self) -> _TimerResolution:
        if not self._enabled:
            return self
        try:
            import ctypes

            self._winmm = ctypes.WinDLL("winmm")
            self._winmm.timeBeginPeriod(self._ms)
        except Exception:
            self._winmm = None
        return self

    def __exit__(self, *exc) -> None:
        if self._winmm is not None:
            try:
                self._winmm.timeEndPeriod(self._ms)
            except Exception:
                pass
            self._winmm = None


def _raise_thread_priority(enabled: bool) -> None:
    """Bump the CURRENT thread to time-critical on Windows. Best-effort, silent."""
    if not enabled:
        return
    try:
        import ctypes

        THREAD_PRIORITY_TIME_CRITICAL = 15
        handle = ctypes.windll.kernel32.GetCurrentThread()
        ctypes.windll.kernel32.SetThreadPriority(handle, THREAD_PRIORITY_TIME_CRITICAL)
    except Exception:
        pass


# --------------------------------------------------------------------------- capturer


class FastCapturer:
    """Runs a high-FPS capture loop on a dedicated thread, filling a frame ring.

    Lifecycle::

        cap = FastCapturer(FastCaptureConfig(backend="wgc", target_fps=144))
        cap.start(window)            # window: WindowInfo (source="window")
        ...                          # frames accumulate in the ring
        frames = cap.drain()         # pull what's there, any time
        cap.stop()                   # join the thread
        print(cap.stats.fps)

    or block for a fixed burst::

        frames = FastCapturer(cfg).run(window)   # start, wait for stop condition, return drain()
    """

    def __init__(self, config: FastCaptureConfig | None = None) -> None:
        self.config = config or FastCaptureConfig()
        self._backend = build_capture(self.config.backend)
        self._ring = _Ring(self.config.ring_frames)
        self.stats = CaptureStats()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._window: WindowInfo | None = None

    # -- public API -------------------------------------------------------

    def start(self, window: WindowInfo | None = None) -> FastCapturer:
        """Spawn the capture thread and begin filling the ring. Non-blocking."""
        if self._thread is not None:
            raise RuntimeError("capturer already started")
        if self.config.source == "window" and window is None:
            raise ValueError("source='window' needs a WindowInfo passed to start()")
        if self.config.source == "region" and self.config.region_px is None:
            raise ValueError("source='region' needs config.region_px set")
        self._window = window
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="fastcap", daemon=True)
        self._thread.start()
        return self

    def stop(self, timeout: float = 2.0) -> CaptureStats:
        """Signal the loop to end and join the thread. Returns final stats."""
        self._stop.set()
        t = self._thread
        if t is not None:
            t.join(timeout)
        self._thread = None
        self._close_backend()
        return self.stats

    def run(self, window: WindowInfo | None = None) -> list[CapturedFrame]:
        """Start, block until a stop condition (``duration_s``/``max_frames``/full+stop)
        fires, then stop and return all captured frames. For a one-shot burst."""
        if self.config.duration_s is None and self.config.max_frames is None \
                and self.config.on_full != "stop":
            raise ValueError("run() needs a stop condition: set duration_s, max_frames, "
                             "or on_full='stop'")
        self.start(window)
        t = self._thread
        if t is not None:
            t.join()
        self._close_backend()
        return self._ring.snapshot()

    def drain(self) -> list[CapturedFrame]:
        """Remove and return all buffered frames (oldest first). Safe while running."""
        return self._ring.drain()

    def snapshot(self) -> list[CapturedFrame]:
        """Copy out buffered frames without clearing the ring."""
        return self._ring.snapshot()

    def latest(self) -> CapturedFrame | None:
        """Most recent stored frame, or ``None``."""
        return self._ring.latest()

    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def __enter__(self) -> FastCapturer:
        return self

    def __exit__(self, *exc) -> None:
        self.stop()

    # -- internals --------------------------------------------------------

    def _close_backend(self) -> None:
        close = getattr(self._backend, "close", None)
        if callable(close):
            try:
                close()
            except Exception:
                pass

    def _grab(self) -> Frame:
        if self.config.source == "region":
            return self._backend.grab(self.config.region_px)
        return self._backend.grab_window(self._window)

    def _src_seq(self) -> int:
        # WGC exposes a monotonic frame_seq; others don't -> -1 (dedup disabled).
        return int(getattr(self._backend, "frame_seq", -1))

    def _transform(self, image: np.ndarray) -> np.ndarray:
        cfg = self.config
        if cfg.region is not None:
            h, w = image.shape[:2]
            b = cfg.region.to_pixels(w, h)
            image = image[b.y:b.y + b.h, b.x:b.x + b.w]
        if cfg.downscale > 1:
            image = image[::cfg.downscale, ::cfg.downscale]
        if cfg.grayscale and image.ndim == 3:
            # Luma without cv2: weighted BGR -> uint8. Contiguous result for fast copy.
            image = (image[:, :, 0] * 0.114 + image[:, :, 1] * 0.587
                     + image[:, :, 2] * 0.299).astype(np.uint8)
        return np.ascontiguousarray(image)

    def _loop(self) -> None:
        cfg = self.config
        _raise_thread_priority(cfg.thread_priority)
        interval = cfg.interval()
        stored = 0
        warmup_left = cfg.warmup_frames
        last_src = -1
        self.stats = CaptureStats(started=_now())
        st = self.stats

        with _TimerResolution(cfg.hi_res_timer):
            next_deadline = _now()
            while not self._stop.is_set():
                if interval:
                    _pace_wait(next_deadline, cfg.pace)
                    # Advance deadline; if we fell behind, resync to now so we don't
                    # spin trying to "catch up" a backlog of missed frames.
                    next_deadline += interval
                    now = _now()
                    if next_deadline < now - interval:
                        next_deadline = now + interval

                if self.config.duration_s is not None and \
                        _now() - st.started >= self.config.duration_s:
                    break

                t = _now()
                try:
                    frame = self._grab()
                except Exception:
                    st.empty += 1
                    continue
                st.polls += 1

                img = frame.image
                if img is None or img.size == 0 or (img.shape[0] <= 1 and img.shape[1] <= 1):
                    st.empty += 1
                    continue

                src_seq = self._src_seq()
                if cfg.dedup and src_seq >= 0 and src_seq == last_src:
                    st.dupes += 1
                    continue
                last_src = src_seq

                if warmup_left > 0:
                    warmup_left -= 1
                    continue

                out = self._transform(img)

                if cfg.on_full == "block":
                    while self._ring.full() and not self._stop.is_set():
                        time.sleep(0.0002)
                elif cfg.on_full == "stop" and self._ring.full():
                    break
                else:  # overwrite: count an about-to-be-clobbered frame as dropped
                    if self._ring.full():
                        st.dropped += 1

                self._ring.write(out, t, stored, src_seq)
                if stored == 0:
                    st.first_t = t
                st.last_t = t
                stored += 1
                st.stored = stored

                if cfg.on_frame is not None:
                    try:
                        cfg.on_frame(stored - 1, t, out)
                    except Exception:
                        pass

                if cfg.max_frames is not None and stored >= cfg.max_frames:
                    break

        st.stopped = _now()


# --------------------------------------------------------------------------- helpers


def burst(window: WindowInfo, *, fps: float = 144.0, seconds: float = 1.0,
          backend: str = "wgc", region: FractionBox | None = None,
          **overrides) -> list[CapturedFrame]:
    """Convenience: capture a fixed ``seconds`` burst at ``fps`` and return the frames.

    Equivalent to building a :class:`FastCaptureConfig`, ``run()``-ing it, and returning
    the result — for quick scripts/benchmarks. Extra ``**overrides`` set any config field.
    """
    cfg = FastCaptureConfig(backend=backend, target_fps=fps, duration_s=seconds,
                            region=region, ring_frames=max(1, int(fps * seconds) + 8),
                            **overrides)
    return FastCapturer(cfg).run(window)


def iter_drained(cap: FastCapturer, poll: float = 0.01) -> Iterator[CapturedFrame]:
    """Yield frames as they arrive by draining the ring on a light poll, until the
    capturer stops and the ring empties. Lets a consumer process at its own pace while
    capture stays decoupled and full-speed."""
    while True:
        frames = cap.drain()
        for f in frames:
            yield f
        if not cap.is_running() and not frames:
            return
        if not frames:
            time.sleep(poll)
