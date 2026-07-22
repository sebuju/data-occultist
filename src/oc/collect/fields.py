"""Turn a raw OCR read into a typed field value by running the field's RULE PIPELINE.

A field's ``rules`` are an ordered list; the raw read flows through them top-to-bottom
(:class:`~oc.profile.models.FieldRule`). A rule fires when its ``when`` condition holds
against the CURRENT running value; its ``then`` action either rewrites the value and lets
flow continue (``set`` / ``lowercase`` / ``extract`` / ``dictionary`` / …) or, for
``drop``, stops the pipeline and drops the whole record for that cell.

The ``dictionary`` action needs a corrector + the game's vocabulary, which this module has
no access to, so the caller passes a ``dict_hook`` callback (built by
:class:`~oc.learn.resolver.FieldResolver`). Without one, a ``dictionary`` rule is a
pass-through — pure-logic callers/tests don't need a dictionary.
"""

from __future__ import annotations

import math
import re
import statistics
import unicodedata
from dataclasses import dataclass

from ..profile.models import Extract, FieldDef, FieldType, RuleThen, RuleWhen

_NUMBER_RE = re.compile(r"-?\d[\d,]*\.?\d*")


def fold_accents(text: str) -> str:
    """Strip diacritics, mapping accented characters to their plain ASCII base
    ("ö" -> "o", "ä" -> "a", "é" -> "e"). Decomposes via NFKD and drops the combining
    marks; characters with no decomposition pass through unchanged."""
    return "".join(c for c in unicodedata.normalize("NFKD", text)
                   if not unicodedata.combining(c))


def _first_number(text: str) -> str | None:
    m = _NUMBER_RE.search(text)
    return m.group(0) if m else None


def _alnum(text: str) -> str:
    """Keep letters, digits and whitespace, drop every other symbol, then collapse
    whitespace runs to a single space and strip the ends ("Lith G1 (rad)" -> "Lith G1 rad")."""
    return " ".join(re.sub(r"[^0-9A-Za-z\s]", " ", text).split())


def _split(text: str, sep: str) -> tuple[str, str]:
    """Split on the first occurrence of ``sep``, case-insensitively (OCR casing is
    unreliable, so a word separator like "Rank" must still match "RANK"). The
    returned halves keep the text's original casing. No match -> all on the left,
    mirroring ``str.partition``."""
    sep = sep or "/"
    idx = text.lower().find(sep.lower())
    if idx < 0:
        return text.strip(), ""
    return text[:idx].strip(), text[idx + len(sep):].strip()


def _apply_extract(strategy: Extract, sep: str, text: str) -> str:
    """Pull a piece out of ``text`` per an :class:`Extract` strategy. Returns "" when the
    strategy finds nothing (e.g. no number present), so the pipeline value stays a string."""
    if strategy is Extract.whole:
        return text
    if strategy is Extract.text:
        return text.strip()
    if strategy is Extract.number:
        return _first_number(text) or ""
    if strategy is Extract.alphanum:
        return _alnum(text)
    # the *_before / *_after family: split, then pull number / alphanum / whole-text from one side
    left, right = _split(text, sep)
    side = left if strategy.value.endswith("_before") else right
    if strategy in (Extract.number_before, Extract.number_after):
        return _first_number(side) or ""
    if strategy in (Extract.alphanum_before, Extract.alphanum_after):
        return _alnum(side)
    return side


def _to_number(num: str | None) -> float | int | None:
    if num is None:
        return None
    num = num.replace(",", "")
    try:
        return float(num) if "." in num else int(num)
    except ValueError:
        return None


@dataclass
class DictOutcome:
    """A ``dictionary`` rule's result, produced by the resolver's ``dict_hook``."""
    value: object                   # corrected text, or None when the read is dropped
    dropped: bool = False           # a drop-mode dictionary rejected an unknown word
    corrected: bool = False         # a word snapped to the vocabulary
    score: float = 1.0              # worst word-correction similarity (1.0 when unchanged)
    verified: str | None = None     # dict/split/fuzzy, else None


@dataclass
class RuleResult:
    """The pipeline's product for one read. ``substituted`` is the ``when`` label of a
    ``set`` rule that authored the value (config, not OCR — the caller shouldn't sink the
    record on its confidence); None for a value derived from the genuine read."""
    value: object = None
    dropped: bool = False           # a ``drop`` action (or a drop-mode dictionary) fired
    prune: bool = False             # a ``prune`` action fired -> caller actively removes the key
    substituted: str | None = None
    corrected: bool = False
    score: float = 1.0
    verified: str | None = None
    trace: list | None = None       # [{i, when, then, "in", out, fired}] when trace=True


# Which field types each condition / action is valid for (MIRRORS node_parts.js RULE_WHEN /
# RULE_THEN type codes — keep the two in sync). Codes: any | t=text | n=number |
# tn=text+number | nc=number+count(pips/diamonds). A rule whose when OR then is invalid for the
# field's type is IGNORED (skipped, not run) — it stays authored so switching the type back
# restores it, but it can't act on a type it doesn't fit.
_WHEN_TYPES = {
    "always": "any", "empty": "any", "no_digit": "tn", "all_digit": "tn", "has_digit": "tn",
    "no_letter": "tn", "all_letter": "tn", "has_letter": "tn", "below": "nc", "above": "nc",
    "equal": "any", "not_equal": "any", "contains": "t",
}
_THEN_TYPES = {
    "set": "any", "drop": "any", "blank": "any", "prune": "any", "lowercase": "t", "uppercase": "t",
    "fold": "t", "round": "n", "floor": "n", "ceil": "n", "decimal": "n", "extract": "tn",
    "dictionary": "t",
}


def _type_ok(code: str, ftype: str) -> bool:
    if code == "any":
        return True
    if code == "t":
        return ftype == "text"
    if code == "n":
        return ftype == "number"
    if code == "tn":
        return ftype in ("text", "number")
    if code == "nc":
        return ftype in ("number", "pips", "diamonds")
    return False


def rule_applies(rule: object, ftype: str) -> bool:
    """Whether a rule can run against a field of ``ftype`` (both its when and then fit)."""
    return (_type_ok(_WHEN_TYPES.get(rule.when.value, "any"), ftype)
            and _type_ok(_THEN_TYPES.get(rule.then.value, "any"), ftype))


def _matches(when: RuleWhen, value: str, arg: str) -> bool:
    """Whether ``when`` holds for the current running ``value`` (and ``arg`` for the
    operand conditions)."""
    if when is RuleWhen.always:
        return True
    if when is RuleWhen.empty:
        return not value
    has_digit = any(c.isdigit() for c in value)
    has_alpha = any(c.isalpha() for c in value)
    if when is RuleWhen.no_digit:
        return not has_digit
    if when is RuleWhen.all_digit:
        return has_digit and not has_alpha
    if when is RuleWhen.has_digit:
        return has_digit
    if when is RuleWhen.no_letter:
        return not has_alpha
    if when is RuleWhen.all_letter:
        return has_alpha and not has_digit
    if when is RuleWhen.has_letter:
        return has_alpha
    if when in (RuleWhen.below, RuleWhen.above):
        n = _to_number(_first_number(value))
        a = _to_number(_first_number(arg))
        if n is None or a is None:
            return False
        return n < a if when is RuleWhen.below else n > a
    if when in (RuleWhen.equal, RuleWhen.not_equal):
        eq = value.strip().lower() == arg.strip().lower()
        return eq if when is RuleWhen.equal else not eq
    if when is RuleWhen.contains:
        return bool(arg) and arg.lower() in value.lower()
    if when is RuleWhen.in_list:
        opts = [a.strip().lower() for a in arg.split(",") if a.strip()]
        return value.strip().lower() in opts
    return False


_LEADING_ZERO_RE = re.compile(r"^0\d+$")


def _decimal_zero(value: str) -> str:
    """Restore a decimal point OCR dropped from a sub-1 reading: an all-digit value with a
    leading zero and no dot ("05", "025") is the fingerprint of a "0.x" number that lost its
    point, so re-insert it right after the leading zero ("05" -> "0.5", "025" -> "0.25").
    Anything else (no leading zero, already has a dot, empty, non-digit) passes through
    unchanged."""
    s = value.strip()
    return "0." + s[1:] if _LEADING_ZERO_RE.match(s) else value


def _round(then: RuleThen, value: str) -> str:
    n = _to_number(_first_number(value))
    if n is None:
        return value
    if then is RuleThen.round:
        return str(round(n))
    if then is RuleThen.floor:
        return str(math.floor(n))
    return str(math.ceil(n))


def _finalize(ftype: str, value: str) -> object:
    """Type the surviving pipeline value: a number field parses out its number; a text
    field keeps the stripped string. Empty -> None."""
    if ftype == FieldType.number.value:
        return _to_number(_first_number(value)) if value else None
    return value.strip() or None


def run_rules(field: FieldDef, raw: str, *, dict_hook=None,
              confidence: float = 1.0, trace: bool = False) -> RuleResult:
    """Run ``field``'s rule pipeline over the ``raw`` read. See the module docstring.

    Thin wrapper over :func:`run_rule_pipeline` — the shared core a standalone process node
    (:class:`oc.profile.models.ProcessDef`) drives with its own ``rules``/``type``, so the two
    never diverge. ``dict_hook`` / ``confidence`` / ``trace`` pass straight through."""
    return run_rule_pipeline(field.rules, field.type.value, raw,
                             dict_hook=dict_hook, confidence=confidence, trace=trace)


def run_rule_pipeline(rules: list, ftype: str, raw: str, *, dict_hook=None,
                      confidence: float = 1.0, trace: bool = False) -> RuleResult:
    """Run an ordered ``rules`` pipeline of the given field ``ftype`` over the ``raw`` read.
    See the module docstring for the pipeline semantics.

    ``dict_hook(value, rule, confidence) -> DictOutcome`` services ``dictionary`` rules;
    omit it for pure value logic (those rules then pass through). ``trace`` records each
    rule's in/out value for the node debug panel."""
    result = RuleResult()
    value = raw.strip()
    steps: list | None = [] if trace else None

    for i, rule in enumerate(rules):
        vin = value
        if not rule_applies(rule, ftype):   # invalid for this field type -> ignored (kept, not run)
            if steps is not None:
                steps.append({"i": i, "when": rule.when.value, "then": rule.then.value,
                              "in": vin, "out": vin, "fired": False, "ignored": True})
            continue
        fired = _matches(rule.when, value, rule.arg)
        dropped = False
        blanked = False
        pruned = False
        if fired:
            then = rule.then
            if then is RuleThen.drop:
                dropped = True
            elif then is RuleThen.blank:
                blanked = True    # emit None and forward it (a gap), NOT a dropped record
            elif then is RuleThen.prune:
                pruned = True     # emit None; caller actively removes this record's key
            elif then is RuleThen.set:
                result.substituted = rule.when.value   # authored value, not a genuine read
                value = rule.value
            elif then is RuleThen.lowercase:
                value = value.lower()
            elif then is RuleThen.uppercase:
                value = value.upper()
            elif then is RuleThen.fold:
                value = fold_accents(value)
            elif then in (RuleThen.round, RuleThen.floor, RuleThen.ceil):
                value = _round(then, value)
            elif then is RuleThen.decimal:
                value = _decimal_zero(value)
            elif then is RuleThen.extract:
                value = _apply_extract(rule.strategy, rule.sep, value)
            elif then is RuleThen.dictionary and dict_hook is not None:
                out = dict_hook(value, rule, confidence)
                if out.dropped:
                    dropped = True
                else:
                    if out.value is not None:
                        value = str(out.value)
                    result.corrected = result.corrected or out.corrected
                    result.score = min(result.score, out.score)
                    if out.verified is not None:
                        result.verified = out.verified
        if steps is not None:
            steps.append({"i": i, "when": rule.when.value, "then": rule.then.value,
                          "in": vin, "out": (None if dropped or blanked or pruned else value),
                          "fired": fired})
        if dropped:
            result.value, result.dropped, result.trace = None, True, steps
            return result
        if blanked:
            result.value, result.dropped, result.trace = None, False, steps   # null forwarded, not dropped
            return result
        if pruned:
            result.value, result.prune, result.trace = None, True, steps
            return result

    result.value = _finalize(ftype, value)
    result.trace = steps
    return result


def coerce(field: FieldDef, raw: str) -> object:
    """Convenience: the final value from the rule pipeline (no dictionary)."""
    return run_rules(field, raw).value


# ---------------------------------------------------------------------------
# Register ring folds — the algorithms behind RegisterDef.aggregate, collapsing a key's rolling
# ring of held values (oldest -> newest) to the ONE value the register exposes. Pure, ring-
# plumbing-free: the caller (LiveSession._aggregate_ring) builds the ring/coerces numbers/applies
# the ring's own decimal-precision rounding; these functions just implement each fold's algorithm.
# Kept here (not live.py) per rule 7 — one home, unit-testable off-Windows, same story
# run_rule_pipeline already tells for field correction.
# ---------------------------------------------------------------------------

def quality_ok(value: object, ftype: str) -> bool:
    """Whether one ring entry is expected-QUALITY for its field ``ftype`` — the restored
    ``readout_stability`` misfire check, now scoped to a ring member instead of a live tick. The
    confidence floor is NOT re-checked here: a sub-floor/dropped read never reaches the ring (it's
    recorded as an explicit ``None`` gap by ``LiveSession._feed_registers``), so a gap is already
    not-ok. Numeric-typed (number/pips/diamonds): the value must actually parse as a number.
    Text/symbol: any non-empty value is the expected type."""
    if value is None or value == "":
        return False
    if ftype in (FieldType.number.value, FieldType.pips.value, FieldType.diamonds.value):
        return _to_number(_first_number(str(value))) is not None
    return str(value).strip() != ""


def quality_fold(values: list, ftype: str, k: float = 0) -> object:
    """The restored per-readout consensus gate (``readout_stability.gate_readouts``), reframed as
    a ring fold: surface the ring TAIL when at least ``k`` of the ring's entries are
    :func:`quality_ok` for ``ftype``; otherwise HOLD -- expose the newest entry that IS
    quality-ok (the last good read still retained in the ring). An all-bad ring falls back to the
    tail, like every other fold's empty-input case. Keys on TYPE not value, so a legitimately
    fast-changing number never lags -- only a burst where reads stop looking like the field's type
    suppresses the exposed value. ``k`` <= 0 -> default to ``ceil(len(values)/2)``; clamped to
    ``1..len(values)``."""
    if not values:
        return None
    tail = values[-1]
    n = len(values)
    kk = int(k) if k and k > 0 else -(-n // 2)   # ceil(n/2) default
    kk = max(1, min(kk, n))
    good = sum(1 for v in values if quality_ok(v, ftype))
    if good >= kk:
        return tail
    for v in reversed(values):
        if quality_ok(v, ftype):
            return v
    return tail


def cluster_fold(values: list, tol: float = 0.0) -> object:
    """Numeric majority-within-tolerance: bucket the ring's numeric members within +/-``tol``
    (default 0 = exact match) of each other, and expose the NEWEST member of the LARGEST bucket --
    the numeric cousin of the ``common`` fold's text majority vote, and the sharpest reject of a
    non-repeating OCR misread (a lone ``400`` among ``4.00`` reads loses even when it's the latest
    read). Falls back to the ring tail when nothing in it parses as a number."""
    idxed = [(i, v) for i, v in enumerate(values) if v is not None and v != ""]
    nums = [(i, n) for i, v in idxed if (n := _to_number(_first_number(str(v)))) is not None]
    if not nums:
        return values[-1] if values else None
    buckets: list[list[tuple[int, float]]] = []
    for i, n in nums:
        for b in buckets:
            if abs(b[-1][1] - n) <= tol:
                b.append((i, n))
                break
        else:
            buckets.append([(i, n)])
    # largest bucket wins; a SIZE TIE breaks to the bucket holding the newest member (mirrors the
    # `common` fold's own tie -> newest rule).
    best = max(buckets, key=lambda b: (len(b), max(i for i, _ in b)))
    newest_i = max(i for i, _ in best)
    return values[newest_i]


def _ring_quantum(values: list) -> float:
    """Half the smallest step the ring's own reads can express — ``4.00``/``3.75`` carry two
    decimals, so the display quantum is ``0.01`` and this returns ``0.005``. Used as the FLOOR on
    :func:`track_fold`'s tolerance: a perfectly-linear ring has zero residual spread, and without a
    floor every legitimate quantization wobble would miss the prediction and be rejected. Mirrors
    ``LiveSession._ring_decimals``'s string scan rather than importing it (these folds stay pure)."""
    dec = 0
    for v in values or []:
        if v is None or v == "":
            continue
        s = str(v)
        dot = s.find(".")
        if dot >= 0:
            dec = max(dec, len(s) - dot - 1)
    return 0.5 * (10.0 ** -dec)


def track_fold(values: list, times: list, tol: float = 0.0) -> object:
    """Time-aware plausibility gate: expose the newest read that fits the ring's OWN trend line.

    Where ``quality`` only asks "does this parse as the right TYPE" (so a noise ``1`` among ``4.00``
    reads sails through), this fold asks "could the value have GOT here in the time that passed".
    A countdown read as ``4`` and then ``1`` a quarter-second later is impossible; that impossibility
    is what identifies the bad read. Nothing here is game-specific -- the ring teaches the fold its
    own rate.

    ``times`` is the per-sample wall clock parallel to ``values`` (see ``LiveSession._feed_registers``).
    Sample spacing is genuinely non-uniform (the collector's OCR gate skips heavy ticks), so the fit
    is against TIME, never sample index.

    The model is fitted on the PRIOR samples and used to judge the newest one -- never on the whole
    ring at once, or the very read under test would contaminate the model meant to catch it:

    1. numeric ``(t, v)`` points, oldest -> newest (blanks / non-numerics / timeless points dropped);
    2. fewer than 3 prior points -> return the tail (nothing to model yet);
    3. Theil-Sen fit on the prior: ``slope`` = median of pairwise slopes, ``intercept`` =
       ``median(v - slope*t)``. Median-based, so a bad sample already sitting in the ring can't
       drag the line;
    4. ``tol`` (when > 0) wins outright; else ``3 * MAD`` of the prior's residuals, floored at half
       the ring's typical step (MAD is degenerate on a short prior -- see the comment below) and at
       :func:`_ring_quantum`;
    5. newest within ``tol`` of ``intercept + slope*t_newest`` -> expose it; otherwise HOLD -- the
       newest PRIOR sample whose own residual fits;
    6. nothing fits -> the tail, like every other fold's fallback.

    A SELECTOR fold: it returns an existing ring member unrounded and never the synthesized
    prediction -- the register exposes a value that was actually read.

    Needs >= 4 numeric samples to do anything at all (3 prior + the newest); a capacity of 6-8+
    gives the Theil-Sen fit enough pairs to be genuinely robust.

    RESET behaviour (a countdown hits 0 and restarts): the ring straddles two lines, the fit
    degrades, and typically nothing fits -- step 6 then falls back to the tail, so the fold
    degrades to plain ``latest`` for a few ticks rather than locking onto a stale pre-reset value.
    That is why step 6 returns the tail instead of holding."""
    tail = values[-1] if values else None
    if not values or not times:
        return tail
    # (time, number, ring index) — the index rides along so the HOLD below can return the RAW ring
    # member (unrounded, as read) rather than the coerced float.
    pts: list[tuple[float, float, int]] = []
    for i, (v, t) in enumerate(zip(values, times)):
        if v is None or v == "" or t is None:
            continue
        n = _to_number(_first_number(str(v)))
        if n is None:
            continue
        pts.append((float(t), float(n), i))
    if len(pts) < 4:   # 3 prior + the newest
        return tail
    prior, (t_new, v_new, _) = pts[:-1], pts[-1]
    slopes = [(b[1] - a[1]) / (b[0] - a[0])
              for i, a in enumerate(prior) for b in prior[i + 1:] if b[0] != a[0]]
    if not slopes:
        return tail
    slope = statistics.median(slopes)
    intercept = statistics.median([v - slope * t for t, v, _ in prior])
    resid = [v - (intercept + slope * t) for t, v, _ in prior]
    mad = statistics.median([abs(r) for r in resid])
    # MAD alone is DEGENERATE on a short prior: a Theil-Sen line through 3 points passes exactly
    # through most of them, so the residuals come out [0, x, 0] and the median is 0 -- collapsing
    # the window onto the quantum floor, which is tighter than any real OCR jitter. Floor it at
    # half the ring's own typical STEP instead, so the tolerance scales with how fast the value
    # actually moves (a 0.25/sample countdown tolerates 0.125; a static ring falls back to MAD).
    steps = [abs(b[1] - a[1]) for a, b in zip(prior, prior[1:])]
    step_floor = 0.5 * statistics.median(steps) if steps else 0.0
    window = tol if tol and tol > 0 else max(3.0 * mad, step_floor, _ring_quantum(values))
    if abs(v_new - (intercept + slope * t_new)) <= window:
        return values[-1]
    # HOLD: the newest prior sample that fits the trend itself.
    fitted = [p[2] for p, r in zip(prior, resid) if abs(r) <= window]
    return values[fitted[-1]] if fitted else tail


def ema_fold(nums: list, alpha: float = 0.5) -> float | None:
    """Exponential moving average over the ring, oldest -> newest, newest-weighted. ``alpha`` in
    (0, 1] (a non-positive/out-of-range arg falls back to 0.5); ``alpha=1`` reduces to the tail."""
    if not nums:
        return None
    a = alpha if 0 < alpha <= 1 else 0.5
    acc = nums[0]
    for v in nums[1:]:
        acc = a * v + (1 - a) * acc
    return acc


def wma_fold(nums: list) -> float | None:
    """Linear weighted moving average: each ring value weighted by its position (1..N, oldest to
    newest), so the newest sample carries the most weight without a full exponential decay."""
    if not nums:
        return None
    weights = range(1, len(nums) + 1)
    return sum(v * w for v, w in zip(nums, weights)) / sum(weights)


def trimmed_fold(nums: list, trim: float = 1) -> float | None:
    """Trimmed mean: drop the ``trim`` highest and ``trim`` lowest values, then average what's
    left -- kills a symmetric spike (a wrong-direction OCR misread) without median's all-or-
    nothing quantization. Falls back to the plain mean when trimming would empty the set."""
    if not nums:
        return None
    t = max(0, int(trim))
    s = sorted(nums)
    core = s[t: len(s) - t] if len(s) > 2 * t else s
    return statistics.fmean(core) if core else statistics.fmean(nums)


def winsor_fold(nums: list, clamp: float = 1) -> float | None:
    """Winsorized mean: clamp the ``clamp`` highest/lowest values IN to the nearest surviving
    bound instead of dropping them, then average -- keeps the sample count but blunts outliers."""
    if not nums:
        return None
    c = max(0, int(clamp))
    s = sorted(nums)
    if c == 0 or len(s) <= 2 * c:
        return statistics.fmean(s)
    lo, hi = s[c], s[-c - 1]
    return statistics.fmean([min(max(v, lo), hi) for v in nums])


def midrange_fold(nums: list) -> float | None:
    """(min + max) / 2 -- the cheapest spread-agnostic center."""
    return (max(nums) + min(nums)) / 2 if nums else None


def range_fold(nums: list) -> float | None:
    """max - min -- the ring's spread this window."""
    return max(nums) - min(nums) if nums else None


def delta_fold(nums: list) -> float | None:
    """newest - oldest (signed) -- net change / direction over the ring."""
    return nums[-1] - nums[0] if nums else None


def stdev_fold(nums: list) -> float | None:
    """Population standard deviation of the ring (0.0 for a single sample)."""
    if not nums:
        return None
    return statistics.pstdev(nums) if len(nums) > 1 else 0.0


def mad_fold(nums: list) -> float | None:
    """Median absolute deviation from the ring's median -- a robust spread measure."""
    if not nums:
        return None
    center = statistics.median(nums)
    return statistics.median([abs(x - center) for x in nums])


def distinct_count(values: list) -> int:
    """# of distinct non-blank values (by text form) in the ring."""
    return len({str(v) for v in values if v not in (None, "")})


def changes_count(values: list) -> int:
    """# of adjacent non-blank value changes in the ring -- a cheap volatility signal."""
    members = [v for v in values if v not in (None, "")]
    return sum(1 for a, b in zip(members, members[1:]) if str(a) != str(b))


def nonblank_count(values: list) -> int:
    """# of non-blank (non-None, non-empty) reads currently retained in the ring."""
    return sum(1 for v in values if v not in (None, ""))
