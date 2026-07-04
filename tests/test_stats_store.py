"""Per-node timing store: aggregate maths, bounded history, CSV format, rename/remove."""

from __future__ import annotations

import csv
import time

import pytest

from oc.store import stats_store as ss


@pytest.fixture(autouse=True)
def _isolate(tmp_path):
    ss._reset_for_tests()
    ss.configure(tmp_path)
    yield
    ss._reset_for_tests()


def _csv(tmp_path, node):
    return tmp_path / "g" / "stats" / f"{ss._safe(node)}.csv"


def test_aggregate_running_stats():
    for v in (10, 30, 20):
        ss.record_timing("g", "ds:prices", "rp", v, n=5)
    rows = {(r["node"], r["op"]): r for r in ss.aggregate("g")}
    r = rows[("ds:prices", "rp")]
    assert r["count"] == 3
    assert r["min_ms"] == 10.0
    assert r["max_ms"] == 30.0
    assert r["avg_ms"] == 20.0
    assert r["last_ms"] == 20.0
    assert r["label"] == "replay"


def test_unknown_op_dropped():
    ss.record_timing("g", "ds:x", "ZZ", 10)        # not in OPS
    assert ss.aggregate("g") == []


def test_ts_is_unix_epoch():
    before = int(time.time())
    ss.record_timing("g", "win:eq", "tk", 5)
    r = ss.aggregate("g")[0]
    assert r["last_ts"] >= before
    assert r["last_ts"] < before + 10        # seconds, not millis


def test_history_ring_capped_and_ordered():
    for i in range(ss.MAX_SAMPLES + 120):
        ss.record_timing("g", "win:eq", "oc", float(i))
    hist = ss.history("g", "win:eq", "oc")
    assert len(hist) == ss.MAX_SAMPLES        # bounded
    tss = [row[0] for row in hist]
    assert tss == sorted(tss)                 # time-ordered


def test_csv_has_version_header_and_columns(tmp_path):
    ss.record_timing("g", "ds:prices", "rp", 12.4, n=240)
    ss.flush_all()
    path = _csv(tmp_path, "ds:prices")
    lines = path.read_text(encoding="utf-8").splitlines()
    assert lines[0] == f"#stats v{ss.STATS_CSV_VERSION} ds:prices"
    assert lines[1] == "ts,op,ms,n"
    last = list(csv.reader([lines[-1]]))[0]
    assert last[1] == "rp" and last[3] == "240"


def test_reload_rebuilds_aggregate_from_disk(tmp_path):
    for v in (10, 20, 30):
        ss.record_timing("g", "ds:prices", "rp", v)
    ss.flush_all()
    ss._reset_for_tests()                     # wipe memory; keep files
    ss.configure(tmp_path)
    r = {(x["node"], x["op"]): x for x in ss.aggregate("g")}[("ds:prices", "rp")]
    assert r["count"] == 3 and r["avg_ms"] == 20.0


def test_rename_moves_file_and_carries_history(tmp_path):
    for v in (10, 20):
        ss.record_timing("g", "ds:prices", "rp", v)
    ss.flush_all()
    ss.rename_node("g", "ds:prices", "ds:market")
    assert not _csv(tmp_path, "ds:prices").exists()
    new = _csv(tmp_path, "ds:market")
    assert new.exists()
    assert new.read_text(encoding="utf-8").splitlines()[0].endswith("ds:market")
    assert len(ss.history("g", "ds:market", "rp")) == 2
    assert ss.history("g", "ds:prices", "rp") == []


def test_remove_deletes_file_and_drops_cache(tmp_path):
    ss.record_timing("g", "ds:prices", "rp", 10)
    ss.flush_all()
    assert _csv(tmp_path, "ds:prices").exists()
    ss.remove_node("g", "ds:prices")
    assert not _csv(tmp_path, "ds:prices").exists()
    assert ss.aggregate("g") == []


def test_malformed_rows_skipped_on_read(tmp_path):
    d = tmp_path / "g" / "stats"
    d.mkdir(parents=True)
    (d / "ds_x.csv").write_text(
        f"#stats v{ss.STATS_CSV_VERSION} ds:x\n"
        "ts,op,ms,n\n"
        "1750000000,rp,12.0,5\n"
        "garbage,row,here\n"            # wrong column count -> skipped
        "1750000001,rp,notnum,5\n"      # non-numeric ms -> skipped
        "1750000002,rp,9.0,3\n",
        encoding="utf-8",
    )
    hist = ss.history("g", "ds:x", "rp")
    assert len(hist) == 2               # only the two valid rows


def test_no_persist_without_configure(tmp_path):
    ss._reset_for_tests()
    ss.configure(None)                  # in-memory only
    ss.record_timing("g", "ds:prices", "rp", 10)
    ss.flush_all()
    assert ss.aggregate("g")[0]["count"] == 1     # still tracked in memory
    assert not (tmp_path / "g").exists()           # but nothing written


def test_gate_ops_gone_from_ops():
    # the worthiness gate was removed; its op codes must not linger (else stale cards render)
    assert not ({"ga", "go", "gn"} & set(ss.OPS))
    assert "rp" in ss.OPS               # replay is still a live op — kept


def test_prune_stale_removes_orphans_keeps_live(tmp_path):
    for node in ("ds:live", "win:eq", "producer:p", "ds:gone", "win:renamed_away", "price:legacy"):
        ss.record_timing("g", node, "rp" if node.startswith(("ds:", "price:")) else "tk", 5)
    ss.flush_all()
    live = {"ds:live", "win:eq", "producer:p", "precap"}
    purged = sorted(ss.prune_stale("g", live))
    assert purged == ["ds:gone", "price:legacy", "win:renamed_away"]
    assert not _csv(tmp_path, "ds:gone").exists()
    assert _csv(tmp_path, "ds:live").exists()            # live nodes untouched
    remaining = {r["node"] for r in ss.aggregate("g")}
    assert remaining == {"ds:live", "win:eq", "producer:p"}


def test_prune_stale_empty_live_set_is_noop(tmp_path):
    # a failed profile load yields no live nodes — must NOT wipe every file
    ss.record_timing("g", "ds:prices", "rp", 5)
    ss.flush_all()
    assert ss.prune_stale("g", set()) == []
    assert _csv(tmp_path, "ds:prices").exists()


def test_prune_stale_leaves_unrecognized_shape(tmp_path):
    # an unknown node shape (not a stat kind) is left alone even if absent from the live set
    ss.record_timing("g", "weird_node", "tk", 5)
    ss.flush_all()
    assert ss.prune_stale("g", {"ds:live"}) == []
    assert _csv(tmp_path, "weird_node").exists()
