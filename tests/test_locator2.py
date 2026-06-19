"""Locator 2.0 — joint content-fit grid discovery (pure logic, no OCR/GPU).

Mirrors tests/test_items.py style: synthetic ``lines_frac`` tuples
``(cx, cy, h, text, conf, lx, lw)`` feed the locator; a dummy frame is enough
because v2 never touches the image for text locators.
"""

import numpy as np

from oc.collect.items import locate_item_cells, resolve_overlaps
from oc.profile.models import Box, FieldDef, FieldType, ItemDef, RegionDef, WindowDef
from oc.types import Frame, PixelBox

FRAME = Frame(image=np.zeros((1000, 1000, 3), dtype=np.uint8), client=PixelBox(0, 0, 1000, 1000))


def _relic_window(align_x="left", data_area=Box(x=0.0, y=0.0, w=1.0, h=1.0)):
    """A relic-style window: a ``name`` locator (text, tell) + an optional ``count``."""
    name = RegionDef(id="name", box=Box(x=0.0, y=0.0, w=1.0, h=0.5), field="name",
                     tell=True, locate=True, align="center", align_x=align_x)
    count = RegionDef(id="count", box=Box(x=0.0, y=0.6, w=0.4, h=0.3), field="count")
    item = ItemDef(id="relic", box=Box(x=0.0, y=0.0, w=0.2, h=0.2),
                   align="center", align_x=align_x, fields=[name, count])
    return WindowDef(id="w", static_grid=False, data_area=data_area, items=[item],
                     fields=[FieldDef(id="name"), FieldDef(id="count", type=FieldType.number)])


def _name(cx, cy, lw=0.10, conf=0.95, text="Meso Relic"):
    return (cx, cy, 0.04, text, conf, cx - lw / 2, lw)


def test_relic_grid_count_optional():
    # A 2x2 grid of names: two carry a count badge, two don't. Count presence is SOFT,
    # so every name yields a cell either way -> exactly 4 cells, 2 rows x 2 columns.
    win = _relic_window(align_x="center")
    lines = []
    for cx in (0.3, 0.5):            # columns one cell-pitch (0.2) apart
        for cy in (0.3, 0.5):        # rows one cell-pitch apart
            lines.append(_name(cx, cy))
    lines.append((0.32, 0.30, 0.03, "x20", 0.9, 0.30, 0.05))   # a count badge (digit-dominant)
    lines.append((0.52, 0.50, 0.03, "5", 0.9, 0.51, 0.02))     # another count, no name attached
    cells = locate_item_cells(FRAME, win, lines)
    assert len(cells) == 4
    assert len({round(ic.ox, 3) for ic in cells}) == 2     # two columns
    assert len({round(ic.oy, 3) for ic in cells}) == 2     # two rows
    assert all("count" in ic.cell.boxes for ic in cells)   # count box still placed for reading


def test_phase_locks_to_content_not_data_area_corner():
    # A blank left margin: data area starts at x=0.2 but the two name columns sit at left
    # edges 0.35 and 0.55 (one pitch apart). The lattice phase must come from the content,
    # so columns land on 0.35/0.55 — NOT on the da.x (0.2) + pitch tiling.
    win = _relic_window(align_x="left", data_area=Box(x=0.2, y=0.0, w=0.7, h=1.0))
    lines = []
    for cy in (0.3, 0.5):
        lines.append(_name(0.40, cy, lw=0.10))   # left edge 0.35
        lines.append(_name(0.60, cy, lw=0.10))   # left edge 0.55
    cells = locate_item_cells(FRAME, win, lines)
    xs = sorted({round(ic.ox, 2) for ic in cells})
    assert xs == [0.35, 0.55]          # phased on content
    assert 0.2 not in xs               # not the data-area corner


def test_close_lines_merge_into_one_column():
    # Gap-clustering forms a solid grid: two columns one cell-pitch (0.2) apart, plus a
    # near-duplicate line within half a cell of column 0 (e.g. an OCR re-detection). The
    # duplicate must MERGE into column 0 — no phantom third column, no overlap. Exactly two
    # columns, spacing uniform.
    win = _relic_window(align_x="left")
    lines = []
    for cy in (0.30, 0.50):
        lines.append(_name(0.25, cy, lw=0.10))   # col0, left edge 0.20
        lines.append(_name(0.45, cy, lw=0.10))   # col1, left edge 0.40
    lines.append(_name(0.27, 0.30, lw=0.10))     # near-duplicate of col0 (left 0.22, < half cell)
    cells = locate_item_cells(FRAME, win, lines)
    xs = sorted({round(ic.ox, 2) for ic in cells})
    assert len(xs) == 2                          # duplicate merged: no phantom column
    assert abs((xs[1] - xs[0]) - 0.2) < 0.03     # uniform one-pitch spacing


def test_occluded_name_leaves_its_slot_empty():
    # A full 2x2 grid with one name missing (occluded): the lattice still spans the area,
    # but the empty slot has no anchor line -> no cell. The other three are intact.
    win = _relic_window(align_x="left")
    lines = [
        _name(0.25, 0.30), _name(0.45, 0.30),    # row 0: both present
        _name(0.25, 0.50),                       # row 1: only the first column
    ]
    cells = locate_item_cells(FRAME, win, lines)
    locs = {(round(ic.ox, 2), round(ic.oy, 2)) for ic in cells}
    assert len(cells) == 3
    row1 = max(y for _, y in locs)               # the lower row (larger y)
    assert (0.20, row1) in locs                  # first column present
    assert (0.40, row1) not in locs              # occluded slot stays empty


def test_multiple_templates_one_location_resolved_by_priority():
    # Two templates share the window and both locate on a name. At a name's location BOTH
    # emit a candidate cell (same tile) — "they all work together to get the best location".
    # resolve_overlaps then keeps exactly ONE item per location; priority breaks the tie,
    # it never moved the location.
    name_a = RegionDef(id="name", box=Box(x=0.0, y=0.0, w=1.0, h=0.5), field="name",
                       tell=True, locate=True, align="center", align_x="center")
    plain = ItemDef(id="plain", box=Box(x=0.0, y=0.0, w=0.2, h=0.2), priority=1,
                    align="center", align_x="center", fields=[name_a])
    special = ItemDef(id="special", box=Box(x=0.0, y=0.0, w=0.2, h=0.2), priority=5,
                      align="center", align_x="center", fields=[name_a])
    win = WindowDef(id="w", static_grid=False, data_area=Box(x=0.0, y=0.0, w=1.0, h=1.0),
                    items=[plain, special], fields=[FieldDef(id="name")])
    cells = locate_item_cells(FRAME, win, [_name(0.3, 0.3)])
    # one location, both templates -> two overlapping candidate cells
    assert len(cells) == 2
    assert {ic.item.id for ic in cells} == {"plain", "special"}
    assert cells[0].ox == cells[1].ox and cells[0].oy == cells[1].oy
    kept = resolve_overlaps(cells, [0, 1])
    assert len(kept) == 1
    assert cells[kept[0]].item.id == "special"   # higher priority wins the single slot


def test_align_bottom_anchors_on_box_bottom_edge():
    # The authored ``align`` must drive the cell-relative anchor, not a hardcoded centre.
    # Locator box y=0.0 h=0.5 with align="bottom" -> the name's BOTTOM sits at 0.5 of the
    # cell. A line bottom at 0.32 (cy 0.30 + h/2 0.02) puts the cell top at 0.32 - 0.5*0.2.
    name = RegionDef(id="name", box=Box(x=0.0, y=0.0, w=1.0, h=0.5), field="name",
                     tell=True, locate=True, align="bottom", align_x="left")
    item = ItemDef(id="relic", box=Box(x=0.0, y=0.0, w=0.2, h=0.2),
                   align="bottom", align_x="left", fields=[name])
    win = WindowDef(id="w", static_grid=False, data_area=Box(x=0.0, y=0.0, w=1.0, h=1.0),
                    items=[item], fields=[FieldDef(id="name")])
    cells = locate_item_cells(FRAME, win, [(0.25, 0.30, 0.04, "Meso Relic", 0.95, 0.20, 0.10)])
    assert len(cells) == 1
    assert round(cells[0].oy, 3) == round(0.32 - 0.5 * 0.2, 3)   # 0.22, not centre-based 0.27


def test_last_pass_snaps_columns_to_content_consensus():
    # The grid-regular last pass: the lattice (authored pitch 0.2) buckets content, but the
    # final column x comes from the CONTENT median, not the rigid node. Column two sits at
    # left edge 0.45 (off the 0.40 node) — cells must snap to 0.45, not 0.40.
    win = _relic_window(align_x="left")
    lines = []
    for cy in (0.3, 0.5):
        lines.append(_name(0.25, cy, lw=0.10))   # left edge 0.20 -> node 0.20
        lines.append(_name(0.50, cy, lw=0.10))   # left edge 0.45 -> node 0.40, off by 0.05
    cells = locate_item_cells(FRAME, win, lines)
    xs = sorted({round(ic.ox, 2) for ic in cells})
    assert xs == [0.20, 0.45]      # content consensus, not lattice nodes [0.20, 0.40]


def test_outlier_cell_pulled_onto_column_consensus():
    # Three names in one column; the middle one read a few pixels right (an outlier). The
    # column's median ignores it, so ALL three cells share one x — the outlier is corrected.
    win = _relic_window(align_x="left")
    lines = [
        _name(0.25, 0.30, lw=0.10),   # left edge 0.20
        _name(0.28, 0.50, lw=0.10),   # left edge 0.23 (the outlier)
        _name(0.25, 0.70, lw=0.10),   # left edge 0.20
    ]
    cells = locate_item_cells(FRAME, win, lines)
    assert len(cells) == 3
    assert len({round(ic.ox, 3) for ic in cells}) == 1            # one shared column x
    assert round(cells[0].ox, 2) == 0.20                          # snapped to the median


def test_empty_inputs_return_empty():
    win = _relic_window()
    assert locate_item_cells(FRAME, win, []) == []          # no names -> no cells
    no_items = WindowDef(id="w", data_area=Box(x=0, y=0, w=1, h=1), fields=[FieldDef(id="name")])
    assert locate_item_cells(FRAME, no_items, [_name(0.3, 0.3)]) == []
