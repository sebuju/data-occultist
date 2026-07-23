"""Accumulating / replace-by-tag toast: the sidecar tally + toast_spec's tag+accumulate wiring."""

from __future__ import annotations

from oc.collect.triggers import toast_spec
from oc.notify import toast_accum
from oc.profile.models import ToastDef, ToastTextDef


def _blocks(*contents):
    return [{"content": c, "style": "", "align": ""} for c in contents]


# ---- the sidecar tally ---------------------------------------------------------------

def test_accum_appends_and_keeps_prior_entries(tmp_path):
    b, _ = toast_accum.append(tmp_path, "g", "relic", _blocks("A"), [], cap=10)
    assert [x["content"] for x in b] == ["A"]
    # a DIFFERENT fire adds to the tally (prior data stays) — "updates only add"
    b, _ = toast_accum.append(tmp_path, "g", "relic", _blocks("B"), [], cap=10)
    assert [x["content"] for x in b] == ["A", "B"]


def test_accum_dedups_identical_entry(tmp_path):
    toast_accum.append(tmp_path, "g", "relic", _blocks("A"), [], cap=10)
    b, _ = toast_accum.append(tmp_path, "g", "relic", _blocks("A"), [], cap=10)
    assert [x["content"] for x in b] == ["A"]   # re-seeing the same screen doesn't double it


def test_accum_caps_newest_wins(tmp_path):
    for c in ("A", "B", "C"):
        b, _ = toast_accum.append(tmp_path, "g", "relic", _blocks(c), [], cap=2)
    assert [x["content"] for x in b] == ["B", "C"]   # oldest dropped past the cap


def test_accum_clear_all_for_game(tmp_path):
    toast_accum.append(tmp_path, "g", "relic", _blocks("A"), [], cap=10)
    toast_accum.clear(tmp_path, "g")                 # live-session start wipes every tally
    assert toast_accum.load(tmp_path, "g", "relic") == []


def test_accum_snapshots_inline_images_and_dedups(tmp_path):
    img = tmp_path / "card.png"
    img.write_bytes(b"PNG-A")
    _, imgs1 = toast_accum.append(tmp_path, "g", "relic", [], [str(img)], cap=10)
    assert len(imgs1) == 1 and imgs1[0].endswith(".png")
    # same bytes re-fired -> same content-hash snapshot, deduped to one entry
    _, imgs2 = toast_accum.append(tmp_path, "g", "relic", [], [str(img)], cap=10)
    assert imgs2 == imgs1


# ---- toast_spec: replace-by-tag identity + accumulation ------------------------------

def test_toast_spec_sets_tag_and_group_when_replace_key(tmp_path):
    toast = ToastDef(id="t", texts=[ToastTextDef(content="hi")], replace_key="relic")
    spec = toast_spec(toast, {}, data_dir=tmp_path, game="warframe")
    assert spec.tag and spec.group == "warframe"


def test_toast_spec_blank_replace_key_leaves_tag_empty(tmp_path):
    toast = ToastDef(id="t", texts=[ToastTextDef(content="hi")])
    spec = toast_spec(toast, {}, data_dir=tmp_path, game="warframe")
    assert spec.tag == "" and spec.group == ""


def test_toast_spec_accumulate_grows_body_across_fires(tmp_path):
    t1 = ToastDef(id="t", texts=[ToastTextDef(content="A")], replace_key="relic", accumulate=True)
    spec1 = toast_spec(t1, {}, data_dir=tmp_path, game="g")
    assert [x.content for x in spec1.texts] == ["A"]
    t2 = ToastDef(id="t", texts=[ToastTextDef(content="B")], replace_key="relic", accumulate=True)
    spec2 = toast_spec(t2, {}, data_dir=tmp_path, game="g")
    assert [x.content for x in spec2.texts] == ["A", "B"]   # shows previous data too
    # a live-session start clears the tally -> next fire starts fresh
    toast_accum.clear(tmp_path, "g")
    spec3 = toast_spec(t2, {}, data_dir=tmp_path, game="g")
    assert [x.content for x in spec3.texts] == ["B"]
