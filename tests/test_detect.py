"""Detect text matching dismisses over-long reads; a window needs ALL detectors."""

from types import SimpleNamespace

from oc.detect.matcher import text_match_score
from oc.detect.classifier import DetectClassifier
from oc.profile.models import Box, DetectDef, GameProfile, WindowDef


def test_clean_match_scores_high():
    assert text_match_score("INVENTORY / SELL", "INVTNTORYSELL", included=True) >= 0.8


def test_long_read_is_dismissed():
    # the box read a paragraph that merely contains the target -> not the landmark
    blob = "search" + "x" * 80
    assert text_match_score("search", blob) == 0.0
    assert text_match_score("search", blob, included=True) == 0.0


def test_short_fragment_still_matches():
    # a slightly-longer-than-target read is fine (some slack)
    assert text_match_score("NAME", "NAME:") >= 0.8
    assert text_match_score("search", "searchbar") >= 0.8


def test_tiny_substring_is_dismissed():
    # a near-empty box reads a 2-3 char blob that happens to sit inside the target;
    # partial_ratio would score it ~1.0, so the too-short guard must reject it
    assert text_match_score("reward", "war") == 0.0
    assert text_match_score("reward", "re", included=True) == 0.0
    assert text_match_score("inventory", "in") == 0.0


def test_empty_is_zero():
    assert text_match_score("x", "") == 0.0
    assert text_match_score("", "y") == 0.0


def test_partial_waves_through_near_substring():
    # the reported bug: 'WARDSI' shares "wards" with 'rewards', so partial_ratio
    # aligns it and scores high — loose by design, this is what 'full' fixes.
    assert text_match_score("rewards", "WARDSI", mode="partial") >= 0.8


def test_full_mode_rejects_near_substring():
    # whole-string ratio: the extra/missing chars cost, so the same pair fails 0.8
    assert text_match_score("rewards", "WARDSI", mode="full") < 0.8
    # but a clean noisy read of the real word still passes
    assert text_match_score("rewards", "REWARDS", mode="full") >= 0.8


def test_exact_mode_is_all_or_nothing():
    assert text_match_score("inventory", "INVENTORY", mode="exact") == 1.0
    assert text_match_score("inventory", "inventori", mode="exact") == 0.0


def test_prefix_mode():
    # included=False: the detect text begins the read (read may have trailing junk)
    assert text_match_score("equipment", "EQUIPMENT UPGRADE", mode="prefix") == 1.0
    assert text_match_score("equipment", "loadout", mode="prefix") < 0.8
    # included=True: the read is a prefix of the detect text (truncated read)
    assert text_match_score("inventory", "INV", mode="prefix", included=True) == 1.0


def test_min_chars_floor():
    # a 4-char read that would otherwise match is killed by a higher floor
    assert text_match_score("name", "NAME", mode="full") >= 0.8
    assert text_match_score("name", "NAME", mode="full", min_chars=5) == 0.0


def test_case_sensitive():
    assert text_match_score("Name", "name", mode="exact") == 1.0          # folded
    assert text_match_score("Name", "name", mode="exact", case_sensitive=True) == 0.0


def test_strip_mode_keeps_punctuation():
    # default alnum drops the slash; 'none'/'spaces' keep it significant
    assert text_match_score("a/b", "ab", mode="exact") == 1.0
    assert text_match_score("a/b", "ab", mode="exact", strip="none") == 0.0
    assert text_match_score("a / b", "a/b", mode="exact", strip="spaces") == 1.0


def _classifier_with(matched: dict):
    win = WindowDef(id="equip", detect=[
        DetectDef(id="a", search=Box(x=0, y=0, w=0.1, h=0.1), text="inventory", threshold=0.8),
        DetectDef(id="b", search=Box(x=0.2, y=0, w=0.1, h=0.1), text="name", threshold=0.8),
    ])
    profile = GameProfile(name="g", windows=[win])
    clf = DetectClassifier.__new__(DetectClassifier)
    clf._matcher = SimpleNamespace(matches=lambda det, frame: matched.get(det.id, False))
    return clf, profile


def test_window_matches_only_when_all_detectors_true():
    clf, profile = _classifier_with({"a": True, "b": True})
    assert clf.classify(frame=None, profile=profile) == ("equip", None)


def test_window_rejected_when_one_detector_false():
    clf, profile = _classifier_with({"a": True, "b": False})
    assert clf.classify(frame=None, profile=profile) is None


def test_window_with_no_detectors_never_matches():
    win = WindowDef(id="x")  # no detectors
    profile = GameProfile(name="g", windows=[win])
    clf = DetectClassifier.__new__(DetectClassifier)
    clf._matcher = SimpleNamespace(matches=lambda a, f: True)
    assert clf.classify(frame=None, profile=profile) is None
