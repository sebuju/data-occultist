import pytest

from oc.store import ChangeOp
from oc.store.dataset_store import DatasetStore, delete_dataset, rename_dataset


def _store(tmp_path, clock=None):
    seq = {"n": 0}
    def tick():
        seq["n"] += 1
        return f"t{seq['n']}"
    return DatasetStore(tmp_path, "game", "mods", clock=clock or tick)


def test_add_then_no_change(tmp_path):
    s = _store(tmp_path)
    ev = s.record_seen({"name": "Serration", "rank": 5})
    assert ev and ev.op is ChangeOp.add
    assert s.record_seen({"name": "Serration", "rank": 5}) is None  # identical -> no event
    assert s.present_count == 1


def test_observations_accumulate_on_change(tmp_path):
    s = _store(tmp_path)
    s.record_seen({"name": "Serration", "rank": 1})
    assert s.record_seen({"name": "Serration", "rank": 1}) is None   # identical → no new obs
    s.record_seen({"name": "Serration", "rank": 2})
    s.record_seen({"name": "Serration", "rank": 3})
    row = s.records()[0]
    assert s.present_count == 1            # still one key
    assert row["rank"] == 3                # latest aggregate (default policy)
    assert row["_count"] == 3              # three distinct observations under the key
    assert [o["rank"] for o in s.observations("serration")] == [1, 2, 3]


def test_aggregate_policies(tmp_path):
    def feed(store):
        for c in (10, 20, 30):
            store.record_seen({"name": "X", "count": c})
    s = DatasetStore(tmp_path, "game", "agg", aggregate="sum"); feed(s)
    assert s.records()[0]["count"] == 60
    # same ledger, reopened under a different policy → recomputed from observations
    assert DatasetStore(tmp_path, "game", "agg", aggregate="mean").records()[0]["count"] == 20
    assert DatasetStore(tmp_path, "game", "agg", aggregate="max").records()[0]["count"] == 30
    assert DatasetStore(tmp_path, "game", "agg", aggregate="min").records()[0]["count"] == 10
    assert DatasetStore(tmp_path, "game", "agg", aggregate="first").records()[0]["count"] == 10
    assert DatasetStore(tmp_path, "game", "agg", aggregate="latest").records()[0]["count"] == 30


def test_observations_persist_across_reopen(tmp_path):
    s = _store(tmp_path)
    s.record_seen({"name": "A", "v": 1})
    s.record_seen({"name": "A", "v": 2})
    s2 = DatasetStore(tmp_path, "game", "mods")     # reload from ledger/cache
    row = s2.records()[0]
    assert row["_count"] == 2 and row["v"] == 2


def test_update_field_logs_change(tmp_path):
    s = _store(tmp_path)
    s.record_seen({"name": "Serration", "rank": 5})
    ev = s.record_seen({"name": "Serration", "rank": 6})  # ranked up
    assert ev.op is ChangeOp.update
    assert ev.changed["rank"] == [5, 6]


def test_reconcile_marks_removed(tmp_path):
    s = _store(tmp_path)
    s.record_seen({"name": "Serration"})
    s.record_seen({"name": "Vitality"})
    removed = s.reconcile({"serration"})  # Vitality absent from a full pass
    assert [e.key for e in removed] == ["vitality"]
    assert s.present_count == 1


def test_readd_after_removal(tmp_path):
    s = _store(tmp_path)
    s.record_seen({"name": "Serration"})
    s.reconcile(set())                        # removed
    ev = s.record_seen({"name": "Serration"})  # seen again -> add
    assert ev.op is ChangeOp.add
    assert s.present_count == 1


def test_rename_dataset_moves_files(tmp_path):
    s = _store(tmp_path)            # dataset "mods"
    s.record_seen({"name": "Serration", "rank": 1})
    s.save()
    g = tmp_path / "game"
    assert rename_dataset(tmp_path, "game", "mods", "arsenal") is True
    assert not (g / "mods.history.jsonl").exists()
    assert (g / "arsenal.history.jsonl").exists()
    # records carry over under the new name
    assert DatasetStore(tmp_path, "game", "arsenal").present_count == 1


def test_rename_dataset_refuses_existing_target(tmp_path):
    _store(tmp_path).record_seen({"name": "Serration"})   # "mods" on disk
    DatasetStore(tmp_path, "game", "arsenal").record_seen({"name": "Vitality"})  # target exists
    DatasetStore(tmp_path, "game", "mods").save()
    DatasetStore(tmp_path, "game", "arsenal").save()
    with pytest.raises(FileExistsError):
        rename_dataset(tmp_path, "game", "mods", "arsenal")
    assert (tmp_path / "game" / "mods.history.jsonl").exists()  # untouched


def test_rename_dataset_missing_is_noop(tmp_path):
    assert rename_dataset(tmp_path, "game", "nope", "other") is False


def test_delete_dataset_removes_files(tmp_path):
    s = _store(tmp_path)            # dataset "mods"
    s.record_seen({"name": "Serration", "rank": 1})
    s.save()
    g = tmp_path / "game"
    assert (g / "mods.history.jsonl").exists()
    assert delete_dataset(tmp_path, "game", "mods") is True
    for suf in (".history.jsonl", ".reverted.json", ".state.json"):
        assert not (g / f"mods{suf}").exists()


def test_delete_dataset_missing_is_noop(tmp_path):
    assert delete_dataset(tmp_path, "game", "nope") is False


def test_reading_missing_dataset_writes_no_files(tmp_path):
    # Merely opening a nonexistent dataset must not materialize a state cache — else
    # list_datasets resurfaces it (e.g. an old name after a rename) as a blank phantom.
    s = DatasetStore(tmp_path, "game", "ghost")
    assert s.present_count == 0
    g = tmp_path / "game"
    for suf in (".history.jsonl", ".reverted.json", ".state.json"):
        assert not (g / f"ghost{suf}").exists()
    from oc.store import inspect
    assert "ghost" not in inspect.list_datasets(tmp_path, "game")


def test_history_persists(tmp_path):
    s = _store(tmp_path)
    s.record_seen({"name": "Serration", "rank": 1})
    s.save()
    hist = (tmp_path / "game" / "mods.history.jsonl").read_text(encoding="utf-8")
    assert '"op": "add"' in hist
    state = (tmp_path / "game" / "mods.state.json").read_text(encoding="utf-8")
    assert "serration" in state
