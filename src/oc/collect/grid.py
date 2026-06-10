"""Expand a window's regions across a scrollable grid into concrete cells.

A non-grid window yields a single cell containing its regions as-authored. A grid
window (``WindowDef.scroll`` with rows/cols) tiles each region's base box by the
configured row/column strides, producing one cell per visible slot.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..profile.models import WindowDef
from ..types import FractionBox


@dataclass
class Cell:
    """One logical record slot: field id -> region box (window fractions)."""

    row: int
    col: int
    boxes: dict[str, FractionBox]  # keyed by FieldDef.id


def _shift(box: FractionBox, dx: float, dy: float) -> FractionBox:
    return FractionBox(box.x + dx, box.y + dy, box.w, box.h)


def expand_cells(window: WindowDef) -> list[Cell]:
    """Static tiling from the authored template — the configured rows/strides taken
    at face value. Used when there's no data area to detect rows in, and as a
    fallback. Prefer :func:`cells_for_rows` when the live row positions are known."""
    base = {r.field: r.box.to_fraction() for r in window.regions if r.enabled}
    scroll = window.scroll
    if scroll is None or (scroll.rows <= 1 and scroll.cols <= 1):
        return [Cell(row=0, col=0, boxes=base)]

    cells: list[Cell] = []
    for row in range(scroll.rows):
        for col in range(scroll.cols):
            dx = col * scroll.col_stride
            dy = row * scroll.row_stride
            cells.append(
                Cell(row=row, col=col, boxes={f: _shift(b, dx, dy) for f, b in base.items()})
            )
    return cells


def cells_for_rows(window: WindowDef, row_centers: list[float], base_cy: float) -> list[Cell]:
    """Tile the authored row template onto the rows actually detected in the frame.

    The configured rows/strides are only a *hint*; the real row count and vertical
    positions come from ``row_centers`` (fractions, the centres of the *anchor*
    field). Each detected row keeps the authored intra-row layout, just shifted so
    the anchor field lands on the detected row. ``base_cy`` is the authored centre of
    that anchor field. Columns are still tiled by the configured ``col_stride``.
    """
    base = {r.field: r.box.to_fraction() for r in window.regions if r.enabled}
    scroll = window.scroll
    cols = max(1, scroll.cols if scroll else 1)
    col_stride = scroll.col_stride if scroll else 0.0

    cells: list[Cell] = []
    for ri, ry in enumerate(row_centers):
        dy = ry - base_cy
        for col in range(cols):
            dx = col * col_stride
            cells.append(
                Cell(row=ri, col=col, boxes={f: _shift(b, dx, dy) for f, b in base.items()})
            )
    return cells
