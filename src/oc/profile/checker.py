"""Boot-time profile validator: cross-references every id a profile's nodes point at
against where that id is actually declared, and flags a region/tell/readout naming a
field that isn't in its window's schema. Pure inspection — never mutates the profile.
A dangling reference is a config mistake (renamed/deleted node, stale merge leftover),
never something to silently patch or guess at."""

from __future__ import annotations

from dataclasses import dataclass

from .models import GameProfile, ProcessDef, RegisterDef, RuleThen


@dataclass(frozen=True)
class ProfileIssue:
    severity: str   # "error" | "warn"
    node: str       # human-readable node path, e.g. "window:equipment region:name"
    msg: str


def _parse_ref(ref: str) -> tuple[str, str, str | None] | None:
    """Split a prefixed ref into ``(kind, id, key)``. Handles the grammar every source
    ref in a profile uses: ``"dataset:foo"`` -> ``("dataset", "foo", None)``,
    ``"register:foo#bar"`` -> ``("register", "foo", "bar")``, and a gate's
    ``"register:foo#bar@nonblank"`` modifier suffix on the key is stripped before
    comparison (``"bar@nonblank"`` -> key ``"bar"``). ``None`` for an unprefixed/blank
    ref — nothing to check."""
    if not ref or ":" not in ref:
        return None
    kind, rest = ref.split(":", 1)
    if "#" in rest:
        rid, key = rest.split("#", 1)
        key = key.split("@", 1)[0]
    else:
        rid, key = rest, None
    return kind, rid, key


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

    dataset_ids = {d.id for d in p.datasets}
    subset_ids = {s.id for s in p.subsets}
    producer_ids = {x.id for x in p.producers}
    file_source_ids = {x.id for x in p.file_sources}
    gate_ids = {x.id for x in p.gates}
    router_ids = {x.id for x in p.routers}
    toast_ids = {x.id for x in p.toasts}
    sound_ids = {x.id for x in p.sounds}
    action_ids = {x.id for x in p.actions}
    register_ids = {x.id for x in p.registers}
    process_ids = {x.id for x in p.processes}
    dictionary_ids = {x.id for x in p.dictionaries}
    readout_ids = {r.id for w in p.windows for r in w.readouts}
    registers_by_id: dict[str, RegisterDef] = {x.id: x for x in p.registers}
    processes_by_id: dict[str, ProcessDef] = {x.id: x for x in p.processes}

    ds_or_sub = dataset_ids | subset_ids
    trigger_targets = producer_ids | file_source_ids | toast_ids | sound_ids | action_ids | router_ids

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

    def check_rules(node: str, rules) -> None:
        for r in rules:
            if r.then is RuleThen.dictionary and r.dict_id and r.dict_id not in dictionary_ids:
                err(node, f"rule references missing dictionary '{r.dict_id}'")

    def check_source_ref(node: str, ref: str) -> None:
        """``"readout:<id>"`` / ``"register:<id>#<key>"`` — the grammar gates, routers,
        and process inputs all source live values through. When a register slot is
        named, the KEY is checked too (not just the register id) — a register only
        exposes the keys its wired sources actually emit."""
        parsed = _parse_ref(ref)
        if parsed is None:
            return
        kind, rid, key = parsed
        if kind == "readout":
            if rid not in readout_ids:
                err(node, f"references missing readout '{rid}'")
        elif kind == "register":
            if rid not in register_ids:
                err(node, f"references missing register '{rid}'")
            elif key is not None:
                exposed = register_keys(rid, set())
                if exposed and key not in exposed:
                    err(node, f"references missing key '{key}' on register '{rid}'")
        else:
            warn(node, f"unrecognised source kind '{kind}:{rid}'")

    # ---- windows: dataset sink, per-window field schema, rule pipelines ----
    for w in p.windows:
        node = f"window:{w.id}"
        if w.dataset and w.dataset not in dataset_ids:
            err(node, f"feeds missing dataset '{w.dataset}'")
        fields = p.fields_for(w)
        field_ids = {f.id for f in fields}
        dup_check(f"{node} fields", [f.id for f in w.fields])
        for f in fields:
            check_rules(f"{node} field:{f.id}", f.rules)
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

    # ---- dictionaries: feed sources ----
    for dic in p.dictionaries:
        node = f"dictionary:{dic.id}"
        for feed in dic.feeds:
            if feed.dataset and feed.dataset not in dataset_ids:
                err(node, f"feeds from missing dataset '{feed.dataset}'")

    # ---- subsets: joined sources (dataset or upstream subset) ----
    for s in p.subsets:
        node = f"subset:{s.id}"
        for src in s.sources:
            if src.dataset and src.dataset not in ds_or_sub:
                err(node, f"joins missing dataset/subset '{src.dataset}'")

    # ---- producers: output dataset, input sources (dataset/subset) ----
    for pr in p.producers:
        node = f"producer:{pr.id}"
        if pr.dataset and pr.dataset not in dataset_ids:
            err(node, f"writes to missing dataset '{pr.dataset}'")
        for src in pr.sources:
            if src not in ds_or_sub:
                err(node, f"reads missing dataset/subset '{src}'")

    # ---- file sources: output dataset ----
    for fs in p.file_sources:
        node = f"file_source:{fs.id}"
        if fs.dataset and fs.dataset not in dataset_ids:
            err(node, f"writes to missing dataset '{fs.dataset}'")

    # ---- gates: source value ----
    for g in p.gates:
        check_source_ref(f"gate:{g.id}", g.source)

    # ---- routers: source value + branch targets ----
    for r in p.routers:
        node = f"router:{r.id}"
        check_source_ref(node, r.source)
        for i, br in enumerate(r.branches):
            for t in br.targets:
                if t not in trigger_targets:
                    err(f"{node} branch:{i}", f"forwards to missing target '{t}'")

    # ---- triggers: watch lists, gates, targets ----
    for t in p.triggers:
        node = f"trigger:{t.id}"
        # on_ready watches PRODUCER ids (fires when a sweep finishes); every other
        # watching kind watches a dataset/subset.
        watch_pool = producer_ids if t.kind == "on_ready" else ds_or_sub
        watch_label = "producer" if t.kind == "on_ready" else "dataset/subset"
        for w_id in t.watch:
            if w_id not in watch_pool:
                err(node, f"watches missing {watch_label} '{w_id}'")
        for ro in t.readout_watch:
            if ro not in readout_ids:
                err(node, f"watches missing readout '{ro}'")
        for reg in t.register_watch:
            if reg not in register_ids:
                err(node, f"watches missing register '{reg}'")
        for gid in t.gates:
            if gid not in gate_ids:
                err(node, f"gated by missing gate '{gid}'")
        for tgt in t.targets:
            if tgt not in trigger_targets:
                err(node, f"fires missing target '{tgt}'")

    # ---- toasts: wired sources (readout/dataset/subset) ----
    for to in p.toasts:
        node = f"toast:{to.id}"
        for src in to.sources:
            parsed = _parse_ref(src)
            if parsed is None:
                continue
            kind, rid, _key = parsed
            if kind == "readout" and rid not in readout_ids:
                err(node, f"references missing readout '{rid}'")
            elif kind == "dataset" and rid not in dataset_ids:
                err(node, f"references missing dataset '{rid}'")
            elif kind == "subset" and rid not in subset_ids:
                err(node, f"references missing subset '{rid}'")
            elif kind not in ("readout", "dataset", "subset"):
                warn(node, f"unrecognised source kind '{src}'")

    # ---- actions: sources (dataset/register/sound/action), dest, slots ----
    for a in p.actions:
        node = f"action:{a.id}"
        for src in a.sources:
            parsed = _parse_ref(src)
            if parsed is None:
                continue
            kind, rid, _key = parsed
            if kind == "dataset" and rid not in dataset_ids:
                err(node, f"references missing dataset '{rid}'")
            elif kind == "register" and rid not in register_ids:
                err(node, f"references missing register '{rid}'")
            elif kind == "sound" and rid not in sound_ids:
                err(node, f"references missing sound '{rid}'")
            elif kind == "action" and rid not in action_ids:
                err(node, f"chains to missing action '{rid}'")
            elif kind not in ("dataset", "register", "sound", "action"):
                warn(node, f"unrecognised source kind '{src}'")
        if a.dest and a.dest not in dataset_ids:
            err(node, f"writes to missing destination dataset '{a.dest}'")
        for reg_id, slot_keys in a.slots.items():
            if reg_id not in register_ids:
                err(node, f"slots reference missing register '{reg_id}'")
                continue
            exposed = register_keys(reg_id, set())
            for key in slot_keys:
                if exposed and key not in exposed:
                    err(node, f"slots reference missing key '{key}' on register '{reg_id}'")

    # ---- registers: wired sources (readout/process/register), persist sink ----
    for r in p.registers:
        node = f"register:{r.id}"
        for src in r.sources:
            parsed = _parse_ref(src)
            if parsed is None:
                continue
            kind, rid, _key = parsed
            if kind == "readout" and rid not in readout_ids:
                err(node, f"references missing readout '{rid}'")
            elif kind == "process" and rid not in process_ids:
                err(node, f"references missing process '{rid}'")
            elif kind == "register" and rid not in register_ids:
                err(node, f"references missing register '{rid}'")
            elif kind not in ("readout", "process", "register"):
                warn(node, f"unrecognised source kind '{src}'")
        if r.persist and r.persist not in dataset_ids:
            err(node, f"persists to missing dataset '{r.persist}'")

    # ---- processes: wired inputs + rule pipeline dictionary refs ----
    for pc in p.processes:
        node = f"process:{pc.id}"
        for src in pc.sources:
            check_source_ref(node, src.ref)
        check_rules(node, pc.rules)

    return issues
