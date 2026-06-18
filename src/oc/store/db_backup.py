"""Snapshot + restore for a game's whole SQLite store (``data/<game>/store.sqlite``).

The store is one file per game, written continuously by the collector / sweeps / manual
edits. It has no per-record undo at the file level, and the database panel can ``drop`` it
outright, so we keep versioned copies under ``data/<game>/.backups/<stamp>.sqlite``.

Snapshots use SQLite's **online backup API** (``source.backup(target)``), which copies a
*consistent* image including WAL with no checkpoint juggling and no file-lock fight with a
live writer. Restore runs the same API in reverse (backup -> live) so the live file handle
is written THROUGH rather than replaced — no open-file lock on Windows. Stamp/list/prune
ride the shared :mod:`oc.backup` primitive (the profile backups use the same one); the only
DB-specific bits here are the sqlite copy and the row-count metadata.

Retention is keep-last-N (DB files are far bigger than a profile YAML, so a flat count cap
beats time-thinning). The daily-on-change trigger lives in :class:`AutoBackup`.
"""

from __future__ import annotations

import gzip
import json
import os
import shutil
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .. import backup, eventlog
from . import changes
from .dataset_store import _connect, _db_path

# Retention is grandfather-father-son (snapshots are a whole ~tens-of-MB SQLite file, so we
# thin aggressively): keep the few freshest, then weekly for recent weeks, then monthly.
DB_BACKUP_RECENT = 3                          # newest snapshots kept unconditionally
DB_BACKUP_WEEKLY_WEEKS = 8                    # keep 1/ISO-week for this many weeks, then 1/month
DB_BACKUP_MIN_AGE = timedelta(hours=24)       # daily-on-change: skip if a backup is newer

# A snapshot is a GZIPPED sqlite copy named ``<stamp>.gz`` (the store is mostly JSON text in
# values_json, which gzips ~5-10x). A tiny ``<stamp>.json`` sidecar carries the row counts so
# the listing never has to decompress a snapshot just to show "N ds / M events".
_EXT = "gz"
_META_EXT = "json"
_GZIP_LEVEL = 6                               # default gzip; near-max ratio, far cheaper than 9


def backup_dir(data_dir: Path | str, game: str) -> Path:
    return Path(data_dir) / game / ".backups"


def _human(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / 1024 / 1024:.1f} MB"
    if n >= 1024:
        return f"{n / 1024:.0f} kB"
    return f"{n} B"


def _meta_path(snapshot: Path) -> Path:
    return snapshot.with_suffix(f".{_META_EXT}")   # <stamp>.gz -> <stamp>.json (stem is the stamp)


def _extract_sqlite(snapshot: Path, dst: Path) -> None:
    """Materialise a snapshot to a plain sqlite file at ``dst``, handling EITHER a gzipped
    snapshot (the norm) or a raw sqlite one. We sniff the gzip magic (0x1f 0x8b) rather than
    trust the name, so a hand-placed/legacy uncompressed snapshot still loads."""
    with open(snapshot, "rb") as f:
        gz = f.read(2) == b"\x1f\x8b"
    opener = gzip.open if gz else open
    with opener(snapshot, "rb") as fi, open(dst, "wb") as fo:
        shutil.copyfileobj(fi, fo)


def _counts(conn: sqlite3.Connection) -> dict:
    """Dataset/event counts + newest event ts from an open store connection (tolerant of an
    odd/legacy schema)."""
    datasets = events = 0
    last_seen = None
    try:
        datasets = conn.execute("SELECT COUNT(*) FROM datasets").fetchone()[0]
    except sqlite3.OperationalError:
        pass
    try:
        row = conn.execute("SELECT COUNT(*), MAX(ts) FROM events").fetchone()
        events, last_seen = row[0], row[1]
    except sqlite3.OperationalError:
        pass
    return {"datasets": datasets, "events": events, "last_seen": last_seen}


def _prune(d: Path, now: datetime) -> None:
    """Apply the GFS policy to the ``*.gz`` snapshots, then sweep any orphaned ``*.json``
    sidecars whose snapshot was pruned."""
    keep = backup.gfs_keep([p.stem for p in backup.list_snapshots(d, _EXT)], now,
                           recent=DB_BACKUP_RECENT, weekly_weeks=DB_BACKUP_WEEKLY_WEEKS)
    backup.prune(d, _EXT, keep)
    live = {p.stem for p in backup.list_snapshots(d, _EXT)}
    for sc in d.glob(f"*.{_META_EXT}"):
        if sc.stem not in live:
            sc.unlink(missing_ok=True)


def snapshot_db(data_dir: Path | str, game: str, reason: str = "manual") -> Path | None:
    """Snapshot the game's live store to a fresh gzipped ``<stamp>.gz`` (+ a ``<stamp>.json``
    meta sidecar), then thin per the GFS policy. Returns the snapshot path, or ``None`` when
    no store exists yet. ``reason`` tags WHY it was taken (``manual`` / ``auto`` /
    ``pre-drop`` / ``pre-clear:<dataset>`` ...) so backups are self-identifying in the list."""
    db = _db_path(data_dir, game)
    if not db.exists():
        return None
    d = backup_dir(data_dir, game)
    d.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    _, path = backup.new_stamp_path(d, _EXT, now)
    raw = path.with_name(f"{path.name}.{os.getpid()}.raw")   # uncompressed sqlite copy
    gz = path.with_name(f"{path.name}.{os.getpid()}.tmp")    # gzip target, atomically replaced in
    meta = {"stamp": path.stem, "reason": reason, "created": now.isoformat(),
            "datasets": 0, "events": 0, "last_seen": None}
    src = sqlite3.connect(str(db))
    try:
        dst = sqlite3.connect(str(raw))
        try:
            src.backup(dst)        # consistent online copy (incl. WAL), no checkpoint needed
            meta.update(_counts(dst))
        finally:
            dst.close()
    finally:
        src.close()
    try:
        with open(raw, "rb") as fi, gzip.open(gz, "wb", compresslevel=_GZIP_LEVEL) as fo:
            shutil.copyfileobj(fi, fo)
    finally:
        raw.unlink(missing_ok=True)
    os.replace(gz, path)           # snapshot only appears once fully written
    meta["size"] = path.stat().st_size   # compressed size (what the dir actually costs)
    _meta_path(path).write_text(json.dumps(meta), encoding="utf-8")
    _prune(d, now)
    eventlog.publish(
        f"db backup · {reason} · {meta['datasets']} ds / {meta['events']} events "
        f"· {_human(meta['size'])}", level="ok", game=game)
    return path


def db_backup_meta(path: Path) -> dict:
    """Browser metadata for one snapshot: stamp/iso/size + dataset & event counts and the
    newest event ts. Reads the cheap ``<stamp>.json`` sidecar; falls back to decompressing +
    counting only for a legacy snapshot that has no sidecar."""
    stamp = path.stem
    dt = backup.parse_stamp(stamp)
    base = {"stamp": stamp, "iso": dt.isoformat() if dt else stamp,
            "size": path.stat().st_size, "reason": "", "datasets": 0,
            "events": 0, "last_seen": None}
    sc = _meta_path(path)
    if sc.exists():
        try:
            base.update(json.loads(sc.read_text(encoding="utf-8")))
            base["size"] = path.stat().st_size   # trust the live file size, not the sidecar's
            base["stamp"] = stamp
            return base
        except (OSError, ValueError):
            pass
    # no sidecar: materialise to a temp sqlite and count once (gz or raw, sniffed)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.read")
    try:
        _extract_sqlite(path, tmp)
        conn = sqlite3.connect(str(tmp))
        try:
            base.update(_counts(conn))
        finally:
            conn.close()
    except (OSError, sqlite3.Error):
        pass
    finally:
        tmp.unlink(missing_ok=True)
    return base


def list_db_backups(data_dir: Path | str, game: str) -> list[dict]:
    """Snapshots for a game, NEWEST first (what the modal shows)."""
    return [db_backup_meta(p)
            for p in reversed(backup.list_snapshots(backup_dir(data_dir, game), _EXT))]


def restore_db_backup(data_dir: Path | str, game: str, stamp: str) -> bool:
    """Restore a snapshot over the live store. Snapshots the CURRENT state first (so a
    restore is itself undoable), decompresses the chosen snapshot, then copies it -> live via
    the backup API (writing through the open handle, no file replace) and announces every
    affected dataset so panels refetch. Raises ``FileNotFoundError`` for an unknown stamp.
    NOTE: a running collector holds a long-lived store with cached counters — stop collection
    before restoring, or its in-memory state can lag the restored file."""
    src_path = backup_dir(data_dir, game) / f"{stamp}.{_EXT}"
    if not src_path.exists():
        raise FileNotFoundError(f"no backup {stamp!r}")
    snapshot_db(data_dir, game, reason="pre-restore")   # capture current before overwriting
    tmp = src_path.with_name(f"{src_path.name}.{os.getpid()}.restore")   # plain sqlite
    _extract_sqlite(src_path, tmp)   # gz or raw, sniffed
    try:
        live = _connect(_db_path(data_dir, game))   # creates the file+schema if absent
        try:
            before = {r[0] for r in live.execute("SELECT dataset FROM datasets")}
            bk = sqlite3.connect(str(tmp))
            try:
                bk.backup(live)    # snapshot -> live, through the open handle (no file replace)
            finally:
                bk.close()
            after = {r[0] for r in live.execute("SELECT dataset FROM datasets")}
        finally:
            live.close()
    finally:
        tmp.unlink(missing_ok=True)
    for ds in (before | after):    # removed AND restored datasets both refresh
        changes.publish(game, ds)
    return True


class AutoBackup:
    """Dataset-change-bus subscriber implementing the daily-on-change backup: when a write
    lands and the newest snapshot is older than ``min_age`` (or none exists), take one. The
    snapshot runs on a daemon thread so it never blocks the writer, and ``_inflight`` keeps a
    burst of writes from queuing more than one snapshot per game at a time. The ``min_age``
    gate is the throttle — no extra timer needed."""

    def __init__(self, data_dir: Path | str, min_age: timedelta = DB_BACKUP_MIN_AGE) -> None:
        self._data_dir = data_dir
        self._min_age = min_age
        self._last: dict[str, datetime] = {}
        self._inflight: set[str] = set()
        self._lock = threading.Lock()

    def _seed(self, game: str) -> None:
        snaps = backup.list_snapshots(backup_dir(self._data_dir, game), _EXT)
        if snaps:
            dt = backup.parse_stamp(snaps[-1].stem)
            if dt is not None:
                self._last[game] = dt

    def __call__(self, game: str, dataset: str, records: list) -> None:
        if not records or not game:
            return                                  # only real writes count as "changed"
        now = datetime.now(timezone.utc)
        with self._lock:
            if game not in self._last:
                self._seed(game)
            last = self._last.get(game)
            if last is not None and (now - last) < self._min_age:
                return
            if game in self._inflight:
                return
            self._inflight.add(game)
        threading.Thread(target=self._run, args=(game,), daemon=True).start()

    def _run(self, game: str) -> None:
        try:
            if snapshot_db(self._data_dir, game, reason="auto") is not None:
                with self._lock:
                    self._last[game] = datetime.now(timezone.utc)
        except Exception:  # noqa: BLE001 - a backup failure must never break a write
            pass
        finally:
            with self._lock:
                self._inflight.discard(game)
