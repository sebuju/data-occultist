"""Precapture batch pipeline: anchor/data skips, staging dedup, save."""

from types import SimpleNamespace

import cv2
import numpy as np

from oc.collect.precapture import PrecaptureSession, Phase, _anchor_boxes, _sig
from oc.collect.reader import Record
from oc.profile.models import (
    AnchorDef, Box, DatasetDef, FieldDef, GameProfile, RegionDef, WindowDef,
)
from oc.settings import Settings, Tuning
from oc.store.dataset_store import DatasetStore


def _profile():
    win = WindowDef(
        id="equip",
        fields=[FieldDef(id="item_name"), FieldDef(id="item_count")],
        regions=[RegionDef(id="n", box=Box(x=0, y=0.5, w=0.5, h=0.1), field="item_name")],
        anchors=[AnchorDef(id="a", search=Box(x=0.0, y=0.0, w=0.2, h=0.1), text="inv")],
    )
    return GameProfile(name="testgame", datasets=[DatasetDef(id="equip", key_field="item_name")],
                       windows=[win])


def _engine(tmp_path):
    settings = Settings(data_dir=str(tmp_path / "data"), captures_dir=str(tmp_path / "caps"),
                        profiles_dir=str(tmp_path / "prof"), tuning=Tuning())
    # ocr/corrector/capture/window unused once we swap the reader/classifier
    return SimpleNamespace(settings=settings, ocr=None, corrector=SimpleNamespace(),
                           capture=SimpleNamespace(), classifier=SimpleNamespace(),
                           window=SimpleNamespace())


def _session(tmp_path, reads, classify=("equip", None)):
    s = PrecaptureSession(_engine(tmp_path), _profile())
    # fake classifier + reader: classify returns the window, read returns canned records
    s._engine.classifier.classify = lambda frame, profile: classify
    s._reader = SimpleNamespace(
        region_signature=lambda frame, window: None,           # never cache by data area
        read=lambda frame, window, fields: reads,
    )
    return s


def _jpeg(seed):
    rng = np.random.default_rng(seed)
    img = rng.integers(0, 255, (60, 80, 3), dtype=np.uint8)
    return cv2.imencode(".jpg", img)[1].tobytes()


def test_anchor_boxes_gathers_window_and_state_anchors():
    boxes = _anchor_boxes(_profile())
    assert len(boxes) == 1


def test_signature_changes_with_pixels():
    a = np.zeros((40, 40, 3), np.uint8)
    b = a.copy(); b[0, 0] = 255
    assert _sig(a) != _sig(b)
    assert _sig(a) == _sig(a.copy())


def test_process_stages_and_dedups(tmp_path):
    recs = [Record(values={"item_name": "Adra", "item_count": 1}, confidence=0.9),
            Record(values={"item_name": "Adra", "item_count": 2}, confidence=0.9)]
    s = _session(tmp_path, recs)
    s._process_loop([_jpeg(1), _jpeg(2)], 80, 60)
    st = s.status()
    assert st["phase"] == Phase.done.value
    assert st["processed"] == 2
    ds = st["datasets"][0]
    assert ds["dataset"] == "equip" and ds["count"] == 1   # same key -> one staged row
    assert ds["sample"][-1]["item_count"] == 2             # last value wins


def test_confidence_floor_drops_low_reads(tmp_path):
    recs = [Record(values={"item_name": "Junk"}, confidence=0.1)]  # below floor 0.5
    s = _session(tmp_path, recs)
    s._process_loop([_jpeg(1)], 80, 60)
    assert s.status()["datasets"] == []


def test_unrecognised_window_stages_nothing(tmp_path):
    recs = [Record(values={"item_name": "Adra"}, confidence=0.9)]
    s = _session(tmp_path, recs, classify=None)   # classifier finds no window
    s._process_loop([_jpeg(1)], 80, 60)
    assert s.status()["processed"] == 1
    assert s.status()["datasets"] == []


def test_save_commits_to_real_store(tmp_path):
    recs = [Record(values={"item_name": "Adra", "item_count": 3}, confidence=0.9)]
    s = _session(tmp_path, recs)
    s._process_loop([_jpeg(1)], 80, 60)
    written = s.save()
    assert written == {"equip": 1}
    assert s.status()["phase"] == Phase.saved.value
    store = DatasetStore(tmp_path / "data", "testgame", "equip", "item_name")
    rows = store.records()
    assert rows[0]["item_name"] == "Adra" and rows[0]["item_count"] == 3


def test_recording_skips_identical_frames(tmp_path):
    s = PrecaptureSession(_engine(tmp_path), _profile())
    from oc.types import Frame, PixelBox
    rng = np.random.default_rng(7)
    a = rng.integers(0, 255, (50, 70, 3), dtype=np.uint8)
    b = rng.integers(0, 255, (50, 70, 3), dtype=np.uint8)
    seq = [a, a, a, b, b, a]            # kept: a, b, a -> 3 (consecutive dups dropped)
    def grab(win):
        if not seq:
            s._stop.set()
            return Frame(image=a, client=PixelBox(0, 0, 70, 50))
        return Frame(image=seq.pop(0), client=PixelBox(0, 0, 70, 50))
    s._engine.capture.grab_window = grab
    s._locator = SimpleNamespace(locate=lambda profile: object())
    s._record_loop(max_frames=100, interval=0)
    assert len(s._frames) == 3


def test_recording_skips_cursor_only_moves(tmp_path):
    s = PrecaptureSession(_engine(tmp_path), _profile())
    from oc.types import Frame, PixelBox
    rng = np.random.default_rng(3)
    base = rng.integers(0, 255, (480, 640, 3), dtype=np.uint8)
    cur1 = base.copy(); cur1[10:22, 10:22] = 255       # small cursor here
    cur2 = base.copy(); cur2[10:22, 40:52] = 255       # cursor nudged a little
    scrolled = rng.integers(0, 255, (480, 640, 3), dtype=np.uint8)  # whole view changed
    seq = [cur1, cur2, cur1, scrolled]
    def grab(win):
        if not seq:
            s._stop.set()
            return Frame(image=scrolled, client=PixelBox(0, 0, 640, 480))  # == last kept -> dropped
        return Frame(image=seq.pop(0), client=PixelBox(0, 0, 640, 480))
    s._engine.capture.grab_window = grab
    s._locator = SimpleNamespace(locate=lambda profile: object())
    s._record_loop(max_frames=100, interval=0)
    assert len(s._frames) == 2   # cur1 + scrolled; cursor-only moves dropped


def test_cancel_stops_processing(tmp_path):
    recs = [Record(values={"item_name": "Adra"}, confidence=0.9)]
    s = _session(tmp_path, recs)
    s.cancel()                       # stop set before processing
    s._process_loop([_jpeg(1), _jpeg(2)], 80, 60)
    assert s.status()["phase"] == Phase.cancelled.value
