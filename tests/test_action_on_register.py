"""Action node operating on a REGISTER source — set / remove_all / clone / move of a register's
held keys, pure logic, no GPU. Complements test_dataset_ops.py (the dataset side of the same
action node).

A register's held map lives only in a running LiveSession, so these exercise the funnel against a
real LiveSession seeded via `_feed_registers`, with a "dataset:<id>" dest opened through the real
`store_for`. `fire_action` resolves the session for the game itself (via `active_session`). `dest`
is a PREFIXED ref -- "dataset:<id>" or "register:<id>" -- so a clone/move can target ANOTHER
register instead of a dataset; see the "clone/move into ANOTHER REGISTER" section below.
"""

from types import SimpleNamespace

from oc.collect.live import LiveSession
from oc.collect.register_ops import fire_register_target, run_register_action
from oc.collect.triggers import fire_action
from oc.profile.models import (
    ActionDef,
    GameProfile,
    GateCond,
    GateDef,
    RegisterDef,
    RegisterWrite,
    TriggerDef,
)
from oc.store import store_for


def _session(tmp_path, keys=("health", "shield")):
    profile = GameProfile(
        name="g",
        registers=[RegisterDef(id="hp", sources=[f"readout:{k}" for k in keys])],
        actions=[],
    )
    engine = SimpleNamespace(settings=SimpleNamespace(data_dir=tmp_path))
    s = LiveSession(engine, profile)
    s._feed_registers({"health": 100, "shield": 50}, {"health": 0.9, "shield": 0.9})
    return profile, s


def _dst_present(tmp_path, profile):
    st = store_for(tmp_path, "g", "dst", profile=profile)
    return {r["name"]: r["value"] for r in st.records() if r.get("present")}


def test_remove_all_wipes_every_key(tmp_path):
    profile, s = _session(tmp_path)
    out = run_register_action(tmp_path, "g", profile, s, action="remove_all", reg_id="hp")
    assert set(out["keys"]) == {"health", "shield"}
    assert s.register_keys("hp") == []


def test_set_remove_row_targets_one_key(tmp_path):
    profile, s = _session(tmp_path)
    out = run_register_action(tmp_path, "g", profile, s, action="set", reg_id="hp",
                              writes=[RegisterWrite(key="health", remove=True)])
    assert out["keys"] == ["health"]
    assert s.register_keys("hp") == ["shield"]     # only the targeted key wiped


def test_clone_writes_latest_per_key_to_dest(tmp_path):
    profile, s = _session(tmp_path)
    out = run_register_action(tmp_path, "g", profile, s, action="clone", reg_id="hp",
                              dest="dataset:dst")
    assert set(out["keys"]) == {"health", "shield"}
    assert _dst_present(tmp_path, profile) == {"health": 100, "shield": 50}
    assert s.register_keys("hp") == ["health", "shield"]   # clone leaves the source intact


def test_move_clones_then_clears_targeted(tmp_path):
    profile, s = _session(tmp_path)
    run_register_action(tmp_path, "g", profile, s, action="move", reg_id="hp",
                        slots=["shield"], dest="dataset:dst")
    assert _dst_present(tmp_path, profile) == {"shield": 50}
    assert s.register_keys("hp") == ["health"]      # only the moved key cleared


def test_clone_without_dest_is_a_noop(tmp_path):
    profile, s = _session(tmp_path)
    assert run_register_action(tmp_path, "g", profile, s, action="clone", reg_id="hp") == {}


def test_vanished_remove_row_key_skipped(tmp_path):
    profile, s = _session(tmp_path)
    out = run_register_action(tmp_path, "g", profile, s, action="set", reg_id="hp",
                              writes=[RegisterWrite(key="health", remove=True),
                                      RegisterWrite(key="gone", remove=True)])
    assert out["keys"] == ["health"]                # "gone" filtered out (not held)


def test_no_session_is_a_noop(tmp_path):
    profile, _ = _session(tmp_path)
    assert run_register_action(tmp_path, "g", profile, None, action="remove_all", reg_id="hp") == {}


def test_fire_register_target_reads_action_slots(tmp_path):
    profile, s = _session(tmp_path)
    action = ActionDef(id="act", action="clear", sources=["register:hp"], slots={"hp": ["shield"]})
    assert fire_register_target("g", tmp_path, profile, s, action, "hp") is True
    assert s.register_keys("hp") == ["health"]

    # actionless node fires nothing
    noop = ActionDef(id="a2", action="", sources=["register:hp"])
    assert fire_register_target("g", tmp_path, profile, s, noop, "hp") is False


def test_fire_action_dispatches_registers_and_datasets(tmp_path):
    # end-to-end: fire_action splits sources by kind and resolves the live session for the game
    # itself (active_session). A LiveSession self-registers on construction, so this fire finds it.
    profile, s = _session(tmp_path)
    # seed a dataset source too, so the mixed-source dispatch is exercised
    ds = store_for(tmp_path, "g", "src", profile=profile)
    ds.begin_batch()
    ds.record_seen({"name": "A", "v": 1})

    action = ActionDef(id="act", action="clear", sources=["dataset:src", "register:hp"])
    ran = fire_action("g", action, tmp_path, profile=profile, trigger_id=None)
    assert ran is True
    assert s.register_keys("hp") == []                          # register cleared
    assert [r for r in ds.records() if r.get("present")] == []  # dataset cleared


# ---- set: append one sample to the ring (not a whole-ring replace) -------------------------

def _capped_session(tmp_path, cap=3):
    profile = GameProfile(name="g", registers=[RegisterDef(id="hp", sources=["readout:health"],
                                                           capacity=cap)])
    engine = SimpleNamespace(settings=SimpleNamespace(data_dir=tmp_path), notifier=None)
    s = LiveSession(engine, profile)
    return profile, s


def test_set_appends_to_ring_respecting_capacity(tmp_path):
    profile, s = _capped_session(tmp_path, cap=3)
    s._feed_registers({"health": 1}, {"health": 0.9})
    s._feed_registers({"health": 2}, {"health": 0.9})
    out = run_register_action(tmp_path, "g", profile, s, action="set", reg_id="hp",
                              writes=[RegisterWrite(key="health", value="3")])
    assert out["keys"] == ["health"]
    rec = next(r for r in s.register_records("hp") if r["key"] == "health")
    assert rec["values"] == [1, 2, "3"]     # appended, oldest NOT evicted until a 4th write
    # a moving aggregate over the ring sees every sample, including the manually set one
    s.set_register_value("hp", "health", "4")   # 4th write evicts the oldest (1)
    rec = next(r for r in s.register_records("hp") if r["key"] == "health")
    assert rec["values"] == [2, "3", "4"]


def test_set_empty_value_clears_value_but_keeps_key(tmp_path):
    profile, s = _session(tmp_path)
    out = run_register_action(tmp_path, "g", profile, s, action="set", reg_id="hp",
                              writes=[RegisterWrite(key="health", value="")])
    assert out["keys"] == ["health"]
    assert "health" in s.register_keys("hp")        # key still held...
    assert s.register_latest("hp", "health") is None   # ...but its value is cleared, not the key


def test_set_creates_a_key_never_previously_held(tmp_path):
    profile, s = _session(tmp_path)
    out = run_register_action(tmp_path, "g", profile, s, action="set", reg_id="hp",
                              writes=[RegisterWrite(key="combo", value="7")])
    assert out["keys"] == ["combo"]
    assert "combo" in s.register_keys("hp")
    # RegisterWrite.value is free text -- stored/exposed verbatim (mode="" -> raw ring tail,
    # no numeric coercion), same as any other register value that was never fed as a number.
    assert s.register_latest("hp", "combo") == "7"


def test_set_mixes_write_and_remove_rows_in_one_op(tmp_path):
    profile, s = _session(tmp_path)
    out = run_register_action(tmp_path, "g", profile, s, action="set", reg_id="hp",
                              writes=[RegisterWrite(key="health", value="70"),
                                      RegisterWrite(key="shield", remove=True)])
    assert set(out["keys"]) == {"health", "shield"}
    assert s.register_keys("hp") == ["health"]
    assert s.register_latest("hp", "health") == "70"


# ---- clone/move into ANOTHER REGISTER (dest="register:<id>") -------------------------------

def _two_reg_session(tmp_path):
    profile = GameProfile(
        name="g",
        registers=[RegisterDef(id="hp", sources=["readout:health", "readout:shield"]),
                   RegisterDef(id="mp", sources=[])],
        actions=[],
    )
    engine = SimpleNamespace(settings=SimpleNamespace(data_dir=tmp_path))
    s = LiveSession(engine, profile)
    s._feed_registers({"health": 100, "shield": 50}, {"health": 0.9, "shield": 0.9})
    return profile, s


def test_clone_into_another_register(tmp_path):
    profile, s = _two_reg_session(tmp_path)
    out = run_register_action(tmp_path, "g", profile, s, action="clone", reg_id="hp",
                              dest="register:mp")
    assert set(out["keys"]) == {"health", "shield"}
    assert s.register_latest("mp", "health") == "100"
    assert s.register_latest("mp", "shield") == "50"
    assert s.register_keys("hp") == ["health", "shield"]   # clone leaves the source intact


def test_move_into_another_register_clears_source(tmp_path):
    profile, s = _two_reg_session(tmp_path)
    run_register_action(tmp_path, "g", profile, s, action="move", reg_id="hp",
                        dest="register:mp", slots=["shield"])
    assert s.register_latest("mp", "shield") == "50"
    assert s.register_keys("hp") == ["health"]      # only the moved key cleared from the source


def test_clone_into_self_register_is_a_noop(tmp_path):
    profile, s = _two_reg_session(tmp_path)
    assert run_register_action(tmp_path, "g", profile, s, action="clone", reg_id="hp",
                               dest="register:hp") == {}
    assert s.register_keys("hp") == ["health", "shield"]   # untouched


def test_malformed_dest_is_a_noop(tmp_path):
    # neither "dataset:" nor "register:" prefixed -- a bare/unrecognised dest, refused outright
    profile, s = _session(tmp_path)
    assert run_register_action(tmp_path, "g", profile, s, action="clone", reg_id="hp", dest="dst") == {}
    assert run_register_action(tmp_path, "g", profile, s, action="clone", reg_id="hp", dest="bogus:dst") == {}


def test_fire_register_target_reads_a_register_dest_from_the_op(tmp_path):
    profile, s = _two_reg_session(tmp_path)
    action = ActionDef(id="act", sources=["register:hp"],
                       reg_ops={"hp": {"op": "clone", "dest": "register:mp", "keys": []}})
    assert fire_register_target("g", tmp_path, profile, s, action, "hp") is True
    assert s.register_latest("mp", "health") == "100"
    assert s.register_latest("mp", "shield") == "50"


# ---- fully live: a manual set flushes persist + reaches on_register gates immediately -------

def test_set_is_fully_live_persist_and_gates(tmp_path, monkeypatch):
    calls = []

    class _FakeStore:
        def record_many(self, rows):
            calls.append(rows)

    monkeypatch.setattr("oc.collect.live.store_for", lambda *a, **k: _FakeStore())

    gate = GateDef(id="gb", source="register:hp#health", conds=[GateCond(when="lt", arg="60")],
                   targets=["t"])
    profile = GameProfile(
        name="g",
        registers=[RegisterDef(id="hp", sources=["readout:health"], persist="hpds")],
        gates=[gate],
        triggers=[TriggerDef(id="t", kind="on_register", register_watch=["hp"])],
    )
    engine = SimpleNamespace(settings=SimpleNamespace(data_dir=tmp_path), notifier=None)
    s = LiveSession(engine, profile)
    s._feed_registers({"health": 100}, {"health": 0.9})
    calls.clear()   # drop the initial feed's own flush -- only the manual set matters below
    assert s.gate_states() == {"gb": False}   # 100 not < 60 -> blocked

    action = ActionDef(id="act", sources=["register:hp"],
                       reg_ops={"hp": {"op": "set", "writes": [{"key": "health", "value": "50"}]}})
    assert fire_register_target("g", tmp_path, profile, s, action, "hp") is True

    assert calls == [[{"name": "health", "value": "50"}]]   # persist flushed NOW, not next tick
    assert s.gate_states() == {"gb": True}                   # 50 < 60 -> gate re-evaluated NOW
