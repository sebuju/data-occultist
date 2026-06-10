"""Locate and validate item instances from an :class:`ItemDef` template.

Finding items, on the fly, without a fixed grid:

  * columns are an even tiling of the data area by the cell width;
  * rows come from the *locator* tell — a cheap visual tell (filled/colour/template)
    slid down a column finds the rows with no OCR, or a text tell clusters the OCR
    lines in its column;
  * each (row, col) places the whole cell; fields read at cell-relative offsets.

A detected cell is kept only when *all* the item's tells pass (:func:`valid_cell`),
so floating tooltips and empty slots are discarded.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..profile.models import FieldType, ItemDef, Tell, TellKind, WindowDef
from ..types import Frame, FractionBox
from . import tells as telldet
from .grid import Cell
from .pips import count_diamonds, count_pips
from .rows import detect_row_centers

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
    """What finds the rows. Priority: an explicit ``locate`` tell, else the first visual
    tell (cheap, no OCR), else any text tell, else a field flagged ``tell`` (it locates
    by its OCR text) — so an item can be built entirely from field-tells, with no
    separate tell drawn. Returns a Tell or a RegionDef field, or None."""
    tl = item.tells
    for t in tl:
        if t.locate:
            return t
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


def _text_rows(item: ItemDef, loc, lines_frac, da) -> list[float]:
    """Cluster the OCR lines in the locator field's column into row bands.

    The locator is a TEXT field (a name), so only letter-bearing, confident lines
    count. This rejects two things that otherwise sit in the same column and corrupt
    the row anchor: numeric badges (e.g. a count "6" at the tile's top-left) and OCR
    garbage off the icons (low confidence). Without this, a scrolled view clusters
    badge + garbage + name into one band and the centroid misses the name entirely."""
    iw, ih = item.box.w, item.box.h
    lx0 = da.x + loc.box.x * iw          # column 0 sits at the data-area's left edge
    lx1 = lx0 + loc.box.w * iw
    centers, heights = [], []
    for cx, cy, h, text, conf in lines_frac:
        if not (lx0 <= cx <= lx1 and da.y <= cy <= da.y + da.h):
            continue
        if conf < _LOC_MIN_CONF or not any(ch.isalpha() for ch in text):
            continue                     # skip numeric badges and low-confidence garbage
        centers.append(cy)
        heights.append(h)
    return detect_row_centers(centers, heights, ih, da.y, da.y + da.h, None, anchor=anchor_align(item))


def _cells_for_item(frame: Frame, item: ItemDef, da, lines_frac, templates, ref: float) -> list[ItemCell]:
    """``ref`` is the cell-relative y the detected row anchors to — calibrated from
    where the locator's content ACTUALLY sits in the cutout (see RegionReader), not
    the tell box's centre. That keeps the cell at the position the user authored, so
    every field box lands where it was defined."""
    loc = locator_of(item)
    iw, ih = item.box.w, item.box.h
    if loc is None or iw <= 0 or ih <= 0:
        return []

    if _is_visual_loc(loc):
        loc_anchors = _visual_rows(frame, item, loc, da, templates)
    else:
        loc_anchors = _text_rows(item, loc, lines_frac, da)
    # columns tile the data area EVENLY: step by the exact pitch (da.w / ncols), not
    # the drawn cell width, so a slightly-tight cell doesn't drift across columns.
    ncols = max(1, round(da.w / iw))
    pitch_x = da.w / ncols
    out: list[ItemCell] = []
    for ri, lc in enumerate(loc_anchors):
        cell_y = lc - ref * ih              # align the locator's true content to the detected row
        for c in range(ncols):
            cell_x = da.x + c * pitch_x
            boxes = {
                f.field: FractionBox(cell_x + f.box.x * iw, cell_y + f.box.y * ih,
                                     f.box.w * iw, f.box.h * ih)
                for f in item.fields
            }
            out.append(ItemCell(Cell(row=ri, col=c, boxes=boxes), cell_x, cell_y, iw, ih, item))
    return out


def locate_item_cells(frame: Frame, window: WindowDef, lines_frac, templates=None, anchors=None) -> list[ItemCell]:
    """Located cells for every item template defined on the window, concatenated.

    ``anchors`` maps item id -> calibrated cell-relative anchor (RegionReader fills it
    by OCR-ing the cutout). Falls back to the locator tell's centre when absent."""
    if not window.items or window.data_area is None:
        return []
    da = window.data_area.to_fraction()
    out: list[ItemCell] = []
    for item in window.items:
        if not item.enabled:
            continue
        loc = locator_of(item)
        if loc is None:
            continue
        ref = (anchors or {}).get(item.id, loc.box.y + loc.box.h / 2)
        out.extend(_cells_for_item(frame, item, da, lines_frac, templates, ref))
    return out


def resolve_overlaps(ics: list[ItemCell], idx: list[int]) -> list[int]:
    """From the VALID cell indices, drop overlaps so each tile keeps one template.

    When several templates claim the same tile (e.g. a generic 'name' template and a
    specific 'arcane' template both match an arcane), keep the one with the higher
    ``priority`` (ties broken by tell count). Cells overlap when their centres are
    within half a cell. Single-template windows have no overlaps, so nothing is dropped."""
    order = sorted(idx, key=lambda i: (-ics[i].item.priority, -len(ics[i].item.tells)))
    kept: list[int] = []
    for i in order:
        a = ics[i]
        acx, acy = a.ox + a.iw / 2, a.oy + a.ih / 2
        clash = any(abs(acx - (ics[j].ox + ics[j].iw / 2)) < a.iw * 0.5
                    and abs(acy - (ics[j].oy + ics[j].ih / 2)) < a.ih * 0.5 for j in kept)
        if not clash:
            kept.append(i)
    return kept


def _tell_result(frame: Frame, values: dict, ic: ItemCell, t, templates=None, confs=None) -> dict:
    """Score one tell and whether it passes — used by both validation and the preview
    diagnostics, so the UI shows the exact reason a cell is kept or rejected. For a text
    tell the score is the field's OCR confidence (so a *passing* tell still shows how
    sure the read was, not a flat 1.0)."""
    if t.kind is TellKind.text:
        if t.field:
            val = values.get(t.field)
            ok = val not in (None, "")
            conf = (confs or {}).get(t.field)
            score = round(float(conf), 3) if conf is not None else (1.0 if ok else 0.0)
            detail = f"{t.field}={val!r}"
        else:
            ok = any(v not in (None, "") for v in values.values())
            score = 1.0 if ok else 0.0
            detail = "any field non-empty"
        return {"id": t.id, "kind": t.kind.value, "field": t.field,
                "score": score, "threshold": None, "pass": ok, "detail": detail}
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
    has = val not in (None, "") and not (isinstance(val, (int, float)) and val == 0)
    ok = has and (conf is None or conf >= thr)
    score = round(float(conf), 3) if conf is not None else (1.0 if has else 0.0)
    return {"id": f.id, "kind": "field", "field": f.field,
            "score": score, "threshold": thr or None, "pass": ok, "detail": f"{f.field}={val!r}"}


def cell_results(frame: Frame, values: dict, ic: ItemCell, templates=None, confs=None, fields=None) -> list[dict]:
    """All pass/score checks for a cell: explicit tells plus any field flagged ``tell``."""
    res = [_tell_result(frame, values, ic, t, templates, confs) for t in ic.item.tells]
    res += [_field_tell_result(frame, values, confs, ic, f, fields)
            for f in ic.item.fields if getattr(f, "tell", False)]
    return res


def tell_report(frame: Frame, values: dict, ic: ItemCell, templates=None, confs=None, fields=None) -> list[dict]:
    """Per-tell pass/score for a cell (diagnostics). ``confs`` maps field id -> OCR
    confidence; ``fields`` maps id -> FieldDef so pip/diamond field-tells gate on marks."""
    return cell_results(frame, values, ic, templates, confs, fields)


def valid_cell(frame: Frame, window: WindowDef, values: dict, ic: ItemCell, templates=None, fields=None) -> bool:
    """True when every tell passes for this cell — explicit tells AND field tells."""
    return all(r["pass"] for r in cell_results(frame, values, ic, templates, fields=fields))
