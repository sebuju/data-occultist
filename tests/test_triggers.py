"""Trigger runner + price-node item sourcing — pure logic, no network.

``TriggerRunner`` scheduling (interval due / on_change for changed keys only) is tested with
an injected clock and a captured ``fire``. ``gather_source_items`` is tested against a real
DatasetStore with a stubbed name->slug resolver.
"""

from oc import eventlog
from oc.collect.triggers import TriggerRunner
from oc.enrich.price_runner import gather_source_items
from oc.profile.models import GameProfile, PriceNodeDef, TriggerDef
from oc.store import DatasetStore, KeySpec


def _profile():
    return GameProfile(
        name="g",
        price_nodes=[
            PriceNodeDef(id="live", dataset="prices_live", mode="orders", sources=["master"]),
            PriceNodeDef(id="relic", dataset="prices_relic", mode="orders", sources=["relic_rewards"]),
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
    tr._resolve = lambda n: n.lower().replace(" ", "_")     # stub slug resolver (no network)

    assert tr.on_change("master", [{"name": "x"}]) == []    # no on_change trigger watches master
    changed = [{"name": "Soma Prime"}, {"name": "Volt Prime"}]
    assert tr.on_change("relic_rewards", changed) == ["relicwatch"]
    assert calls == [("relic", [("soma_prime", "Soma Prime"), ("volt_prime", "Volt Prime")])]


def test_on_change_ignores_empty_and_disabled():
    profile = _profile()
    profile.triggers[1].enabled = False
    clock = [0.0]
    tr, calls = _runner(profile, clock)
    tr._resolve = lambda n: n
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
        tr._resolve = lambda n: n.lower().replace(" ", "_")
        tr.on_change("relic_rewards", [{"name": "Soma Prime"}])
        clock[0] = 1100.0
        tr.tick()
    finally:
        off()
    msgs = [e["msg"] for e in lines]
    assert any("relicwatch <- relic_rewards changed" in m for m in msgs)
    assert any("periodic fired (interval" in m for m in msgs)
    assert all(e["game"] == "g" for e in lines)   # scoped to the profile's game


def test_gather_source_items_from_dataset(tmp_path):
    ds = DatasetStore(tmp_path, "g", "master", key=KeySpec(fields=("name",)))
    ds.begin_batch()
    for name in ("Soma Prime", "Soma Prime", "Volt Prime"):   # dup name -> one slug
        ds.record_seen({"name": name})
    ds.save()

    items = gather_source_items(tmp_path, "g", _profile(), ["master"],
                                resolve=lambda n: n.lower().replace(" ", "_"))
    assert items == [("soma_prime", "Soma Prime"), ("volt_prime", "Volt Prime")]
