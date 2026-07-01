"""Detect text matching: partial is pure substring fit (no hidden length guards); a window
needs ALL its detectors, and the BEST-fitting passing window wins classify."""

from types import SimpleNamespace

from oc.detect.matcher import text_match_score
from oc.detect.classifier import DetectClassifier
from oc.profile.models import Box, DetectDef, GameProfile, WindowDef


def test_clean_match_scores_high():
    assert text_match_score("INVENTORY / SELL", "INVTNTORYSELL") >= 0.8


def test_long_read_still_matches_partial():
    # no hidden length guard: a read that CONTAINS the target scores high. Whether this is
    # "the landmark" or a coincidental substring is decided by best-fit classify, not here.
    blob = "search" + "x" * 80
    assert text_match_score("search", blob) >= 0.8


def test_short_fragment_still_matches():
    # a slightly-longer-than-target read is fine (some slack)
    assert text_match_score("NAME", "NAME:") >= 0.8
    assert text_match_score("search", "searchbar") >= 0.8


def test_tiny_substring_matches_partial_only_min_chars_floors():
    # partial_ratio aligns a tiny blob inside the target -> high score (no too-short guard);
    # the ONLY explicit floor is min_chars, which deterministically kills the blob.
    assert text_match_score("reward", "war") >= 0.8
    assert text_match_score("reward", "war", min_chars=4) == 0.0
    assert text_match_score("inventory", "in", min_chars=4) == 0.0


def test_empty_read_is_zero():
    assert text_match_score("x", "") == 0.0


def test_empty_target_matches_any_text():
    # empty detector text = "any text present": any non-empty read scores 1.0...
    assert text_match_score("", "y") == 1.0
    assert text_match_score("", "anything here") == 1.0
    # ...but an empty read still fails, and min_chars still gates
    assert text_match_score("", "") == 0.0
    assert text_match_score("", "ab", min_chars=4) == 0.0
    assert text_match_score("", "abcd", min_chars=4) == 1.0


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
    # the detect text begins the read (read may have trailing junk)
    assert text_match_score("equipment", "EQUIPMENT UPGRADE", mode="prefix") == 1.0
    assert text_match_score("equipment", "loadout", mode="prefix") < 0.8


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


def _stub_matcher(matched: dict, scores: dict | None = None):
    """A matcher whose verdict/score are looked up per detector id. ``matches`` drives
    candidacy; ``score`` (defaults to 1.0 matched / 0.0 not) drives the best-fit tie-break."""
    scores = scores or {}
    return SimpleNamespace(
        matches=lambda det, frame: matched.get(det.id, False),
        score=lambda det, frame: scores.get(det.id, 1.0 if matched.get(det.id) else 0.0),
    )


def _classifier_with(matched: dict, scores: dict | None = None):
    win = WindowDef(id="equip", detect=[
        DetectDef(id="a", search=Box(x=0, y=0, w=0.1, h=0.1), text="inventory", threshold=0.8),
        DetectDef(id="b", search=Box(x=0.2, y=0, w=0.1, h=0.1), text="name", threshold=0.8),
    ])
    profile = GameProfile(name="g", windows=[win])
    clf = DetectClassifier.__new__(DetectClassifier)
    clf._matcher = _stub_matcher(matched, scores)
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
    clf._matcher = _stub_matcher({}, {})
    clf._matcher.matches = lambda a, f: True
    assert clf.classify(frame=None, profile=profile) is None


def test_best_fit_window_wins_over_more_detectors_and_file_order():
    # both windows PASS, but the second one (fewer detectors, later in file) fits BETTER.
    # The old tie-break (most detectors, then file order) would pick `loose`; best-fit picks
    # `tight` because its detector scores higher.
    loose = WindowDef(id="loose", detect=[
        DetectDef(id="la", search=Box(x=0, y=0, w=0.1, h=0.1), text="refine", threshold=0.8),
        DetectDef(id="lb", search=Box(x=0.2, y=0, w=0.1, h=0.1), text="void", threshold=0.8),
    ])
    tight = WindowDef(id="tight", detect=[
        DetectDef(id="ta", search=Box(x=0, y=0, w=0.1, h=0.1), text="refinement", threshold=0.8),
    ])
    profile = GameProfile(name="g", windows=[loose, tight])
    clf = DetectClassifier.__new__(DetectClassifier)
    # both pass their thresholds, but `tight` matches its landmark exactly (1.0) while `loose`
    # only caught coincidental substrings (0.85 worst detector).
    clf._matcher = _stub_matcher(
        {"la": True, "lb": True, "ta": True},
        {"la": 0.85, "lb": 0.9, "ta": 1.0},
    )
    assert clf.classify(frame=None, profile=profile) == ("tight", None)
