"""Relic-contents enricher: table build, reward formatting, and live-safe wiring.

All offline — the network fetchers are injected, so no HTTP and no GPU/game needed.
"""

import pytest

from oc.enrich import relic
from oc.enrich.subset import compute_view
from oc.profile.models import EnrichRule, SubsetDef

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


@pytest.fixture
def built_table(tmp_path, monkeypatch):
    """Build the relic table from the fixture into a temp cache and reset module state."""
    monkeypatch.setattr(relic, "_cache_path", lambda: tmp_path / "relic_table.json")
    monkeypatch.setattr(relic, "_cache", None, raising=False)
    monkeypatch.setattr(relic, "_cache_mtime", None, raising=False)
    relic.build_relic_table(
        force=True, fetch_relics=lambda: _RAW,
        fetch_ducats=lambda slug: _DUCATS.get(slug))
    return tmp_path


def test_build_skips_relicless_and_keys_by_display_name(built_table):
    table = relic._load()
    assert list(table) == ["AXI A1"]            # Requiem entry (no relicName) dropped
    assert set(table["AXI A1"]) == {"Intact", "Radiant"}


def test_enrich_default_intact_with_rarity_chance_ducats(built_table):
    out = relic.RelicContentsEnricher(source_field="name").enrich({"name": "Axi A1"})
    assert out["relic_contents"] == "3"
    # untradeable Forma falls back to 0 ducats; real parts get market ducats
    assert "Forma Blueprint (Common, 25.33%, 0d)" in out["relic_rewards"]
    assert "Akstiletto Prime Barrel (Uncommon, 11%, 25d)" in out["relic_rewards"]


def test_name_normalisation_matches_noisy_ocr(built_table):
    out = relic.RelicContentsEnricher().enrich({"name": "axi a1 relic"})
    assert out["relic_contents"] == "3"


def test_state_knob_selects_radiant(built_table):
    out = relic.RelicContentsEnricher(state="Radiant").enrich({"name": "Axi A1"})
    assert out["relic_contents"] == "1"
    assert "Nikana Prime Blueprint (Rare, 10%, 15d)" == out["relic_rewards"]


def test_unknown_relic_returns_empty(built_table):
    assert relic.RelicContentsEnricher().enrich({"name": "Lith Z9"}) == {}


def test_missing_cache_degrades_without_blocking(tmp_path, monkeypatch):
    monkeypatch.setattr(relic, "_cache_path", lambda: tmp_path / "absent.json")
    monkeypatch.setattr(relic, "_cache", None, raising=False)
    monkeypatch.setattr(relic, "_ensure_built", lambda: None)   # don't spawn a build thread
    out = relic.RelicContentsEnricher().enrich({"name": "Axi A1"})
    assert out == {"relic_contents": "(no data yet)", "relic_rewards": ""}


def test_compute_view_runs_live_safe_skips_network(built_table):
    sub = SubsetDef(
        id="t", datasets=["relics_offered"], join_field="name",
        enrich=[
            EnrichRule(id="r", type="relic_contents", source_field="name", enabled=True),
            EnrichRule(id="m", type="warframe_market", source_field="name", enabled=True),
        ])
    view = compute_view([("relics_offered", [{"name": "Axi A1"}])], sub)
    assert "relic_rewards" in view["columns"]
    row = view["rows"][0]
    assert row["relic_contents"] == "3"
    # the network enricher must NOT run inside the live view
    assert not any(k.startswith("wm_") for k in row)
