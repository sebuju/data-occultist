"""Database snapshot/restore + the shared backup primitive."""

from datetime import datetime, timedelta, timezone

import pytest

from oc import backup
from oc.store import inspect
from oc.store.dataset_store import DatasetStore, drop_database
from oc.store.db_backup import (
    DB_BACKUP_RECENT,
    backup_dir,
    db_backup_meta,
    list_db_backups,
    restore_db_backup,
    snapshot_db,
)


# ---- shared primitive (oc.backup) ------------------------------------------

def test_keep_last_n_keeps_newest():
    stamps = [f"2026010{i}-000000-000000" for i in range(1, 8)]   # 7, ascending
    assert backup.keep_last_n(stamps, 3) == set(stamps[-3:])
    assert backup.keep_last_n(stamps, 0) == set()
    assert backup.keep_last_n(stamps, 99) == set(stamps)          # fewer than N -> all


def test_gfs_keep_policy():
    now = datetime(2026, 6, 18, 12, 0, tzinfo=timezone.utc)

    def st(**kw):
        return (now - timedelta(**kw)).strftime(backup.STAMP_FMT)

    recent = [st(hours=0), st(hours=1), st(hours=2)]   # 3 freshest -> all kept
    same_week = st(hours=5)                            # 4th this ISO week -> weekly bucket
    wk_prior = [st(days=10), st(days=10, hours=4)]     # one prior week -> keep newest only
    wk_older = st(days=20)                             # another week (still <8wk)
    month = [st(days=70), st(days=72)]                 # >8wk, same month -> keep newest only
    month_b = st(days=110)                             # older, different month

    stamps = recent + [same_week] + wk_prior + [wk_older] + month + [month_b]
    keep = backup.gfs_keep(stamps, now, recent=3, weekly_weeks=8)

    assert set(recent) <= keep                         # freshest always kept
    assert same_week in keep                           # current week's weekly rep
    assert max(wk_prior) in keep and min(wk_prior) not in keep   # 1/week
    assert wk_older in keep
    assert max(month) in keep and min(month) not in keep         # 1/month for the old ones
    assert month_b in keep


def test_new_stamp_path_avoids_collision(tmp_path):
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    s1, p1 = backup.new_stamp_path(tmp_path, "gz", now)
    p1.write_text("x")
    s2, p2 = backup.new_stamp_path(tmp_path, "gz", now)          # same instant -> bumped
    assert s1 != s2 and not p2.exists()


# ---- DB snapshot / restore -------------------------------------------------

def test_snapshot_missing_store_is_none(tmp_path):
    assert snapshot_db(tmp_path, "nope") is None


def test_snapshot_then_restore_brings_data_back(tmp_path):
    DatasetStore(tmp_path, "g", "mods").record_seen({"name": "Serration"})
    snap = snapshot_db(tmp_path, "g")
    assert snap is not None and snap.exists()

    drop_database(tmp_path, "g")
    assert inspect.list_datasets(tmp_path, "g") == []

    restore_db_backup(tmp_path, "g", snap.stem)
    assert "mods" in inspect.list_datasets(tmp_path, "g")
    assert DatasetStore(tmp_path, "g", "mods").present_count == 1


def test_db_backup_meta_counts(tmp_path):
    s = DatasetStore(tmp_path, "g", "mods")
    s.record_seen({"name": "A"})
    s.record_seen({"name": "B"})
    m = db_backup_meta(snapshot_db(tmp_path, "g"))
    assert m["datasets"] == 1
    assert m["events"] == 2
    assert m["last_seen"]


def test_reason_persists_in_meta(tmp_path):
    DatasetStore(tmp_path, "g", "mods").record_seen({"name": "A"})
    snapshot_db(tmp_path, "g", reason="pre-drop")
    assert list_db_backups(tmp_path, "g")[0]["reason"] == "pre-drop"


def test_snapshot_is_compressed_with_sidecar(tmp_path):
    s = DatasetStore(tmp_path, "g", "mods")
    for i in range(200):
        s.record_seen({"name": f"item {i}", "rank": i})
    snap = snapshot_db(tmp_path, "g")
    assert snap.suffix == ".gz"
    assert snap.with_suffix(".json").exists()                  # meta sidecar written
    live = (tmp_path / "g" / "store.sqlite").stat().st_size
    assert snap.stat().st_size < live                          # gzip actually shrank it


def test_gfs_prunes_db_backups(tmp_path):
    # A burst of same-instant snapshots collapses to the 3 freshest + one weekly rep.
    DatasetStore(tmp_path, "g", "mods").record_seen({"name": "A"})
    for _ in range(8):
        assert snapshot_db(tmp_path, "g") is not None
    files = list(backup_dir(tmp_path, "g").glob("*.gz"))
    assert len(files) <= DB_BACKUP_RECENT + 1
    # every surviving snapshot keeps its meta sidecar; no orphans left behind
    sidecars = {p.stem for p in backup_dir(tmp_path, "g").glob("*.json")}
    assert sidecars == {p.stem for p in files}


def test_restore_snapshots_current_first(tmp_path):
    DatasetStore(tmp_path, "g", "mods").record_seen({"name": "A"})
    snap = snapshot_db(tmp_path, "g")
    before = len(list_db_backups(tmp_path, "g"))
    restore_db_backup(tmp_path, "g", snap.stem)
    assert len(list_db_backups(tmp_path, "g")) == before + 1   # current was captured first


def test_restore_handles_uncompressed_snapshot(tmp_path):
    # The loader sniffs gzip magic, so a raw (non-gz) sqlite dropped in as <stamp>.gz still
    # restores — robust to a hand-placed/legacy snapshot.
    import shutil

    DatasetStore(tmp_path, "g", "mods").record_seen({"name": "Serration"})
    gz = snapshot_db(tmp_path, "g")
    raw_stamp = "20200101-000000-000000"
    raw = gz.with_name(f"{raw_stamp}.gz")
    shutil.copyfile(tmp_path / "g" / "store.sqlite", raw)   # plain sqlite, .gz name, NOT gzipped
    drop_database(tmp_path, "g")
    restore_db_backup(tmp_path, "g", raw_stamp)
    assert DatasetStore(tmp_path, "g", "mods").present_count == 1


def test_restore_unknown_stamp_raises(tmp_path):
    DatasetStore(tmp_path, "g", "mods").record_seen({"name": "A"})
    with pytest.raises(FileNotFoundError):
        restore_db_backup(tmp_path, "g", "nope")
