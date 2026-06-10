"""Anchor text matching dismisses over-long reads; a window needs ALL anchors."""

from types import SimpleNamespace

from oc.detect.anchor import text_match_score
from oc.detect.anchor_classifier import AnchorClassifier
from oc.profile.models import AnchorDef, Box, GameProfile, WindowDef


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


def test_empty_is_zero():
    assert text_match_score("x", "") == 0.0
    assert text_match_score("", "y") == 0.0


def _classifier_with(matched: dict):
    win = WindowDef(id="equip", anchors=[
        AnchorDef(id="a", search=Box(x=0, y=0, w=0.1, h=0.1), text="inventory"),
        AnchorDef(id="b", search=Box(x=0.2, y=0, w=0.1, h=0.1), text="name"),
    ])
    profile = GameProfile(name="g", windows=[win])
    clf = AnchorClassifier.__new__(AnchorClassifier)
    clf._matcher = SimpleNamespace(matches=lambda anchor, frame: matched.get(anchor.id, False))
    return clf, profile


def test_window_matches_only_when_all_anchors_true():
    clf, profile = _classifier_with({"a": True, "b": True})
    assert clf.classify(frame=None, profile=profile) == ("equip", None)


def test_window_rejected_when_one_anchor_false():
    clf, profile = _classifier_with({"a": True, "b": False})
    assert clf.classify(frame=None, profile=profile) is None


def test_window_with_no_anchors_never_matches():
    win = WindowDef(id="x")  # no anchors
    profile = GameProfile(name="g", windows=[win])
    clf = AnchorClassifier.__new__(AnchorClassifier)
    clf._matcher = SimpleNamespace(matches=lambda a, f: True)
    assert clf.classify(frame=None, profile=profile) is None
