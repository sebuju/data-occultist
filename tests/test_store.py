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


def test_present_keys(tmp_path):
    s = _store(tmp_path)
    s.record_seen({"name": "Serration"})
    s.record_seen({"name": "Vitality"})
    assert s.present_keys() == {"serration", "vitality"}
    s.remove_keys({"vitality"})
    assert s.present_keys() == {"serration"}


def test_remove_keys_soft(tmp_path):
    s = _store(tmp_path)
    s.record_seen({"name": "Serration", "rank": 5})
    removed = s.remove_keys({"serration"})
    assert [e.key for e in removed] == ["serration"]
    assert s.present_count == 0
    s.remove_keys({"serration"})           # already absent -> no-op
    assert s.present_count == 0
    # soft: the last observation survives in history for a non-present read
    row = next(r for r in s.records() if r["key"] == "serration")
    assert row["present"] is False and row["rank"] == 5


def test_remove_keys_empty_noop(tmp_path):
    s = _store(tmp_path)
    s.record_seen({"name": "Serration"})
    assert s.remove_keys(set()) == []
    assert s.present_count == 1


def test_positions_roundtrip_and_on_records(tmp_path):
    s = _store(tmp_path)
    s.record_seen({"name": "Lith G1"})
    s.record_seen({"name": "Meso F2"})
    s.set_positions({"lith_g1": (0.0, 3.0), "meso_f2": (1.0, 7.0)})   # (col index, vpos row index)
    assert s.positions() == {"lith_g1": (0.0, 3.0), "meso_f2": (1.0, 7.0)}
    s.set_positions({"lith_g1": (0.0, 5.0)})           # upsert one
    assert s.positions()["lith_g1"] == (0.0, 5.0)
    rows = {r["key"]: r["_pos"] for r in s.records()}   # _pos shows "(row, col)" — both integer indices
    assert rows["lith_g1"] == "(5, 0)" and rows["meso_f2"] == "(7, 1)"
    # positions survive a reopen (own table, not rebuilt with `current`)
    assert DatasetStore(tmp_path, "game", "mods").positions()["meso_f2"] == (1.0, 7.0)


def test_pos_not_a_data_column(tmp_path):
    s = _store(tmp_path)
    s.record_seen({"name": "Lith G1"})
    s.set_positions({"lith_g1": (0.1, 0.25)})
    assert "_pos" not in s.summary()["columns"]   # plumbing, not a record field


def test_remove_keys_drops_position(tmp_path):
    s = _store(tmp_path)
    s.record_seen({"name": "Lith G1"})
    s.set_positions({"lith_g1": (0.1, 0.25)})
    s.remove_keys({"lith_g1"})
    assert s.positions() == {}                    # a gone key's position is meaningless


def test_remove_after_cuts_stale_far_rows(tmp_path):
    s = _store(tmp_path)
    for nm in ["Lith A1", "Lith B2", "Lith C3", "Stale X9"]:
        s.record_seen({"name": nm})
    # three real relics at row indices 0..2; a stale misread parked far down at row 57
    s.set_positions({"lith_a1": (0.1, 0.0), "lith_b2": (0.1, 1.0),
                     "lith_c3": (0.1, 2.0), "stale_x9": (0.1, 57.0)})
    s.remove_after(8)                          # terminator sits at row ~8 -> drop everything past it
    assert s.present_keys() == {"lith_a1", "lith_b2", "lith_c3"}
    assert "stale_x9" not in s.positions()     # remove_keys drops its position too
    assert s.remove_after(100) == []           # nothing past the cutoff -> no-op


def test_remove_after_cuts_same_row_at_or_after_terminator_column(tmp_path):
    # a not_owned guard mid-row: columns BEFORE it on that row are still legitimately owned;
    # columns AT OR AFTER it, same row, are not -- a row-only cutoff would wrongly keep those.
    s = _store(tmp_path)
    for nm in ["Axi A1", "Axi A2", "Axi A3", "Axi B1", "Axi B2"]:
        s.record_seen({"name": nm})
    # row 0: cols 0,1 owned, col 2 is the not_owned guard's slot -> row 0 col>=2 unowned
    # row 1 (entirely past the guard's row): unowned regardless of column
    s.set_positions({"axi_a1": (0.0, 0.0), "axi_a2": (1.0, 0.0), "axi_a3": (2.0, 0.0),
                     "axi_b1": (0.0, 1.0), "axi_b2": (3.0, 1.0)})
    s.remove_after(0, 2)                       # terminator at row 0, col 2
    assert s.present_keys() == {"axi_a1", "axi_a2"}


def test_remove_after_col_cutoff_defaults_to_row_start(tmp_path):
    # no col_cutoff given -> the whole cutoff row goes (old row-only behaviour), unchanged
    s = _store(tmp_path)
    s.record_seen({"name": "Axi A1"})
    s.set_positions({"axi_a1": (3.0, 5.0)})    # row 5, col 3
    s.remove_after(5)                          # cutoff row 5, no column given
    assert s.present_keys() == set()


def test_positions_follow_rename_and_delete(tmp_path):
    s = _store(tmp_path)
    s.record_seen({"name": "Lith G1"})
    s.set_positions({"lith_g1": (0.1, 0.25)})
    assert rename_dataset(tmp_path, "game", "mods", "relics") is True
    assert DatasetStore(tmp_path, "game", "relics").positions() == {"lith_g1": (0.1, 0.25)}
    delete_dataset(tmp_path, "game", "relics")
    assert DatasetStore(tmp_path, "game", "relics").positions() == {}


def test_clear_data_drops_positions(tmp_path):
    s = _store(tmp_path)
    s.record_seen({"name": "Lith G1"})
    s.set_positions({"lith_g1": (0.1, 0.25)})
    s.clear_data()
    assert s.positions() == {}


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
    assert rename_dataset(tmp_path, "game", "mods", "arsenal") is True
    from oc.store import inspect
    names = inspect.list_datasets(tmp_path, "game")
    assert "mods" not in names and "arsenal" in names
    # records carry over under the new name
    assert DatasetStore(tmp_path, "game", "arsenal").present_count == 1


def test_rename_dataset_refuses_existing_target(tmp_path):
    _store(tmp_path).record_seen({"name": "Serration"})   # "mods" on disk
    DatasetStore(tmp_path, "game", "arsenal").record_seen({"name": "Vitality"})  # target exists
    with pytest.raises(FileExistsError):
        rename_dataset(tmp_path, "game", "mods", "arsenal")
    from oc.store import inspect
    assert "mods" in inspect.list_datasets(tmp_path, "game")  # untouched


def test_rename_dataset_missing_is_noop(tmp_path):
    assert rename_dataset(tmp_path, "game", "nope", "other") is False


def test_delete_dataset_removes_files(tmp_path):
    from oc.store import inspect
    s = _store(tmp_path)            # dataset "mods"
    s.record_seen({"name": "Serration", "rank": 1})
    assert "mods" in inspect.list_datasets(tmp_path, "game")
    assert delete_dataset(tmp_path, "game", "mods") is True
    assert "mods" not in inspect.list_datasets(tmp_path, "game")
    assert DatasetStore(tmp_path, "game", "mods").present_count == 0


def test_delete_dataset_missing_is_noop(tmp_path):
    assert delete_dataset(tmp_path, "game", "nope") is False


def test_drop_database_empties_all_datasets(tmp_path):
    from oc.store import inspect
    from oc.store.dataset_store import drop_database
    _store(tmp_path).record_seen({"name": "Serration"})                 # "mods"
    DatasetStore(tmp_path, "game", "arsenal").record_seen({"name": "Excalibur"})
    removed = drop_database(tmp_path, "game")
    assert set(removed) == {"mods", "arsenal"}                          # reports what existed
    assert inspect.list_datasets(tmp_path, "game") == []                # all gone
    assert DatasetStore(tmp_path, "game", "mods").present_count == 0    # fresh, not absent
    # a node resurrects its dataset on the next write
    DatasetStore(tmp_path, "game", "mods").record_seen({"name": "Vitality"})
    assert "mods" in inspect.list_datasets(tmp_path, "game")


def test_drop_database_missing_is_noop(tmp_path):
    from oc.store.dataset_store import drop_database
    assert drop_database(tmp_path, "game") == []


def test_clear_table_empties_one_table(tmp_path):
    from oc.store.dataset_store import clear_table
    s = _store(tmp_path)
    s.record_seen({"name": "Serration", "rank": 1})
    assert clear_table(tmp_path, "game", "events") >= 1                 # rows removed
    assert DatasetStore(tmp_path, "game", "mods").history(10) == []     # ledger empty


def test_clear_table_rejects_unknown(tmp_path):
    from oc.store.dataset_store import clear_table
    _store(tmp_path).record_seen({"name": "Serration"})
    with pytest.raises(KeyError):
        clear_table(tmp_path, "game", "events; DROP TABLE events")


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
    h = s.history()
    assert h and h[0]["op"] == "add" and h[0]["values"]["name"] == "Serration"
    # committed to the DB -> a fresh store reads it back
    s2 = DatasetStore(tmp_path, "game", "mods")
    assert s2.records()[0]["name"] == "Serration"


def test_fresh_reader_sees_all_committed_writes(tmp_path):
    # SQLite is the single source of truth: a second store opened mid-stream sees every
    # committed event. There's no derived snapshot cache that could lag the ledger (the bug
    # class the old JSONL+state.json design fought).
    s = _store(tmp_path)
    s.record_seen({"name": "a"})
    s.record_seen({"name": "b"})
    s.record_seen({"name": "c"})
    assert DatasetStore(tmp_path, "game", "mods").present_count == 3
