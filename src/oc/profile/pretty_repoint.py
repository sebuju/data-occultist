"""Repoint ``{{token}}`` references in a Pretty doc when a graph node is renamed.

A Pretty widget's ``text`` / ``title`` / ``visible_when`` / ``enabled_when`` and its
conditions-rule ``source`` strings embed graph ids inside tokens: ``dataset:<id>`` /
``subset:<id>`` heads, and ``node:`` paths like ``windows[<win>].fields[<fid>]`` /
``windows[<win>].items[<it>]`` / ``triggers[<id>]`` / ``producers[<id>]`` /
``datasets[<id>]`` / ``subsets[<id>]``. The node view can rename any of those; without this
sweep the tokens keep the OLD id and resolve to empty.

The JS twin is ``renameWidget``'s walk (widget ids, pretty-internal); this covers every OTHER
kind server-side so a rename lands even when Pretty was never opened this session — a view
switch reloads the doc from disk. The token grammar mirrors ``static/js/pretty/binding.js``.

Every rewrite is anchored to the token grammar (``kind:id`` heads bounded by a token
delimiter, ids inside ``[...]`` bounded by the brackets), so plain prose never matches.
"""

from __future__ import annotations

import re

# right boundary of a ``kind:id`` head — the id ends at a token delimiter or string end.
_HEAD_END = r"(?=$|[.\[|\s}])"


def _pairs(kind: str, old: str, new: str, win: str | None):
    """The ``(compiled_regex, replacement)`` list that turns OLD into NEW for one rename
    ``kind``. ``win`` scopes field/item ids to their window (ids are window-unique, not global)."""
    o = re.escape(old)
    if kind == "dataset":
        return [(re.compile(rf"\bdataset:{o}{_HEAD_END}"), f"dataset:{new}"),
                (re.compile(rf"\bdatasets\[{o}\]"), f"datasets[{new}]")]
    if kind == "subset":
        return [(re.compile(rf"\bsubset:{o}{_HEAD_END}"), f"subset:{new}"),
                (re.compile(rf"\bsubsets\[{o}\]"), f"subsets[{new}]")]
    if kind == "widget":
        return [(re.compile(rf"\bwidget:{o}{_HEAD_END}"), f"widget:{new}")]
    if kind == "window":
        return [(re.compile(rf"\bwindows\[{o}\]"), f"windows[{new}]")]
    if kind == "trigger":
        return [(re.compile(rf"\btriggers\[{o}\]"), f"triggers[{new}]")]
    if kind == "producer":
        return [(re.compile(rf"\bproducers\[{o}\]"), f"producers[{new}]")]
    if kind in ("field", "item") and win:
        w = re.escape(win)
        seg = "fields" if kind == "field" else "items"
        return [(re.compile(rf"windows\[{w}\]\.{seg}\[{o}\]"), f"windows[{win}].{seg}[{new}]")]
    return []


def _compile(rewrites) -> list:
    pairs: list = []
    for r in rewrites or []:
        if not isinstance(r, dict):
            continue
        old, new = r.get("old"), r.get("new")
        if not old or not new or old == new:
            continue
        pairs.extend(_pairs(r.get("kind") or "", str(old), str(new), r.get("win")))
    return pairs


def _bind_map(rewrites) -> dict:
    """``{(src, old): new}`` for dataset/subset renames — a widget ``binding``'s ``src`` value
    ("dataset"/"subset") equals the rename ``kind``, so a binding to the OLD id repoints too."""
    m: dict = {}
    for r in rewrites or []:
        if not isinstance(r, dict):
            continue
        kind, old, new = r.get("kind"), r.get("old"), r.get("new")
        if kind in ("dataset", "subset") and old and new and old != new:
            m[(kind, str(old))] = str(new)
    return m


def repoint_pretty(doc, rewrites) -> int:
    """Apply a list of ``{kind, old, new, win?}`` rewrites to every string in ``doc`` (mutated
    in place). Returns the total number of substitutions made (0 ⇒ nothing to save).

    Covers two ref shapes: ``{{token}}`` strings (regex ``pairs``) AND a widget's structured
    ``binding: {src, id}`` — the latter is NOT a token string, so a dataset/subset rename would
    otherwise orphan every widget bound to it (empty render + a 404 on the row fetch)."""
    pairs = _compile(rewrites)
    binds = _bind_map(rewrites)
    if not pairs and not binds:
        return 0
    count = 0

    def fix(s: str) -> str:
        nonlocal count
        for rx, rep in pairs:
            s, n = rx.subn(rep, s)
            count += n
        return s

    def walk(o) -> None:
        nonlocal count
        if isinstance(o, list):
            for i, v in enumerate(o):
                if isinstance(v, str):
                    o[i] = fix(v)
                else:
                    walk(v)
        elif isinstance(o, dict):
            # widget binding: {src: dataset|subset, id: <renamed>} — repoint the bare id
            new = binds.get((o.get("src"), o.get("id")))
            if new is not None:
                o["id"] = new
                count += 1
            for k, v in o.items():
                if isinstance(v, str):
                    o[k] = fix(v)
                else:
                    walk(v)

    walk(doc)
    return count
