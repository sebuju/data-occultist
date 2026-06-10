from oc.store import ChangeOp
from oc.store.dataset_store import DatasetStore


def _store(tmp_path, clock=None):
    seq = {"n": 0}
    def tick():
        seq["n"] += 1
        return f"t{seq['n']}"
    return DatasetStore(tmp_path, "game", "mods", "name", clock=clock or tick)


def test_add_then_no_change(tmp_path):
    s = _store(tmp_path)
    ev = s.record_seen({"name": "Serration", "rank": 5})
    assert ev and ev.op is ChangeOp.add
    assert s.record_seen({"name": "Serration", "rank": 5}) is None  # identical -> no event
    assert s.present_count == 1


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


def test_history_persists(tmp_path):
    s = _store(tmp_path)
    s.record_seen({"name": "Serration", "rank": 1})
    s.save()
    hist = (tmp_path / "game" / "mods.history.jsonl").read_text(encoding="utf-8")
    assert '"op": "add"' in hist
    state = (tmp_path / "game" / "mods.state.json").read_text(encoding="utf-8")
    assert "serration" in state
