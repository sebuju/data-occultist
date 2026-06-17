"""Stats endpoints: per-node execution durations for the stats panel.

The panel polls :func:`stats` for the live rollup (one row per node+op) and lazily fetches
:func:`node_history` only when the user expands a row (the trend chart). Rename/remove carry
a node's history across the matching graph edit, driven from the front-end's single rename
seam.
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from ...store import stats_store

router = APIRouter(prefix="/api/stats", tags=["stats"])


@router.get("/{game}")
def stats(game: str):
    """Live rollup: one row per (node, op) — count, last/avg/min/max ms, last-seen ts."""
    return {"game": game, "nodes": stats_store.aggregate(game)}


@router.get("/{game}/node/{node}/history")
def node_history(game: str, node: str, op: str = ""):
    """Recent samples ``[[ts, ms, n], ...]`` for one node (optionally one op), time-ordered.
    Fetched only on row-expand — never pushed."""
    return {"node": node, "op": op, "samples": stats_store.history(game, node, op)}


class _Rename(BaseModel):
    old: str
    new: str


@router.post("/{game}/rename")
def rename(game: str, body: _Rename):
    """Carry a node's stats history across a rename (file move + rollup remap)."""
    stats_store.rename_node(game, body.old, body.new)
    return {"ok": True}


@router.delete("/{game}/node/{node}")
def remove(game: str, node: str):
    """Drop a node's stats when the node is deleted."""
    stats_store.remove_node(game, node)
    return {"ok": True}
