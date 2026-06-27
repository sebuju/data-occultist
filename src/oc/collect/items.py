"""Locate and validate item instances from an :class:`ItemDef` template.

Finding items, on the fly, without a fixed grid. Each item's locator field (its name,
usually) back-projects every eligible OCR line — honouring the authored ``align`` /
``align_x`` edge — to the cell ORIGIN that would put the anchor on that line. Those
origins are gap-clustered per axis (items always form a regular grid, so a gap wider than
half a cell is a new column/row); each cluster median is a grid line. Per cell the
align-extreme line is kept (so a wrapped second line never drags the anchor), and the cell
is emitted there. :func:`resolve_overlaps` then keeps ONE item per location; priority only
breaks that tie, never drives location.

A detected cell is kept only when *all* the item's tells pass (:func:`valid_cell`),
so floating tooltips and empty slots are discarded.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..detect.matcher import text_match_score
from ..profile.models import FieldType, ItemDef, Tell, TellKind, WindowDef
from ..types import Frame, FractionBox
from . import tells as telldet
from .grid import Cell
from .pips import count_diamonds, count_pips

_LOC_MIN_CONF = 0.7   # text-locator lines below this are OCR garbage, not names


@dataclass
class ItemCell:
    """A located cell: the readable boxes plus the cell origin/size and its template."""

    cell: Cell
    ox: float
    oy: float
    iw: float
    ih: float
    item: ItemDef


def locator_of(item: ItemDef):
    """What finds the rows. Priority: an explicit ``locate`` tell, else a field flagged
    ``locate`` (a reliable text field used purely to anchor rows, no tell duty), else the
    first visual tell (cheap, no OCR), else any text tell, else a field flagged ``tell`` (it
    locates by its OCR text). So an item can be located by a name without that name being a
    tell. Returns a Tell or a RegionDef field, or None."""
    tl = item.tells
    for t in tl:
        if t.locate:
            return t
    for f in item.fields:                       # a field explicitly flagged to locate
        if getattr(f, "locate", False):
            return f
    for t in tl:
        if telldet.is_visual(t):
            return t
    if tl:
        return tl[0]
    for f in item.fields:
        if getattr(f, "tell", False):
            return f
    return None


def _is_visual_loc(loc) -> bool:
    """Visual locators slide a region down a column (no OCR); a Tell that isn't text.
    A field locator (RegionDef) is always text."""
    return isinstance(loc, Tell) and telldet.is_visual(loc)


def anchor_align(item: ItemDef) -> str:
    """How the locator's text aligns in the cell. Taken from the locator tell (so it's
    tell-specific), falling back to the item's legacy ``align``."""
    loc = locator_of(item)
    return (getattr(loc, "align", "") or item.align) if loc else item.align


def anchor_align_x(item: ItemDef) -> str:
    """Horizontal twin of :func:`anchor_align`: which edge of the located text fixes the
    column — "left"/"center"/"right". Locator's own ``align_x`` wins, else the item's."""
    loc = locator_of(item)
    return (getattr(loc, "align_x", "") or item.align_x or "left") if loc else (item.align_x or "left")


def _crop(frame: Frame, fb: FractionBox) -> np.ndarray:
    pb = fb.to_pixels(frame.client.w, frame.client.h)
    return frame.image[pb.y : pb.y + pb.h, pb.x : pb.x + pb.w]


def _expand_box(fb: FractionBox, margin: float) -> FractionBox:
    """Grow a box by ``margin`` (fraction of its own size) on every side, clamped to [0,1] —
    the search region a template tell slides its saved sub-image within."""
    x0 = max(0.0, fb.x - fb.w * margin)
    y0 = max(0.0, fb.y - fb.h * margin)
    x1 = min(1.0, fb.x + fb.w * (1 + margin))
    y1 = min(1.0, fb.y + fb.h * (1 + margin))
    return FractionBox(x0, y0, x1 - x0, y1 - y0)


def _loc_lines(item: ItemDef, loc, lines_frac, da, numeric: bool = False, min_conf: float = _LOC_MIN_CONF) -> list[tuple]:
    """The OCR lines eligible to anchor rows AND columns: confident lines of the locator's
    CHARACTER CLASS anywhere inside the data area. Returns (cx, cy, h, lx, lw) — centre,
    height, plus left edge + width so columns can be clustered from content (see _text_cols).

    The char class follows the locator FIELD's type: a text locator (a name) keeps only
    letter-DOMINANT lines — rejecting count badges that merely CONTAIN a letter (e.g. "x20",
    "x6") and icon garbage that would otherwise corrupt the row anchor by adding phantom rows
    between the names; a NUMBER locator (e.g. a mod's drain) keeps digit-dominant lines
    instead, since there the digits ARE the anchor. "Dominant" not "contains": a count badge
    like "x20" has a letter but is digit-heavy, so a name locator must reject it or every
    name row gets a sibling count row and the whole lattice shifts. Low-confidence lines are
    always dropped."""
    out = []
    for cx, cy, h, text, conf, *box in lines_frac:
        if not (da.x <= cx <= da.x + da.w and da.y <= cy <= da.y + da.h):
            continue
        nl = sum(ch.isalpha() for ch in text)
        nd = sum(ch.isdigit() for ch in text)
        wanted = (nd > nl) if numeric else (nl > nd)   # DOMINANT class, not merely present
        if conf < min_conf or not wanted:
            continue                     # skip the wrong char class + low-confidence garbage
        lx = box[0] if box else cx                   # line left edge (frac); fall back to centre
        lw = box[1] if len(box) > 1 else 0.0         # line width (frac)
        out.append((cx, cy, h, lx, lw))
    return out


def _cell_in_bounds(item: ItemDef, cell_x: float, cell_y: float, da, iw: float | None = None, ih: float | None = None, clip_x: bool = False) -> bool:
    """Every field AND tell box of the placed cell must sit inside the data area.
    A row half-scrolled off the grid (or a misplaced anchor) pushes boxes outside,
    where they read unrelated UI text — dismiss the whole cell instead. ``iw``/``ih`` are the
    placed cell dimensions (default the item's own box; a shared static grid passes its own).

    ``clip_x`` (located mode): allow boxes to overflow BOTH horizontal edges. A cell's width
    carries the margin toward the neighbouring column, so a wide / ``align_x: center`` name box
    reaches past a tightly-drawn edge even though the content sits inside — that's expected
    clipping, not an off-grid cell. It is symmetric: the FIRST column's centred box overhangs
    the LEFT edge exactly as the last column's overhangs the right, so both are tolerated (else
    the leftmost column is silently dropped though its anchor is in-bounds). The anchor line
    itself is already gated to the data area (see ``_loc_lines``), so this admits no off-grid
    cell. Top/bottom stay strict — a partial bottom row / misplaced anchor must still be
    dismissed. A static grid (``clip_x=False``) stays strict on all four edges."""
    iw = item.box.w if iw is None else iw
    ih = item.box.h if ih is None else ih
    ex, ey = 0.02 * iw, 0.02 * ih           # authoring slack: boxes drawn to the edge
    boxes = [f.box for f in item.fields] + [t.box for t in item.tells]
    for b in boxes:
        x, y = cell_x + b.x * iw, cell_y + b.y * ih
        if y < da.y - ey or y + b.h * ih > da.y + da.h + ey:     # top/bottom always strict
            return False
        if not clip_x and (x < da.x - ex or x + b.w * iw > da.x + da.w + ex):
            return False
    return True


def static_grid_origins(o0: float, step: float, lo: float, hi: float) -> list[float]:
    """Tile origins ``o0 + k*step`` (k any sign) whose tile ``[o, o+step]`` fits in ``[lo, hi]``.
    The static grid anchors at the DATA-AREA corner (``o0 = lo``) and tiles by the cell size
    (``step``), so row 0 / col 0 always start at the data-area top-left — the cell sets only the
    pitch, never the phase. Walks both directions from o0 (a non-corner o0 still works)."""
    if step <= 0:
        return [o0]
    slack = step * 0.04                      # authoring slack: a cell drawn flush to the edge counts
    out = []
    o = o0
    while o >= lo - slack:                    # o0 and leftward
        if o + step <= hi + slack:
            out.append(o)
        o -= step
    o = o0 + step
    while o + step <= hi + slack:             # rightward of o0
        if o >= lo - slack:
            out.append(o)
        o += step
    out.sort()
    return out


def grid_drift(ics: list[ItemCell], lines, cw: float, ch: float) -> dict:
    """How far the located cells sit from the content they should bracket — a grid-fit score.

    Per cell: the EXPECTED locator-text anchor (x from ``align_x`` relative to the CELL —
    left=0, centre=0.5, right=1.0; y from the locator box's ``align`` edge) vs where the OCR
    actually read that line. The offset is normalised by the CELL size, so the score is in
    CELL units: 0 = dead-on, 0.25 = a quarter of a cell off, 1.0 = a whole cell off. (Window
    fractions hide it — a quarter-cell shift is only ~3% of a wide window but ruins the grid.)

    Returns ``{x:{mean,max}, y:{mean,max}, n}`` — drift split by axis (horizontal vs vertical),
    each in CELL units (n = cells that had a locator line to measure against)."""
    fl = [(ln.box.x / cw, ln.box.y / ch, ln.box.w / cw, ln.box.h / ch) for ln in lines]
    dxs, dys = [], []
    for ic in ics:
        # only DATA cells: a fieldless guard (e.g. "no relic") tiles every row with its own
        # offset locator box and isn't stored — its drift is noise, not a grid-fit signal.
        if not ic.item.fields:
            continue
        loc = locator_of(ic.item)
        if loc is None or ic.iw <= 0 or ic.ih <= 0:
            continue
        bx, by = ic.ox + loc.box.x * ic.iw, ic.oy + loc.box.y * ic.ih
        bw, bh = loc.box.w * ic.iw, loc.box.h * ic.ih
        cand = [t for t in fl if bx <= t[0] + t[2] / 2 <= bx + bw and by <= t[1] + t[3] / 2 <= by + bh]
        if not cand:
            continue
        cyc = by + bh / 2
        lx, ly, lw, lh = min(cand, key=lambda t: abs(t[1] + t[3] / 2 - cyc))
        ax, ay = anchor_align_x(ic.item), anchor_align(ic.item)
        act_x = (lx + lw) if ax == "right" else (lx if ax == "left" else lx + lw / 2)
        exp_x = ic.ox + _box_xref(loc.box, ax) * ic.iw   # the locator box's edge, twin of exp_y
        act_y = ly if ay == "top" else (ly + lh if ay == "bottom" else ly + lh / 2)
        exp_y = by + (0.0 if ay == "top" else bh if ay == "bottom" else bh / 2)
        dxs.append(abs(act_x - exp_x) / ic.iw)   # CELL units, per axis
        dys.append(abs(act_y - exp_y) / ic.ih)
    if not dxs:
        return {"x": {"mean": 0.0, "max": 0.0}, "y": {"mean": 0.0, "max": 0.0}, "n": 0}

    def agg(v):
        return {"mean": round(sum(v) / len(v), 4), "max": round(max(v), 4)}

    return {"x": agg(dxs), "y": agg(dys), "n": len(dxs)}


def _box_xref(box, ax: str) -> float:
    """Where the locator's OWN box puts its ``align_x`` edge, in cell-relative units:
    right -> box right (``x+w``), centre -> box centre (``x+w/2``), left -> box left (``x``).

    This is the horizontal twin of :func:`_anchor_ref` (which reads the box's vertical edge).
    Using the box edge — not an idealised 0/0.5/1 — is what lands the locator FIELD'S OWN box
    back on the line it located: a name box drawn off-centre in the cell (e.g. centre at 0.39,
    not 0.5) must re-place at 0.39, else every read sits a constant fraction off the text."""
    return (box.x + box.w) if ax == "right" else (box.x if ax == "left" else box.x + box.w / 2)


def _origin_x(item: ItemDef, loc, cw: float, cx: float, lx: float, lw: float) -> float:
    """Cell LEFT edge that lands the anchor text's ``align_x`` edge on this line, with the
    locator box's own x-offset honoured (so the located field's box re-lands on the text)."""
    ax = anchor_align_x(item)
    edge = (lx + lw) if ax == "right" else (cx if ax == "center" else lx)
    return edge - _box_xref(loc.box, ax) * cw


def _origin_y(item: ItemDef, ch: float, cy: float, h: float, ref: float) -> float:
    """Cell TOP edge that lands the anchor line's ``align`` edge at the cell-relative ``ref``."""
    ay = anchor_align(item)
    anchor_y = (cy - h / 2) if ay == "top" else (cy + h / 2) if ay == "bottom" else cy
    return anchor_y - ref * ch


def _anchor_ref(item: ItemDef, loc) -> float:
    """The cell-relative y the anchor's ``align`` edge sits at — the twin of the edge
    :func:`_origin_y` reads off each line. ``align`` is authored, so honour it: top -> the
    locator box's top, bottom -> its bottom, centre -> its centre."""
    ay = anchor_align(item)
    b = loc.box
    return b.y if ay == "top" else (b.y + b.h if ay == "bottom" else b.y + b.h / 2)


def _clusters(vals: list[float], min_gap: float) -> list[float]:
    """Sorted cluster centres (medians): a gap wider than ``min_gap`` starts a new cluster.
    The grid is regular, so half a cell is the natural separator — points closer than that
    are the same column/row, points farther apart are distinct ones."""
    if not vals:
        return []
    s = sorted(vals)
    groups: list[list[float]] = [[s[0]]]
    for v in s[1:]:
        if v - groups[-1][-1] > min_gap:
            groups.append([v])
        else:
            groups[-1].append(v)
    return [_median(g) for g in groups]


def _median(vals: list[float]) -> float:
    s = sorted(vals)
    n = len(s)
    m = n // 2
    return s[m] if n % 2 else (s[m - 1] + s[m]) / 2


def _emit(item: ItemDef, ri: int, ci: int, cell_x: float, cell_y: float,
          cw: float, ch: float) -> ItemCell:
    """Build one candidate cell: the item's fields placed at cell-relative offsets."""
    boxes = {
        f.field: FractionBox(cell_x + f.box.x * cw, cell_y + f.box.y * ch,
                             f.box.w * cw, f.box.h * ch)
        for f in item.fields
    }
    return ItemCell(Cell(row=ri, col=ci, boxes=boxes), cell_x, cell_y, cw, ch, item)


def locate_item_cells(frame: Frame, window: WindowDef, lines_frac, templates=None, anchors=None) -> list[ItemCell]:
    """Located cells for every item template, found by gap-clustering the OCR content.

    Each template's locator field back-projects every eligible (in-bounds) anchor line to
    the cell origin its authored ``align``/``align_x`` edge implies; those origins are
    gap-clustered per axis into the grid's columns and rows. Per cell the align-extreme line
    is kept (so a wrapped second line never drags the anchor). ``anchors`` is accepted for
    signature compatibility but unused — v2 anchors on the authored align edge, not on a
    cutout calibration that would snap to the line centre and override the alignment.
    """
    if not window.items or window.data_area is None:
        return []
    da = window.data_area.to_fraction()
    items = [it for it in window.items if it.enabled]
    if not items:
        return []

    # ONE grid for the whole window: pitch = the lowest-priority ("base") cell size. Every
    # template places its fields at this size; resolve_overlaps picks one item per location.
    base = min(items, key=lambda it: it.priority)
    giw, gih = base.box.w, base.box.h
    if giw <= 0 or gih <= 0 or da.w <= 0 or da.h <= 0:
        return []

    # Per template: locator, whether it is visual (no text to cluster), and the back-projected
    # cell origins of its eligible lines — but ONLY lines whose placed cell is IN BOUNDS. A
    # relic tile carries a status badge ("Crafted"/"Owned") ABOVE the name, also letter-
    # dominant and inside the data area; back-projected as a name it lands a cell off the top
    # of the data area. Gating on bounds here drops it before it can skew the grid.
    info: dict[str, tuple] = {}
    for item in items:
        loc = locator_of(item)
        if loc is None:
            continue
        visual = _is_visual_loc(loc)
        ref = _anchor_ref(item, loc)
        pts: list[tuple[float, float]] = []
        if not visual:
            fid = getattr(loc, "field", None)
            fdef = next((f for f in window.fields if f.id == fid), None) if fid else None
            numeric = bool(fdef and fdef.type is FieldType.number)
            tc = getattr(loc, "tell_conf", 0.0) or 0.0
            conf = tc if tc > 0 else _LOC_MIN_CONF
            for cx, cy, h, lx, lw in _loc_lines(item, loc, lines_frac, da, numeric=numeric, min_conf=conf):
                cox = _origin_x(item, loc, giw, cx, lx, lw)
                coy = _origin_y(item, gih, cy, h, ref)
                if _cell_in_bounds(item, cox, coy, da, giw, gih, clip_x=True):
                    pts.append((cox, coy))
        info[item.id] = (loc, visual, pts)

    def _nearest(v: float, arr: list[float]) -> int:
        return min(range(len(arr)), key=lambda k: abs(arr[k] - v))

    # Derive the grid by GAP-CLUSTERING the content origins (a gap > half a cell = a new
    # column/row); cluster centres are the real grid lines, straight from the content.
    text_items = [it for it in items if it.id in info and not info[it.id][1] and info[it.id][2]]
    col_centers = _clusters([cox for it in text_items for cox, _ in info[it.id][2]], giw * 0.5)
    row_centers = _clusters([coy for it in text_items for _, coy in info[it.id][2]], gih * 0.5)

    # Snap each line to its (row, col); keep ONE line per cell by the authored vertical align
    # (bottom -> bottommost line, so a wrapped 2nd line never drags the anchor off the name's
    # bottom edge; top -> topmost; centre -> median). The column/row line is the MEDIAN of
    # those anchors, so every column shares one x and every row one y — a solid grid.
    col_buf: dict[int, list[float]] = {}
    row_buf: dict[int, list[float]] = {}
    occ: dict[str, set] = {}
    for it in text_items:
        ay = anchor_align(it)
        groups: dict[tuple[int, int], list[tuple[float, float]]] = {}
        for cox, coy in info[it.id][2]:
            ri, ci = _nearest(coy, row_centers), _nearest(cox, col_centers)
            groups.setdefault((ri, ci), []).append((cox, coy))
        for (ri, ci), lst in groups.items():
            if ay == "bottom":
                rx, ry = max(lst, key=lambda p: p[1])
            elif ay == "top":
                rx, ry = min(lst, key=lambda p: p[1])
            else:
                rx, ry = _median([p[0] for p in lst]), _median([p[1] for p in lst])
            col_buf.setdefault(ci, []).append(rx)
            row_buf.setdefault(ri, []).append(ry)
            occ.setdefault(it.id, set()).add((ri, ci))
    col_line = {k: _median(v) for k, v in col_buf.items()}
    row_line = {k: _median(v) for k, v in row_buf.items()}

    out: list[ItemCell] = []
    for it in text_items:
        for ri, ci in sorted(occ.get(it.id, ())):
            cx, cy = col_line[ci], row_line[ri]
            # cells may clip the right edge (cell width carries the next-column margin)
            if _cell_in_bounds(it, cx, cy, da, giw, gih, clip_x=True):
                out.append(_emit(it, ri, ci, cx, cy, giw, gih))

    # Visual locators carry no text to cluster: tile the data area geometrically and let the
    # reader's pip/diamond validation keep the real cells (the old static-grid behaviour).
    visual_items = [it for it in items if it.id in info and info[it.id][1]]
    if visual_items:
        xs = static_grid_origins(da.x, giw, da.x, da.x + da.w)
        ys = static_grid_origins(da.y, gih, da.y, da.y + da.h)
        for it in visual_items:
            for ri, cy in enumerate(ys):
                for ci, cx in enumerate(xs):
                    if _cell_in_bounds(it, cx, cy, da, giw, gih, clip_x=True):
                        out.append(_emit(it, ri, ci, cx, cy, giw, gih))
    return out


def resolve_overlaps(ics: list[ItemCell], idx: list[int]) -> list[int]:
    """From the VALID cell indices, drop overlaps so each tile keeps one template.

    When several templates claim the same tile (e.g. a generic 'name' template and a
    specific 'arcane' template both match an arcane), keep the one with the higher
    ``priority`` (ties broken by tell count). Cells overlap when their centres are within
    half a cell — but ONLY across DIFFERENT templates: two cells of the SAME item are
    distinct grid positions (adjacent rows/cols), never rivals, even when the authored cell
    is taller than the real row pitch (which previously made a tightly-packed grid drop every
    other row). So a single-template window never drops anything."""
    order = sorted(idx, key=lambda i: (-ics[i].item.priority, -len(ics[i].item.tells)))
    kept: list[int] = []
    for i in order:
        a = ics[i]
        acx, acy = a.ox + a.iw / 2, a.oy + a.ih / 2
        clash = any(ics[j].item is not a.item
                    and abs(acx - (ics[j].ox + ics[j].iw / 2)) < a.iw * 0.5
                    and abs(acy - (ics[j].oy + ics[j].ih / 2)) < a.ih * 0.5 for j in kept)
        if not clash:
            kept.append(i)
    return kept


def _tell_result(frame: Frame, values: dict, ic: ItemCell, t, templates=None, confs=None,
                 tell_reads=None) -> dict:
    """Score one tell and whether it passes — used by both validation and the preview
    diagnostics, so the UI shows the exact reason a cell is kept or rejected.

    A ``text`` tell judges ONE read. Which one:
      * bound to a ``field`` -> reuse that field's read (no extra OCR);
      * fieldless -> its OWN box, OCR'd separately and handed in via ``tell_reads``
        ({tell_id: (text, conf)}). This is the cheap-to-author case: draw a box over a
        label, set the literal, done — no field needed;
      * fieldless with no ``tell_reads`` (pure-logic callers with no OCR) -> falls back to
        the first non-empty column read, so the function stays usable without an engine.
    The score is the read-vs-text match (literal set) or the read's OCR confidence (not)."""
    if t.kind is TellKind.text:
        want = (t.text or "").strip()
        # resolve which read this tell judges + its confidence + a label for diagnostics
        conf = None
        if t.field:
            val = values.get(t.field)
            read = "" if val is None else str(val)
            conf = (confs or {}).get(t.field)
            src = t.field
        elif tell_reads is not None and t.id in tell_reads:
            text, conf = tell_reads[t.id]
            read = (text or "").strip()
            src = "box"
        else:
            val = next((v for v in values.values() if v not in (None, "")), "")
            read = "" if val is None else str(val)
            src = "any"
        if want:
            score = text_match_score(want, read, mode=t.match,
                                     case_sensitive=t.case_sensitive, min_chars=t.min_chars, strip=t.strip)
            return {"id": t.id, "kind": t.kind.value, "field": t.field,
                    "score": round(float(score), 3), "threshold": t.threshold,
                    "pass": score >= t.threshold, "detail": f"{src}={read!r} ~ {want!r}"}
        # no literal: pass when the chosen source read SOMETHING
        ok = read not in (None, "")
        score = round(float(conf), 3) if conf is not None else (1.0 if ok else 0.0)
        return {"id": t.id, "kind": t.kind.value, "field": t.field,
                "score": score, "threshold": None, "pass": ok, "detail": f"{src}={read!r}"}
    fb = FractionBox(ic.ox + t.box.x * ic.iw, ic.oy + t.box.y * ic.ih,
                     t.box.w * ic.iw, t.box.h * ic.ih)
    # template tells match a SAVED sub-image: grow the live crop by ``margin`` per side so
    # matchTemplate can slide to the icon even when the located cell drifts a few px (the saved
    # template stays the exact box, so a bigger crop = more search slack, not a scale change).
    m = getattr(t, "margin", 0.0) or 0.0
    if t.kind is TellKind.template and m > 0:
        fb = _expand_box(fb, m)
    tmpl = templates.get(t.id) if templates else None
    score = telldet.visual_score(t, _crop(frame, fb), tmpl)
    return {"id": t.id, "kind": t.kind.value, "field": None,
            "score": round(float(score), 3), "threshold": t.threshold,
            "pass": score >= t.threshold, "detail": None}


def _field_tell_result(frame: Frame, values: dict, confs, ic: ItemCell, f, fields) -> dict:
    """A field flagged ``tell`` doubles as a tell. Two modes:

    * a ``pips``/``diamonds`` field gates on PRESENCE — how many marks are in its box
      (``count_diamonds``), NOT the field's value (which is the *filled* rank and is 0
      for an unranked arcane). ``tell_conf`` is the bar on marks/5, so 0.5 ≈ 3 marks.
    * any other field gates on a real read: non-empty and (numeric) non-zero, clearing
      ``tell_conf`` against the OCR confidence.
    """
    thr = getattr(f, "tell_conf", 0.0) or 0.0
    fdef = (fields or {}).get(f.field)
    if fdef is not None and fdef.type in (FieldType.pips, FieldType.diamonds):
        fb = FractionBox(ic.ox + f.box.x * ic.iw, ic.oy + f.box.y * ic.ih,
                         f.box.w * ic.iw, f.box.h * ic.ih)
        crop = _crop(frame, fb)
        cnt = count_diamonds(crop) if fdef.type is FieldType.diamonds else count_pips(crop)
        score = min(1.0, cnt / 5.0)
        return {"id": f.id, "kind": "field", "field": f.field, "score": round(score, 3),
                "threshold": thr or None, "pass": score >= thr, "detail": f"{f.field}: {cnt} marks"}
    val = values.get(f.field)
    conf = (confs or {}).get(f.field)
    if getattr(f, "tell_allow_text", False):
        # lenient: a read of ANYTHING satisfies the tell (conf is set only when text read),
        # so a number field still passes when its read carries text (e.g. a polarity glyph)
        has = conf is not None or val not in (None, "")
    else:
        has = val not in (None, "") and not (isinstance(val, (int, float)) and val == 0)
    ok = has and (conf is None or conf >= thr)
    score = round(float(conf), 3) if conf is not None else (1.0 if has else 0.0)
    return {"id": f.id, "kind": "field", "field": f.field,
            "score": score, "threshold": thr or None, "pass": ok, "detail": f"{f.field}={val!r}"}


def cell_results(frame: Frame, values: dict, ic: ItemCell, templates=None, confs=None, fields=None,
                 tell_reads=None) -> list[dict]:
    """All pass/score checks for a cell: explicit tells plus any field flagged ``tell``.
    ``tell_reads`` ({tell_id: (text, conf)}) carries the OCR of each fieldless text tell's
    own box (read by the caller, which owns the OCR engine)."""
    res = [_tell_result(frame, values, ic, t, templates, confs, tell_reads) for t in ic.item.tells]
    res += [_field_tell_result(frame, values, confs, ic, f, fields)
            for f in ic.item.fields if getattr(f, "tell", False)]
    return res


def tell_report(frame: Frame, values: dict, ic: ItemCell, templates=None, confs=None, fields=None,
                tell_reads=None) -> list[dict]:
    """Per-tell pass/score for a cell (diagnostics). ``confs`` maps field id -> OCR
    confidence; ``fields`` maps id -> FieldDef so pip/diamond field-tells gate on marks;
    ``tell_reads`` carries the OCR of fieldless text tells' own boxes."""
    return cell_results(frame, values, ic, templates, confs, fields, tell_reads)


def valid_cell(frame: Frame, window: WindowDef, values: dict, ic: ItemCell, templates=None, fields=None,
               confs=None, tell_reads=None) -> bool:
    """True when every tell passes for this cell — explicit tells AND field tells. ``confs``
    (per-field OCR confidence) lets a field-tell's ``tell_conf`` actually gate the read;
    ``tell_reads`` carries the OCR of fieldless text tells' own boxes."""
    return all(r["pass"] for r in cell_results(frame, values, ic, templates, confs=confs,
                                               fields=fields, tell_reads=tell_reads))


def item_templates(windows, load_cutout) -> dict:
    """Reference images for every ``template`` tell across ``windows``: ``{tell_id: crop}``.

    A ``template`` tell scores by matching a saved sub-image inside the cell. That sub-image
    is the tell's own box on the item's frozen cutout — so the reference is built here by
    cropping the cutout at the SAME cell-relative→cutout-fraction mapping the reader uses
    (:meth:`RegionReader.read_cutout`), guaranteeing a self-match of ~1.0 and that the
    reference is never larger than the runtime crop (which would force ``matchTemplate`` to 0).

    ``load_cutout(name)`` returns the cutout image (BGR ndarray) or None. A template tell whose
    item has no cutout, or whose box falls outside it, is skipped — it scores 0 (correctly
    absent, never silently wrong). Without this dict, EVERY template tell scores 0."""
    out: dict = {}
    for w in windows:
        for it in (w.items or []):
            tmpls = [t for t in it.tells if t.kind is TellKind.template]
            cb, ib = it.cutout_box, it.box
            if not (tmpls and it.cutout and cb and cb.w > 0 and cb.h > 0 and ib.w > 0 and ib.h > 0):
                continue
            img = load_cutout(it.cutout)
            if img is None:
                continue
            ch, cw = img.shape[:2]
            iw, ih = ib.w / cb.w, ib.h / cb.h          # cell size in cutout fractions
            ox, oy = (ib.x - cb.x) / cb.w, (ib.y - cb.y) / cb.h
            for t in tmpls:
                fb = FractionBox(ox + t.box.x * iw, oy + t.box.y * ih, t.box.w * iw, t.box.h * ih)
                pb = fb.to_pixels(cw, ch)
                crop = img[pb.y : pb.y + pb.h, pb.x : pb.x + pb.w]
                if crop.size and crop.shape[0] >= 2 and crop.shape[1] >= 2:
                    out[t.id] = crop.copy()
    return out
