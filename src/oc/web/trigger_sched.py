"""Background interval-trigger scheduler for the teach app.

Triggers normally fire from the collector loop (``oc collect``). When only the teach UI is
up, this keeps **interval** triggers firing on schedule so the Activity panel can show a
live "fires in Ns" countdown and the sweeps still happen. It reuses :class:`TriggerRunner`
(so the firing logic is identical) and is safe:

* firing is guarded — :func:`start_sweep` no-ops a node whose sweep is already running, and a
  cross-process file lock stops it double-running alongside a real collector;
* on_change/on_any_change triggers are NOT driven here (they need the collector's live record
  stream) — they are listed for visibility only.

A single daemon thread evaluates every profile's interval triggers once a second; the per-game
runner is kept across ticks (so ``_last`` fire times persist) and rebuilt only when the
profile's trigger config changes. :func:`schedule` is what ``/api/activity`` reads.
"""

from __future__ import annotations

import threading
import time

from ..collect.triggers import TriggerRunner
from ..enrich.price_runner import sweep_status
from ..profile import list_profiles
from ..runtime import load_live_profile

_lock = threading.Lock()
_runners: dict[str, tuple[str, TriggerRunner, object]] = {}   # game -> (config-sig, runner, profile)
_started = False


def _sig(profile) -> str:
    """Identity of the trigger config — rebuild the runner (reseeding the clock) when it moves."""
    return repr([(t.id, t.kind, t.interval_s, tuple(t.targets), t.enabled, t.throttle_ms)
                 for t in profile.triggers])


def _runner_for(game: str, settings):
    """Per-game runner, kept across ticks so interval clocks persist; rebuilt on config change."""
    profile = load_live_profile(settings.profiles_dir, game)
    sig = _sig(profile)
    cur = _runners.get(game)
    if cur is None or cur[0] != sig:
        from .deps import get_notifier
        runner = TriggerRunner(profile, settings.data_dir,   # fresh _last seeds to "now"
                               notifier=get_notifier())
        _runners[game] = (sig, runner, profile)
        return runner, profile
    _, runner, _old = cur
    runner._profile = profile                # keep _last; refresh other (non-trigger) profile bits
    _runners[game] = (sig, runner, profile)
    return runner, profile


def _tick(settings) -> None:
    for game in list_profiles(settings.profiles_dir):
        try:
            runner, profile = _runner_for(game, settings)
            if any(t.enabled and t.kind in ("interval", "true_interval") for t in profile.triggers):
                runner.tick()   # fire due interval / true_interval triggers (guarded inside _fire_targets)
        except Exception:       # one bad profile must never kill the loop
            continue


def _loop(settings) -> None:
    from .shutdown import is_shutting_down
    while not is_shutting_down():
        with _lock:
            try:
                _tick(settings)
            except Exception:
                pass
        time.sleep(1.0)


def start(settings) -> None:
    """Launch the scheduler thread once (called from the app lifespan)."""
    global _started
    if _started:
        return
    _started = True
    threading.Thread(target=_loop, args=(settings,), daemon=True).start()


def schedule(game: str, settings) -> list[dict]:
    """Live trigger view for ``game``: every trigger (``enabled`` flagged), its target
    sweep status, and — for enabled interval triggers — seconds until the next fire.
    Disabled triggers are included so the Activity panel can show + re-enable them.
    Pulled by /api/activity."""
    with _lock:
        try:
            runner, profile = _runner_for(game, settings)
        except Exception:
            return []
        now = runner._clock()
        from datetime import datetime, timezone

        from ..collect.triggers import read_fires
        fires = read_fires(settings.data_dir, game)
        now_wall = datetime.now(timezone.utc)
        by_id = {p.id: p for p in profile.producers}
        out: list[dict] = []
        for t in profile.triggers:
            targets = [{"id": pid, "dataset": by_id[pid].dataset,
                        "running": bool(sweep_status(game, by_id[pid].dataset).get("running"))}
                       for pid in t.targets if pid in by_id]
            # fire-history rides its own top-level `trigger_history` heartbeat key now (see
            # activity.build_activity), not nested here — matches every other history ring. The
            # on_input considered-event log rides `input_history` the same way.
            item = {"id": t.id, "kind": t.kind, "targets": targets, "enabled": bool(t.enabled),
                    "last_fired": fires.get(t.id)}
            if t.kind == "interval":
                item["interval_s"] = t.interval_s
                if t.enabled:   # a disabled trigger never fires -> no countdown
                    nxt = runner._last.get(t.id, now) + t.interval_s
                    item["next_in"] = max(0, round(nxt - now))
            elif t.kind == "true_interval":
                item["interval_s"] = t.interval_s
                if t.enabled:
                    # countdown off the PERSISTED last fire (wall clock) — continues across restarts
                    last = _parse_iso(fires.get(t.id))
                    item["next_in"] = 0 if last is None else max(
                        0, round(t.interval_s - (now_wall - last).total_seconds()))
            elif t.kind in ("on_change", "on_any_change", "on_new_batch"):
                item["watch"] = list(t.watch)
            out.append(item)
        return out


def _parse_iso(s):
    """Parse an ISO timestamp to an aware UTC datetime, or None if absent/unparseable."""
    if not s:
        return None
    from datetime import datetime, timezone
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
