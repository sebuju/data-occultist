import numpy as np

from oc.collect.grid import Cell
from oc.collect.items import ItemCell, locate_item_cells, resolve_overlaps, valid_cell
from oc.profile.models import Box, FieldDef, ItemDef, RegionDef, Tell, TellKind, WindowDef
from oc.types import Frame, PixelBox


def _window():
    item = ItemDef(
        id="it",
        box=Box(x=0.0, y=0.0, w=0.2, h=0.25),
        fields=[RegionDef(id="name", box=Box(x=0.05, y=0.6, w=0.9, h=0.3), field="name")],
        tells=[Tell(id="icon", box=Box(x=0.1, y=0.05, w=0.5, h=0.4),
                    kind=TellKind.filled, threshold=0.2, locate=True)],
    )
    return WindowDef(id="w", fields=[FieldDef(id="name")],
                     data_area=Box(x=0.0, y=0.0, w=1.0, h=1.0), items=[item])


def _frame_with_icons(rows_celltop):
    """1000x1000 black frame with a busy bright icon in column 0 for each row."""
    img = np.zeros((1000, 1000, 3), dtype=np.uint8)
    rng = np.random.default_rng(0)
    for top in rows_celltop:
        y0 = int((top + 0.05 * 0.25) * 1000)
        y1 = int((top + 0.45 * 0.25) * 1000)
        x0, x1 = int(0.02 * 1000), int(0.12 * 1000)
        img[y0:y1, x0:x1] = rng.integers(0, 255, (y1 - y0, x1 - x0, 3), dtype=np.uint8)
    return Frame(image=img, client=PixelBox(0, 0, 1000, 1000))


def test_visual_locator_finds_rows_and_columns():
    win = _window()
    frame = _frame_with_icons([0.0, 0.25, 0.5])      # three rows of icons
    cells = locate_item_cells(frame, win, [])
    rows = {ic.cell.row for ic in cells}
    cols = {ic.cell.col for ic in cells}
    assert len(rows) == 3
    assert cols == {0, 1, 2, 3, 4}                    # 1.0 / 0.2 = 5 columns


def test_tell_keeps_only_filled_cells():
    win = _window()
    frame = _frame_with_icons([0.0, 0.25, 0.5])
    cells = locate_item_cells(frame, win, [])
    # only column 0 has an icon -> only its cells pass the filled tell
    kept = [ic for ic in cells if valid_cell(frame, win, {"name": "x"}, ic)]
    assert kept and all(ic.cell.col == 0 for ic in kept)


def test_no_icons_no_rows():
    win = _window()
    frame = Frame(image=np.zeros((1000, 1000, 3), dtype=np.uint8), client=PixelBox(0, 0, 1000, 1000))
    assert locate_item_cells(frame, win, []) == []


def _ic(prio, ntells, ox=0.0):
    item = ItemDef(id=f"p{prio}", box=Box(x=0, y=0, w=0.2, h=0.2), priority=prio,
                   tells=[Tell(id=f"t{i}", box=Box(x=0, y=0, w=0.1, h=0.1)) for i in range(ntells)])
    return ItemCell(Cell(row=0, col=0, boxes={}), ox=ox, oy=0.0, iw=0.2, ih=0.2, item=item)


def test_resolve_overlaps_priority_wins():
    # two templates on the SAME tile: higher priority kept, lower dropped
    ics = [_ic(prio=0, ntells=5), _ic(prio=9, ntells=1)]
    assert resolve_overlaps(ics, [0, 1]) == [1]


def test_resolve_overlaps_priority_tie_breaks_on_tells():
    ics = [_ic(prio=3, ntells=1), _ic(prio=3, ntells=4)]
    assert resolve_overlaps(ics, [0, 1]) == [1]


def test_resolve_overlaps_keeps_non_overlapping():
    # far-apart tiles never clash, both kept
    ics = [_ic(prio=0, ntells=1, ox=0.0), _ic(prio=0, ntells=1, ox=0.8)]
    assert sorted(resolve_overlaps(ics, [0, 1])) == [0, 1]
