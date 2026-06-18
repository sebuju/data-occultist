"""The dataset ledger is revertable: state is the replay of non-reverted events."""

from oc.store.dataset_store import DatasetStore, replay
from oc.store.change import ChangeEvent, ChangeOp
from oc.store.keys import KeySpec


def _store(tmp_path):
    seq = {"n": 0}
    def tick():
        seq["n"] += 1
        return f"t{seq['n']}"
    return DatasetStore(tmp_path, "game", "mods", clock=tick)


def test_events_get_monotonic_ids(tmp_path):
    s = _store(tmp_path)
    a = s.record_seen({"name": "Serration", "rank": 1})
    b = s.record_seen({"name": "Serration", "rank": 2})
    assert a.id == 1 and b.id == 2


def test_revert_update_falls_back_to_previous(tmp_path):
    s = _store(tmp_path)
    s.record_seen({"name": "Serration", "rank": 1})      # id 1
    up = s.record_seen({"name": "Serration", "rank": 2})  # id 2
    s.set_reverted(up.id)                                 # undo the rank-up
    assert s.records()[0]["rank"] == 1                    # fell back to previous value


def test_revert_the_add_removes_the_record(tmp_path):
    s = _store(tmp_path)
    add = s.record_seen({"name": "Serration", "rank": 1})
    s.set_reverted(add.id)
    assert s.present_count == 0
    assert s.records() == []


def test_unrevert_restores(tmp_path):
    s = _store(tmp_path)
    add = s.record_seen({"name": "Serration"})
    s.set_reverted(add.id)
    assert s.present_count == 0
    s.set_reverted(add.id, reverted=False)
    assert s.present_count == 1


def test_history_marks_reverted_newest_first(tmp_path):
    s = _store(tmp_path)
    s.record_seen({"name": "A"})
    b = s.record_seen({"name": "B"})
    s.set_reverted(b.id)
    h = s.history()
    assert h[0]["key"] == "b" and h[0]["reverted"] is True
    assert h[1]["key"] == "a" and h[1]["reverted"] is False


def test_reverted_persists_across_reload(tmp_path):
    s = _store(tmp_path)
    up = (s.record_seen({"name": "Serration", "rank": 1}),
          s.record_seen({"name": "Serration", "rank": 2}))[1]
    s.set_reverted(up.id)
    # a fresh store over the same files must replay to the same reverted state
    s2 = DatasetStore(tmp_path, "game", "mods")
    assert s2.records()[0]["rank"] == 1
    # and a new id continues past the reverted one
    nxt = s2.record_seen({"name": "Vitality"})
    assert nxt.id == 3


def test_batches_group_events_and_revert_wholesale(tmp_path):
    s = _store(tmp_path)
    s.begin_batch()
    s.record_seen({"name": "A", "v": 1})
    s.record_seen({"name": "B", "v": 1})
    s.begin_batch()                       # second run
    up = s.record_seen({"name": "A", "v": 2})
    s.record_seen({"name": "C", "v": 1})
    bs = s.batches()
    assert [b["batch"] for b in bs] == [2, 1]          # newest first
    assert bs[0]["count"] == 2 and bs[0]["adds"] == 1 and bs[0]["updates"] == 1
    # revert the whole second batch -> A back to 1, C gone
    s.revert_batch(up.batch)
    rows = {r["key"]: r for r in s.records()}
    assert rows["a"]["v"] == 1 and "c" not in rows
    assert s.batches()[0]["reverted"] is True
    s.revert_batch(up.batch, reverted=False)           # restore
    assert s.records()[0]["v"] in (1, 2)


def test_clear_data_removes_all_batches(tmp_path):
    s = _store(tmp_path)
    s.begin_batch(); s.record_seen({"name": "A"}); s.record_seen({"name": "B"})
    s.begin_batch(); s.record_seen({"name": "C"})
    s.clear_data()
    assert s.records() == []                       # no current records
    assert s.batches() == []                       # every batch wiped from the ledger
    # truly gone from disk: a reload brings nothing back
    s2 = DatasetStore(tmp_path, "game", "mods")
    assert s2.batches() == [] and s2.records() == []


def test_remove_batch_deletes_from_ledger(tmp_path):
    s = _store(tmp_path)
    s.begin_batch(); s.record_seen({"name": "A"})
    s.begin_batch(); s.record_seen({"name": "B"})
    s.remove_batch(1)
    assert [b["batch"] for b in s.batches()] == [2]     # batch 1 gone from the ledger
    assert {r["key"] for r in s.records()} == {"b"}     # only batch 2's record remains
    # and it's truly gone from disk: a reload doesn't bring it back
    s2 = DatasetStore(tmp_path, "game", "mods")
    assert [b["batch"] for b in s2.batches()] == [2]


def test_batch_events_and_preview(tmp_path):
    s = _store(tmp_path)
    s.begin_batch(); s.record_seen({"name": "A", "v": 1}); s.record_seen({"name": "B", "v": 1})
    s.begin_batch(); s.record_seen({"name": "A", "v": 2}); s.record_seen({"name": "C", "v": 1})
    evs = s.batch_events(2)
    assert [e["key"] for e in evs] == ["a", "c"]
    assert all(e["reverted"] is False for e in evs)
    pv = {p["key"]: p for p in s.preview_batch(2)}     # what applying batch 2 changes
    assert pv["a"]["kind"] == "update" and pv["a"]["changed"]["v"] == [1, 2]
    assert pv["c"]["kind"] == "add" and pv["c"]["after"]["v"] == 1
    assert "b" not in pv                                # batch 2 doesn't touch B


def test_edit_event_rekeys_and_persists(tmp_path):
    s = _store(tmp_path)
    s.begin_batch(); add = s.record_seen({"name": "Srration", "v": 1})  # typo
    s.edit_event(add.id, {"name": "Serration", "v": 1})
    assert {r["key"] for r in s.records()} == {"serration"}
    s2 = DatasetStore(tmp_path, "game", "mods")                         # survives reload
    assert {r["key"] for r in s2.records()} == {"serration"}


def test_remove_event_drops_one_event(tmp_path):
    s = _store(tmp_path)
    s.begin_batch(); a = s.record_seen({"name": "A"}); b = s.record_seen({"name": "B"})
    s.remove_event(a.id)
    assert {r["key"] for r in s.records()} == {"b"}
    assert [e["id"] for e in s.batch_events(1)] == [b.id]


def test_case_sensitive_key_keeps_case_variants_apart(tmp_path):
    s = DatasetStore(tmp_path, "g", "d", key=KeySpec(case_sensitive=True))
    s.record_seen({"name": "Soma Prime", "n": 1})
    s.record_seen({"name": "soma prime", "n": 2})
    assert s.present_count == 2


def test_rekey_when_key_config_changes(tmp_path):
    # raw records stored as-is; re-opening with a different key re-keys the ledger.
    # The arcane scenario: data collected keyed on name alone, then `level` is
    # added to the key -> the merged record splits per level on replay.
    s = DatasetStore(tmp_path, "g", "d")
    s.record_seen({"name": "Arcane Aegis", "level": 5, "n": 1})
    s.record_seen({"name": "Arcane Aegis", "level": 3, "n": 2})   # same key -> merged
    assert s.present_count == 1
    s2 = DatasetStore(tmp_path, "g", "d", key=KeySpec(("name", "level")))
    assert {r["key"] for r in s2.records()} == {"arcane_aegis|5", "arcane_aegis|3"}
    # and re-key by a different field entirely
    s3 = DatasetStore(tmp_path, "g", "d", key=KeySpec(("n",)))
    assert {r["key"] for r in s3.records()} == {"1", "2"}


def test_replay_pure_function():
    evs = [
        ChangeEvent("t1", ChangeOp.add, "x", {"name": "x", "v": 1}, id=1),
        ChangeEvent("t2", ChangeOp.update, "x", {"name": "x", "v": 2}, {"v": [1, 2]}, id=2),
        ChangeEvent("t3", ChangeOp.remove, "x", {"name": "x", "v": 2}, id=3),
    ]
    assert replay(evs, set())["x"]["present"] is False
    assert replay(evs, {3})["x"]["present"] is True          # un-remove
    assert replay(evs, {2, 3})["x"]["values"]["v"] == 1       # back to first value
    assert replay(evs, {1, 2, 3}) == {}                        # nothing left
