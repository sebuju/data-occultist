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

import threading
import time

from ..engine import Engine
from ..profile.models import GameProfile
from .collector import Collector, TickStatus


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
        self._t0 = 0.0
        self._error: str | None = None

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

    def start(self, interval: float = 1.0) -> None:
        if self.is_running():
            return
        self._join_prev()
        with self._lock:
            self._interval = max(0.1, float(interval))
            self._recog = {}
            self._written = 0
            self._frames = 0
            self._cur = (None, None)
            self._error = None
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
        try:
            collector = Collector(self._engine, self._profile)
            # Collector.run owns the trigger loop + flushes via close() on the way out.
            collector.run(self._interval, on_tick=self._on_tick, should_stop=self._stop.is_set)
        except Exception as exc:  # pragma: no cover - defensive
            with self._lock:
                self._error = str(exc)

    def _on_tick(self, result) -> None:
        with self._lock:
            self._frames += 1
            self._written += result.new
            if result.status is TickStatus.saved:
                self._cur = (result.window_id, result.state_id)
                key = f"{result.window_id}/{result.state_id}"
            else:
                self._cur = (None, None)
                key = result.status.value   # no_window / not_foreground / unrecognised / state_invalid
            self._recog[key] = self._recog.get(key, 0) + 1

    # ---- status ------------------------------------------------------------

    def status(self) -> dict:
        with self._lock:
            running = self.is_running()
            elapsed = max(1e-3, time.monotonic() - self._t0) if self._t0 else 1e-3
            return {
                "running": running,
                "frames": self._frames,
                "written": self._written,
                "fps": round(self._frames / elapsed, 1) if running else 0.0,
                "window": self._cur[0],
                "state": self._cur[1],
                "recognized": [{"key": k, "count": n, "miss": k in ("", "unrecognised", "no_window")}
                               for k, n in sorted(self._recog.items(), key=lambda kv: kv[1], reverse=True)],
                "error": self._error,
            }
