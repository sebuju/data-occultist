"""Locate and validate item instances from an :class:`ItemDef` template.

Finding items, on the fly, without a fixed grid:

  * columns are an even tiling of the data area by the cell width;
  * rows come from the *locator* tell — a cheap visual tell (filled/colour/template)
    slid down a column finds the rows with no OCR, or a text tell clusters the OCR
    lines across every column;
  * each (row, col) places the whole cell; fields read at cell-relative offsets. A
    text-located cell re-anchors on its OWN column's label (tile types put their
    label at different heights, so a row-wide anchor misplaces mixed rows).

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
from .rows import fit_row_lattice

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


def _peaks(ys: list[float], scores: list[float], thr: float, min_dist: float) -> list[float]:
    """Cluster the contiguous above-threshold band around each row into ONE peak.

    Sliding a window over an icon makes a wide high-score plateau, so picking raw
    maxima would split one row into several. Instead, group above-threshold samples
    whose gap is < ``min_dist`` and take each group's score-weighted centre."""
    hits = sorted((y, s) for y, s in zip(ys, scores) if s >= thr)
    if not hits:
        return []
    groups, cur = [], [hits[0]]
    for y, s in hits[1:]:
        if y - cur[-1][0] > min_dist:
            groups.append(cur)
            cur = [(y, s)]
        else:
            cur.append((y, s))
    groups.append(cur)
    out = []
    for g in groups:
        wsum = sum(s for _, s in g)
        out.append(sum(y * s for y, s in g) / wsum if wsum else g[0][0])
    return out


def _visual_rows(frame: Frame, item: ItemDef, loc, da, templates) -> list[float]:
    """Slide the locator tell's region down column 0 and pick the rows where it fires."""
    iw, ih = item.box.w, item.box.h
    lx = da.x + loc.box.x * iw          # column 0 sits at the data-area's left edge
    lw, lh = loc.box.w * iw, loc.box.h * ih
    tmpl = templates.get(loc.id) if templates else None
    step = max(1.0 / frame.client.h, ih * 0.05)

    ys, scores = [], []
    y = da.y
    while y + lh <= da.y + da.h:
        crop = _crop(frame, FractionBox(lx, y, lw, lh))
        ys.append(y + lh / 2)
        scores.append(telldet.visual_score(loc, crop, tmpl))
        y += step
    # cluster gap a few slide-steps wide: merges one row's plateau, keeps rows apart
    return _peaks(ys, scores, loc.threshold, max(step * 3, ih * 0.15))


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


def _text_rows(item: ItemDef, loc_lines: list[tuple], da, pitch_tol: float | None = None) -> list[float]:
    """Fit a regular row lattice to the eligible locator lines (every column).

    Clusters the lines into candidate rows, then lays a regular pitch+phase grid over
    the data area so a row whose name is occluded/low-confidence still gets a cell, and
    off-lattice OCR noise never invents a phantom row (see :func:`fit_row_lattice`)."""
    centers = [t[1] for t in loc_lines]
    heights = [t[2] for t in loc_lines]
    return fit_row_lattice(centers, heights, item.box.h, da.y, da.y + da.h, None,
                           anchor=anchor_align(item), pitch_tol=pitch_tol)


def _text_cols(item: ItemDef, loc, loc_lines: list[tuple], da, pitch_tol: float | None = None) -> list[float]:
    """Fit a regular COLUMN lattice to the locator lines — the horizontal twin of
    :func:`_text_rows`. Each line's anchor edge (per ``align_x``: its left/centre/right)
    minus the locator's cell-relative x position gives a candidate cell LEFT edge; those
    cluster into the real columns. Because the phase comes from the content, blank margins
    in the data area don't shift the grid (the geometric ``da.x + c*pitch`` tiling did)."""
    iw = item.box.w
    ax = anchor_align_x(item)
    # ``align_x`` is where the text sits in the CELL, not in the locator box: left edge at the
    # cell's left (0), centre at the cell centre (0.5), right edge at the cell's right (1.0).
    # cell_x (left edge) = <line's anchor edge> - xref*iw.
    xref = 1.0 if ax == "right" else (0.5 if ax == "center" else 0.0)
    cands = []
    for cx, _cy, _h, lx, lw in loc_lines:
        edge = (lx + lw) if ax == "right" else (cx if ax == "center" else lx)
        cands.append(edge - xref * iw)
    if not cands:
        return []
    return fit_row_lattice(cands, [iw] * len(cands), iw, da.x, da.x + da.w, None,
                           anchor="center", pitch_tol=pitch_tol)


def _column_anchor(loc_lines: list[tuple], x0: float, x1: float, lc: float, ih: float,
                   align: str) -> float | None:
    """Re-anchor ONE cell to the locator text actually in ITS column.

    A row-wide anchor assumes every tile puts its label at the same height, but tile
    types differ (an arcane's name sits above its rank diamonds; a plain item's name
    sits lower) — so a row anchored from one type misplaces the other's boxes and the
    label falls outside its field box. The lines in this column within half a cell of
    the row anchor are the cell's own label; anchor on them. None -> no text here,
    keep the row anchor."""
    band = [(cy, h) for cx, cy, h, *_ in loc_lines if x0 <= cx <= x1 and abs(cy - lc) <= ih * 0.5]
    if not band:
        return None
    if align == "top":
        return min(cy - h / 2 for cy, h in band)
    if align == "bottom":
        return max(cy for cy, _ in band)
    return sum(cy for cy, _ in band) / len(band)


def _cell_in_bounds(item: ItemDef, cell_x: float, cell_y: float, da, iw: float | None = None, ih: float | None = None, clip_right: bool = False) -> bool:
    """Every field AND tell box of the placed cell must sit inside the data area.
    A row half-scrolled off the grid (or a misplaced anchor) pushes boxes outside,
    where they read unrelated UI text — dismiss the whole cell instead. ``iw``/``ih`` are the
    placed cell dimensions (default the item's own box; a shared static grid passes its own).

    ``clip_right`` (located mode): allow boxes to overflow the RIGHT edge. A cell's width
    carries the margin toward the NEXT column, so the last column's wide name box reaches
    past a tightly-drawn right edge even though the content sits inside — that's expected
    clipping, not an off-grid cell. The other three edges stay strict (a partial bottom row
    or a misplaced anchor must still be dismissed)."""
    iw = item.box.w if iw is None else iw
    ih = item.box.h if ih is None else ih
    ex, ey = 0.02 * iw, 0.02 * ih           # authoring slack: boxes drawn to the edge
    boxes = [f.box for f in item.fields] + [t.box for t in item.tells]
    for b in boxes:
        x, y = cell_x + b.x * iw, cell_y + b.y * ih
        if (x < da.x - ex or y < da.y - ey
                or (not clip_right and x + b.w * iw > da.x + da.w + ex)
                or y + b.h * ih > da.y + da.h + ey):
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


def _cells_for_item(frame: Frame, item: ItemDef, da, lines_frac, templates, ref: float, loc_numeric: bool = False, loc_conf: float = _LOC_MIN_CONF, static_grid: bool = True, grid=None, pitch_tol: float | None = None) -> list[ItemCell]:
    """Locate this item's cells across the data area.

    STATIC mode (default): tile from a shared grid (``grid`` = (xs, ys, giw, gih)) formed from
    the window's lowest-priority cell, so every template aligns to the same cells. With no
    shared grid, tile from this item's own authored cell. No OCR. LOCATED mode: rows come
    from the OCR locator and ``ref`` is the cell-relative y its content anchors to."""
    iw, ih = item.box.w, item.box.h
    if iw <= 0 or ih <= 0 or da.w <= 0 or da.h <= 0:
        return []
    # static cells are placed on the SHARED grid (its cell size), so all templates line up;
    # located cells use this item's own cell size.
    giw, gih = (grid[2], grid[3]) if grid else (iw, ih)

    def emit(out, ri, c, cell_x, cell_y, cw, ch):
        # located cells may clip the right edge (cell width = pitch incl. next-column margin)
        if not _cell_in_bounds(item, cell_x, cell_y, da, cw, ch, clip_right=not static_grid):
            return                          # a box outside the data area reads stray UI text
        boxes = {
            f.field: FractionBox(cell_x + f.box.x * cw, cell_y + f.box.y * ch,
                                 f.box.w * cw, f.box.h * ch)
            for f in item.fields
        }
        out.append(ItemCell(Cell(row=ri, col=c, boxes=boxes), cell_x, cell_y, cw, ch, item))

    out: list[ItemCell] = []
    if static_grid:
        # anchor at the data-area corner (its top-left), tile by the cell size — the cell's
        # position is NOT used as a phase
        xs = grid[0] if grid else static_grid_origins(da.x, iw, da.x, da.x + da.w)
        ys = grid[1] if grid else static_grid_origins(da.y, ih, da.y, da.y + da.h)
        for ri, cell_y in enumerate(ys):
            for c, cell_x in enumerate(xs):
                emit(out, ri, c, cell_x, cell_y, giw, gih)
        return out

    loc = locator_of(item)
    if loc is None:
        return []
    loc_lines = None
    if _is_visual_loc(loc):
        # visual locators have no text to cluster into columns -> tile columns geometrically
        loc_anchors = _visual_rows(frame, item, loc, da, templates)
        ncols = max(1, round(da.w / iw))
        col_xs = [da.x + c * (da.w / ncols) for c in range(ncols)]
    else:
        loc_lines = _loc_lines(item, loc, lines_frac, da, numeric=loc_numeric, min_conf=loc_conf)
        loc_anchors = _text_rows(item, loc_lines, da, pitch_tol)
        col_xs = _text_cols(item, loc, loc_lines, da, pitch_tol)   # columns FROM CONTENT
    align = anchor_align(item)
    for ri, lc in enumerate(loc_anchors):
        for c, cell_x in enumerate(col_xs):
            anchor_y = lc
            if loc_lines is not None:
                # per-cell re-anchor: this column's own label, not the row consensus
                la = _column_anchor(loc_lines, cell_x + loc.box.x * iw,
                                    cell_x + (loc.box.x + loc.box.w) * iw, lc, ih, align)
                if la is not None:
                    anchor_y = la
            cell_y = anchor_y - ref * ih    # align the locator's true content to the detected row
            if anchor_y != lc and not _cell_in_bounds(item, cell_x, cell_y, da, clip_right=True):
                # The column re-anchor only sees letter-bearing lines, so a label whose
                # BOTTOM line is letter-less (e.g. "Akbronco Prime" over "[30]") anchors
                # one line high and pushes the cell out of bounds. The row consensus
                # still has it right — retry there before dismissing the tile.
                cell_y = lc - ref * ih
            emit(out, ri, c, cell_x, cell_y, iw, ih)
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
        exp_x = ic.ox + (1.0 if ax == "right" else 0.0 if ax == "left" else 0.5) * ic.iw
        act_y = ly if ay == "top" else (ly + lh if ay == "bottom" else ly + lh / 2)
        exp_y = by + (0.0 if ay == "top" else bh if ay == "bottom" else bh / 2)
        dxs.append(abs(act_x - exp_x) / ic.iw)   # CELL units, per axis
        dys.append(abs(act_y - exp_y) / ic.ih)
    if not dxs:
        return {"x": {"mean": 0.0, "max": 0.0}, "y": {"mean": 0.0, "max": 0.0}, "n": 0}
    agg = lambda v: {"mean": round(sum(v) / len(v), 4), "max": round(max(v), 4)}
    return {"x": agg(dxs), "y": agg(dys), "n": len(dxs)}


def locate_item_cells(frame: Frame, window: WindowDef, lines_frac, templates=None, anchors=None) -> list[ItemCell]:
    """Located cells for every item template defined on the window, concatenated.

    ``anchors`` maps item id -> calibrated cell-relative anchor (RegionReader fills it
    by OCR-ing the cutout). Falls back to the locator tell's centre when absent."""
    if not window.items or window.data_area is None:
        return []
    da = window.data_area.to_fraction()
    items = [it for it in window.items if it.enabled]
    if not items:
        return []
    out: list[ItemCell] = []

    # Row-finding mode is per WINDOW (all its item templates share the data-area grid).
    if getattr(window, "static_grid", True):
        # ONE grid for the whole window: anchored at the data-area corner, tiled by the
        # LOWEST-priority item's cell SIZE (the generic base sets only the pitch, not the
        # position). Every template reads at those cells; resolve_overlaps picks the winner.
        base = min(items, key=lambda it: it.priority)
        giw, gih = base.box.w, base.box.h
        xs = static_grid_origins(da.x, giw, da.x, da.x + da.w)
        ys = static_grid_origins(da.y, gih, da.y, da.y + da.h)
        grid = (xs, ys, giw, gih)
        for item in items:
            out.extend(_cells_for_item(frame, item, da, lines_frac, templates, 0.5, static_grid=True, grid=grid))
        return out

    # LOCATED: each template resolves its own OCR locator + anchoring inputs
    pitch_tol = window.scroll.pitch_tolerance if window.scroll else None
    for item in items:
        loc = locator_of(item)
        if loc is None:
            continue
        # a NUMBER-typed field locator (e.g. a mod's drain) anchors rows on its digits, not
        # letters — so the line filter keeps digit lines instead of rejecting them as badges
        fid = getattr(loc, "field", None)
        fdef = next((f for f in window.fields if f.id == fid), None) if fid else None
        loc_numeric = bool(fdef and fdef.type is FieldType.number)
        # the locator's OWN confidence input governs which lines anchor rows — its tell_conf
        # when set (>0), else the default floor.
        tc = getattr(loc, "tell_conf", 0.0) or 0.0
        loc_conf = tc if tc > 0 else _LOC_MIN_CONF
        ref = (anchors or {}).get(item.id, loc.box.y + loc.box.h / 2)
        out.extend(_cells_for_item(frame, item, da, lines_frac, templates, ref, loc_numeric, loc_conf, static_grid=False, pitch_tol=pitch_tol))
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
            score = text_match_score(want, read, mode=t.match, included=t.included,
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
