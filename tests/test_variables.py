"""Live, ephemeral readouts: reading them (RegionReader.read_readouts), firing threshold
triggers on them (TriggerRunner.on_readout), and their profile model round-trip + merge."""

import tempfile

import numpy as np

from oc.collect.reader import RegionReader
from oc.collect.triggers import TriggerRunner
from oc.interfaces import OcrEngine
from oc.profile.merge import merge_profiles
from oc.profile.models import (
    Box, FieldDef, FieldRule, FieldType, GameProfile, GateCond, GateDef, ReadoutDef, RuleThen,
    RuleWhen, TriggerDef, WindowDef,
)
from oc.types import Frame, OcrLine, PixelBox


class StubOcr(OcrEngine):
    def __init__(self, text, conf=0.95):
        self._text, self._conf = text, conf

    def read_image(self, image, **_kw) -> list[OcrLine]:
        h, w = image.shape[:2]
        return [OcrLine(self._text, PixelBox(0, 0, w, h), self._conf)]


def _frame(h=100, w=200):
    return Frame(image=np.zeros((h, w, 3), np.uint8), client=PixelBox(0, 0, w, h))


# ---- read_readouts --------------------------------------------------------------

def test_read_ocr_readout():
    # A readout is a RAW OCR TAP: it emits the read text as-is, no rules/typing. Value-filtering
    # (and any number coercion) is the downstream process node's job, not the readout's.
    win = WindowDef(
        id="hud",
        fields=[FieldDef(id="hpf", type=FieldType.number)],
        readouts=[ReadoutDef(id="hp", box=Box(x=0, y=0, w=0.5, h=0.5), field="hpf")],
    )
    fields = {f.id: f for f in win.fields}
    out = RegionReader(StubOcr("450")).read_readouts(_frame(), win, fields)
    assert out == {"hp": "450"}


def test_readout_ignores_field_rules():
    # Readouts DO NOT run the field's rules pipeline (that surface moved to process nodes). A
    # drop rule that would have omitted this read is inert -- the raw text is still emitted.
    win = WindowDef(
        id="hud",
        fields=[FieldDef(id="hpf", type=FieldType.number,
                         rules=[FieldRule(when=RuleWhen.above, arg="1000", then=RuleThen.drop)])],
        readouts=[ReadoutDef(id="hp", box=Box(x=0, y=0, w=0.5, h=0.5), field="hpf")],
    )
    fields = {f.id: f for f in win.fields}
    out = RegionReader(StubOcr("999999")).read_readouts(_frame(), win, fields)
    assert out == {"hp": "999999"}


def test_ocr_readout_below_confidence_omitted():
    # The readout's surviving plausibility gate is min_confidence: a low-confidence read is
    # OMITTED (a trigger/process must never fire on a garbage/occluded reading).
    win = WindowDef(
        id="hud",
        fields=[FieldDef(id="hpf", type=FieldType.number, min_confidence=0.8)],
        readouts=[ReadoutDef(id="hp", box=Box(x=0, y=0, w=0.5, h=0.5), field="hpf")],
    )
    fields = {f.id: f for f in win.fields}
    out = RegionReader(StubOcr("450", conf=0.3)).read_readouts(_frame(), win, fields)
    assert "hp" not in out


def test_disabled_readout_skipped():
    win = WindowDef(
        id="hud",
        fields=[FieldDef(id="hpf", type=FieldType.number)],
        readouts=[ReadoutDef(id="hp", box=Box(x=0, y=0, w=0.5, h=0.5), field="hpf", enabled=False)],
    )
    fields = {f.id: f for f in win.fields}
    assert RegionReader(StubOcr("450")).read_readouts(_frame(), win, fields) == {}


# ---- on_readout trigger firing --------------------------------
# The trigger's kind supplies the PULSE (a watched readout moved this tick); the VALUE condition is
# a gate over that readout (see GateDef). Fire = moved AND the gate holds — the edge behaviour the
# old inline readout_op/readout_value carried, now expressed as a reusable gate node.

def _runner(readout, when, arg, tid="low"):
    gid = f"{tid}_g"
    trig = TriggerDef(id=tid, kind="on_readout", readout_watch=[readout], gates=[gid])
    gate = GateDef(id=gid, source=f"readout:{readout}", conds=[GateCond(when=when, arg=str(arg))])
    p = GameProfile(name="g", windows=[WindowDef(id="w")], triggers=[trig], gates=[gate])
    return TriggerRunner(p, tempfile.gettempdir())


def test_on_readout_comparison_fires_on_every_move_while_held():
    # a comparison gate (at-or-below) fires on ENTERING the condition and on every further move while
    # it still holds; a static reading between ticks does NOT re-fire (no move = no pulse).
    r = _runner("hp", "lte", 3)
    assert r.on_readout({"hp": 5}) == []        # above threshold -> no
    assert r.on_readout({"hp": 3}) == ["low"]    # enters at-or-below -> fire
    assert r.on_readout({"hp": 3}) == []        # same value, no move -> no re-fire
    assert r.on_readout({"hp": 2}) == ["low"]    # moved while still <=3 -> re-fire
    assert r.on_readout({"hp": 1}) == ["low"]    # moved again -> re-fire
    assert r.on_readout({"hp": 6}) == []        # recovers -> no


def test_on_readout_crosses_down_is_edge_once():
    # edge-once ("fire only on entering the band") is the crosses_down gate op: it fires only on the
    # tick the value crosses down through the threshold, not on further moves while below.
    r = _runner("hp", "crosses_down", 3)
    assert r.on_readout({"hp": 5}) == []        # above, no prev crossing
    assert r.on_readout({"hp": 2}) == ["low"]    # 5 -> 2 crosses down through 3 -> fire once
    assert r.on_readout({"hp": 1}) == []        # still below, no crossing -> no re-fire
    assert r.on_readout({"hp": 6}) == []        # recovers
    assert r.on_readout({"hp": 2}) == ["low"]    # crosses down again -> fire


def test_on_readout_crosses_up_uses_prev():
    r = _runner("x", "crosses_up", 5, tid="cu")
    assert r.on_readout({"x": 3}) == []        # no prev yet
    assert r.on_readout({"x": 8}) == ["cu"]     # 3 -> 8 crosses up through 5
    assert r.on_readout({"x": 9}) == []        # already above, no transition


def test_on_readout_ignores_non_numeric_and_absent():
    r = _runner("hp", "lte", 30)
    assert r.on_readout({"hp": "??"}) == []    # non-numeric -> no move pulse -> never fires
    assert r.on_readout({"other": 5}) == []    # watched readout absent -> never fires


# ---- model round-trip + merge ---------------------------------------------------

def test_readout_survives_merge_and_roundtrip():
    win = WindowDef(
        id="hud",
        fields=[FieldDef(id="hpf", type=FieldType.number), FieldDef(id="shf", type=FieldType.number)],
        readouts=[
            ReadoutDef(id="health", box=Box(x=.1, y=.1, w=.2, h=.05), field="hpf"),
            ReadoutDef(id="shield", box=Box(x=.1, y=.2, w=.2, h=.05), field="shf"),
        ],
    )
    merged = merge_profiles(GameProfile(name="g", windows=[WindowDef(id="other")]),
                            GameProfile(name="g", windows=[win]))
    re = GameProfile.model_validate(merged.model_dump())
    hud = next(w for w in re.windows if w.id == "hud")
    assert [(v.id, v.field) for v in hud.readouts] == [
        ("health", "hpf"), ("shield", "shf")]
    assert {w.id for w in re.windows} == {"other", "hud"}


def test_migrate_readout_ids_adopts_name_and_repoints():
    from oc.profile.loader import _migrate_readout_ids
    raw = {
        "windows": [{"id": "hud", "readouts": [
            {"id": "ro_2", "name": "ability_1_cd", "field": "rof_3"},
            {"id": "ro_4", "name": "", "field": "rof_5"},   # blank name -> keeps its id
        ]}],
        "toasts": [{"id": "t", "title": "CD", "message": "ready {{ ro_2 }} / {{ro_4}}"}],
        "triggers": [{"id": "g", "readout_watch": ["ro_2", "ro_4"]}],
    }
    out = _migrate_readout_ids(raw)
    ros = out["windows"][0]["readouts"]
    assert ros[0]["id"] == "ability_1_cd" and "name" not in ros[0]
    assert ros[1]["id"] == "ro_4" and "name" not in ros[1]
    # {{ro_2}} (even spaced) repointed; ro_4 untouched
    assert out["toasts"][0]["message"] == "ready {{ability_1_cd}} / {{ro_4}}"
    assert out["triggers"][0]["readout_watch"] == ["ability_1_cd", "ro_4"]
    # idempotent: a second pass (no names left) is a no-op
    assert _migrate_readout_ids(out) == out


def test_migrate_readout_ids_skips_name_collision():
    from oc.profile.loader import _migrate_readout_ids
    raw = {"windows": [{"id": "hud", "readouts": [
        {"id": "ro_1", "name": "hp"},
        {"id": "hp", "name": ""},   # a readout already owns id "hp" -> ro_1 can't take it
    ]}]}
    out = _migrate_readout_ids(raw)
    assert [v["id"] for v in out["windows"][0]["readouts"]] == ["ro_1", "hp"]


def test_migrate_dictionary_ids_adopts_name_and_repoints_pins():
    from oc.profile.loader import _migrate_dictionary_ids
    raw = {
        "dictionaries": [
            {"id": "wiki", "name": "wiki", "source": "wiki.txt"},       # name==id -> just drop name
            {"id": "dict_1", "name": "relics", "source": "dict_1.txt"},  # adopt "relics", keep source
        ],
        "windows": [{"id": "eq", "fields": [
            {"id": "f1", "dictionary": "dict_1"}, {"id": "f2", "dictionary": "wiki"},
        ]}],
    }
    out = _migrate_dictionary_ids(raw)
    dicts = out["dictionaries"]
    assert dicts[0]["id"] == "wiki" and "name" not in dicts[0]
    assert dicts[1]["id"] == "relics" and dicts[1]["source"] == "dict_1.txt" and "name" not in dicts[1]
    flds = out["windows"][0]["fields"]
    assert flds[0]["dictionary"] == "relics" and flds[1]["dictionary"] == "wiki"
    assert _migrate_dictionary_ids(out) == out   # idempotent
