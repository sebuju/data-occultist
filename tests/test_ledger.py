"""The dataset ledger is revertable: state is the replay of non-reverted events."""

from oc.store.dataset_store import DatasetStore, replay
from oc.store.change import ChangeEvent, ChangeOp


def _store(tmp_path):
    seq = {"n": 0}
    def tick():
        seq["n"] += 1
        return f"t{seq['n']}"
    return DatasetStore(tmp_path, "game", "mods", "name", clock=tick)


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
    s2 = DatasetStore(tmp_path, "game", "mods", "name")
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


def test_strip_nonalnum_and_case_dedup(tmp_path):
    from oc.store.dataset_store import DatasetStore, norm_key
    assert norm_key("Soma Prime", strip_nonalnum=True) == "somaprime"
    assert norm_key("Soma Prime", case_sensitive=True) == "Soma Prime"
    s = DatasetStore(tmp_path, "g", "d", "name", strip_nonalnum=True)
    s.record_seen({"name": "Soma Prime", "n": 1})
    s.record_seen({"name": "somaprime", "n": 2})       # same key after stripping
    assert s.present_count == 1


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
