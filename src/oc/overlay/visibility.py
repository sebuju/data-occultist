"""Which overlays should be on screen right now — the one place that question is answered.

Four independent sources can show an overlay, and they compose (:class:`oc.profile.models.OverlayDef`):

* ``manual`` — forced on from the node, for authoring.
* a **trigger pulse** — a fire shows it for ``pulse_ms`` (registered here by
  :mod:`oc.collect.triggers`, expiring on wall time).
* ``follow_window`` — the bound window is the live classified state (optionally narrowed to
  ``states``).
* a **gate** — an overlay is ``GATEABLE``, so a :class:`GateDef` naming it holds it visible while
  its predicate is true.

Gates are also a SUPPRESSOR, matching what a gate means everywhere else in the app: if any enabled
gate targeting the overlay blocks, the overlay is hidden no matter what else asked for it. So an
overlay with only a gate is visible exactly while that gate passes; one with ``follow_window`` and a
gate needs both.

The resolved set is published on :mod:`oc.overlay.events` (which no-ops when unchanged, so calling
this every tick is free) and the host window is raised/hidden through :mod:`oc.overlay.manager`.
"""

from __future__ import annotations

import threading
import time

from . import events, manager

# (game, overlay_id) -> monotonic deadline. A trigger fire writes here; resolve() reads it.
_pulses: dict[tuple[str, str], float] = {}
_lock = threading.Lock()


def pulse(game: str, overlay_id: str, ms: int) -> None:
    """Show ``overlay_id`` for ``ms`` milliseconds — the trigger-fire path. ``ms <= 0`` is treated
    as "until the next resolve decides otherwise", i.e. no pulse is recorded."""
    if not game or not overlay_id or ms <= 0:
        return
    with _lock:
        _pulses[(game, overlay_id)] = time.monotonic() + (ms / 1000.0)


def clear_pulses(game: str | None = None) -> None:
    """Drop pending pulses (one game, or all) — on live-session stop, and in tests."""
    with _lock:
        for key in [k for k in _pulses if game is None or k[0] == game]:
            _pulses.pop(key, None)


def _pulsing(game: str, overlay_id: str, now: float) -> bool:
    with _lock:
        deadline = _pulses.get((game, overlay_id))
        if deadline is None:
            return False
        if deadline <= now:
            _pulses.pop((game, overlay_id), None)
            return False
        return True


def _gate_verdicts(profile, overlay_id: str, gate_states: dict) -> tuple[bool, bool]:
    """``(has_gate, any_blocks)`` for the enabled gates targeting ``overlay_id``. A gate missing
    from ``gate_states`` (live not running, or disabled) is not counted either way."""
    has = blocks = False
    for g in getattr(profile, "gates", None) or []:
        if not getattr(g, "enabled", True) or overlay_id not in (getattr(g, "targets", None) or []):
            continue
        if g.id not in gate_states:
            continue
        has = True
        if not gate_states[g.id]:
            blocks = True
    return has, blocks


def visible_ids(profile, game: str, *, window_id: str = "", state_id: str = "",
                gate_states: dict | None = None, now: float | None = None) -> list[str]:
    """The overlay ids that should be showing. Pure — no side effects, so it is directly testable.

    ``window_id`` is the window node the classifier currently matched (empty = none matched);
    ``state_id`` is its detect state within that window, when the profile uses states.
    """
    gate_states = gate_states or {}
    now = time.monotonic() if now is None else now
    out: list[str] = []
    for ov in getattr(profile, "overlays", None) or []:
        if not getattr(ov, "enabled", True):
            continue
        has_gate, blocked = _gate_verdicts(profile, ov.id, gate_states)
        if blocked:
            continue                     # a blocking gate wins over every reason to show
        window_ok = bool(
            getattr(ov, "follow_window", True)
            and ov.window and window_id and ov.window == window_id
            and (not getattr(ov, "states", None) or state_id in ov.states))
        if getattr(ov, "manual", False) or window_ok or has_gate or _pulsing(game, ov.id, now):
            out.append(ov.id)
    return out


def apply(profile, game: str, *, window_id: str = "", state_id: str = "",
          gate_states: dict | None = None, hwnd: int = 0, foreground: bool = True) -> list[str]:
    """Resolve, publish, and drive the host window. Returns the visible set.

    The host window is raised only when something is visible AND the game holds the foreground —
    an overlay pinned over another app the user alt-tabbed to would be worse than useless. The
    child is spawned lazily on the first overlay that actually wants to show, so a profile with no
    overlays never pays for one.
    """
    ids = visible_ids(profile, game, window_id=window_id, state_id=state_id,
                      gate_states=gate_states)
    events.publish_overlays(game, ids)
    want = bool(ids) and foreground and bool(hwnd)
    if want and manager.start(_url_for(game)):
        manager.attach(hwnd)
    manager.set_visible(want)
    return ids


def _url_for(game: str) -> str:
    """The page the host loads. Navigated exactly ONCE per child (see ``_overlay_child`` quirk 3),
    so the game id is baked into the URL and a game switch respawns the child."""
    from urllib.parse import quote

    from ..web import server_url
    # Plain static file — the whole front end is mounted at "/", so the overlay page needs no
    # route of its own.
    return f"{server_url.base_url()}/overlay.html?game={quote(game)}"
