from oc.collect.grid import expand_cells
from oc.profile.models import Box, RegionDef, ScrollDef, WindowDef


def _window(scroll=None):
    return WindowDef(
        id="w",
        regions=[RegionDef(id="r", field="name", box=Box(x=0.1, y=0.1, w=0.1, h=0.05))],
        scroll=scroll,
    )


def test_single_cell_without_scroll():
    cells = expand_cells(_window())
    assert len(cells) == 1
    assert cells[0].boxes["name"].x == 0.1


def test_grid_tiles_rows_cols():
    scroll = ScrollDef(rows=2, cols=3, row_stride=0.2, col_stride=0.15)
    cells = expand_cells(_window(scroll))
    assert len(cells) == 6
    # row 1, col 2 is offset by stride from the base box.
    c = next(c for c in cells if c.row == 1 and c.col == 2)
    assert abs(c.boxes["name"].x - (0.1 + 2 * 0.15)) < 1e-9
    assert abs(c.boxes["name"].y - (0.1 + 1 * 0.2)) < 1e-9
