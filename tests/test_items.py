import numpy as np

from oc.collect.grid import Cell
from oc.collect.items import ItemCell, grid_drift, locate_item_cells, resolve_overlaps, valid_cell
from oc.profile.models import Box, FieldDef, ItemDef, RegionDef, Tell, TellKind, WindowDef
from oc.types import Frame, OcrLine, PixelBox


def _window():
    item = ItemDef(
        id="it",
        box=Box(x=0.0, y=0.0, w=0.2, h=0.25),
        fields=[RegionDef(id="name", box=Box(x=0.05, y=0.6, w=0.9, h=0.3), field="name")],
        tells=[Tell(id="icon", box=Box(x=0.1, y=0.05, w=0.5, h=0.4),
                    kind=TellKind.filled, threshold=0.2, locate=True)],
    )
    return WindowDef(id="w", fields=[FieldDef(id="name")], static_grid=False,
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


def test_tell_keeps_only_filled_cells():
    win = _window()
    frame = _frame_with_icons([0.0, 0.25, 0.5])
    cells = locate_item_cells(frame, win, [])
    # only column 0 has an icon -> only its cells pass the filled tell
    kept = [ic for ic in cells if valid_cell(frame, win, {"name": "x"}, ic)]
    assert kept and all(ic.cell.col == 0 for ic in kept)


def _text_window():
    """Text-located grid: the name field doubles as the locator (tell=True)."""
    item = ItemDef(
        id="it",
        box=Box(x=0.0, y=0.0, w=0.2, h=0.25),
        align="bottom",
        fields=[RegionDef(id="name", box=Box(x=0.05, y=0.6, w=0.9, h=0.3),
                          field="name", tell=True),
                RegionDef(id="count", box=Box(x=0.0, y=0.0, w=0.5, h=0.15),
                          field="count")],
    )
    return WindowDef(id="w", fields=[FieldDef(id="name"), FieldDef(id="count")], static_grid=False,
                     data_area=Box(x=0.0, y=0.0, w=1.0, h=1.0), items=[item])


def test_text_locator_ignores_count_badges():
    # A count badge like "x20" CONTAINS a letter but is digit-dominant — a NAME (text)
    # locator must not anchor a row on it, or every name row gains a phantom count row and
    # the whole lattice shifts (names then read on the count line). Two real name rows + a
    # count badge between them -> exactly two rows, anchored on the names.
    win = _text_window()
    lines = [
        (0.10, 0.30, 0.02, "Meso A9 Relic", 0.95),   # a name (letter-dominant) -> anchors
        (0.10, 0.40, 0.02, "x20", 0.90),             # a count badge (digit-dominant) -> ignored
        (0.10, 0.55, 0.02, "Lith E2 Relic", 0.95),   # another name -> anchors
    ]
    frame = Frame(image=np.zeros((1000, 1000, 3), dtype=np.uint8), client=PixelBox(0, 0, 1000, 1000))
    cells = locate_item_cells(frame, win, lines)
    tops = sorted({round(ic.oy, 3) for ic in cells})
    assert len(tops) == 2          # the badge did NOT invent a third row between the names


def test_columns_found_from_content_ignore_margins():
    # Columns must anchor on the OCR text x (align_x), NOT tile geometrically from da.x — so a
    # blank left margin in the data area doesn't shift the grid. da starts at 0.2; the two name
    # columns sit at left edges 0.35 and 0.60. (cx, cy, h, text, conf, lx, lw)
    item = ItemDef(id="it", box=Box(x=0.0, y=0.0, w=0.2, h=0.25), align="bottom", align_x="left",
                   fields=[RegionDef(id="name", box=Box(x=0.0, y=0.6, w=0.9, h=0.3), field="name", tell=True)])
    win = WindowDef(id="w", fields=[FieldDef(id="name")], static_grid=False,
                    data_area=Box(x=0.2, y=0.0, w=0.7, h=1.0), items=[item])
    lines = []
    for cy in (0.25, 0.55):
        lines.append((0.40, cy, 0.05, "Alpha Relic", 0.95, 0.35, 0.10))
        lines.append((0.65, cy, 0.05, "Bravo Relic", 0.95, 0.60, 0.10))
    frame = Frame(image=np.zeros((1000, 1000, 3), dtype=np.uint8), client=PixelBox(0, 0, 1000, 1000))
    cells = locate_item_cells(frame, win, lines)
    xs = sorted({round(ic.ox, 2) for ic in cells})
    assert xs == [0.35, 0.60]   # on content, not da.x (0.2) + pitch


def test_align_x_center_lands_locator_box_on_content():
    # align_x re-lands the LOCATOR FIELD'S OWN box on the line it located — its text IS that
    # line, so the read box must sit on it (the horizontal twin of align, which already re-lands
    # the box's vertical edge). With a non-centred locator box (x=0, w=0.6 -> box centre 0.3) a
    # centred name places the cell so the BOX centre lands on the text. (Old behaviour pinned the
    # CELL centre instead, leaving every read a constant fraction off the text -> visible drift.)
    item = ItemDef(id="it", box=Box(x=0.0, y=0.0, w=0.2, h=0.25), align="bottom", align_x="center",
                   fields=[RegionDef(id="name", box=Box(x=0.0, y=0.6, w=0.6, h=0.3), field="name", tell=True)])
    win = WindowDef(id="w", fields=[FieldDef(id="name")], static_grid=False,
                    data_area=Box(x=0.0, y=0.0, w=1.0, h=1.0), items=[item])
    # two columns of names centred at 0.30 and 0.60 (cx; lx=cx-0.05, lw=0.10)
    lines = []
    for cy in (0.25, 0.55):
        lines.append((0.30, cy, 0.05, "Alpha Relic", 0.95, 0.25, 0.10))
        lines.append((0.60, cy, 0.05, "Bravo Relic", 0.95, 0.55, 0.10))
    frame = Frame(image=np.zeros((1000, 1000, 3), dtype=np.uint8), client=PixelBox(0, 0, 1000, 1000))
    cells = locate_item_cells(frame, win, lines)
    nb = item.fields[0].box                      # locator box centre = x + w/2 = 0.3 of the cell
    box_centers = sorted({round(ic.ox + (nb.x + nb.w / 2) * ic.iw, 2) for ic in cells})
    assert box_centers == [0.30, 0.60]           # the locator field's box re-lands on its text


def test_grid_drift_zero_when_cells_land_on_content():
    # When the located cells sit exactly on their rows+columns, the grid-drift score is ~0.
    # Content placed on a perfect 2x2 grid (centred names); locate, then measure drift.
    item = ItemDef(id="it", box=Box(x=0.0, y=0.0, w=0.2, h=0.2), align="center", align_x="center",
                   fields=[RegionDef(id="name", box=Box(x=0.0, y=0.4, w=0.6, h=0.2), field="name", tell=True)])
    win = WindowDef(id="w", fields=[FieldDef(id="name")], static_grid=False,
                    data_area=Box(x=0.0, y=0.0, w=1.0, h=1.0), items=[item])
    W = H = 1000
    lw, lh = 0.10, 0.05
    lines, lf = [], []
    for rc in (0.30, 0.60):           # row centres
        for cc in (0.30, 0.60):       # column centres — names CENTRED on each
            bx, by, bw, bh = (cc - lw / 2) * W, (rc - lh / 2) * H, lw * W, lh * H
            lines.append(OcrLine(text="Alpha Relic", box=PixelBox(int(bx), int(by), int(bw), int(bh)), confidence=0.95))
            lf.append((cc, rc, lh, "Alpha Relic", 0.95, cc - lw / 2, lw))
    frame = Frame(image=np.zeros((H, W, 3), dtype=np.uint8), client=PixelBox(0, 0, W, H))
    ics = locate_item_cells(frame, win, lf)
    d = grid_drift(ics, lines, W, H)
    assert d["n"] == 4
    assert d["x"]["max"] < 0.02 and d["y"]["max"] < 0.02   # cells land dead-on -> x & y drift ~0


def test_visual_guard_lands_on_content_grid_not_geometric():
    # A visual guard (a fieldless template/tell item, e.g. the unowned-relic terminator) has no text
    # of its own to cluster, so it must borrow the lattice the TEXT item established from the on-screen
    # names — which tracks the scroll. The OLD path tiled it geometrically from the data-area corner,
    # so on a scrolled window its tell box landed off the real tile. Here the content columns (0.35,
    # 0.60) do NOT coincide with the geometric tiling from da.x (0.2 + k*0.2 = 0.2, 0.4, 0.6): the
    # guard must land on the content columns, proving it followed the text lattice.
    relic = ItemDef(id="relic", box=Box(x=0.0, y=0.0, w=0.2, h=0.25), align="bottom", align_x="left",
                    priority=0,
                    fields=[RegionDef(id="name", box=Box(x=0.0, y=0.6, w=0.9, h=0.3), field="name", tell=True)])
    guard = ItemDef(id="guard", box=Box(x=0.0, y=0.0, w=0.2, h=0.25), priority=1,
                    tells=[Tell(id="mark", box=Box(x=0.1, y=0.05, w=0.5, h=0.4),
                                kind=TellKind.filled, threshold=0.2, locate=True)])
    win = WindowDef(id="w", fields=[FieldDef(id="name")], static_grid=False,
                    data_area=Box(x=0.2, y=0.0, w=0.7, h=1.0), items=[relic, guard])
    lines = []
    for cy in (0.25, 0.55):
        lines.append((0.40, cy, 0.05, "Alpha Relic", 0.95, 0.35, 0.10))
        lines.append((0.65, cy, 0.05, "Bravo Relic", 0.95, 0.60, 0.10))
    frame = Frame(image=np.zeros((1000, 1000, 3), dtype=np.uint8), client=PixelBox(0, 0, 1000, 1000))
    cells = locate_item_cells(frame, win, lines)
    guard_xs = sorted({round(ic.ox, 2) for ic in cells if ic.item.id == "guard"})
    assert guard_xs == [0.35, 0.60]                     # on the text lattice, NOT [0.2, 0.4, 0.6]
    # and the guard shares the text item's rows too (same oy set)
    relic_ys = sorted({round(ic.oy, 3) for ic in cells if ic.item.id == "relic"})
    guard_ys = sorted({round(ic.oy, 3) for ic in cells if ic.item.id == "guard"})
    assert guard_ys == relic_ys


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


