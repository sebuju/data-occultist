"""Cross-process sweep visibility — a sweep running in the `collect` process must show up in
the `serve` process's Activity panel via the on-disk status sidecar (in-memory `_runners` are
per-process). Pure logic: we fake the foreign status file instead of spawning a process.
"""

import json
import os
import time

from oc.enrich.price_runner import _STATUS_STALE, _status_path, active_sweeps


def _write_status(tmp_path, game, pid, updated, state):
    p = _status_path(tmp_path, game)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"pid": pid, "updated": updated, "state": state}), encoding="utf-8")


def test_active_sweeps_surfaces_foreign_running_sweep(tmp_path):
    st = {"dataset": "prices", "running": True, "done": 3, "total": 10}
    _write_status(tmp_path, "g", os.getpid() + 1, time.time(), st)        # another live process
    out = active_sweeps("g", tmp_path)
    assert [s["dataset"] for s in out] == ["prices"]                      # now visible here


def test_active_sweeps_ignores_own_pid_status(tmp_path):
    # our own sweeps come from in-memory _runners; a same-pid file must not double them
    _write_status(tmp_path, "g", os.getpid(), time.time(), {"dataset": "prices", "running": True})
    assert active_sweeps("g", tmp_path) == []


def test_active_sweeps_prunes_stale_foreign(tmp_path):
    # writer died mid-sweep -> stale file must not haunt the panel, and is pruned on read
    _write_status(tmp_path, "g", os.getpid() + 1, time.time() - _STATUS_STALE - 5,
                  {"dataset": "prices", "running": True})
    assert active_sweeps("g", tmp_path) == []
    assert not _status_path(tmp_path, "g").exists()


def test_active_sweeps_ignores_finished_foreign(tmp_path):
    _write_status(tmp_path, "g", os.getpid() + 1, time.time(), {"dataset": "prices", "running": False})
    assert active_sweeps("g", tmp_path) == []


def test_active_sweeps_without_data_dir_is_in_memory_only(tmp_path):
    # back-compat: no data_dir -> disk is not consulted (old behaviour)
    _write_status(tmp_path, "g", os.getpid() + 1, time.time(), {"dataset": "p", "running": True})
    assert active_sweeps("g") == []
