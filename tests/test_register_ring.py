"""Register ring buffer (RegisterDef.capacity) — per-key rolling history of the last N values,
pure logic, no GPU. Pulls/persist/records expose the LATEST (ring tail); the extra depth is
retained history. Complements test_registers.py (which covers the depth-1 default behaviour).
"""

from types import SimpleNamespace

from oc.collect import register_history
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
    # the public record shows the LATEST + the current depth + the full ring (membank stack)
    r = {x["key"]: x for x in s.register_records("hp")}["health"]
    assert r["value"] == 40
    assert r["depth"] == 3
    assert r["values"] == [20, 30, 40]   # oldest -> newest, the client reverses to stack latest-first


def test_repeated_value_fills_the_ring():
    # EVERY read is appended (even identical ones) so a rolling window / moving aggregate sees each
    # sample — a static value fills the ring to its cap, newest N retained.
    s = _session(cap=3)
    for _ in range(5):
        s._feed_registers({"health": 100}, {"health": 0.9})
    assert s._registers["hp"]["health"]["values"] == [100, 100, 100]
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
    s._feed_registers({"health": 4}, {"health": 0.9})  # 4 appended again -> [.. ,4,4], trimmed to newest 2
    assert s._registers["hp"]["health"]["values"] == [4, 4]


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


# ---- ignore_empty --------------------------------------------------------------

def test_ignore_empty_drops_null_and_empty_reads():
    profile = GameProfile(name="g", registers=[
        RegisterDef(id="hp", sources=["readout:health"], capacity=3, ignore_empty=True),
    ])
    s = LiveSession(None, profile)
    s._feed_registers({"health": 10}, {})
    s._feed_registers({"health": ""}, {})     # empty -> dropped, ring unchanged
    s._feed_registers({"health": None}, {})   # null -> dropped, ring unchanged
    s._feed_registers({"health": 20}, {})
    assert s._registers["hp"]["health"]["values"] == [10, 20]


def test_ignore_empty_off_writes_empty():
    # default (off) writes whatever the readout yields, including a blank
    s = _session(cap=3)   # ignore_empty defaults False
    s._feed_registers({"health": 10}, {})
    s._feed_registers({"health": ""}, {})
    assert s._registers["hp"]["health"]["values"] == [10, ""]


# ---- aggregate ---------------------------------------------------------------

def _agg_session(mode, cap=4):
    profile = GameProfile(name="g", registers=[
        RegisterDef(id="hp", sources=["readout:health"], capacity=cap, aggregate=mode),
    ])
    return LiveSession(None, profile)


def test_aggregate_folds_the_ring():
    for mode, want in [("min", 10), ("max", 40), ("sum", 100), ("avg", 25), ("median", 25)]:
        s = _agg_session(mode)
        for v in (10, 20, 30, 40):
            s._feed_registers({"health": v}, {})
        r = {x["key"]: x for x in s.register_records("hp")}["health"]
        assert r["agg"] == want, mode
        assert r["values"] == [10, 20, 30, 40]   # raw ring always retained alongside the fold
        assert s.register_latest("hp", "health") == want   # exposed value = the fold


def test_aggregate_rounds_to_input_decimals_plus_one():
    # whole-number inputs -> avg/median round to ONE decimal (0 input decimals + 1)
    s = _agg_session("avg")
    for v in (10, 20, 30):
        s._feed_registers({"health": v}, {})
    assert s.register_latest("hp", "health") == 20.0   # round(20.0, 1)

    # two-decimal inputs -> round to THREE decimals (2 + 1)
    s = _agg_session("avg")
    for v in ("1.25", "2.75"):
        s._feed_registers({"health": v}, {})
    assert s.register_latest("hp", "health") == 2.0    # round(2.0, 3), value happens whole

    s = _agg_session("median")
    for v in ("0.1", "0.2", "0.4"):
        s._feed_registers({"health": v}, {})
    assert s.register_latest("hp", "health") == 0.2    # median rounded to 2 decimals


def test_whole_min_max_sum_stay_int():
    # min/max/sum merely select/add existing values -> a whole result stays an int (not x.0)
    for mode, want in [("min", 10), ("max", 30), ("sum", 60)]:
        s = _agg_session(mode)
        for v in (10, 20, 30):
            s._feed_registers({"health": v}, {})
        got = s.register_latest("hp", "health")
        assert got == want and isinstance(got, int), mode


def test_fractional_min_stays_float():
    # a fractional min is a float result -> rounded to input decimals + 1
    s = _agg_session("min")
    for v in ("1.5", "2.5"):
        s._feed_registers({"health": v}, {})
    got = s.register_latest("hp", "health")
    assert got == 1.5 and isinstance(got, float)


def test_aggregate_latest_default_has_no_fold():
    s = _agg_session("")   # "" == latest
    for v in (10, 20, 30):
        s._feed_registers({"health": v}, {})
    r = {x["key"]: x for x in s.register_records("hp")}["health"]
    assert r["agg"] is None                          # no aggregate -> no summary line
    assert s.register_latest("hp", "health") == 30   # ring tail


def test_aggregate_non_numeric_falls_back_to_tail():
    s = _agg_session("avg")
    for v in ("a", "b", "c"):
        s._feed_registers({"health": v}, {})
    # a non-numeric ring can't be folded -> expose the tail, never raise
    assert s.register_latest("hp", "health") == "c"


def test_persist_flushes_aggregate_when_set(monkeypatch, tmp_path):
    calls = []

    class _FakeStore:
        def record_many(self, rows):
            calls.append(rows)

    monkeypatch.setattr("oc.collect.live.store_for", lambda *a, **k: _FakeStore())
    profile = GameProfile(name="g", registers=[
        RegisterDef(id="hp", sources=["readout:health"], persist="loadout", capacity=3, aggregate="avg"),
    ])
    engine = SimpleNamespace(settings=SimpleNamespace(data_dir=tmp_path))
    s = LiveSession(engine, profile)
    for v in (10, 20, 30):
        s._feed_registers({"health": v}, {"health": 0.9})
    assert calls[-1] == [{"name": "health", "value": 20}]   # avg(10,20,30), not the tail 30


# ---- push-history ring -------------------------------------------------------

def test_push_history_records_index_and_overwritten():
    register_history.clear("g")
    profile = GameProfile(name="g", registers=[
        RegisterDef(id="hp", sources=["readout:health"], capacity=2),
    ])
    s = LiveSession(None, profile)
    # ring_index is the CIRCULAR write cursor ((writes-1) % cap), rotating 0,1,0,1,... — not a
    # constant tail. overwritten = the slot's prior content (None until the ring first fills).
    s._feed_registers({"health": 10}, {})   # write 1 -> cursor 0, ring [10], nothing evicted
    s._feed_registers({"health": 20}, {})   # write 2 -> cursor 1, ring [10,20], nothing evicted
    s._feed_registers({"health": 30}, {})   # write 3 -> cursor 0, ring [20,30], evicted 10
    hist = register_history.recent("g", "hp")   # newest first
    assert [e["value"] for e in hist] == [30, 20, 10]
    assert [e["ring_index"] for e in hist] == [0, 1, 0]   # rotating cursor, newest-first
    assert hist[0] == {"ts": hist[0]["ts"], "key": "health", "value": 30,
                       "ring_index": 0, "overwritten": 10}
    assert hist[2]["overwritten"] is None        # first write overwrote nothing
    # every read is a push now (duplicates included) -> a repeat value logs another entry
    s._feed_registers({"health": 30}, {"health": 0.9})   # write 4 -> cursor 1, ring [30,30], evicted 20
    hist2 = register_history.recent("g", "hp")
    assert len(hist2) == 4
    assert hist2[0]["value"] == 30 and hist2[0]["ring_index"] == 1 and hist2[0]["overwritten"] == 20


def test_push_history_capacity_one_overwrites_previous():
    register_history.clear("g")
    profile = GameProfile(name="g", registers=[
        RegisterDef(id="hp", sources=["readout:health"], capacity=1),
    ])
    s = LiveSession(None, profile)
    s._feed_registers({"health": 10}, {})
    s._feed_registers({"health": 20}, {})
    hist = register_history.recent("g", "hp")
    # capacity 1: each new value overwrites the single held slot -> overwritten == prior value
    assert hist[0]["overwritten"] == 10
    assert hist[0]["ring_index"] == 0


def test_clear_register_wipes_push_history():
    register_history.clear("g")
    profile = GameProfile(name="g", registers=[
        RegisterDef(id="hp", sources=["readout:health"], capacity=2),
    ])
    s = LiveSession(None, profile)
    s._feed_registers({"health": 10}, {})
    assert register_history.recent("g", "hp")
    s.clear_register("hp")
    assert register_history.recent("g", "hp") == []
