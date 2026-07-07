"""Live collection: run the real collector pipeline in a background thread.

The web UI's live mode used to be read-only (detect + OCR preview for tuning). This
makes it actually COLLECT — capture -> classify -> valid_for_save -> read -> confirm
(``tuning.confirm_frames``) -> dedup -> ``DatasetStore`` -> triggers — the exact same
:class:`Collector` the CLI ``collect`` command drives. So data flows into datasets live
(the only way to capture reward-only datasets like ``relics_offered``, which then feed
their downstream views/triggers).

One :class:`LiveSession` per game, cached for the server's life. Thread-safe; status is
polled through the activity heartbeat. The worker runs even when the game is backgrounded
(PrintWindow capture), so collection doesn't need the window focused.
"""

from __future__ import annotations

import collections
import threading
import time

from ..engine import Engine
from ..ocr.device_switch import enter_device, exit_device
from ..profile.models import GameProfile
from .collector import Collector, TickStatus

# How many recent debug entries the live session keeps for the panel's debug log. Bounded so a
# long-running collector can't grow memory without limit; the UI polls incrementally by seq.
_DEBUG_CAP = 300


class LiveSession:
    """A toggleable live-collection worker for one game. All public methods are thread-safe."""

    def __init__(self, engine: Engine, profile: GameProfile) -> None:
        self._engine = engine
        self._profile = profile
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._interval = 1.0
        # rolling status (read by status(); written by the worker thread under the lock)
        self._recog: dict[str, int] = {}   # "window/state" frame tally ("" = miss/unrecognised)
        self._written = 0                  # records added/updated this run
        self._frames = 0                   # ticks processed
        self._cur: tuple[str | None, str | None] = (None, None)
        self._phase = False                # was the latest tick reading/holding a recognised window?
        self._last_status = "no_window"    # raw TickStatus of the latest tick (why we're not reading)
        self._scroll: tuple[float, float] | None = None   # latest mirror visible row-index span
        self._scroll_meta: dict | None = None             # latest mirror calibration snapshot
        self._readouts: dict[str, object] = {}           # latest live readout values (ephemeral)
        self._readout_confs: dict[str, float] = {}       # confidence per readout value (UI display only)
        # Register-node maps: {register_id: {readout_id: {value, conf, first_seen, last_seen}}}. Held
        # in server memory only (never persisted). Fed from readouts each tick; deliberately NOT
        # reset by start() — a register accumulates across runs and is wiped only by clear_register.
        self._registers: dict[str, dict[str, dict]] = {}
        self._t0 = 0.0
        self._error: str | None = None
        # Debug log ring: recent OCR-heavy ticks (raw reads, corrections, what was written to
        # which dataset). Bounded; the panel polls incrementally by monotonic seq. Only ticks
        # that actually read or wrote are recorded, so an idle/gate-closed run stays quiet.
        self._debug: collections.deque = collections.deque(maxlen=_DEBUG_CAP)
        self._debug_seq = 0
        # "auto" device policy: set to "gpu" by the web layer to run the live loop on GPU
        # (every frame OCRs many regions -> GPU throughput wins), then restore the baseline
        # device on stop (which frees the GPU). None = use whatever device the engine is on.
        self.batch_device: str | None = None

    # ---- profile -----------------------------------------------------------

    def update_profile(self, profile: GameProfile) -> None:
        """Swap in a freshly-loaded profile — never mid-run (the collector reads it every
        tick). A no-op while collecting; the next start picks it up."""
        with self._lock:
            if self.is_running():
                return
            self._profile = profile

    # ---- control -----------------------------------------------------------

    def is_running(self) -> bool:
        t = self._thread
        return bool(t is not None and t.is_alive())

    def start(self, interval: float | None = None) -> None:
        if self.is_running():
            return
        if interval is None:
            interval = self._engine.settings.tuning.collect_interval
        self._join_prev()
        with self._lock:
            self._interval = max(0.0, float(interval))
            self._recog = {}
            self._written = 0
            self._frames = 0
            self._cur = (None, None)
            self._phase = False
            self._last_status = "no_window"
            self._scroll = None
            self._scroll_meta = None
            self._readouts = {}
            self._readout_confs = {}
            self._error = None
            self._debug.clear()
            self._debug_seq = 0
            self._t0 = time.monotonic()
            self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> bool:
        """Stop the worker and wait for it to flush + exit. Returns True if it died."""
        self._stop.set()
        t = self._thread
        if t is not None and t.is_alive():
            t.join(timeout)
        return not self.is_running()

    def _join_prev(self) -> None:
        t = self._thread
        if t is not None and t.is_alive():
            self._stop.set()
            t.join(timeout=5.0)
        self._thread = None

    # ---- worker ------------------------------------------------------------

    def _loop(self) -> None:
        restore = enter_device(self._engine, self.batch_device)
        try:
            collector = Collector(self._engine, self._profile)
            collector.on_frame = self._save_frame   # persist a frame only when a record was written
            # Collector.run owns the trigger loop + flushes via close() on the way out.
            collector.run(self._interval, on_tick=self._on_tick, should_stop=self._stop.is_set)
        except Exception as exc:  # pragma: no cover - defensive
            with self._lock:
                self._error = str(exc)
        finally:
            exit_device(self._engine, restore)

    def _save_frame(self, frame) -> None:
        """Save one frame into the game's live/ image bucket — the same bucket the read-only
        tuning loop writes to. Only called on a tick that WROTE a record, so the bucket fills
        with frames that produced data, not every recognised grab. Best-effort: an encode/disk
        hiccup must never disturb collection."""
        try:
            import cv2

            from ..web import captures_store
            ok, buf = cv2.imencode(".jpg", frame.image, [cv2.IMWRITE_JPEG_QUALITY, 90])
            if ok:
                captures_store.save(self._engine.settings.captures_dir, self._profile.name,
                                    buf.tobytes(), sub=captures_store.LIVE)
        except Exception:  # pragma: no cover - defensive
            pass

    def _on_tick(self, result) -> None:
        with self._lock:
            self._frames += 1
            self._written += result.new
            if result.readouts:
                self._readouts.update(result.readouts)   # latest live values for the UI (ephemeral)
                self._readout_confs.update(result.readout_confs or {})
                # feed from the full accumulated map (every readout seen all session), not just this
                # tick's delta -- a register wired to a readout from a window that isn't the one just
                # read would otherwise wait for that window to be revisited before showing anything.
                self._feed_registers(self._readouts, self._readout_confs)
            self._last_status = result.status.value   # why we are / aren't reading right now
            # phase = we're in an OCR-worthy screen. A `saved` tick read it; a `throttled` tick
            # is the SAME screen between two-rate OCR slots (not re-read) — both count as "in a
            # phase", so the live view stays steady instead of flickering to idle every slot.
            if result.status is TickStatus.saved:
                self._phase = True
                self._cur = (result.window_id, result.state_id)
                self._scroll = result.scroll   # None unless a mirror dataset read its scrollbar
                self._scroll_meta = result.scroll_meta
                key = f"{result.window_id}/{result.state_id}"
            elif result.status is TickStatus.throttled:
                self._phase = True             # still in the phase; KEEP _cur (don't reset)
                key = "throttled"
            else:
                self._phase = False
                self._cur = (None, None)
                key = result.status.value   # idle / no_window / not_foreground / unrecognised / state_invalid
            self._recog[key] = self._recog.get(key, 0) + 1
            # Debug log: record a tick that actually READ something new or WROTE a record. A
            # cache-hit / throttled / idle tick carries no reads, so it never spams the log.
            reads = getattr(result, "reads", None) or []
            if reads or result.new:
                self._debug_seq += 1
                self._debug.append({
                    "seq": self._debug_seq,
                    "t": time.time(),
                    "window": result.window_id,
                    "state": result.state_id,
                    "dataset": result.dataset,
                    "new": result.new,
                    "read": result.read,
                    "kept": result.kept,
                    "reads": reads,
                    # written keys/values this tick (added or updated) — the "pushed to dataset" side
                    "changed": [{k: v for k, v in c.items() if not str(k).startswith("_")}
                                for c in (result.changed or [])],
                })

    # ---- registers ---------------------------------------------------------

    @staticmethod
    def _readout_ref(src: str) -> str | None:
        """Bare readout id from a register source ref. Sources are prefixed ``"readout:<id>"``
        (the ToastDef.sources shape); a bare ``"<id>"`` is tolerated. Non-readout refs -> None."""
        if ":" in src:
            kind, _, rid = src.partition(":")
            return rid if kind == "readout" else None
        return src or None

    def _feed_registers(self, readouts: dict, confs: dict) -> None:
        """Overwrite each register's held entries from the accumulated live-readout map (caller
        holds the lock) -- so a newly-wired source picks up its value immediately from whatever
        window last reported it, not only when its own window is next read. Key = readout id;
        value/conf/last_seen overwrite, first_seen is kept. A source never seen this session is
        simply skipped (nothing to show yet)."""
        now = time.time()
        for reg in getattr(self._profile, "registers", []) or []:
            if not getattr(reg, "enabled", True):
                continue
            for src in reg.sources or []:
                rid = self._readout_ref(src)
                if rid is None or rid not in readouts:
                    continue
                m = self._registers.setdefault(reg.id, {})
                prev = m.get(rid)
                m[rid] = {
                    "value": readouts[rid],
                    "conf": confs.get(rid),
                    "first_seen": prev["first_seen"] if prev else now,
                    "last_seen": now,
                }

    def register_records(self, reg_id: str) -> list[dict]:
        """Current held map for one register as table rows (newest last_seen first)."""
        with self._lock:
            m = self._registers.get(reg_id) or {}
            rows = [{"key": rid, "value": e["value"], "conf": e["conf"],
                     "first_seen": e["first_seen"], "last_seen": e["last_seen"]}
                    for rid, e in m.items()]
        rows.sort(key=lambda r: r["last_seen"], reverse=True)
        return rows

    def clear_register(self, reg_id: str) -> None:
        """Drop every held entry for one register (its map button)."""
        with self._lock:
            self._registers.pop(reg_id, None)

    # ---- status ------------------------------------------------------------

    def debug(self, after: int = 0) -> dict:
        """Debug-log entries with seq > ``after`` (incremental poll). ``seq`` is the newest
        entry number so a caller knows the high-water mark even when nothing is newer."""
        with self._lock:
            return {
                "running": self.is_running(),
                "seq": self._debug_seq,
                "entries": [e for e in self._debug if e["seq"] > after],
            }

    def status(self) -> dict:
        with self._lock:
            running = self.is_running()
            elapsed = max(1e-3, time.monotonic() - self._t0) if self._t0 else 1e-3
            return {
                "running": running,
                "frames": self._frames,
                "written": self._written,
                "interval": self._interval,   # frame limiter (seconds); lets a reloaded UI restore the limit input
                "fps": round(self._frames / elapsed, 1) if running else 0.0,
                "window": self._cur[0],
                "state": self._cur[1],
                "phase": self._phase and running,   # currently reading a data window (a worthy screen)
                "phase_status": self._last_status,  # raw TickStatus — WHY we're not reading (throttled / unrecognised / …)
                "scroll": list(self._scroll) if self._scroll else None,   # [vlo,vhi] row-index span, or null
                "scroll_meta": self._scroll_meta,   # {total,viewport,gain,confident,pinned} or null
                "readouts": dict(self._readouts),   # {readout_id: value} live ephemeral values (never stored)
                "readout_confs": dict(self._readout_confs),   # {readout_id: confidence} for the values above (UI only)
                "recognized": [{"key": k, "count": n, "miss": k in ("", "idle", "unrecognised", "no_window")}
                               for k, n in sorted(self._recog.items(), key=lambda kv: kv[1], reverse=True)],
                "error": self._error,
            }
