"""Window recognition + the priority-order classifier.

The game-level worthiness gate is gone: cheapness now comes from priority-order classify.
The top-priority window is a cheap (no-OCR) colour "gate" for the on-screen gameplay HUD
with no dataset — when it matches, classify early-returns it and the collector reads
nothing; when it doesn't, classify falls through to the real data windows. The two-rate
run loop still polls fast while throttling the OCR-heavy path.
"""

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


# ---- priority-order classify: first match wins, cheap-first, no wasted OCR -----

class _RecordingOcr:
    """An OCR stub that fails the test loudly if classify ever asks it to read."""
    def __init__(self):
        self.reads = 0

    def read_line(self, crop):
        self.reads += 1
        return ("", 0.0)

    def read_lines(self, crops):
        self.reads += len(crops)
        return [("", 0.0) for _ in crops]


def _classifier(ocr):
    clf = DetectClassifier.__new__(DetectClassifier)
    clf._matcher = DetectMatcher(ocr=ocr, profile_dir=".")
    return clf


def test_classify_priority_early_returns_first_match_no_ocr():
    ocr = _RecordingOcr()
    clf = _classifier(ocr)
    # the gate window: a cheap colour probe for the HUD, listed FIRST, with no dataset. A later
    # data window carries an OCR text detector — it must never be read while the gate matches.
    gate = WindowDef(id="gate", detect=[
        DetectDef(id="hud", search=_full_box(), color="#00ff00", tolerance=40, threshold=0.8)])
    relic = WindowDef(id="relic", detect=[
        DetectDef(id="title", search=_full_box(), text="REWARD", threshold=0.8)])
    # relic listed BEFORE gate in profile order, but window_priority puts the gate first
    profile = GameProfile(name="g", windows=[relic, gate], window_priority=["gate", "relic"])
    # green (HUD present): gate matches -> returned first, and the relic's text detector is
    # never OCR'd because the gate short-circuits before it (early-return).
    assert clf.classify(_frame((0, 255, 0)), profile) == ("gate", None)
    assert ocr.reads == 0


def test_classify_priority_falls_through_when_gate_misses():
    clf = _classifier(_RecordingOcr())
    # colours are BGR frames vs #RRGGBB detectors: green HUD = BGR(0,255,0); blue data = BGR(255,0,0)
    gate = WindowDef(id="gate", detect=[
        DetectDef(id="hud", search=_full_box(), color="#00ff00", tolerance=40, threshold=0.8)])
    data = WindowDef(id="data", detect=[
        DetectDef(id="anchor", search=_full_box(), color="#0000ff", tolerance=40, threshold=0.8)])
    profile = GameProfile(name="g", windows=[gate, data], window_priority=["gate", "data"])
    # blue frame: the gate (green) misses, so classify falls through to the next priority window
    assert clf.classify(_frame((255, 0, 0)), profile) == ("data", None)
    # green frame: the gate matches first
    assert clf.classify(_frame((0, 255, 0)), profile) == ("gate", None)


def test_classify_empty_priority_uses_best_fit():
    clf = _classifier(_RecordingOcr())
    # no window_priority -> the best-fit branch. Only the green window matches a green frame.
    green_win = WindowDef(id="green", detect=[
        DetectDef(id="g", search=_full_box(), color="#00ff00", tolerance=40, threshold=0.8)])
    blue_win = WindowDef(id="blue", detect=[
        DetectDef(id="b", search=_full_box(), color="#0000ff", tolerance=40, threshold=0.8)])
    profile = GameProfile(name="g", windows=[blue_win, green_win])   # profile order, no priority
    assert clf.classify(_frame((0, 255, 0)), profile) == ("green", None)


# ---- two-rate run(): poll fast, throttle the OCR-heavy path slow ---------------

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


def test_two_rate_throttles_ocr_between_polls():
    # a matched window every poll (status=saved spends the OCR slot). collect_interval 1.0,
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
    # the two-rate flicker fix: a `saved` tick sets the phase; the `throttled` hold between
    # OCR slots must KEEP the current window (not reset), so the live view is steady.
    s = _live_session()
    s._on_tick(TickResult(TickStatus.saved, window_id="equipment", state_id="normal", new=1))
    assert s._cur == ("equipment", "normal") and s._phase is True
    s._on_tick(TickResult(TickStatus.throttled))     # between OCR slots, same screen
    assert s._cur == ("equipment", "normal") and s._phase is True   # held, not flickered
    s._on_tick(TickResult(TickStatus.unrecognised))  # nothing recognised now
    assert s._cur == (None, None) and s._phase is False


def test_ocr_clock_only_advances_on_heavy_path():
    # a frame that ran the heavy path (status=saved) spends the OCR slot; a pre-classify skip
    # (no_window is heavy-skipped) does not, so the next frame is immediately due even if
    # <interval elapsed.
    seen = _run_collector([TickStatus.no_window, TickStatus.saved],
                          collect_interval=1.0, gate_interval=0.25)
    assert seen[0] == (True, TickStatus.no_window)   # due, but no slot spent (heavy-skipped)
    assert seen[1][0] is True                        # still due (clock didn't advance)


def test_detection_gap_counts_only_read_opportunities():
    # Regression: the detection-batch grace gap (batch_mode: detection) is measured in
    # ``_tick_no``. Under the two-rate loop there are throttle ticks between OCR slots; if
    # those advanced the counter, the gap between two consecutive reads of the SAME visible
    # window would exceed confirm_frames and reset the confirmer EVERY slot, so nothing ever
    # confirmed and detection datasets never saved (relics_refinement bug). Only ocr_due ticks
    # may advance the counter.
    import types

    c = Collector.__new__(Collector)
    c._tick_no = 0
    c._profile = None
    c._engine = object()
    c._locator = types.SimpleNamespace(locate=lambda prof: None)   # no_window -> early return

    assert c.tick(ocr_due=False).status is TickStatus.no_window
    assert c._tick_no == 0                     # throttle tick: gap must NOT widen
    c.tick(ocr_due=True)
    assert c._tick_no == 1                     # a real read opportunity counts
    c.tick(ocr_due=False)
    c.tick(ocr_due=False)
    assert c._tick_no == 1                     # throttle ticks between slots do nothing
    c.tick(ocr_due=True)
    assert c._tick_no == 2                     # two consecutive reads -> gap of 1 (<= confirm_frames)


# ---- merge: window_priority is game-level, preserved on a single-window save --

def test_merge_preserves_window_priority_on_window_save():
    existing = GameProfile(name="g", windows=[WindowDef(id="w1")],
                           window_priority=["w1"])
    # a single-window teach save carries no game-level window_priority
    incoming = GameProfile(name="g", windows=[WindowDef(id="w2")])
    merged = merge_profiles(existing, incoming)
    assert merged.window_priority == ["w1"]              # not wiped
    assert {w.id for w in merged.windows} == {"w1", "w2"}
