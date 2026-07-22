from oc.collect.fields import (
    changes_count,
    cluster_fold,
    coerce,
    delta_fold,
    distinct_count,
    ema_fold,
    mad_fold,
    midrange_fold,
    nonblank_count,
    quality_fold,
    quality_ok,
    range_fold,
    run_rules,
    stdev_fold,
    track_fold,
    trimmed_fold,
    winsor_fold,
    wma_fold,
)
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


def test_blank_resolves_to_none_but_not_dropped():
    # `blank` early-returns None like `drop`, but leaves dropped=False -> the value is FORWARDED
    # as a gap (a process emits key->None; the record is NOT failed). Distinct from `drop`.
    f = _f([rule(when=RuleWhen.all_letter, then=RuleThen.blank)], FieldType.number)
    res = run_rules(f, "Guard")
    assert res.value is None and res.dropped is False
    assert coerce(f, "x 7") == 7          # a numeric read is unaffected


def test_blank_early_returns_before_later_rules():
    f = _f([
        rule(when=RuleWhen.empty, then=RuleThen.blank),
        rule(when=RuleWhen.always, then=RuleThen.set, value="LATE"),
    ])
    res = run_rules(f, "")
    assert res.value is None and res.dropped is False   # blank stopped the pipeline before `set`


def test_prune_resolves_to_none_and_flags_prune_not_dropped():
    # `prune` early-returns None like `drop`/`blank`, but flags `prune` (not `dropped`) — the
    # caller keeps the cell identified and actively removes its key, rather than sinking the
    # whole record as unread (which mirror-sync could never react to).
    f = _f([rule(when=RuleWhen.equal, arg="0", then=RuleThen.prune)], FieldType.number)
    res = run_rules(f, "0")
    assert res.value is None and res.prune is True and res.dropped is False
    assert coerce(f, "7") == 7          # a non-matching read is unaffected, prune stays False


def test_prune_early_returns_before_later_rules():
    f = _f([
        rule(when=RuleWhen.equal, arg="0", then=RuleThen.prune),
        rule(when=RuleWhen.always, then=RuleThen.set, value="LATE"),
    ])
    res = run_rules(f, "0")
    assert res.value is None and res.prune is True   # prune stopped the pipeline before `set`


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


# ---- register ring folds (RegisterDef.aggregate) -----------------------------
# The restored per-readout consensus gate (quality_ok/quality_fold) + the rest of the
# denoise/central/spread roster live here as pure functions; LiveSession._aggregate_ring just
# plumbs the ring + rounds. See tests/test_register_ring.py for the end-to-end register wiring.

def test_quality_ok_by_type():
    assert quality_ok("4.00", FieldType.number.value) is True
    assert quality_ok("garbage", FieldType.number.value) is False
    assert quality_ok("", FieldType.number.value) is False
    assert quality_ok(None, FieldType.number.value) is False
    assert quality_ok("Soma Prime", FieldType.text.value) is True
    assert quality_ok("", FieldType.text.value) is False


def test_quality_fold_holds_while_enough_recent_reads_are_bad():
    # 3 of the last 4 are non-numeric ("garbage" x3) -> below K=2 default (ceil(4/2)) is NOT the
    # case here (good=1 < k=2) -> HOLD the newest good (quality-ok) entry, not the tail.
    vals = ["4.00", "garbage", "garbage", "garbage"]
    assert quality_fold(vals, FieldType.number.value, 0) == "4.00"


def test_quality_fold_surfaces_when_k_of_m_are_good():
    # 3 of 4 are good numeric reads -> default K=2 is met -> surfaces the tail (newest read)
    vals = ["1", "2", "garbage", "4"]
    assert quality_fold(vals, FieldType.number.value, 0) == "4"


def test_quality_fold_explicit_k_clamped():
    vals = ["1", "2", "3"]
    # k > len(values) clamps to len(values): all 3 must be good -> they are -> tail surfaces
    assert quality_fold(vals, FieldType.number.value, 99) == "3"


def test_quality_fold_all_bad_falls_back_to_tail():
    vals = ["a", "b", "c"]
    assert quality_fold(vals, FieldType.number.value, 2) == "c"


def test_quality_fold_empty_ring():
    assert quality_fold([], FieldType.number.value, 1) is None


def test_cluster_fold_picks_newest_of_largest_bucket():
    # a lone "400" among "4.00"-ish reads loses even though it's the latest read
    vals = ["4", "4", "4", "400"]
    assert cluster_fold(vals, 0.0) == "4"


def test_cluster_fold_tolerance_widens_bucket():
    vals = ["4.0", "4.1", "4.2"]
    assert cluster_fold(vals, 0.0) == "4.2"          # exact match -> each its own bucket -> newest wins by tie
    assert cluster_fold(vals, 0.5) == "4.2"          # all within tolerance of one another -> one bucket, newest


def test_cluster_fold_no_numeric_members_falls_back_to_tail():
    assert cluster_fold(["a", "b"], 0.0) == "b"


def test_track_fold_rejects_a_read_the_elapsed_time_could_not_produce():
    # the countdown case: 4.00 -> 3.75 -> 3.50 falls at 1.0/s, so a "1" a quarter-second later is
    # impossible (it would need 10/s). `quality` passes this straight through -- a bare 1 IS a valid
    # number -- so this is the gap `track` exists to cover. HOLD the newest read that fits.
    vals = ["4.00", "3.75", "3.50", "1"]
    times = [0.0, 0.25, 0.50, 0.75]
    assert track_fold(vals, times, 0) == "3.50"


def test_track_fold_accepts_an_on_trend_read():
    times = [0.0, 0.25, 0.50, 0.75]
    assert track_fold(["4.00", "3.75", "3.50", "3.25"], times, 0) == "3.25"


def test_track_fold_tolerates_ocr_jitter():
    # a Theil-Sen line through 3 points passes exactly through most of them, so the residual MAD
    # collapses to 0 -- the tolerance must floor at half the ring's typical STEP (here 0.125), or
    # every real read's quantization wobble would be rejected.
    times = [0.0, 0.25, 0.50, 0.75]
    assert track_fold(["4.00", "3.74", "3.51", "3.25"], times, 0) == "3.25"


def test_track_fold_uneven_sample_spacing_fits_against_time_not_index():
    # samples 1s apart then a 4s gap: the value moved 4 units over that gap, which is ON trend at
    # 1.0/s. Fitting against sample INDEX instead would call it a 4x jump and reject it.
    vals = ["60", "59", "58", "54"]
    times = [0.0, 1.0, 2.0, 6.0]
    assert track_fold(vals, times, 0) == "54"


def test_track_fold_needs_four_numeric_samples():
    # 3 prior + the newest; anything shorter has nothing to model -> the tail, like every fold
    assert track_fold(["4.00", "3.75", "3.50"], [0.0, 0.25, 0.50], 0) == "3.50"


def test_track_fold_explicit_tolerance_overrides_the_derived_window():
    vals = ["4.00", "3.75", "3.50", "1"]
    times = [0.0, 0.25, 0.50, 0.75]
    assert track_fold(vals, times, 5.0) == "1"      # wide enough to accept the spike
    assert track_fold(vals, times, 0.01) == "3.50"  # tight -> still held


def test_track_fold_skips_gaps_and_non_numeric_members():
    # a dropped read (None) carries no value to fit; it's skipped, not treated as 0
    vals = ["4.00", None, "3.75", "3.50", "1"]
    times = [0.0, 0.10, 0.25, 0.50, 0.75]
    assert track_fold(vals, times, 0) == "3.50"


def test_track_fold_non_numeric_ring_falls_back_to_tail():
    assert track_fold(["a", "b", "c", "d"], [0.0, 1.0, 2.0, 3.0], 0) == "d"


def test_track_fold_without_times_falls_back_to_tail():
    # a caller that didn't plumb the per-sample clock gets the tail, never a wrong answer
    assert track_fold(["4.00", "3.75", "3.50", "1"], [], 0) == "1"
    assert track_fold([], [], 0) is None


def test_track_fold_static_ring_rejects_a_sudden_spike():
    # slope 0 is a trend like any other -> a lone 93 among 7s doesn't fit it
    assert track_fold(["7", "7", "7", "7", "93"], [0.0, 1.0, 2.0, 3.0, 4.0], 0) == "7"


def test_ema_fold_weights_newest_more():
    assert ema_fold([10, 20], 0.5) == 15.0
    assert ema_fold([10, 20], 1.0) == 20.0   # alpha=1 -> reduces to the tail
    assert ema_fold([], 0.5) is None


def test_trimmed_fold_drops_extremes():
    assert trimmed_fold([1, 2, 3, 4, 100], 1) == 3.0   # drop 1 low (1) + 1 high (100) -> mean(2,3,4)


def test_winsor_fold_clamps_extremes():
    # clamp the 1 lowest/highest IN to the nearest surviving bound, then average
    assert winsor_fold([1, 2, 3, 4, 100], 1) == 3.0   # [2,2,3,4,4] -> mean 3.0


def test_wma_fold_weights_by_position():
    # weights 1,2,3 -> (10*1 + 20*2 + 30*3) / 6 = 140/6
    assert wma_fold([10, 20, 30]) == 140 / 6


def test_midrange_fold():
    assert midrange_fold([10, 20, 30]) == 20.0


def test_range_and_delta_fold():
    assert range_fold([10, 30, 20]) == 20
    assert delta_fold([10, 30, 20]) == 10   # newest(20) - oldest(10), signed


def test_stdev_and_mad_fold():
    assert stdev_fold([1, 1, 1]) == 0.0
    assert stdev_fold([]) is None
    assert mad_fold([1, 2, 3, 4, 100]) == 1.0   # median 3, deviations [2,1,0,1,97] -> median 1


def test_count_folds():
    ring = ["a", "a", None, "", "b"]
    assert distinct_count(ring) == 2
    assert nonblank_count(ring) == 3
    assert changes_count(ring) == 1   # non-blank members a,a,b -> one change (a->b)
