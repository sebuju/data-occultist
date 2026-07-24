"""ActionDef's legacy migration to per-register `reg_ops` — pure pydantic validation, no GPU.

Before `reg_ops` existed, a register target rode the action node's SHARED `action`/`slots`/`dest`
fields (the same ones a dataset target used). `_migrate_reg_ops` folds that shape into a per-register
`RegisterOp` entry so an old profile keeps behaving exactly the same way once loaded under the new
model. A narrowed legacy `clear` (`slots[reg_id]` non-empty) becomes a `set` op with a `remove` row
per targeted key (the per-row remove toggle IS that narrowed-clear now); an unnarrowed legacy `clear`
becomes `remove_all`; `clone_*`/`move_*` map across (aliased to plain `clone`/`move` — a register has
no batch grouping, so the dataset-shaped batches/resolved distinction never applied to it), `slots`
-> `keys`. That alias normalization runs unconditionally, not just on a freshly-folded register: an
existing `reg_ops[id].op` already carrying the old dataset-shaped value gets fixed too. `dest` is
similarly always coerced to a prefixed `"dataset:<id>"`/`"register:<id>"` ref — before a register's
clone/move dest could be another register too, EVERY `dest` (folded or already-saved) was a bare
dataset id.
"""

from oc.profile.models import ActionDef


def test_narrowed_clear_migrates_to_set_with_remove_rows():
    a = ActionDef.model_validate({
        "id": "a", "action": "clear", "sources": ["register:hp"], "slots": {"hp": ["shield"]},
    })
    op = a.reg_ops["hp"]
    assert op.op == "set"
    assert [(w.key, w.remove) for w in op.writes] == [("shield", True)]


def test_unnarrowed_clear_migrates_to_remove_all():
    a = ActionDef.model_validate({"id": "a", "action": "clear", "sources": ["register:hp"]})
    assert a.reg_ops["hp"].op == "remove_all"
    assert a.reg_ops["hp"].writes == []


def test_clone_migrates_with_keys_and_dest_aliased_to_plain_clone():
    a = ActionDef.model_validate({
        "id": "a", "action": "clone_resolved", "sources": ["register:hp"],
        "slots": {"hp": ["health"]}, "dest": "dst",
    })
    op = a.reg_ops["hp"]
    assert op.op == "clone"      # dataset-shaped clone_resolved aliased -- a register has no batches
    assert op.dest == "dataset:dst"   # bare legacy dest coerced to a prefixed ref
    assert op.keys == ["health"]


def test_move_batches_migrates_aliased_to_plain_move():
    a = ActionDef.model_validate({
        "id": "a", "action": "move_batches", "sources": ["register:hp"], "dest": "dst",
    })
    assert a.reg_ops["hp"].op == "move"


def test_dataset_only_action_gets_no_reg_ops():
    a = ActionDef.model_validate({"id": "a", "action": "clear", "sources": ["dataset:ds"]})
    assert a.reg_ops == {}


def test_new_style_profile_with_reg_ops_passes_through_unchanged():
    a = ActionDef.model_validate({
        "id": "a", "sources": ["register:hp"],
        "reg_ops": {"hp": {"op": "set", "writes": [{"key": "k", "value": "5"}]}},
    })
    assert a.reg_ops["hp"].op == "set"
    assert a.reg_ops["hp"].writes[0].key == "k"
    assert a.reg_ops["hp"].writes[0].value == "5"


def test_existing_reg_ops_entry_is_not_overwritten_by_legacy_fields():
    # a register already migrated (or hand-authored) keeps its own reg_ops even if legacy
    # action/slots/dest are still present in the same document (stale leftovers, not authoritative).
    a = ActionDef.model_validate({
        "id": "a", "action": "clear", "sources": ["register:hp"],
        "reg_ops": {"hp": {"op": "remove_all"}},
    })
    assert a.reg_ops["hp"].op == "remove_all"
    assert a.reg_ops["hp"].writes == []


def test_existing_reg_ops_op_normalizes_old_batches_alias_even_without_legacy_action():
    # a register op saved directly with the pre-collapse dataset-shaped value (not via the
    # action/slots/dest fold above) still gets fixed -- this is the actual shape a profile saved
    # before the clone/move collapse would have on disk, with no legacy `action` field to trigger
    # the fold path at all.
    a = ActionDef.model_validate({
        "id": "a", "sources": ["register:hp"],
        "reg_ops": {"hp": {"op": "clone_batches", "dest": "dst"}},
    })
    assert a.reg_ops["hp"].op == "clone"
    assert a.reg_ops["hp"].dest == "dataset:dst"   # bare pre-feature dest coerced to a prefixed ref too


def test_existing_reg_ops_prefixed_dest_untouched():
    # already carrying a prefix (either kind) -- not re-prefixed / not touched at all
    a = ActionDef.model_validate({
        "id": "a", "sources": ["register:hp"],
        "reg_ops": {"hp": {"op": "clone", "dest": "register:mp"}},
    })
    assert a.reg_ops["hp"].dest == "register:mp"
