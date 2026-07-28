"""The guards that keep ``oc.profile.wiring`` from going stale.

Two failure modes killed the checker before this table existed: a new *kind* became legal in the
model/UI/runtime but not in the checker (an action's ``window:`` source — every window-bound
action node reported as broken), and a new ref-holding *field* was added that nothing validated
at all. The first is caught by checking the SHIPPED profile stays clean; the second by asserting
every model field is either a table row or an explicitly-declared non-ref.
"""

from __future__ import annotations

import inspect
from pathlib import Path
from typing import get_args

import pytest

from oc.profile import models as m
from oc.profile import wiring
from oc.profile.checker import check_profile
from oc.profile.loader import load_profile

PROFILES = Path(__file__).resolve().parents[1] / "config" / "games"


# ---- guard 1: the shipped profile must check clean ------------------------------------------

@pytest.mark.parametrize("name", sorted(p.stem for p in PROFILES.glob("*.yaml")
                                        if not p.name.endswith(".pretty.yaml")))
def test_shipped_profile_is_clean(name):
    """Every profile in ``config/games`` must report zero issues. A checker that no longer knows
    a legal wiring shows up HERE, as a red test, instead of as a "Profile has errors" banner the
    user is told to fix by hand."""
    issues = check_profile(load_profile(PROFILES, name))
    assert issues == [], "\n".join(f"[{i.severity}] {i.node}: {i.msg}" for i in issues)


# ---- guard 2: every model field is classified ------------------------------------------------

# Fields that hold no reference to another node: raw geometry, OCR/preprocess knobs, labels,
# filesystem paths, COLUMN names (a dataset's own column vocabulary, not a node id), and the
# opaque layout blobs. Anything not here must be a LINKS row — that is the point of the test.
NON_REF: dict[str, set[str]] = {
    "GameProfile": {"actions", "atlas", "datasets", "dictionaries", "exe", "fields",
                    "file_sources", "gates", "layout", "name", "notes", "process",
                    "process_names", "processes", "producers", "registers", "routers", "settings",
                    "overlays", "sounds", "subsets", "testing", "title", "toasts", "triggers",
                    "window_title_hint", "windows"},
    "WindowDef": {"capture", "config_collapsed", "cutouts", "data_area", "dedup", "detect",
                  "detect_mode", "enabled", "grid", "id", "items", "key", "live", "notes",
                  "preprocess", "readouts", "record_mode", "regions", "scroll", "settle_ms",
                  "states", "static_grid", "title"},
    "FieldDef": {"confidence_min", "confirm", "corroborate", "extract", "glyph_check", "id",
                 "isolate", "label", "match", "min_confidence", "notes", "preprocess", "rules",
                 "strip", "type", "unit"},
    "FieldRule": {"arg", "case_sensitive", "cutoff", "dict_mode", "enabled", "fuzzy", "group",
                  "max", "min", "mode", "notes", "pattern", "sep", "strategy", "then", "value",
                  "when"},
    "DatasetDef": {"aggregate", "batch_mode", "columns", "dedup", "id", "keep_batches",
                   "key_field", "key_fields", "key_norm", "kind", "notes", "reopen_grace",
                   "retention", "sync_mode", "test_row"},
    "SubsetDef": {"config_collapsed", "derived", "distinct", "distinct_by", "filters",
                  "hidden_columns", "id", "latest_batch", "limit", "notes", "pivot", "sort",
                  "sort_by", "sort_desc", "sorts", "sources"},
    "ProducerDef": {"id", "type", "mode", "throttle", "enabled", "key", "fields", "http",
                    "source_field", "source_array", "identity_field", "notes", "queue_mode"},
    "FileSourceDef": {"enabled", "encoding", "fields", "filename", "format", "id", "key",
                      "line_position", "match", "notes", "path", "roots", "tail", "tail_lines",
                      "throttle_s", "watch"},
    "TriggerDef": {"confirm_frames", "cooldown_s", "enabled", "id", "input_button",
                   "input_double_ms", "input_event", "input_mods", "input_rect", "interval_s",
                   "item_watch", "key_watch", "kind", "notes", "queue_mode", "quiet_ms",
                   "ready_field", "reopen_grace", "settle_max_ms", "settle_ms", "throttle_ms"},
    "GateDef": {"id", "conds", "logic", "negate", "enabled", "notes"},
    "RouterDef": {"id", "branches", "enabled", "notes"},
    "RouterBranch": {"conds", "logic"},
    "ToastDef": {"accumulate", "accumulate_cap", "app_name", "attribution", "duration", "enabled",
                 "icon", "id", "images", "message", "muted", "notes", "replace_key", "show_icon",
                 "texts", "title"},
    "SoundDef": {"enabled", "file", "id", "notes", "synth", "volume"},
    # `window` and `sources` ARE refs and carry LINKS rows; everything else here is plain config.
    # `widgets` holds front-end-owned widget models (extra=allow), not node refs — a widget's own
    # {{token}} bindings are resolved at render time, exactly like a toast's text.
    "OverlayDef": {"enabled", "follow_window", "id", "manual", "notes", "pulse_ms", "states",
                   "widgets"},
    "OverlayWidgetDef": {"h", "id", "type", "w", "x", "y"},
    "ActionDef": {"id", "action", "delay_ms", "repeat", "repeat_ms", "enabled", "notes",
                  "input_events"},
    "RegisterOp": {"op", "keys", "writes"},
    "RegisterDef": {"aggregate", "aggregate_arg", "capacity", "enabled", "id", "ignore_empty",
                    "keys", "notes", "ring", "title"},
    "ProcessDef": {"enabled", "id", "notes", "rules", "sources", "type"},
    "ProcessInput": {"out"},
    "DictionaryDef": {"cutoff", "enabled", "feeds", "id", "mode", "notes", "source", "terms"},
    "DictFeed": {"columns"},
    "JoinSource": {"aggregate", "exclude", "how", "join_field", "join_norm", "mode", "norm",
                   "prefer_newest", "prefix", "required"},
}


def _model_of(ann):
    """The model class a field annotation ultimately holds — unwrapping ``list[X]``,
    ``dict[str, X]`` and ``X | None`` — or ``None`` for a scalar field."""
    if inspect.isclass(ann) and issubclass(ann, m.BaseModel):
        return ann
    for arg in get_args(ann) or ():
        found = _model_of(arg)
        if found is not None:
            return found
    return None


def _owner_class(owner: str):
    """The model class a link's ``owner`` names (``"profile"`` = the whole game profile)."""
    if owner == "profile":
        return m.GameProfile
    kind = wiring.BY_NAME[owner]
    for cls_name, cls in vars(m).items():
        if inspect.isclass(cls) and issubclass(cls, m.BaseModel) \
                and cls_name.lower() == kind.name.replace("_", "") + "def":
            return cls
    return None


def _link_fields() -> set[tuple[str, str]]:
    """``(ClassName, field)`` for every field a LINKS row touches, INCLUDING the nested ones a
    path descends through (``dictionary.feeds[].dataset`` covers ``DictFeed.dataset`` too), so a
    nested ref carrier counts as classified without being re-listed by hand."""
    covered: set[tuple[str, str]] = set()
    for ln in wiring.LINKS:
        cls = _owner_class(ln.owner)
        for seg in ln.field.split("."):
            if cls is None:
                break
            name = seg.removesuffix("[]").removesuffix("{}")
            info = cls.model_fields.get(name)
            if info is None:
                break
            covered.add((cls.__name__, name))
            cls = _model_of(info.annotation)
    return covered


def test_every_model_field_is_a_link_or_declared_non_ref():
    """No model field may be silently unclassified: it either points at another node (a LINKS
    row) or is declared non-referential above. Adding a ref field without a table row fails
    here, which is the whole reason the table can't rot."""
    linked = _link_fields()
    unclassified: list[str] = []
    for cls_name, cls in vars(m).items():
        if not (inspect.isclass(cls) and issubclass(cls, m.BaseModel)):
            continue
        known = NON_REF.get(cls_name)
        if known is None:
            continue          # nested value objects (Box, Preprocess, ...) hold no node refs
        for fname in cls.model_fields:
            if fname in known or (cls_name, fname) in linked:
                continue
            unclassified.append(f"{cls_name}.{fname}")
    assert not unclassified, (
        "unclassified model fields — add a wiring.LINKS row if the field points at another "
        f"node, or list it in NON_REF here: {sorted(unclassified)}")


# ---- the table's own shape --------------------------------------------------------------

def test_links_reference_known_kinds_and_paths():
    """Every kind a link names must exist, and every link's owner must be a real collection —
    a typo'd row would otherwise silently validate nothing."""
    for ln in wiring.LINKS:
        assert ln.grammar in ("prefixed", "bare", "dictkey"), ln
        for name in ln.kinds:
            assert name in wiring.BY_NAME, f"{ln.owner}.{ln.field} names unknown kind '{name}'"
        assert ln.owner == "profile" or ln.owner in wiring.BY_NAME, ln
        if ln.grammar == "prefixed":
            assert all(wiring.BY_NAME[n].prefix for n in ln.kinds), \
                f"{ln.owner}.{ln.field} is prefixed but a kind has no ref prefix"


def test_as_dict_is_json_serializable():
    """The front-end derives its pickers/ports from this payload — it must survive JSON."""
    import json
    data = json.loads(json.dumps(wiring.as_dict()))
    assert {k["name"] for k in data["kinds"]} == {k.name for k in wiring.KINDS}
    assert len(data["links"]) == len(wiring.LINKS)
