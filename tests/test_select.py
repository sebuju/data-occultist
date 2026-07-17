"""The shared window-selection rule (oc.detect.select) and its agreement with the classifier.

The teach-UI collision check and the runtime classifier MUST pick the same winner, or the check
falsely reports a correctly-classified window as misclassified (it did: it used best-fit while the
classifier uses priority). These tests pin the shared rule and assert classify() stays in step.
"""

import numpy as np

from oc.detect.classifier import DetectClassifier
from oc.detect.matcher import DetectMatcher
from oc.detect.select import WinCand, aggregate_fit, priority_order, select_winner
from oc.profile.models import Box, DetectCombine, DetectDef, GameProfile, WindowDef
from oc.types import Frame, PixelBox


def _frame(bgr, w=100, h=100):
    img = np.zeros((h, w, 3), dtype=np.uint8)
    img[:, :] = bgr
    return Frame(image=img, client=PixelBox(0, 0, w, h))


def _box():
    return Box(x=0.0, y=0.0, w=1.0, h=1.0)


# ---- select_winner: pure rule ------------------------------------------------

def test_priority_beats_higher_score():
    # THE regression: live_game_window (priority 1, score 0.6) must beat arsenal (priority 6,
    # score 1.0). Priority mode is pure true/false — a lower-priority higher score never steals.
    p = GameProfile(name="g", windows=[WindowDef(id="a"), WindowDef(id="b")],
                    window_priority=["a", "b"])
    assert select_winner(p, [WinCand("a", True, 0.6, 1), WinCand("b", True, 1.0, 1)]) == "a"


def test_priority_skips_failing_higher_priority():
    p = GameProfile(name="g", windows=[WindowDef(id="a"), WindowDef(id="b")],
                    window_priority=["a", "b"])
    # a is higher priority but did NOT pass -> the next passing priority window wins.
    assert select_winner(p, [WinCand("a", False, 1.0, 1), WinCand("b", True, 0.5, 1)]) == "b"


def test_best_fit_without_priority():
    p = GameProfile(name="g", windows=[WindowDef(id="a"), WindowDef(id="b")])
    assert select_winner(p, [WinCand("a", True, 0.6, 1), WinCand("b", True, 0.9, 1)]) == "b"  # score
    # score tie -> more detectors (specificity)
    assert select_winner(p, [WinCand("a", True, 0.9, 2), WinCand("b", True, 0.9, 1)]) == "a"


def test_none_when_nothing_passes():
    p = GameProfile(name="g", windows=[WindowDef(id="a")], window_priority=["a"])
    assert select_winner(p, [WinCand("a", False, 1.0, 1)]) is None


def test_priority_order_names_first_then_profile_order():
    a, b, c = WindowDef(id="a"), WindowDef(id="b"), WindowDef(id="c")
    p = GameProfile(name="g", windows=[a, b, c], window_priority=["c", "a"])
    assert [w.id for w in priority_order(p)] == ["c", "a", "b"]


def test_aggregate_fit_weakest_all_strongest_any():
    assert aggregate_fit([0.4, 0.9], DetectCombine.all) == 0.4   # every detector must fit -> worst
    assert aggregate_fit([0.4, 0.9], DetectCombine.any) == 0.9   # one good fit suffices -> best
    assert aggregate_fit([], DetectCombine.all) == 0.0


# ---- classify agrees with select_winner (drift guard) ------------------------

def _clf():
    clf = DetectClassifier.__new__(DetectClassifier)
    clf._matcher = DetectMatcher(ocr=None, profile_dir=".")
    return clf


def _cands(clf, profile, frame):
    return [WinCand(w.id, clf._window_matches(w, frame), clf._window_score(w, frame),
                    len([d for d in w.detect if d.enabled]))
            for w in profile.windows]


def test_classify_priority_matches_select_winner():
    clf = _clf()
    # both windows pass a green frame; the LOWER-priority one has more detectors (a higher best-fit
    # tie-break), yet priority must still pick the first — classify and select_winner must agree.
    a = WindowDef(id="a", detect=[
        DetectDef(id="g", search=_box(), colors=["#00ff00"], tolerance=40, threshold=0.8)])
    b = WindowDef(id="b", detect=[
        DetectDef(id="g1", search=_box(), colors=["#00ff00"], tolerance=40, threshold=0.8),
        DetectDef(id="g2", search=_box(), colors=["#00ff00"], tolerance=40, threshold=0.8)])
    p = GameProfile(name="g", windows=[a, b], window_priority=["a", "b"])
    frame = _frame((0, 255, 0))
    assert clf.classify(frame, p)[0] == "a"
    assert clf.classify(frame, p)[0] == select_winner(p, _cands(clf, p, frame))


def test_classify_best_fit_matches_select_winner():
    clf = _clf()
    g = WindowDef(id="green", detect=[
        DetectDef(id="g", search=_box(), colors=["#00ff00"], tolerance=40, threshold=0.8)])
    bl = WindowDef(id="blue", detect=[
        DetectDef(id="b", search=_box(), colors=["#0000ff"], tolerance=40, threshold=0.8)])
    p = GameProfile(name="g", windows=[bl, g])   # no window_priority -> best-fit branch
    frame = _frame((0, 255, 0))
    assert clf.classify(frame, p)[0] == "green"
    assert clf.classify(frame, p)[0] == select_winner(p, _cands(clf, p, frame))
