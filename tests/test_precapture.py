"""Precapture batch pipeline: detect/data skips, staging dedup, save."""

from types import SimpleNamespace

import cv2
import numpy as np

from oc.collect.precapture import PrecaptureSession, Phase, _detect_boxes, _sig
from oc.collect.reader import Record
from oc.profile.models import (
    Box, DetectDef, FieldDef, GameProfile, KeyDef, RegionDef, WindowDef,
)
from oc.settings import Settings, Tuning
from oc.store.dataset_store import DatasetStore
from oc.store.keys import KeySpec


def _profile():
    win = WindowDef(
        id="equip",
        dataset="equip",
        key=KeyDef(fields=["item_name"]),
        fields=[FieldDef(id="item_name"), FieldDef(id="item_count")],
        regions=[RegionDef(id="n", box=Box(x=0, y=0.5, w=0.5, h=0.1), field="item_name")],
        detect=[DetectDef(id="a", search=Box(x=0.0, y=0.0, w=0.2, h=0.1), text="inv", threshold=0.8)],
    )
    return GameProfile(name="testgame", windows=[win])


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
        read=lambda frame, window, fields: (reads, None),
    )
    return s


def _jpeg(seed):
    rng = np.random.default_rng(seed)
    img = rng.integers(0, 255, (60, 80, 3), dtype=np.uint8)
    return cv2.imencode(".jpg", img)[1].tobytes()


def test_detect_boxes_gathers_window_and_state_detectors():
    boxes = _detect_boxes(_profile())
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


def test_window_without_dataset_discards(tmp_path):
    # a window with no dataset produces records that are DISCARDED, never staged
    recs = [Record(values={"item_name": "Adra"}, confidence=0.9)]
    s = _session(tmp_path, recs)
    s._profile.windows[0].dataset = None
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
    store = DatasetStore(tmp_path / "data", "testgame", "equip", key=KeySpec(("item_name",)))
    rows = store.records()
    assert rows[0]["item_name"] == "Adra" and rows[0]["item_count"] == 3


def test_grab_frame_uses_streaming_backend_for_both_paths(tmp_path):
    # a streaming engine backend (WGC default) is read for foreground AND background -> the
    # private mss grabber is never touched (its per-grab BitBlt leaves the hot path).
    from oc.types import Frame, PixelBox
    s = PrecaptureSession(_engine(tmp_path), _profile())
    good = Frame(image=np.ones((4, 4, 3), np.uint8), client=PixelBox(0, 0, 4, 4))
    calls = {"stream": 0, "mss": 0}
    def stream_grab(win):
        calls["stream"] += 1
        return good
    s._engine.capture = SimpleNamespace(streaming=True, grab_window=stream_grab)
    s._screen = SimpleNamespace(grab_window=lambda win: calls.__setitem__("mss", calls["mss"] + 1) or good)
    s._grab_frame(object(), foreground=True)
    s._grab_frame(object(), foreground=False)
    assert calls == {"stream": 2, "mss": 0}


def test_grab_frame_falls_back_to_mss_when_backend_not_streaming(tmp_path):
    # non-streaming engine backend (printwindow/mss): foreground uses the private mss grabber
    # (avoids a per-poll re-render/BitBlt through the engine backend).
    from oc.types import Frame, PixelBox
    s = PrecaptureSession(_engine(tmp_path), _profile())
    good = Frame(image=np.full((4, 4, 3), 200, np.uint8), client=PixelBox(0, 0, 4, 4))
    calls = {"engine": 0, "mss": 0}
    s._engine.capture = SimpleNamespace(  # no streaming attr -> getattr(..., False)
        grab_window=lambda win: calls.__setitem__("engine", calls["engine"] + 1) or good)
    s._screen = SimpleNamespace(grab_window=lambda win: calls.__setitem__("mss", calls["mss"] + 1) or good)
    s._grab_frame(object(), foreground=True)
    assert calls == {"engine": 0, "mss": 1}   # foreground -> mss, engine untouched
    s._grab_frame(object(), foreground=False)
    assert calls == {"engine": 1, "mss": 1}   # background -> engine backend


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


def _settled_grabber(seed):
    # two distinct, each settled (sent twice) so the record loop keeps BOTH; once the
    # sequence drains it repeats the last (== last kept -> dropped), so the run ends on
    # max_frames rather than starving for new frames.
    from oc.types import Frame, PixelBox
    rng = np.random.default_rng(seed)
    a = rng.integers(0, 255, (50, 70, 3), dtype=np.uint8)
    b = rng.integers(0, 255, (50, 70, 3), dtype=np.uint8)
    seq = [a, a, b, b]
    def grab(win):
        return Frame(image=seq.pop(0) if seq else b, client=PixelBox(0, 0, 70, 50))
    return grab


def test_auto_process_runs_ocr_when_recording_self_ends(tmp_path):
    # auto_process on + a natural end (max_frames) -> recording rolls straight into OCR
    s = _session(tmp_path, [Record(values={"item_name": "Adra"}, confidence=0.9)])
    s._engine.capture.grab_window = _settled_grabber(11)
    s._locator = SimpleNamespace(locate=lambda profile: object())
    s._engine.window.is_foreground = lambda win: True
    s._auto_process = True
    s._phase = Phase.recording
    s._record_loop(max_frames=2, interval=0)   # 2 frames kept -> max_frames -> auto-process
    assert s._thread is not None
    s._thread.join(timeout=10)
    st = s.status()
    assert st["phase"] == Phase.done.value           # processed, not left at "recorded"
    assert st["processed"] == 2
    assert st["datasets"] and st["datasets"][0]["dataset"] == "equip"


def test_no_auto_process_leaves_recording_recorded(tmp_path):
    # auto_process off -> a self-ended recording stops at "recorded" (no OCR launched)
    s = _session(tmp_path, [Record(values={"item_name": "Adra"}, confidence=0.9)])
    s._engine.capture.grab_window = _settled_grabber(12)
    s._locator = SimpleNamespace(locate=lambda profile: object())
    s._phase = Phase.recording
    s._record_loop(max_frames=2, interval=0)
    assert s._thread is None
    assert s.status()["phase"] == Phase.recorded.value


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
    s1._process_loop(s1._frame_paths, 60, 40)   # loaded session -> frames read lazily from disk
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
    s1._process_loop(s1._frame_paths[:1], 60, 40)   # only frame 0 done before the "kill"

    seen = []
    recs2 = [Record(values={"item_name": "Boar"}, confidence=0.9)]
    s2 = _session(tmp_path, recs2)
    st = s2.status()
    assert st["phase"] == Phase.recorded.value and st["processed"] == 1
    s2._reader.read = lambda frame, window, fields: (seen.append(1), (recs2, None))[1]
    s2.start_processing()
    s2._thread.join(timeout=10)
    st = s2.status()
    assert st["phase"] == Phase.done.value and st["processed"] == 3
    assert len(seen) == 2                       # only the 2 remaining frames re-OCR'd
    names = {r["item_name"] for ds in st["datasets"] for r in ds["sample"]}
    assert names == {"Adra", "Boar"}            # pre-kill rows kept, new rows added


def test_saved_session_keeps_records_for_resave(tmp_path):
    # a saved session RETAINS its processed records (checkpoint kept) so it can be loaded
    # and saved again without re-recording — and is flagged saved in the session list
    _frames_on_disk(tmp_path)
    recs = [Record(values={"item_name": "Adra"}, confidence=0.9)]
    s1 = _session(tmp_path, recs)
    s1._process_loop(s1._frame_paths, 60, 40)
    s1.save()
    s2 = _session(tmp_path, recs)
    st = s2.status()
    assert st["phase"] == Phase.done.value and st["processed"] == 3
    names = {r["item_name"] for ds in st["datasets"] for r in ds["sample"]}
    assert names == {"Adra"}                       # records still there to re-save
    sess = s2.list_sessions()
    assert len(sess) == 1 and sess[0]["saved_at"] and sess[0]["records"] == 1


def _session_on_disk(tmp_path, sid, n=2):
    d = tmp_path / "caps" / "testgame" / "precapture" / sid
    d.mkdir(parents=True)
    for i in range(n):
        cv2.imwrite(str(d / f"{i:05d}.jpg"),
                    np.random.default_rng(i).integers(0, 255, (40, 60, 3), dtype=np.uint8))
    (d / "meta.json").write_text(f'{{"label": "{sid}"}}', encoding="utf-8")
    return d


def test_sessions_list_load_delete(tmp_path):
    # two recorded sessions on disk: list newest-first, the active one rehydrates, and
    # load/delete switch between them without re-recording
    _session_on_disk(tmp_path, "20200101-000000-000001", 2)
    _session_on_disk(tmp_path, "20200101-000000-000002", 3)
    recs = [Record(values={"item_name": "Adra"}, confidence=0.9)]
    s = _session(tmp_path, recs)
    lst = s.list_sessions()
    assert [x["id"] for x in lst] == ["20200101-000000-000002", "20200101-000000-000001"]
    assert s.status()["frames"] == 3                 # active = newest, already rehydrated
    s.load_session("20200101-000000-000001")
    assert s.status()["frames"] == 2
    s.delete_session("20200101-000000-000001")
    assert len(s.list_sessions()) == 1
    assert s.status()["frames"] == 3                 # fell back to the remaining session


def test_missing_key_part_warns(tmp_path):
    recs = [Record(values={"item_name": "Adra", "item_count": 1}, confidence=0.9)]
    s = _session(tmp_path, recs)
    s._profile.windows[0].key = KeyDef(fields=["ghost"])   # key doesn't match any field
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


def test_consolidate_composite_keys_compare_per_part():
    # "arcane aegis|5" vs "arcane aegis|3" are 93% alike as strings but differ entirely
    # in the level part — they must never merge. Name-part OCR noise still folds.
    from oc.collect.precapture import _consolidate
    rows = {k: {} for k in ("arcane aegis|5", "arcane aegis|3", "amesha|0", "arnesha|0")}
    counts = {"arcane aegis|5": 20, "arcane aegis|3": 15, "amesha|0": 30, "arnesha|0": 2}
    parts = {"arcane aegis|5": ["arcane aegis", "5"], "arcane aegis|3": ["arcane aegis", "3"],
             "amesha|0": ["amesha", "0"], "arnesha|0": ["arnesha", "0"]}
    out = _consolidate(rows, counts, parts)
    assert "arcane aegis|5" in out and "arcane aegis|3" in out   # levels never merge
    assert "amesha|0" in out and "arnesha|0" not in out          # noise still folds
