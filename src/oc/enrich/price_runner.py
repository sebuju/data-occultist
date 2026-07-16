"""Shared orchestration for a producer sweep (any ``ProducerDef.type``).

One place that turns "run this producer now" into a throttled, cancellable background sweep —
driven by BOTH the web app (the manual button) and the collector (triggers), so they can't
double-run. Type-agnostic: it owns the gate / lock / status / cancel and dispatches the actual
fetch+write to the backend named by ``type`` (registry._PRODUCER) — the ``http`` producer
prices items (per-item) or writes an expanded table (list mode). Responsibilities:

* track per-(game, dataset) :class:`SweepState` so each price node reports its own progress;
* serialise fetching PER GAME — two concurrent sweeps would blow past warframe.market's
  rate ceiling and clobber the shared ``price_store.json``. An in-memory lock covers the
  in-process runners; a **filesystem lock** (``data/<game>/.price_sweep.lock``) covers separate
  processes (``data-occultist collect`` and ``data-occultist serve`` run independently);
* resolve WHICH items to price: an explicit ``items`` list (on_change → just the changed
  keys), else the node's ``sources`` datasets/views, else the whole market catalogue.

**The sweep runs in a SUBPROCESS, not a thread.** A sweep is CPU-heavy in bursts (it
re-serialises the multi-MB price store every checkpoint and scans movers), and the web server
is single-worker uvicorn — one event loop, one GIL. A worker *thread* doing that encode holds
the GIL and freezes the event loop for its duration, so a minutes-long sweep locks the whole
UI. Running it as its own ``python -m oc _sweep-job`` process (its own GIL) keeps the server
responsive no matter how big the store, and isolates faults: a hung/crashed sweep is a dead
child, not a frozen server. The sweep body itself lives in :mod:`oc.cli.sweep_job`; this module
is the parent-side supervisor — it acquires the gate/lock, spawns the child, mirrors the child's
progress from the status sidecar, and reaps it (releasing the gate/lock and re-announcing the
result on this process's buses) when it exits.
"""

from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

from ..eventlog import publish as logev
from ..jobs import SubprocessJob
from ..profile.models import ProducerDef


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---- sweep state (per game, dataset) ----------------------------------------

@dataclass
class SweepState:
    game: str
    dataset: str
    mode: str = ""
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
    # number of sweeps waiting behind this one (queue_mode != drop) — shown in the node status line
    queued_count: int = 0
    last: str = ""
    started: str = ""
    finished: str = ""

    def public(self) -> dict:
        return asdict(self)   # ``cancel`` included so the UI can show a "cancelling…" state


@dataclass
class _Runner:
    """Parent-side handle for one (game, dataset) sweep. Holds the child process plus the
    gate/lock/files the PARENT owns on its behalf, so reaping the child can release them."""

    state: SweepState | None = None
    proc: SubprocessJob | None = None
    data_dir: object | None = None
    game: str = ""
    dataset: str = ""
    node_id: str = ""
    gate: threading.Lock | None = None
    lock_path: Path | None = None
    job_file: str | None = None
    reaped: bool = False


# Runner state is per (game, dataset) so each price node tracks its own sweep
# independently. Fetching, though, is serialised PER GAME by the gates below.
_runners: dict[tuple[str, str], _Runner] = {}
_game_gate: dict[str, threading.Lock] = {}
_gate_guard = threading.Lock()
_reap_lock = threading.Lock()   # serialises reaping so a child is released exactly once

# Pending sweeps per (game, dataset): a fire that arrived while this node was busy and its
# ``queue_mode`` is not "drop". Each entry is the captured start_sweep(**kwargs) to replay. The
# reap of the current sweep drains the next one. ``latest`` keeps at most one; ``queue`` is FIFO.
_pending: dict[tuple[str, str], list[dict]] = {}
_pending_lock = threading.Lock()


def _queue_request(game: str, dataset: str, mode: str, req: dict) -> int:
    """Enqueue a blocked sweep per ``mode``. Returns the resulting pending count (0 = dropped)."""
    key = (game, dataset)
    with _pending_lock:
        if mode == "latest":
            _pending[key] = [req]              # coalesce: only the newest batch survives
        elif mode == "queue":
            _pending.setdefault(key, []).append(req)
        else:
            return 0                           # drop
        return len(_pending[key])


def _dequeue_request(game: str, dataset: str) -> dict | None:
    """Pop the next pending sweep (FIFO), or None. Called from the reap to run the next batch."""
    key = (game, dataset)
    with _pending_lock:
        q = _pending.get(key)
        if not q:
            return None
        req = q.pop(0)
        if not q:
            _pending.pop(key, None)
        return req


def _pending_count(game: str, dataset: str) -> int:
    with _pending_lock:
        return len(_pending.get((game, dataset), []))


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


# ---- producer-node resolution -----------------------------------------------

def producer_for(profile, dataset: str, *, type: str = "http",
                 mode: str = "", throttle: float = 0.4) -> ProducerDef:
    """The configured producer feeding ``dataset`` (its ``type``/``sources`` decide what it
    fetches), or an ephemeral node when none is taught — preserving the original behaviour for
    a dataset with no producer. The ONE place a (game, dataset) maps to its :class:`ProducerDef`
    (the web route and the sweep supervisor both call it, so they can't drift)."""
    if profile is not None:
        for pn in profile.producers:
            if pn.dataset == dataset:
                return pn
    return ProducerDef(id=dataset, dataset=dataset, type=type, mode=mode, throttle=throttle)


# ---- cross-process filesystem gate ------------------------------------------

# A crashed/killed sweep would otherwise strand the lock file forever; reclaim it once
# it's older than this (a real sweep refreshes nothing, so keep it well above any sweep).
_LOCK_STALE = 1800.0   # 30 min


def _lock_path(data_dir, game: str) -> Path:
    return Path(data_dir) / game / ".price_sweep.lock"


def clear_stale_locks(data_dir) -> list[str]:
    """Remove every per-game ``.price_sweep.lock`` (and its ``.price_sweep.cancel`` sibling)
    under ``data_dir``. Safe to call at process startup: a fresh process holds no in-process
    sweep, so any lock file on disk was orphaned by a crashed/killed sweep and would otherwise
    BLOCK all sweeps for ``_LOCK_STALE``; a stranded cancel file would insta-cancel the next
    sweep. Returns the games whose lock was cleared."""
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
    for cancel in base.glob("*/.price_sweep.cancel"):
        try:
            cancel.unlink()
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


def _release_file_lock(path: Path | None) -> None:
    if path is None:
        return
    try:
        path.unlink()
    except OSError:
        pass


# ---- cross-process cancel flag ----------------------------------------------

# In-process the runner's ``state.cancel`` aborts a sweep; but the sweep now runs in a CHILD
# process, so cancellation crosses the boundary via a flag FILE the child polls in its
# ``should_stop``. The child stops after its current item and flushes partial data (its
# ``finally``), so a cancel is graceful, not a hard kill.

def _cancel_path(data_dir, game: str) -> Path:
    return Path(data_dir) / game / ".price_sweep.cancel"


def _write_cancel(data_dir, game: str) -> None:
    p = _cancel_path(data_dir, game)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(str(int(time.time())), encoding="utf-8")
    except OSError:
        pass


def _clear_cancel(data_dir, game: str) -> None:
    try:
        _cancel_path(data_dir, game).unlink()
    except OSError:
        pass


# ---- the sweep job file (parent -> child hand-off) --------------------------

def _job_path(data_dir, game: str) -> Path:
    return Path(data_dir) / game / ".sweep_job.json"


def _write_job_file(path: Path, profile, node: ProducerDef, items) -> None:
    """Serialise everything the child needs that can't be a CLI scalar: the exact resolved
    producer node, the full profile (so the child rebuilds the same key map / source views —
    and so an in-memory test profile works without touching disk), and any explicit item list.
    A callable ``resolve`` can't cross a process, so the child rebuilds the catalogue-backed
    resolver from disk itself."""
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = {
        "profile": profile.model_dump(mode="json") if profile is not None else None,
        "node": node.model_dump(mode="json"),
        "items": items,
    }
    path.write_text(json.dumps(doc), encoding="utf-8")


# ---- cross-process sweep status ---------------------------------------------

# A sweep runs in a CHILD process (or the `collect` process while the web UI is a separate
# `serve` process); each process only knows its OWN in-memory `_runners`, so the running sweep
# publishes progress to a status sidecar that any process reads. The per-game file lock already
# serialises sweeps to ONE per game across all processes, so a single sidecar suffices.
_STATUS_STALE = 30.0   # seconds without an update before a status file is treated as a dead process


def _status_path(data_dir, game: str) -> Path:
    return Path(data_dir) / game / ".sweep_status.json"


def _write_sweep_status(data_dir, game: str, state: SweepState) -> None:
    """Publish the running sweep so any process's panel can show it. Atomic (temp + replace) so
    a concurrent reader never sees a torn file. Best-effort. Called by the CHILD."""
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
    sweep another process just started). Called by the CHILD."""
    p = _status_path(data_dir, game)
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        if d.get("pid") == os.getpid():
            p.unlink()
    except (OSError, json.JSONDecodeError):
        pass


def _read_status_payload(data_dir, game: str) -> dict | None:
    """The raw ``{pid, updated, state}`` sidecar for a live sweep, or None. Prunes a stale file
    (writer died mid-sweep) so a crashed sweep doesn't haunt the panel."""
    p = _status_path(data_dir, game)
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if time.time() - d.get("updated", 0) > _STATUS_STALE:
        try:
            p.unlink()
        except OSError:
            pass
        return None
    return d


def _foreign_sweep(data_dir, game: str) -> dict | None:
    """The running sweep owned by ANOTHER live process (a fresh status file), or None. A
    same-pid file is ignored (our own child's progress is mirrored via the in-memory runner
    instead, so it isn't double-counted here)."""
    d = _read_status_payload(data_dir, game)
    if not d or d.get("pid") == os.getpid():
        return None
    st = d.get("state") or {}
    return st if st.get("running") else None


# ---- item-source resolution -------------------------------------------------
# Item names are gathered by :func:`oc.enrich.http_producer.gather_source_names` (re-exported
# for callers of this module); the producer applies its own key transform per its HttpSpec.


# ---- supervising the child sweep --------------------------------------------

def _parse_summary(lines: list[str]) -> dict | None:
    """The child prints one ``OCC_SWEEP_SUMMARY <json>`` line at the end (stderr is merged into
    stdout, so tracebacks may precede it). Return the last such summary, or None."""
    for line in reversed(lines):
        if line.startswith("OCC_SWEEP_SUMMARY "):
            try:
                return json.loads(line[len("OCC_SWEEP_SUMMARY "):])
            except json.JSONDecodeError:
                return None
    return None


def _reap(runner: _Runner) -> None:
    """The child exited — finalise the sweep. Runs on the job's reader thread (via ``on_exit``)
    once stdout is fully drained, so the summary line is present. Idempotent: releases the
    gate/lock/files exactly once and re-announces the result on THIS process's buses (the
    child's own writes published only to its own in-process buses, invisible here)."""
    with _reap_lock:
        job = runner.proc
        if job is None or runner.reaped:
            return
        runner.reaped = True

    summary = _parse_summary(job.drain_stdout())
    state = runner.state
    if state is not None:
        state.running = False
        state.finished = _utcnow_iso()
        if summary is not None:
            state.total = summary.get("total", state.total)
            state.fetched = summary.get("fetched", state.fetched)
            state.failed = summary.get("failed", state.failed)
            state.done = summary.get("done", state.total)

    fetched = int((summary or {}).get("fetched", 0) or 0)
    names = (summary or {}).get("names", []) or []
    # One producer-history row per completed sweep (non-persisted ring, teach-UI satellite). Keyed
    # by the producer NODE id; this parent process is the only one that sees the child's outcome.
    try:
        from ..collect import producer_history
        producer_history.record(
            runner.game, runner.node_id,
            ts=(state.finished if state is not None else _utcnow_iso()),
            dataset=runner.dataset,
            total=int((summary or {}).get("total", 0) or 0),
            fetched=fetched, failed=int((summary or {}).get("failed", 0) or 0),
            rows=len(names), mode=(state.mode if state is not None else ""))
    except Exception:  # noqa: BLE001 - history is a debug view, never break teardown
        pass
    # Re-announce on this process's buses so the live UX the in-process path used to give still
    # happens: the "data landed" blob animation, the Pretty SSE refetch, and (via the change
    # bus) any on_change trigger chained off this sweep's output — its records ARE the names the
    # child wrote. running is already False, so the OnChangeFirer's busy-guard lets it fire once.
    try:
        from ..store.flow_events import publish_flow
        if fetched:
            publish_flow(runner.game, "data", f"producer:{runner.node_id}",
                         f"ds:{runner.dataset}", fetched)
    except Exception:  # noqa: BLE001 - announcing must never break teardown
        pass
    try:
        from ..store.changes import publish as publish_change
        if names:   # nothing written -> no change to announce (matches the in-process path)
            publish_change(runner.game, runner.dataset, [{"name": n} for n in names])
    except Exception:  # noqa: BLE001
        pass
    # The producer's sweep is DONE (data already written above): fire on_ready triggers watching
    # this producer. Deterministic — the toast is CAUSED by completion, so it can't precede it. Fires
    # even when nothing was written (the fetch still finished — e.g. all rewards unpriceable).
    try:
        from ..store.changes import publish_sweep_done
        publish_sweep_done(runner.game, runner.node_id, runner.dataset)
    except Exception:  # noqa: BLE001 - announcing must never break teardown
        pass

    _release_file_lock(runner.lock_path)
    if runner.data_dir is not None:
        _clear_cancel(runner.data_dir, runner.game)
    if runner.job_file:
        try:
            Path(runner.job_file).unlink()
        except OSError:
            pass
    gate = runner.gate
    if gate is not None:
        try:
            gate.release()
        except RuntimeError:
            pass   # not held (already reaped elsewhere) — harmless
    runner.proc = None

    # Drain the queue: a fire that arrived while this node was busy (queue_mode latest/queue) is
    # replayed now the gate is free. ``latest`` has one pending; ``queue`` runs the rest FIFO across
    # successive reaps. This is why a queued batch always gets priced instead of silently dropped.
    nxt = _dequeue_request(runner.game, runner.dataset)
    if nxt is not None:
        try:
            start_sweep(**nxt)
        except Exception:  # noqa: BLE001 - a failed restart must not wedge teardown
            pass


def _sync(runner: _Runner) -> None:
    """Refresh a runner from its child: mirror live progress from the status sidecar while the
    child runs; once it exits, wait for the reader thread to reap it (so ``state.running`` and
    the gate/lock reflect reality before a caller reads them)."""
    job = runner.proc
    if job is None:
        return
    if job.alive():
        d = _read_status_payload(runner.data_dir, runner.game)
        st = (d or {}).get("state") or {}
        if st.get("dataset") == runner.dataset and runner.state is not None:
            for k in ("done", "total", "fetched", "failed", "last"):
                if k in st:
                    setattr(runner.state, k, st[k])
    else:
        # child gone — the reader thread's finally fires on_exit -> _reap; wait it out so we
        # don't return a stale running=True or a still-held gate.
        job.join(timeout=2.0)


def start_sweep(data_dir, game: str, price_node, *, profile=None, key=None,
                items=None, timeout: float = 30.0, limit: int = 0, workers: int = 6) -> SweepState:
    """Start a background producer sweep (in a child process) for ``price_node`` and return its
    live state.

    A second call while this node is running is a no-op (returns the running state); if a
    DIFFERENT node in the same game (or another process) is sweeping, returns a ``blocked``
    state without starting. ``items`` forces the exact list to price (on_change path); otherwise
    the node's ``sources`` decide. ``key`` is recomputed by the child from ``profile``; the child
    also builds any catalogue resolver itself (a callable can't cross a process)."""
    dataset = price_node.dataset
    runner = _runner(game, dataset)
    _sync(runner)   # reap a just-finished prior child so a stale running flag doesn't block us
    mode = getattr(price_node, "queue_mode", "drop") or "drop"
    # captured call to replay when this sweep is drained from the pending queue by the reap.
    req = dict(data_dir=data_dir, game=game, price_node=price_node, profile=profile, key=key,
               items=items, timeout=timeout, limit=limit, workers=workers)

    def _blocked_or_queued(reason: str) -> SweepState:
        """This node can't start now. Queue the batch (queue_mode != drop) or drop it."""
        if mode != "drop":
            return _note_queued(game, dataset, price_node.mode,
                                _queue_request(game, dataset, mode, req))
        return _note_blocked(game, dataset, price_node.mode, reason)

    if runner.state and runner.state.running:
        return _blocked_or_queued("this node already sweeping") \
            if mode != "drop" else runner.state
    gate = _gate(game)
    if not gate.acquire(blocking=False):
        return _blocked_or_queued("another sweep running")
    lock_path = _lock_path(data_dir, game)
    if not _acquire_file_lock(lock_path):
        gate.release()                       # another PROCESS is sweeping this game
        return _blocked_or_queued("another process sweeping")
    _recent_blocked.pop((game, dataset), None)   # this node is now sweeping — drop any stale block
    _clear_cancel(data_dir, game)                # a stale cancel must not insta-cancel this sweep

    job_file = _job_path(data_dir, game)
    _write_job_file(job_file, profile, price_node, items)
    n = "" if items is None else f" · {len(items)} item(s)"   # count unknown until sources resolve
    logev(f"sweep {dataset} started · {price_node.mode}{n}", level="run", game=game)

    runner.state = SweepState(game=game, dataset=dataset, mode=price_node.mode,
                              running=True, started=_utcnow_iso())
    runner.data_dir = data_dir
    runner.game = game
    runner.dataset = dataset
    runner.node_id = price_node.id
    runner.gate = gate
    runner.lock_path = lock_path
    runner.job_file = str(job_file)
    runner.reaped = False

    args = ["_sweep-job", game, "--dataset", dataset, "--data-dir", str(data_dir),
            "--job-file", str(job_file), "--timeout", str(timeout),
            "--limit", str(limit), "--workers", str(workers)]
    runner.proc = SubprocessJob(args, name=f"sweep:{game}:{dataset}",
                                on_exit=lambda: _reap(runner))
    try:
        runner.proc.start()
    except Exception:                        # spawn failed — don't strand the gates/files
        runner.state.running = False
        runner.proc = None
        _release_file_lock(lock_path)
        _clear_cancel(data_dir, game)
        try:
            job_file.unlink()
        except OSError:
            pass
        gate.release()
        raise
    return runner.state


def cancel_sweep(game: str, dataset: str) -> dict:
    """Ask this node's running sweep to stop after the current item (writes the cross-process
    cancel flag the child polls; also flips the in-memory flag so the UI shows 'cancelling…')."""
    runner = _runner(game, dataset)
    if runner.state and runner.state.running:
        runner.state.cancel = True
        if runner.data_dir is not None:
            _write_cancel(runner.data_dir, game)
    return runner.state.public() if runner.state else {"running": False}


def cancel_all_sweeps() -> None:
    """Ask every running sweep (any game/dataset) to stop after its current item — used on
    server shutdown so no sweep keeps working during teardown."""
    for (game, _ds), runner in list(_runners.items()):
        if runner.state and runner.state.running:
            runner.state.cancel = True
            if runner.data_dir is not None:
                _write_cancel(runner.data_dir, game)


def shutdown_sweeps(grace: float = 4.0) -> None:
    """Teardown backstop: ask every child to stop (cancel flag), give them ``grace`` seconds to
    flush partial data and exit via their ``finally``, then hard-stop any survivor and reap. The
    stale-lock/stale-status timeouts self-heal anything a truly hard-killed parent leaves."""
    cancel_all_sweeps()
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline:
        if not any(r.proc and r.proc.alive() for r in _runners.values()):
            break
        time.sleep(0.1)
    for runner in list(_runners.values()):
        job = runner.proc
        if job is None:
            continue
        if job.alive():
            job.stop(grace=2.0)
        job.join(timeout=2.0)   # let on_exit reap (release gate/lock/files)


def sweep_status(game: str, dataset: str) -> dict:
    runner = _runner(game, dataset)
    _sync(runner)
    st = runner.state.public() if runner.state else {"running": False, "total": 0, "done": 0}
    st["queued_count"] = _pending_count(game, dataset)   # sweeps waiting behind this one (live)
    return st


def active_sweeps(game: str, data_dir=None) -> list[dict]:
    """Every currently-running sweep for ``game`` (one per dataset). For the Activity panel.

    In-memory runners cover sweeps started in THIS process (child progress mirrored from the
    sidecar); ``data_dir`` (when given) also surfaces a sweep running in ANOTHER process — the
    common case where the web ``serve`` panel must show a sweep the ``collect`` process started
    before the page was loaded."""
    out: list[dict] = []
    for (g, _ds), r in list(_runners.items()):
        if g != game or not r.state:
            continue
        _sync(r)
        if r.state.running:
            out.append(r.state.public())
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


def _note_queued(game: str, dataset: str, mode: str, count: int) -> SweepState:
    """Return a state marking that a fire was QUEUED behind the running sweep (queue_mode != drop).
    ``count`` sweeps now wait; the current sweep's reap drains the next."""
    logev(f"sweep {dataset} queued ({count} waiting)", level="info", game=game)
    return SweepState(game=game, dataset=dataset, mode=mode, queued_count=count,
                      finished=_utcnow_iso())


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
