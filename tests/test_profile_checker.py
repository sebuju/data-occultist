"""Boot-time profile checker: cross-referenced ids/fields report as issues, a clean
profile reports none. Pure-logic — no game, GPU, or Windows needed."""

from __future__ import annotations

from oc.profile.checker import check_profile
from oc.profile.models import (
    Box,
    DatasetDef,
    FieldDef,
    FieldRule,
    GameProfile,
    GateDef,
    ItemDef,
    ProcessDef,
    ProcessInput,
    RegionDef,
    RegisterDef,
    RuleThen,
    RuleWhen,
    ScrollDef,
    TriggerDef,
    WindowDef,
)


def _prof(**kw):
    return GameProfile(name="g", **kw)


def test_clean_profile_has_no_issues():
    p = _prof(
        datasets=[DatasetDef(id="items")],
        windows=[WindowDef(
            id="equip", dataset="items",
            fields=[FieldDef(id="name")],
            regions=[RegionDef(id="r1", box={"x": 0, "y": 0, "w": 1, "h": 1}, field="name")],
        )],
    )
    assert check_profile(p) == []


def test_window_dataset_dangling():
    p = _prof(windows=[WindowDef(id="equip", dataset="missing_ds")])
    issues = check_profile(p)
    assert any(i.severity == "error" and "missing_ds" in i.msg for i in issues)


def test_region_field_dangling():
    p = _prof(windows=[WindowDef(
        id="equip",
        fields=[FieldDef(id="name")],
        regions=[RegionDef(id="r1", box={"x": 0, "y": 0, "w": 1, "h": 1}, field="typo"),
                 RegionDef(id="r2", box={"x": 0, "y": 0, "w": 1, "h": 1}, field="name")],
    )])
    issues = check_profile(p)
    assert len(issues) == 1
    assert "typo" in issues[0].msg


def test_trigger_targets_and_watch_dangling():
    p = _prof(triggers=[TriggerDef(id="t1", kind="on_change", watch=["ghost_ds"],
                                   targets=["ghost_target"])])
    issues = check_profile(p)
    msgs = {i.msg for i in issues}
    assert any("ghost_ds" in m for m in msgs)
    assert any("ghost_target" in m for m in msgs)


def test_on_ready_watches_producer_not_dataset():
    from oc.profile.models import ProducerDef
    # on_ready watches PRODUCER ids, not dataset/subset ids — a dataset named the same
    # as a producer must not be accepted, and the real producer id must not be flagged.
    p = _prof(
        datasets=[DatasetDef(id="prices")],
        producers=[ProducerDef(id="prod_a", dataset="prices")],
        triggers=[TriggerDef(id="t1", kind="on_ready", watch=["prod_a"])],
    )
    assert check_profile(p) == []

    p2 = _prof(triggers=[TriggerDef(id="t1", kind="on_ready", watch=["no_such_producer"])])
    issues = check_profile(p2)
    assert any("no_such_producer" in i.msg and "producer" in i.msg for i in issues)


def test_dictionary_rule_dangling():
    rule = FieldRule(when=RuleWhen.always, then=RuleThen.dictionary, dict_id="ghost_dict")
    p = _prof(windows=[WindowDef(id="w1", fields=[FieldDef(id="f1", rules=[rule])])])
    issues = check_profile(p)
    assert any("ghost_dict" in i.msg for i in issues)


def test_register_slot_key_dangling_through_process_chain():
    # register <- process <- readout, mirroring value_ab_register/process_value_ab/value_ab_1
    # in the real profile. A gate naming a key the process never emits (typo'd, or the
    # readout input got removed) must be caught — the register id alone existing is not
    # enough; the KEY must actually be exposed by the chain feeding it.
    p = _prof(
        registers=[RegisterDef(id="reg1", sources=["process:proc1"])],
        gates=[
            GateDef(id="g_ok", source="register:reg1#slot_a@nonblank"),
            GateDef(id="g_bad", source="register:reg1#slot_typo@nonblank"),
        ],
        processes=[ProcessDef(id="proc1", sources=[ProcessInput(ref="readout:slot_a")])],
    )
    issues = check_profile(p)
    assert not any(i.node == "gate:g_ok" for i in issues)
    bad = [i for i in issues if i.node == "gate:g_bad"]
    assert len(bad) == 1
    assert "slot_typo" in bad[0].msg
    assert "reg1" in bad[0].msg


def test_register_source_kind_dangling():
    p = _prof(registers=[RegisterDef(id="reg1", sources=["process:no_such_process",
                                                          "readout:no_such_readout"])])
    issues = check_profile(p)
    msgs = {i.msg for i in issues}
    assert any("no_such_process" in m for m in msgs)
    assert any("no_such_readout" in m for m in msgs)


def test_duplicate_ids_warn():
    p = _prof(datasets=[DatasetDef(id="a"), DatasetDef(id="a")])
    issues = check_profile(p)
    assert any(i.severity == "warn" and "duplicate id 'a'" in i.msg for i in issues)


# ---- window-scoped kinds: window_watch / item_watch ----------------------------------------

def test_window_watch_dangling():
    p = _prof(triggers=[TriggerDef(id="t1", kind="on_window_detected", window_watch=["ghost_win"])])
    issues = check_profile(p)
    assert any("ghost_win" in i.msg for i in issues)


def test_window_watch_real_window_is_clean():
    p = _prof(
        windows=[WindowDef(id="equip")],
        triggers=[TriggerDef(id="t1", kind="on_window_detected", window_watch=["equip"])],
    )
    assert check_profile(p) == []


def test_on_item_watch_dangling_item():
    p = _prof(
        windows=[WindowDef(id="equip", items=[ItemDef(id="weapon", box=Box(x=0, y=0, w=0.1, h=0.1))])],
        triggers=[TriggerDef(id="t1", kind="on_item", window_watch=["equip"], item_watch="ghost_item")],
    )
    issues = check_profile(p)
    assert any("ghost_item" in i.msg for i in issues)


def test_on_item_watch_real_item_is_clean():
    p = _prof(
        windows=[WindowDef(id="equip", items=[ItemDef(id="weapon", box=Box(x=0, y=0, w=0.1, h=0.1))])],
        triggers=[TriggerDef(id="t1", kind="on_item", window_watch=["equip"], item_watch="weapon")],
    )
    assert check_profile(p) == []


def test_on_item_watch_with_no_window_flagged():
    p = _prof(triggers=[TriggerDef(id="t1", kind="on_item", item_watch="weapon")])
    issues = check_profile(p)
    assert any("no window is set" in i.msg for i in issues)


def test_on_item_watch_any_item_wildcard_is_clean():
    # "*" is the "any item" wildcard, not a real item id -- must not be flagged as missing.
    p = _prof(
        windows=[WindowDef(id="equip", items=[ItemDef(id="weapon", box=Box(x=0, y=0, w=0.1, h=0.1))])],
        triggers=[TriggerDef(id="t1", kind="on_item", window_watch=["equip"], item_watch="*")],
    )
    assert check_profile(p) == []


# ---- on_scroll_top/on_scroll_bottom: watched window must have a scrollbar configured --------

def test_on_scroll_top_watching_a_scrollbarless_window_is_flagged():
    p = _prof(
        windows=[WindowDef(id="equip")],
        triggers=[TriggerDef(id="t1", kind="on_scroll_top", window_watch=["equip"])],
    )
    issues = check_profile(p)
    assert any("no scrollbar configured" in i.msg for i in issues)


def test_on_scroll_bottom_watching_a_scrollbar_window_is_clean():
    p = _prof(
        windows=[WindowDef(
            id="equip", scroll=ScrollDef(scrollbar=Box(x=0.95, y=0.1, w=0.02, h=0.8)))],
        triggers=[TriggerDef(id="t1", kind="on_scroll_bottom", window_watch=["equip"])],
    )
    assert check_profile(p) == []


def test_on_scroll_top_dangling_window_reports_missing_window_not_scrollbar():
    # a nonexistent window is caught by the generic window_watch check (checker.py:270), not the
    # scrollbar-specific one -- don't double-report or crash on a window that isn't in window_ids.
    p = _prof(triggers=[TriggerDef(id="t1", kind="on_scroll_top", window_watch=["ghost_win"])])
    issues = check_profile(p)
    assert any("ghost_win" in i.msg for i in issues)
    assert not any("no scrollbar configured" in i.msg for i in issues)
