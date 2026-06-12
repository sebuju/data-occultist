"""Compute a view (:class:`SubsetDef`) over one or more datasets.

A view outer-joins its source datasets on a shared key (``join_field``, default
``name``), then filters rows, adds computed columns, sorts, and limits. It holds no
state — recomputed from the current records each call, so it always reflects the latest
stored data. Joining inventory to a producer's price dataset (then deriving
``value = count*price_median``) is the canonical use.

Derived columns are ``{column}`` templates. A template beginning with ``=`` is evaluated
as ARITHMETIC over its numeric placeholders (e.g. ``={count}*{price_median}``); any
missing/non-numeric operand yields an empty cell.
"""

from __future__ import annotations

import ast
import operator
import re

from ..profile.models import DerivedColumn, FilterRule, SubsetDef

_PLACEHOLDER = re.compile(r"\{([^{}]+)\}")


def _num(v) -> float | None:
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return None


# safe arithmetic for ``=`` derived columns: + - * / ** and unary minus, numbers only
_ARITH_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
              ast.Div: operator.truediv, ast.Pow: operator.pow, ast.USub: operator.neg,
              ast.UAdd: operator.pos, ast.Mod: operator.mod}


def _eval_arith(expr: str) -> float:
    def ev(n):
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)):
            return n.value
        if isinstance(n, ast.BinOp) and type(n.op) in _ARITH_OPS:
            return _ARITH_OPS[type(n.op)](ev(n.left), ev(n.right))
        if isinstance(n, ast.UnaryOp) and type(n.op) in _ARITH_OPS:
            return _ARITH_OPS[type(n.op)](ev(n.operand))
        raise ValueError("unsupported expression")
    return ev(ast.parse(expr, mode="eval").body)


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


def _derive_cell(template: str, row: dict):
    """One derived value. ``=expr`` -> arithmetic over numeric placeholders (empty if any
    operand is missing/non-numeric); otherwise plain ``{column}`` text substitution."""
    if not template.startswith("="):
        return render_template(template, row)
    ok = True

    def sub(m):
        nonlocal ok
        n = _num(row.get(m.group(1)))
        if n is None:
            ok = False
            return "0"
        return repr(n)

    expr = _PLACEHOLDER.sub(sub, template[1:])
    if not ok:
        return ""
    try:
        val = _eval_arith(expr)
    except (ValueError, SyntaxError, ZeroDivisionError):
        return ""
    return int(val) if isinstance(val, float) and val.is_integer() else round(val, 2)


def apply_derived(row: dict, derived: list[DerivedColumn]) -> None:
    """Add each derived column to the row in order, so a later column can reference an
    earlier one."""
    for d in derived:
        if d.name:
            row[d.name] = _derive_cell(d.template, row)


# columns that the store adds for bookkeeping — hidden from a subset by default
_HIDDEN = ("present", "first_seen", "last_seen", "_count")


def _join(inputs: list[tuple[str, list[dict]]], join_field: str) -> list[dict]:
    """Outer-join the source datasets on ``join_field`` (case-insensitive), unioning
    columns. A row without a join value stays standalone. Earlier inputs win column
    collisions (their non-empty value is kept); later inputs fill gaps."""
    merged: dict[str, dict] = {}
    order: list[str] = []
    for ds_id, recs in inputs:
        for rec in recs:
            row = {k: v for k, v in rec.items() if k not in _HIDDEN}
            kv = str(row.get(join_field, "")).strip().lower()
            if not kv:                                   # unjoinable -> its own row
                key = f"\x00{ds_id}\x00{len(order)}"
                merged[key] = row
                order.append(key)
                continue
            if kv in merged:
                base = merged[kv]
                for k, v in row.items():
                    if k not in base or base.get(k) in (None, ""):
                        base[k] = v
            else:
                merged[kv] = row
                order.append(kv)
    return [merged[k] for k in order]


def compute_view(inputs: list[tuple[str, list[dict]]], sub: SubsetDef) -> dict:
    """Return ``{columns, rows}`` for a view over its joined source datasets.

    ``inputs`` is ``[(dataset_id, records), ...]`` — the datasets the view joins (on
    ``sub.join_field``). Merge -> derive -> filter -> sort -> limit, so filters and sort
    can reference joined and derived columns alike."""
    rows = _join(inputs, sub.join_field or "name")
    for row in rows:
        apply_derived(row, sub.derived)
    rows = [r for r in rows if all(match_rule(r, f) for f in sub.filters if f.field)]
    if sub.sort_by:
        rows.sort(key=lambda r: _sort_key(r.get(sub.sort_by)), reverse=sub.sort_desc)
    if sub.limit and sub.limit > 0:
        rows = rows[: sub.limit]

    derived_names = [d.name for d in sub.derived if d.name]
    base: list[str] = []
    for row in rows:
        for k in row:
            if k not in base and k not in derived_names:
                base.append(k)
    return {"columns": base + derived_names, "rows": rows}


def compute_subset(records: list[dict], sub: SubsetDef) -> dict:
    """Back-compat single-dataset view over already-fetched ``records``."""
    return compute_view([(sub.dataset or "", records)], sub)


def _sort_key(v):
    """Sort numerically when the value is a number, else lexicographically. Blanks rank
    LOWEST (bucket -1) so an unpriced row sinks to the bottom on a descending sort, rather
    than floating to the top. Returns a (bucket, number, text) tuple so mixed columns
    don't raise."""
    if v is None or str(v).strip() == "":
        return (-1, 0.0, "")
    n = _num(v)
    if n is not None:
        return (0, n, "")
    return (1, 0.0, str(v).lower())
