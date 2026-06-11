"""Read records from a frame using a single batched OCR pass.

OCR has heavy per-call overhead, so instead of OCR-ing each cell separately (24+
calls for a grid) we OCR the *union* of all target boxes **once**, then assign each
recognised text line to the field box that contains its centre. This cuts OCR work
roughly by the number of cells while keeping accuracy.

A record's ``confidence`` is its *worst* field, so one occluded region drags the
whole record below the save floor instead of yielding a half-record.
"""

from __future__ import annotations

from dataclasses import dataclass, field as dc_field

import cv2

from ..interfaces import OcrEngine
from ..profile.models import FieldDef, FieldType, Preprocess, WindowDef
from ..types import Frame, OcrLine, PixelBox
from .fields import coerce, coerce_rule
from .grid import Cell, cells_for_rows, expand_cells
from .items import anchor_align, locate_item_cells, locator_of, resolve_overlaps, tell_report, valid_cell
from .pips import count_filled_diamonds, count_pips
from .preprocess import apply as apply_preprocess
from .rows import detect_row_centers

_MIN_OCR_H = 96   # focused field crops shorter than this are upscaled before OCR


@dataclass
class Record:
    values: dict[str, object] = dc_field(default_factory=dict)
    confidence: float = 1.0
    corrected: list[str] = dc_field(default_factory=list)

    def is_empty(self) -> bool:
        return all(v in (None, "") for v in self.values.values())


def _union(boxes: list[PixelBox]) -> PixelBox:
    x0 = min(b.x for b in boxes)
    y0 = min(b.y for b in boxes)
    x1 = max(b.right for b in boxes)
    y1 = max(b.bottom for b in boxes)
    return PixelBox(x0, y0, x1 - x0, y1 - y0)


def _center_in(line: OcrLine, box: PixelBox) -> bool:
    cx = line.box.x + line.box.w / 2
    cy = line.box.y + line.box.h / 2
    return box.x <= cx <= box.right and box.y <= cy <= box.bottom


class RegionReader:
    def __init__(self, ocr: OcrEngine, resolver=None, templates=None, cutouts=None) -> None:
        self._ocr = ocr
        self._resolver = resolver
        # {tell_id: image} for ``template`` tells; loaded by the caller (knows the
        # profile dir). None/absent -> template tells score 0.
        self._templates = templates or {}
        # {item_id: cutout image} so the row anchor can be calibrated to where the
        # locator's content actually sits in the frozen cell. Cached per item.
        self._cutouts = cutouts or {}
        self._anchor_cache: dict[str, float] = {}

    # ---- batched OCR -------------------------------------------------------

    def _ocr_union(
        self, frame: Frame, boxes: list[PixelBox], preprocess: Preprocess | None = None,
        clip: PixelBox | None = None,
    ) -> list[OcrLine]:
        """One OCR pass over a crop; lines in frame coords. ``clip`` (the window's
        data area) bounds the crop so stray text outside it is never read; otherwise
        the crop is the union of the target boxes."""
        if clip is None and not boxes:
            return []
        u = clip if clip is not None else _union(boxes)
        crop = frame.image[u.y : u.y + u.h, u.x : u.x + u.w]
        scale = preprocess.scale if (preprocess and preprocess.scale) else 1.0
        if preprocess is not None:
            crop = apply_preprocess(crop, preprocess)
        lines = self._ocr.read_image(crop)
        return [
            OcrLine(
                text=ln.text,
                confidence=ln.confidence,
                box=PixelBox(
                    round(ln.box.x / scale) + u.x, round(ln.box.y / scale) + u.y,
                    round(ln.box.w / scale), round(ln.box.h / scale),
                ),
            )
            for ln in lines
        ]

    @staticmethod
    def _gather(lines: list[OcrLine], box: PixelBox) -> tuple[str, float]:
        hits = [ln for ln in lines if _center_in(ln, box)]
        if not hits:
            return "", 0.0
        hits.sort(key=lambda ln: ln.box.x)
        text = " ".join(ln.text for ln in hits).strip()
        conf = sum(ln.confidence for ln in hits) / len(hits)
        return text, conf

    def _box_crop(self, frame: Frame, box: PixelBox, preprocess: Preprocess | None):
        """Prepared recognition input for a single field box: crop, preprocess, and
        upscale tiny crops so small multi-character numbers (a count badge) don't
        fragment. Returns the crop, or None if the box is empty."""
        if box.w <= 0 or box.h <= 0:
            return None
        crop = frame.image[box.y : box.y + box.h, box.x : box.x + box.w]
        if crop.size == 0:
            return None
        if preprocess is not None:
            crop = apply_preprocess(crop, preprocess)
        if crop.shape[0] < _MIN_OCR_H:                       # upscale tiny crops
            f = _MIN_OCR_H / crop.shape[0]
            crop = cv2.resize(crop, None, fx=f, fy=f, interpolation=cv2.INTER_CUBIC)
        return crop

    def _focus_reads(self, frame: Frame, window: WindowDef,
                     pending: list[tuple]) -> dict:
        """Batch the focused box reads the detection pass missed. ``pending`` is a list
        of (key, box); returns {key: (text, conf)}. RECOGNITION ONLY (no detection) — the
        dominant OCR cost — and batched into ONE recogniser pass instead of a call per
        box, so a grid full of missed badges is a handful of GPU launches, not dozens."""
        keys, crops = [], []
        for key, box in pending:
            crop = self._box_crop(frame, box, window.preprocess)
            if crop is not None:
                keys.append(key)
                crops.append(crop)
        if not crops:
            return {}
        return dict(zip(keys, self._ocr.read_lines(crops)))

    def _targets_from_cells(self, cells: list[Cell], frame: Frame):
        """Yield (cell_index, field_id, PixelBox) for every field of every cell."""
        out = []
        for ci, cell in enumerate(cells):
            for field_id, frac in cell.boxes.items():
                out.append((ci, field_id, frac.to_pixels(frame.client.w, frame.client.h)))
        return out

    def _pixel_targets(self, frame: Frame, window: WindowDef):
        return self._targets_from_cells(expand_cells(window), frame)

    def _anchor_region(self, window: WindowDef, fields: dict[str, FieldDef]):
        """The field whose column drives row detection: the first text field (names
        are one-per-row and densest), else the first region."""
        for r in window.regions:
            fd = fields.get(r.field)
            if fd is not None and fd.type is FieldType.text:
                return r
        return window.regions[0] if window.regions else None

    def _detect_rows(self, frame: Frame, window: WindowDef, fields: dict[str, FieldDef],
                     lines: list[OcrLine]) -> list[Cell]:
        """Cells for the rows actually present in this frame (on-the-fly grid).

        Rows are found from the OCR lines in the ANCHOR field's column only — using
        every field's lines would merge a row's name and count (which sit at
        different heights) into one band and misalign the boxes. The configured row
        count/stride is only a hint (expected pitch + upper bound). Returns ``[]`` so
        the caller falls back to the static grid when nothing is detected."""
        sc = window.scroll if (window.scroll and window.scroll.enabled) else None
        anchor = self._anchor_region(window, fields)
        if anchor is None:
            return []
        da = window.data_area.to_fraction()
        ab = anchor.box.to_fraction()
        cw, ch = frame.client.w, frame.client.h
        lo, hi = da.y, da.y + da.h
        ax0, ax1 = ab.x, ab.x + ab.w   # anchor column (col 0) x-range, fractions

        centers, heights = [], []
        for ln in lines:
            cx = (ln.box.x + ln.box.w / 2) / cw
            if ax0 <= cx <= ax1:
                centers.append((ln.box.y + ln.box.h / 2) / ch)
                heights.append(ln.box.h / ch)
        cap = max(1, (sc.rows or 1)) + 2  # the hint is a guide, not a hard limit
        row_ys = detect_row_centers(centers, heights, sc.row_stride, lo, hi, cap)
        return cells_for_rows(window, row_ys, ab.y + ab.h / 2)

    def _resolve_cells(self, frame: Frame, window: WindowDef, fields: dict[str, FieldDef]):
        """Decide the grid cells for this frame and run the single OCR pass.

        When the window is a scrollable grid with a data area, the rows are detected
        live from the OCR content; otherwise the static authored grid is used."""
        clip = self._clip(frame, window)
        # Item templates: locate instances by content + tells (preferred over the grid).
        if window.items and window.data_area is not None:
            lines = self._ocr_union(frame, [], window.preprocess, clip)
            cw, ch = frame.client.w, frame.client.h
            # carry text + confidence so the row locator can reject badges (numbers)
            # and OCR garbage (low confidence) instead of clustering them as rows
            lf = [((ln.box.x + ln.box.w / 2) / cw, (ln.box.y + ln.box.h / 2) / ch, ln.box.h / ch,
                   ln.text, ln.confidence) for ln in lines]
            anchors = {it.id: self._item_anchor(it) for it in window.items if locator_of(it)}
            ics = locate_item_cells(frame, window, lf, self._templates, anchors)
            return [ic.cell for ic in ics], lines, ics

        sc = window.scroll if (window.scroll and window.scroll.enabled) else None
        dynamic = sc is not None and window.data_area is not None and (sc.rows or 1) > 1 and bool(window.regions)
        if dynamic:
            # OCR the whole data area first (clip bounds the crop), then place rows.
            lines = self._ocr_union(frame, [], window.preprocess, clip)
            cells = self._detect_rows(frame, window, fields, lines) or expand_cells(window)
            return cells, lines, None

        cells = expand_cells(window)
        targets = self._targets_from_cells(cells, frame)
        text_boxes = [b for _, fid, b in targets if not self._is_pip(fields.get(fid))]
        lines = self._ocr_union(frame, text_boxes, window.preprocess, clip)
        return cells, lines, None

    def _item_anchor(self, item) -> float:
        """Cell-relative y the row anchor should align to: where the locator's TEXT
        actually sits in the frozen cutout. The tell box is usually drawn loosely
        around the name, so its centre is above the real text — anchoring on the
        centre drops the cell low. OCR the cutout once to find the true position so
        every field box lands exactly where it was defined."""
        loc = locator_of(item)
        fallback = (loc.box.y + loc.box.h / 2) if loc else 0.5
        if item.id in self._anchor_cache:
            return self._anchor_cache[item.id]
        ref = fallback
        cut = self._cutouts.get(item.id)
        cb, ib = item.cutout_box, item.box
        if cut is not None and cut.size and cb is not None and cb.w > 0 and cb.h > 0 and loc is not None:
            ch, cw = cut.shape[:2]
            # locator region: cell-relative -> window -> cutout fraction -> pixels
            wx, wy = ib.x + loc.box.x * ib.w, ib.y + loc.box.y * ib.h
            ww, wh = loc.box.w * ib.w, loc.box.h * ib.h
            x0, y0 = (wx - cb.x) / cb.w, (wy - cb.y) / cb.h
            x1, y1 = x0 + ww / cb.w, y0 + wh / cb.h
            px0, py0 = max(0, int(x0 * cw)), max(0, int(y0 * ch))
            px1, py1 = min(cw, int(x1 * cw)), min(ch, int(y1 * ch))
            crop = cut[py0:py1, px0:px1]
            ls = self._ocr.read_image(crop) if crop.size else []
            ls = [ln for ln in ls if any(c.isalpha() for c in ln.text)]   # the name, not a badge
            if ls:
                # match the live row anchor: bottommost / topmost / mean line
                align = anchor_align(item)
                if align == "bottom":
                    cy_cut = max((py0 + ln.box.y + ln.box.h / 2) / ch for ln in ls)
                elif align == "top":
                    cy_cut = min((py0 + ln.box.y) / ch for ln in ls)
                else:
                    cy_cut = sum((py0 + ln.box.y + ln.box.h / 2) / ch for ln in ls) / len(ls)
                wy_text = cb.y + cy_cut * cb.h                                             # window frac
                ref = (wy_text - ib.y) / ib.h                                              # cell-relative
        self._anchor_cache[item.id] = ref
        return ref

    # ---- public reads ------------------------------------------------------

    @staticmethod
    def _is_pip(fdef: FieldDef | None) -> bool:
        # "visual count" fields aren't OCR'd — they're counted from pixels
        return fdef is not None and fdef.type in (FieldType.pips, FieldType.diamonds)

    def _pip_value(self, frame: Frame, box: PixelBox, fdef: FieldDef | None = None) -> int:
        crop = frame.image[box.y : box.y + box.h, box.x : box.x + box.w]
        if fdef is not None and fdef.type is FieldType.diamonds:
            return count_filled_diamonds(crop)
        return count_pips(crop)

    def _clip(self, frame: Frame, window: WindowDef) -> PixelBox | None:
        if window.data_area is None:
            return None
        return window.data_area.to_fraction().to_pixels(frame.client.w, frame.client.h)

    def read(self, frame: Frame, window: WindowDef, fields: dict[str, FieldDef]) -> list[Record]:
        cells, lines, ics = self._resolve_cells(frame, window, fields)
        targets = self._targets_from_cells(cells, frame)
        n_cells = len(cells)
        records = [Record() for _ in range(n_cells)]
        worst = [1.0] * n_cells
        saw = [False] * n_cells

        # first gather every field from the single detection pass; queue the item-field
        # boxes it missed, then read them all in ONE batched recognition pass
        base, pending = {}, []
        for ci, field_id, box in targets:
            if self._is_pip(fields.get(field_id)):
                continue
            tc = self._gather(lines, box)
            base[(ci, field_id)] = tc
            if not tc[0] and ics is not None:
                pending.append(((ci, field_id), box))
        focus = self._focus_reads(frame, window, pending) if pending else {}

        for ci, field_id, box in targets:
            fdef = fields.get(field_id)
            rec = records[ci]
            if self._is_pip(fdef):
                rec.values[field_id] = self._pip_value(frame, box, fdef)
                saw[ci] = True
                continue
            text, conf = focus.get((ci, field_id)) or base[(ci, field_id)]
            if text:
                saw[ci] = True
                worst[ci] = min(worst[ci], conf)
            if self._resolver and fdef:
                resolved = self._resolver.resolve(fdef, text, conf)
                rec.values[field_id] = resolved.value
                if resolved.corrected:
                    rec.corrected.append(field_id)
            else:
                rec.values[field_id] = coerce(fdef, text) if fdef else (text or None)

        for ci, rec in enumerate(records):
            rec.confidence = worst[ci] if saw[ci] else 0.0
        if ics is None:
            return [r for r in records if not r.is_empty()]
        # Item templates: keep a cell only if all its tells pass (drops popups/empties);
        # resolve template overlaps; and (when >1 template) tag which one matched.
        valid = [ci for ci, r in enumerate(records)
                 if not r.is_empty() and valid_cell(frame, window, r.values, ics[ci], self._templates, fields)]
        kept = resolve_overlaps(ics, valid)
        tag = len(window.items) > 1
        for ci in kept:
            if tag:
                records[ci].values["_item"] = ics[ci].item.id
        return [records[ci] for ci in kept]

    def region_signature(self, frame: Frame, window: WindowDef) -> int | None:
        """Cheap hash of the grid region's pixels, to detect an unchanged view.

        Downsamples the union crop so the cost is negligible next to OCR; lets the
        collector skip re-OCR while the user isn't scrolling/changing the screen.
        """
        targets = self._pixel_targets(frame, window)
        if not targets:
            return None
        u = _union([b for _, _, b in targets])
        crop = frame.image[u.y : u.y + u.h, u.x : u.x + u.w]
        sy = max(1, u.h // 48)
        sx = max(1, u.w // 48)
        return hash(crop[::sy, ::sx].tobytes())

    def read_preview(self, frame: Frame, window: WindowDef, fields: dict[str, FieldDef]) -> dict:
        """Teaching preview from ONE OCR pass. Returns:
        - ``cells``: per cell, raw text + extracted value + confidence per field
        - ``detections``: every raw OCR line (text, box as client fractions, conf),
          i.e. exactly what OCR found and where, independent of the region boxes.
        """
        cells, lines, ics = self._resolve_cells(frame, window, fields)
        targets = self._targets_from_cells(cells, frame)
        cw, ch = frame.client.w, frame.client.h

        base, pending = {}, []   # gather from the detection pass; batch what it missed
        for ci, field_id, box in targets:
            if self._is_pip(fields.get(field_id)):
                continue
            tc = self._gather(lines, box)
            base[(ci, field_id)] = tc
            if not tc[0] and ics is not None:
                pending.append(((ci, field_id), box))
        focus = self._focus_reads(frame, window, pending) if pending else {}

        out = [{"row": c.row, "col": c.col, "fields": {}} for c in cells]
        for ci, field_id, box in targets:
            fdef = fields.get(field_id)
            def asfrac(b):
                return {"x": b.x / cw, "y": b.y / ch, "w": b.w / cw, "h": b.h / ch}
            if self._is_pip(fdef):
                cnt = self._pip_value(frame, box, fdef)
                unit = "filled" if fdef.type is FieldType.diamonds else "pips"
                out[ci]["fields"][field_id] = {"raw": f"{cnt} {unit}", "value": cnt, "confidence": 0.99, "box": asfrac(box)}
                continue
            text, conf = focus.get((ci, field_id)) or base[(ci, field_id)]
            # apply the resolver (dictionary snap, read-only) when one is set, so the
            # preview shows the same value the collector would; else just coerce.
            if self._resolver and fdef:
                resolved = self._resolver.resolve(fdef, text, conf)
                value, rule = resolved.value, resolved.substituted
            elif fdef:
                value, rule = coerce_rule(fdef, text)
            else:
                value, rule = text or None, None
            # the box is shown where it was DEFINED (cell-relative), not snapped to data
            out[ci]["fields"][field_id] = {"raw": text, "value": value, "confidence": round(conf, 3),
                                           "substituted": rule, "box": asfrac(box)}

        # mark which cells survive (tells pass AND win overlap resolution), record which
        # template matched, and attach per-tell diagnostics + the reject reason so the
        # UI shows exactly why each cell is kept or dropped
        if ics is not None:
            valid = []
            for ci, cell in enumerate(out):
                cell["item"] = ics[ci].item.id
                # the located cell's rect (window fractions) so the UI can centre
                # cell-level labels (e.g. the item's name) on the tile
                cell["box"] = {"x": ics[ci].ox, "y": ics[ci].oy, "w": ics[ci].iw, "h": ics[ci].ih}
                vals = {fid: f.get("value") for fid, f in cell["fields"].items()}
                confs = {fid: f.get("confidence") for fid, f in cell["fields"].items()}
                rep = tell_report(frame, vals, ics[ci], self._templates, confs, fields)
                cell["tells"] = rep
                cell["tells_pass"] = all(r["pass"] for r in rep)
                if cell["tells_pass"]:
                    valid.append(ci)
            kept = set(resolve_overlaps(ics, valid))
            for ci, cell in enumerate(out):
                cell["valid"] = ci in kept
                if ci in valid and ci not in kept:
                    cell["reason"] = "overlap: lost to higher-priority template"
                elif not cell["tells_pass"]:
                    failed = [r["id"] for r in cell["tells"] if not r["pass"]]
                    cell["reason"] = "tell failed: " + ", ".join(failed)

        detections = [
            {
                "text": ln.text,
                "confidence": round(ln.confidence, 3),
                "box": {"x": ln.box.x / cw, "y": ln.box.y / ch, "w": ln.box.w / cw, "h": ln.box.h / ch},
            }
            for ln in lines
        ]
        return {"cells": out, "detections": detections}
