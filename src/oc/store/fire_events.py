"""Fire-event bus — the ONE place "a trigger just fired" is announced as a LIVE cue.

Distinct from :mod:`oc.eventlog` on purpose. The log bus carries a human-facing line and is
*backfilled* (a bounded ring replays on reconnect), which is exactly wrong for a sound cue: a
reconnect would replay old fires as phantom sounds. A fire is momentary — it must reach the
browser the instant it happens and never be replayed — so it rides its own un-buffered bus and
the SSE layer forwards it live only (no backfill).

The server never plays the sound (:mod:`oc.collect.triggers` skips sound targets; the browser
plays them). This bus is that instant hand-off: the collector publishes on a real fire, the web
SSE stream pushes an ``event: fire`` carrying the trigger id, and the client resolves the
trigger's sound nodes from the graph model and plays them immediately.

Publishers may run on any thread (collector loop, request handlers), so the bus is plain and
thread-safe; subscribers that need an event loop bridge it themselves. Same shape as
:mod:`oc.store.flow_events` / :mod:`oc.store.changes` / :mod:`oc.eventlog`.
"""

from __future__ import annotations

import threading
from collections.abc import Callable

# subscriber signature: cb(game, trigger_id, sounds)
#   game: profile name; trigger_id: the trigger that fired; sounds: the sound-node ids the client
#   should play (a router may have SELECTED them by a live value). Empty -> the client falls back to
#   the trigger's own sound targets (back-compat with the pre-router cue).
_Sub = Callable[[str, str, list], None]

_lock = threading.Lock()
_subs: list[_Sub] = []


def subscribe(cb: _Sub) -> Callable[[], None]:
    """Register a fire-event subscriber; returns an unsubscribe function."""
    with _lock:
        _subs.append(cb)

    def _off() -> None:
        with _lock:
            if cb in _subs:
                _subs.remove(cb)
    return _off


def publish_fire(game: str, trigger_id: str, sounds: list | None = None) -> None:
    """Announce that ``trigger_id`` just fired for ``game`` — a live cue for the browser to play its
    sound nodes now. ``sounds`` names the sound ids to play (router-selected or the trigger's direct
    sounds); empty/None -> the client plays the trigger's own sound targets. No game/id -> dropped."""
    if not game or not trigger_id:
        return
    payload = list(sounds or [])
    with _lock:
        subs = list(_subs)
    for cb in subs:
        try:
            cb(game, trigger_id, payload)
        except Exception:  # noqa: BLE001 - one bad subscriber must never break a fire
            pass
