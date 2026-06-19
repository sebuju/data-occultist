"""Declarative, no-regex extraction primitives shared by every source parser.

The UI authors :class:`oc.profile.models.SourceMatch` / ``SourceField`` rules — never a
regex. This module turns those rules into values: line filters, the per-line field methods
(after / between / column / whole), document path lookups (json/yaml/ini/xml), and the
text/number cast. Both the line parser and the document parsers call these, so the meaning
of a method lives in exactly one place. The ``re`` use below is INTERNAL number-sniffing,
not a user-facing pattern.
"""

from __future__ import annotations

import re

_NUM = re.compile(r"-?\d+(?:\.\d+)?")


# ---- line filtering --------------------------------------------------------

def _op_match(text: str, op: str, needle: str, case_sensitive: bool) -> bool:
    if not case_sensitive:
        text, needle = text.lower(), needle.lower()
    if op == "starts_with":
        return text.startswith(needle)
    if op == "ends_with":
        return text.endswith(needle)
    if op == "equals":
        return text == needle
    return needle in text   # "contains" (default)


def line_matches(line: str, match) -> bool:
    """True when ``line`` satisfies EVERY clause (AND). No clauses -> keep the line."""
    return all(
        _op_match(line, getattr(m, "op", "contains"), getattr(m, "text", ""),
                  getattr(m, "case_sensitive", False))
        for m in (match or [])
    )


# ---- value casting ---------------------------------------------------------

def cast(value, ftype: str):
    """Cast an extracted value to the field's type. ``number`` sniffs the first numeric
    token (int if whole, else float); a value with no number passes through unchanged."""
    if ftype == "number":
        if isinstance(value, (int, float)):
            return value
        m = _NUM.search(str(value))
        if not m:
            return value
        tok = m.group(0)
        return float(tok) if "." in tok else int(tok)
    return value if isinstance(value, str) else str(value)


def finalize(value, field):
    """Strip (string values only) then cast per the field — the common tail of every method."""
    if value is None:
        return None
    if isinstance(value, str) and getattr(field, "strip", True):
        value = value.strip()
    return cast(value, getattr(field, "type", "text"))


# ---- per-line field methods (log_lines) ------------------------------------

def extract_line_field(line: str, field):
    """Pull one field's value out of a single log line via its declarative ``method``.
    Returns ``None`` when the anchor/column isn't present (so the row simply lacks that
    column — a missing KEY part then drops the row downstream, never a guess)."""
    method = getattr(field, "method", "after")
    if method == "whole":
        return finalize(line, field)

    if method == "after":
        anchor = field.anchor or ""
        if anchor:
            i = line.find(anchor)
            if i < 0:
                return None
            rest = line[i + len(anchor):]
        else:
            rest = line
        if field.stop:
            j = rest.find(field.stop)
            if j >= 0:
                rest = rest[:j]
        return finalize(rest, field)

    if method == "between":
        anchor = field.anchor or ""
        if anchor:
            i = line.find(anchor)
            if i < 0:
                return None
            rest = line[i + len(anchor):]
        else:
            rest = line
        if field.end:
            j = rest.find(field.end)
            if j < 0:
                return None
            rest = rest[:j]
        return finalize(rest, field)

    if method == "column":
        delim = field.delim or " "
        parts = line.split() if delim == " " else line.split(delim)
        try:
            return finalize(parts[field.index], field)
        except IndexError:
            return None

    return None


def line_record(line: str, fields) -> dict:
    """Build one record dict from a line: every field that extracts a non-empty value.
    A field that misses (None / "") is omitted, not nulled."""
    rec: dict = {}
    for f in fields or []:
        v = extract_line_field(line, f)
        if v is not None and v != "":
            rec[f.id] = v
    return rec


# ---- document path lookup (json / yaml; ini & xml have their own) ----------

def path_parts(path: str):
    """Split a dotted path into segments; an all-digit (or -digit) segment is a list index.
    ``a.b.0.c`` -> ``["a", "b", 0, "c"]``."""
    out = []
    for seg in (path or "").split("."):
        if not seg:
            continue
        if seg.lstrip("-").isdigit():
            out.append(int(seg))
        else:
            out.append(seg)
    return out


def dig(data, path: str):
    """Walk a dotted path through nested dict/list data (json/yaml). ``None`` if any hop
    misses or a type doesn't match."""
    cur = data
    for part in path_parts(path):
        if isinstance(part, int):
            if isinstance(cur, (list, tuple)) and -len(cur) <= part < len(cur):
                cur = cur[part]
            else:
                return None
        elif isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur


def doc_record(get, fields) -> list[dict]:
    """Build the single-row result for a document parser: ``get(field)`` per ``path`` field,
    cast, dropped if None. Returns ``[record]`` or ``[]`` when nothing resolved."""
    rec: dict = {}
    for f in fields or []:
        if getattr(f, "method", "") != "path" or not getattr(f, "path", ""):
            continue
        v = get(f)
        if v is None:
            continue
        rec[f.id] = finalize(v, f)
    return [rec] if rec else []
