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


def test_inline_math_mixes_static_text():
    inv = [{"name": "Acceltra Prime", "count": 2, "present": True},
           {"name": "Junk", "count": 5, "present": True}]
    prices = [{"name": "Acceltra Prime", "slug": "acceltra_prime_set", "price_median": 48}]
    sub = SubsetDef(id="folio", datasets=["master", "prices"], join_field="name",
                    derived=[DerivedColumn(name="worth", template="{=count*price_median} plat")])
    rows = {r["name"]: r for r in compute_view([("master", inv), ("prices", prices)], sub)["rows"]}
    assert rows["Acceltra Prime"]["worth"] == "96 plat"   # math evaluated, literal text kept
    assert rows["Junk"]["worth"] == " plat"               # missing operand -> empty math, text stays


def test_leading_equals_still_pure_math():
    inv = [{"name": "X", "count": 2, "present": True}]
    prices = [{"name": "X", "price_median": 48}]
    sub = SubsetDef(id="v", datasets=["m", "p"], join_field="name",
                    derived=[DerivedColumn(name="value", template="={count}*{price_median}")])
    rows = compute_view([("m", inv), ("p", prices)], sub)["rows"]
    assert rows[0]["value"] == 96                         # back-compat: numeric, not a string


def test_view_feeding_view_chains_derived_columns():
    # upstream view computes `value`; downstream view consumes its ROWS and derives from it,
    # mirroring how flow.py resolves a view input before the view that joins it (calc order).
    inv = [{"name": "A", "count": 3, "present": True}]
    prices = [{"name": "A", "price_median": 10}]
    up = SubsetDef(id="up", datasets=["inv", "prices"], join_field="name",
                   derived=[DerivedColumn(name="value", template="={count}*{price_median}")])
    up_rows = compute_view([("inv", inv), ("prices", prices)], up)["rows"]
    down = SubsetDef(id="down", datasets=["up"], join_field="name",
                     derived=[DerivedColumn(name="label", template="{=value*2} pl")])
    out = compute_view([("up", up_rows)], down)
    row = out["rows"][0]
    assert row["value"] == 30 and row["label"] == "60 pl"   # upstream derived feeds downstream


def test_latest_batch_keeps_only_newest_batch_rows():
    # rows carry the store's `_batch`; latest_batch trims to the highest before anything else
    recs = [{"name": "Old", "_batch": 1, "present": True},
            {"name": "Mid", "_batch": 1, "present": True},
            {"name": "New", "_batch": 2, "present": True}]
    sub = SubsetDef(id="v", dataset="d", latest_batch=True)
    rows = compute_subset(recs, sub)["rows"]
    assert {r["name"] for r in rows} == {"New"}              # batch 1 dropped
    assert "_batch" not in rows[0]                            # bookkeeping col stays hidden


def test_latest_batch_off_keeps_all():
    recs = [{"name": "Old", "_batch": 1, "present": True},
            {"name": "New", "_batch": 2, "present": True}]
    rows = compute_subset(recs, SubsetDef(id="v", dataset="d"))["rows"]
    assert {r["name"] for r in rows} == {"Old", "New"}


def test_latest_batch_applied_before_limit():
    # apply order: latest-batch FIRST, then limit — so limit counts only newest-batch rows
    recs = [{"name": "a", "_batch": 1, "present": True}, {"name": "b", "_batch": 1, "present": True},
            {"name": "c", "_batch": 2, "present": True}, {"name": "d", "_batch": 2, "present": True}]
    sub = SubsetDef(id="v", dataset="d", latest_batch=True, limit=10)
    rows = compute_subset(recs, sub)["rows"]
    assert {r["name"] for r in rows} == {"c", "d"}           # only batch 2 survived, limit didn't pull batch 1


def test_store_records_expose_latest_batch(tmp_path):
    # the store tags each observation with its batch; records() surfaces the row's max _batch
    from oc.store.dataset_store import DatasetStore
    s = DatasetStore(tmp_path, "g", "ds")
    s.begin_batch(); s.record_seen({"name": "A"})
    s.begin_batch(); s.record_seen({"name": "B"})
    by = {r["name"]: r for r in s.records()}
    assert by["A"]["_batch"] == 1 and by["B"]["_batch"] == 2


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
