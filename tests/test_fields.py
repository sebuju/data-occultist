from oc.collect.fields import coerce, coerce_rule
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


def test_empty_fallback_only_when_truly_empty():
    # "empty" fires only when NOTHING was detected — junk text is not empty
    f = FieldDef(id="count", type=FieldType.number, empty="1")
    assert coerce(f, "") == 1            # nothing read
    assert coerce(f, "   ") == 1         # whitespace-only = nothing read
    assert coerce(f, "Guard") is None    # junk read: NOT the empty fallback
    assert coerce(f, "x 3") == 3         # a real number still wins


def test_no_empty_no_number_is_none():
    f = FieldDef(id="count", type=FieldType.number)   # no empty default
    assert coerce(f, "abc") is None


def test_text_empty_fallback():
    f = FieldDef(id="tag", empty="—")
    assert coerce(f, "  ") == "—"


def test_text_if_number_all_numeric_only():
    # default mode: substitute only when the read is ENTIRELY numbers
    f = FieldDef(id="name", if_number="unknown")
    assert coerce(f, "1234") == "unknown"
    assert coerce(f, "12,5") == "unknown"            # punctuation+digits still numeric
    assert coerce(f, "Soma 2") == "Soma 2"           # contains a letter -> kept
    assert coerce(f, "Soma Prime") == "Soma Prime"


def test_text_if_number_any_digit():
    f = FieldDef(id="name", if_number="unknown", if_number_any=True)
    assert coerce(f, "Soma 2") == "unknown"          # any digit triggers
    assert coerce(f, "Soma Prime") == "Soma Prime"


def test_number_if_text_all_text_only():
    f = FieldDef(id="count", type=FieldType.number, if_text="0")
    assert coerce(f, "Guard") == 0                   # all-text read substituted
    assert coerce(f, "x 3") == 3                     # contains a digit -> real read wins
    assert coerce(f, "7") == 7


def test_number_if_text_any_letter():
    f = FieldDef(id="count", type=FieldType.number, if_text="0", if_text_any=True)
    assert coerce(f, "x 3") == 0                     # any letter triggers
    assert coerce(f, "3") == 3


def test_if_substitutions_do_not_swallow_empty():
    # truly-empty read goes through the empty fallback, not the if_* substitution
    f = FieldDef(id="count", type=FieldType.number, empty="1", if_text="0")
    assert coerce(f, "") == 1
    assert coerce(f, "Guard") == 0


def test_coerce_rule_reports_which_fallback_fired():
    f = FieldDef(id="count", type=FieldType.number, empty="1", if_text="0")
    assert coerce_rule(f, "") == (1, "empty")
    assert coerce_rule(f, "Guard") == (0, "if_text")
    assert coerce_rule(f, "7") == (7, None)               # a real read carries no rule
    t = FieldDef(id="name", if_number="unknown")
    assert coerce_rule(t, "1234") == ("unknown", "if_number")
    assert coerce_rule(t, "Soma") == ("Soma", None)
