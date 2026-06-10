from oc.collect.fields import coerce
from oc.profile.models import Extract, FieldDef, FieldType


def test_text_passthrough():
    f = FieldDef(id="name")
    assert coerce(f, "  Soma Prime ") == "Soma Prime"


def test_text_empty_is_none():
    assert coerce(FieldDef(id="name"), "   ") is None


def test_number_parsing():
    f = FieldDef(id="count", type=FieldType.number)
    assert coerce(f, "x 12 owned") == 12
    assert coerce(f, "1,234") == 1234
    assert coerce(f, "3.5") == 3.5


def test_extract_number_before_separator():
    f = FieldDef(id="rank", type=FieldType.number, extract=Extract.number_before, separator="/")
    assert coerce(f, "7 / 30") == 7


def test_extract_number_after_separator():
    f = FieldDef(id="max", type=FieldType.number, extract=Extract.number_after, separator="/")
    assert coerce(f, "7 / 30") == 30


def test_extract_text_before_separator():
    f = FieldDef(id="name", extract=Extract.text_before, separator="(")
    assert coerce(f, "Serration (maxed)") == "Serration"


def test_empty_fallback_when_no_number():
    # a count box that read junk (no digit) falls back to the empty default, not None
    f = FieldDef(id="count", type=FieldType.number, empty="1")
    assert coerce(f, "") == 1            # nothing read
    assert coerce(f, "Guard") == 1       # OCR junk, no digit
    assert coerce(f, "x 3") == 3         # a real number still wins


def test_no_empty_no_number_is_none():
    f = FieldDef(id="count", type=FieldType.number)   # no empty default
    assert coerce(f, "abc") is None


def test_text_empty_fallback():
    f = FieldDef(id="tag", empty="—")
    assert coerce(f, "  ") == "—"
