"""Trigger endpoints: list a game's triggers and fire one on demand.

Triggers normally fire automatically from the collector loop (interval / on_change). This
route is for the teach UI: show what's wired and let the user fire a trigger NOW to test it
without running the collector. Editing a trigger's config is a profile save (it persists in
the YAML like any other node), so there's no edit endpoint here.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ...collect.triggers import fire_target, read_source_target, record_fire
from ...enrich.price_runner import start_sweep, sweep_status
from ...profile import list_profiles, load_profile
from ..deps import get_settings

router = APIRouter(prefix="/api/triggers", tags=["triggers"])


def _profile_or_404(game: str):
    settings = get_settings()
    if game not in list_profiles(settings.profiles_dir):
        raise HTTPException(status_code=404, detail=f"No profile {game!r}")
    return load_profile(settings.profiles_dir, game)


@router.get("/{game}")
def list_triggers(game: str):
    """Each trigger plus the live sweep status of every producer it targets."""
    profile = _profile_or_404(game)
    by_id = {p.id: p for p in profile.producers}
    out = []
    for t in profile.triggers:
        targets = [{"id": pid, "dataset": by_id[pid].dataset,
                    "status": sweep_status(game, by_id[pid].dataset)}
                   for pid in t.targets if pid in by_id]
        out.append({"id": t.id, "kind": t.kind, "interval_s": t.interval_s,
                    "watch": t.watch, "enabled": t.enabled, "targets": targets})
    return {"game": game, "triggers": out}


@router.post("/{game}/{trigger_id}/fire")
def fire_trigger(game: str, trigger_id: str):
    """Fire ``trigger_id`` now: sweep each target price node (its ``sources`` decide what's
    priced, whole catalogue if none). For testing wiring outside the collector loop."""
    profile = _profile_or_404(game)
    trig = next((t for t in profile.triggers if t.id == trigger_id), None)
    if trig is None:
        raise HTTPException(status_code=404, detail=f"No trigger {trigger_id!r}")
    by_producer = {p.id: p for p in profile.producers}
    by_source = {s.id: s for s in profile.file_sources}
    data_dir = get_settings().data_dir
    # SAME funnels the collector uses (fire_target for producers, read_source_target for file
    # sources) so a manual fire behaves identically to an automatic one — no path drifts. A
    # producer already sweeping is reported in ``skipped`` (not an error) so the UI can say
    # "already sweeping" instead of a bare "0 sweeps" that reads as a broken button.
    started, skipped = [], []
    fired = False
    for pid in trig.targets:
        pn = by_producer.get(pid)
        if pn is not None:
            if sweep_status(game, pn.dataset).get("running"):
                skipped.append(pid)
                continue
            if fire_target(game, pn, None, trigger_id=trigger_id,
                           fire=lambda p, items: start_sweep(data_dir, game, p, profile=profile, items=items)):
                started.append(sweep_status(game, pn.dataset))
                fired = True
            continue
        src = by_source.get(pid)
        if src is not None and read_source_target(game, src, data_dir, profile=profile,
                                                  trigger_id=trigger_id):
            started.append({"source": pid})
            fired = True
    if fired:
        record_fire(data_dir, game, trigger_id)   # stamp the sidecar so the fire countdown is right
    return {"trigger": trigger_id, "started": started, "skipped": skipped}
