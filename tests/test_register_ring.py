"""Register ring buffer (RegisterDef.capacity) — per-key rolling history of the last N values,
pure logic, no GPU. Pulls/persist/records expose the LATEST (ring tail); the extra depth is
retained history. Complements test_registers.py (which covers the depth-1 default behaviour).
"""

from types import SimpleNamespace

from oc.collect.live import LiveSession
from oc.profile.models import GameProfile, RegisterDef


def _session(cap=3):
    profile = GameProfile(name="g", registers=[
        RegisterDef(id="hp", sources=["readout:health"], capacity=cap),
    ])
    return LiveSession(None, profile)


def test_ring_holds_last_n_distinct_values():
    s = _session(cap=3)
    for v in (10, 20, 30, 40):
        s._feed_registers({"health": v}, {})
    # internal ring: newest N, oldest dropped
    assert s._registers["hp"]["health"]["values"] == [20, 30, 40]
    # the public record shows the LATEST + the current depth
    r = {x["key"]: x for x in s.register_records("hp")}["health"]
    assert r["value"] == 40
    assert r["depth"] == 3


def test_unchanged_value_does_not_grow_ring():
    # a static HUD reads the same value every tick — it must not flood the ring with duplicates.
    s = _session(cap=3)
    for _ in range(5):
        s._feed_registers({"health": 100}, {"health": 0.9})
    assert s._registers["hp"]["health"]["values"] == [100]
    assert {x["key"]: x for x in s.register_records("hp")}["health"]["value"] == 100


def test_latest_helpers():
    s = _session(cap=3)
    for v in (1, 2, 3):
        s._feed_registers({"health": v}, {})
    assert s.register_keys("hp") == ["health"]
    assert s.register_latest("hp", "health") == 3
    assert s.register_latest("hp", "missing") is None
    assert s.register_latest("nope", "health") is None


def test_lowering_capacity_truncates_next_tick():
    # capacity is read per-tick from the RegisterDef, so shrinking it truncates to the newest N.
    profile = GameProfile(name="g", registers=[
        RegisterDef(id="hp", sources=["readout:health"], capacity=4),
    ])
    s = LiveSession(None, profile)
    for v in (1, 2, 3, 4):
        s._feed_registers({"health": v}, {})
    assert s._registers["hp"]["health"]["values"] == [1, 2, 3, 4]

    profile.registers[0].capacity = 2                 # user lowers N
    s._feed_registers({"health": 4}, {"health": 0.9})  # unchanged value still honours the new cap
    assert s._registers["hp"]["health"]["values"] == [3, 4]


def test_clear_register_keys_drops_only_named():
    profile = GameProfile(name="g", registers=[
        RegisterDef(id="hp", sources=["readout:health", "readout:shield"], capacity=2),
    ])
    s = LiveSession(None, profile)
    s._feed_registers({"health": 1, "shield": 2}, {})
    s.clear_register_keys("hp", ["health"])
    assert s.register_keys("hp") == ["shield"]
    # an unknown key / unknown register is a no-op, never raises
    s.clear_register_keys("hp", ["nope"])
    s.clear_register_keys("no-register", ["shield"])
    assert s.register_keys("hp") == ["shield"]


def test_persist_flushes_ring_tail(monkeypatch, tmp_path):
    calls = []

    class _FakeStore:
        def record_many(self, rows):
            calls.append(rows)

    monkeypatch.setattr("oc.collect.live.store_for", lambda *a, **k: _FakeStore())
    profile = GameProfile(name="g", registers=[
        RegisterDef(id="hp", sources=["readout:health"], persist="loadout", capacity=3),
    ])
    engine = SimpleNamespace(settings=SimpleNamespace(data_dir=tmp_path))
    s = LiveSession(engine, profile)

    s._feed_registers({"health": 10}, {"health": 0.9})
    s._feed_registers({"health": 20}, {"health": 0.9})
    # persist always mirrors the LATEST value per key (ring tail), not the whole ring
    assert calls[-1] == [{"name": "health", "value": 20}]
