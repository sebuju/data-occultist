"""The ONE table of what a profile may wire to what.

Every other module that needs to know "which node kinds may this field point at", "what does a
ref of kind X look like", "where does an id of kind X live in the graph/pretty grammars" reads
:data:`KINDS` and :data:`LINKS` here — the boot checker (:mod:`oc.profile.checker`), the trigger
runner's ref dispatch, and, over ``GET /api/wiring``, every front-end picker, port-drop target
and rename/repoint site. Declaring a new wireable pairing is ONE row here; nothing else needs an
audit. That is the whole point: this table exists because the knowledge used to live in ~10
Python and ~15 JS copies, and the copy that went stale (an action's ``window:`` source, added to
the model/UI/runtime but not to the checker) reported every correctly-wired profile as broken.

Two declarations:

* :data:`KINDS` — one row per node kind, carrying every naming grammar that kind has: the ref
  prefix (``dataset:<id>``), the id pool, the front-end node type/prefix, and the pretty-doc
  token forms.
* :data:`LINKS` — one row per ref-holding field, naming the STORAGE PATH and the kinds that
  field may point at.

Nothing here knows about any game. Nothing here validates — :mod:`oc.profile.checker` walks
this table and decides; the semantics a table can't express (a register's exposed KEYS, a
window-scoped item id, a scrollbar requirement) stay as explicit code there.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass


# --------------------------------------------------------------------------- kinds

@dataclass(frozen=True)
class Kind:
    """One wireable node kind and every name it goes by.

    ``name`` is the canonical one (the profile's own vocabulary, e.g. ``file_source``).
    ``pool`` names the id set (see :data:`POOLS`) and, for every kind that is a top-level
    collection, is also the ``GameProfile`` attribute holding those nodes.

    ``key`` describes the ``#key`` tail a ref of this kind carries:
    ``""`` none, ``"required"`` a register slot (``register:<id>#<key>``), ``"facet"`` a slot
    plus a count facet (``register:<id>#<key>@count``). The three register kinds are ONE pool
    with three grammars — that is why they are separate rows.
    """

    name: str
    pool: str
    label: str = ""              # what messages/pickers call it (defaults to `name`)
    prefix: str | None = None    # ref prefix, "" -> no prefixed form (bare-target only)
    key: str = ""                # "" | "required" | "facet"
    node_type: str = ""          # front-end `.gnode.<type>` class (defaults to `name`)
    node_prefix: str = ""        # front-end graph-node id prefix ("ds:foo")
    pretty_path: str = ""        # pretty-doc path head ("datasets[foo]")
    token_head: str = ""         # pretty/toast {{token}} head ("dataset:foo")

    def __post_init__(self) -> None:
        if not self.label:
            object.__setattr__(self, "label", self.name)
        if not self.node_type:
            object.__setattr__(self, "node_type", self.name)


KINDS: tuple[Kind, ...] = (
    Kind(name="dataset", pool="datasets", prefix="dataset", node_prefix="ds",
         pretty_path="datasets", token_head="dataset"),
    Kind(name="subset", pool="subsets", prefix="subset", node_prefix="sub",
         pretty_path="subsets", token_head="subset"),
    Kind(name="window", pool="windows", prefix="window", node_prefix="win",
         pretty_path="windows"),
    Kind(name="readout", pool="readouts", prefix="readout", node_prefix="ro",
         token_head="readout"),
    Kind(name="producer", pool="producers", prefix="producer", node_prefix="producer",
         pretty_path="producers"),
    Kind(name="file_source", pool="file_sources", node_type="filesource", node_prefix="src"),
    Kind(name="trigger", pool="triggers", node_prefix="trigger", pretty_path="triggers"),
    Kind(name="gate", pool="gates", node_prefix="gate"),
    Kind(name="router", pool="routers", node_prefix="router"),
    Kind(name="toast", pool="toasts", node_prefix="toast"),
    Kind(name="sound", pool="sounds", prefix="sound", node_prefix="sound"),
    Kind(name="action", pool="actions", prefix="action", node_prefix="action"),
    Kind(name="overlay", pool="overlays", prefix="overlay", node_prefix="overlay"),
    Kind(name="process", pool="processes", prefix="process", node_prefix="process"),
    Kind(name="dictionary", pool="dictionaries", node_prefix="dict"),
    # the three register grammars over ONE pool: whole register, one slot, one slot's count facet
    Kind(name="register", pool="registers", prefix="register", node_prefix="register"),
    Kind(name="register_key", pool="registers", label="register", prefix="register",
         key="required", node_type="register", node_prefix="register"),
    Kind(name="register_count", pool="registers", label="register", prefix="register",
         key="facet", node_type="register", node_prefix="register"),
)

BY_NAME: dict[str, Kind] = {k.name: k for k in KINDS}

# The count-facet suffixes a `register_count` ref offers per key: each counts over the key's ring
# of recent values (register:<id>#<key>@<facet>) so a numeric gate op tests HOW MANY values the
# key holds, not its single exposed value. Backend: TriggerRunner._facet_count.
FACETS: tuple[tuple[str, str], ...] = (
    ("count", "count"), ("nonblank", "actual"), ("distinct", "distinct"),
)


def pool_ids(profile, pool: str) -> set[str]:
    """Every declared id of one pool. Readouts are the one nested pool (they live per window);
    every other pool is a top-level ``GameProfile`` list of nodes with an ``id``."""
    if pool == "readouts":
        return {r.id for w in profile.windows for r in w.readouts}
    return {x.id for x in getattr(profile, pool, [])}


def pools_for(profile, kinds: tuple[str, ...]) -> set[str]:
    """The union of the id pools of several kinds (a bare ref may name any of them)."""
    out: set[str] = set()
    for name in kinds:
        k = BY_NAME.get(name)
        if k:
            out |= pool_ids(profile, k.pool)
    return out


def label_for(kinds: tuple[str, ...]) -> str:
    """"dataset/subset" — how a message names the kinds a field accepts (deduped, in order)."""
    return "/".join(dict.fromkeys(BY_NAME[n].label for n in kinds if n in BY_NAME))


# --------------------------------------------------------------------------- op vocabularies

@dataclass(frozen=True)
class Op:
    """One value of a closed vocabulary (an op, a trigger kind) with the copy that describes it.

    The value is what lands in the YAML and what a Python evaluator dispatches on; ``label`` and
    ``desc`` are the picker's copy. Both live here so the evaluator and the UI can't disagree
    about what exists — the drift these tables replace was per-side lists that each grew a value
    the other never learned. ``group`` heads a picker section; ``no_arg`` marks an op that reads
    no argument (the arg input is hidden for it).
    """

    id: str
    label: str = ""
    desc: str = ""
    group: str = ""
    no_arg: bool = False

    def __post_init__(self) -> None:
        if not self.label:
            object.__setattr__(self, "label", self.id.replace("_", " "))


VOCAB: dict[str, tuple[Op, ...]] = {
    # what an action node does to each attached DATASET target (store/dataset_ops.py)
    "dataset_actions": (
        Op("", "no action", "do nothing to the attached datasets"),
        Op("clear", "clear targets", "wipe every attached dataset's rows"),
        Op("compact", "compact to batch limit",
           "apply each attached dataset's own keep_batches window (a no-op without one)"),
        Op("clone_batches", "clone data (batches)",
           "copy data into the destination, keeping batch grouping"),
        Op("clone_resolved", "clone data (resolved)",
           "copy data into the destination, collapsed to one resolved batch"),
        Op("move_batches", "move data (batches)",
           "move data into the destination (batch grouping kept), clearing the source"),
        Op("move_resolved", "move data (resolved)",
           "move data into the destination (collapsed to one batch), clearing the source"),
    ),
    # what an action node does to each attached REGISTER target (collect/register_ops.py) —
    # independent of the dataset op above, so a dataset clear and a register set can coexist
    "register_ops": (
        Op("", "no action", "do nothing to this register"),
        Op("set", "set values", "write/remove individual keys (rows below)"),
        Op("remove_all", "remove all keys",
           "drop every key this register holds (ignores key-narrowing)"),
        Op("clone", "clone data",
           "copy this register's keys into a destination, keeping its own values"),
        Op("move", "move data",
           "copy this register's keys into a destination, then clear them from here"),
    ),
    # what wakes a trigger. `group` = the node kind that kind watches (the picker's headers).
    "trigger_kinds": (
        Op("interval", "interval",
           "fire every N seconds; the clock reseeds to a fresh wait on restart/config edit", "timed"),
        Op("true_interval", "true interval",
           "fire every N seconds of REAL time, anchored to the persisted last fire — cadence survives restarts/config edits", "timed"),
        Op("on_change", "on change",
           "fire when a watched dataset/subset gains new/changed rows; a watched subset fires only when its computed output actually changes", "dataset"),
        Op("on_any_change", "on any change",
           "same watch as on change, but fires on EVERY write reaching it, even when a watched subset's visible output is unchanged", "dataset"),
        Op("on_new_batch", "on new batch",
           "fire once per NEW batch of a watched dataset/subset, even when the row values are identical to the last batch (a re-pushed screen)", "dataset"),
        Op("on_readout", "on readout",
           "pulse when a watched live readout is read this tick — wire a gate for the value condition", "readout"),
        Op("on_register", "on register",
           "pulse when a watched register's exposed key moves this tick — wire a gate for the per-key condition", "register"),
        Op("on_ready", "on ready",
           "fire once when a watched producer's sweep/fetch finishes — deterministic, can't precede the data", "producer"),
        Op("on_item", "on item",
           'pulse when a specific item template (or any item) of a watched window is detected/kept this tick (e.g. a "terminator" placeholder)', "window"),
        Op("on_window_detected", "on window detected",
           "fire when a watched window becomes the currently-recognized one", "window"),
        Op("on_window_undetected", "on window undetected",
           "fire when a watched window stops being the currently-recognized one", "window"),
        Op("on_window_tick", "on window tick",
           "fire every tick a watched window's grid was actually OCR'd — content-independent, won't stall on a duplicate-content re-read (unlike on change)", "window"),
        Op("on_window_data_start", "on window data start",
           "fire the first time a watched window produces data again after a quiet spell", "window"),
        Op("on_window_data_stop", "on window data stop",
           "fire once a watched window has gone quiet (see settle below) after producing data", "window"),
        Op("on_scroll_top", "on scroll top",
           "fire when a watched window's scrollbar thumb arrives at the TOP of its track", "window"),
        Op("on_scroll_bottom", "on scroll bottom",
           "fire when a watched window's scrollbar thumb arrives at the BOTTOM of its track", "window"),
        Op("on_app_start", "on app start", "fire once when the web app boots", "session"),
        Op("on_capture", "on capture start", "fire when a capture session starts, live or precapture", "session"),
        Op("on_live_start", "on live start", "fire when the server live-collection session starts", "session"),
        Op("on_live_stop", "on live stop", "fire when the server live-collection session stops", "session"),
        Op("on_input", "on input (live only)",
           "pulse on a keyboard/mouse chord — LIVE ONLY, optionally bound to a window and rect", "input"),
        Op("manual", "manual only", "never auto-fires; the fire button drives it", "manual"),
    ),
    # how a gate/router condition tests its source value (GateWhen; collect/triggers._cond_holds).
    # `group` mirrors the three families: shape/text, numeric level, numeric window/edge.
    "gate_ops": (
        Op("always", "always", "holds unconditionally — every tick", "shape", no_arg=True),
        Op("empty", "empty", "the value is empty/blank", "shape", no_arg=True),
        Op("has_digit", "has digit", "the value contains at least one digit", "shape", no_arg=True),
        Op("no_digit", "no digit", "the value contains no digit at all", "shape", no_arg=True),
        Op("all_digit", "is a number", "the value is all digits (a whole number)", "shape", no_arg=True),
        Op("has_letter", "has letter", "the value contains at least one letter", "shape", no_arg=True),
        Op("no_letter", "no letter", "the value contains no letter at all", "shape", no_arg=True),
        Op("all_letter", "is text", "the value is all letters (no digits)", "shape", no_arg=True),
        Op("equal", "equals", "the value equals the given text/number exactly", "shape"),
        Op("not_equal", "not equal", "the value does not equal the given text/number", "shape"),
        Op("contains", "contains", "the value contains the given substring", "shape"),
        Op("in", "in list", "the value matches one of a comma-separated list", "shape"),
        Op("gte", "gte num", "the value, read as a number, is >= the given number", "number"),
        Op("lte", "lte num", "the value, read as a number, is <= the given number", "number"),
        Op("gt", "gt num", "the value, read as a number, is > the given number", "number"),
        Op("lt", "lt num", "the value, read as a number, is < the given number", "number"),
        Op("eq", "eq num", "the value, read as a number, equals the given number", "number"),
        Op("ne", "not eq", "the value, read as a number, does not equal the given number", "number"),
        Op("between", "between", "the value, read as a number, falls between lo,hi (inclusive)", "edge"),
        Op("crosses_up", "crosses up",
           "the value just crossed UP through the given number this tick (was below, now at/above)", "edge"),
        Op("crosses_down", "crosses down",
           "the value just crossed DOWN through the given number this tick (was above, now at/below)", "edge"),
        Op("changed", "changed", "the value moved since the last fire", "edge", no_arg=True),
    ),
    # subset row filters (enrich/subset.match_rule) — text-shaped, values stringified
    "subset_ops": (
        Op("contains", desc="value contains the given text (case-sensitive)"),
        Op("icontains", desc="value contains the given text (case-insensitive)"),
        Op("eq", desc="value equals the given text/number exactly"),
        Op("ne", desc="value does not equal the given text/number"),
        Op("nonempty", desc="value is present/non-blank"),
        Op("empty", desc="value is empty/blank"),
        Op("gt", desc="value, read as a number, is greater than the given number"),
        Op("lt", desc="value, read as a number, is less than the given number"),
        Op("gte", desc="value, read as a number, is >= the given number"),
        Op("lte", desc="value, read as a number, is <= the given number"),
        Op("regex", desc="value matches the given regular expression"),
    ),
    # producer response mapping (enrich/http_producer) — these compare TYPED json values, unlike
    # the stringified subset ops above, so the two vocabularies stay separate despite shared names
    "producer_aggs": (
        Op("min", desc="smallest of the kept values"),
        Op("max", desc="largest of the kept values"),
        Op("sum", desc="add every kept value"),
        Op("count", desc="how many values were kept"),
        Op("median", desc="middle value of the kept set"),
        Op("median_low", desc="median of the lowest N (see depth)"),
        Op("first", desc="the first kept value, in element order"),
    ),
    "producer_filters": (
        Op("eq", desc="equals the value"),
        Op("ne", desc="does not equal the value"),
        Op("in", desc="is one of a comma-separated list"),
        Op("nin", desc="is not one of a comma-separated list"),
        Op("gt", desc="greater than the value"),
        Op("ge", desc="greater than or equal to the value"),
        Op("lt", desc="less than the value"),
        Op("le", desc="less than or equal to the value"),
        Op("contains", desc="contains the value"),
        Op("ncontains", desc="does not contain the value"),
    ),
}

# Old values still found in saved profiles, normalized on load. A register never had batches, so
# the dataset ops' batches/resolved split collapses to one op when it lands on a register.
ALIASES: dict[str, dict[str, str]] = {
    "register_ops": {"clone_batches": "clone", "clone_resolved": "clone",
                     "move_batches": "move", "move_resolved": "move"},
}


def ops(vocab: str) -> tuple[Op, ...]:
    """One vocabulary's values, in picker order."""
    return VOCAB[vocab]


def op_ids(vocab: str, *, skip_blank: bool = True) -> frozenset[str]:
    """The set an evaluator dispatches on — the blank "no action" sentinel is UI-only, so it is
    dropped unless asked for."""
    return frozenset(o.id for o in VOCAB[vocab] if o.id or not skip_blank)


# --------------------------------------------------------------------------- links

# Every kind a trigger/gate/router may fire, and the extra one only a gate may hold back.
TARGETABLE = ("producer", "file_source", "toast", "sound", "action", "router", "overlay")
GATEABLE = ("trigger", *TARGETABLE)
# The live-value grammar gates and routers test. A bare `register:<id>` is accepted alongside the
# slot forms because a whole-register port drop writes one (port_wire.js).
TESTABLE = ("readout", "register", "register_key", "register_count", "dataset", "subset")


@dataclass(frozen=True)
class Link:
    """One ref-holding field: who owns it, where it is stored, and what it may point at.

    ``owner`` is a kind name (or ``"profile"`` for a game-level field). ``field`` is the storage
    PATH from the owner: ``"sources"``, ``"sources[].ref"`` (list of nested models),
    ``"reg_ops{}.dest"`` (dict values), ``"branches[].targets"`` (list of models holding a list).
    That path is what makes one row serve both validation and the front-end's rename/repoint
    registry.

    ``grammar``:
      * ``prefixed`` — ``kind:id[#key][@facet]``
      * ``bare`` — a plain id whose kind is implied by the field
      * ``dictkey`` — a ``dict`` whose KEYS are the refs

    ``when`` gates a row on a sibling field, ``("kind", "on_ready")`` or its negation
    ``("kind", "!on_ready")`` — the one discriminated field in the profile (a trigger's watch
    list means producers for ``on_ready`` and datasets for every other kind).

    ``decl`` marks a feeder that DECLARES the id rather than referencing it ("I output this
    dataset"): a rename must move it, but it is not a dangling ref when nothing else declares it.

    ``port`` says which END of the relationship carries the drag-to-wire out-port, because the
    graph has both: an ACTION's port drops onto the dataset it operates on (``owner``), while a
    DATASET's port drops onto the subset that joins it (``ref``). ``watch`` is a trigger's second
    (watch) port; ``none`` = editable in the node body only, never dragged.

    ``picker`` / ``ports`` narrow ``kinds`` for the two UI surfaces when the model accepts more
    than the UI offers — a register may SOURCE another register, but only readouts and processes
    are offered in its "+" list, and a whole-register drag writes a bare ``register:<id>`` that
    the slot-level picker never mints. Blank = the same as ``kinds``.
    """

    owner: str
    field: str
    grammar: str
    kinds: tuple[str, ...]
    verb: str = "references"
    label: str = ""                              # overrides label_for(kinds) in messages
    when: tuple[str, str] | None = None
    decl: bool = False
    checked: bool = True                         # False -> front-end only, checker skips it
    prune: bool = False                          # entry exists only to hold this ref -> drop it
                                                 # from its list when a delete blanks the ref
    port: str = "none"                           # none | owner | ref | watch
    port_when: tuple[str, ...] = ()              # owner `kind` values that show this port
    picker: tuple[str, ...] = ()                 # blank -> kinds
    ports: tuple[str, ...] = ()                  # blank -> kinds


LINKS: tuple[Link, ...] = (
    # ---- dataset feeders: another node asserts "I output this dataset" ----
    Link("window", "dataset", "bare", ("dataset",), verb="feeds", decl=True, port="owner"),
    Link("producer", "dataset", "bare", ("dataset",), verb="writes to", decl=True, port="owner"),
    Link("file_source", "dataset", "bare", ("dataset",), verb="writes to", decl=True,
         port="owner"),

    # ---- joins / feeds ----
    Link("subset", "sources[].dataset", "bare", ("dataset", "subset"), verb="joins", port="ref",
         prune=True),
    Link("dictionary", "feeds[].dataset", "bare", ("dataset",), verb="feeds from", port="ref",
         prune=True),
    Link("producer", "sources", "bare", ("dataset", "subset"), verb="reads", port="ref"),

    # ---- predicates / fan-out ----
    # a gate/router tests ONE live value: the picker offers register SLOTS (and their count
    # facets), while a whole-register drag writes the bare `register:<id>` form — both legal.
    Link("gate", "source", "prefixed", TESTABLE, port="ref",
         picker=("readout", "register_key", "register_count", "dataset", "subset"),
         ports=("readout", "register", "dataset", "subset")),
    Link("gate", "targets", "bare", GATEABLE, verb="targets", label="gateable node", port="owner"),
    Link("router", "source", "prefixed", TESTABLE, port="ref",
         picker=("readout", "register_key", "register_count", "dataset", "subset"),
         ports=("readout", "register", "dataset", "subset")),
    # a branch may forward to another router (chained fan-out) but a drag doesn't offer it — the
    # body editor manages branches precisely, and a router dropped on a router reads as a mistake
    Link("router", "branches[].targets", "bare", TARGETABLE, verb="forwards to", label="target",
         port="owner", ports=("producer", "file_source", "toast", "sound", "action")),

    # ---- triggers ----
    Link("trigger", "watch", "bare", ("producer",), verb="watches", when=("kind", "on_ready"),
         port="watch", port_when=("on_ready",)),
    Link("trigger", "watch", "bare", ("dataset", "subset"), verb="watches",
         when=("kind", "!on_ready"), port="watch",
         port_when=("on_change", "on_any_change", "on_new_batch")),
    Link("trigger", "readout_watch", "bare", ("readout",), verb="watches", port="watch",
         port_when=("on_readout",)),
    Link("trigger", "register_watch", "bare", ("register",), verb="watches", port="watch",
         port_when=("on_register",)),
    Link("trigger", "window_watch", "bare", ("window",), verb="watches", port="watch",
         port_when=tuple(o.id for o in VOCAB["trigger_kinds"] if o.group == "window")),
    Link("trigger", "input_window", "bare", ("window",), verb="binds", when=("kind", "on_input")),
    Link("trigger", "targets", "bare", TARGETABLE, verb="fires", label="target", port="owner"),

    # ---- sinks / operators ----
    Link("toast", "sources", "prefixed", ("readout", "dataset", "subset"), port="ref"),
    Link("overlay", "sources", "prefixed", ("readout", "dataset", "subset"), port="ref"),
    # Which window's client rect the overlay is anchored to and sized against. `ref` port: the
    # WINDOW's port drops onto the overlay, matching how a dataset drops onto the subset that
    # joins it — the overlay is the dependant end.
    Link("overlay", "window", "bare", ("window",), verb="overlays", port="ref"),
    Link("action", "sources", "prefixed",
         ("dataset", "register", "sound", "action", "window"), port="owner"),
    Link("action", "dest", "bare", ("dataset",), verb="writes to", label="destination dataset"),
    Link("action", "slots", "dictkey", ("register",), verb="slots reference"),
    Link("action", "reg_ops", "dictkey", ("register",), verb="reg_ops reference"),
    Link("action", "reg_ops{}.dest", "prefixed", ("dataset", "register"),
         verb="reg_ops writes to", label="destination"),
    # a register may hold another register's output, but only readouts/processes are offered
    Link("register", "sources", "prefixed", ("readout", "process", "register"), port="ref",
         picker=("readout", "process"), ports=("readout", "process")),
    Link("register", "persist", "bare", ("dataset",), verb="persists to", port="owner"),
    # a process input is one KEY — a whole-register drag has no key, so registers are picker-only
    Link("process", "sources[].ref", "prefixed", ("readout", "register_key"), port="ref",
         ports=("readout",), prune=True),

    # ---- dictionary refs on rule pipelines ----
    Link("window", "fields[].rules[].dict_id", "bare", ("dictionary",),
         verb="rule references"),
    Link("profile", "fields[].rules[].dict_id", "bare", ("dictionary",),
         verb="rule references"),
    Link("process", "rules[].dict_id", "bare", ("dictionary",), verb="rule references"),

    # ---- game-level ----
    Link("profile", "window_priority", "bare", ("window",), verb="orders"),
)

# --------------------------------------------------------------------------- path walking

def owners(profile, link: Link) -> Iterator:
    """The node objects a link's rows live on (the profile itself for a game-level link)."""
    if link.owner == "profile":
        yield profile
        return
    kind = BY_NAME.get(link.owner)
    if kind is None:
        return
    yield from getattr(profile, kind.pool, [])


def _applies(owner, link: Link) -> bool:
    """``when`` gate: ``("kind", "on_ready")`` requires the sibling to equal it, a ``!`` prefix
    requires it not to."""
    if link.when is None:
        return True
    name, want = link.when
    have = getattr(owner, name, None)
    return have != want[1:] if want.startswith("!") else have == want


def _walk(obj, segments: list[str]) -> Iterator:
    """Resolve a storage path segment by segment. ``foo[]`` descends into a list of models,
    ``foo{}`` into a dict's values; a bare name is a plain attribute."""
    if not segments:
        yield obj
        return
    seg, rest = segments[0], segments[1:]
    if seg.endswith("[]"):
        for item in getattr(obj, seg[:-2], None) or []:
            yield from _walk(item, rest)
    elif seg.endswith("{}"):
        for item in (getattr(obj, seg[:-2], None) or {}).values():
            yield from _walk(item, rest)
    else:
        yield from _walk(getattr(obj, seg, None), rest)


def refs(profile, link: Link) -> Iterator[tuple[str, str]]:
    """``(owner_id, ref)`` for every non-blank ref a link holds across the whole profile.
    A terminal that is a list yields each entry; for ``dictkey`` it is the dict's KEYS that are
    the refs (``action.slots``/``action.reg_ops`` are keyed by register id)."""
    segments = link.field.split(".")
    for owner in owners(profile, link):
        if not _applies(owner, link):
            continue
        oid = getattr(owner, "id", "")
        for value in _walk(owner, segments):
            if value is None:
                continue
            if link.grammar == "dictkey":
                for key in (value or {}):
                    if key:
                        yield oid, key
            elif isinstance(value, (list, tuple)):
                for entry in value:
                    if entry:
                        yield oid, entry
            elif value:
                yield oid, value


def parse_ref(ref: str) -> tuple[str, str, str | None] | None:
    """Split a prefixed ref into ``(prefix, id, key)``. ``"register:foo#bar@nonblank"`` ->
    ``("register", "foo", "bar")`` — the facet suffix is stripped off the key. ``None`` for an
    unprefixed/blank ref (nothing to resolve)."""
    if not ref or ":" not in ref:
        return None
    prefix, rest = ref.split(":", 1)
    if "#" in rest:
        rid, key = rest.split("#", 1)
        key = key.split("@", 1)[0]
    else:
        rid, key = rest, None
    return prefix, rid, key


def link_for(owner: str, field: str) -> Link:
    """The one row for a field — how a consumer asks the table "what may go here?"."""
    for ln in LINKS:
        if ln.owner == owner and ln.field == field:
            return ln
    raise KeyError(f"no wiring link for {owner}.{field}")


def prefixes(kinds: tuple[str, ...]) -> set[str]:
    """The ref prefixes several kinds are written with (``register_key`` -> ``register``)."""
    return {BY_NAME[n].prefix for n in kinds if n in BY_NAME and BY_NAME[n].prefix}


def kinds_for_prefix(link: Link, prefix: str) -> list[Kind]:
    """The kinds a link accepts that use this ref prefix (``register`` matches all three
    register grammars) — empty means the prefix is not wireable here."""
    return [BY_NAME[n] for n in link.kinds if n in BY_NAME and BY_NAME[n].prefix == prefix]


# --------------------------------------------------------------------------- serialization

def as_dict() -> dict:
    """The whole table as plain JSON for ``GET /api/wiring`` — the front-end derives its pickers,
    port-drop targets, repoint registry and node-id prefixes from exactly these rows."""
    return {
        "kinds": [
            {"name": k.name, "label": k.label, "pool": k.pool, "prefix": k.prefix, "key": k.key,
             "node_type": k.node_type, "node_prefix": k.node_prefix,
             "pretty_path": k.pretty_path, "token_head": k.token_head}
            for k in KINDS
        ],
        "links": [
            {"owner": ln.owner, "field": ln.field, "grammar": ln.grammar,
             "kinds": list(ln.kinds), "verb": ln.verb, "label": ln.label or label_for(ln.kinds),
             "when": list(ln.when) if ln.when else None, "decl": ln.decl, "port": ln.port,
             "port_when": list(ln.port_when), "prune": ln.prune,
             "picker": list(ln.picker or ln.kinds),
             "ports": list(ln.ports or ln.kinds)}
            for ln in LINKS
        ],
        "facets": [{"id": f, "label": lbl} for f, lbl in FACETS],
        "vocab": {name: [{"id": o.id, "label": o.label, "desc": o.desc, "group": o.group,
                          "no_arg": o.no_arg} for o in v] for name, v in VOCAB.items()},
        "aliases": ALIASES,
    }
