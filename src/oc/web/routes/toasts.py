"""Toast-node endpoints: list a game's toast nodes and raise one on demand.

Toast nodes normally fire as a trigger *target* (a trigger names the toast's id in its
``targets``). This route is for the teach UI's per-node **test** button: pop the toast NOW,
with the node's current title/message/options, without wiring a trigger or running the
collector. Editing a toast's config is a profile save (it persists in the YAML like any other
node), so there's no edit endpoint here.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ...collect.triggers import toast_spec
from ...profile import list_profiles, load_profile
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
    # interpolate {{ro_1}} tokens against the running live session's readouts (empty if none —
    # tokens then resolve to blank, same as the pretty renderer)
    get_notifier().notify(toast_spec(toast, live_readouts(game)))
    return {"toast": toast_id, "raised": True}
