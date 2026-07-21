"""Database-structure endpoint for the DB-structure panel.

Reports the per-game SQLite store's shape: tables (with columns + indexes + row counts) and
a per-dataset breakdown (event count, present records, batches). Read-only — opens its own
short-lived connection so it never contends with a writer (WAL allows concurrent readers)."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, HTTPException

from ...store import changes
from ...store.dataset_store import _db_path, clear_table, drop_database, vacuum_database
from ...store.db_backup import snapshot_db
from ..deps import get_settings

router = APIRouter(prefix="/api/dbschema", tags=["dbschema"])


def _content_expr(conn: sqlite3.Connection, table: str) -> str:
    """SQL summing the stored length of every column in ``table``.

    This is CONTENT size, not on-disk size: SQLite only exposes per-table page usage through the
    ``dbstat`` virtual table, which this build is not compiled with, so pages, indexes and free
    space are invisible here. Measured against the real store the two diverge wildly (a 194 MB
    file holding 18 MB of content), which is exactly why the payload keeps them as separate,
    separately-labelled numbers instead of implying one explains the other."""
    cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({table})")]
    return " + ".join(f'COALESCE(LENGTH(CAST("{c}" AS TEXT)),0)' for c in cols) or "0"


def _sizes(conn: sqlite3.Connection, names: list[str]) -> tuple[dict, dict]:
    """``({table: bytes}, {dataset: bytes})`` of stored content. Full scans — ~80ms on a
    45k-event store — so this runs ONLY when the caller opts in via ``?sizes=1``. The panel
    refreshes on every dataset write, and paying this on that path would put a pair of full
    table scans behind every collection tick."""
    per_table, per_ds = {}, {}
    for name in names:
        try:
            per_table[name] = conn.execute(
                f'SELECT COALESCE(SUM({_content_expr(conn, name)}),0) b FROM "{name}"').fetchone()["b"]
        except sqlite3.OperationalError:
            per_table[name] = None
    # A dataset's footprint spans the three tables keyed by it; `datasets` itself is one tiny row.
    for table in ("events", "current", "positions"):
        if table not in names:
            continue
        try:
            for r in conn.execute(f'SELECT dataset, COALESCE(SUM({_content_expr(conn, table)}),0) b '
                                  f'FROM "{table}" GROUP BY dataset'):
                per_ds[r["dataset"]] = per_ds.get(r["dataset"], 0) + r["b"]
        except sqlite3.OperationalError:
            pass
    return per_table, per_ds


@router.get("/{game}")
def dbschema(game: str, sizes: bool = False) -> dict:
    """The game's SQLite store structure: tables/columns/indexes/row-counts + per-dataset
    stats. Empty when no store exists yet.

    ``sizes=1`` adds per-table / per-dataset content sizes and the whole-store content total —
    off by default because it costs a full scan of every table (see :func:`_sizes`)."""
    db = _db_path(get_settings().data_dir, game)
    if not db.exists():
        return {"game": game, "db": None, "tables": [], "datasets": []}
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    try:
        tables = []
        names = [r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        for name in names:
            cols = [{"name": r["name"], "type": r["type"]}
                    for r in conn.execute(f"PRAGMA table_info({name})")]
            idx = [r["name"] for r in conn.execute(f"PRAGMA index_list({name})")
                   if not r["name"].startswith("sqlite_autoindex")]
            try:
                rows = conn.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0]
            except sqlite3.OperationalError:
                rows = None
            tables.append({"name": name, "columns": cols, "indexes": idx, "rows": rows})

        tbytes, dbytes = _sizes(conn, names) if sizes else ({}, {})
        for t in tables:
            t["bytes"] = tbytes.get(t["name"])

        datasets = []
        try:
            stats = {r["dataset"]: dict(r) for r in conn.execute(
                "SELECT dataset, COUNT(*) events, COUNT(DISTINCT batch) batches "
                "FROM events GROUP BY dataset")}
            present = {r["dataset"]: r["n"] for r in conn.execute(
                "SELECT dataset, COUNT(*) n FROM current WHERE present=1 GROUP BY dataset")}
            registered = [r["dataset"] for r in conn.execute("SELECT dataset FROM datasets ORDER BY dataset")]
            for ds in registered:
                s = stats.get(ds, {})
                datasets.append({"dataset": ds, "events": s.get("events", 0),
                                 "batches": s.get("batches", 0), "present": present.get(ds, 0),
                                 "bytes": dbytes.get(ds)})
        except sqlite3.OperationalError:
            pass
        size = db.stat().st_size
        # Why the file dwarfs the data: SQLite never returns deleted pages to the OS, it parks
        # them on a freelist for reuse. On this store 84% of a 194 MB file was freelist — only
        # VACUUM (0.3s here) hands it back. These are O(1) header reads, NOT scans, so unlike the
        # per-table content sizes they ride every refresh for free.
        #
        # `live` counts real pages (rows AND indexes AND page overhead), which is why it sits well
        # above the `content` figure below — that one only sums stored value lengths and is blind
        # to indexes. Two different questions, kept as two clearly-named numbers.
        page = conn.execute("PRAGMA page_size").fetchone()[0]
        pages = conn.execute("PRAGMA page_count").fetchone()[0]
        free = conn.execute("PRAGMA freelist_count").fetchone()[0]
        out = {"game": game, "db": db.name, "size": size, "tables": tables, "datasets": datasets,
               "live_bytes": (pages - free) * page, "free_bytes": free * page}
        if sizes:
            out["content"] = sum(v for v in tbytes.values() if v)
        return out
    finally:
        conn.close()


def _datasets_on_disk(game: str) -> list[str]:
    """The dataset names currently registered in the game's store (empty when none)."""
    db = _db_path(get_settings().data_dir, game)
    if not db.exists():
        return []
    conn = sqlite3.connect(str(db))
    try:
        try:
            return [r[0] for r in conn.execute("SELECT dataset FROM datasets ORDER BY dataset")]
        except sqlite3.OperationalError:
            return []
    finally:
        conn.close()


@router.post("/{game}/drop")
def drop_db(game: str) -> dict:
    """Drop the whole game store and leave a fresh empty one. Every dataset's data is gone;
    the graph's dataset nodes survive and resurrect their dataset on the next write."""
    snapshot_db(get_settings().data_dir, game, reason="pre-drop")   # before this irreversible wipe
    removed = drop_database(get_settings().data_dir, game)
    for ds in removed:
        changes.publish(game, ds)   # nudge every panel/node that watched a now-empty dataset
    return dbschema(game)


@router.post("/{game}/vacuum")
def vacuum_db(game: str) -> dict:
    """Compact the store file, handing freed pages back to the OS.

    NOT destructive: VACUUM rewrites the same content, so there is no snapshot here and nothing
    to confirm — it only reclaims space SQLite was holding for reuse. Returns the byte counts
    plus the refreshed schema (with sizes) so the panel can report what it freed and redraw from
    one round-trip. ``ok: false`` means the store was busy mid-write; the file is untouched and
    retrying is safe."""
    res = vacuum_database(get_settings().data_dir, game)
    return {**res, "schema": dbschema(game, sizes=True)}


@router.post("/{game}/table/{table}/clear")
def clear_db_table(game: str, table: str) -> dict:
    """Empty ONE physical table (rows only). Low-level — see ``clear_table`` for the caveat."""
    affected = _datasets_on_disk(game)   # snapshot before the wipe so subscribers refresh
    snapshot_db(get_settings().data_dir, game, reason=f"pre-clear-table:{table}")
    try:
        clear_table(get_settings().data_dir, game, table)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    for ds in affected:
        changes.publish(game, ds)
    return dbschema(game)
