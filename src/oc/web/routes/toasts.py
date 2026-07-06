"""Toast-node endpoints: list a game's toast nodes and raise one on demand.

Toast nodes normally fire as a trigger *target* (a trigger names the toast's id in its
``targets``). This route is for the teach UI's per-node **test** button: pop the toast NOW,
with the node's current title/message/options, without wiring a trigger or running the
collector. Editing a toast's config is a profile save (it persists in the YAML like any other
node), so there's no edit endpoint here.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response

from ...collect.triggers import toast_spec
from ...profile import list_profiles, load_profile
from ...profile.models import ToastImageDef
from ..deps import get_notifier, get_settings
from .live import live_readouts

router = APIRouter(prefix="/api/toasts", tags=["toasts"])


def _profile_or_404(game: str):
    settings = get_settings()
    if game not in list_profiles(settings.profiles_dir):
        raise HTTPException(status_code=404, detail=f"No profile {game!r}")
    return load_profile(settings.profiles_dir, game)


@router.post("/{game}/{toast_id}/test")
def test_toast(game: str, toast_id: str):
    """Raise toast ``toast_id`` now with its current config — the node's test button. Fires
    regardless of the node's ``enabled`` flag (a test should always pop). The notifier swallows
    its own OS errors, so a broken toast reports ``raised: true`` with no visible pop rather
    than erroring; the ``null`` notifier (non-Windows) simply does nothing."""
    profile = _profile_or_404(game)
    toast = next((x for x in profile.toasts if x.id == toast_id), None)
    if toast is None:
        raise HTTPException(status_code=404, detail=f"No toast {toast_id!r}")
    # interpolate tokens: {{readout:id}} against the running live session's readouts (empty if
    # none), {{dataset:...}}/{{subset:...}} against the game's stored records — so a test toast
    # reads exactly what a fired one would (mirrors the pretty renderer).
    get_notifier().notify(toast_spec(toast, live_readouts(game),
                                     data_dir=get_settings().data_dir, profile=profile, game=game))
    return {"toast": toast_id, "raised": True}


@router.post("/{game}/preview")
def preview_image(game: str, spec: ToastImageDef, focus: int | None = None):
    """Render a hero/inline image spec to a live PNG for the node editor's preview. The posted
    ``spec`` is the IN-PROGRESS edit (not the saved profile), so the preview updates as the user
    types. Tokens resolve against the live readouts + the game's stored records; a token with no
    live value stays as its literal ``{{...}}`` so the design is still legible without a session.
    ``focus`` (a text-line index) outlines that line — the editor passes the line being edited."""
    import json

    settings = get_settings()
    profile = load_profile(settings.profiles_dir, game) if game in list_profiles(settings.profiles_dir) else None
    from ...collect.templating import TokenContext
    from ...notify.toast_image import render_png_boxes
    ctx = TokenContext(live_readouts(game), data_dir=settings.data_dir, profile=profile, game=game)
    try:
        png, boxes = render_png_boxes(spec, ctx, keep_missing=True, focus=focus)
    except Exception as e:   # noqa: BLE001 - a bad design must not 500 the editor
        raise HTTPException(status_code=422, detail=f"render failed: {e}") from e
    # per-line pixel boxes ride a header so the editor overlays a clickable box on each element
    # (one render, no second round trip). Small JSON — a handful of boxes.
    return Response(content=png, media_type="image/png",
                    headers={"X-Text-Boxes": json.dumps(boxes, separators=(",", ":"))})
