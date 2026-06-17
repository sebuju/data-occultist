"""Flow-event bus — the ONE place "data just moved along a graph edge" is announced.

Distinct from :mod:`oc.store.changes` on purpose. The change bus says *a dataset's stored
data changed* (its payload is a dataset name; it drives Pretty refetch + on_change triggers,
and coalesces bursts). This bus instead carries a **directed, counted hop** for the graph's
blob animation: which node wrote, which node received, how many items, and the edge kind.
Overloading the change bus would muddy both — refetch wants dedup, the animation wants every
distinct hop.

A publisher is any real write site (a collection tick, a price sweep, a trigger firing). The
ids use the SAME scheme as the front-end graph model nodes/edges, so the browser can map an
event straight onto an existing edge:

* ``win:<id>``, ``ds:<id>``, ``sub:<id>``, ``price:<id>``, ``trigger:<id>``
* ``kind`` is one of ``"data"`` (orange), ``"trigger"`` (cyan), ``"watch"`` (teal) — the
  same edge classes drawn in ``model.js`` / ``graph.css``.

Publishers may run on any thread (collector loop, sweep workers, request handlers), so the bus
is plain and thread-safe; subscribers that need an event loop bridge it themselves.
"""

from __future__ import annotations

import threading
from collections.abc import Callable

# subscriber signature: cb(game, kind, src, dst, n)
#   game: profile name; kind: "data"|"trigger"|"watch"; src/dst: graph node ids; n: item count
_Sub = Callable[[str, str, str, str, int], None]

_lock = threading.Lock()
_subs: list[_Sub] = []


def subscribe(cb: _Sub) -> Callable[[], None]:
    """Register a flow-event subscriber; returns an unsubscribe function."""
    with _lock:
        _subs.append(cb)

    def _off() -> None:
        with _lock:
            if cb in _subs:
                _subs.remove(cb)
    return _off


def publish_flow(game: str, kind: str, src: str, dst: str, n: int) -> None:
    """Announce that ``n`` items just moved from node ``src`` to node ``dst`` (edge ``kind``)
    for ``game``. ``src``/``dst`` are graph node ids ("win:<id>", "ds:<id>", "sub:<id>",
    "price:<id>", "trigger:<id>"). A non-positive ``n`` is dropped (nothing to animate)."""
    if n <= 0 or not src or not dst:
        return
    with _lock:
        subs = list(_subs)
    for cb in subs:
        try:
            cb(game, kind, src, dst, int(n))
        except Exception:  # noqa: BLE001 - one bad subscriber must never break a write
            pass
