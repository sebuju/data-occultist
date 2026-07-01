"""``oc _sweep-job`` — run ONE producer sweep, in its own process.

Internal command (leading underscore): the web/collector supervisor
(:func:`oc.enrich.price_runner.start_sweep`) spawns it as ``python -m oc _sweep-job ...`` so
the sweep's CPU-heavy bursts (re-encoding the multi-MB price store, scanning movers) run on a
SEPARATE GIL and can never freeze the single-worker server event loop. It is the child half of
that supervisor: it owns only the fetch+write+status; the parent owns the gate/lock and reaps
the result.

Hand-off: the parent writes a ``--job-file`` JSON holding the exact resolved profile, the
producer node, and any explicit item list (things that can't be CLI scalars), and passes the
data dir + tuning as flags. This process rebuilds the sweep context, publishes progress to the
status sidecar (so any process's Activity panel shows it), polls the cross-process cancel flag,
and prints one ``OCC_SWEEP_SUMMARY <json>`` line the parent parses on reap. It does NOT touch
the gate/lock or the in-process event buses — those belong to the parent (which re-announces the
result on its own buses when it reaps this child)."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from ..settings import Settings


def register(sub) -> None:
    # Hidden from `--help`: this is spawned by the supervisor, never typed by a user.
    p = sub.add_parser("_sweep-job", help=argparse.SUPPRESS)
    p.add_argument("game", help="profile name")
    p.add_argument("--dataset", required=True, help="output dataset id")
    p.add_argument("--job-file", required=True, help="JSON hand-off file (profile + node + items)")
    p.add_argument("--data-dir", default=None, help="data dir (defaults to settings)")
    p.add_argument("--timeout", type=float, default=30.0)
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--workers", type=int, default=6)
    p.set_defaults(func=run)


def run(args) -> int:
    from ..enrich.price_runner import (
        SweepState, _cancel_path, _clear_sweep_status, _utcnow_iso, _write_sweep_status,
    )
    from ..interfaces import ProducerCtx
    from ..profile.models import GameProfile, ProducerDef
    from ..registry import build_producer
    from ..store import stats_store

    settings = Settings.load()
    data_dir = args.data_dir or str(settings.data_dir)
    game = args.game
    dataset = args.dataset
    stats_store.configure(data_dir)

    doc = json.loads(Path(args.job_file).read_text(encoding="utf-8"))
    profile = GameProfile.model_validate(doc["profile"]) if doc.get("profile") else None
    node = ProducerDef.model_validate(doc["node"])
    items = doc.get("items")
    key = profile.key_map_for(dataset) if profile is not None else None

    state = SweepState(game=game, dataset=dataset, mode=node.mode, running=True,
                       started=_utcnow_iso())
    names: list[str] = []          # written item names -> parent republishes as changed records
    cancel_path = _cancel_path(data_dir, game)
    _cancel_seen = [0.0, False]    # (last-check monotonic, last result) — throttle the exists() poll
    _last_pub = [0.0]

    def should_stop() -> bool:
        now = time.monotonic()
        if now - _cancel_seen[0] >= 0.5:
            _cancel_seen[0] = now
            _cancel_seen[1] = cancel_path.exists()
        return _cancel_seen[1]

    def on_item(done, total, slug, name, ok) -> None:
        state.total = total
        state.done = done
        state.last = name
        if ok:
            state.fetched += 1
            names.append(name)
        else:
            state.failed += 1
        now = time.monotonic()
        if now - _last_pub[0] >= 1.0:
            _last_pub[0] = now
            _write_sweep_status(data_dir, game, state)   # refresh progress for other processes

    t0 = time.perf_counter()
    try:
        _write_sweep_status(data_dir, game, state)   # publish at once so the panel shows it
        ctx = ProducerCtx(
            data_dir=data_dir, game=game, node=node, dataset=dataset, key=key,
            profile=profile, items=items, timeout=args.timeout, limit=args.limit,
            workers=args.workers, on_item=on_item, should_stop=should_stop)
        build_producer(getattr(node, "type", "warframe_market")).run(ctx)
    finally:
        state.running = False
        state.finished = _utcnow_iso()
        stats_store.record_timing(game, f"producer:{node.id}", "sw",
                                  (time.perf_counter() - t0) * 1000.0, n=state.fetched)
        try:
            stats_store.flush_all()   # persist timings before the process exits
        except Exception:  # noqa: BLE001
            pass
        _clear_sweep_status(data_dir, game)
        try:
            cancel_path.unlink()
        except OSError:
            pass
        summary = {"total": state.total, "fetched": state.fetched, "failed": state.failed,
                   "done": state.done, "names": names}
        print("OCC_SWEEP_SUMMARY " + json.dumps(summary))
        sys.stdout.flush()
    return 0
