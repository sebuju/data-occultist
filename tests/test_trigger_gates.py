"""Gates (a boolean predicate wired to the node(s) it permits/blocks via GateDef.targets) + routers
(fan-out by a live value). A gated trigger's kind supplies the PULSE; a gate supplies the LEVEL;
fire = pulse AND every gate naming this trigger holds. A router forwards a fire to the first branch
whose conds hold. All evaluated server-side against the runner's live caches — no game knowledge.
See TriggerRunner._gates_pass / _node_gated / _resolve_fire.
"""

import tempfile

from oc.collect.fields import _matches
from oc.collect.triggers import TriggerRunner, fire_action
from oc.profile.models import (
    ActionDef, DatasetDef, GameProfile, GateCond, GateDef, JoinSource, RouterBranch, RouterDef,
    RuleWhen, SoundDef, SubsetDef, TriggerDef,
)
from oc.store.dataset_store import DatasetStore


def _runner(profile):
    return TriggerRunner(profile, tempfile.gettempdir(), clock=lambda: 0.0)


def _gate(gid, source, *conds, logic="or", negate=False, targets=()):
    return GateDef(id=gid, source=source, logic=logic, negate=negate, targets=list(targets),
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


# ---- _gates_pass: allow / block / and / or / no controlling gate ---------------------------------

def _gp(gates, gate_ids_targeting_t, snapshot):
    """Build a trigger "t" gated by whichever of `gates` has its id listed in
    `gate_ids_targeting_t` (mirrors the old TriggerDef.gates call shape for these tests, but the
    link is now expressed as GateDef.targets)."""
    for g in gates:
        if g.id in gate_ids_targeting_t:
            g.targets = list(g.targets) + ["t"]
    prof = GameProfile(name="g", gates=gates,
                       triggers=[TriggerDef(id="t", kind="on_register", register_watch=["r"])])
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
    # multiple gates targeting a trigger AND together
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


def test_no_controlling_gate_or_disabled_gate_passes():
    assert _gp([], ["ghost"], {})                                    # no gate names "t" -> pass
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
    g = _gate("gc", "register:r#a@count", ("gte", "2"), targets=["t"])
    prof = GameProfile(name="g", gates=[g],
                       triggers=[TriggerDef(id="t", kind="on_register", register_watch=["r"])])
    tr = _runner(prof)
    tr.set_register_rings({"r": {"a": [4.0]}})            # one held -> blocked
    assert not tr._gates_pass(prof.triggers[0])
    tr.set_register_rings({"r": {"a": [4.0, 4.0]}})       # two held -> passes
    assert tr._gates_pass(prof.triggers[0])


def test_gate_on_distinct_value_count():
    # distinct counts UNIQUE non-blank values -> "the key has seen 2+ different values" (unstable).
    g = _gate("gd", "register:r#a@distinct", ("gte", "2"), targets=["t"])
    prof = GameProfile(name="g", gates=[g],
                       triggers=[TriggerDef(id="t", kind="on_register", register_watch=["r"])])
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


def test_gated_producer_target_dropped_from_resolve_fire():
    # a gate over a non-trigger kind (producer) blocks it at the same _resolve_fire choke point.
    g = _gate("gb", "register:r#a", ("lt", "3"), targets=["producer_x"])
    prof = GameProfile(
        name="g", gates=[g],
        triggers=[TriggerDef(id="t", kind="interval", targets=["producer_x", "bob"])],
        sounds=[SoundDef(id="bob")],
    )
    tr = _runner(prof)
    tr.set_registers({"r": {"a": 99}})     # 99 not < 3 -> gate blocks producer_x
    assert tr._resolve_fire(prof.triggers[0]) == ([], ["bob"])
    tr.set_registers({"r": {"a": 1}})      # 1 < 3 -> gate passes
    assert tr._resolve_fire(prof.triggers[0]) == (["producer_x"], ["bob"])


def test_gated_router_forwards_nothing_while_blocked():
    g = _gate("gb", "register:r#a", ("lt", "3"), targets=["rt"])
    prof = GameProfile(
        name="g", gates=[g],
        routers=[RouterDef(id="rt", source="register:r2#frame", branches=[
            RouterBranch(conds=[], targets=["px"])])],
        triggers=[TriggerDef(id="t", kind="interval", targets=["rt"])],
    )
    tr = _runner(prof)
    tr.set_registers({"r": {"a": 99}, "r2": {"frame": "x"}})   # gate blocks the router
    assert tr._resolve_fire(prof.triggers[0]) == ([], [])
    tr.set_registers({"r": {"a": 1}, "r2": {"frame": "x"}})    # gate passes -> router forwards
    assert tr._resolve_fire(prof.triggers[0]) == (["px"], [])


# ---- manual fire (via _emit_fire) bypasses gates -------------------------------------------------

def test_gated_ids_reports_currently_blocked_nodes():
    # the live 'gated off' cue: gated_ids lists prefixed node ids currently blocked by a gate.
    g = _gate("gb", "register:r#a", ("lt", "3"), targets=["t"])
    prof = GameProfile(name="g", gates=[g], triggers=[
        TriggerDef(id="t", kind="on_register", register_watch=["r"]),
        TriggerDef(id="u", kind="interval"),                       # no gate names it -> never gated
    ])
    tr = _runner(prof)
    tr.set_registers({"r": {"a": 99}})     # 99 not < 3 -> t is blocked
    assert tr.gated_ids() == ["trigger:t"]
    tr.set_registers({"r": {"a": 1}})      # 1 < 3 -> t passes
    assert tr.gated_ids() == []


def test_emit_gate_flow_only_on_flip():
    # The source->gate data blob fires only when the decision flips; the gate->target hop is NOT a
    # blob anymore (the line is tinted ok/danger by gate_states instead), so no watch blob is emitted.
    import oc.store.flow_events as fl
    blobs = []
    off = fl.subscribe(lambda game, kind, src, dst, n: blobs.append((kind, src, dst)))
    try:
        g = _gate("gb", "register:reg#a", ("lt", "3"), targets=["t"])
        prof = GameProfile(name="g", gates=[g], triggers=[
            TriggerDef(id="t", kind="on_register", register_watch=["reg"])])
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
        assert not any(kind == "watch" for kind, *_ in blobs)   # no gate->target blob
    finally:
        off()


def test_gate_states_reports_pass_block():
    g = _gate("gb", "register:reg#a", ("lt", "3"), targets=["t"])
    prof = GameProfile(name="g", gates=[g], triggers=[
        TriggerDef(id="t", kind="on_register", register_watch=["reg"])])
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
    g = _gate("gb", "register:r#a", ("lt", "3"), targets=["t"])
    prof = GameProfile(name="g", gates=[g],
                       triggers=[TriggerDef(id="t", kind="on_register", register_watch=["r"])])
    fired = []
    tr = TriggerRunner(prof, tempfile.gettempdir(),
                       fire=lambda pn, items: fired.append(pn.id), clock=lambda: 0.0)
    tr.set_registers({"r": {"a": 99}})                    # gate would BLOCK (99 not < 3)
    assert tr._route_fire(prof.triggers[0], "auto", items=None) is False   # gated
    assert tr._emit_fire(prof.triggers[0], "manual", items=None) is True   # manual bypasses


# ---- satellite-log rings: gate flip / router route-change / sound play / action run ------------

def test_emit_gate_flow_writes_gate_history_on_flip():
    from oc.collect import gate_history
    g = _gate("gb", "register:reg#a", ("lt", "3"), targets=["t"])
    prof = GameProfile(name="test_gate_hist", gates=[g], triggers=[
        TriggerDef(id="t", kind="on_register", register_watch=["reg"])])
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


# ---- dataset content-signature source: `changed` gate dedups a re-firing trigger -----------------

def test_dataset_sig_stable_across_bookkeeping_only_writes(tmp_path):
    # Re-recording the SAME authored values must not move the signature, even though the store's
    # plumbing (last_seen/_count/_batch) changes on every write -- that's the whole point of
    # stripping _PLUMBING before hashing.
    ds = DatasetStore(tmp_path, "g", "items")
    ds.begin_batch(); ds.record_seen({"name": "Soma Prime"}); ds.save()
    tr = TriggerRunner(GameProfile(name="g", datasets=[DatasetDef(id="items")]), tmp_path,
                       clock=lambda: 0.0)
    sig1 = tr._dataset_sig("items")
    assert sig1 is not None
    ds.begin_batch(); ds.record_seen({"name": "Soma Prime"}); ds.save()   # identical re-observation
    assert tr._dataset_sig("items") == sig1
    ds.begin_batch(); ds.record_seen({"name": "Volt Prime"}); ds.save()   # new row -> content differs
    assert tr._dataset_sig("items") != sig1


def test_dataset_gate_changed_blocks_until_content_moves(tmp_path):
    ds = DatasetStore(tmp_path, "g", "items")
    ds.begin_batch(); ds.record_seen({"name": "Soma Prime"}); ds.save()
    g = _gate("gd", "dataset:items", ("changed", ""), targets=["t"])
    prof = GameProfile(name="g", datasets=[DatasetDef(id="items")], gates=[g],
                       triggers=[TriggerDef(id="t", kind="on_register", register_watch=["r"])])
    tr = TriggerRunner(prof, tmp_path, clock=lambda: 0.0)
    # first evaluation: no baseline yet -> "changed" holds (None -> hash) -> fires, baseline set.
    assert tr._route_fire(prof.triggers[0], "auto", items=None) is True
    # unchanged dataset -> the gate now blocks a second attempt.
    assert tr._route_fire(prof.triggers[0], "auto", items=None) is False
    # dataset content changes -> the gate passes again.
    ds.begin_batch(); ds.record_seen({"name": "Volt Prime"}); ds.save()
    assert tr._route_fire(prof.triggers[0], "auto", items=None) is True


def test_subset_gate_changed_blocks_until_visible_output_moves(tmp_path):
    ds = DatasetStore(tmp_path, "g", "items")
    ds.begin_batch(); ds.record_seen({"name": "Soma Prime", "updated": "t1"}); ds.save()
    sub = SubsetDef(id="view", sources=[JoinSource(dataset="items")], hidden_columns=["updated"])
    g = _gate("gd", "subset:view", ("changed", ""), targets=["t"])
    prof = GameProfile(name="g", datasets=[DatasetDef(id="items")], subsets=[sub], gates=[g],
                       triggers=[TriggerDef(id="t", kind="on_register", register_watch=["r"])])
    tr = TriggerRunner(prof, tmp_path, clock=lambda: 0.0)
    # first evaluation: no baseline yet -> fires, baseline set.
    assert tr._route_fire(prof.triggers[0], "auto", items=None) is True
    # only the HIDDEN `updated` timestamp changes -> visible output is identical -> blocked.
    ds.begin_batch(); ds.record_seen({"name": "Soma Prime", "updated": "t2"}); ds.save()
    assert tr._route_fire(prof.triggers[0], "auto", items=None) is False
    # a visible field changes -> the gate passes again.
    ds.begin_batch(); ds.record_seen({"name": "Volt Prime", "updated": "t2"}); ds.save()
    assert tr._route_fire(prof.triggers[0], "auto", items=None) is True


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
