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
    "set": "any", "drop": "any", "lowercase": "t", "uppercase": "t", "fold": "t",
    "round": "n", "floor": "n", "ceil": "n", "decimal": "n", "extract": "tn", "dictionary": "t",
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


def _finalize(field: FieldDef, value: str) -> object:
    """Type the surviving pipeline value: a number field parses out its number; a text
    field keeps the stripped string. Empty -> None."""
    if field.type is FieldType.number:
        return _to_number(_first_number(value)) if value else None
    return value.strip() or None


def run_rules(field: FieldDef, raw: str, *, dict_hook=None,
              confidence: float = 1.0, trace: bool = False) -> RuleResult:
    """Run ``field``'s rule pipeline over the ``raw`` read. See the module docstring.

    ``dict_hook(value, rule, confidence) -> DictOutcome`` services ``dictionary`` rules;
    omit it for pure value logic (those rules then pass through). ``trace`` records each
    rule's in/out value for the node debug panel."""
    result = RuleResult()
    value = raw.strip()
    steps: list | None = [] if trace else None

    ftype = field.type.value
    for i, rule in enumerate(field.rules):
        vin = value
        if not rule_applies(rule, ftype):   # invalid for this field type -> ignored (kept, not run)
            if steps is not None:
                steps.append({"i": i, "when": rule.when.value, "then": rule.then.value,
                              "in": vin, "out": vin, "fired": False, "ignored": True})
            continue
        fired = _matches(rule.when, value, rule.arg)
        dropped = False
        if fired:
            then = rule.then
            if then is RuleThen.drop:
                dropped = True
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
                          "in": vin, "out": (None if dropped else value), "fired": fired})
        if dropped:
            result.value, result.dropped, result.trace = None, True, steps
            return result

    result.value = _finalize(field, value)
    result.trace = steps
    return result


def coerce(field: FieldDef, raw: str) -> object:
    """Convenience: the final value from the rule pipeline (no dictionary)."""
    return run_rules(field, raw).value
