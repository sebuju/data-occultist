"""GPU watchdog: release only when the front end is gone AND OCR is idle AND no worker runs."""

from __future__ import annotations

import threading
import time

from oc.ocr import serialize
from oc.web import gpu_watch


class FakeOcr:
    def __init__(self):
        self.gpu_active = True
        self.released = False

    def release(self):
        self.released = True
        self.gpu_active = False


class FakeEngine:
    def __init__(self, ocr):
        self.ocr = ocr


def _arm(monkeypatch, ocr, *, clients=0, gone_s=100.0, idle_s=100.0,
         precapture=False, live=False):
    """Put every gate in the given state (defaults: all gates open -> release fires)."""
    monkeypatch.setattr(gpu_watch, "_clients", clients)
    monkeypatch.setattr(gpu_watch, "_last_client", time.monotonic() - gone_s)
    monkeypatch.setattr(serialize.OCR_LOCK, "_last", time.monotonic() - idle_s)
    monkeypatch.setattr("oc.web.deps.get_engine", lambda: FakeEngine(ocr))
    monkeypatch.setattr("oc.web.routes.precapture.any_running", lambda: precapture)
    monkeypatch.setattr("oc.web.routes.live.any_running", lambda: live)


def test_releases_when_all_gates_open(monkeypatch):
    ocr = FakeOcr()
    _arm(monkeypatch, ocr)
    gpu_watch._maybe_release()
    assert ocr.released


def test_holds_while_client_connected(monkeypatch):
    ocr = FakeOcr()
    _arm(monkeypatch, ocr, clients=1)
    gpu_watch._maybe_release()
    assert not ocr.released


def test_holds_while_ocr_recently_used(monkeypatch):
    ocr = FakeOcr()
    _arm(monkeypatch, ocr, idle_s=1.0)
    gpu_watch._maybe_release()
    assert not ocr.released


def test_holds_while_worker_running(monkeypatch):
    for kind in ("precapture", "live"):
        ocr = FakeOcr()
        _arm(monkeypatch, ocr, **{kind: True})
        gpu_watch._maybe_release()
        assert not ocr.released, kind


def test_holds_while_gpu_not_active(monkeypatch):
    ocr = FakeOcr()
    ocr.gpu_active = False
    _arm(monkeypatch, ocr)
    gpu_watch._maybe_release()
    assert not ocr.released


def test_holds_while_ocr_lock_held(monkeypatch):
    ocr = FakeOcr()
    _arm(monkeypatch, ocr)
    grabbed, done = threading.Event(), threading.Event()

    def hold():
        with serialize.OCR_LOCK:
            grabbed.set()
            done.wait(5.0)

    t = threading.Thread(target=hold, daemon=True)
    t.start()
    assert grabbed.wait(5.0)
    try:
        # entering the lock stamped _last = now; re-arm the idle clock so THIS gate
        # (lock held from another thread -> idle_for() == 0) is the one under test
        monkeypatch.setattr(serialize.OCR_LOCK, "_last", time.monotonic() - 100.0)
        assert serialize.ocr_idle_for() == 0.0
        gpu_watch._maybe_release()
        assert not ocr.released
    finally:
        done.set()
        t.join(5.0)


def test_idle_stamp_tracks_lock_traffic():
    with serialize.OCR_LOCK:
        pass
    assert serialize.ocr_idle_for() < 5.0


def test_frontend_gone_timer(monkeypatch):
    monkeypatch.setattr(gpu_watch, "_clients", 1)
    assert gpu_watch.frontend_gone_for() == 0.0
    monkeypatch.setattr(gpu_watch, "_clients", 0)
    monkeypatch.setattr(gpu_watch, "_last_client", time.monotonic() - 42.0)
    assert gpu_watch.frontend_gone_for() >= 42.0
