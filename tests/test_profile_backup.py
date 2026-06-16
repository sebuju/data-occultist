"""Profile save hardening: atomic writes, keep-all versioned backups (layout-only
saves excepted), external dictionary files, and the per-device graph-local sidecar.
All pure-logic — no game, GPU, or Windows needed."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import yaml

from oc.profile import (
    backup_meta,
    list_backups,
    load_graph_local,
    load_profile,
    restore_backup,
    save_graph_local,
    save_profile,
)
from oc.profile.loader import (
    _STAMP_FMT,
    dictionaries_dir,
    profile_path,
    retention_keep,
)
from oc.profile.models import GameProfile, NodeLayout


def _profiles_dir(tmp_path):
    # profiles live in <tmp>/games; dictionaries resolve to the sibling <tmp>/dictionaries
    return tmp_path / "games"


def _prof(**kw):
    return GameProfile(name="g", **kw)


# ---- atomic write + backups ------------------------------------------------------

def test_first_save_creates_file_without_backup(tmp_path):
    d = _profiles_dir(tmp_path)
    save_profile(d, _prof(process_names=["a.exe"]))
    assert profile_path(d, "g").exists()
    assert list_backups(d, "g") == []   # nothing prior to snapshot


def test_content_edit_snapshots_prior_version(tmp_path):
    d = _profiles_dir(tmp_path)
    save_profile(d, _prof(process_names=["v1.exe"]))
    v1_text = profile_path(d, "g").read_text(encoding="utf-8")

    save_profile(d, _prof(process_names=["v2.exe"]))    # content change
    backups = list_backups(d, "g")
    assert len(backups) == 1
    assert backups[0].read_text(encoding="utf-8") == v1_text   # snapshot == prior contents
    assert "v2.exe" in profile_path(d, "g").read_text(encoding="utf-8")


def test_identical_save_is_noop(tmp_path):
    d = _profiles_dir(tmp_path)
    save_profile(d, _prof(process_names=["x.exe"]))
    save_profile(d, _prof(process_names=["x.exe"]))   # byte-identical
    assert list_backups(d, "g") == []


def test_layout_only_save_skips_snapshot(tmp_path):
    d = _profiles_dir(tmp_path)
    p = _prof(process_names=["x.exe"])
    save_profile(d, p)

    p.layout.nodes["win:equip"] = NodeLayout(x=10, y=20)   # only node layout moved
    save_profile(d, p)
    assert list_backups(d, "g") == []                  # drags don't spam backups
    saved = load_profile(d, "g")
    assert "win:equip" in saved.layout.nodes           # but layout did persist

    p.process_names = ["y.exe"]                         # now a real content change
    save_profile(d, p)
    assert len(list_backups(d, "g")) == 1               # snapshots this time


# ---- non-structural churn skips the snapshot (geometry + UI view-state) -----------

def _win(box_x):
    return {"id": "equip", "items": [{"id": "normal",
            "box": {"x": box_x, "y": 0, "w": 1, "h": 1}}]}


def test_geometry_only_change_skips_snapshot(tmp_path):
    d = _profiles_dir(tmp_path)
    save_profile(d, _prof(windows=[_win(0.0)]))
    save_profile(d, _prof(windows=[_win(0.5)]))     # only a box's x/y/w/h moved
    assert list_backups(d, "g") == []               # drag/resize doesn't spam backups
    saved = load_profile(d, "g")
    assert saved.windows[0].items[0].box.x == 0.5   # but the new coord did persist


def test_ui_view_state_change_skips_snapshot(tmp_path):
    d = _profiles_dir(tmp_path)
    sub = lambda c, h: {"id": "v", "config_collapsed": c, "hidden_columns": h}
    save_profile(d, _prof(subsets=[sub(False, [])]))
    save_profile(d, _prof(subsets=[sub(True, ["plat"])]))   # only UI view-state
    assert list_backups(d, "g") == []


def test_structural_change_snapshots_full_prior_including_coords(tmp_path):
    d = _profiles_dir(tmp_path)
    save_profile(d, _prof(windows=[_win(0.3)]))
    # structural change (new process_names) AND a geometry move in the same save
    save_profile(d, _prof(windows=[_win(0.9)], process_names=["x.exe"]))
    backups = list_backups(d, "g")
    assert len(backups) == 1                                 # one snapshot
    assert "0.3" in backups[0].read_text(encoding="utf-8")   # full prior file, prior coords


# ---- tiered retention ------------------------------------------------------------

def test_retention_keep_policy():
    now = datetime(2026, 6, 16, 12, 0, 0, tzinfo=timezone.utc)
    stamp = lambda dt: dt.strftime(_STAMP_FMT)

    recent = [now - timedelta(hours=3 * i) for i in range(1, 11)]   # 3h..30h, all <48h
    day_old = [now - timedelta(days=dd, hours=hh)                   # 3 per day, days 3..7
               for dd in range(3, 8) for hh in (1, 5, 9)]
    weekly = [now - timedelta(days=dd) for dd in (40, 41, 47, 48, 60, 61)]  # 3 ISO weeks

    keep = retention_keep([stamp(dt) for dt in recent + day_old + weekly], now)

    assert all(stamp(dt) in keep for dt in recent)             # every <48h snapshot kept
    assert len({stamp(dt) for dt in day_old if stamp(dt) in keep}) == 5   # one per day
    assert len({stamp(dt) for dt in weekly if stamp(dt) in keep}) == 3    # one per week


def test_snapshot_prunes_over_dense_dir(tmp_path):
    d = _profiles_dir(tmp_path)
    bdir = d / ".backups" / "g"
    bdir.mkdir(parents=True)
    now = datetime(2026, 6, 16, 12, 0, 0, tzinfo=timezone.utc)
    # 20 old snapshots all on the SAME ancient day -> retention keeps exactly one
    for i in range(20):
        s = (now - timedelta(days=200, minutes=i)).strftime(_STAMP_FMT)
        (bdir / f"{s}.yaml").write_text("name: g\n", encoding="utf-8")

    save_profile(d, _prof(process_names=["a.exe"]))
    save_profile(d, _prof(process_names=["b.exe"]))   # content change -> snapshot + prune
    # the 20 same-day ancients collapse to 1 (one per ISO week), plus the fresh snapshot
    assert len(list_backups(d, "g")) == 2


def test_no_tmp_file_left_behind(tmp_path):
    d = _profiles_dir(tmp_path)
    save_profile(d, _prof(process_names=["x.exe"]))
    assert not list(d.glob("*.tmp"))


# ---- dictionaries externalised ---------------------------------------------------

def test_dictionary_terms_externalised(tmp_path):
    d = _profiles_dir(tmp_path)
    save_profile(d, _prof(dictionaries=[{"id": "wiki", "name": "wiki",
                                         "terms": ["Soma Prime", "Neo V11"]}]))

    text = profile_path(d, "g").read_text(encoding="utf-8")
    assert "Soma Prime" not in text          # terms no longer inline
    assert "source: wiki.txt" in text

    term_file = dictionaries_dir(d) / "wiki.txt"
    assert term_file.read_text(encoding="utf-8").splitlines() == ["Soma Prime", "Neo V11"]

    reloaded = load_profile(d, "g")
    assert reloaded.dictionaries[0].terms == ["Soma Prime", "Neo V11"]


def test_dictionary_survives_missing_file(tmp_path):
    d = _profiles_dir(tmp_path)
    save_profile(d, _prof(dictionaries=[{"id": "wiki", "name": "wiki", "terms": ["A", "B"]}]))
    (dictionaries_dir(d) / "wiki.txt").unlink()        # term file vanishes

    reloaded = load_profile(d, "g")
    assert [x.id for x in reloaded.dictionaries] == ["wiki"]   # node intact
    assert reloaded.dictionaries[0].terms == []               # resolves to zero terms


def test_unchanged_terms_do_not_rewrite_file(tmp_path):
    d = _profiles_dir(tmp_path)
    save_profile(d, _prof(dictionaries=[{"id": "wiki", "name": "wiki", "terms": ["A"]}]))
    term_file = dictionaries_dir(d) / "wiki.txt"
    mtime = term_file.stat().st_mtime_ns

    save_profile(d, _prof(process_names=["new.exe"],
                          dictionaries=[{"id": "wiki", "name": "wiki", "terms": ["A"]}]))
    assert term_file.stat().st_mtime_ns == mtime       # same terms -> file untouched


# ---- graph-local sidecar ---------------------------------------------------------

def test_graph_local_roundtrip_and_missing(tmp_path):
    d = _profiles_dir(tmp_path)
    assert load_graph_local(d, "g") == {}              # missing -> {}
    save_graph_local(d, "g", {"view": {"zoom": 2}, "minimap": {"visible": True}})
    assert load_graph_local(d, "g")["view"]["zoom"] == 2


# ---- restore ---------------------------------------------------------------------

def test_restore_reverts_and_keeps_backup_intact(tmp_path):
    d = _profiles_dir(tmp_path)
    save_profile(d, _prof(process_names=["v1.exe"]))
    save_profile(d, _prof(process_names=["v2.exe"]))   # snapshots v1
    stamp = list_backups(d, "g")[0].stem
    backup_before = list_backups(d, "g")[0].read_text(encoding="utf-8")

    restored = restore_backup(d, "g", stamp)
    assert restored.process_names == ["v1.exe"]                       # live reverted
    assert load_profile(d, "g").process_names == ["v1.exe"]
    # the chosen backup file is untouched, and restoring snapshotted the v2 state
    assert (d / ".backups" / "g" / f"{stamp}.yaml").read_text(encoding="utf-8") == backup_before
    assert len(list_backups(d, "g")) == 2


def test_backup_meta_counts(tmp_path):
    d = _profiles_dir(tmp_path)
    win = {"id": "equip", "items": [{"id": "normal", "box": {"x": 0, "y": 0, "w": 1, "h": 1}},
                                    {"id": "arcane", "box": {"x": 0, "y": 0, "w": 1, "h": 1}}]}
    p = _prof(windows=[win], datasets=[{"id": "master"}],
              layout={"nodes": {"a": {"x": 1, "y": 1}, "b": {"x": 2, "y": 2}, "c": {"x": 3, "y": 3}}})
    save_profile(d, p)
    save_profile(d, _prof(windows=[win], datasets=[{"id": "master"}], process_names=["x.exe"]))  # snapshot p

    meta = backup_meta(list_backups(d, "g")[0])
    assert meta["counts"]["nodes"] == 3
    assert meta["counts"]["windows"] == 1
    assert meta["counts"]["items"] == 2
    assert meta["counts"]["datasets"] == 1
    assert meta["stamp"] and meta["size"] > 0


def test_profile_roundtrips_with_and_without_layout(tmp_path):
    d = _profiles_dir(tmp_path)
    # legacy-style: no layout block at all still validates + saves
    raw = {"name": "g", "process_names": ["x.exe"]}
    profile_path(d, "g").parent.mkdir(parents=True, exist_ok=True)
    profile_path(d, "g").write_text(yaml.safe_dump(raw), encoding="utf-8")
    p = load_profile(d, "g")
    assert p.layout.nodes == {}
    save_profile(d, p)   # must not raise
