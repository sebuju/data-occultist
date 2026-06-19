"""File-source producer: parsers, extraction, finder, coalesced reader, runner, triggers.

All pure-logic / filesystem — no game, GPU, or network. The OCR/capture backends are never
imported on these paths, so this runs anywhere.
"""

from __future__ import annotations

import pytest

from oc.profile.models import (
    DatasetDef,
    FileSourceDef,
    GameProfile,
    KeyDef,
    SourceField,
    SourceMatch,
    TriggerDef,
)
from oc.registry import build_parser, parser_names
from oc.source.extract import dig, extract_line_field, line_matches
from oc.source.locate import find_candidates, resolve_path
from oc.source.reader import SourceReader
from oc.source.runner import read_source
from oc.store import store_for
from oc.store.keys import KeyMap, KeySpec


# ---- parser discovery ------------------------------------------------------

def test_all_formats_registered():
    assert set(parser_names()) == {"log_lines", "ini", "json", "xml", "yaml"}


# ---- line extraction (no regex) --------------------------------------------

def _field(**kw):
    kw.setdefault("id", "v")
    return SourceField(**kw)


def test_extract_after_with_stop():
    line = "12:00 LootEvent item=Forma qty=3"
    assert extract_line_field(line, _field(method="after", anchor="item=", stop=" ")) == "Forma"


def test_extract_after_to_end():
    line = "name=Arcane Energize"
    assert extract_line_field(line, _field(method="after", anchor="name=")) == "Arcane Energize"


def test_extract_between():
    line = "[INFO] (Mission) reward"
    assert extract_line_field(line, _field(method="between", anchor="(", end=")")) == "Mission"


def test_extract_column_and_negative_index():
    line = "a,b,c,d"
    assert extract_line_field(line, _field(method="column", delim=",", index=1)) == "b"
    assert extract_line_field(line, _field(method="column", delim=",", index=-1)) == "d"


def test_extract_column_default_whitespace():
    line = "tok0   tok1\ttok2"
    assert extract_line_field(line, _field(method="column", delim=" ", index=2)) == "tok2"


def test_extract_number_cast():
    line = "qty=42 done"
    assert extract_line_field(line, _field(method="after", anchor="qty=", stop=" ", type="number")) == 42


def test_extract_missing_anchor_is_none():
    assert extract_line_field("no anchor here", _field(method="after", anchor="item=")) is None


def test_line_matches_all_clauses():
    line = "INFO loot dropped"
    assert line_matches(line, [SourceMatch(op="contains", text="loot")])
    assert not line_matches(line, [SourceMatch(op="contains", text="loot"),
                                   SourceMatch(op="starts_with", text="WARN")])
    assert line_matches(line, [])   # no clauses keeps everything


# ---- log_lines parser: auto line-ends + match + fields ---------------------

@pytest.mark.parametrize("nl", ["\n", "\r\n", "\r"])
def test_log_parser_auto_line_endings(nl):
    text = nl.join(["LOOT item=Forma", "noise", "LOOT item=Kuva"])
    parser = build_parser("log_lines")
    rows = parser.parse(
        text,
        [SourceMatch(op="starts_with", text="LOOT")],
        [SourceField(id="name", method="after", anchor="item=")],
    )
    assert rows == [{"name": "Forma"}, {"name": "Kuva"}]


# ---- document parsers: path lookups ----------------------------------------

def test_ini_parser_section_key():
    text = "[Graphics]\nResolution=1920\n[Audio]\nVolume=0.8\n"
    rows = build_parser("ini").parse(text, [], [
        SourceField(id="res", method="path", path="Graphics.Resolution", type="number"),
        SourceField(id="vol", method="path", path="Audio.Volume", type="number"),
    ])
    assert rows == [{"res": 1920, "vol": 0.8}]


def test_json_parser_dotted_path_with_index():
    text = '{"a": {"b": [10, 20, 30]}}'
    rows = build_parser("json").parse(text, [], [SourceField(id="v", method="path", path="a.b.1", type="number")])
    assert rows == [{"v": 20}]


def test_yaml_parser_path():
    text = "outer:\n  inner: hello\n"
    rows = build_parser("yaml").parse(text, [], [SourceField(id="v", method="path", path="outer.inner")])
    assert rows == [{"v": "hello"}]


def test_xml_parser_text_and_attr():
    text = '<root><child id="7">val</child></root>'
    rows = build_parser("xml").parse(text, [], [
        SourceField(id="t", method="path", path="root/child"),
        SourceField(id="a", method="path", path="root/child/@id", type="number"),
    ])
    assert rows == [{"t": "val", "a": 7}]


def test_dig_helper():
    assert dig({"a": {"b": 1}}, "a.b") == 1
    assert dig({"a": [1, 2]}, "a.0") == 1
    assert dig({"a": 1}, "a.b") is None


# ---- coalesced reader ------------------------------------------------------

def test_reader_coalesces_same_file(tmp_path):
    p = tmp_path / "f.log"
    p.write_text("one\n", encoding="utf-8")
    r = SourceReader()
    assert r.read(p) == "one\n"
    assert r.read(p) == "one\n"
    assert r.reads == 1   # two callers, one disk read (same mtime+size)


def test_reader_rereads_on_change(tmp_path):
    p = tmp_path / "f.log"
    p.write_text("one\n", encoding="utf-8")
    r = SourceReader()
    r.read(p)
    p.write_text("one\ntwo\n", encoding="utf-8")   # size changes -> new signature
    assert r.read(p) == "one\ntwo\n"
    assert r.reads == 2


def test_reader_tail_returns_only_appended(tmp_path):
    p = tmp_path / "f.log"
    p.write_text("a\nb\n", encoding="utf-8")
    r = SourceReader()
    assert r.read(p, tail=True, key="s1") == "a\nb\n"   # first read = whole file
    p.write_text("a\nb\nc\n", encoding="utf-8")
    assert r.read(p, tail=True, key="s1") == "c\n"      # only the appended part


# ---- finder ----------------------------------------------------------------

def test_find_candidates_matches_glob(tmp_path, monkeypatch):
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "EE.log").write_text("x", encoding="utf-8")
    (tmp_path / "other.txt").write_text("y", encoding="utf-8")
    monkeypatch.setattr("oc.source.locate.default_roots", lambda: [str(tmp_path)])
    hits = find_candidates("EE.log")
    assert [h["path"] for h in hits] == [str(tmp_path / "sub" / "EE.log")]


def test_resolve_path_prefers_explicit():
    src = FileSourceDef(id="s", path="C:/explicit.log", filename="EE.log")
    assert resolve_path(src) == "C:/explicit.log"


# ---- runner: parse -> write to the dataset ---------------------------------

def _name_key():
    return KeyMap(KeySpec(("name",)))


def test_read_source_writes_rows(tmp_path):
    log = tmp_path / "EE.log"
    log.write_text("LOOT item=Forma\nLOOT item=Kuva\nchatter\n", encoding="utf-8")
    src = FileSourceDef(
        id="s", format="log_lines", path=str(log), dataset="loot",
        key=KeyDef(fields=["name"]), tail=False,
        match=[SourceMatch(op="starts_with", text="LOOT")],
        fields=[SourceField(id="name", method="after", anchor="item=")],
    )
    prof = GameProfile(name="g", datasets=[DatasetDef(id="loot")], file_sources=[src])

    n = read_source("g", src, tmp_path, profile=prof)
    assert n == 2

    store = store_for(tmp_path, "g", "loot", key=_name_key())
    names = {r.get("name") for r in store.records()}
    assert names == {"Forma", "Kuva"}


def test_read_source_skips_when_disabled(tmp_path):
    log = tmp_path / "EE.log"
    log.write_text("LOOT item=Forma\n", encoding="utf-8")
    src = FileSourceDef(id="s", path=str(log), dataset="loot", enabled=False,
                        fields=[SourceField(id="name", method="whole")])
    assert read_source("g", src, tmp_path) == 0


# ---- triggers: dispatch a target to a source read --------------------------

def test_trigger_app_start_reads_source(tmp_path):
    from oc.collect.triggers import TriggerRunner

    log = tmp_path / "EE.log"
    log.write_text("LOOT item=Forma\n", encoding="utf-8")
    src = FileSourceDef(
        id="src1", format="log_lines", path=str(log), dataset="loot",
        key=KeyDef(fields=["name"]), tail=False,
        fields=[SourceField(id="name", method="after", anchor="item=")],
    )
    trig = TriggerDef(id="t", kind="on_app_start", targets=["src1"])
    prof = GameProfile(name="g", datasets=[DatasetDef(id="loot")],
                       file_sources=[src], triggers=[trig])

    fired = TriggerRunner(prof, tmp_path).fire_app_start()
    assert fired == ["t"]

    store = store_for(tmp_path, "g", "loot", key=_name_key())
    assert {r.get("name") for r in store.records()} == {"Forma"}


# ---- watcher gate: one read per signature, re-reads on change ---------------

def test_watch_reads_once_per_signature(tmp_path, monkeypatch):
    from oc.web import source_sched as ss

    log = tmp_path / "EE.log"
    log.write_text("a\n", encoding="utf-8")
    src = FileSourceDef(id="s", format="log_lines", path=str(log), dataset="d",
                        watch="on_change", throttle_s=0.0, tail=False,
                        fields=[SourceField(id="name", method="whole")])
    prof = GameProfile(name="g", file_sources=[src])

    class _Settings:
        profiles_dir = str(tmp_path)
        data_dir = tmp_path

    calls = []
    monkeypatch.setattr(ss, "list_profiles", lambda d: ["g"])
    monkeypatch.setattr(ss, "load_live_profile", lambda d, g: prof)
    monkeypatch.setattr(ss, "read_source", lambda *a, **k: calls.append(1) or 1)
    ss._state.clear()

    ss._watch_tick(_Settings)
    ss._watch_tick(_Settings)
    assert len(calls) == 1   # same signature -> one read

    log.write_text("a\nb\n", encoding="utf-8")   # changed -> new signature
    ss._watch_tick(_Settings)
    assert len(calls) == 2
