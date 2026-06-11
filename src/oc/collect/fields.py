"""Turn raw OCR text into typed field values per the profile schema.

Extraction is driven by a declarative :class:`~oc.profile.models.Extract` strategy
(no user-facing regex). Regex is used only internally to locate numbers.
"""

from __future__ import annotations

import re

from ..profile.models import Extract, FieldDef, FieldType

_NUMBER_RE = re.compile(r"-?\d[\d,]*\.?\d*")


def _first_number(text: str) -> str | None:
    m = _NUMBER_RE.search(text)
    return m.group(0) if m else None


def _split(text: str, sep: str) -> tuple[str, str]:
    sep = sep or "/"
    left, _, right = text.partition(sep)
    return left.strip(), right.strip()


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


def coerce_rule(field: FieldDef, raw: str) -> tuple[str | float | int | None, str | None]:
    """``(value, rule)`` — ``rule`` names the fallback that produced the value
    ("empty" / "if_number" / "if_text"), or None for a real read. A substituted value
    is configuration, not OCR, so callers shouldn't present it as a confident read."""
    raw = raw.strip()

    # "empty" means OCR detected no text and no numbers at all. For a NUMBER field a
    # digitless read also counts as empty (see below): icon art OCR'd as stray glyphs
    # ('人', '#') is not text, so a box holding only an icon reads as "no number here".
    # For a TEXT field junk does not fall back — if_number handles type mismatches.
    if not raw:
        if field.empty is None:
            return None, None
        if field.type is FieldType.number:
            return _to_number(_first_number(field.empty)), "empty"
        return field.empty.strip() or None, "empty"

    has_digit = any(c.isdigit() for c in raw)
    has_alpha = any(c.isalpha() for c in raw)

    # a text field that read numbers / a number field that read text substitutes its
    # configured value; the *_any flag fires on "contains", default on "is entirely"
    if field.type is FieldType.text and field.if_number is not None:
        if has_digit if field.if_number_any else (has_digit and not has_alpha):
            return field.if_number.strip() or None, "if_number"
    if field.type is FieldType.number and field.if_text is not None:
        # default mode is "no digits at all", not "has letters": OCR junk off an icon
        # in the box is often symbol-only ('#', '@') — still not a number
        if has_alpha if field.if_text_any else not has_digit:
            return _to_number(_first_number(field.if_text)), "if_text"

    text = _apply_extract(field, raw)

    if field.type is FieldType.number:
        if not has_digit and field.empty is not None:
            # no digits anywhere = no number was rendered; whatever OCR picked up is
            # a marker icon (built-status, equipped, ...) — same as an empty box
            return _to_number(_first_number(field.empty)), "empty"
        return _to_number(_first_number(text) if text else None), None

    if not text:
        return None, None
    return text.strip() or None, None


def coerce(field: FieldDef, raw: str) -> str | float | int | None:
    return coerce_rule(field, raw)[0]
