"""Shared orchestration for a producer sweep (any ``ProducerDef.type``).

One place that turns "run this producer now" into a throttled, cancellable background sweep —
driven by BOTH the web app (the manual button) and the collector (triggers), so they can't
double-run. Type-agnostic: it owns the gate / lock / status / cancel and dispatches the actual
fetch+write to the backend named by ``type`` (registry._PRODUCER) — ``warframe_market`` prices
items, ``relic`` writes relic rewards. Responsibilities:

* track per-(game, dataset) :class:`SweepState` so each price node reports its own progress;
* serialise fetching PER GAME — two concurrent sweeps would blow past warframe.market's
  rate ceiling and clobber the shared ``price_store.json``. An in-memory lock covers threads
  in one process; a **filesystem lock** (``data/<game>/.price_sweep.lock``) covers separate
  processes (``data-occultist collect`` and ``data-occultist serve`` run independently);
* resolve WHICH items to price: an explicit ``items`` list (on_change → just the changed
  keys), else the node's ``sources`` datasets/views, else the whole market catalogue.

The heavy lifting (fetch + ingest + snapshot) stays in :mod:`price_collector`; this module is
just the gate + state + item-source resolution around :func:`sweep_catalogue`.
"""

from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from ..eventlog import publish as logev
from ..store import store_for
from .price_collector import inventory_slugs
from .slug_resolver import get_resolver
from .wm_client import slugify


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---- sweep state (per game, dataset) ----------------------------------------

@dataclass
class SweepState:
    game: str
    dataset: str
    mode: str = "statistics"
    total: int = 0
    done: int = 0
    fetched: int = 0
    failed: int = 0
    running: bool = False
    cancel: bool = False
    # set when a sweep was refused because another node in the same game is sweeping
    # (fetching is serialised per game for the rate limit + shared price store).
    blocked: bool = False
    blocked_by: str = ""   # human reason, surfaced in the Activity panel
    last: str = ""
    started: str = ""
    finished: str = ""

    def public(self) -> dict:
        return asdict(self)   # ``cancel`` included so the UI can show a "cancelling…" state


@dataclass
class _Runner:
    state: SweepState | None = None
    thread: threading.Thread | None = field(default=None)


# Runner state is per (game, dataset) so each price node tracks its own sweep
# independently. Fetching, though, is serialised PER GAME by the gates below.
_runners: dict[tuple[str, str], _Runner] = {}
_game_gate: dict[str, threading.Lock] = {}
_gate_guard = threading.Lock()

# A blocked sweep (refused because another node/process holds the per-game gate) runs nothing,
# so it never reaches active_sweeps — yet a trigger that hit it looks like it silently did
# nothing. Remember the most recent block per (game, dataset) so the Activity panel can show
# "blocked" for a short window. (state, monotonic_ts); expired/cleared lazily.
_recent_blocked: dict[tuple[str, str], tuple[SweepState, float]] = {}
_BLOCKED_TTL = 20.0   # seconds a block stays visible in the panel


def _runner(game: str, dataset: str) -> _Runner:
    return _runners.setdefault((game, dataset), _Runner())


def _gate(game: str) -> threading.Lock:
    with _gate_guard:
        return _game_gate.setdefault(game, threading.Lock())


# ---- cross-process filesystem gate ------------------------------------------

# A crashed/killed sweep would otherwise strand the lock file forever; reclaim it once
# it's older than this (a real sweep refreshes nothing, so keep it well above any sweep).
_LOCK_STALE = 1800.0   # 30 min


def _lock_path(data_dir, game: str) -> Path:
    return Path(data_dir) / game / ".price_sweep.lock"


def clear_stale_locks(data_dir) -> list[str]:
    """Remove every per-game ``.price_sweep.lock`` under ``data_dir``. Safe to call at
    process startup: a fresh process holds no in-process sweep, so any lock file on disk was
    orphaned by a crashed/killed sweep and would otherwise BLOCK all sweeps for ``_LOCK_STALE``.
    Returns the games whose lock was cleared."""
    cleared: list[str] = []
    base = Path(data_dir)
    if not base.is_dir():
        return cleared
    for lock in base.glob("*/.price_sweep.lock"):
        try:
            lock.unlink()
            cleared.append(lock.parent.name)
        except OSError:
            pass
    return cleared


def _acquire_file_lock(path: Path, stale: float = _LOCK_STALE) -> bool:
    """Atomically create ``path`` as a mutex. Returns False if another process holds it
    (and it isn't stale). Reclaims a stale lock left by a crashed sweep."""
    path.parent.mkdir(parents=True, exist_ok=True)
    for _ in range(2):
        try:
            fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                age = time.time() - path.stat().st_mtime
            except OSError:
                return False
            if age < stale:
                return False
            try:
                path.unlink()          # stale -> reclaim, then retry the create
            except OSError:
                return False
            continue
        try:
            os.write(fd, f"{os.getpid()} {int(time.time())}".encode())
        finally:
            os.close(fd)
        return True
    return False


def _release_file_lock(path: Path) -> None:
    try:
        path.unlink()
    except OSError:
        pass


# ---- cross-process sweep status ---------------------------------------------

# A sweep usually runs in the `collect` process while the web UI is a SEPARATE `serve`
# process; each only knows its OWN in-memory `_runners`, so a collector sweep is invisible
# to the serve Activity panel (the "task started before the page loaded" never shows). The
# per-game file lock already serialises sweeps to ONE per game across all processes, so a
# single status sidecar carries that running sweep's progress for any process to read.
_STATUS_STALE = 30.0   # seconds without an update before a status file is treated as a dead process


def _status_path(data_dir, game: str) -> Path:
    return Path(data_dir) / game / ".sweep_status.json"


def _write_sweep_status(data_dir, game: str, state: SweepState) -> None:
    """Publish this process's running sweep so other processes' panels can show it. Atomic
    (temp + replace) so a concurrent reader never sees a torn file. Best-effort."""
    p = _status_path(data_dir, game)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        payload = {"pid": os.getpid(), "updated": time.time(), "state": state.public()}
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(json.dumps(payload), encoding="utf-8")
        tmp.replace(p)
    except OSError:
        pass


def _clear_sweep_status(data_dir, game: str) -> None:
    """Remove the status file at sweep end — only if THIS process wrote it (don't clobber a
    sweep another process just started)."""
    p = _status_path(data_dir, game)
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        if d.get("pid") == os.getpid():
            p.unlink()
    except (OSError, json.JSONDecodeError):
        pass


def _foreign_sweep(data_dir, game: str) -> dict | None:
    """The running sweep owned by ANOTHER live process (a fresh status file), or None. Our own
    sweeps come from in-memory ``_runners`` instead, so a same-pid file is ignored. A stale file
    (writer died mid-sweep) is pruned so a crashed sweep doesn't haunt the panel."""
    p = _status_path(data_dir, game)
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if d.get("pid") == os.getpid():
        return None
    if time.time() - d.get("updated", 0) > _STATUS_STALE:
        try:
            p.unlink()
        except OSError:
            pass
        return None
    st = d.get("state") or {}
    return st if st.get("running") else None


# ---- item-source resolution -------------------------------------------------

def _present_fetch(data_dir, game: str, profile):
    """A ``fetch_dataset(dataset_id, aggregate)`` for :func:`compute_view_rows` — a plain
    dataset's PRESENT records only (a sold/removed item must not be re-priced). Ignores the
    aggregate (a price node reads the dataset's default), preserving prior behaviour."""
    return lambda ds, _agg: [r for r in store_for(data_dir, game, ds, profile=profile).records()
                             if r.get("present", True)]


def _resolver(data_dir, game: str, resolve):
    """A name->slug callable: the caller's, else the catalogue-backed resolver, else naive."""
    if resolve is not None:
        return resolve
    r = get_resolver(data_dir, game)
    return r.resolve if r is not None else slugify


def gather_source_items(data_dir, game: str, profile, sources: list[str],
                        resolve=None, name_field: str = "name") -> list[tuple[str, str]]:
    """``(slug, name)`` pairs for every item across a node's ``sources`` (datasets/views),
    de-duped by slug. ``name_field`` is the column holding the item name (selectable per
    price node). Names that don't resolve to a market slug are dropped."""
    from .subset import compute_view_rows
    resolve = _resolver(data_dir, game, resolve)
    fetch = _present_fetch(data_dir, game, profile)
    rows: list[dict] = []
    for s in sources:
        # A bare dataset source -> its present rows directly; a VIEW source -> computed (so its
        # filters/derived columns apply, e.g. count>0), recursing through the shared primitive.
        sub = profile.subset_def(s) if profile else None
        rows.extend(compute_view_rows(profile, s, fetch)["rows"] if sub else fetch(s, None))
    return inventory_slugs(rows, name_field or "name", resolve)


# ---- the sweep --------------------------------------------------------------

def _run_sweep(data_dir, game: str, price_node, *, profile, key, resolve, items,
               timeout: float, limit: int, workers: int,
               gate: threading.Lock, lock_path: Path) -> None:
    dataset = price_node.dataset
    state = _runner(game, dataset).state
    _t0 = time.perf_counter()
    _last_pub = 0.0   # throttle the cross-process status write to ~1/s (not every item)

    def on_item(done, total, slug, name, ok):
        nonlocal _last_pub
        state.total = total
        state.done = done
        state.last = name
        if ok:
            state.fetched += 1
        else:
            state.failed += 1
        now = time.monotonic()
        if now - _last_pub >= 1.0:
            _last_pub = now
            _write_sweep_status(data_dir, game, state)   # refresh progress for other processes

    try:
        _write_sweep_status(data_dir, game, state)   # publish immediately so the panel shows it at once
        # Dispatch to the producer backend named by `type` (registry._PRODUCER): warframe_market
        # resolves items from `sources`/the catalogue and writes price snapshots; relic fetches the
        # WFCD table and writes (relic, reward, state) rows. The gate/lock/status above is generic.
        from ..interfaces import ProducerCtx
        from ..registry import build_producer
        ctx = ProducerCtx(
            data_dir=data_dir, game=game, node=price_node, dataset=dataset, key=key,
            profile=profile, items=items, timeout=timeout, limit=limit, workers=workers,
            on_item=on_item, should_stop=lambda: state.cancel)
        build_producer(getattr(price_node, "type", "warframe_market")).run(ctx)
    finally:
        state.running = False
        state.finished = _utcnow_iso()
        from ..store import stats_store
        from ..store.flow_events import publish_flow
        stats_store.record_timing(game, f"producer:{price_node.id}", "sw",
                                  (time.perf_counter() - _t0) * 1000.0, n=state.fetched)
        if state.fetched:
            # Source-aware data hop: the sweep wrote `fetched` records from THIS producer
            # into its output dataset. One pulse at sweep end (not per item) keeps it un-chatty.
            publish_flow(game, "data", f"producer:{price_node.id}", f"ds:{dataset}", state.fetched)
        _clear_sweep_status(data_dir, game)   # sweep done -> stop advertising it cross-process
        _release_file_lock(lock_path)
        gate.release()


def start_sweep(data_dir, game: str, price_node, *, profile=None, key=None, resolve=None,
                items=None, timeout: float = 30.0, limit: int = 0, workers: int = 6) -> SweepState:
    """Start a background producer sweep for ``price_node`` and return its live state.

    A second call while this node is running is a no-op (returns the running state); if a
    DIFFERENT node in the same game (or another process) is sweeping, returns a ``blocked``
    state without starting. ``items`` forces the exact list to price (on_change path);
    otherwise the node's ``sources`` decide, falling back to the whole catalogue."""
    dataset = price_node.dataset
    runner = _runner(game, dataset)
    if runner.state and runner.state.running:
        return runner.state
    if key is None and profile is not None:
        key = profile.key_map_for(dataset)
    gate = _gate(game)
    if not gate.acquire(blocking=False):
        return _note_blocked(game, dataset, price_node.mode, "another sweep running")
    lock_path = _lock_path(data_dir, game)
    if not _acquire_file_lock(lock_path):
        gate.release()                       # another PROCESS is sweeping this game
        return _note_blocked(game, dataset, price_node.mode, "another process sweeping")
    _recent_blocked.pop((game, dataset), None)   # this node is now sweeping — drop any stale block
    n = "" if items is None else f" · {len(items)} item(s)"   # count unknown until sources resolve
    logev(f"sweep {dataset} started · {price_node.mode}{n}", level="run", game=game)
    runner.state = SweepState(game=game, dataset=dataset, mode=price_node.mode,
                              running=True, started=_utcnow_iso())
    runner.thread = threading.Thread(
        target=_run_sweep, args=(data_dir, game, price_node),
        kwargs=dict(profile=profile, key=key, resolve=resolve, items=items,
                    timeout=timeout, limit=limit, workers=workers,
                    gate=gate, lock_path=lock_path),
        daemon=True)
    try:
        runner.thread.start()
    except RuntimeError:                     # thread couldn't start — don't strand the gates
        runner.state.running = False
        _release_file_lock(lock_path)
        gate.release()
        raise
    return runner.state


def cancel_sweep(game: str, dataset: str) -> dict:
    """Ask this node's running sweep to stop after the current item."""
    runner = _runner(game, dataset)
    if runner.state and runner.state.running:
        runner.state.cancel = True
    return runner.state.public() if runner.state else {"running": False}


def cancel_all_sweeps() -> None:
    """Ask every running sweep (any game/dataset) to stop after its current item — used on
    server shutdown so no sweep keeps working during teardown."""
    for runner in list(_runners.values()):
        if runner.state and runner.state.running:
            runner.state.cancel = True


def sweep_status(game: str, dataset: str) -> dict:
    runner = _runner(game, dataset)
    return runner.state.public() if runner.state else {"running": False, "total": 0, "done": 0}


def active_sweeps(game: str, data_dir=None) -> list[dict]:
    """Every currently-running sweep for ``game`` (one per dataset). For the Activity panel.

    In-memory runners cover sweeps started in THIS process; ``data_dir`` (when given) also
    surfaces a sweep running in ANOTHER process — the common case where the web ``serve`` panel
    must show a sweep the ``collect`` process started before the page was loaded."""
    out = [r.state.public() for (g, _ds), r in _runners.items()
           if g == game and r.state and r.state.running]
    if data_dir is not None:
        foreign = _foreign_sweep(data_dir, game)
        if foreign and not any(s.get("dataset") == foreign.get("dataset") for s in out):
            out.append(foreign)
    return out


def _note_blocked(game: str, dataset: str, mode: str, reason: str) -> SweepState:
    """Record (and return) a blocked sweep so the Activity panel can surface it briefly."""
    st = SweepState(game=game, dataset=dataset, mode=mode, blocked=True, blocked_by=reason,
                    finished=_utcnow_iso())
    _recent_blocked[(game, dataset)] = (st, time.monotonic())
    logev(f"sweep {dataset} blocked — {reason}", level="warn", game=game)
    return st


def recent_blocked(game: str, within: float = _BLOCKED_TTL) -> list[dict]:
    """Sweeps refused (gate held by another node/process) within the last ``within`` seconds —
    so a trigger that fired but couldn't sweep is visible instead of silently doing nothing.
    Expired entries are pruned on read."""
    now = time.monotonic()
    out: list[dict] = []
    for (g, ds), (st, ts) in list(_recent_blocked.items()):
        if now - ts > within:
            _recent_blocked.pop((g, ds), None)
            continue
        if g == game:
            out.append(st.public())
    return out
