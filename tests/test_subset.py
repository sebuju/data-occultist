"""Subset compute + profile round-trip."""

from oc.profile.loader import load_profile, save_profile
from oc.profile.models import (
    DerivedColumn, EnrichRule, FilterRule, GameProfile, SubsetDef,
)
from oc.enrich.subset import compute_subset, compute_view


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


def test_text_filter_ops():
    sub = SubsetDef(id="v", dataset="d", filters=[FilterRule(field="name", op="icontains", value="a")])
    keys = {row["name"] for row in compute_subset(_records(), sub)["rows"]}
    assert keys == {"Amesha", "Vitality"}                # both contain 'a'/'A'


def test_view_joins_datasets_on_key_with_arithmetic_derived():
    inv = [{"name": "Acceltra Prime", "count": 2, "present": True},
           {"name": "Junk", "count": 5, "present": True}]
    prices = [{"name": "Acceltra Prime", "slug": "acceltra_prime_set", "price_median": 48}]
    sub = SubsetDef(id="folio", datasets=["master", "prices"], join_field="name",
                    derived=[DerivedColumn(name="value", template="={count}*{price_median}")],
                    sort_by="value", sort_desc=True)
    out = compute_view([("master", inv), ("prices", prices)], sub)
    rows = {r["name"]: r for r in out["rows"]}
    assert rows["Acceltra Prime"]["value"] == 96          # 2 * 48, joined from prices
    assert rows["Junk"]["value"] == ""                    # no price -> empty arithmetic
    assert out["rows"][0]["name"] == "Acceltra Prime"     # priced row sorts above blank on desc
    assert "price_median" in out["columns"]               # columns unioned across datasets


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
