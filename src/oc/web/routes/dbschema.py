"""Database-structure endpoint for the DB-structure panel.

Reports the per-game SQLite store's shape: tables (with columns + indexes + row counts) and
a per-dataset breakdown (event count, present records, batches). Read-only — opens its own
short-lived connection so it never contends with a writer (WAL allows concurrent readers)."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, HTTPException

from ...store import changes
from ...store.dataset_store import _db_path, clear_table, drop_database
from ...store.db_backup import snapshot_db
from ..deps import get_settings

router = APIRouter(prefix="/api/dbschema", tags=["dbschema"])


@router.get("/{game}")
def dbschema(game: str) -> dict:
    """The game's SQLite store structure: tables/columns/indexes/row-counts + per-dataset
    stats. Empty when no store exists yet."""
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
                                 "batches": s.get("batches", 0), "present": present.get(ds, 0)})
        except sqlite3.OperationalError:
            pass
        size = db.stat().st_size
        return {"game": game, "db": db.name, "size": size, "tables": tables, "datasets": datasets}
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
