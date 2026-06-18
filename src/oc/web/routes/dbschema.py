"""Database-structure endpoint for the DB-structure panel.

Reports the per-game SQLite store's shape: tables (with columns + indexes + row counts) and
a per-dataset breakdown (event count, present records, batches). Read-only — opens its own
short-lived connection so it never contends with a writer (WAL allows concurrent readers)."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter

from ...store.dataset_store import _db_path
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
