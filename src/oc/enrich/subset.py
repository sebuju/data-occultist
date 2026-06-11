"""Compute a :class:`SubsetDef` over a dataset's records.

A subset is a derived view: filter rows, add columns computed from other columns, sort,
limit, and (on an explicit pass) attach external data via registered enrichers. It holds
no state — it's recomputed from the current dataset records each call, so it always
reflects the latest stored data.

The live path (``compute_subset`` with ``run_enrich=False``) does only local work
(filter + derive + sort) and is cheap enough to run on every dataset update. Network
enrichers run only when ``run_enrich=True`` (an explicit user action), never in the poll
loop — see :class:`oc.interfaces.Enricher`.
"""

from __future__ import annotations

import re

from ..profile.models import DerivedColumn, FilterRule, SubsetDef

_PLACEHOLDER = re.compile(r"\{([^{}]+)\}")


def _num(v) -> float | None:
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return None


def match_rule(row: dict, rule: FilterRule) -> bool:
    """Does one row satisfy one filter rule?"""
    raw = row.get(rule.field)
    s = "" if raw is None else str(raw)
    op, val = rule.op, rule.value
    if op == "nonempty":
        return s.strip() != ""
    if op == "empty":
        return s.strip() == ""
    if op == "eq":
        return s == val
    if op == "ne":
        return s != val
    if op == "contains":
        return val in s
    if op == "icontains":
        return val.lower() in s.lower()
    if op == "regex":
        try:
            return re.search(val, s) is not None
        except re.error:
            return False
    if op in ("gt", "lt", "gte", "lte"):
        a, b = _num(s), _num(val)
        if a is None or b is None:
            return False
        return {"gt": a > b, "lt": a < b, "gte": a >= b, "lte": a <= b}[op]
    return True   # unknown op -> don't filter out


def render_template(template: str, row: dict) -> str:
    """Substitute ``{column}`` placeholders from a row's values (missing -> empty)."""
    return _PLACEHOLDER.sub(lambda m: "" if row.get(m.group(1)) is None else str(row.get(m.group(1))), template)


def apply_derived(row: dict, derived: list[DerivedColumn]) -> None:
    """Add each derived column to the row in order, so a later column can reference an
    earlier one."""
    for d in derived:
        if d.name:
            row[d.name] = render_template(d.template, row)


# columns that the store adds for bookkeeping — hidden from a subset by default
_HIDDEN = ("present", "first_seen", "last_seen")


def compute_subset(records: list[dict], sub: SubsetDef, *, run_enrich: bool = False,
                   build=None) -> dict:
    """Return ``{columns, rows, enriched}`` for a subset over ``records``.

    ``build(rule)`` -> an :class:`Enricher` instance (or ``None``) is only called when
    ``run_enrich`` is set; otherwise the enrich columns are skipped entirely (the live
    refresh stays local + fast).
    """
    rows: list[dict] = []
    for rec in records:
        if all(match_rule(rec, f) for f in sub.filters if f.field):
            row = {k: v for k, v in rec.items() if k not in _HIDDEN}
            apply_derived(row, sub.derived)
            rows.append(row)

    enriched = False
    enrich_cols: list[str] = []
    if run_enrich and build is not None:
        for rule in sub.enrich:
            if not rule.enabled:
                continue
            enricher = build(rule)
            if enricher is None:
                continue
            for row in rows:
                extra = {}
                try:
                    extra = enricher.enrich(row) or {}
                except Exception:   # an enricher must never break the view
                    extra = {}
                for k, v in extra.items():
                    if k not in enrich_cols:
                        enrich_cols.append(k)
                    row[k] = v
            enriched = True

    if sub.sort_by:
        rows.sort(key=lambda r: _sort_key(r.get(sub.sort_by)), reverse=sub.sort_desc)
    if sub.limit and sub.limit > 0:
        rows = rows[: sub.limit]

    # column order: base fields (first row's, minus hidden), then derived, then enrich
    base: list[str] = []
    for row in rows:
        for k in row:
            if k not in base and k not in [d.name for d in sub.derived] and k not in enrich_cols:
                base.append(k)
    columns = base + [d.name for d in sub.derived if d.name] + enrich_cols
    return {"columns": columns, "rows": rows, "enriched": enriched}


def _sort_key(v):
    """Sort numerically when both sides are numbers, else lexicographically. Returns a
    (is_text, number, text) tuple so mixed columns don't raise."""
    n = _num(v)
    if n is not None:
        return (0, n, "")
    return (1, 0.0, "" if v is None else str(v).lower())
