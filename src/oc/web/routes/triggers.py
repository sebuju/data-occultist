"""Trigger endpoints: list a game's triggers and fire one on demand.

Triggers normally fire automatically from the collector loop (interval / on_change). This
route is for the teach UI: show what's wired and let the user fire a trigger NOW to test it
without running the collector. Editing a trigger's config is a profile save (it persists in
the YAML like any other node), so there's no edit endpoint here.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ...collect.triggers import (
    fire_action, fire_target, fire_toast, read_source_target, record_fire)
from ...enrich.price_runner import start_sweep, sweep_status
from ...profile import list_profiles, load_profile
from ...store.fire_events import publish_fire
from ..deps import get_notifier, get_settings
from .live import live_readouts

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
                    "watch": t.watch, "enabled": t.enabled, "targets": targets,
                    "readout_watch": t.readout_watch, "register_watch": t.register_watch,
                    "gates": t.gates, "throttle_ms": t.throttle_ms})
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
    by_toast = {x.id: x for x in profile.toasts}
    by_action = {x.id: x for x in profile.actions}
    by_sound = {x.id: x for x in profile.sounds}
    by_router = {x.id: x for x in getattr(profile, "routers", [])}
    data_dir = get_settings().data_dir
    # Expand any router target: a manual test fire has no live value to pick a branch by, so it
    # exercises EVERY branch target (proves the whole wiring plays). The collector path does the
    # real per-value branch selection (see TriggerRunner._resolve_fire).
    effective_targets: list[str] = []
    for pid in trig.targets:
        r = by_router.get(pid)
        if r is not None:
            for b in r.branches:
                for tid in b.targets:
                    if tid not in effective_targets:
                        effective_targets.append(tid)
        elif pid not in effective_targets:
            effective_targets.append(pid)
    # SAME funnels the collector uses (fire_target for producers, read_source_target for file
    # sources) so a manual fire behaves identically to an automatic one — no path drifts. A
    # producer already sweeping is reported in ``skipped`` (not an error) so the UI can say
    # "already sweeping" instead of a bare "0 sweeps" that reads as a broken button.
    started, skipped = [], []
    sound_ids: list[str] = []
    fired = False
    for pid in effective_targets:
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
            continue
        toast = by_toast.get(pid)
        if toast is not None and fire_toast(game, toast, get_notifier(), trigger_id=trigger_id,
                                            values=live_readouts(game)):
            started.append({"toast": pid})
            fired = True
            continue
        # action nodes (clear / clone / move a dataset) — same funnel the collector dispatch uses,
        # so a manual test fire behaves identically to an automatic one.
        action = by_action.get(pid)
        if action is not None and fire_action(game, action, data_dir, profile=profile,
                                              trigger_id=trigger_id):
            started.append({"action": pid})
            fired = True
            continue
        # sound nodes are played CLIENT-SIDE, never here — they ride the instant fire cue published
        # below (ALL of them, so a trigger wired to several sounds plays the whole set at once).
        # Count an enabled sound as fired; the browser does the actual playback.
        snd = by_sound.get(pid)
        if snd is not None and getattr(snd, "enabled", True):
            sound_ids.append(pid)
            started.append({"sound": pid})
            fired = True
    if fired:
        # Push the live cue so a MANUAL fire sounds exactly like an automatic one. Without this the
        # browser never hears about a manual fire at all (the old polled fire-detector this route's
        # comment referred to is gone) -- the collector path publishes via TriggerRunner._emit_fire.
        publish_fire(game, trigger_id, sound_ids)
        record_fire(data_dir, game, trigger_id)   # stamp the sidecar so the fire countdown is right
        from datetime import datetime, timezone

        from ...collect import sound_history
        from ...collect.trigger_history import record as record_hist
        ts = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        for sid in sound_ids:
            sound_history.record(game, sid, ts=ts, trigger=trigger_id)
        record_hist(game, trigger_id, why="manual", targets=list(trig.targets),
                    throttled=False, ts=ts)
    return {"trigger": trigger_id, "started": started, "skipped": skipped}
