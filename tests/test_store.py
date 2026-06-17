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


def _poison_state_cache(tmp_path, dataset, drop):
    """Forge the bug: rewrite <dataset>.state.json to DROP `drop` records while stamping it with
    the CURRENT history src + the live cache version — i.e. a snapshot that looks valid but lags
    the ledger. This is what the old racy post-build `stat()` could leave on disk."""
    import json
    from oc.store import dataset_store as dsmod
    g = tmp_path / "game"
    hist = g / f"{dataset}.history.jsonl"
    st = hist.stat()
    sp = g / f"{dataset}.state.json"
    state = json.loads(sp.read_text(encoding="utf-8"))
    keys = list(state["state"])
    for k in keys[-drop:]:
        del state["state"][k]
    state["_meta"]["src"] = {"size": st.st_size, "mtime": st.st_mtime_ns}
    state["_meta"]["v"] = dsmod.CACHE_V
    state["_meta"]["n_events"] = len(state["state"])
    sp.write_text(json.dumps(state), encoding="utf-8")


def test_poisoned_state_cache_heals_to_ledger(tmp_path):
    # The reported bug: batches (events) showed all records, but the data (keyed state) lagged —
    # and stayed wrong. A stale-but-trusted state cache must never outvote the ledger.
    s = _store(tmp_path)
    for i in range(4):
        s.record_seen({"name": f"item{i}", "rank": i})
    s.save()
    assert s.present_count == 4
    _poison_state_cache(tmp_path, "mods", drop=1)   # state.json now claims 3, with a matching src

    reopened = _store(tmp_path)
    reopened.ensure_loaded()                         # what the dashboard detail/subset path does
    assert reopened.present_count == 4               # healed from the ledger
    assert len(reopened.records()) == 4
    # batches were always right; records must now agree
    assert sum(b["count"] for b in reopened.batches(80)) == 4


def test_old_format_summary_sidecar_rejected(tmp_path):
    # A sidecar written by the buggy version (its racy `src` could overstate the content, and it
    # carried no version field) must NOT be trusted: the version bump rejects it, forcing a
    # reparse so the /api/flow count can't stick at a stale low value.
    import json
    from oc.store import inspect
    s = _store(tmp_path)
    for i in range(4):
        s.record_seen({"name": f"item{i}", "rank": i})
    s.save()
    sidecar = tmp_path / "game" / "mods.summary.json"
    sm = json.loads(sidecar.read_text(encoding="utf-8"))
    hist = (tmp_path / "game" / "mods.history.jsonl").stat()
    # old format: stale count + matching src, but NO version field (or an old one)
    sm.pop("v", None)
    sm.update(present=3, total=3, src={"size": hist.st_size, "mtime": hist.st_mtime_ns})
    sidecar.write_text(json.dumps(sm), encoding="utf-8")

    out = inspect.summarize(tmp_path, "game", "mods")
    assert out["total"] == 4 and out["present"] == 4   # rejected -> reparsed from the ledger


def test_content_src_never_overstates(tmp_path):
    # Invariant behind the fix: a saved cache is stamped with the src of the content it holds,
    # never a newer stat. So after a writer appends past a snapshot, a fresh reader that opens
    # mid-stream rejects the older snapshot and reparses — it can't trust a lagging cache.
    s = _store(tmp_path)
    s.record_seen({"name": "a"})
    s.save()
    # append two more WITHOUT saving the snapshot, so state.json lags the ledger
    s.record_seen({"name": "b"})
    s.record_seen({"name": "c"})
    # a fresh reader sees 3 events on disk but a 1-record snapshot stamped at the 1-event src
    r = _store(tmp_path)
    assert r.present_count == 3            # reparsed, not the stale 1-record snapshot
