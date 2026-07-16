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

# subscriber signature: cb(game, dataset, records, data_changed=True). ``data_changed`` is
# False only for a metadata-only ping (learned scroll positions) that refreshes the UI but is
# not a change to the stored data — subscribers that fire on data changes (the OnChangeFirer)
# must ignore it; the rest don't care and accept it via a default.
_Sub = Callable[..., None]

_lock = threading.Lock()
_subs: list[_Sub] = []
# separate channel: a PRODUCER's sweep finished (reaped, its data written). Distinct from a dataset
# change because a sweep that fetched-but-wrote-nothing still COMPLETED — the fetch is done, which is
# the signal an ``on_ready`` trigger fires on. Subscriber signature: cb(game, node_id, dataset).
_sweep_subs: list[Callable[..., None]] = []


def subscribe(cb: _Sub) -> Callable[[], None]:
    """Register a change subscriber; returns an unsubscribe function."""
    with _lock:
        _subs.append(cb)

    def _off() -> None:
        with _lock:
            if cb in _subs:
                _subs.remove(cb)
    return _off


def subscribe_sweep_done(cb: Callable[..., None]) -> Callable[[], None]:
    """Register a sweep-completion subscriber ``cb(game, node_id, dataset)``; returns unsubscribe."""
    with _lock:
        _sweep_subs.append(cb)

    def _off() -> None:
        with _lock:
            if cb in _sweep_subs:
                _sweep_subs.remove(cb)
    return _off


def publish_sweep_done(game: str, node_id: str, dataset: str) -> None:
    """Announce that producer ``node_id``'s sweep finished (data already written). Fired from the
    reap AFTER the child's output is on disk, so a subscriber that reads the dataset sees it."""
    with _lock:
        subs = list(_sweep_subs)
    for cb in subs:
        try:
            cb(game, node_id, dataset)
        except Exception:  # noqa: BLE001 - one bad subscriber must never break teardown
            pass


def publish(game: str, dataset: str, records: list | None = None,
            *, data_changed: bool = True) -> None:
    """Announce that ``dataset`` of ``game`` changed. ``records`` are the values just
    added/updated (used by on_change trigger firing); empty/None still notifies the UI.

    ``data_changed=False`` marks a metadata-only ping (learned scroll positions): it refreshes
    the UI but did NOT change the stored data, so it must not fire on_change triggers. A real
    change with no priceable records (a clear / removal) keeps the default ``True`` — the watched
    data changed even though there is nothing new to price."""
    with _lock:
        subs = list(_subs)
    for cb in subs:
        try:
            cb(game, dataset, records or [], data_changed)
        except Exception:  # noqa: BLE001 - one bad subscriber must never break a write
            pass


class OnChangeFirer:
    """A bus subscriber that fires ``on_change`` triggers for changed datasets, coalescing a
    burst of per-record publishes (a collection tick / a sweep writes many rows) into ONE
    ``on_change`` call per dataset. ``runner_for(game)`` returns a
    :class:`oc.collect.triggers.TriggerRunner` (or None) for that game.

    Coalescing has two layers, because a trailing quiet window alone is not enough — a price
    sweep writes one row per market request (throttled SLOWER than any sane quiet window), so a
    pure time window would let every row escape into its own ``on_change`` and fire the trigger
    once per row. So while ``busy(game, dataset)`` reports a write is still in flight for that
    dataset (a running sweep), firing is DEFERRED and the records accumulate; the trigger fires
    exactly once when the dataset goes quiet. ``busy`` is injected (default: never busy) so this
    store-level module stays decoupled from the sweep machinery."""

    def __init__(self, runner_for: Callable[[str], object], delay: float = 0.25,
                 busy: Callable[[str, str], bool] | None = None) -> None:
        self._runner_for = runner_for
        self._delay = delay
        self._busy = busy
        self._pending: dict[tuple[str, str], list] = {}
        self._lock = threading.Lock()
        self._timer: threading.Timer | None = None

    def _arm_locked(self) -> None:
        """(Re)start the trailing-window timer. Caller holds ``self._lock``."""
        if self._timer is not None:
            self._timer.cancel()
        self._timer = threading.Timer(self._delay, self._flush)
        self._timer.daemon = True
        self._timer.start()

    def __call__(self, game: str, dataset: str, records: list,
                 data_changed: bool = True) -> None:
        if not dataset:
            return
        # A metadata-only ping (learned scroll positions) is not a data change -> never fires.
        # A real change with no priceable records (a clear / removal) DOES fire: the watched data
        # changed. The empty ``records`` still enqueue so the trailing-window flush calls
        # on_change, which re-evaluates every watch (direct = fire; subset = fire iff its output
        # actually changed) and prices nothing.
        if not records and not data_changed:
            return
        with self._lock:
            self._pending.setdefault((game, dataset), []).extend(records)
            self._arm_locked()

    def _flush(self) -> None:
        with self._lock:
            pending = self._pending
            self._pending = {}
            self._timer = None
        deferred: dict[tuple[str, str], list] = {}
        for (game, dataset), recs in pending.items():
            if self._busy is not None:
                try:
                    if self._busy(game, dataset):
                        deferred[(game, dataset)] = recs   # a write's still in flight -> wait it out
                        continue
                except Exception:  # noqa: BLE001 - a bad predicate must not drop the fire
                    pass
            try:
                runner = self._runner_for(game)
                if runner is not None:
                    runner.on_change(dataset, recs)
            except Exception:  # noqa: BLE001 - firing is best-effort
                pass
        if deferred:
            # nothing settled yet — keep the records and re-check after another window
            with self._lock:
                for k, v in deferred.items():
                    self._pending.setdefault(k, []).extend(v)
                if self._timer is None:
                    self._arm_locked()
