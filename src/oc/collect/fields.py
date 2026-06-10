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


def coerce(field: FieldDef, raw: str) -> str | float | int | None:
    text = _apply_extract(field, raw.strip())

    if field.type is FieldType.number:
        # the empty fallback applies whenever NO number could be read — an empty box OR
        # one that OCR'd junk with no digit (e.g. a missing count badge -> default 1)
        num = _first_number(text) if text else None
        if num is None and field.empty is not None:
            num = _first_number(field.empty)
        if num is None:
            return None
        num = num.replace(",", "")
        return float(num) if "." in num else int(num)

    if not text:
        return field.empty if field.empty is not None else None
    return text.strip() or None
