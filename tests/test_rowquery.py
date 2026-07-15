"""Unit tests for the server-side row query engine (oc.enrich.rowquery).

`compile_query` is a MIRROR of `compileQuery` in static/js/vtable.js — the grammar must stay
identical so a query behaves the same whether it runs server-side (paginated node tables) or
client-side (the small array-mode tables that still search in the browser). The table below is the
shared contract; if you change the grammar on either side, update this table on both.
"""

from __future__ import annotations

from oc.enrich.rowquery import compile_query, distinct, row_haystack, window

HAY = "forma prime  5  lith g3  abc-foo"


def _m(q: str) -> bool:
    """Does query `q` match the fixture haystack HAY? (compile + apply)"""
    pred = compile_query(q)
    return bool(pred and pred(HAY))


# (query, expected-match-against-HAY) — the shared grammar contract, mirror of vtable.js.
CASES = [
    ("forma", True),                       # bare term
    ("zzz", False),
    ("forma prime", True),                 # implicit AND (juxtaposition)
    ("forma zzz", False),
    ("forma AND prime", True),             # explicit AND
    ("forma OR zzz", True),                # OR
    ("zzz OR yyy", False),
    ("NOT zzz", True),                     # NOT
    ("NOT forma", False),
    ("- zzz", True),                       # bare-dash token == NOT
    ("- forma", False),
    ("-foo", True),                        # GLUED dash is a literal term (matches 'abc-foo'), NOT negation
    ("lith*g3", True),                     # glob * (any run)
    ("g?", True),                          # glob ? (one char) -> 'g3'
    ("g?zz", False),
    ("(forma OR zzz) AND prime", True),    # parens
    ("(zzz OR yyy) AND prime", False),
    ('"forma prime"', True),               # quoted phrase (kept intact)
    ('"prime forma"', False),              # order matters in a phrase
    ("a OR b AND c", True),                # precedence OR < AND: a OR (b AND c); 'a' matches -> True
]


def test_grammar_contract():
    for q, expected in CASES:
        assert _m(q) is expected, f"{q!r} expected {expected}"


def test_empty_query_is_none():
    assert compile_query("") is None
    assert compile_query("   ") is None


def test_unbalanced_parens_never_raise():
    # Mirror of vtable.js: an unbalanced open paren is tolerated — nested empty atoms resolve to a
    # match-everything predicate (NOT a throw). The substring fallback is defensive-only (termRegex
    # catches its own bad-regex errors), so it isn't reachable from ordinary input.
    pred = compile_query("(((")
    assert pred is not None
    assert pred("has ((( in it") is True
    assert pred("no parens") is True     # empty-atom -> true, same as the client


def test_case_insensitive():
    assert _m("FORMA") is True
    assert _m("Lith") is True


def test_row_haystack_matches_vtable_shape():
    row = {"name": "Forma", "plat": 5, "note": ""}
    # lowercased, cells joined by two spaces, over the given columns only
    assert row_haystack(row, ["name", "plat", "note"]) == "forma  5  "


# ---- window(): filter -> sort -> slice ----------------------------------------------------------

ROWS = [{"name": "Kuva", "plat": 10}, {"name": "Forma", "plat": 5}, {"name": "Ash", "plat": ""}]
COLS = ["name", "plat"]


def test_window_sort_desc_blanks_sink():
    w = window(ROWS, COLS, sort="plat", desc=True, offset=0, limit=0)
    assert [r["name"] for r in w["rows"]] == ["Kuva", "Forma", "Ash"]   # blank plat sinks to bottom
    assert w["total"] == 3


def test_window_query_then_total_is_full_match_not_page():
    # 'a' appears in every name (kuvA, formA, Ash) -> 3 matches; page of 2 still reports total 3.
    w = window(ROWS, COLS, q="a", sort="name", offset=0, limit=2)
    assert [r["name"] for r in w["rows"]] == ["Ash", "Forma"]
    assert w["total"] == 3


def test_window_offset():
    w = window(ROWS, COLS, sort="name", offset=1, limit=1)
    assert [r["name"] for r in w["rows"]] == ["Forma"]   # sorted Ash,Forma,Kuva -> offset 1 -> Forma
    assert w["total"] == 3


def test_distinct_skips_blanks_keeps_order():
    rows = [{"v": "b"}, {"v": ""}, {"v": "a"}, {"v": "b"}, {"v": None}]
    assert distinct(rows, "v") == ["b", "a"]
    assert distinct(rows, "v", limit=1) == ["b"]
