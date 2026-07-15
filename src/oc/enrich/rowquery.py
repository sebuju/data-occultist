"""Ad-hoc row query + windowing for the server-backed node tables.

The graph's dataset/subset node tables (VTable) used to hold every row in the browser and search /
sort / paint them client-side — which forced the whole row set over the wire. The paginated
``/dataset/{id}/page`` and ``/subset/{id}/page`` endpoints instead filter + sort + slice server-side
and return only the visible window, so the browser never holds more than a page.

:func:`compile_query` is a **line-for-line mirror** of ``compileQuery``/``termRegex`` in
``static/js/vtable.js`` (the JS copy stays for the small array-mode tables — batch/history/precap —
that still search in the browser). The grammar MUST stay identical so a query types the same whether
it runs here or there; ``tests/test_rowquery.py`` locks the shared cases. If you change one side,
change the other and update the test table.

Grammar: ``OR``, ``AND`` (also implicit by juxtaposition), ``NOT`` (also a bare ``-`` token), parens
``( )``, ``"quoted phrase"``, glob ``*`` (any run) / ``?`` (one char). Precedence OR < AND < NOT.
Terms are unanchored substring/glob matches against the row's lowercased haystack. A malformed query
never raises — it falls back to a plain substring match.
"""

from __future__ import annotations

import re
from typing import Callable

from .subset import _sort_key   # numeric-aware sort key, reused so column sort matches the view engine

# Same tokenizer as vtable.js: a paren, a double-quoted phrase, or a run of non-space/non-paren chars.
_TOKEN = re.compile(r'\s*(\(|\)|"[^"]*"|[^\s()]+)')
# Regex specials to escape in a glob term — the SAME set vtable.js escapes (NOT * or ?, NOT -).
_SPECIALS = re.compile(r'[.+^${}()|\[\]\\]')


# Predicate combinators — kept as helpers (not inline `x = lambda`) so the recursive-descent parser
# below reads as a clean mirror of vtable.js's closures.
def _and(a, b):
    return lambda t: a(t) and b(t)


def _or(a, b):
    return lambda t: a(t) or b(t)


def _not(x):
    return lambda t: not x(t)


def _term_regex(term: str) -> Callable[[str], bool]:
    """glob -> matcher: escape regex specials (except ``*``/``?``), then ``*`` -> ``.*`` and
    ``?`` -> ``.``; unanchored, case-folded (term lowercased; the haystack is already lowercased).
    Mirror of ``termRegex`` (vtable.js). Bad regex -> a fully-escaped literal, so it never raises."""
    src = _SPECIALS.sub(lambda m: "\\" + m.group(0), term.lower()).replace("*", ".*").replace("?", ".")
    try:
        rx = re.compile(src)
    except re.error:
        rx = re.compile(re.escape(term.lower()))
    return lambda text: rx.search(text) is not None


def compile_query(q: str) -> Callable[[str], bool] | None:
    """Compile a query string to a predicate ``(lowercased_haystack) -> bool``, or ``None`` for an
    empty query. Mirror of ``compileQuery`` (vtable.js) — recursive descent, precedence OR<AND<NOT.
    On a malformed query, falls back to a plain substring match so typing never raises."""
    q = (q or "").strip()
    if not q:
        return None
    toks = [m.group(1) for m in _TOKEN.finditer(q)]
    if not toks:
        return None

    i = 0

    def peek():
        return toks[i] if i < len(toks) else None

    def is_op(t, op):
        return bool(t) and t.upper() == op

    def parse_or():
        nonlocal i
        left = parse_and()
        while is_op(peek(), "OR"):
            i += 1
            left = _or(left, parse_and())
        return left

    def parse_and():
        nonlocal i
        left = parse_not()
        while peek() is not None and not is_op(peek(), "OR") and peek() != ")":
            if is_op(peek(), "AND"):
                i += 1
            left = _and(left, parse_not())
        return left

    def parse_not():
        nonlocal i
        if is_op(peek(), "NOT") or peek() == "-":
            i += 1
            return _not(parse_atom())
        return parse_atom()

    def parse_atom():
        nonlocal i
        t = peek()
        if t == "(":
            i += 1
            e = parse_or()
            if peek() == ")":
                i += 1
            return e
        if t == ")" or t is None:
            i += 1
            return lambda _t: True
        i += 1
        if len(t) > 1 and t.startswith('"') and t.endswith('"'):
            t = t[1:-1]
        return _term_regex(t)

    try:
        return parse_or() or None
    except Exception:   # noqa: BLE001 - a malformed query must never raise; fall back to substring
        needle = q.lower()
        return lambda text: needle in text


def row_haystack(row: dict, columns: list[str]) -> str:
    """The lowercased search haystack for a row — the row's visible cell values joined by two
    spaces, matching VTable's per-row ``text`` (vtable.js setData) so a query matches identically
    server-side and client-side."""
    return "  ".join(str(row.get(c, "")) for c in columns).lower()


def window(rows: list[dict], columns: list[str], *, q: str = "", sort: str = "",
           desc: bool = False, offset: int = 0, limit: int = 0) -> dict:
    """Filter (``q``) -> sort (``sort``/``desc``) -> slice (``offset``/``limit``) over already-read
    rows. Returns ``{"rows", "total"}`` where ``total`` is the FULL match count (pre-slice), so the
    client's scrollbar can span the true result size. ``limit<=0`` means no slice cap."""
    pred = compile_query(q)
    if pred is not None:
        rows = [r for r in rows if pred(row_haystack(r, columns))]
    if sort:
        rows = sorted(rows, key=lambda r: _sort_key(r.get(sort)), reverse=desc)
    total = len(rows)
    start = max(0, offset)
    rows = rows[start: start + limit] if limit and limit > 0 else rows[start:]
    return {"rows": rows, "total": total}


def distinct(rows: list[dict], field: str, limit: int = 0) -> list:
    """Distinct non-empty values of one column, in first-seen order. Feeds the join-sample cycler
    (fillNormSamples) that used to scan the whole row set in the browser. ``limit<=0`` = no cap."""
    seen: list = []
    seset: set = set()
    for r in rows:
        v = r.get(field)
        if v is None or v == "" or v in seset:
            continue
        seset.add(v)
        seen.append(v)
        if limit and limit > 0 and len(seen) >= limit:
            break
    return seen
