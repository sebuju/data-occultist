"""Dataset-level trigger actions (clear / clone / move) — pure logic, no network/GPU.

Exercises :func:`oc.store.dataset_ops.run_dataset_action` against real DatasetStores opened
through ``store_for`` (so the destination's key spec applies), plus the ``TriggerRunner`` +
route dispatch that funnels through it.
"""

from oc.collect.triggers import TriggerRunner
from oc.profile.models import ActionDef, DatasetDef, GameProfile, TriggerDef
from oc.store import store_for
from oc.store.dataset_ops import run_dataset_action


def _seed(tmp_path, profile, dataset, rows, *, batched=False):
    """Write ``rows`` into ``dataset`` — one batch each when ``batched`` else one batch total."""
    st = store_for(tmp_path, "g", dataset, profile=profile)
    if not batched:
        st.begin_batch()
    for r in rows:
        if batched:
            st.begin_batch()
        st.record_seen(r)
    return st


def _present(tmp_path, profile, dataset):
    st = store_for(tmp_path, "g", dataset, profile=profile)
    return [r for r in st.records() if r.get("present")]


def test_clone_resolved_copies_present_rows_only(tmp_path):
    p = GameProfile(name="g")
    src = _seed(tmp_path, p, "src", [{"name": "A", "v": 1}, {"name": "B", "v": 2}])
    src.remove_keys({src.key_of({"name": "B"})})            # soft-remove B -> absent, not deleted

    out = run_dataset_action(tmp_path, "g", p, source="src", action="clone_resolved", dest="dst")
    assert out["rows"] == 1                                  # only the present key copied
    names = {r["name"] for r in _present(tmp_path, p, "dst")}
    assert names == {"A"}                                    # B not resurrected in the dest


def test_clone_batches_preserves_grouping(tmp_path):
    p = GameProfile(name="g")
    _seed(tmp_path, p, "src", [{"name": "A"}, {"name": "B"}], batched=True)   # two batches

    out = run_dataset_action(tmp_path, "g", p, source="src", action="clone_batches", dest="dst")
    assert out["rows"] == 2
    dst = store_for(tmp_path, "g", "dst", profile=p)
    assert len(dst.batches(limit=0)) == 2                    # grouping preserved, not flattened
    assert {r["name"] for r in dst.records()} == {"A", "B"}


def test_move_clears_source(tmp_path):
    p = GameProfile(name="g")
    _seed(tmp_path, p, "src", [{"name": "A"}, {"name": "B"}])

    out = run_dataset_action(tmp_path, "g", p, source="src", action="move_resolved", dest="dst")
    assert out["rows"] == 2
    assert _present(tmp_path, p, "src") == []               # source emptied by the move
    assert {r["name"] for r in _present(tmp_path, p, "dst")} == {"A", "B"}


def test_clear_empties_the_dataset(tmp_path):
    p = GameProfile(name="g")
    _seed(tmp_path, p, "src", [{"name": "A"}, {"name": "B"}])
    out = run_dataset_action(tmp_path, "g", p, source="src", action="clear", dest="")
    assert out["action"] == "clear"
    assert _present(tmp_path, p, "src") == []


def test_dest_re_keys_under_destination_spec(tmp_path):
    # src keys on name (default); dst keys on `sku` — the copied raw values re-key on write
    p = GameProfile(name="g", datasets=[DatasetDef(id="dst", key_field="sku")])
    _seed(tmp_path, p, "src", [{"name": "Thing", "sku": "XYZ"}])
    run_dataset_action(tmp_path, "g", p, source="src", action="clone_resolved", dest="dst")
    dst = store_for(tmp_path, "g", "dst", profile=p)
    assert dst.records()[0]["key"] == "xyz"                 # keyed by sku under the dest spec


def test_guards_prevent_data_loss_and_noops(tmp_path):
    p = GameProfile(name="g")
    _seed(tmp_path, p, "src", [{"name": "A"}])
    # move onto self would clone src->src then clear it = total loss -> must no-op
    assert run_dataset_action(tmp_path, "g", p, source="src", action="move_resolved", dest="src") == {}
    # clone/move with no dest -> no-op; unknown action -> no-op
    assert run_dataset_action(tmp_path, "g", p, source="src", action="clone_resolved", dest="") == {}
    assert run_dataset_action(tmp_path, "g", p, source="src", action="bogus", dest="dst") == {}
    assert {r["name"] for r in _present(tmp_path, p, "src")} == {"A"}   # source untouched


def _lifecycle_profile():
    # the dataset action (clear "d") is its own node now, fired via the trigger's targets.
    return GameProfile(name="g",
        actions=[ActionDef(id="clr", action="clear", datasets=["d"])],
        triggers=[
            TriggerDef(id="start", kind="on_live_start", targets=["clr"]),
            TriggerDef(id="stop", kind="on_live_stop"),
            TriggerDef(id="cap", kind="on_capture"),
        ])


def test_fire_live_start_stop_only_fire_their_kind():
    tr = TriggerRunner(_lifecycle_profile(), "data", clock=lambda: 0.0)
    assert tr.fire_live_start() == ["start"]
    assert tr.fire_live_stop() == ["stop"]
    assert tr.fire_capture() == ["cap"]


def test_fire_targets_runs_dataset_action(tmp_path):
    p = _lifecycle_profile()
    _seed(tmp_path, p, "d", [{"name": "A"}, {"name": "B"}])
    tr = TriggerRunner(p, tmp_path, clock=lambda: 0.0)
    assert tr.fire_live_start() == ["start"]                # clears dataset "d" via the action
    assert _present(tmp_path, p, "d") == []
