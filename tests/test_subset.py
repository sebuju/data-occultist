"""Subset compute + profile round-trip."""

from oc.profile.loader import load_profile, save_profile
from oc.profile.models import (
    DerivedColumn, EnrichRule, FilterRule, GameProfile, SubsetDef,
)
from oc.enrich.subset import compute_subset


def _records():
    return [
        {"name": "Amesha", "rank": "3", "present": True, "first_seen": "t"},
        {"name": "Vitality", "rank": "0", "present": True},
        {"name": "Bronco", "rank": "5", "present": True},
    ]


def test_filter_derive_sort_limit():
    sub = SubsetDef(
        id="arc", dataset="equip",
        filters=[FilterRule(field="rank", op="gte", value="1")],
        derived=[DerivedColumn(name="display", template="{name} [{rank}]")],
        sort_by="rank", sort_desc=True, limit=1,
    )
    r = compute_subset(_records(), sub)
    assert r["columns"] == ["name", "rank", "display"]   # bookkeeping cols hidden
    assert len(r["rows"]) == 1                            # limit
    assert r["rows"][0]["name"] == "Bronco"              # rank 5 sorts first
    assert r["rows"][0]["display"] == "Bronco [5]"
    assert r["enriched"] is False


def test_text_filter_ops():
    sub = SubsetDef(id="v", dataset="d", filters=[FilterRule(field="name", op="icontains", value="a")])
    keys = {row["name"] for row in compute_subset(_records(), sub)["rows"]}
    assert keys == {"Amesha", "Vitality"}                # both contain 'a'/'A'


def test_enrich_pass_runs_registered_enricher():
    from oc.registry import build_enricher
    sub = SubsetDef(id="r", dataset="d", enrich=[EnrichRule(type="relic_contents", source_field="name")])
    out = compute_subset(_records(), sub, run_enrich=True,
                         build=lambda rule: build_enricher(rule.type, source_field=rule.source_field))
    assert out["enriched"] is True
    assert "relic_contents" in out["columns"]


def test_subset_round_trips_through_profile(tmp_path):
    p = GameProfile(name="g", subsets=[SubsetDef(
        id="arc", dataset="equip",
        filters=[FilterRule(field="rank", op="gte", value="1")],
        derived=[DerivedColumn(name="display", template="{name} [{rank}]")],
        enrich=[EnrichRule(type="warframe_market", source_field="name")],
    )])
    save_profile(tmp_path, p)
    back = load_profile(tmp_path, "g")
    assert len(back.subsets) == 1
    s = back.subset_def("arc")
    assert s.dataset == "equip" and s.derived[0].template == "{name} [{rank}]"
    assert s.enrich[0].type == "warframe_market"
