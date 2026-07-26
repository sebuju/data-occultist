"""Boot-time profile validator: cross-references every id a profile's nodes point at
against where that id is actually declared, and flags a region/tell/readout naming a
field that isn't in its window's schema. Pure inspection — never mutates the profile.
A dangling reference is a config mistake (renamed/deleted node, stale merge leftover),
never something to silently patch or guess at.

WHAT may point at WHAT is not decided here — it is read from :mod:`oc.profile.wiring`, the one
table the runtime and the whole web UI also read, so a newly wireable pairing can never be legal
in the model/UI/runtime while this checker still calls it unrecognised. This module owns only
the semantics a table can't express: duplicate ids, a window's field schema, a register's
exposed KEYS, window-scoped item ids, and the per-trigger-kind requirements.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import wiring
from .models import GameProfile, ProcessDef, RegisterDef
from .wiring import parse_ref as _parse_ref


@dataclass(frozen=True)
class ProfileIssue:
    severity: str   # "error" | "warn"
    node: str       # human-readable node path, e.g. "window:equipment region:name"
    msg: str


def check_profile(p: GameProfile) -> list[ProfileIssue]:
    """Walk every declared node's string references and report the ones that point at
    an id (or, for a register slot, a KEY) nothing declares, plus field references that
    miss their window's schema."""
    issues: list[ProfileIssue] = []

    def err(node: str, msg: str) -> None:
        issues.append(ProfileIssue("error", node, msg))

    def warn(node: str, msg: str) -> None:
        issues.append(ProfileIssue("warn", node, msg))

    def dup_check(node_kind: str, ids: list[str]) -> None:
        seen: set[str] = set()
        for i in ids:
            if i in seen:
                warn(node_kind, f"duplicate id '{i}' — the first definition silently wins")
            seen.add(i)

    register_ids = wiring.pool_ids(p, "registers")
    window_ids = wiring.pool_ids(p, "windows")
    items_by_window: dict[str, set[str]] = {w.id: {it.id for it in w.items} for w in p.windows}
    scrollbar_windows = {w.id for w in p.windows if w.scroll and w.scroll.scrollbar}
    registers_by_id: dict[str, RegisterDef] = {x.id: x for x in p.registers}
    processes_by_id: dict[str, ProcessDef] = {x.id: x for x in p.processes}

    dup_check("window", [w.id for w in p.windows])
    dup_check("dataset", [d.id for d in p.datasets])
    dup_check("subset", [s.id for s in p.subsets])
    dup_check("producer", [x.id for x in p.producers])
    dup_check("file_source", [x.id for x in p.file_sources])
    dup_check("trigger", [x.id for x in p.triggers])
    dup_check("gate", [x.id for x in p.gates])
    dup_check("router", [x.id for x in p.routers])
    dup_check("toast", [x.id for x in p.toasts])
    dup_check("sound", [x.id for x in p.sounds])
    dup_check("action", [x.id for x in p.actions])
    dup_check("register", [x.id for x in p.registers])
    dup_check("process", [x.id for x in p.processes])
    dup_check("dictionary", [x.id for x in p.dictionaries])
    dup_check("readout", [r.id for w in p.windows for r in w.readouts])

    # ---- register-slot key resolution (register -> process -> readout/register chains) ----
    # A register's EXPOSED keys are the union of what its wired sources emit: a readout
    # source's key is the readout id itself; a process source's keys are whatever that
    # process's inputs emit (their ``out`` rename, or their own ref's id/key). Both
    # recurse (a process can source a register slot; a register can source another
    # register), so both are memoized against a shared ``seen`` set to survive a cycle.

    def process_keys(proc_id: str, seen: set[str]) -> set[str]:
        if proc_id in seen or proc_id not in processes_by_id:
            return set()
        seen.add(proc_id)
        keys: set[str] = set()
        for inp in processes_by_id[proc_id].sources:
            if inp.out:
                keys.add(inp.out)
                continue
            parsed = _parse_ref(inp.ref)
            if parsed is None:
                continue
            kind, rid, key = parsed
            if kind == "readout":
                keys.add(rid)
            elif kind == "register" and key:
                keys.add(key)
        return keys

    def register_keys(reg_id: str, seen: set[str]) -> set[str]:
        if reg_id in seen or reg_id not in registers_by_id:
            return set()
        seen.add(reg_id)
        keys: set[str] = set()
        for src in registers_by_id[reg_id].sources:
            parsed = _parse_ref(src)
            if parsed is None:
                continue
            kind, rid, _key = parsed
            if kind == "readout":
                keys.add(rid)
            elif kind == "process":
                keys |= process_keys(rid, seen)
            elif kind == "register":
                keys |= register_keys(rid, seen)
        return keys

    # ---- the generic pass: every wiring.LINKS row, checked the same way -----------------
    # Adding a wireable pairing is a row in wiring.py; nothing below needs an audit. A bare ref
    # must name a declared id of one of the row's kinds; a prefixed ref must additionally carry
    # a prefix that row accepts (an unknown prefix is a warn, not an error — the ref may predate
    # a kind this build doesn't have). A register-slot ref checks its KEY too, since a register
    # only exposes the keys its wired sources actually emit.
    for link in wiring.LINKS:
        if not link.checked:
            continue
        node_label = link.label or wiring.label_for(link.kinds)
        for owner_id, ref in wiring.refs(p, link):
            node = f"{link.owner}:{owner_id}" if owner_id else link.owner
            if link.grammar == "prefixed":
                parsed = _parse_ref(ref)
                if parsed is None:
                    continue
                prefix, rid, key = parsed
                matching = wiring.kinds_for_prefix(link, prefix)
                if not matching:
                    warn(node, f"unrecognised source kind '{ref}'")
                    continue
                kind = matching[0]
                if rid not in wiring.pool_ids(p, kind.pool):
                    err(node, f"{link.verb} missing {kind.label} '{rid}'")
                elif key is not None and any(k.key for k in matching):
                    exposed = register_keys(rid, set())
                    if exposed and key not in exposed:
                        err(node, f"references missing key '{key}' on {kind.label} '{rid}'")
            elif ref not in wiring.pools_for(p, link.kinds):
                err(node, f"{link.verb} missing {node_label} '{ref}'")

    # ---- windows: per-window field schema (regions/items/tells/readouts) ----------------
    for w in p.windows:
        node = f"window:{w.id}"
        field_ids = {f.id for f in p.fields_for(w)}
        dup_check(f"{node} fields", [f.id for f in w.fields])
        for r in w.regions:
            if r.field not in field_ids:
                err(f"{node} region:{r.id}", f"reads missing field '{r.field}'")
        for it in w.items:
            item_node = f"{node} item:{it.id}"
            for rf in it.fields:
                if rf.field not in field_ids:
                    err(f"{item_node} field:{rf.id}", f"reads missing field '{rf.field}'")
            for t in it.tells:
                if t.field and t.field not in field_ids:
                    err(f"{item_node} tell:{t.id}", f"validates missing field '{t.field}'")
        for ro in w.readouts:
            if ro.field and ro.field not in field_ids:
                err(f"{node} readout:{ro.id}", f"reads missing field '{ro.field}'")

    # ---- triggers: the per-kind requirements a link row can't express ------------------
    for t in p.triggers:
        node = f"trigger:{t.id}"
        if t.kind == "on_input":
            if t.input_rect and not t.input_window:
                err(node, "sets a rect but no bound window — a rect needs a window's client area")
            if t.input_rect and len(t.input_rect) != 4:
                err(node, "rect must be [x, y, w, h]")
        if t.kind == "on_item" and t.item_watch:
            win_id = t.window_watch[0] if t.window_watch else None
            if win_id is None:
                err(node, f"watches item '{t.item_watch}' but no window is set")
            # "*" is the "any item" wildcard — not a real item id, nothing to check it against.
            elif t.item_watch != "*" and win_id in items_by_window and t.item_watch not in items_by_window[win_id]:
                err(node, f"watches missing item '{t.item_watch}' in window '{win_id}'")
        if t.kind in ("on_scroll_top", "on_scroll_bottom"):
            for win_id in t.window_watch:
                if win_id in window_ids and win_id not in scrollbar_windows:
                    err(node, f"watches window '{win_id}' for scroll but it has no scrollbar configured")

    # ---- actions: register KEYS (the ids themselves are LINKS rows) --------------------
    for a in p.actions:
        node = f"action:{a.id}"
        for reg_id, slot_keys in a.slots.items():
            if reg_id not in register_ids:
                continue          # dangling register already reported by the slots LINKS row
            exposed = register_keys(reg_id, set())
            for key in slot_keys:
                if exposed and key not in exposed:
                    err(node, f"slots reference missing key '{key}' on register '{reg_id}'")
        for reg_id, op in a.reg_ops.items():
            if reg_id not in register_ids:
                continue          # ditto, via the reg_ops LINKS row
            # dest is a prefixed ref ("dataset:<id>" / "register:<id>") -- _migrate_reg_ops
            # (models.py) guarantees every non-empty dest already carries one of those two
            # prefixes, and the LINKS row checks the id exists; only the self-target (which
            # needs the OWNING register's id, so no table can see it) is decided here.
            if op.dest:
                dest_kind, dest_id, _ = _parse_ref(op.dest) or ("dataset", op.dest, None)
                if dest_kind == "register" and dest_id == reg_id:
                    err(node, f"reg_ops on register '{reg_id}' clones/moves into itself")
            # advisory only (warn, not err): unlike `slots` above, a clone/move key here is hand-
            # typed by design (keyRows, reg_slots.js) — register keys are runtime-created, so a key
            # not currently wired may still be legitimate (fed by another action's "set", or wired
            # later). Still flagged so a genuine typo against a known key doesn't go unnoticed.
            exposed = register_keys(reg_id, set())
            for key in op.keys:
                if exposed and key not in exposed:
                    warn(node, f"reg_ops on register '{reg_id}' targets key '{key}' not currently wired to it")

    return issues
