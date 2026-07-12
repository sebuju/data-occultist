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


def test_feed_holds_empty_value():
    # a readout that read empty (or dropped below confidence) must still push an entry, not be
    # skipped -- the full map hands "" for it (see TickResult.readouts_all), and the register
    # holds "" like any other value, overwriting a stale prior reading.
    s = _session()
    s._feed_registers({"health": 100, "shield": 50}, {"health": 0.9, "shield": 0.9})
    s._feed_registers({"health": "", "shield": 50}, {"health": None, "shield": 0.9})
    rows = {r["key"]: r for r in s.register_records("hp")}
    assert rows["health"]["value"] == ""


def test_persist_flushes_only_when_a_value_changes(monkeypatch, tmp_path):
    # RegisterDef.persist mirrors the held map into a dataset -- but only when a VALUE actually
    # changed (conf/last_seen alone don't count), else every tick would write.
    from types import SimpleNamespace

    calls = []

    class _FakeStore:
        def record_many(self, rows):
            calls.append(rows)

    made = []
    monkeypatch.setattr("oc.collect.live.store_for", lambda *a, **k: (made.append(1), _FakeStore())[1])

    profile = GameProfile(name="g", registers=[
        RegisterDef(id="hp", sources=["readout:health"], persist="loadout"),
    ])
    engine = SimpleNamespace(settings=SimpleNamespace(data_dir=tmp_path))
    s = LiveSession(engine, profile)

    s._feed_registers({"health": 100}, {"health": 0.9})
    assert calls == [[{"name": "health", "value": 100}]]

    s._feed_registers({"health": 100}, {"health": 0.95})   # same value, only conf differs -> no flush
    assert len(calls) == 1

    s._feed_registers({"health": 90}, {"health": 0.95})    # value changed -> flush again
    assert calls[1] == [{"name": "health", "value": 90}]
    assert len(made) == 1                                  # store opened once, cached across flushes


def test_no_persist_never_opens_a_store(monkeypatch):
    called = []
    monkeypatch.setattr("oc.collect.live.store_for", lambda *a, **k: called.append(1))
    s = _session()   # default profile's registers carry no `persist`
    s._feed_registers({"health": 1, "shield": 2}, {})
    assert called == []


def test_feed_registers_public_matches_internal_tick_path():
    # feed_registers (public, thread-safe) must behave exactly like the internal tick path for
    # a caller OUTSIDE the collector loop (a one-shot /api/preview OCR read) -- same overwrite/
    # dirty-flush semantics, just entered from a different door.
    s = _session()
    s.feed_registers({"health": 100, "shield": 50}, {"health": 0.9, "shield": 0.8})
    rows = {r["key"]: r for r in s.register_records("hp")}
    assert rows["health"]["value"] == 100 and rows["shield"]["value"] == 50


def test_feed_registers_accumulates_into_readouts_all():
    # mirrors _on_tick's own reasoning: a register wired to a readout from a window that isn't
    # the one just (preview-)read must still hold that readout's LAST known value, not wait for
    # that window to be read again -- feed_registers folds into the same accumulated map.
    s = _session()
    s.feed_registers({"health": 1}, {"health": 0.5})     # window A's readout
    s.feed_registers({"shield": 2}, {"shield": 0.5})     # window B's readout, health absent this call
    rows = {r["key"]: r for r in s.register_records("hp")}
    assert rows["health"]["value"] == 1                   # still held from the earlier call
    assert rows["shield"]["value"] == 2


def test_feed_registers_honors_fresh_wiring_over_stale_profile():
    # A long-lived session snapshots its profile at start; wiring a NEW readout into a register
    # afterwards must still reach the held map when the (preview) caller passes the FRESH
    # register wiring -- otherwise a just-added source is dropped against the stale snapshot
    # until the live collector is restarted. (Regression: warframe_name never reached loadout.)
    stale = GameProfile(name="g", registers=[RegisterDef(id="hp", sources=["readout:health"])])
    fresh = [RegisterDef(id="hp", sources=["readout:health", "readout:warframe_name"])]
    s = _session(stale)

    # stale wiring (registers=None) drops the newly-wired readout
    s.feed_registers({"health": 1, "warframe_name": "nova"}, {})
    assert {r["key"] for r in s.register_records("hp")} == {"health"}

    # fresh wiring passed through picks it up
    s.feed_registers({"health": 1, "warframe_name": "nova"}, {}, registers=fresh)
    rows = {r["key"]: r for r in s.register_records("hp")}
    assert rows["warframe_name"]["value"] == "nova"


def test_feed_registers_flushes_persist_like_live_tick(monkeypatch, tmp_path):
    from types import SimpleNamespace

    calls = []

    class _FakeStore:
        def record_many(self, rows):
            calls.append(rows)

    monkeypatch.setattr("oc.collect.live.store_for", lambda *a, **k: _FakeStore())
    profile = GameProfile(name="g", registers=[
        RegisterDef(id="hp", sources=["readout:health"], persist="loadout"),
    ])
    engine = SimpleNamespace(settings=SimpleNamespace(data_dir=tmp_path))
    s = LiveSession(engine, profile)

    s.feed_registers({"health": 100}, {"health": 0.9})
    assert calls == [[{"name": "health", "value": 100}]]
    s.feed_registers({"health": 100}, {"health": 0.95})   # same value -> no extra flush
    assert len(calls) == 1


def test_on_tick_routes_gated_vs_full_readout_maps():
    # `_on_tick` must feed the register from `readouts_all` (empty-inclusive) while keeping
    # `_readouts`/`_readout_confs` (status()'s gated map for toasts/triggers) fed only from the
    # gated `readouts`. A dataclass-like stub stands in for TickResult.
    from types import SimpleNamespace

    from oc.collect.collector import TickStatus

    s = _session()
    # status=moving (not saved/throttled) so _on_tick's bookkeeping only needs .status/.new --
    # the readout split under test doesn't depend on which status this is.
    result = SimpleNamespace(
        status=TickStatus.moving, new=0,
        readouts={"shield": 50},                      # health dropped (empty/low-conf) -> omitted
        readout_confs={"shield": 0.9},
        readouts_all={"health": "", "shield": 50},     # full map: health present as ""
        readout_confs_all={"health": None, "shield": 0.9},
    )
    s._on_tick(result)
    assert s._readouts == {"shield": 50}               # gated map never sees "health"
    rows = {r["key"]: r for r in s.register_records("hp")}
    assert rows["health"]["value"] == ""                # register still got the empty entry
    assert rows["shield"]["value"] == 50
