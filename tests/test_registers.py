"""Register node — model round-trip + LiveSession in-memory keyed map (pure logic, no GPU).

A register holds the latest live value of the readouts wired into it, keyed by readout id,
in the running session's memory only (never persisted). The feed overwrites on each read,
keeps first_seen, and the map is wiped only by clear_register.
"""

from oc.collect.live import LiveSession
from oc.profile.models import GameProfile, RegisterDef


def _profile():
    return GameProfile(
        name="g",
        registers=[
            RegisterDef(id="hp", sources=["readout:health", "readout:shield"]),
            RegisterDef(id="off", sources=["readout:health"], enabled=False),
        ],
    )


def test_profile_round_trips_registers():
    p = _profile()
    p2 = GameProfile.model_validate(p.model_dump())
    assert [r.id for r in p2.registers] == ["hp", "off"]
    assert p2.registers[0].sources == ["readout:health", "readout:shield"]
    assert p2.registers[1].enabled is False


def _session(profile=None):
    # engine is never touched by __init__ / the feed path, so None is fine for pure-logic tests.
    return LiveSession(None, profile or _profile())


def test_readout_ref_parses_prefix():
    assert LiveSession._readout_ref("readout:health") == "health"
    assert LiveSession._readout_ref("bare") == "bare"
    assert LiveSession._readout_ref("dataset:x") is None


def test_feed_holds_and_overwrites():
    s = _session()
    s._feed_registers({"health": 487, "shield": 120}, {"health": 0.9, "shield": 0.8})
    rows = {r["key"]: r for r in s.register_records("hp")}
    assert set(rows) == {"health", "shield"}
    assert rows["health"]["value"] == 487
    assert rows["health"]["conf"] == 0.9
    first = rows["health"]["first_seen"]

    # a later read overwrites value/last_seen but keeps first_seen
    s._feed_registers({"health": 486}, {"health": 0.95})
    r = {x["key"]: x for x in s.register_records("hp")}["health"]
    assert r["value"] == 486
    assert r["first_seen"] == first
    assert r["last_seen"] >= first


def test_absent_readout_keeps_prior_entry():
    s = _session()
    s._feed_registers({"health": 1, "shield": 2}, {})
    s._feed_registers({"health": 9}, {})   # shield absent this tick
    rows = {r["key"]: r for r in s.register_records("hp")}
    assert rows["health"]["value"] == 9
    assert rows["shield"]["value"] == 2   # held, not dropped


def test_disabled_register_not_fed():
    s = _session()
    s._feed_registers({"health": 1}, {})
    assert s.register_records("off") == []


def test_only_wired_readouts_held():
    s = _session()
    s._feed_registers({"health": 1, "mana": 5}, {})   # mana not a source of "hp"
    assert {r["key"] for r in s.register_records("hp")} == {"health"}


def test_clear_wipes_map():
    s = _session()
    s._feed_registers({"health": 1, "shield": 2}, {})
    assert s.register_records("hp")
    s.clear_register("hp")
    assert s.register_records("hp") == []
