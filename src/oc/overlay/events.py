"""Overlay-visibility bus — the ONE place "these overlays are showing now" is announced.

Same shape and same reasoning as :mod:`oc.store.fire_events`: deliberately **un-buffered**, with no
backfill. Overlay visibility is a statement about *now*; replaying it on an SSE reconnect would pop
an overlay back up long after the state that justified it went away — the visual equivalent of the
phantom-sound problem that bus exists to avoid.

The server never draws the overlay. It resolves *which* overlays should be visible (window state,
gate, trigger pulse, manual toggle — see :mod:`oc.overlay.manager`) and publishes that set; the
overlay page subscribes over the existing SSE stream and shows/hides in the DOM. The child process
is told only whether the whole WINDOW should be up, never which widgets are in it.

Publishers may run on any thread (collector loop, trigger runner, request handlers), so the bus is
plain and thread-safe; subscribers that need an event loop bridge it themselves.
"""

from __future__ import annotations

import threading
from collections.abc import Callable

# subscriber signature: cb(game, overlay_ids)
#   game: profile name; overlay_ids: the overlay-node ids that should be visible right now (the
#   FULL set, not a delta — a subscriber that missed an event still converges on the next one).
_Sub = Callable[[str, list], None]

_lock = threading.Lock()
_subs: list[_Sub] = []
# Last published set per game, so a late subscriber (a page that connected after the state
# settled) can be handed the current truth without waiting for the next change. This is a
# CURRENT-STATE read, not a replay log — see the module docstring.
_state: dict[str, list] = {}


def subscribe(cb: _Sub) -> Callable[[], None]:
    """Register an overlay-visibility subscriber; returns an unsubscribe function."""
    with _lock:
        _subs.append(cb)

    def _off() -> None:
        with _lock:
            if cb in _subs:
                _subs.remove(cb)
    return _off


def current(game: str) -> list:
    """The overlay ids currently visible for ``game`` — what a newly-connected page needs to
    render immediately. Empty when nothing is showing or the game is unknown."""
    with _lock:
        return list(_state.get(game) or [])


def publish_overlays(game: str, overlay_ids: list | None = None) -> None:
    """Announce the set of overlays that should be visible for ``game`` right now.

    No-ops when the set is unchanged, so a resolver may call this every gate tick (0.25s) without
    waking every subscriber — the steady state is free, mirroring how the dataset bus only fires on
    a real change.
    """
    if not game:
        return
    payload = sorted(str(o) for o in (overlay_ids or []) if o)
    with _lock:
        if _state.get(game) == payload:
            return          # unchanged — steady state must cost nothing
        _state[game] = payload
        subs = list(_subs)
    for cb in subs:
        try:
            cb(game, list(payload))
        except Exception:  # noqa: BLE001 - one bad subscriber must never break the resolver
            pass


def reset(game: str | None = None) -> None:
    """Forget the remembered visibility (one game, or all). Used on live-session stop and by
    tests, so a stale 'visible' set can't leak into the next run."""
    with _lock:
        if game is None:
            _state.clear()
        else:
            _state.pop(game, None)
