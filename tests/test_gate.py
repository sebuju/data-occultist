"""Live-mode worthiness gate: cheap colour detectors recognise an OCR-worthy phase
with NO OCR, the classifier's gate_active decides whether OCR is worth it, and the
two-rate run loop polls the gate fast while throttling the OCR-heavy path."""

import numpy as np

import collections
import threading

from oc.collect.collector import Collector, TickResult, TickStatus
from oc.collect.live import LiveSession
from oc.detect.classifier import DetectClassifier
from oc.detect.matcher import DetectMatcher
from oc.profile.merge import merge_profiles
from oc.profile.models import Box, DetectDef, GameProfile, WindowDef
from oc.settings import Tuning
from oc.types import Frame, PixelBox


def _frame(bgr, w=100, h=100):
    img = np.zeros((h, w, 3), dtype=np.uint8)
    img[:, :] = bgr
    return Frame(image=img, client=PixelBox(0, 0, w, h))


def _full_box():
    return Box(x=0.0, y=0.0, w=1.0, h=1.0)


# ---- DetectDef.is_cheap -------------------------------------------------------

def test_is_cheap_classifies_kinds():
    box = _full_box()
    assert DetectDef(id="t", search=box, template="x.png", threshold=0.8).is_cheap
    assert DetectDef(id="c", search=box, color="#00ff00", threshold=0.8).is_cheap
    assert not DetectDef(id="x", search=box, text="REWARD", threshold=0.8).is_cheap
    # text wins even if a colour is also set (text means an OCR read is needed)
    assert not DetectDef(id="m", search=box, text="R", color="#fff", threshold=0.8).is_cheap


# ---- matcher colour / border scoring (real primitives, no OCR) ----------------

def test_color_detector_scores_full_fill():
    m = DetectMatcher(ocr=None, profile_dir=".")
    green = DetectDef(id="g", search=_full_box(), color="#00ff00", tolerance=40, threshold=0.8)
    assert m.score(green, _frame((0, 255, 0))) >= 0.99      # whole frame is the colour
    assert m.score(green, _frame((0, 0, 255))) < 0.2        # red frame: almost nothing near green


def test_border_detector_scores_perimeter_only():
    m = DetectMatcher(ocr=None, profile_dir=".")
    # a frame that is green only on a perimeter ring, black inside
    img = np.zeros((100, 100, 3), dtype=np.uint8)
    img[:10, :] = img[-10:, :] = img[:, :10] = img[:, -10:] = (0, 255, 0)
    frame = Frame(image=img, client=PixelBox(0, 0, 100, 100))
    border = DetectDef(id="b", search=_full_box(), color="#00ff00", tolerance=40,
                       width=0.1, threshold=0.8)
    fill = DetectDef(id="f", search=_full_box(), color="#00ff00", tolerance=40, threshold=0.8)
    assert m.score(border, frame) >= 0.9     # the ring IS the colour
    assert m.score(fill, frame) < 0.5        # most of the whole-fill area is black


def test_evaluate_reports_color_kind():
    m = DetectMatcher(ocr=None, profile_dir=".")
    green = DetectDef(id="g", search=_full_box(), color="#00ff00", tolerance=40, threshold=0.8)
    out = m.evaluate(green, _frame((0, 255, 0)))
    assert out["read"] == "(color)"
    assert out["matched"] and out["passes"]
    assert out["score"] >= 0.8


# ---- gate_active: cheap-only, no OCR -------------------------------------------

class _RecordingOcr:
    """An OCR stub that fails the test loudly if the gate ever asks it to read."""
    def __init__(self):
        self.reads = 0

    def read_line(self, crop):
        self.reads += 1
        return ("", 0.0)

    def read_lines(self, crops):
        self.reads += len(crops)
        return [("", 0.0) for _ in crops]


def _gate_classifier(ocr):
    clf = DetectClassifier.__new__(DetectClassifier)
    clf._matcher = DetectMatcher(ocr=ocr, profile_dir=".")
    return clf


def test_gate_active_when_color_anchor_present_no_ocr():
    ocr = _RecordingOcr()
    clf = _gate_classifier(ocr)
    profile = GameProfile(name="g", detect=[
        DetectDef(id="reward", search=_full_box(), color="#00ff00", tolerance=40, threshold=0.8),
        DetectDef(id="title", search=_full_box(), text="REWARD", threshold=0.8),  # ignored: not cheap
    ])
    assert clf.gate_active(_frame((0, 255, 0)), profile) is True
    assert clf.gate_active(_frame((0, 0, 255)), profile) is False
    assert ocr.reads == 0   # the gate never runs OCR, even with a text detector declared


def test_gate_active_empty_or_text_only_is_always_active():
    ocr = _RecordingOcr()
    clf = _gate_classifier(ocr)
    # no game-level gate at all -> always active (historical behaviour)
    assert clf.gate_active(_frame((0, 0, 0)), GameProfile(name="g")) is True
    # only a text detector -> nothing cheap to gate on -> always active, still no OCR
    text_only = GameProfile(name="g", detect=[
        DetectDef(id="t", search=_full_box(), text="REWARD", threshold=0.8)])
    assert clf.gate_active(_frame((0, 0, 0)), text_only) is True
    assert ocr.reads == 0


def test_gate_active_combine_mode():
    clf = _gate_classifier(_RecordingOcr())
    dets = [
        DetectDef(id="g", search=_full_box(), color="#00ff00", tolerance=40, threshold=0.8),
        DetectDef(id="r", search=_full_box(), color="#0000ff", tolerance=40, threshold=0.8),
    ]
    # green frame: the green detector passes, the red one fails
    green = _frame((0, 255, 0))
    any_p = GameProfile(name="g", detect=dets, detect_mode="any")
    all_p = GameProfile(name="g", detect=dets, detect_mode="all")
    assert clf.gate_active(green, any_p) is True    # OR: one match arms
    assert clf.gate_active(green, all_p) is False   # AND: needs both


def test_gate_active_honours_negate():
    clf = _gate_classifier(_RecordingOcr())
    profile = GameProfile(name="g", detect=[
        DetectDef(id="not_green", search=_full_box(), color="#00ff00",
                  tolerance=40, threshold=0.8, negate=True)])
    # negate: passes when the colour is ABSENT
    assert clf.gate_active(_frame((0, 0, 255)), profile) is True
    assert clf.gate_active(_frame((0, 255, 0)), profile) is False


# ---- two-rate run(): poll gate fast, throttle OCR slow ------------------------

def _run_collector(statuses, *, collect_interval, gate_interval):
    """Drive Collector.run with a scripted tick() and capture the ocr_due flag each
    call. ``statuses`` is the TickStatus each successive tick returns."""
    c = Collector.__new__(Collector)
    c._tuning = Tuning(collect_interval=collect_interval, gate_interval=gate_interval)
    seen = []        # (ocr_due, status) per tick
    seq = iter(statuses)

    def fake_tick(ocr_due=True):
        st = next(seq)
        seen.append((ocr_due, st))
        return TickResult(st)

    c.tick = fake_tick
    c._build_triggers = lambda: None
    c.close = lambda: None
    # stop once the scripted ticks are consumed. Keyed off ticks actually run (len(seen)),
    # not a call counter — should_stop is also polled inside the interruptible sleep.
    n = len(statuses)

    def should_stop():
        return len(seen) >= n

    # the loop checks should_stop before each tick; advance perf_counter via monkeypatch
    import oc.collect.collector as mod
    t = {"v": 0.0}
    orig_pc, orig_sleep = mod.time.perf_counter, mod.time.sleep
    mod.time.perf_counter = lambda: t["v"]
    mod.time.sleep = lambda s: t.__setitem__("v", t["v"] + s)
    try:
        c.run(should_stop=should_stop)
    finally:
        mod.time.perf_counter, mod.time.sleep = orig_pc, orig_sleep
    return seen


def test_two_rate_throttles_ocr_between_gate_polls():
    # gate ACTIVE every poll (status=saved spends the OCR slot). collect_interval 1.0,
    # gate_interval 0.25 -> after an OCR tick the next ~3 polls are throttled (not due),
    # then due again once a full interval has elapsed.
    seen = _run_collector([TickStatus.saved] * 6, collect_interval=1.0, gate_interval=0.25)
    due = [d for d, _ in seen]
    assert due[0] is True                                   # first tick: due
    assert due[1] is False and due[2] is False and due[3] is False   # throttled within 1.0s
    assert due[4] is True                                   # a full interval elapsed -> due


def _live_session():
    s = LiveSession.__new__(LiveSession)
    s._lock = threading.Lock()
    s._frames = 0
    s._written = 0
    s._phase = False
    s._last_status = "no_window"
    s._cur = (None, None)
    s._scroll = None
    s._scroll_meta = None
    s._recog = {}
    s._debug = collections.deque(maxlen=8)
    s._debug_seq = 0
    return s


def test_throttled_tick_keeps_phase_steady():
    # the two-rate flicker fix: a `saved` tick sets the phase; the `throttled` holds between
    # OCR slots must KEEP the current window (not reset to idle), so the live view is steady.
    s = _live_session()
    s._on_tick(TickResult(TickStatus.saved, window_id="equipment", state_id="normal", new=1))
    assert s._cur == ("equipment", "normal") and s._phase is True
    s._on_tick(TickResult(TickStatus.throttled))     # between OCR slots, same screen
    assert s._cur == ("equipment", "normal") and s._phase is True   # held, not flickered to idle
    s._on_tick(TickResult(TickStatus.idle))          # gate genuinely closed
    assert s._cur == (None, None) and s._phase is False


def test_idle_polls_stay_due_so_a_phase_is_caught_instantly():
    # while the gate is inactive (idle) the OCR clock never advances, so every fast poll
    # stays "due" — the instant the phase appears, OCR fires without waiting out a slot.
    seen = _run_collector([TickStatus.idle] * 4, collect_interval=1.0, gate_interval=0.25)
    assert all(d is True for d, _ in seen)


def test_ocr_clock_only_advances_on_heavy_path():
    # a frame that PASSED the gate (status=saved) spends the OCR slot; an idle frame does
    # not, so the next non-idle frame is immediately due even if <interval elapsed.
    seen = _run_collector([TickStatus.idle, TickStatus.saved],
                          collect_interval=1.0, gate_interval=0.25)
    assert seen[0] == (True, TickStatus.idle)    # due, but gate idle -> no slot spent
    assert seen[1][0] is True                    # still due (clock didn't advance on idle)


# ---- profile round-trip + merge -----------------------------------------------

def test_game_detect_round_trips():
    p = GameProfile(name="g", detect=[
        DetectDef(id="reward", search=_full_box(), color="#00ff00",
                  tolerance=40, width=0.1, threshold=0.8)])
    again = GameProfile.model_validate(p.model_dump())
    assert again.detect[0].color == "#00ff00"
    assert again.detect[0].width == 0.1
    assert again.detect[0].is_cheap


def test_merge_preserves_game_gate_on_window_save():
    existing = GameProfile(name="g", detect=[
        DetectDef(id="reward", search=_full_box(), color="#00ff00", tolerance=40, threshold=0.8)],
        windows=[WindowDef(id="w1")])
    # a single-window teach save carries no game-level detect
    incoming = GameProfile(name="g", windows=[WindowDef(id="w2")])
    merged = merge_profiles(existing, incoming)
    assert [d.id for d in merged.detect] == ["reward"]   # gate not wiped
    assert {w.id for w in merged.windows} == {"w1", "w2"}
