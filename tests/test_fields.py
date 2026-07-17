from oc.collect.fields import coerce, run_rules
from oc.profile.models import Extract, FieldDef, FieldRule, FieldType, RuleThen, RuleWhen


def _f(rules=None, type=FieldType.text):
    return FieldDef(id="f", type=type, rules=rules or [])


def rule(**kw):
    return FieldRule(**kw)


# ---- pass-through / typing --------------------------------------------------

def test_text_passthrough():
    assert coerce(_f(), "  Soma Prime ") == "Soma Prime"


def test_text_empty_is_none():
    assert coerce(_f(), "   ") is None


def test_number_parsing():
    f = _f(type=FieldType.number)
    assert coerce(f, "x 12 owned") == 12
    assert coerce(f, "1,234") == 1234
    assert coerce(f, "3.5") == 3.5


def test_no_rules_reads_pass_through():
    assert coerce(_f(), "Soma") == "Soma"
    assert coerce(_f(type=FieldType.number), "x 3") == 3


# ---- extract rule -----------------------------------------------------------

def test_extract_number_before_separator():
    f = _f([rule(then=RuleThen.extract, strategy=Extract.number_before, sep="/")], FieldType.number)
    assert coerce(f, "7 / 30") == 7


def test_extract_number_after_separator():
    f = _f([rule(then=RuleThen.extract, strategy=Extract.number_after, sep="/")], FieldType.number)
    assert coerce(f, "7 / 30") == 30


def test_extract_text_before_separator():
    f = _f([rule(then=RuleThen.extract, strategy=Extract.text_before, sep="(")])
    assert coerce(f, "Serration (maxed)") == "Serration"


def test_extract_word_separator_is_case_insensitive():
    f = _f([rule(then=RuleThen.extract, strategy=Extract.text_before, sep="Rank")])
    assert coerce(f, "Serration RANK 5") == "Serration"
    g = _f([rule(then=RuleThen.extract, strategy=Extract.number_after, sep="of")], FieldType.number)
    assert coerce(g, "5 OF 30") == 30


def test_extract_text_strips_whole():
    f = _f([rule(then=RuleThen.extract, strategy=Extract.text)])
    assert coerce(f, "  Serration (maxed) ") == "Serration (maxed)"


def test_extract_alphanum_drops_symbols_collapses_ws():
    f = _f([rule(then=RuleThen.extract, strategy=Extract.alphanum)])
    assert coerce(f, "Lith  G1  (rad)") == "Lith G1 rad"


def test_extract_alphanum_before_and_after_separator():
    f = _f([rule(then=RuleThen.extract, strategy=Extract.alphanum_before, sep="/")])
    assert coerce(f, "Lith G1 / rad") == "Lith G1"
    g = _f([rule(then=RuleThen.extract, strategy=Extract.alphanum_after, sep="/")])
    assert coerce(g, "7 / 30 (max)") == "30 max"


# ---- decimal rule (restore an OCR-dropped decimal point) --------------------

def test_decimal_restores_dropped_point():
    f = _f([rule(then=RuleThen.decimal)], FieldType.number)
    assert coerce(f, "05") == 0.5
    assert coerce(f, "025") == 0.25
    assert coerce(f, "005") == 0.05


def test_decimal_leaves_normal_numbers_untouched():
    f = _f([rule(then=RuleThen.decimal)], FieldType.number)
    assert coerce(f, "12") == 12        # no leading zero
    assert coerce(f, "0") == 0          # length 1
    assert coerce(f, "0.5") == 0.5      # already has a dot


def test_decimal_ignored_on_text_field():
    # `decimal` is number-only; on a TEXT field it must be IGNORED, not run
    f = _f([rule(then=RuleThen.decimal)], FieldType.text)
    assert coerce(f, "05") == "05"
    res = run_rules(f, "05", trace=True)
    assert res.trace[0]["ignored"] is True and res.trace[0]["fired"] is False


# ---- set / drop -------------------------------------------------------------

def test_set_on_empty():
    f = _f([rule(when=RuleWhen.empty, then=RuleThen.set, value="1")], FieldType.number)
    assert coerce(f, "") == 1
    assert coerce(f, "   ") == 1
    assert coerce(f, "x 3") == 3          # a real number: empty rule doesn't fire


def test_set_reports_substituted_label():
    f = _f([rule(when=RuleWhen.no_digit, then=RuleThen.set, value="1")], FieldType.number)
    res = run_rules(f, "Guard")
    assert res.value == 1 and res.substituted == "no_digit"
    res2 = run_rules(f, "7")
    assert res2.value == 7 and res2.substituted is None


def test_drop_resolves_to_none_and_flags_dropped():
    f = _f([rule(when=RuleWhen.all_letter, then=RuleThen.drop)], FieldType.number)
    res = run_rules(f, "Guard")
    assert res.value is None and res.dropped is True
    assert coerce(f, "x 7") == 7          # a numeric read is unaffected


# ---- below / above (min/max replacement) ------------------------------------

def test_below_above_drop_out_of_range():
    f = _f([rule(when=RuleWhen.above, arg="16", then=RuleThen.drop)], FieldType.number)
    assert coerce(f, "8") == 8
    assert coerce(f, "16") == 16           # inclusive: above 16 is strictly >
    assert run_rules(f, "81").dropped is True

    g = _f([rule(when=RuleWhen.below, arg="0", then=RuleThen.drop)], FieldType.number)
    assert run_rules(g, "-1").dropped is True
    assert coerce(g, "0") == 0


def test_below_can_clamp_with_set():
    # configurable action: below 1 -> set 1 (a floor), not drop
    f = _f([rule(when=RuleWhen.below, arg="1", then=RuleThen.set, value="1")], FieldType.number)
    assert coerce(f, "0") == 1
    assert coerce(f, "5") == 5


# ---- equal / not_equal / contains -------------------------------------------

def test_equal_and_not_equal():
    f = _f([rule(when=RuleWhen.equal, arg="n/a", then=RuleThen.drop)])
    assert run_rules(f, "N/A").dropped is True   # case-insensitive
    assert coerce(f, "Soma") == "Soma"

    g = _f([rule(when=RuleWhen.not_equal, arg="ok", then=RuleThen.set, value="bad")])
    assert coerce(g, "OK") == "OK"          # equals arg (case-insensitive) -> rule doesn't fire
    assert coerce(g, "whatever") == "bad"   # differs -> set fires


def test_contains():
    f = _f([rule(when=RuleWhen.contains, arg="maxed", then=RuleThen.drop)])
    assert run_rules(f, "Serration (MAXED)").dropped is True
    assert coerce(f, "Serration") == "Serration"


# ---- string / number transforms --------------------------------------------

def test_lowercase_uppercase():
    assert coerce(_f([rule(then=RuleThen.lowercase)]), "Soma PRIME") == "soma prime"
    assert coerce(_f([rule(then=RuleThen.uppercase)]), "Soma prime") == "SOMA PRIME"


def test_fold_accents_rule():
    assert coerce(_f([rule(then=RuleThen.fold)]), "Grineer Bö") == "Grineer Bo"


def test_round_floor_ceil():
    r = _f([rule(then=RuleThen.round)], FieldType.number)
    assert coerce(r, "3.5") == 4
    assert coerce(r, "3.4") == 3
    assert coerce(_f([rule(then=RuleThen.floor)], FieldType.number), "3.9") == 3
    assert coerce(_f([rule(then=RuleThen.ceil)], FieldType.number), "3.1") == 4


# ---- pipeline ordering ------------------------------------------------------

def test_value_flows_top_to_bottom():
    # a transform mutates the running value; a later condition sees the CHANGED value
    f = _f([
        rule(then=RuleThen.uppercase),                              # "abc" -> "ABC"
        rule(when=RuleWhen.contains, arg="ABC", then=RuleThen.set, value="hit"),
    ])
    assert coerce(f, "abc") == "hit"
    # without the uppercase, the lowercase contains would miss (case-insensitive it wouldn't,
    # but this shows the second rule reacts to the first's output)


def test_multiple_transforms_chain():
    f = _f([
        rule(then=RuleThen.extract, strategy=Extract.number_after, sep="/"),   # "7 / 30" -> "30"
        rule(when=RuleWhen.above, arg="50", then=RuleThen.set, value="50"),    # clamp high
    ], FieldType.number)
    assert coerce(f, "7 / 30") == 30
    assert coerce(f, "7 / 80") == 50


def test_drop_early_returns_before_later_rules():
    f = _f([
        rule(when=RuleWhen.empty, then=RuleThen.drop),
        rule(then=RuleThen.set, value="never"),
    ])
    res = run_rules(f, "")
    assert res.dropped is True and res.value is None


# ---- trace ------------------------------------------------------------------

def test_trace_records_each_rule_in_out():
    f = _f([
        rule(then=RuleThen.uppercase),
        rule(when=RuleWhen.contains, arg="X", then=RuleThen.set, value="found"),
    ])
    res = run_rules(f, "axb", trace=True)
    assert [s["out"] for s in res.trace] == ["AXB", "found"]
    assert [s["fired"] for s in res.trace] == [True, True]


def test_invalid_rule_for_type_is_ignored():
    # `contains` is text-only; on a NUMBER field it must be IGNORED (kept but not evaluated),
    # not run — else it would match "3" in "3.5" and wrongly drop the record
    f = _f([rule(when=RuleWhen.contains, arg="3", then=RuleThen.drop)], FieldType.number)
    assert coerce(f, "3.5") == 3.5
    res = run_rules(f, "3.5", trace=True)
    assert res.trace[0]["ignored"] is True and res.trace[0]["fired"] is False


def test_trace_marks_drop():
    f = _f([rule(when=RuleWhen.empty, then=RuleThen.drop)])
    res = run_rules(f, "", trace=True)
    assert res.trace[0]["fired"] is True
    assert res.trace[0]["out"] is None
