"""Relic-rewards producer: table build, row flattening, and the producer write path.

All offline — the network fetchers are injected/monkeypatched, so no HTTP and no GPU/game
needed.
"""

from oc.enrich import relic
from oc.interfaces import ProducerCtx
from oc.profile.models import ProducerDef
from oc.store import KeySpec, store_for

# The relic producer keys (name, item, state); write and read must agree (in production this
# comes from the dataset's key_map_for) so a re-keyed read doesn't collapse rows.
_KEY = KeySpec(fields=("name", "item", "state"))

_RAW = {"relics": [
    {"tier": "Axi", "relicName": "A1", "state": "Intact", "rewards": [
        {"itemName": "Akstiletto Prime Barrel", "rarity": "Uncommon", "chance": 11},
        {"itemName": "Forma Blueprint", "rarity": "Common", "chance": 25.33},
        {"itemName": "Nikana Prime Blueprint", "rarity": "Rare", "chance": 2}]},
    {"tier": "Axi", "relicName": "A1", "state": "Radiant", "rewards": [
        {"itemName": "Nikana Prime Blueprint", "rarity": "Rare", "chance": 10}]},
    {"tier": "Requiem", "relicName": None, "state": "Intact", "rewards": []},  # skipped
]}

_DUCATS = {"akstiletto_prime_barrel": 25, "nikana_prime_blueprint": 15}


def _build():
    return relic.build_relic_table(
        fetch_relics=lambda: _RAW, fetch_ducats=lambda slug: _DUCATS.get(slug))


def test_build_skips_relicless_and_keys_by_display_name():
    table = _build()
    assert list(table) == ["AXI A1"]            # Requiem entry (no relicName) dropped
    assert set(table["AXI A1"]) == {"Intact", "Radiant"}


def test_reward_rows_flatten_per_relic_reward_state():
    rows = relic.relic_reward_rows(_build())
    # 3 Intact rewards + 1 Radiant reward = 4 rows; name is the RELIC, item is the reward
    assert len(rows) == 4
    intact = {r["item"]: r for r in rows if r["state"] == "Intact"}
    assert intact["Akstiletto Prime Barrel"] == {
        "name": "AXI A1", "item": "Akstiletto Prime Barrel", "rarity": "Uncommon",
        "chance": 11, "ducats": 25, "state": "Intact"}
    # untradeable Forma falls back to 0 ducats
    assert intact["Forma Blueprint"]["ducats"] == 0
    # same reward in a different state is its OWN row
    radiant = [r for r in rows if r["state"] == "Radiant"]
    assert radiant == [{"name": "AXI A1", "item": "Nikana Prime Blueprint", "rarity": "Rare",
                        "chance": 10, "ducats": 15, "state": "Radiant"}]


def test_producer_writes_keyed_rows_to_dataset(tmp_path, monkeypatch):
    # the producer's run() builds via the module fetchers, so patch those (not build args)
    monkeypatch.setattr(relic, "_fetch_relics_json", lambda: _RAW)
    monkeypatch.setattr(relic, "fetch_item_ducats", lambda slug: _DUCATS.get(slug))

    node = ProducerDef(id="relic_rewards", type="relic", dataset="relic_rewards", throttle=0)
    summary = relic.RelicProducer().run(ProducerCtx(
        data_dir=str(tmp_path), game="warframe", node=node, dataset="relic_rewards", key=_KEY))
    assert summary["fetched"] == 4

    rows = store_for(str(tmp_path), "warframe", "relic_rewards", key=_KEY).records()
    keys = {(r["name"], r["item"], r["state"]) for r in rows}
    assert ("AXI A1", "Nikana Prime Blueprint", "Intact") in keys
    assert ("AXI A1", "Nikana Prime Blueprint", "Radiant") in keys   # state keeps them distinct
    assert len(rows) == 4


def test_producer_cancel_stops_ducat_resolution(tmp_path, monkeypatch):
    monkeypatch.setattr(relic, "_fetch_relics_json", lambda: _RAW)
    monkeypatch.setattr(relic, "fetch_item_ducats", lambda slug: _DUCATS.get(slug))

    node = ProducerDef(id="relic_rewards", type="relic", dataset="relic_rewards", throttle=0)
    # cancelled from the start -> the table is incomplete, so NOTHING is written (don't pollute
    # the dataset with a half-fetched table) and the summary reports nothing fetched.
    summary = relic.RelicProducer().run(ProducerCtx(
        data_dir=str(tmp_path), game="warframe", node=node, dataset="relic_rewards",
        key=_KEY, should_stop=lambda: True))
    assert summary["fetched"] == 0
    rows = store_for(str(tmp_path), "warframe", "relic_rewards", key=_KEY).records()
    assert rows == []
