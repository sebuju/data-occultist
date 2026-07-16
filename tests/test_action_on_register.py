"""Action node operating on a REGISTER source — clear / clone / move of a register's held keys,
pure logic, no GPU. Complements test_dataset_ops.py (the dataset side of the same action node).

A register's held map lives only in a running LiveSession, so these exercise the funnel against a
real LiveSession seeded via `_feed_registers`, with clone/move destinations opened through the real
`store_for`. `fire_action` resolves the session for the game itself (via `active_session`).
"""

from types import SimpleNamespace

from oc.collect.live import LiveSession
from oc.collect.register_ops import fire_register_target, run_register_action
from oc.collect.triggers import fire_action
from oc.profile.models import ActionDef, GameProfile, RegisterDef
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


def test_clear_wipes_all_keys_by_default(tmp_path):
    profile, s = _session(tmp_path)
    out = run_register_action(tmp_path, "g", profile, s, action="clear", reg_id="hp")
    assert set(out["keys"]) == {"health", "shield"}
    assert s.register_keys("hp") == []


def test_clear_respects_slot_targeting(tmp_path):
    profile, s = _session(tmp_path)
    out = run_register_action(tmp_path, "g", profile, s, action="clear", reg_id="hp",
                              slots=["health"])
    assert out["keys"] == ["health"]
    assert s.register_keys("hp") == ["shield"]     # only the targeted key wiped


def test_clone_writes_latest_per_key_to_dest(tmp_path):
    profile, s = _session(tmp_path)
    out = run_register_action(tmp_path, "g", profile, s, action="clone_resolved", reg_id="hp",
                              dest="dst")
    assert set(out["keys"]) == {"health", "shield"}
    assert _dst_present(tmp_path, profile) == {"health": 100, "shield": 50}
    assert s.register_keys("hp") == ["health", "shield"]   # clone leaves the source intact


def test_move_clones_then_clears_targeted(tmp_path):
    profile, s = _session(tmp_path)
    run_register_action(tmp_path, "g", profile, s, action="move_batches", reg_id="hp",
                        slots=["shield"], dest="dst")
    assert _dst_present(tmp_path, profile) == {"shield": 50}
    assert s.register_keys("hp") == ["health"]      # only the moved key cleared


def test_clone_without_dest_is_a_noop(tmp_path):
    profile, s = _session(tmp_path)
    assert run_register_action(tmp_path, "g", profile, s, action="clone_resolved", reg_id="hp") == {}


def test_vanished_slot_key_skipped(tmp_path):
    profile, s = _session(tmp_path)
    out = run_register_action(tmp_path, "g", profile, s, action="clear", reg_id="hp",
                              slots=["health", "gone"])
    assert out["keys"] == ["health"]                # "gone" filtered out (not held)


def test_no_session_is_a_noop(tmp_path):
    profile, _ = _session(tmp_path)
    assert run_register_action(tmp_path, "g", profile, None, action="clear", reg_id="hp") == {}


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
