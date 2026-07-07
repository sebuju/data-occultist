"""Action-node endpoints: run a game's action node (a dataset op) on demand.

Action nodes normally fire as a trigger *target* (a trigger names the action's id in its
``targets``). This route is for the teach UI's per-node **fire** button: run the op NOW on the
node's target dataset(s) — clear / clone / move — without wiring a trigger or running the
collector. Editing an action's config is a profile save (it persists in the YAML like any other
node), so there's no edit endpoint here.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ...collect.triggers import fire_action
from ...profile import list_profiles, load_profile
from ..deps import get_settings

router = APIRouter(prefix="/api/actions", tags=["actions"])


def _profile_or_404(game: str):
    settings = get_settings()
    if game not in list_profiles(settings.profiles_dir):
        raise HTTPException(status_code=404, detail=f"No profile {game!r}")
    return load_profile(settings.profiles_dir, game)


@router.post("/{game}/{action_id}/fire")
def fire(game: str, action_id: str):
    """Run action ``action_id`` now on each of its target datasets. Uses the SAME funnel the
    collector dispatch and trigger fire-now route use (``fire_action``), so a manual fire behaves
    identically to an automatic one. ``trigger_id=None`` marks it as manual (no trigger->action
    control pulse). Returns ``ran`` = whether it ran on any dataset (False for a no-op/disabled
    node)."""
    profile = _profile_or_404(game)
    action = next((x for x in profile.actions if x.id == action_id), None)
    if action is None:
        raise HTTPException(status_code=404, detail=f"No action {action_id!r}")
    ran = fire_action(game, action, get_settings().data_dir, profile=profile, trigger_id=None)
    return {"action": action_id, "ran": ran}
