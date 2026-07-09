"""Subset compute + profile round-trip."""

from oc.profile.loader import load_profile, save_profile
from oc.profile.models import (
    DerivedColumn, FilterRule, GameProfile, JoinNorm, JoinSource, SubsetDef,
)
from oc.enrich.subset import compute_subset, compute_view
from oc.store.textnorm import norm_text


def _src(dataset, join_field="name", required=False, aggregate="latest", join_norm=None):
    """One JoinSource with terse defaults — the per-source join config a view input carries."""
    return JoinSource(dataset=dataset, join_field=join_field, required=required,
                      aggregate=aggregate, join_norm=join_norm or JoinNorm())


def _records():
    return [
        {"name": "Amesha", "rank": "3", "present": True, "first_seen": "t"},
        {"name": "Vitality", "rank": "0", "present": True},
        {"name": "Bronco", "rank": "5", "present": True},
    ]


def test_filter_derive_sort_limit():
    sub = SubsetDef(
        id="arc", sources=[_src("equip")],
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
    sub = SubsetDef(id="v", sources=[_src("d")], filters=[FilterRule(field="name", op="icontains", value="a")])
    keys = {row["name"] for row in compute_subset(_records(), sub)["rows"]}
    assert keys == {"Amesha", "Vitality"}                # both contain 'a'/'A'


def test_view_joins_datasets_on_key_with_arithmetic_derived():
    inv = [{"name": "Acceltra Prime", "count": 2, "present": True},
           {"name": "Junk", "count": 5, "present": True}]
    prices = [{"name": "Acceltra Prime", "slug": "acceltra_prime_set", "price_median": 48}]
    sub = SubsetDef(id="folio", sources=[_src("master"), _src("prices")],
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
    sub = SubsetDef(id="folio", sources=[_src("master"), _src("prices")],
                    derived=[DerivedColumn(name="worth", template="{=count*price_median} plat")])
    rows = {r["name"]: r for r in compute_view([("master", inv), ("prices", prices)], sub)["rows"]}
    assert rows["Acceltra Prime"]["worth"] == "96 plat"   # math evaluated, literal text kept
    assert rows["Junk"]["worth"] == " plat"               # missing operand -> empty math, text stays


def test_round_directive_fixes_derived_decimals():
    inv = [{"name": "A", "count": 3, "present": True}]
    prices = [{"name": "A", "price_median": 10, "present": True}]
    sub = SubsetDef(id="v", sources=[_src("m"), _src("p")], derived=[
        DerivedColumn(name="each0", template="={price_median}/{count}|round:0"),   # pure math
        DerivedColumn(name="each1", template="={price_median}/{count}|round:1"),
        DerivedColumn(name="inline", template="{=price_median/count|round:2} pl"),  # inline math
        DerivedColumn(name="plain", template="={price_median}/{count}"),            # no directive
    ])
    row = compute_view([("m", inv), ("p", prices)], sub)["rows"][0]
    assert row["each0"] == 3          # 3.333 -> integer (round:0)
    assert row["each1"] == 3.3        # one decimal
    assert row["inline"] == "3.33 pl"  # inline math rounded, literal text kept
    assert row["plain"] == 3.33       # default tidy stays 2dp


def test_round_directive_on_plain_placeholder_in_text():
    inv = [{"name": "Acceltra", "count": 2, "present": True}]
    prices = [{"name": "Acceltra", "price_min": 47.6, "present": True}]
    sub = SubsetDef(id="v", sources=[_src("m"), _src("p")], derived=[
        DerivedColumn(name="label", template="{name} {price_min|round:0}p"),
    ])
    row = compute_view([("m", inv), ("p", prices)], sub)["rows"][0]
    assert row["label"] == "Acceltra 48p"   # placeholder rounds, name substitutes, text kept


def test_leading_equals_still_pure_math():
    inv = [{"name": "X", "count": 2, "present": True}]
    prices = [{"name": "X", "price_median": 48}]
    sub = SubsetDef(id="v", sources=[_src("m"), _src("p")],
                    derived=[DerivedColumn(name="value", template="={count}*{price_median}")])
    rows = compute_view([("m", inv), ("p", prices)], sub)["rows"]
    assert rows[0]["value"] == 96                         # back-compat: numeric, not a string


def test_view_feeding_view_chains_derived_columns():
    # upstream view computes `value`; downstream view consumes its ROWS and derives from it,
    # mirroring how flow.py resolves a view input before the view that joins it (calc order).
    inv = [{"name": "A", "count": 3, "present": True}]
    prices = [{"name": "A", "price_median": 10}]
    up = SubsetDef(id="up", sources=[_src("inv"), _src("prices")],
                   derived=[DerivedColumn(name="value", template="={count}*{price_median}")])
    up_rows = compute_view([("inv", inv), ("prices", prices)], up)["rows"]
    down = SubsetDef(id="down", sources=[_src("up")],
                     derived=[DerivedColumn(name="label", template="{=value*2} pl")])
    out = compute_view([("up", up_rows)], down)
    row = out["rows"][0]
    assert row["value"] == 30 and row["label"] == "60 pl"   # upstream derived feeds downstream


def test_latest_batch_keeps_only_newest_batch_rows():
    # rows carry the store's `_batch`; latest_batch trims to the highest before anything else
    recs = [{"name": "Old", "_batch": 1, "present": True},
            {"name": "Mid", "_batch": 1, "present": True},
            {"name": "New", "_batch": 2, "present": True}]
    sub = SubsetDef(id="v", sources=[_src("d")], latest_batch=True)
    rows = compute_subset(recs, sub)["rows"]
    assert {r["name"] for r in rows} == {"New"}              # batch 1 dropped
    assert "_batch" not in rows[0]                            # bookkeeping col stays hidden


def test_latest_batch_off_keeps_all():
    recs = [{"name": "Old", "_batch": 1, "present": True},
            {"name": "New", "_batch": 2, "present": True}]
    rows = compute_subset(recs, SubsetDef(id="v", sources=[_src("d")]))["rows"]
    assert {r["name"] for r in rows} == {"Old", "New"}


def test_latest_batch_applied_before_limit():
    # apply order: latest-batch FIRST, then limit — so limit counts only newest-batch rows
    recs = [{"name": "a", "_batch": 1, "present": True}, {"name": "b", "_batch": 1, "present": True},
            {"name": "c", "_batch": 2, "present": True}, {"name": "d", "_batch": 2, "present": True}]
    sub = SubsetDef(id="v", sources=[_src("d")], latest_batch=True, limit=10)
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


def test_norm_text_canonicalises():
    # default: lower + collapse whitespace (== the old .strip().lower() join, plus internal ws)
    assert norm_text("  Axi   A1 ") == "axi a1"
    # the relics-vs-relic_contents bridge: strip punctuation + the stray word "relic"
    assert norm_text("Axi A1 Relic", strip_punct=True, strip_words=("relic",)) == "axi a1"
    assert norm_text("AXI A1", strip_punct=True, strip_words=("relic",)) == "axi a1"
    # case-sensitive keeps case and only matches exact-case words
    assert norm_text("Lith B4", lower=False) == "Lith B4"


def test_per_source_join_norm_bridges_near_match_keys():
    # each source canonicalises its OWN value: relics-side keeps "Relic" + case, contents side is plain
    relics = [{"name": "Axi A1 Relic", "count": 3, "present": True}]
    contents = [{"name": "AXI A1", "item": "Nikana Prime Blueprint", "present": True}]
    norm = JoinNorm(strip_punct=True, strip_words=["relic"])
    sub = SubsetDef(id="rwc", sources=[
        _src("relics", required=True, join_norm=norm),
        _src("relic_contents", required=True, join_norm=norm)])
    out = compute_view([("relics", relics), ("relic_contents", contents)], sub)
    assert len(out["rows"]) == 1                                  # joined into ONE row
    row = out["rows"][0]
    assert row["count"] == 3 and row["item"] == "Nikana Prime Blueprint"   # both sides merged


def test_per_source_join_fields_differ():
    # sources may key DIFFERENT columns — they still join when normalised values agree
    inv = [{"name": "Acceltra Prime", "count": 2, "present": True}]
    prices = [{"item_name": "acceltra prime", "price_median": 48, "present": True}]
    sub = SubsetDef(id="v", sources=[_src("inv", join_field="name"),
                                     _src("prices", join_field="item_name")])
    rows = compute_view([("inv", inv), ("prices", prices)], sub)["rows"]
    assert len(rows) == 1 and rows[0]["price_median"] == 48 and rows[0]["count"] == 2


def test_default_join_norm_leaves_exact_joins_unchanged():
    # without configured knobs the join behaves like the old case-insensitive exact match
    a = [{"name": "Acceltra Prime", "count": 2, "present": True}]
    b = [{"name": "acceltra prime", "price_median": 48, "present": True}]
    sub = SubsetDef(id="v", sources=[_src("a"), _src("b")])
    rows = compute_view([("a", a), ("b", b)], sub)["rows"]
    assert len(rows) == 1 and rows[0]["price_median"] == 48       # case folded, still one row


def test_required_narrows_to_inner_optional_keeps_outer():
    # an optional source gap-fills (outer); marking it required drops keys it lacks (inner)
    a = [{"name": "X", "count": 1, "present": True}, {"name": "Y", "count": 2, "present": True}]
    b = [{"name": "X", "price": 10, "present": True}]
    outer = SubsetDef(id="o", sources=[_src("a"), _src("b")])               # nothing required
    inner = SubsetDef(id="i", sources=[_src("a", required=True), _src("b", required=True)])
    outer_rows = {r["name"] for r in compute_view([("a", a), ("b", b)], outer)["rows"]}
    inner_rows = {r["name"] for r in compute_view([("a", a), ("b", b)], inner)["rows"]}
    assert outer_rows == {"X", "Y"}                                  # Y kept, price gap-filled
    assert inner_rows == {"X"}                                       # Y dropped (absent in b)


def test_join_norm_round_trips_through_profile(tmp_path):
    p = GameProfile(name="g", subsets=[SubsetDef(id="rwc", sources=[
        _src("relics", required=True, join_norm=JoinNorm(strip_punct=True, strip_words=["relic"])),
        _src("relic_contents", required=True, join_norm=JoinNorm(strip_punct=True, strip_words=["relic"])),
    ])])
    save_profile(tmp_path, p)
    s = load_profile(tmp_path, "g").subset_def("rwc")
    src0 = s.sources[0]
    assert src0.join_norm.strip_punct is True and src0.join_norm.strip_words == ["relic"]
    assert src0.required is True
    assert src0.join_norm.case_insensitive is True               # default preserved


def test_join_preserves_multiplicity_one_to_many():
    # a key with many rows on one side x one on the other -> one output row PER many-side row
    # (no collapse), each carrying the one-side's columns
    relics = [{"name": "Axi A1", "tier": "Axi"}]
    contents = [{"name": "Axi A1", "item": "Nikana BP"}, {"name": "Axi A1", "item": "Braton Stock"}]
    sub = SubsetDef(id="rwc", sources=[_src("relics", required=True), _src("contents", required=True)])
    out = compute_view([("relics", relics), ("contents", contents)], sub)
    assert len(out["rows"]) == 2                                      # not collapsed to 1
    assert sorted(r["item"] for r in out["rows"]) == ["Braton Stock", "Nikana BP"]
    assert all(r["tier"] == "Axi" for r in out["rows"])              # relic col attached to each


def test_all_aggregate_emits_every_observation(tmp_path):
    # "all" is the no-collapse opt-out: each observation stays its own row
    from oc.store.dataset_store import DatasetStore, rows_at
    s = DatasetStore(tmp_path, "g", "ds")
    s.begin_batch(); s.record_seen({"name": "A", "price": 10})
    s.begin_batch(); s.record_seen({"name": "A", "price": 20})   # same key -> 2nd observation
    s.begin_batch(); s.record_seen({"name": "B", "price": 5})
    assert len(s.records()) == 2                                 # A collapsed to one (latest)
    allr = s.all_records()
    assert len(allr) == 3                                        # A's two obs both kept
    assert sorted(r["price"] for r in allr if r["name"] == "A") == [10, 20]
    assert len(rows_at(s, "all")) == 3 and len(rows_at(s, "latest")) == 2


def test_exclude_source_drops_matching_keys():
    # anti-join: a source marked exclude contributes NO columns -- it's purely a key blocklist
    # (owned mods minus already-equipped names is the motivating case).
    owned = [{"name": "Vitality", "count": 1, "present": True},
             {"name": "Serration", "count": 1, "present": True}]
    equipped = [{"name": "Vitality", "present": True}]
    sub = SubsetDef(id="v", sources=[_src("owned"), JoinSource(dataset="equipped", join_field="name", exclude=True)])
    rows = compute_view([("owned", owned), ("equipped", equipped)], sub)["rows"]
    assert {r["name"] for r in rows} == {"Serration"}       # Vitality dropped, equipped's own cols never appear


def test_exclude_independent_of_required():
    # required only gates presence in the OUTPUT set; exclude removes a key outright regardless.
    owned = [{"name": "X", "present": True}, {"name": "Y", "present": True}]
    blocked = [{"name": "X", "present": True}]
    sub = SubsetDef(id="v", sources=[
        _src("owned", required=True),
        JoinSource(dataset="blocked", join_field="name", required=True, exclude=True),
    ])
    rows = compute_view([("owned", owned), ("blocked", blocked)], sub)["rows"]
    assert {r["name"] for r in rows} == {"Y"}


def test_exclude_never_drops_keyless_standalone_rows():
    # a row with no join value (join_field "") stays standalone and can't be matched by exclude.
    owned = [{"name": "", "extra": "junk", "present": True}, {"name": "X", "present": True}]
    blocked = [{"name": "X", "present": True}]
    sub = SubsetDef(id="v", sources=[
        _src("owned"),
        JoinSource(dataset="blocked", join_field="name", exclude=True),
    ])
    rows = compute_view([("owned", owned), ("blocked", blocked)], sub)["rows"]
    assert {r.get("extra") for r in rows} == {"junk"}       # the keyless row survives; "X" was excluded


def test_all_sources_excluded_yields_nothing():
    # two sources so the single-source pass-through shortcut doesn't apply
    a = [{"name": "X", "present": True}]
    b = [{"name": "Y", "present": True}]
    sub = SubsetDef(id="v", sources=[
        JoinSource(dataset="a", join_field="name", exclude=True),
        JoinSource(dataset="b", join_field="name", exclude=True),
    ])
    assert compute_view([("a", a), ("b", b)], sub)["rows"] == []


def test_exclude_round_trips_through_profile(tmp_path):
    p = GameProfile(name="g", subsets=[SubsetDef(id="v", sources=[
        _src("owned"), JoinSource(dataset="blocked", join_field="name", exclude=True)])])
    save_profile(tmp_path, p)
    s = load_profile(tmp_path, "g").subset_def("v")
    assert s.sources[1].exclude is True
    assert s.sources[0].exclude is False                     # default stays off


def test_subset_round_trips_through_profile(tmp_path):
    p = GameProfile(name="g", subsets=[SubsetDef(
        id="arc", sources=[_src("equip")],
        filters=[FilterRule(field="rank", op="gte", value="1")],
        derived=[DerivedColumn(name="display", template="{name} [{rank}]")],
    )])
    save_profile(tmp_path, p)
    back = load_profile(tmp_path, "g")
    assert len(back.subsets) == 1
    s = back.subset_def("arc")
    assert s.sources[0].dataset == "equip" and s.derived[0].template == "{name} [{rank}]"
