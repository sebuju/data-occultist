"""Trigger runner + price-node item sourcing — pure logic, no network.

``TriggerRunner`` scheduling (interval due / on_change for changed keys only) is tested with
an injected clock and a captured ``fire``. ``gather_source_names`` is tested against a real
DatasetStore (the producer applies its own key transform, so this yields raw item names).
"""

import json
from datetime import datetime, timedelta, timezone

from oc import eventlog
from oc.collect import trigger_history
from oc.collect.triggers import TriggerRunner, read_subset_sigs
from oc.enrich.http_producer import gather_source_names
from oc.profile.models import GameProfile, JoinSource, ProducerDef, SoundDef, SubsetDef, TriggerDef
from oc.store import DatasetStore, KeySpec


def _profile():
    return GameProfile(
        name="g",
        producers=[
            ProducerDef(id="live", dataset="prices_live", mode="orders", sources=["master"]),
            ProducerDef(id="relic", dataset="prices_relic", mode="orders", sources=["relic_rewards"]),
        ],
        triggers=[
            TriggerDef(id="periodic", kind="interval", interval_s=60, targets=["live"]),
            TriggerDef(id="relicwatch", kind="on_change", watch=["relic_rewards"], targets=["relic"]),
        ],
    )


def _runner(profile, clock):
    calls = []
    tr = TriggerRunner(profile, "data", fire=lambda pn, items: calls.append((pn.id, items)), clock=lambda: clock[0])
    return tr, calls


def test_interval_fires_only_when_due():
    clock = [1000.0]
    tr, calls = _runner(_profile(), clock)
    assert tr.tick() == []                  # seeded to "now" -> not due immediately
    clock[0] = 1059.0
    assert tr.tick() == []                  # 59s < 60s
    clock[0] = 1061.0
    assert tr.tick() == ["periodic"]        # elapsed -> fires
    assert calls == [("live", None)]        # interval fire prices the node's own sources
    clock[0] = 1100.0
    assert tr.tick() == []                  # last-fire reset -> not due again yet


def test_on_change_fires_targets_for_changed_keys_only():
    clock = [0.0]
    tr, calls = _runner(_profile(), clock)

    assert tr.on_change("master", [{"name": "x"}]) == []    # no on_change trigger watches master
    changed = [{"name": "Soma Prime"}, {"name": "Volt Prime"}]
    assert tr.on_change("relic_rewards", changed) == ["relicwatch"]
    # items are raw changed names — the producer applies its own key transform
    assert calls == [("relic", ["Soma Prime", "Volt Prime"])]


def test_on_change_ignores_disabled():
    profile = _profile()
    profile.triggers[1].enabled = False
    clock = [0.0]
    tr, calls = _runner(profile, clock)
    assert tr.on_change("relic_rewards", [{"name": "x"}]) == []   # disabled
    assert tr.on_change("relic_rewards", []) == []               # disabled: no fire even on a clear
    assert calls == []


def test_on_change_fires_on_clear_but_prices_nothing():
    # a clear / removal announces empty records: the watched data DID change, so a direct watch
    # fires (last_fired updates), but there is nothing to price -> the producer sweep is skipped
    # (firing it with no items would price the whole dataset).
    clock = [0.0]
    tr, calls = _runner(_profile(), clock)
    assert tr.on_change("relic_rewards", []) == ["relicwatch"]
    assert calls == []


# ---- true_interval: real elapsed time off the PERSISTED last-fire ----------

def _ti_profile():
    return GameProfile(
        name="g",
        producers=[ProducerDef(id="live", dataset="prices_live", mode="orders", sources=["master"])],
        triggers=[TriggerDef(id="ti", kind="true_interval", interval_s=100, targets=["live"])],
    )


def test_true_interval_due_uses_persisted_time(tmp_path):
    p = _ti_profile()
    now = datetime(2026, 7, 7, 12, 0, 0, tzinfo=timezone.utc)
    tr = TriggerRunner(p, tmp_path, clock=lambda: 0.0, wall=lambda: now)
    t = p.triggers[0]
    assert tr._true_interval_due(t, None) is True                                     # never fired -> due
    assert tr._true_interval_due(t, (now - timedelta(seconds=50)).isoformat()) is False   # 50s < 100s
    assert tr._true_interval_due(t, (now - timedelta(seconds=150)).isoformat()) is True    # overdue


def test_true_interval_fires_when_overdue_after_restart(tmp_path):
    # a freshly built runner (simulating a restart) reads the persisted last-fire and fires
    # immediately when the real interval has already elapsed — cadence survives the restart.
    p = _ti_profile()
    (tmp_path / "g").mkdir()
    now = datetime(2026, 7, 7, 12, 0, 0, tzinfo=timezone.utc)
    (tmp_path / "g" / ".trigger_fires.json").write_text(
        json.dumps({"ti": (now - timedelta(seconds=200)).isoformat()}), encoding="utf-8")
    calls = []
    tr = TriggerRunner(p, tmp_path, fire=lambda pn, items: calls.append(pn.id),
                       clock=lambda: 0.0, wall=lambda: now)
    assert tr.tick() == ["ti"]
    assert calls == ["live"]


# ---- throttle: minimum ms between fires, suppressed fires go to history ------

def test_throttle_suppresses_within_window_and_records(tmp_path):
    trigger_history.clear("g")
    p = _profile()
    p.triggers[1].throttle_ms = 5000   # relicwatch: 5s between fires
    clock = [0.0]
    tr = TriggerRunner(p, tmp_path, fire=lambda pn, items: None, clock=lambda: clock[0])
    assert tr.on_change("relic_rewards", [{"name": "A"}]) == ["relicwatch"]
    clock[0] = 1.0
    assert tr.on_change("relic_rewards", [{"name": "B"}]) == []          # inside 5s window -> suppressed
    clock[0] = 10.0
    assert tr.on_change("relic_rewards", [{"name": "C"}]) == ["relicwatch"]   # window elapsed -> fires
    hist = trigger_history.recent("g", "relicwatch")
    assert [h["throttled"] for h in hist] == [False, True, False]        # newest first: fire, throttled, fire


def test_history_records_why_and_targets(tmp_path):
    trigger_history.clear("g")
    p = _profile()
    clock = [0.0]
    tr = TriggerRunner(p, tmp_path, fire=lambda pn, items: None, clock=lambda: clock[0])
    tr.on_change("relic_rewards", [{"name": "A"}])
    hist = trigger_history.recent("g", "relicwatch")
    assert len(hist) == 1 and hist[0]["throttled"] is False
    assert "relic_rewards changed" in hist[0]["why"]
    assert hist[0]["targets"] == ["relic"]


# ---- settle: trailing-edge debounce, coalesce a burst into one fire ----------

class _FakeTimer:
    """A settle timer that never auto-fires — tests drive ``_settle_flush`` themselves so the
    debounce is deterministic without sleeping on a real thread."""

    def __init__(self, secs, fn, args=None):
        self.secs, self.fn, self.args = secs, fn, args or []

    def start(self):
        pass

    def cancel(self):
        pass


def _settle_runner(profile, clock):
    calls = []
    tr = TriggerRunner(profile, "data", fire=lambda pn, items: calls.append((pn.id, items)),
                       clock=lambda: clock[0], timer_factory=_FakeTimer)
    return tr, calls


def test_settle_coalesces_burst_into_one_fire_with_last_items():
    p = _profile()
    p.triggers[1].settle_ms = 1000        # relicwatch: wait 1s of quiet, then fire once
    clock = [0.0]
    tr, calls = _settle_runner(p, clock)
    # three justified changes inside the window -> all DEFERRED (no fire, not in the fired list)
    assert tr.on_change("relic_rewards", [{"name": "A"}]) == []
    clock[0] = 0.3
    assert tr.on_change("relic_rewards", [{"name": "B"}]) == []
    clock[0] = 0.6
    assert tr.on_change("relic_rewards", [{"name": "C"}]) == []
    assert calls == []                    # nothing fired yet — still settling
    tr._settle_flush("relicwatch")        # window went quiet
    assert calls == [("relic", ["C"])]    # fired ONCE, carrying the LAST state


def test_settle_max_forces_fire_when_never_quiet():
    p = _profile()
    p.triggers[1].settle_ms = 1000
    p.triggers[1].settle_max_ms = 5000    # fire anyway 5s after the window opened
    clock = [0.0]
    tr, calls = _settle_runner(p, clock)
    assert tr.on_change("relic_rewards", [{"name": "A"}]) == []   # opens the window at t=0
    clock[0] = 3.0
    assert tr.on_change("relic_rewards", [{"name": "B"}]) == []   # still under the 5s cap
    assert calls == []
    clock[0] = 5.1                                                # past the deadline
    assert tr.on_change("relic_rewards", [{"name": "C"}]) == []   # route returns deferred...
    assert calls == [("relic", ["C"])]                           # ...but the deadline fired it now


def test_settle_unset_fires_immediately():
    # settle_ms unset -> today's behaviour: on_change fires synchronously.
    p = _profile()
    clock = [0.0]
    tr, calls = _settle_runner(p, clock)
    assert tr.on_change("relic_rewards", [{"name": "A"}]) == ["relicwatch"]
    assert calls == [("relic", ["A"])]


def test_settle_still_honours_throttle_at_the_settled_fire():
    trigger_history.clear("g")
    p = _profile()
    p.triggers[1].settle_ms = 1000
    p.triggers[1].throttle_ms = 5000      # at most one fire per 5s, applied at the settled fire
    clock = [0.0]
    tr, calls = _settle_runner(p, clock)
    tr.on_change("relic_rewards", [{"name": "A"}])
    tr._settle_flush("relicwatch")        # fires at t=0
    clock[0] = 1.0
    tr.on_change("relic_rewards", [{"name": "B"}])
    tr._settle_flush("relicwatch")        # inside the 5s throttle window -> suppressed
    assert calls == [("relic", ["A"])]    # only the first settled fire got through


def test_triggers_publish_activity_log_lines():
    # every watch+fire and interval fire emits a log-bar line via the eventlog bus
    lines = []
    off = eventlog.subscribe(lambda ev: lines.append(ev))
    try:
        clock = [1000.0]
        tr, _ = _runner(_profile(), clock)
        tr.on_change("relic_rewards", [{"name": "Soma Prime"}])
        clock[0] = 1100.0
        tr.tick()
    finally:
        off()
    msgs = [e["msg"] for e in lines]
    assert any("relicwatch fired (relic_rewards changed" in m for m in msgs)
    assert any("periodic fired (interval" in m for m in msgs)
    assert all(e["game"] == "g" for e in lines)   # scoped to the profile's game


def test_sound_node_defaults_and_roundtrips():
    # a sound node the web UI plays on fire — a trigger names its id in `targets`. Defaults to a
    # silent, full-volume node; survives dump/reload.
    assert SoundDef(id="s").file == ""
    assert SoundDef(id="s").volume == 1.0
    p = GameProfile(name="g",
                    triggers=[TriggerDef(id="t", targets=["chime"])],
                    sounds=[SoundDef(id="chime", file="chirp.wav", volume=0.4)])
    reloaded = GameProfile.model_validate(p.model_dump())
    assert reloaded.sounds[0].file == "chirp.wav"
    assert reloaded.sounds[0].volume == 0.4
    assert reloaded.triggers[0].targets == ["chime"]
    # sound/volume are gone from the trigger itself
    assert not hasattr(reloaded.triggers[0], "sound")


def test_generated_synth_cue_roundtrips():
    # a GENERATED cue: instead of a file, the sound node carries a synth spec (wave + pitch-over-
    # time points + shape knobs). File stays "". Survives dump/reload with its points intact.
    from oc.profile.models import SynthDef, SynthPoint
    syn = SynthDef(points=[SynthPoint(t=0.0, p=0.5), SynthPoint(t=1.0, p=0.9)],
                   length_ms=300, crush=20)
    p = GameProfile(name="g", sounds=[SoundDef(id="pickup", synth=syn, volume=0.7)])
    reloaded = GameProfile.model_validate(p.model_dump())
    s = reloaded.sounds[0]
    assert s.file == "" and s.synth is not None
    assert s.synth.wave == "square" and s.synth.length_ms == 300 and s.synth.crush == 20
    assert [(pt.t, pt.p) for pt in s.synth.points] == [(0.0, 0.5), (1.0, 0.9)]
    # a plain file node still has no synth
    assert SoundDef(id="f", file="ping.wav").synth is None


def _join_profile():
    # a trigger watching a SUBSET that inner-joins inventory + prices on name. `updated` is a
    # volatile timestamp the view HIDES — rewritten every price refresh but not user-visible.
    return GameProfile(
        name="g",
        producers=[ProducerDef(id="px", dataset="prices_out", mode="orders", sources=["folio"])],
        subsets=[SubsetDef(id="folio", sources=[
            JoinSource(dataset="inv", join_field="name", required=True),
            JoinSource(dataset="prices", join_field="name", required=True),
        ], hidden_columns=["updated"])],
        triggers=[TriggerDef(id="watch", kind="on_change", watch=["folio"], targets=["px"])],
    )


def _ds(tmp_path, name):
    return DatasetStore(tmp_path, "g", name, key=KeySpec(fields=("name",)))


def test_on_change_subset_fires_only_when_joined_output_changes(tmp_path):
    # inventory holds Soma Prime; prices initially has Soma Prime @ 10
    inv = _ds(tmp_path, "inv")
    inv.begin_batch(); inv.record_seen({"name": "Soma Prime", "count": 2}); inv.save()
    prices = _ds(tmp_path, "prices")
    prices.begin_batch(); prices.record_seen({"name": "Soma Prime", "price": 10, "updated": "t1"}); prices.save()

    calls = []
    tr = TriggerRunner(_join_profile(), tmp_path,
                       fire=lambda pn, items: calls.append(pn.id), clock=lambda: 0.0)

    # first change -> no baseline sig yet -> fires once and records the baseline
    assert tr.on_change("prices", [{"name": "Soma Prime", "price": 10}]) == ["watch"]
    assert read_subset_sigs(tmp_path, "g")  # baseline persisted

    # a price for an item NOT in inventory -> inner join drops it -> joined output unchanged
    prices.begin_batch(); prices.record_seen({"name": "Dagger", "price": 5}); prices.save()
    assert tr.on_change("prices", [{"name": "Dagger", "price": 5}]) == []   # must NOT fire

    # only the HIDDEN `updated` timestamp changes (a price refresh) -> visible output identical
    # -> must NOT fire (regression: hashing full row dicts fired here every few seconds)
    prices.begin_batch(); prices.record_seen({"name": "Soma Prime", "updated": "t2"}); prices.save()
    assert tr.on_change("prices", [{"name": "Soma Prime", "updated": "t2"}]) == []

    # the watched item's VISIBLE price actually changes -> joined row changes -> fires
    prices.begin_batch(); prices.record_seen({"name": "Soma Prime", "price": 20}); prices.save()
    assert tr.on_change("prices", [{"name": "Soma Prime", "price": 20}]) == ["watch"]

    assert calls == ["px", "px"]   # fired twice total (baseline + real change), not on the no-ops


def test_on_any_change_subset_fires_even_when_joined_output_unchanged(tmp_path):
    # same join as test_on_change_subset_fires_only_when_joined_output_changes, but with
    # kind="on_any_change" — every write reaching the subset must fire, including the two
    # cases that on_change correctly suppresses (irrelevant row, hidden-column-only change).
    inv = _ds(tmp_path, "inv")
    inv.begin_batch(); inv.record_seen({"name": "Soma Prime", "count": 2}); inv.save()
    prices = _ds(tmp_path, "prices")
    prices.begin_batch(); prices.record_seen({"name": "Soma Prime", "price": 10, "updated": "t1"}); prices.save()

    profile = _join_profile()
    profile.triggers[0].kind = "on_any_change"
    calls = []
    tr = TriggerRunner(profile, tmp_path,
                       fire=lambda pn, items: calls.append(pn.id), clock=lambda: 0.0)

    assert tr.on_change("prices", [{"name": "Soma Prime", "price": 10}]) == ["watch"]

    # a price for an item NOT in inventory -> on_change would drop this (join output unchanged)
    prices.begin_batch(); prices.record_seen({"name": "Dagger", "price": 5}); prices.save()
    assert tr.on_change("prices", [{"name": "Dagger", "price": 5}]) == ["watch"]

    # only the HIDDEN `updated` timestamp changes -> on_change would drop this too
    prices.begin_batch(); prices.record_seen({"name": "Soma Prime", "updated": "t2"}); prices.save()
    assert tr.on_change("prices", [{"name": "Soma Prime", "updated": "t2"}]) == ["watch"]

    assert calls == ["px", "px", "px"]
    assert not read_subset_sigs(tmp_path, "g")   # no sig bookkeeping needed for on_any_change

def _ready_profile():
    # on_ready watches a PRODUCER; it fires when that producer's sweep completes (on_sweep_done),
    # deterministically. No subset, no timers. `sink` is a second producer used as a capturable target.
    return GameProfile(
        name="g",
        producers=[ProducerDef(id="px", dataset="prices", mode="orders", sources=["inv"]),
                   ProducerDef(id="sink", dataset="out", mode="orders", sources=["inv"])],
        triggers=[TriggerDef(id="rdy", kind="on_ready", watch=["px"], targets=["sink"])],
    )


def test_on_ready_fires_on_watched_producer_completion(tmp_path):
    calls = []
    tr = TriggerRunner(_ready_profile(), tmp_path, fire=lambda pn, items: calls.append(pn.id),
                       clock=lambda: 0.0)
    assert tr.on_sweep_done("other") == []       # a DIFFERENT producer finished -> no fire
    assert calls == []
    assert tr.on_sweep_done("px") == ["rdy"]     # the WATCHED producer's sweep finished -> fire
    assert calls == ["sink"]                     # fires its target, once, deterministically


def test_on_ready_ignores_disabled(tmp_path):
    p = _ready_profile()
    p.triggers[0].enabled = False
    calls = []
    tr = TriggerRunner(p, tmp_path, fire=lambda pn, items: calls.append(pn.id), clock=lambda: 0.0)
    assert tr.on_sweep_done("px") == []
    assert calls == []


def test_on_ready_honours_throttle(tmp_path):
    trigger_history.clear("g")
    p = _ready_profile()
    p.triggers[0].throttle_ms = 5000
    clock = [0.0]
    tr = TriggerRunner(p, tmp_path, fire=lambda pn, items: None, clock=lambda: clock[0])
    assert tr.on_sweep_done("px") == ["rdy"]     # first completion fires
    clock[0] = 1.0
    assert tr.on_sweep_done("px") == []          # inside the 5s throttle window -> suppressed
    clock[0] = 10.0
    assert tr.on_sweep_done("px") == ["rdy"]     # window elapsed -> fires again


def test_gather_source_names_from_dataset(tmp_path):
    ds = DatasetStore(tmp_path, "g", "master", key=KeySpec(fields=("name",)))
    ds.begin_batch()
    for name in ("Soma Prime", "Soma Prime", "Volt Prime"):   # dup name -> one entry
        ds.record_seen({"name": name})
    ds.save()

    names = gather_source_names(tmp_path, "g", _profile(), ["master"])
    assert names == ["Soma Prime", "Volt Prime"]
