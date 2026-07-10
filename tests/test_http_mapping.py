"""Pure-logic tests for the generic http producer's mapping engine + helpers.

The mapping engine (select array -> filter -> pluck -> aggregate) is the risky new
logic, so it gets the most coverage. No network — everything here is a pure function.
"""

from oc.enrich.http_get import json_path, key_transform
from oc.enrich.http_producer import _agg, _explode, _fill_template, map_response, map_rows
from oc.profile.models import HttpArraySpec, HttpField, HttpFilter, HttpSpec


# ---- json_path --------------------------------------------------------------

def test_json_path_dotted_and_index():
    obj = {"a": {"b": [10, {"c": 3}]}}
    assert json_path(obj, "") is obj
    assert json_path(obj, "a.b[0]") == 10
    assert json_path(obj, "a.b[1].c") == 3


def test_json_path_missing_returns_none():
    assert json_path({"a": 1}, "a.b") is None
    assert json_path({"a": [1]}, "a[5]") is None
    assert json_path([], "x") is None


# ---- key_transform ----------------------------------------------------------

def test_key_transform_modes():
    assert key_transform("Soma Prime", "none") == "Soma Prime"
    assert key_transform("Soma Prime", "lowercase") == "soma prime"
    assert key_transform("Soma Prime", "slugify") == "soma_prime"
    # catalogue is resolved by the producer, not here -> passthrough
    assert key_transform("Soma Prime", "catalogue") == "Soma Prime"


# ---- aggregation ------------------------------------------------------------

def _arr(**kw):
    return HttpArraySpec(**kw)


def test_agg_variants():
    vals = [30, 10, 20, 40]
    assert _agg(vals, vals, _arr(agg="min")) == 10
    assert _agg(vals, vals, _arr(agg="max")) == 40
    assert _agg(vals, vals, _arr(agg="sum")) == 100
    assert _agg(vals, vals, _arr(agg="count")) == 4
    assert _agg(vals, vals, _arr(agg="median")) == 25
    assert _agg(vals, vals, _arr(agg="first")) == 30


def test_agg_median_low_depth():
    vals = [50, 10, 30, 20, 40]
    # lowest 3 = [10,20,30] -> median 20
    assert _agg(vals, vals, _arr(agg="median_low", depth=3)) == 20
    # depth beyond length just uses all
    assert _agg(vals, vals, _arr(agg="median_low", depth=99)) == 30


def test_agg_empty_is_none():
    assert _agg([], [], _arr(agg="min")) is None
    assert _agg(["x"], ["x"], _arr(agg="min")) is None    # non-numeric plucked -> none


# ---- map_response: filter -> pluck -> aggregate -----------------------------

_ORDERS = [
    {"type": "sell", "user": {"status": "online"}, "platinum": 40},
    {"type": "sell", "user": {"status": "ingame"}, "platinum": 20},
    {"type": "sell", "user": {"status": "offline"}, "platinum": 5},     # excluded (offline)
    {"type": "buy", "user": {"status": "online"}, "platinum": 3},       # excluded (buy)
]


def _sell_filter():
    return [HttpFilter(path="type", op="eq", value="sell"),
            HttpFilter(path="user.status", op="in", value=["online", "ingame"])]


def test_map_response_orders_min_median_count():
    fields = [
        HttpField(out_field="price_min", type="number",
                  array=HttpArraySpec(filter=_sell_filter(), pluck="platinum", agg="min")),
        HttpField(out_field="price_median", type="number",
                  array=HttpArraySpec(filter=_sell_filter(), pluck="platinum", agg="median_low", depth=5)),
        HttpField(out_field="volume", type="number",
                  array=HttpArraySpec(filter=_sell_filter(), pluck="platinum", agg="count")),
    ]
    row = map_response(_ORDERS, fields)
    assert row == {"price_min": 20, "price_median": 30, "volume": 2}


def test_map_response_ops():
    arr = [{"n": 1}, {"n": 2}, {"n": 3}, {"n": 4}]
    def one(op, value):
        f = HttpField(out_field="c", type="number",
                      array=HttpArraySpec(filter=[HttpFilter(path="n", op=op, value=value)],
                                          pluck="n", agg="count"))
        return map_response(arr, [f]).get("c")
    assert one("gt", 2) == 2
    assert one("ge", 2) == 3
    assert one("lt", 3) == 2
    assert one("le", 3) == 3
    assert one("ne", 2) == 3
    assert one("nin", [1, 2]) == 2


def test_map_response_scalar_path_and_number_coercion():
    obj = {"data": {"ducats": "45", "name": "X"}}
    fields = [HttpField(out_field="ducats", path="data.ducats", type="number"),
              HttpField(out_field="name", path="data.name")]
    assert map_response(obj, fields) == {"ducats": 45.0, "name": "X"}


def test_map_response_required_drops_row():
    fields = [HttpField(out_field="p", path="missing.x", type="number", required=True)]
    assert map_response({"a": 1}, fields) is None


def test_map_response_omits_none_but_keeps_row():
    fields = [HttpField(out_field="present", path="a"),
              HttpField(out_field="absent", path="nope")]
    assert map_response({"a": 1}, fields) == {"present": 1}


# ---- template columns -------------------------------------------------------

def test_fill_template_composes_and_drops_missing():
    obj = {"tier": "Axi", "relicName": "A1"}
    assert _fill_template(obj, "{tier} {relicName}") == "Axi A1"
    assert _fill_template(obj, "{tier} {gone}") == "Axi "        # missing path -> ""


def test_map_response_template_field_wins_over_path():
    fields = [HttpField(out_field="name", path="ignored", template="{tier} {relicName}")]
    assert map_response({"tier": "Axi", "relicName": "A1"}, fields) == {"name": "Axi A1"}


# ---- explode / list mode ----------------------------------------------------

_RELICS = {"relics": [
    {"tier": "Axi", "relicName": "A1", "rewards": [
        {"itemName": "Braton Prime", "rarity": "Common"},
        {"itemName": "Nikana Prime", "rarity": "Rare"}]},
    {"tier": "Lith", "relicName": "G3", "rewards": [
        {"itemName": "Nikana Prime", "rarity": "Rare"}]},
    {"tier": "Requiem", "relicName": "I", "rewards": []},   # no rewards -> contributes no rows
]}


def _relic_spec():
    return HttpSpec(root="", explode=["relics", "rewards"], fields=[
        HttpField(out_field="name", template="{tier} {relicName}", required=True),
        HttpField(out_field="item", path="itemName", required=True),
        HttpField(out_field="rarity", path="rarity")])


def test_explode_merges_ancestor_fields_at_each_leaf():
    merged = list(_explode(_RELICS, ["relics", "rewards"]))
    assert len(merged) == 3                                  # empty-rewards relic yields nothing
    assert merged[0]["tier"] == "Axi" and merged[0]["itemName"] == "Braton Prime"


def test_map_rows_list_mode_one_row_per_leaf():
    rows = map_rows(_RELICS, _relic_spec())
    assert rows == [
        {"name": "Axi A1", "item": "Braton Prime", "rarity": "Common"},
        {"name": "Axi A1", "item": "Nikana Prime", "rarity": "Rare"},
        {"name": "Lith G3", "item": "Nikana Prime", "rarity": "Rare"}]


def test_map_rows_per_item_mode_single_row():
    # no explode -> the classic one-row map (or none)
    spec = HttpSpec(fields=[HttpField(out_field="v", path="a", type="number")])
    assert map_rows({"a": 5}, spec) == [{"v": 5}]
    assert map_rows({"a": None}, HttpSpec(fields=[
        HttpField(out_field="v", path="a", required=True)])) == []


# ---- row_filter: drop a source element BEFORE it is mapped -------------------
# Guards the alternative (ingest duplicate names, then let a dataset `aggregate: max` pick
# between them) — that picks a record by magnitude, not identity.


def _mods_spec(row_filter=()):
    return HttpSpec(explode=[""], row_filter=list(row_filter),
                    fields=[HttpField(out_field="name", path="name"),
                            HttpField(out_field="fl", path="fusionLimit", type="number")])


_MODS = [
    {"name": "Fast Deflection", "fusionLimit": 5, "uniqueName": "/Mods/Warframe/ShieldMod"},
    {"name": "Fast Deflection", "fusionLimit": 3, "uniqueName": "/Mods/Warframe/Beginner/ShieldModBeginner"},
    {"name": "Vitality", "fusionLimit": 10, "uniqueName": "/Mods/Warframe/HealthMod"},
]


def test_row_filter_drops_elements_before_mapping():
    rows = map_rows(_MODS, _mods_spec([HttpFilter(path="uniqueName", op="ncontains", value="/Beginner/")]))
    assert rows == [{"name": "Fast Deflection", "fl": 5}, {"name": "Vitality", "fl": 10}]


def test_row_filter_can_test_a_field_no_column_emits():
    # `uniqueName` is never an out_field, yet the predicate still reads it off the raw element
    assert all("uniqueName" not in r for r in map_rows(_MODS, _mods_spec()))
    rows = map_rows(_MODS, _mods_spec([HttpFilter(path="uniqueName", op="contains", value="/Beginner/")]))
    assert rows == [{"name": "Fast Deflection", "fl": 3}]


def test_row_filter_predicates_are_anded():
    flt = [HttpFilter(path="uniqueName", op="ncontains", value="/Beginner/"),
           HttpFilter(path="name", op="ne", value="Vitality")]
    assert map_rows(_MODS, _mods_spec(flt)) == [{"name": "Fast Deflection", "fl": 5}]


def test_row_filter_empty_keeps_every_row():
    assert len(map_rows(_MODS, _mods_spec())) == 3


def test_row_filter_applies_in_per_item_mode():
    spec = HttpSpec(row_filter=[HttpFilter(path="status", op="eq", value="ok")],
                    fields=[HttpField(out_field="v", path="a", type="number")])
    assert map_rows({"a": 5, "status": "ok"}, spec) == [{"v": 5}]
    assert map_rows({"a": 5, "status": "dead"}, spec) == []


def test_ncontains_is_the_negation_of_contains():
    from oc.enrich.http_producer import _op
    assert _op("/Mods/Beginner/X", "contains", "/Beginner/") is True
    assert _op("/Mods/Beginner/X", "ncontains", "/Beginner/") is False
    assert _op("/Mods/X", "ncontains", "/Beginner/") is True
    # a MISSING field cannot contain the value, and vacuously does not contain it — `ncontains`
    # must keep such a row, else the filter meant to keep it silently drops it
    assert _op(None, "contains", "/Beginner/") is False
    assert _op(None, "ncontains", "/Beginner/") is True


def test_row_filter_keeps_rows_missing_the_tested_field():
    mods = [*_MODS, {"name": "Odd Mod", "fusionLimit": 1}]        # no uniqueName at all
    rows = map_rows(mods, _mods_spec([HttpFilter(path="uniqueName", op="ncontains", value="/Beginner/")]))
    assert {"name": "Odd Mod", "fl": 1} in rows
