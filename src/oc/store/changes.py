"""Dataset change bus — the ONE place "a dataset's stored data changed" is announced.

Every write path funnels through :class:`oc.store.dataset_store.DatasetStore`, which calls
:func:`publish` whenever records are added/updated/removed/reverted. Subscribers react:

* the web app's SSE endpoint pushes the change to connected browsers (so any dataset write
  updates the Pretty UI at once — no polling guesswork);
* an :class:`OnChangeFirer` fires ``on_change`` triggers for the changed dataset, REGARDLESS
  of where the data came from (collector, price sweep, manual form, batch restore).

Publishers may run on any thread (collector loop, sweep workers, request handlers), so the bus
is plain and thread-safe; subscribers that need an event loop bridge it themselves.
"""

from __future__ import annotations

import threading
from collections.abc import Callable

# subscriber signature: cb(game: str, dataset: str, records: list[dict])
_Sub = Callable[[str, str, list], None]

_lock = threading.Lock()
_subs: list[_Sub] = []


def subscribe(cb: _Sub) -> Callable[[], None]:
    """Register a change subscriber; returns an unsubscribe function."""
    with _lock:
        _subs.append(cb)

    def _off() -> None:
        with _lock:
            if cb in _subs:
                _subs.remove(cb)
    return _off


def publish(game: str, dataset: str, records: list | None = None) -> None:
    """Announce that ``dataset`` of ``game`` changed. ``records`` are the values just
    added/updated (used by on_change trigger firing); empty/None still notifies the UI."""
    with _lock:
        subs = list(_subs)
    for cb in subs:
        try:
            cb(game, dataset, records or [])
        except Exception:  # noqa: BLE001 - one bad subscriber must never break a write
            pass


class OnChangeFirer:
    """A bus subscriber that fires ``on_change`` triggers for changed datasets, coalescing a
    burst of per-record publishes (a collection tick / a sweep writes many rows) into ONE
    ``on_change`` call per dataset after a short quiet window. ``runner_for(game)`` returns a
    :class:`oc.collect.triggers.TriggerRunner` (or None) for that game."""

    def __init__(self, runner_for: Callable[[str], object], delay: float = 0.25) -> None:
        self._runner_for = runner_for
        self._delay = delay
        self._pending: dict[tuple[str, str], list] = {}
        self._lock = threading.Lock()
        self._timer: threading.Timer | None = None

    def __call__(self, game: str, dataset: str, records: list) -> None:
        if not records or not dataset:
            return
        with self._lock:
            self._pending.setdefault((game, dataset), []).extend(records)
            if self._timer is not None:
                self._timer.cancel()
            self._timer = threading.Timer(self._delay, self._flush)
            self._timer.daemon = True
            self._timer.start()

    def _flush(self) -> None:
        with self._lock:
            pending = self._pending
            self._pending = {}
            self._timer = None
        for (game, dataset), recs in pending.items():
            try:
                runner = self._runner_for(game)
                if runner is not None:
                    runner.on_change(dataset, recs)
            except Exception:  # noqa: BLE001 - firing is best-effort
                pass
