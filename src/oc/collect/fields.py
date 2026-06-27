"""Turn raw OCR text into typed field values per the profile schema.

Extraction is driven by a declarative :class:`~oc.profile.models.Extract` strategy
(no user-facing regex). Regex is used only internally to locate numbers.
"""

from __future__ import annotations

import re

from ..profile.models import Extract, FieldDef, FieldType, RuleThen, RuleWhen

_NUMBER_RE = re.compile(r"-?\d[\d,]*\.?\d*")


def _first_number(text: str) -> str | None:
    m = _NUMBER_RE.search(text)
    return m.group(0) if m else None


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


def _apply_extract(field: FieldDef, text: str) -> str | None:
    strat = field.extract
    if strat is Extract.whole:
        return text
    if strat is Extract.number:
        return _first_number(text)
    if strat in (Extract.number_before, Extract.text_before):
        left, _ = _split(text, field.separator)
        return _first_number(left) if strat is Extract.number_before else left
    if strat in (Extract.number_after, Extract.text_after):
        _, right = _split(text, field.separator)
        return _first_number(right) if strat is Extract.number_after else right
    return text


def _to_number(num: str | None) -> float | int | None:
    if num is None:
        return None
    num = num.replace(",", "")
    return float(num) if "." in num else int(num)


def _rule_matches(when: RuleWhen, raw: str, has_digit: bool, has_alpha: bool) -> bool:
    """Whether ``when`` holds for the (stripped) raw read and its precomputed shape."""
    if when is RuleWhen.empty:
        return not raw
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
    if when is RuleWhen.always:
        return True
    return False


def _rule_value(field: FieldDef, value: str) -> str | float | int | None:
    """A ``set`` rule's substituted text coerced to the field's type."""
    if field.type is FieldType.number:
        return _to_number(_first_number(value))
    return value.strip() or None


def coerce_rule(field: FieldDef, raw: str) -> tuple[str | float | int | None, str | None]:
    """``(value, rule)`` — ``rule`` is the ``when`` of the FieldRule that produced the
    value (e.g. "empty" / "all_digit"), or None for a plain read. A rule-produced value
    is configuration, not OCR, so callers shouldn't present it as a confident read.

    Rules run before extraction, in order; the first whose condition matches the raw
    read's shape wins. ``drop`` resolves to None (the cell, and so the record, is
    dropped). With no matching rule the read is extracted/typed normally."""
    raw = raw.strip()
    has_digit = any(c.isdigit() for c in raw)
    has_alpha = any(c.isalpha() for c in raw)

    for rule in field.rules:
        if not _rule_matches(rule.when, raw, has_digit, has_alpha):
            continue
        if rule.then is RuleThen.drop:
            return None, rule.when.value
        return _rule_value(field, rule.value), rule.when.value

    text = _apply_extract(field, raw)

    if field.type is FieldType.number:
        return _to_number(_first_number(text) if text else None), None

    if not text:
        return None, None
    return text.strip() or None, None


def coerce(field: FieldDef, raw: str) -> str | float | int | None:
    return coerce_rule(field, raw)[0]


def out_of_range(field: FieldDef, value: object) -> bool:
    """A genuine number read outside the field's authored ``[min, max]`` — implausible,
    so the caller drops it. Only number values are range-checked; either bound may be
    None (that side unbounded). A None/non-numeric value is never out of range here."""
    if field.type is not FieldType.number or not isinstance(value, (int, float)):
        return False
    if field.min is not None and value < field.min:
        return True
    if field.max is not None and value > field.max:
        return True
    return False
