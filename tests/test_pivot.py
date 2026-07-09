"""apply_pivot: fold flat {name, value} rows into wide rows by shared id-prefix."""

from oc.enrich.pivot import apply_pivot
from oc.profile.models import PivotSpec


def test_groups_rows_by_prefix():
    flat = [{"name": "slot_1_name", "value": "Vitality"}, {"name": "slot_1_drain", "value": "6"},
            {"name": "slot_2_name", "value": "Serration"}, {"name": "slot_2_drain", "value": "9"}]
    spec = PivotSpec(attributes=["_name", "_drain"])
    rows = {r["slot"]: r for r in apply_pivot(flat, spec)}
    assert rows["slot_1"] == {"slot": "slot_1", "name": "Vitality", "drain": "6"}
    assert rows["slot_2"] == {"slot": "slot_2", "name": "Serration", "drain": "9"}


def test_row_matching_no_suffix_is_dropped():
    flat = [{"name": "slot_1_name", "value": "Vitality"}, {"name": "mod_drain_remaining", "value": "12"}]
    spec = PivotSpec(attributes=["_name"])
    rows = apply_pivot(flat, spec)
    assert len(rows) == 1 and rows[0]["slot"] == "slot_1"


def test_no_attributes_taught_yields_nothing():
    flat = [{"name": "slot_1_name", "value": "Vitality"}]
    assert apply_pivot(flat, PivotSpec(attributes=[])) == []


def test_first_value_wins_a_duplicate_attribute():
    flat = [{"name": "slot_1_name", "value": "First"}, {"name": "slot_1_name", "value": "Second"}]
    rows = apply_pivot(flat, PivotSpec(attributes=["_name"]))
    assert len(rows) == 1 and rows[0]["name"] == "First"


def test_prefix_order_is_first_seen():
    flat = [{"name": "slot_3_name", "value": "C"}, {"name": "slot_1_name", "value": "A"},
            {"name": "slot_3_drain", "value": "1"}, {"name": "slot_1_drain", "value": "2"}]
    rows = apply_pivot(flat, PivotSpec(attributes=["_name", "_drain"]))
    assert [r["slot"] for r in rows] == ["slot_3", "slot_1"]


def test_custom_name_value_key_fields():
    flat = [{"readout": "aura_school", "reading": "zenurik"}]
    spec = PivotSpec(name_field="readout", value_field="reading", key_column="slot", attributes=["_school"])
    rows = apply_pivot(flat, spec)
    assert rows == [{"slot": "aura", "school": "zenurik"}]


def test_missing_name_field_is_treated_as_empty_and_dropped():
    flat = [{"value": "orphan"}]
    rows = apply_pivot(flat, PivotSpec(attributes=["_name"]))
    assert rows == []
