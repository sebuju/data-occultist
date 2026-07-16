"""Producer queue_mode: a fire that arrives while a node is already sweeping is dropped (default),
coalesced to the newest batch (``latest``), or queued FIFO (``queue``). Pure logic — we simulate a
running sweep by seeding the in-memory runner state instead of spawning a child process.
"""

import pytest

from oc.enrich import price_runner as pr
from oc.enrich.price_runner import SweepState
from oc.profile.models import ProducerDef


@pytest.fixture(autouse=True)
def _clean_module_state():
    # these tests seed the module-global _runners/_pending; clear before AND after so state never
    # leaks into other price_runner tests (e.g. active_sweeps in test_sweep_status).
    pr._pending.clear()
    pr._runners.clear()
    yield
    pr._pending.clear()
    pr._runners.clear()


def _reset():
    pr._pending.clear()
    pr._runners.clear()


def _mark_running(game, dataset):
    r = pr._runner(game, dataset)
    r.state = SweepState(game=game, dataset=dataset, running=True)
    r.proc = None   # _sync() is a no-op with no child, so running stays True
    return r


def test_queue_request_modes_and_dequeue_order():
    _reset()
    req = lambda i: {"i": i}   # noqa: E731
    # drop -> never enqueues
    assert pr._queue_request("g", "d", "drop", req(1)) == 0
    assert pr._pending_count("g", "d") == 0
    # latest -> keeps only the newest
    assert pr._queue_request("g", "d", "latest", req(1)) == 1
    assert pr._queue_request("g", "d", "latest", req(2)) == 1
    assert pr._dequeue_request("g", "d")["i"] == 2          # newest survived
    assert pr._dequeue_request("g", "d") is None
    # queue -> FIFO, drains in order
    assert pr._queue_request("g", "d", "queue", req(1)) == 1
    assert pr._queue_request("g", "d", "queue", req(2)) == 2
    assert pr._dequeue_request("g", "d")["i"] == 1
    assert pr._dequeue_request("g", "d")["i"] == 2
    assert pr._pending_count("g", "d") == 0


def test_start_sweep_queues_when_busy_latest():
    _reset()
    _mark_running("g", "d")
    node = ProducerDef(id="px", dataset="d", queue_mode="latest")
    st = pr.start_sweep("data", "g", node, items=["A"])
    assert st.queued_count == 1
    assert pr._pending_count("g", "d") == 1
    # a second fire coalesces (latest) — still one pending, and it's the newest batch
    pr.start_sweep("data", "g", node, items=["B"])
    assert pr._pending_count("g", "d") == 1
    assert pr._dequeue_request("g", "d")["items"] == ["B"]


def test_start_sweep_drops_when_busy_drop_mode():
    _reset()
    running = _mark_running("g", "d")
    node = ProducerDef(id="px", dataset="d", queue_mode="drop")
    st = pr.start_sweep("data", "g", node, items=["A"])
    assert st is running.state                 # returns the running state, no queue
    assert pr._pending_count("g", "d") == 0


def test_sweep_status_surfaces_queued_count():
    _reset()
    _mark_running("g", "d")
    node = ProducerDef(id="px", dataset="d", queue_mode="queue")
    pr.start_sweep("data", "g", node, items=["A"])
    pr.start_sweep("data", "g", node, items=["B"])
    assert pr.sweep_status("g", "d")["queued_count"] == 2
