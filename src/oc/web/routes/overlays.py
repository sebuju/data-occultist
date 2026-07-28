"""Overlay routes: what is showing, and the manual/test controls the node offers.

The overlay page itself needs no route to *render* — it is static HTML served from ``static/`` and
fed by the existing SSE stream. These endpoints cover the two things a push can't: seeding a
freshly-booted page with the current truth, and letting the UI poke an overlay by hand.
"""

from __future__ import annotations

import threading

from fastapi import APIRouter, HTTPException

from ...overlay import events as overlay_events, manager, visibility
from ...profile import list_profiles, load_profile
from ..deps import get_locator, get_settings

router = APIRouter(prefix="/api/overlays", tags=["overlays"])


def _profile_or_404(game: str):
    settings = get_settings()
    if game not in list_profiles(settings.profiles_dir):
        raise HTTPException(status_code=404, detail=f"No profile {game!r}")
    return load_profile(settings.profiles_dir, game)


@router.get("/host")
def host_status() -> dict:
    """Can an overlay run on this host, and is one up? The node shows the ``reason`` when it
    can't, so a missing dependency reads as a message instead of a window that never appears."""
    ok, reason = manager.available()
    return {"available": ok, "reason": reason}


@router.get("/{game}/visible")
def visible(game: str) -> dict:
    """The overlay ids visible right now.

    The page seeds from this on boot: the ``overlay`` SSE event only fires on CHANGE (so a steady
    state costs nothing), which means a page that connected after the state settled would otherwise
    stay blank until something moved.
    """
    return {"game": game, "overlays": overlay_events.current(game)}


@router.post("/{game}/{overlay_id}/pulse")
def pulse(game: str, overlay_id: str, ms: int = 0) -> dict:
    """Show an overlay for a while, by hand — the node's test button.

    Same path a trigger fire takes (:func:`oc.overlay.visibility.pulse`), so testing exercises the
    real mechanism rather than a preview of it. ``ms`` defaults to the overlay's own ``pulse_ms``.
    """
    profile = _profile_or_404(game)
    ov = next((o for o in (getattr(profile, "overlays", None) or []) if o.id == overlay_id), None)
    if ov is None:
        raise HTTPException(404, f"no overlay {overlay_id!r} in {game!r}")
    span = int(ms or getattr(ov, "pulse_ms", 0) or 0)
    visibility.pulse(game, overlay_id, span)
    # Resolve RIGHT NOW rather than waiting for the next collector tick. Without this the button
    # silently does nothing whenever live collection isn't running -- which is exactly when someone
    # is most likely to be testing an overlay they just built.
    shown = _resolve_now(profile, game)
    # ...and again once the pulse lapses, so a test that nothing else is driving takes itself down
    # instead of hanging on screen until the next tick (which may never come).
    if span > 0:
        t = threading.Timer((span / 1000.0) + 0.15, lambda: _resolve_now(profile, game))
        t.daemon = True
        t.start()
    return {"game": game, "overlay": overlay_id, "ms": span, "visible": shown}


def _resolve_now(profile, game: str) -> list:
    """One-shot visibility resolve outside the collector loop.

    The live path (``LiveSession._on_tick``) already knows the classified window and the trigger
    runner's gate states; this has neither, so it locates the game window the same way capture does
    and resolves with no window/gate context. Manual + pulse still hold, which is all a test needs.
    """
    try:
        win = get_locator().locate(profile)
    except Exception:  # noqa: BLE001 - the game may simply not be running
        win = None
    return visibility.apply(
        profile, game,
        hwnd=int(getattr(win, "handle", 0) or 0),
        # No foreground requirement here: a test fired from the browser means the BROWSER is
        # foreground, so demanding the game hold it would hide the very thing being tested.
        foreground=True,
    )
