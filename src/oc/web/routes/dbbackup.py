"""Database-backup endpoints for the DB-backups modal.

Snapshots of a game's whole SQLite store: list, take one on demand, restore one. The
auto-before-destructive and daily-on-change triggers live elsewhere (the destructive
routes call ``snapshot_db`` directly; :class:`oc.store.db_backup.AutoBackup` rides the
change bus) — this router is the manual + restore surface the UI talks to."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ...store.db_backup import list_db_backups, restore_db_backup, snapshot_db
from ..deps import get_settings
from .dbschema import dbschema

router = APIRouter(prefix="/api/dbbackup", tags=["dbbackup"])


@router.get("/{game}")
def backups(game: str) -> dict:
    """All snapshots for the game, newest first."""
    return {"game": game, "items": list_db_backups(get_settings().data_dir, game)}


@router.post("/{game}/create")
def create_backup(game: str) -> dict:
    """Take a snapshot now. Returns the refreshed list (with whether one was created)."""
    data_dir = get_settings().data_dir
    made = snapshot_db(data_dir, game)
    return {"game": game, "created": bool(made), "items": list_db_backups(data_dir, game)}


@router.post("/{game}/{stamp}/restore")
def restore_backup(game: str, stamp: str) -> dict:
    """Restore a snapshot over the live store (current state snapshotted first). Returns the
    refreshed DB schema + backups list."""
    data_dir = get_settings().data_dir
    try:
        restore_db_backup(data_dir, game, stamp)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"game": game, "schema": dbschema(game), "items": list_db_backups(data_dir, game)}
