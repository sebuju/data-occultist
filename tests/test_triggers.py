"""Trigger runner + price-node item sourcing — pure logic, no network.

``TriggerRunner`` scheduling (interval due / on_change for changed keys only) is tested with
an injected clock and a captured ``fire``. ``gather_source_names`` is tested against a real
DatasetStore (the producer applies its own key transform, so this yields raw item names).
"""

from oc import eventlog
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


def test_on_change_ignores_empty_and_disabled():
    profile = _profile()
    profile.triggers[1].enabled = False
    clock = [0.0]
    tr, calls = _runner(profile, clock)
    assert tr.on_change("relic_rewards", [{"name": "x"}]) == []   # disabled
    assert tr.on_change("relic_rewards", []) == []               # nothing changed
    assert calls == []


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
    assert any("relicwatch <- relic_rewards changed" in m for m in msgs)
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


def test_gather_source_names_from_dataset(tmp_path):
    ds = DatasetStore(tmp_path, "g", "master", key=KeySpec(fields=("name",)))
    ds.begin_batch()
    for name in ("Soma Prime", "Soma Prime", "Volt Prime"):   # dup name -> one entry
        ds.record_seen({"name": name})
    ds.save()

    names = gather_source_names(tmp_path, "g", _profile(), ["master"])
    assert names == ["Soma Prime", "Volt Prime"]
