"""Gates (a trigger's value predicate, lifted into reusable nodes) + routers (fan-out by a live
value). The trigger's kind supplies the PULSE; a gate supplies the LEVEL; fire = pulse AND every
gate holds. A router forwards a fire to the first branch whose conds hold. All evaluated server-side
against the runner's live caches — no game knowledge. See TriggerRunner._gates_pass / _resolve_fire.
"""

import tempfile

from oc.collect.fields import _matches
from oc.collect.triggers import TriggerRunner, fire_action
from oc.profile.models import (
    ActionDef, GameProfile, GateCond, GateDef, RouterBranch, RouterDef, RuleWhen, SoundDef,
    TriggerDef,
)


def _runner(profile):
    return TriggerRunner(profile, tempfile.gettempdir(), clock=lambda: 0.0)


def _gate(gid, source, *conds, logic="or", negate=False):
    return GateDef(id=gid, source=source, logic=logic, negate=negate,
                   conds=[GateCond(when=w, arg=str(a)) for w, a in conds])


# ---- the `in` op (shared field predicate, reused by gates) --------------------------------------

def test_in_op_membership():
    assert _matches(RuleWhen.in_list, "octavia", "octavia,volt,mesa")
    assert _matches(RuleWhen.in_list, "VOLT", "octavia, volt , mesa")   # case + whitespace-insensitive
    assert not _matches(RuleWhen.in_list, "rhino", "octavia,volt")
    assert not _matches(RuleWhen.in_list, "octavia", "")               # empty list matches nothing


# ---- _cond_holds: the op families ---------------------------------------------------------------

def test_cond_holds_numeric_text_and_edge():
    tr = _runner(GameProfile(name="g"))
    C = GateCond
    # numeric level
    assert tr._cond_holds(C(when="lt", arg="3"), 2, None)
    assert not tr._cond_holds(C(when="lt", arg="3"), 3, None)
    assert tr._cond_holds(C(when="between", arg="20,40"), 30, None)
    assert not tr._cond_holds(C(when="between", arg="20,40"), 50, None)
    # text / shape (via fields._matches)
    assert tr._cond_holds(C(when="in", arg="octavia,volt"), "volt", None)
    assert tr._cond_holds(C(when="equal", arg="Octavia"), "octavia", None)   # case-insensitive
    assert tr._cond_holds(C(when="contains", arg="oct"), "octavia", None)
    # edge ops compare against prev
    assert tr._cond_holds(C(when="crosses_up", arg="5"), 8, 3)      # 3 -> 8 crosses up through 5
    assert not tr._cond_holds(C(when="crosses_up", arg="5"), 8, None)   # no prev -> no crossing
    assert tr._cond_holds(C(when="changed", arg=""), 8, 3)         # moved
    assert not tr._cond_holds(C(when="changed", arg=""), 8, 8)     # static


# ---- _gates_pass: allow / block / and / or / missing ---------------------------------------------

def _gp(gates, trig_gates, snapshot):
    prof = GameProfile(name="g", gates=gates,
                       triggers=[TriggerDef(id="t", kind="on_register", register_watch=["r"],
                                            gates=trig_gates)])
    tr = _runner(prof)
    tr.set_registers(snapshot)
    return tr._gates_pass(prof.triggers[0])


def test_gates_pass_allow_list():
    g = _gate("gf", "register:r2#frame", ("in", "octavia,volt"))
    assert _gp([g], ["gf"], {"r2": {"frame": "octavia"}})
    assert not _gp([g], ["gf"], {"r2": {"frame": "mesa"}})


def test_gates_pass_block_list_negate():
    g = _gate("gb", "register:r2#frame", ("in", "mesa,rhino"), negate=True)
    assert _gp([g], ["gb"], {"r2": {"frame": "octavia"}})   # not in the block list -> pass
    assert not _gp([g], ["gb"], {"r2": {"frame": "mesa"}})   # in the block list -> blocked


def test_gates_pass_and_across_gates():
    # multiple gates on a trigger AND together
    ga = _gate("ga", "register:r#a", ("lt", "3"))
    gb = _gate("gb", "register:r#b", ("lt", "3"))
    assert _gp([ga, gb], ["ga", "gb"], {"r": {"a": 2, "b": 2}})
    assert not _gp([ga, gb], ["ga", "gb"], {"r": {"a": 2, "b": 5}})   # gb fails -> blocked


def test_gate_internal_or_and_logic():
    g_or = _gate("go", "register:r#a", ("lt", "1"), ("gt", "9"), logic="or")
    assert _gp([g_or], ["go"], {"r": {"a": 10}})    # matches the gt branch
    g_and = _gate("ga", "register:r#a", ("gt", "1"), ("lt", "9"), logic="and")
    assert _gp([g_and], ["ga"], {"r": {"a": 5}})
    assert not _gp([g_and], ["ga"], {"r": {"a": 10}})   # fails the lt cond


def test_missing_or_disabled_gate_passes():
    assert _gp([], ["ghost"], {})                                    # dangling ref -> pass (never wedge)
    g = _gate("gd", "register:r#a", ("lt", "3"))
    g.enabled = False
    assert _gp([g], ["gd"], {"r": {"a": 99}})                        # disabled -> no-op pass


# ---- count-facet source: gate on HOW MANY recent values a register key holds --------------------

def test_facet_count_measures():
    fc = TriggerRunner._facet_count
    ring = [4.0, None, 4.0, ""]      # 4 held; 2 non-blank; 1 distinct non-blank value
    assert fc(ring, "count") == 4
    assert fc(ring, "nonblank") == 2
    assert fc(ring, "distinct") == 1
    assert fc([1, 2, 2, 3], "distinct") == 3
    assert fc(None, "count") is None         # no rings pushed -> a count source doesn't hold
    assert fc(ring, "bogus") is None


def test_source_value_resolves_count_facet():
    tr = _runner(GameProfile(name="g"))
    tr.set_register_rings({"r": {"a": [4.0, None, 4.0]}})
    assert tr._source_value("register:r#a@count") == 3
    assert tr._source_value("register:r#a@nonblank") == 2
    assert tr._source_value("register:r#a@distinct") == 1
    assert tr._source_value("register:r#missing@count") is None


def test_gate_on_recent_value_count():
    # "gate when the key holds more than one recent value" = count at least 2, over the ring.
    g = _gate("gc", "register:r#a@count", ("gte", "2"))
    prof = GameProfile(name="g", gates=[g], triggers=[
        TriggerDef(id="t", kind="on_register", register_watch=["r"], gates=["gc"])])
    tr = _runner(prof)
    tr.set_register_rings({"r": {"a": [4.0]}})            # one held -> blocked
    assert not tr._gates_pass(prof.triggers[0])
    tr.set_register_rings({"r": {"a": [4.0, 4.0]}})       # two held -> passes
    assert tr._gates_pass(prof.triggers[0])


def test_gate_on_distinct_value_count():
    # distinct counts UNIQUE non-blank values -> "the key has seen 2+ different values" (unstable).
    g = _gate("gd", "register:r#a@distinct", ("gte", "2"))
    prof = GameProfile(name="g", gates=[g], triggers=[
        TriggerDef(id="t", kind="on_register", register_watch=["r"], gates=["gd"])])
    tr = _runner(prof)
    tr.set_register_rings({"r": {"a": [4.0, 4.0, 4.0]}})  # all the same -> 1 distinct -> blocked
    assert not tr._gates_pass(prof.triggers[0])
    tr.set_register_rings({"r": {"a": [4.0, 5.0]}})       # two different -> passes
    assert tr._gates_pass(prof.triggers[0])


# ---- _resolve_fire: router branch selection + sound/server split --------------------------------

def _resolve(frame):
    prof = GameProfile(
        name="g",
        sounds=[SoundDef(id="sound_a"), SoundDef(id="sound_b")],
        routers=[RouterDef(id="rt", source="register:r2#frame", branches=[
            RouterBranch(conds=[GateCond(when="equal", arg="octavia")], targets=["sound_a"]),
            RouterBranch(conds=[GateCond(when="equal", arg="volt")], targets=["sound_b", "px"]),
            RouterBranch(conds=[], targets=[]),   # else -> drop
        ])],
        triggers=[TriggerDef(id="t", kind="interval", targets=["rt"])],
    )
    tr = _runner(prof)
    tr.set_registers({"r2": {"frame": frame}})
    return tr._resolve_fire(prof.triggers[0])


def test_router_first_match_and_sound_split():
    assert _resolve("octavia") == ([], ["sound_a"])          # sound-only branch
    assert _resolve("volt") == (["px"], ["sound_b"])         # server target + sound split
    assert _resolve("mesa") == ([], [])                      # else -> drop


def test_direct_targets_bypass_router():
    prof = GameProfile(
        name="g", sounds=[SoundDef(id="bob")],
        triggers=[TriggerDef(id="t", kind="interval", targets=["bob", "producer_x"])],
    )
    tr = _runner(prof)
    # sound goes to the cue list, non-sound to the fire list (no router involved)
    assert tr._resolve_fire(prof.triggers[0]) == (["producer_x"], ["bob"])


def test_disabled_sound_dropped_from_cue():
    # a disabled sound is honored server-side (sounds are client-played off the fire cue): it must
    # NOT reach sound_ids, and must NOT leak into fire_ids as a phantom server target.
    prof = GameProfile(
        name="g",
        sounds=[SoundDef(id="on"), SoundDef(id="off", enabled=False)],
        triggers=[TriggerDef(id="t", kind="interval", targets=["on", "off", "producer_x"])],
    )
    tr = _runner(prof)
    assert tr._resolve_fire(prof.triggers[0]) == (["producer_x"], ["on"])


# ---- manual fire (via _emit_fire) bypasses gates -------------------------------------------------

def test_gated_ids_reports_currently_blocked_triggers():
    # the live 'gated off' cue: gated_ids lists enabled+gated triggers whose gates block them now.
    g = _gate("gb", "register:r#a", ("lt", "3"))
    prof = GameProfile(name="g", gates=[g], triggers=[
        TriggerDef(id="t", kind="on_register", register_watch=["r"], gates=["gb"]),
        TriggerDef(id="u", kind="interval"),                       # no gates -> never gated
    ])
    tr = _runner(prof)
    tr.set_registers({"r": {"a": 99}})     # 99 not < 3 -> t is blocked
    assert tr.gated_ids() == ["t"]
    tr.set_registers({"r": {"a": 1}})      # 1 < 3 -> t passes
    assert tr.gated_ids() == []


def test_emit_gate_flow_only_on_flip():
    # The source->gate data blob fires only when the decision flips; the gate->trigger hop is NOT a
    # blob anymore (the line is tinted ok/danger by gate_states instead), so no watch blob is emitted.
    import oc.store.flow_events as fl
    blobs = []
    off = fl.subscribe(lambda game, kind, src, dst, n: blobs.append((kind, src, dst)))
    try:
        g = _gate("gb", "register:reg#a", ("lt", "3"))
        prof = GameProfile(name="g", gates=[g], triggers=[
            TriggerDef(id="t", kind="on_register", register_watch=["reg"], gates=["gb"])])
        tr = _runner(prof)
        tr.set_registers({"reg": {"a": 5}})
        tr.emit_gate_flow()                     # first sight (blocked) -> seed, no blob
        assert blobs == []
        tr.set_registers({"reg": {"a": 5}})
        tr.emit_gate_flow()                     # unchanged -> no blob
        assert blobs == []
        tr.set_registers({"reg": {"a": 2}})
        tr.emit_gate_flow()                     # flip to pass -> data blob source->gate only
        assert ("data", "register:reg", "gate:gb") in blobs
        assert not any(kind == "watch" for kind, *_ in blobs)   # no gate->trigger blob
    finally:
        off()


def test_gate_states_reports_pass_block():
    g = _gate("gb", "register:reg#a", ("lt", "3"))
    prof = GameProfile(name="g", gates=[g], triggers=[
        TriggerDef(id="t", kind="on_register", register_watch=["reg"], gates=["gb"])])
    tr = _runner(prof)
    tr.set_registers({"reg": {"a": 5}})         # 5 not < 3 -> gate BLOCKS
    assert tr.gate_states() == {"gb": False}
    tr.set_registers({"reg": {"a": 2}})         # 2 < 3 -> gate PASSES
    assert tr.gate_states() == {"gb": True}
    g.enabled = False                           # disabled gate omitted (line stays grey)
    assert tr.gate_states() == {}


def test_emit_fire_bypasses_gates():
    # gates are checked in _route_fire (the AUTO path); a direct _emit_fire (manual "fire now")
    # must fire regardless of a blocking gate.
    g = _gate("gb", "register:r#a", ("lt", "3"))
    prof = GameProfile(name="g", gates=[g],
                       triggers=[TriggerDef(id="t", kind="on_register", register_watch=["r"],
                                            gates=["gb"])])
    fired = []
    tr = TriggerRunner(prof, tempfile.gettempdir(),
                       fire=lambda pn, items: fired.append(pn.id), clock=lambda: 0.0)
    tr.set_registers({"r": {"a": 99}})                    # gate would BLOCK (99 not < 3)
    assert tr._route_fire(prof.triggers[0], "auto", items=None) is False   # gated
    assert tr._emit_fire(prof.triggers[0], "manual", items=None) is True   # manual bypasses


# ---- satellite-log rings: gate flip / router route-change / sound play / action run ------------

def test_emit_gate_flow_writes_gate_history_on_flip():
    from oc.collect import gate_history
    g = _gate("gb", "register:reg#a", ("lt", "3"))
    prof = GameProfile(name="test_gate_hist", gates=[g], triggers=[
        TriggerDef(id="t", kind="on_register", register_watch=["reg"], gates=["gb"])])
    gate_history.clear(prof.name)
    tr = _runner(prof)
    tr.set_registers({"reg": {"a": 5}})
    tr.emit_gate_flow()                     # first sight -> seed, no log row
    assert gate_history.recent(prof.name, "gb") == []
    tr.set_registers({"reg": {"a": 2}})
    tr.emit_gate_flow()                     # flip to pass -> one log row
    rows = gate_history.recent(prof.name, "gb")
    assert len(rows) == 1
    assert rows[0]["holds"] is True
    assert rows[0]["source"] == "register:reg#a"
    assert rows[0]["conds"] == [{"when": "lt", "arg": "3", "hold": True}]


def test_emit_router_flow_logs_only_on_branch_change():
    from oc.collect import router_history
    r = RouterDef(id="rt", source="register:reg#a", branches=[
        RouterBranch(conds=[GateCond(when="lt", arg="3")], targets=["x"]),
        RouterBranch(conds=[], targets=["y"])])   # else branch
    prof = GameProfile(name="test_router_hist", routers=[r])
    router_history.clear(prof.name)
    tr = _runner(prof)
    tr.set_registers({"reg": {"a": 99}})    # branch 0 misses -> else (branch 1) selected
    tr.emit_router_flow()                   # first sight -> seed, no log row
    assert router_history.recent(prof.name, "rt") == []
    tr.emit_router_flow()                   # unchanged selection -> still no row
    assert router_history.recent(prof.name, "rt") == []
    tr.set_registers({"reg": {"a": 1}})      # branch 0 now matches -> selection changes
    tr.emit_router_flow()
    rows = router_history.recent(prof.name, "rt")
    assert len(rows) == 1
    assert rows[0]["selected"] == 0
    assert rows[0]["targets"] == ["x"]


def test_emit_fire_logs_sound_history():
    from oc.collect import sound_history
    snd = SoundDef(id="snd1", file="ding.wav")
    prof = GameProfile(name="test_sound_hist", sounds=[snd], triggers=[
        TriggerDef(id="t", kind="manual", targets=["snd1"])])
    sound_history.clear(prof.name)
    tr = _runner(prof)
    assert tr._emit_fire(prof.triggers[0], "manual", items=None) is True
    rows = sound_history.recent(prof.name, "snd1")
    assert len(rows) == 1
    assert rows[0]["trigger"] == "t"


def test_fire_action_logs_action_history():
    from oc.collect import action_history
    act = ActionDef(id="a1", sources=["sound:snd1"])
    snd = SoundDef(id="snd1", file="ding.wav")
    prof = GameProfile(name="test_action_hist", actions=[act], sounds=[snd])
    action_history.clear(prof.name)
    ok = fire_action(prof.name, act, tempfile.gettempdir(), profile=prof, trigger_id="t")
    assert ok is True
    rows = action_history.recent(prof.name, "a1")
    assert len(rows) == 1
    assert rows[0]["trigger"] == "t"
    assert rows[0]["sounds"] == ["snd1"]
