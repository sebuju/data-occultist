"""Live captures are stored one folder per live-capture start (a "session")."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from oc.collect.replay import build_image_list
from oc.web import captures_store as cs
from oc.web import live_sessions


def _clock(t: datetime):
    return lambda: t


def _write(tmp_path, game, session, *offsets, base=None):
    """Save one frame per offset (seconds from ``base``) into ``session``; return the names."""
    base = base or datetime(2026, 7, 21, 12, 0, 0, tzinfo=timezone.utc)
    return [cs.save_live(tmp_path, game, b"jpeg-bytes", session=session,
                         clock=_clock(base + timedelta(seconds=off)))
            for off in offsets]


def test_save_live_creates_the_session_folder_only_on_write(tmp_path):
    sid = cs.new_session_id()
    live_dir = tmp_path / "wf" / cs.LIVE / sid
    assert not live_dir.exists()          # merely having an id makes no folder
    assert cs.list_live_sessions(tmp_path, "wf") == []
    _write(tmp_path, "wf", sid, 0)
    assert live_dir.is_dir()


def test_list_live_sessions_reports_count_bytes_and_span(tmp_path):
    old, new = "20260720-100000-000000", "20260721-100000-000000"
    _write(tmp_path, "wf", old, 0, 5)
    _write(tmp_path, "wf", new, 0, 30, 90)
    sessions = cs.list_live_sessions(tmp_path, "wf")
    assert [s["id"] for s in sessions] == [new, old]          # newest first
    assert sessions[0]["count"] == 3
    assert sessions[0]["span"] == 90.0                        # first -> last image
    assert sessions[0]["bytes"] == 3 * len(b"jpeg-bytes")
    assert sessions[1]["span"] == 5.0
    assert cs.newest_live_session(tmp_path, "wf") == new


def test_empty_session_folder_is_not_a_recording(tmp_path):
    (tmp_path / "wf" / cs.LIVE / "20260721-100000-000000").mkdir(parents=True)
    assert cs.list_live_sessions(tmp_path, "wf") == []


def test_migrate_flat_live_folds_legacy_images_into_one_session(tmp_path):
    flat = tmp_path / "wf" / cs.LIVE
    flat.mkdir(parents=True)
    for name in ("20260101-090000-000000.jpg", "20260101-090005-000000.jpg"):
        (flat / name).write_bytes(b"old")
    sid = cs.migrate_flat_live(tmp_path, "wf")
    assert sid == "20260101-090000-000000"                    # named after the oldest frame
    assert not list(flat.glob("*.jpg"))                       # nothing left loose
    sessions = cs.list_live_sessions(tmp_path, "wf")
    assert len(sessions) == 1
    assert sessions[0]["count"] == 2 and sessions[0]["label"] == "recovered"
    assert cs.migrate_flat_live(tmp_path, "wf") is None       # idempotent


def test_live_stats_sums_sessions_and_scopes_to_one(tmp_path):
    a, b = "20260720-100000-000000", "20260721-100000-000000"
    _write(tmp_path, "wf", a, 0)
    _write(tmp_path, "wf", b, 0, 1)
    assert cs.live_stats(tmp_path, "wf") == {"count": 3, "bytes": 3 * 10, "sessions": 2}
    assert cs.live_stats(tmp_path, "wf", b)["count"] == 2


def test_live_clear_scopes_to_one_session(tmp_path):
    a, b = "20260720-100000-000000", "20260721-100000-000000"
    _write(tmp_path, "wf", a, 0)
    _write(tmp_path, "wf", b, 0)
    assert cs.live_clear(tmp_path, "wf", a) == 1
    assert [s["id"] for s in cs.list_live_sessions(tmp_path, "wf")] == [b]
    assert cs.live_clear(tmp_path, "wf") == 1                 # the rest
    assert cs.list_live_sessions(tmp_path, "wf") == []


def test_promote_live_copies_out_of_its_session(tmp_path):
    sid = "20260721-100000-000000"
    (name,) = _write(tmp_path, "wf", sid, 0)
    assert cs.promote_live(tmp_path, "wf", sid, name) == name
    assert cs.listing(tmp_path, "wf") == [name]               # now a normal stashed capture
    cs.live_clear(tmp_path, "wf")
    assert cs.listing(tmp_path, "wf") == [name]               # ...and survives a flush


def test_live_path_for_rejects_traversal(tmp_path):
    sid = "20260721-100000-000000"
    _write(tmp_path, "wf", sid, 0)
    assert cs.live_path_for(tmp_path, "wf", sid, "../x.jpg") is None
    assert cs.live_path_for(tmp_path, "wf", "..", "x.jpg") is None


def test_build_image_list_replays_one_session_newest_by_default(tmp_path):
    old, new = "20260720-100000-000000", "20260721-100000-000000"
    _write(tmp_path, "wf", old, 0, 5)
    _write(tmp_path, "wf", new, 0, 1, 2)
    newest = build_image_list(tmp_path, "wf")
    assert len(newest) == 3
    assert all(p.parent.name == new for _, p in newest)
    assert [t for t, _ in newest] == sorted(t for t, _ in newest)   # oldest first
    assert len(build_image_list(tmp_path, "wf", old)) == 2
    assert build_image_list(tmp_path, "wf", "20990101-000000-000000") == []


def test_registry_holds_one_session_per_game_until_ended():
    sid = live_sessions.begin("wf")
    assert live_sessions.current("wf") == sid
    assert live_sessions.current_or_begin("wf") == sid        # same run keeps recording into it
    live_sessions.end("wf")
    assert live_sessions.current("wf") is None
    assert live_sessions.current_or_begin("wf") != sid        # next save opens a new one
    live_sessions.end("wf")


def test_registry_rolls_a_stale_session(monkeypatch):
    sid = live_sessions.begin("wf")
    # a client that died without calling end(): the idle backstop must not glue new frames on
    real = live_sessions.time.monotonic
    monkeypatch.setattr(live_sessions.time, "monotonic",
                        lambda: real() + live_sessions._IDLE + 1)
    assert live_sessions.current_or_begin("wf") != sid
    live_sessions.end("wf")
