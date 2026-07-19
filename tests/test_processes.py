"""Process node — model round-trip + LiveSession rules pipeline & KEY MANGLER (pure logic, no GPU).

A process applies ONE FieldRule pipeline to every wired SINGLE-KEY input's value, and renames each
input's key on the way out (ProcessInput.out; blank = keep the input key). Inputs are one key each
(readout, or a register slot). Only key + value enter (never confidence); no consensus/gate here.
Output is recomputed fresh each tick (a process holds no state, unlike a register).
"""

from oc.collect import process_history
from oc.collect.live import LiveSession
from oc.profile.models import FieldRule, GameProfile, ProcessDef, ProcessInput, RegisterDef


def _session(profile):
    # engine is never touched by __init__ / the feed path, so None is fine for pure-logic tests.
    return LiveSession(None, profile)


def test_profile_round_trips_processes():
    p = GameProfile(name="g", processes=[
        ProcessDef(id="clean", type="number", sources=[{"ref": "readout:hp"}, {"ref": "readout:shield"}],
                   rules=[FieldRule(when="always", then="extract", strategy="number")]),
    ])
    p2 = GameProfile.model_validate(p.model_dump())
    assert [x.id for x in p2.processes] == ["clean"]
    assert p2.processes[0].type.value == "number"
    assert [s.ref for s in p2.processes[0].sources] == ["readout:hp", "readout:shield"]
    assert p2.processes[0].rules[0].then.value == "extract"


def test_processinput_round_trips_and_trims_blank_out():
    # the ProcessInput serializer omits a blank `out` (bare {ref}) but keeps a set one.
    p = GameProfile(name="g", processes=[ProcessDef(id="m", sources=[
        ProcessInput(ref="readout:hp", out="health"), ProcessInput(ref="register:reg#slot")])])
    dumped = p.model_dump()["processes"][0]["sources"]
    assert dumped == [{"ref": "readout:hp", "out": "health"}, {"ref": "register:reg#slot"}]
    p2 = GameProfile.model_validate(p.model_dump())
    assert p2.processes[0].sources[0].out == "health"
    assert p2.processes[0].sources[1].out == ""


def test_applies_rules_key_preserved():
    p = GameProfile(name="g", processes=[
        ProcessDef(id="clean", type="number", sources=[{"ref": "readout:hp"}, {"ref": "readout:shield"}],
                   rules=[FieldRule(when="always", then="extract", strategy="number")]),
    ])
    s = _session(p)
    s._readouts_all = {"hp": "487 dmg", "shield": "120 x"}
    s._feed_processes()
    assert s._process_values["clean"] == {"hp": 487, "shield": 120}   # value transformed, key kept


def test_blank_out_keeps_input_key():
    p = GameProfile(name="g", processes=[ProcessDef(id="m", sources=[{"ref": "readout:hp"}], rules=[])])
    s = _session(p)
    s._readouts_all = {"hp": "100"}
    s._feed_processes()
    assert s._process_values["m"] == {"hp": "100"}   # no `out` -> emitted under the input key


def test_out_renames_emitted_key():
    p = GameProfile(name="g", processes=[
        ProcessDef(id="m", sources=[{"ref": "readout:hp", "out": "health"}], rules=[])])
    s = _session(p)
    s._readouts_all = {"hp": "100"}
    s._feed_processes()
    assert s._process_values["m"] == {"health": "100"}   # emitted under the mangled key


def test_history_recorded_under_output_key():
    p = GameProfile(name="g", processes=[
        ProcessDef(id="m", sources=[{"ref": "readout:hp", "out": "health"}], rules=[])])
    s = _session(p)
    s._readouts_all = {"hp": "100"}
    s._feed_processes()
    hist = process_history.recent("g", "m")
    assert hist and hist[0]["key"] == "health" and hist[0]["raw"] == "100"


def test_drop_rule_omits_key():
    p = GameProfile(name="g", processes=[
        ProcessDef(id="f", sources=[{"ref": "readout:a"}, {"ref": "readout:b"}],
                   rules=[FieldRule(when="equal", arg="x", then="drop")]),
    ])
    s = _session(p)
    s._readouts_all = {"a": "x", "b": "keep"}
    s._feed_processes()
    assert s._process_values["f"] == {"b": "keep"}   # 'a' matched drop -> omitted


def test_blank_rule_forwards_null_gap():
    # distinct from `drop`: a `blank` rule keeps the key but forwards value=None (a gap), so a
    # downstream register with ignore_empty=false can record the hole. Contrast test_drop_rule_omits_key.
    p = GameProfile(name="g", processes=[
        ProcessDef(id="f", sources=[{"ref": "readout:a"}, {"ref": "readout:b"}],
                   rules=[FieldRule(when="equal", arg="x", then="blank")]),
    ])
    s = _session(p)
    s._readouts_all = {"a": "x", "b": "keep"}
    s._feed_processes()
    assert s._process_values["f"] == {"a": None, "b": "keep"}   # 'a' blanked -> present as None, not omitted


def test_blank_process_feeds_register_gap():
    # end-to-end of the drops-not-forwarded fix: a process `blank` rule forwards a None gap to a
    # register. ignore_empty=false records the gap in the ring; ignore_empty=true skips it.
    def build(ignore_empty):
        return GameProfile(name="g",
            processes=[ProcessDef(id="p", type="number", sources=[{"ref": "readout:a"}],
                                  rules=[FieldRule(when="no_digit", then="blank")])],
            registers=[RegisterDef(id="r", sources=["process:p"], capacity=3,
                                   ignore_empty=ignore_empty)])

    def feed(s, raw):
        s._readouts_all = {"a": raw}
        s._feed_processes()                       # p: "12"->12, "xx"->blank->None
        s._feed_registers(s._readouts_all, {})    # r reads process:p

    s = _session(build(False))
    feed(s, "12")
    feed(s, "xx")
    assert s._registers["r"]["a"]["values"] == [12, None]   # gap recorded

    s = _session(build(True))
    feed(s, "12")
    feed(s, "xx")
    assert s._registers["r"]["a"]["values"] == [12]         # gap skipped


def test_confidence_never_read_from_inputs():
    p = GameProfile(name="g", processes=[ProcessDef(id="f", sources=[{"ref": "readout:a"}], rules=[])])
    s = _session(p)
    s._readouts_all = {"a": "hello"}
    s._readout_confs_all = {"a": 0.01}   # would trip any conf floor — a process ignores it
    s._feed_processes()
    assert s._process_values["f"] == {"a": "hello"}


def test_disabled_process_not_evaluated():
    p = GameProfile(name="g", processes=[
        ProcessDef(id="off", sources=[{"ref": "readout:a"}], rules=[], enabled=False)])
    s = _session(p)
    s._readouts_all = {"a": "v"}
    s._feed_processes()
    assert "off" not in s._process_values


def test_register_holds_process_output_key_preserved():
    # a register wired to a process holds one slot per emitted key (value passed through, no conf).
    p = GameProfile(
        name="g",
        processes=[ProcessDef(id="clean", type="number", sources=[{"ref": "readout:hp", "out": "health"}],
                              rules=[FieldRule(when="always", then="extract", strategy="number")])],
        registers=[RegisterDef(id="held", sources=["process:clean"])])
    s = _session(p)
    s._readouts_all = {"hp": "487 dmg"}
    s._feed_processes()                                   # processes first (as the live tick does)
    s._feed_registers(s._readouts_all, s._readout_confs_all)
    rows = {r["key"]: r for r in s.register_records("held")}
    assert rows["health"]["value"] == 487                 # mangled key reached the register slot
    assert rows["health"]["conf"] is None                 # no confidence carried from a process source


def test_register_key_slice_feeds_one_key():
    # a register slot input (register:<id>#<key>) feeds a process only that ONE key.
    p = GameProfile(
        name="g",
        registers=[RegisterDef(id="reg", sources=["readout:a", "readout:b"])],
        processes=[ProcessDef(id="pick", sources=[{"ref": "register:reg#a"}],
                              rules=[FieldRule(when="always", then="uppercase")])])
    s = _session(p)
    s._readouts_all = {"a": "aa", "b": "bb"}
    s._feed_registers(s._readouts_all, s._readout_confs_all)   # register held from a prior tick
    s._feed_processes()
    assert s._process_values["pick"] == {"a": "AA"}      # only key 'a'; 'b' excluded by the slice


def test_rename_carries_history_to_new_id():
    p = GameProfile(name="g", processes=[ProcessDef(id="f", sources=[{"ref": "readout:a"}], rules=[])])
    s = _session(p)
    s._readouts_all = {"a": "v"}
    s._feed_processes()
    assert process_history.recent("g", "f")
    s.rename_process("f", "renamed")
    assert process_history.recent("g", "f") == []
    assert process_history.recent("g", "renamed")


# ---- flow blobs (in + out edges animate as data moves through the process) --------

def test_flow_readout_targets_include_process():
    p = GameProfile(name="g", processes=[ProcessDef(id="m", sources=[{"ref": "readout:hp"}])])
    s = _session(p)
    assert "process:m" in s._readout_targets("hp")      # readout -> process is a flow edge
    assert "process:m" not in s._readout_targets("other")


def test_flow_process_consumers():
    p = GameProfile(
        name="g",
        processes=[ProcessDef(id="m", sources=[{"ref": "readout:hp"}])],
        registers=[RegisterDef(id="held", sources=["process:m"])])
    s = _session(p)
    assert s._process_consumers("m") == ["register:held"]


def test_flow_out_blob_every_run_no_gate(monkeypatch):
    # NO change-gate: a process that ran animates its OUT edge EVERY tick, even with identical output.
    # Coalescing is the downstream (client) job; the backend never drops a valid read silently.
    calls = []
    monkeypatch.setattr("oc.collect.live.publish_flow", lambda game, kind, src, dst, n: calls.append((kind, src, dst)))
    p = GameProfile(
        name="g",
        processes=[ProcessDef(id="m", sources=[{"ref": "readout:hp", "out": "health"}], rules=[])],
        registers=[RegisterDef(id="held", sources=["process:m"])])
    s = _session(p)
    s._readouts_all = {"hp": "100"}
    s._feed_processes()
    s._feed_processes()                                  # same output -> STILL emits (no gate)
    assert calls.count(("data", "process:m", "register:held")) == 2


def test_flow_in_blob_register_slot_every_held_tick(monkeypatch):
    # register-slot -> process animates for every HELD slot each tick (no change event needed); a slot
    # with no held value has no data to animate.
    calls = []
    monkeypatch.setattr("oc.collect.live.publish_flow", lambda game, kind, src, dst, n: calls.append((kind, src, dst)))
    p = GameProfile(
        name="g",
        registers=[RegisterDef(id="reg", sources=["readout:a"])],
        processes=[ProcessDef(id="m", sources=[{"ref": "register:reg#a"}])])
    s = _session(p)
    s._readouts_all = {"a": "aa"}
    s._feed_registers(s._readouts_all, s._readout_confs_all)   # register now HOLDS slot 'a'
    s._emit_register_process_flow()
    s._emit_register_process_flow()                            # every tick -> emits again (no gate)
    assert calls.count(("data", "register:reg", "process:m")) == 2

    calls.clear()
    p2 = GameProfile(
        name="g",
        registers=[RegisterDef(id="reg", sources=["readout:a"])],
        processes=[ProcessDef(id="m", sources=[{"ref": "register:reg#missing"}])])
    s2 = _session(p2)
    s2._emit_register_process_flow()                           # slot never held -> no blob
    assert calls == []


def test_feed_uses_fresh_profile_wiring(monkeypatch):
    # a session started BEFORE the process was wired (stale self._profile) must still feed + animate
    # the process when the preview-feed passes the FRESH request profile — no live restart needed
    # (mirrors the registers= fresh-wiring override). This is the "not seeing blobs" fix.
    calls = []
    monkeypatch.setattr("oc.collect.live.publish_flow", lambda game, kind, src, dst, n: calls.append((kind, src, dst)))
    stale = GameProfile(name="g")                    # session snapshot: no process, no register
    s = _session(stale)
    fresh = GameProfile(
        name="g",
        processes=[ProcessDef(id="m", sources=[{"ref": "readout:hp"}], rules=[])],
        registers=[RegisterDef(id="held", sources=["process:m"])])
    s._readouts_all = {"hp": "100"}
    s._feed_processes(processes=fresh.processes, profile=fresh)   # feed path passes fresh wiring
    assert s._process_values["m"] == {"hp": "100"}               # fed despite stale self._profile
    assert ("data", "process:m", "register:held") in calls       # OUT blob via the fresh consumers
    assert "process:m" in s._readout_targets("hp", fresh)        # IN target via the fresh wiring


def test_readout_flow_emits_every_run_no_gate(monkeypatch):
    # readout -> process animates on EVERY read, even an unchanged value (no change-gate). The live
    # loop and the feed path behave identically now — downstream coalesces.
    calls = []
    monkeypatch.setattr("oc.collect.live.publish_flow", lambda game, kind, src, dst, n: calls.append((kind, src, dst)))
    p = GameProfile(name="g", processes=[ProcessDef(id="m", sources=[{"ref": "readout:hp"}], rules=[])])
    s = _session(p)
    s._emit_readout_flow("w", {"hp": "100"})
    s._emit_readout_flow("w", {"hp": "100"})                 # same value -> STILL emits
    assert calls.count(("data", "ro:w:hp", "process:m")) == 2


def test_on_tick_emits_process_flow_both_directions(monkeypatch):
    # the FULL live tick path: a readout feeding a process feeding a register must animate BOTH
    # the readout->process (in) and process->register (out) edges on a value change.
    from types import SimpleNamespace

    from oc.collect.collector import TickStatus

    calls = []
    monkeypatch.setattr("oc.collect.live.publish_flow", lambda game, kind, src, dst, n: calls.append((kind, src, dst)))
    p = GameProfile(
        name="g",
        processes=[ProcessDef(id="m", sources=[{"ref": "readout:hp"}], rules=[])],
        registers=[RegisterDef(id="held", sources=["process:m"])])
    s = _session(p)
    result = SimpleNamespace(
        status=TickStatus.moving, new=0, window_id="w",
        readouts={"hp": "100"}, readout_confs={"hp": 0.9},
        readouts_all={"hp": "100"}, readout_confs_all={"hp": 0.9})
    s._on_tick(result)
    assert ("data", "ro:w:hp", "process:m") in calls        # IN  blob: readout -> process
    assert ("data", "process:m", "register:held") in calls  # OUT blob: process -> register
