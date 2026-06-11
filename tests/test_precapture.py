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


def test_rehydrate_frames_from_disk(tmp_path):
    # frames recorded in a prior run (on disk) survive a new session -> reprocessable
    d = tmp_path / "caps" / "testgame" / "precapture"
    d.mkdir(parents=True)
    for i in range(3):
        cv2.imwrite(str(d / f"{i:05d}.jpg"),
                    np.random.default_rng(i).integers(0, 255, (40, 60, 3), dtype=np.uint8))
    s = PrecaptureSession(_engine(tmp_path), _profile())
    st = s.status()
    assert st["frames"] == 3 and st["phase"] == "recorded"


def _frames_on_disk(tmp_path, n=3):
    d = tmp_path / "caps" / "testgame" / "precapture"
    d.mkdir(parents=True)
    for i in range(n):
        cv2.imwrite(str(d / f"{i:05d}.jpg"),
                    np.random.default_rng(i).integers(0, 255, (40, 60, 3), dtype=np.uint8))
    return d


def test_ocr_checkpoint_survives_process_kill(tmp_path):
    # finish OCR, kill the process before saving -> a fresh session still has the results
    _frames_on_disk(tmp_path)
    recs = [Record(values={"item_name": "Adra", "item_count": 1}, confidence=0.9)]
    s1 = _session(tmp_path, recs)
    s1._process_loop(s1._frames, 60, 40)
    assert s1.status()["phase"] == Phase.done.value

    s2 = _session(tmp_path, recs)        # "restart": brand-new session, same disk
    st = s2.status()
    assert st["phase"] == Phase.done.value and st["processed"] == 3
    assert st["datasets"][0]["count"] == 1 and st["datasets"][0]["sample"][-1]["item_name"] == "Adra"


def test_partial_ocr_checkpoint_resumes_not_restarts(tmp_path):
    # killed mid-OCR -> restart keeps the staged rows and continues at the cursor
    _frames_on_disk(tmp_path)
    recs1 = [Record(values={"item_name": "Adra"}, confidence=0.9)]
    s1 = _session(tmp_path, recs1)
    s1._process_loop(s1._frames[:1], 60, 40)   # only frame 0 done before the "kill"

    seen = []
    recs2 = [Record(values={"item_name": "Boar"}, confidence=0.9)]
    s2 = _session(tmp_path, recs2)
    st = s2.status()
    assert st["phase"] == Phase.recorded.value and st["processed"] == 1
    s2._reader.read = lambda frame, window, fields: seen.append(1) or recs2
    s2.start_processing()
    s2._thread.join(timeout=10)
    st = s2.status()
    assert st["phase"] == Phase.done.value and st["processed"] == 3
    assert len(seen) == 2                       # only the 2 remaining frames re-OCR'd
    names = {r["item_name"] for ds in st["datasets"] for r in ds["sample"]}
    assert names == {"Adra", "Boar"}            # pre-kill rows kept, new rows added


def test_saved_checkpoint_not_reoffered_after_restart(tmp_path):
    # save commits and drops the checkpoint -> a restart doesn't re-offer the same rows
    _frames_on_disk(tmp_path)
    recs = [Record(values={"item_name": "Adra"}, confidence=0.9)]
    s1 = _session(tmp_path, recs)
    s1._process_loop(s1._frames, 60, 40)
    s1.save()
    s2 = _session(tmp_path, recs)
    st = s2.status()
    assert st["phase"] == Phase.recorded.value and st["processed"] == 0
    assert st["datasets"] == []


def test_missing_dataset_key_warns(tmp_path):
    recs = [Record(values={"item_name": "Adra", "item_count": 1}, confidence=0.9)]
    s = _session(tmp_path, recs)
    s._profile.datasets[0].key_field = "ghost"   # key doesn't match any field
    s._process_loop([_jpeg(1)], 80, 60)
    st = s.status()
    assert st["datasets"][0]["count"] == 0       # nothing staged
    assert st["read"] == 1
    assert st["warning"] and "key" in st["warning"]


def test_one_bad_frame_does_not_stop_the_run(tmp_path):
    recs = [Record(values={"item_name": "Adra"}, confidence=0.9)]
    s = _session(tmp_path, recs)
    s._process_loop([b"not a jpeg", _jpeg(2)], 80, 60)   # first frame undecodable
    st = s.status()
    assert st["phase"] == Phase.done.value and st["processed"] == 2   # finished, didn't hang
    assert st["error"] and "failed" in st["error"]


def test_processing_records_timing_and_perf_log(tmp_path):
    recs = [Record(values={"item_name": "Adra"}, confidence=0.9)]
    s = _session(tmp_path, recs)
    s._process_loop([_jpeg(1), _jpeg(2)], 80, 60)
    t = s.status()["timing"]
    assert set(t) >= {"device", "ms_per_frame", "decode_ms", "classify_ms", "read_ms"}
    assert t["device"] == "cpu"
    perf = tmp_path / "data" / "testgame" / "precapture_perf.jsonl"
    assert perf.exists() and "ms_per_frame" in perf.read_text(encoding="utf-8")


def test_cancel_stops_processing(tmp_path):
    recs = [Record(values={"item_name": "Adra"}, confidence=0.9)]
    s = _session(tmp_path, recs)
    s.cancel()                       # stop set before processing
    s._process_loop([_jpeg(1), _jpeg(2)], 80, 60)
    assert s.status()["phase"] == Phase.cancelled.value


def test_consolidate_merges_ocr_noise_doubles():
    from oc.collect.precapture import _consolidate
    rows = {k: {"name": k} for k in
            ("amesha", "arnesha", "centaurblueprint", "centourblueprint", "latoblueprint")}
    counts = {"amesha": 30, "arnesha": 2, "centaurblueprint": 25,
              "centourblueprint": 1, "latoblueprint": 18}
    out = _consolidate(rows, counts)
    # rare misreads fold into the frequent spelling; distinct items survive
    assert "amesha" in out and "arnesha" not in out          # 0.77 ratio, but rare vs popular
    assert "centaurblueprint" in out and "centourblueprint" not in out   # near-identical
    assert "latoblueprint" in out
