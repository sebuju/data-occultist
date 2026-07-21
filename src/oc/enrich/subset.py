"""Compute a subset (:class:`SubsetDef`) over one or more datasets.

A subset joins its sources — each on its OWN key (a per-source ``join_field`` + ``join_norm``),
each collapsing its own many->one (``aggregate``), each optionally ``required`` — then filters
rows, adds computed columns, sorts, and limits. It holds no state — recomputed from the current
records each call, so it always reflects the latest stored data. Joining inventory to a
producer's price dataset (then deriving ``value = count*price_median``) is the canonical use.

Derived columns are ``{column}`` templates. A template beginning with ``=`` is evaluated
as ARITHMETIC over its numeric placeholders (e.g. ``={count}*{price_median}``); any
missing/non-numeric operand yields an empty cell.

To mix literal text with math, use an inline ``{=expr}`` block inside an ordinary text
template (do NOT lead with ``=``): e.g. ``{=count*price_median} plat`` -> ``96 plat``.
Inline math whose operands are missing/non-numeric collapses to an empty string, leaving
the surrounding literal text intact.

A math expression (either form) may carry a trailing ``|round:N`` directive to fix its
decimals: ``={price_median}/{count}|round:0`` yields an integer, ``|round:1`` one decimal
(``|dp:N`` / ``|fixed:N`` / ``|.Nf`` are aliases). Without it numbers tidy to int-bare / 2dp.
"""

from __future__ import annotations

import ast
import hashlib
import json
import operator
import re
from functools import lru_cache

from ..numfmt import split_dp
from ..profile.models import DerivedColumn, FilterRule, JoinNorm, JoinSource, SortRule, SubsetDef
from ..store.textnorm import norm_text
from .pivot import apply_pivot

_PLACEHOLDER = re.compile(r"\{([^{}]+)\}")
_INLINE_MATH = re.compile(r"\{=([^{}]+)\}")   # an inline arithmetic block within a text template
# per-row predicate blocks yielding "1"/"0" (feed a later `=` column as a numeric flag):
#   {a == b} / {a != b}  compare two operands (column name, or a "quoted"/'literal')
#   {col?}               1 when the column is non-empty, else 0
# disjoint from _INLINE_MATH (its `{=...}` starts with `=`, excluded from the lhs class).
_PREDICATE = re.compile(r"\{\s*([^{}=!?]+?)\s*(==|!=)\s*([^{}]+?)\s*\}")
_NONEMPTY = re.compile(r"\{\s*([^{}=!?]+?)\?\s*\}")


def _num(v) -> float | None:
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return None


# safe arithmetic for ``=`` derived columns: + - * / ** and unary minus, numbers only
_ARITH_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
              ast.Div: operator.truediv, ast.Pow: operator.pow, ast.USub: operator.neg,
              ast.UAdd: operator.pos, ast.Mod: operator.mod}


@lru_cache(maxsize=512)
def _parse_arith(expr: str):
    """Parse one arithmetic expression to its AST body once and reuse it. A subset's derived
    columns share the same expr string across every row, so this turns N row-level
    ``ast.parse`` calls into one."""
    return ast.parse(expr, mode="eval").body


def _eval_arith(expr: str, row: dict | None = None) -> float:
    def ev(n):
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)):
            return n.value
        if isinstance(n, ast.Name):   # bare column name (inline `{=count*price}` form)
            v = _num(row.get(n.id)) if row is not None else None
            if v is None:
                raise ValueError(f"missing or non-numeric column {n.id!r}")
            return v
        if isinstance(n, ast.BinOp) and type(n.op) in _ARITH_OPS:
            return _ARITH_OPS[type(n.op)](ev(n.left), ev(n.right))
        if isinstance(n, ast.UnaryOp) and type(n.op) in _ARITH_OPS:
            return _ARITH_OPS[type(n.op)](ev(n.operand))
        raise ValueError(f"unsupported expression element: {type(n).__name__}")
    return ev(_parse_arith(expr))


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
    """Substitute ``{column}`` placeholders from a row's values (missing -> empty). A placeholder
    may carry a ``|round:N`` directive (``{price_min|round:0}``) to fix a numeric value's
    decimals; a non-numeric value ignores it and substitutes as-is."""
    def sub(m):
        col, dp = split_dp(m.group(1))
        v = row.get(col)
        if v is None:
            return ""
        if dp is not None:
            try:
                return f"{float(v):.{dp}f}"
            except (TypeError, ValueError):
                return str(v)
        return str(v)
    return _PLACEHOLDER.sub(sub, template)


def _eval_math(expr: str, row: dict):
    """Evaluate one arithmetic expression over a row's numeric ``{column}`` placeholders.
    Returns an int/float, or ``None`` if any operand is missing/non-numeric or the
    expression is malformed. A trailing ``|round:N`` directive fixes the result to N
    decimals (``0`` => integer); absent it, numbers tidy to int-bare / 2dp."""
    expr, dp = split_dp(expr)
    ok = True

    def sub(m):
        nonlocal ok
        n = _num(row.get(m.group(1)))
        if n is None:
            ok = False
            return "0"
        return repr(n)

    substituted = _PLACEHOLDER.sub(sub, expr)
    if not ok:
        return None
    try:
        val = _eval_arith(substituted, row)
    except (ValueError, SyntaxError, ZeroDivisionError):
        return None
    if dp is not None:
        r = round(float(val), dp)
        return int(r) if dp == 0 else r
    return int(val) if isinstance(val, float) and val.is_integer() else round(val, 2)


def _operand(token: str, row: dict) -> str:
    """Resolve one predicate operand to a comparable string: a ``"quoted"``/``'literal'`` yields
    its inner text; anything else is a column name looked up in the row. Both sides are
    normalised (lowercased, whitespace-collapsed) so a match is case/spacing-insensitive, in the
    same spirit as a join's default :class:`JoinNorm`."""
    token = token.strip()
    if len(token) >= 2 and token[0] == token[-1] and token[0] in "\"'":
        raw = token[1:-1]
    else:
        raw = "" if row.get(token) is None else str(row.get(token))
    return norm_text(raw, lower=True, strip_punct=False, collapse_ws=True, strip_words=())


def _apply_predicates(template: str, row: dict) -> str:
    """Substitute predicate blocks (``{a==b}``, ``{a!=b}``, ``{col?}``) with ``"1"``/``"0"`` so a
    text template can produce a numeric flag a later ``=`` column consumes."""
    def cmp(m):
        eq = _operand(m.group(1), row) == _operand(m.group(3), row)
        return "1" if (eq if m.group(2) == "==" else not eq) else "0"
    template = _PREDICATE.sub(cmp, template)
    return _NONEMPTY.sub(lambda m: "1" if str(row.get(m.group(1).strip()) or "").strip() else "0", template)


def _derive_cell(template: str, row: dict):
    """One derived value:
    - a template beginning with ``=`` (and with no inline block) is ONE arithmetic
      expression (empty if any operand is missing/non-numeric);
    - otherwise it's text: predicate blocks (``{a==b}``/``{a!=b}``/``{col?}``) resolve to
      ``1``/``0`` first, inline ``{=expr}`` blocks evaluate to their number (empty on a
      missing/non-numeric operand), plain ``{column}`` placeholders substitute values, and
      everything else is kept literally — so static strings, flags, and math freely mix.
    Either math form may end with ``|round:N`` to fix its decimals (see :func:`_eval_math`)."""
    if template.startswith("=") and "{=" not in template:
        val = _eval_math(template[1:], row)
        return "" if val is None else val
    text = _apply_predicates(template, row)
    text = _INLINE_MATH.sub(lambda m: "" if (v := _eval_math(m.group(1), row)) is None else str(v), text)
    return render_template(text, row)


def apply_derived(row: dict, derived: list[DerivedColumn]) -> None:
    """Add each derived column to the row in order, so a later column can reference an
    earlier one."""
    for d in derived:
        if d.name:
            row[d.name] = _derive_cell(d.template, row)


# columns that the store adds for bookkeeping — hidden from a subset by default
_HIDDEN = ("present", "first_seen", "last_seen", "_count", "_batch")


def _latest_batch_only(recs: list[dict]) -> list[dict]:
    """Keep only the rows from each input's most recent batch — those whose ``_batch`` equals
    the highest ``_batch`` present. Rows without a ``_batch`` (e.g. an upstream view that
    already stripped it) are left untouched, so the filter is a no-op there."""
    batches = [r.get("_batch") for r in recs if r.get("_batch") is not None]
    if not batches:
        return recs
    top = max(batches)
    return [r for r in recs if r.get("_batch") == top]


def _merge_rows(combo) -> dict:
    """Union the columns of one matched row per source. Earlier sources win a non-empty
    collision; later sources only fill a missing/empty cell."""
    out: dict = {}
    for row in combo:
        for k, v in row.items():
            if k not in out or out.get(k) in (None, ""):
                out[k] = v
    return out


def _join(pairs: list[tuple[JoinSource, list[dict]]]) -> list[dict]:
    """Join the sources, unioning columns. Each source canonicalises ITS OWN ``join_field``
    value through ITS OWN :class:`JoinNorm` to the shared join key — so sources keying
    different columns still match when their normalised values agree.

    This is a real relational join: it PRESERVES multiplicity. If a key has N rows in one
    source and M in another, the key yields N*M output rows (the cross product). So an
    ``all``-aggregate (no-collapse) or no-dedup source keeps every observation when joined,
    rather than coalescing to one row. With one row per key on every side (the usual case —
    sources aggregate to one) a key is just one merged row, unchanged.

    Per-source ``required`` replaces the old global inner/outer mode: with NO source required
    the join is a full OUTER (every key kept; a source missing the key pairs in one empty
    placeholder so the present sources' rows still surface, and a row with no join value stays
    standalone). Marking sources required narrows the output to keys present in EVERY required
    source (all required == the old ``inner``); standalones are dropped when any source is
    required. Earlier sources win column collisions (their non-empty value is kept).

    A source's ``mode`` (see :class:`JoinSource`) picks how it combines, beyond a plain
    key-matched ``join``:

    - ``exclude`` is an ANTI-join: it contributes no columns at all — every key it contains is
      simply dropped from the output (e.g. "owned mods minus already-equipped names"). It is
      independent of ``required`` and never affects keyless standalone rows.
    - ``mark`` is a SEMI-join: for each output row whose ``join``-derived key also appears in
      this source, its columns are merged in — but it can never multiply rows (unlike a plain
      ``join`` source, which cross-products). A key matching several of this source's rows
      still contributes only the first. Use to flag/annotate a row (e.g. "this mod's polarity
      matches an empty slot's") without risking a duplicate per match.
    - ``broadcast`` merges this source's row(s) into EVERY output row, unkeyed — several rows
      collapse into one merged dict first (first-wins), then fill only each output row's
      missing/empty cells (real join columns always win)."""
    from itertools import product

    strip = lambda rec: {k: v for k, v in rec.items() if k not in _HIDDEN}   # noqa: E731
    # A single source isn't joined — pass its rows through 1:1 (stripping bookkeeping cols).
    # (a non-``join`` mode is meaningless with nothing else to combine with, so it's a no-op.)
    if len(pairs) == 1:
        return [strip(rec) for rec in pairs[0][1]]

    def kof(row, src: JoinSource) -> str:
        if not src.join_field:
            return ""
        n = src.join_norm or JoinNorm()
        return norm_text(row.get(src.join_field, ""), lower=n.case_insensitive,
                         strip_punct=n.strip_punct, collapse_ws=n.collapse_ws,
                         strip_words=tuple(n.strip_words))

    # Peel off the non-plain-join sources first: exclude -> a key blocklist, mark -> a
    # key->row annotate map, broadcast -> one merged row applied to everything at the end.
    # What's left (``join_pairs``) goes through the ordinary keyed join below.
    excluded_keys: set[str] = set()
    mark_map: dict[str, dict] = {}
    broadcast_rows: list[dict] = []
    join_pairs: list[tuple[JoinSource, list[dict]]] = []
    for src, recs in pairs:
        if src.mode == "exclude":
            for rec in recs:
                k = kof(strip(rec), src)
                if k:
                    excluded_keys.add(k)
        elif src.mode == "mark":
            for rec in recs:
                row = strip(rec)
                k = kof(row, src)
                if k and k not in mark_map:             # first match wins
                    mark_map[k] = row
        elif src.mode == "broadcast":
            broadcast_rows.extend(strip(rec) for rec in recs)
        else:
            join_pairs.append((src, recs))
    broadcast_row = _merge_rows(broadcast_rows) if broadcast_rows else None
    if not join_pairs:                       # every source was exclude/mark/broadcast
        return []

    per_source: list[dict[str, list[dict]]] = []   # source idx -> {key -> [rows]}
    standalones: list[dict] = []                    # rows with no join value (outer only)
    key_order: list[str] = []
    seen: set[str] = set()
    for src, recs in join_pairs:
        groups: dict[str, list[dict]] = {}
        for rec in recs:
            row = strip(rec)
            k = kof(row, src)
            if not k:
                standalones.append(row)             # unjoinable -> its own row
                continue
            groups.setdefault(k, []).append(row)
            if k not in seen:
                seen.add(k)
                key_order.append(k)
        per_source.append(groups)

    required = [bool(src.required) for src, _ in join_pairs]
    strict = any(required)
    out: list[dict] = []
    for k in key_order:
        if k in excluded_keys:
            continue
        # drop the key if a REQUIRED source lacks it (all-required == old inner; mixed narrows)
        if any(req and k not in gs for req, gs in zip(required, per_source)):
            continue
        # each source contributes its matching rows; an optional source missing the key pairs in
        # one empty placeholder so the present sources' rows still appear.
        lists = [gs.get(k) or [{}] for gs in per_source]
        mark = mark_map.get(k)
        for combo in product(*lists):
            row = _merge_rows(combo)
            if mark:
                row = _merge_rows([row, mark])          # annotate only, never multiplies
            out.append(row)
    if not strict:
        out.extend(standalones)
    if broadcast_row:
        out = [_merge_rows([row, broadcast_row]) for row in out]
    return out


def compute_view(inputs: list[tuple[str, list[dict]]], sub: SubsetDef) -> dict:
    """Return ``{columns, rows}`` for a view over its joined sources.

    ``inputs`` is ``[(dataset_id, records), ...]`` aligned by index with ``sub.sources`` — the
    sources the view joins (each on its OWN ``join_field``). Latest-batch -> merge -> pivot ->
    derive -> filter -> sort -> limit, so filters and sort can reference joined, pivoted, and
    derived columns alike."""
    # latest-batch first: trim each source to its most recent batch BEFORE the join, so the
    # rest of the pipeline only ever sees the latest pass.
    if getattr(sub, "latest_batch", False):
        inputs = [(ds, _latest_batch_only(recs)) for ds, recs in inputs]
    # pair each source's join config with its records (aligned by position) and join.
    pairs = [(src, recs) for src, (_ds, recs) in zip(sub.sources, inputs)]
    rows = _join(pairs)
    if sub.pivot is not None:
        rows = apply_pivot(rows, sub.pivot)
    for row in rows:
        apply_derived(row, sub.derived)
    rows = [r for r in rows if all(match_rule(r, f) for f in sub.filters if f.field)]
    # multi-column sort (primary first), applied BEFORE limit. Folds the legacy single
    # sort_by/sort_desc in when no `sort` list is set. A stable sort applied from the LAST
    # rule to the FIRST makes earlier rules dominate while later ones break ties.
    sort_rules = list(getattr(sub, "sort", None) or [])
    if not sort_rules and sub.sort_by:
        sort_rules = [SortRule(field=sub.sort_by, desc=sub.sort_desc)]
    for rule in reversed(sort_rules):
        if rule.field:
            rows.sort(key=lambda r, f=rule.field: _sort_key(r.get(f)), reverse=rule.desc)
    columns = _visible_columns(rows, sub)
    if getattr(sub, "distinct", False):
        rows = _distinct(rows, sub, columns)
    if sub.limit and sub.limit > 0:
        rows = rows[: sub.limit]
    return {"columns": columns, "rows": rows}


def _visible_columns(rows: list[dict], sub: SubsetDef) -> list[str]:
    """The result's visible column order: every key seen across ``rows`` (join order), then
    derived columns, minus ``hidden_columns``. The one source of truth for "what does this view
    show" — both the returned ``columns`` and whole-row ``distinct`` key off it."""
    derived_names = [d.name for d in sub.derived if d.name]
    base: list[str] = []
    for row in rows:
        for k in row:
            if k not in base and k not in derived_names:
                base.append(k)
    hidden = set(sub.hidden_columns or ())
    return [c for c in base + derived_names if c not in hidden]


def _distinct(rows: list[dict], sub: SubsetDef, visible: list[str]) -> list[dict]:
    """First-wins row de-dup. Key on ``distinct_by`` columns, or (empty) the whole visible row
    (``visible`` already excludes hidden + _HIDDEN bookkeeping cols). Runs after sort, so the
    surviving row is the sort-order-first one; runs before limit, so limit counts distinct rows."""
    keys = sub.distinct_by or visible
    seen: set = set()
    out: list[dict] = []
    for r in rows:
        k = tuple(r.get(c) for c in keys)
        if k in seen:
            continue
        seen.add(k)
        out.append(r)
    return out


def compute_subset(records: list[dict], sub: SubsetDef) -> dict:
    """Single-source view over already-fetched ``records`` (``sub`` must have one source)."""
    ds = sub.sources[0].dataset if sub.sources else ""
    return compute_view([(ds, records)], sub)


def subset_source_datasets(profile, subset_id: str, _stack: frozenset = frozenset()) -> set[str]:
    """The transitive PLAIN-dataset ids a subset ultimately reads (the leaves of its source
    tree). A subset input recurses into its own sources; a plain dataset is its own leaf; a
    cycle stops. Used to build a rev signature that gates a cached view result — any write to
    one of these datasets bumps its ``rev`` and so invalidates the cache."""
    sub = profile.subset_def(subset_id)
    if sub is None:                      # a plain dataset — itself a leaf
        return {subset_id}
    if subset_id in _stack:              # cycle -> stop
        return set()
    out: set[str] = set()
    for src in sub.sources:
        out |= subset_source_datasets(profile, src.dataset, _stack | {subset_id})
    return out


def subset_source_views(profile, subset_id: str, _stack: frozenset = frozenset()) -> set[str]:
    """The subset id itself plus every transitive UPSTREAM subset (view) feeding it. A plain
    dataset is not a view -> excluded; a cycle stops. Companion to :func:`subset_source_datasets`:
    that one gates a cached view on its source DATA (dataset revs), this one gates it on the source
    DEFINITIONS — an upstream view's def change alters this view's output just as a data write does.
    """
    sub = profile.subset_def(subset_id)
    if sub is None or subset_id in _stack:   # a plain dataset (not a view), or a cycle -> stop
        return set()
    out = {subset_id}
    for src in sub.sources:
        out |= subset_source_views(profile, src.dataset, _stack | {subset_id})
    return out


def subset_def_fingerprint(sub) -> str:
    """A stable hash of a subset's DEFINITION — everything that changes its computed view
    (sources, filters, derived, sort, hidden_columns, pivot, limit, latest_batch), excluding
    pure-UI state (``config_collapsed``). Folded into the view cache key so a settings edit
    invalidates the cached result even when no source data changed."""
    payload = json.dumps(sub.model_dump(mode="json", exclude={"config_collapsed"}), sort_keys=True)
    return hashlib.sha1(payload.encode()).hexdigest()


def compute_view_rows(profile, subset_id: str, fetch_dataset, *, cache: dict | None = None) -> dict:
    """Compute a subset's full ``{columns, rows}`` view, recursing through subset inputs.

    The ONE place the subset dependency walk lives — the web flow, the price runner, and the
    trigger change-gate all call this so the recursion (cycle guard, per-``(input, aggregate)``
    memo, ``compute_view`` glue) never drifts between them. The only thing that genuinely
    differs per caller — how a PLAIN dataset's rows are fetched (web store vs. ``store_for``,
    with/without a ``present`` filter) — is injected:

    ``cache`` (optional) is the per-``(input, aggregate)`` memo. Pass a shared dict across a
    BATCH of top-level subsets (the web boot fetches every subset at once) so a heavy upstream
    view — e.g. a 23k-row join feeding several ``*_suggestions`` siblings — is computed ONCE for
    the whole batch, not once per consumer. Omit it (``None``) for a one-off compute.

    ``fetch_dataset(dataset_id, aggregate) -> list[dict]`` returns the raw stored records for
    one plain dataset, aggregated per the consuming SOURCE's ``aggregate``. A subset input is
    computed recursively (each of ITS sources carries its own aggregate) so its derived columns
    are available upstream; a cycle resolves to no rows.

    A source with a BLANK ``aggregate`` INHERITS the source dataset's own policy
    (:meth:`GameProfile.aggregate_for`) — so a dataset that sets e.g. ``max`` to collapse a
    duplicate observation isn't silently overridden back to ``latest`` by its consumers. Resolved
    HERE, the one place the dependency walk lives, so every caller agrees."""
    if cache is None:
        cache = {}

    def src_agg(src) -> str:
        """This source's effective many->one policy: its own, else the dataset's own (blank
        inherits). ``aggregate_for`` yields ``latest`` for a subset/unknown input, which is moot
        there anyway (a subset already serves one row per key)."""
        return src.aggregate or profile.aggregate_for(src.dataset)

    def input_rows(input_id: str, stack: frozenset, aggregate: str) -> list[dict]:
        ck = (input_id, aggregate)
        if ck in cache:
            return cache[ck]
        sub = profile.subset_def(input_id)
        if sub is None:                                   # a plain dataset
            rows = fetch_dataset(input_id, aggregate)
        elif input_id in stack:                           # cycle -> stop
            rows = []
        else:
            inputs = [(src.dataset, input_rows(src.dataset, stack | {input_id}, src_agg(src)))
                      for src in sub.sources]
            rows = compute_view(inputs, sub)["rows"]
        cache[ck] = rows
        return rows

    sub = profile.subset_def(subset_id)
    if sub is None:
        return {"columns": [], "rows": []}
    inputs = [(src.dataset, input_rows(src.dataset, frozenset({subset_id}), src_agg(src)))
              for src in sub.sources]
    result = compute_view(inputs, sub)
    # Seed the top-level rows so a sibling/downstream subset sharing this `cache` (batch mode)
    # reuses them instead of recomputing. A subset input resolves at aggregate `latest`
    # (`aggregate_for` yields `latest` for a subset, and it already serves one row per key).
    cache[(subset_id, "latest")] = result["rows"]
    return result


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
