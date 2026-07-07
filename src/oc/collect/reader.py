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
from ..profile.models import FieldDef, FieldType, ItemDef, Preprocess, TellKind, WindowDef
from ..types import FractionBox, Frame, OcrLine, PixelBox
from .fields import run_rules
from .grid import Cell, cells_for_rows, expand_cells
from .items import (
    ItemCell,
    cell_cover,
    cell_occluded,
    grid_drift,
    locate_item_cells,
    resolve_overlaps,
    tell_report,
    valid_cell,
)
from .pips import count_filled_diamonds, count_pips
from .preprocess import apply as apply_preprocess
from .rows import fit_row_lattice

_MIN_OCR_H = 96   # focused field crops shorter than this are upscaled before OCR


@dataclass
class Record:
    values: dict[str, object] = dc_field(default_factory=dict)
    confidence: float = 1.0
    corrected: list[str] = dc_field(default_factory=list)
    # {field_id: raw OCR text} for genuine text reads — carried purely for the live debug
    # log (what OCR saw before resolve). Empty for pip fields / fallback-fired fields.
    raw: dict[str, str] = dc_field(default_factory=dict)
    # Position of this record's cell as fractions (0..1) of the window's data_area: ``ypos``
    # vertical (0 = top of the visible list, 1 = bottom), ``xpos`` horizontal (0 = left col,
    # 1 = right col). Lets a scrolling consumer place a row in the grid — ypos + the scrollbar
    # give a scroll-invariant list position, xpos pins the column. None when no data_area.
    ypos: float | None = None
    xpos: float | None = None
    # The cell's DISCRETE column index (0..cols-1) as the grid built it — content-clustered for
    # item windows, authored for static grids. Unlike ``xpos`` (a continuous centre fraction that
    # jitters) this is stable frame-to-frame, so it's the mirror slot's column identity. None when
    # no cell/grid produced it.
    col: int | None = None

    def is_empty(self) -> bool:
        return all(v in (None, "") for v in self.values.values())


@dataclass
class _FieldRead:
    """One field's read in a cell — everything both the collector and the preview need."""
    raw: str | None              # the raw OCR text (None for pip fields)
    conf: float
    value: object                # extracted/resolved value
    substituted: object          # a ``set`` rule's ``when`` label, else None (None => a genuine read)
    dropped: bool                # a ``drop`` rule (range/dictionary/authored) fired -> drop the cell
    box: PixelBox                # where the field was read (image pixels)
    pip_unit: str | None = None  # "pips"/"filled" for visual-count fields, else None
    verified: str | None = None  # how the value was confirmed: dict/split/fuzzy/glyph, else None


@dataclass
class _CellRead:
    """One cell read from a single OCR pass — the shared product of :meth:`RegionReader._read_cells`
    that both :meth:`read` (collection) and :meth:`read_preview` (teaching UI) are built on, so
    the two can never drift apart (CLAUDE.md rule 7)."""
    values: dict[str, object] = dc_field(default_factory=dict)
    corrected: list[str] = dc_field(default_factory=list)
    confidence: float = 0.0      # worst genuine-read field conf (0 if nothing seen)
    saw: bool = False            # any field produced text
    failed: bool = False         # a field tripped its min_confidence or plausibility range
    confs: dict[str, float] = dc_field(default_factory=dict)        # field_id -> conf (seen text only)
    fields: dict[str, _FieldRead] = dc_field(default_factory=dict)  # field_id -> read detail

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
    def __init__(self, ocr: OcrEngine, resolver=None, templates=None, glyphs=None) -> None:
        self._ocr = ocr
        self._resolver = resolver
        # {tell_id: image} for ``template`` tells; loaded by the caller (knows the
        # profile dir). None/absent -> template tells score 0.
        self._templates = templates or {}
        # Optional GlyphMatcher (taught glyph atlas) for post-OCR glyph refinement on
        # ``glyph_check`` fields. None -> refinement skipped.
        self._glyphs = glyphs

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
        # reading order, not bare x-order: a wrapped name's second line often starts
        # left of the first, so sorting by x alone scrambles it ("Empowered Cascadia").
        # Cluster into visual lines (a hit joins the current line while its centre is
        # inside that line's vertical extent), top-to-bottom, then x within each line.
        hits.sort(key=lambda ln: ln.box.y + ln.box.h / 2)
        rows: list[list[OcrLine]] = [[hits[0]]]
        for ln in hits[1:]:
            if ln.box.y + ln.box.h / 2 <= max(h.box.bottom for h in rows[-1]):
                rows[-1].append(ln)
            else:
                rows.append([ln])
        ordered = [ln for row in rows for ln in sorted(row, key=lambda ln: ln.box.x)]
        text = " ".join(ln.text for ln in ordered).strip()
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

    def _detect_reads(self, frame: Frame, window: WindowDef,
                      pending: list[tuple]) -> dict:
        """Detection+recognition read of each box -> {key: (text, conf)}, OMITTING boxes
        where the detector found no text. Unlike ``_focus_reads`` (recognition-only, whose
        rec head ALWAYS emits a string — it hallucinates a value on a blank crop), this
        gates on detection: an EMPTY box yields nothing, so a legitimately-absent readout
        (an ability off cooldown, a cleared counter) produces no phantom reading. This is
        exactly what the window's raw-OCR layer shows, since both run detection."""
        out = {}
        for key, box in pending:
            if box.w <= 0 or box.h <= 0:
                continue
            crop = frame.image[box.y : box.y + box.h, box.x : box.x + box.w]
            if crop.size == 0:
                continue
            if window.preprocess is not None:
                crop = apply_preprocess(crop, window.preprocess)
            # NO tiny-crop upscale here (unlike _box_crop): upscaling amplifies faint
            # noise/edges until the detector fires on a blank box and the rec head reads a
            # phantom value. Native res keeps this read as sensitive as the window's raw-OCR
            # layer — so an empty box reads empty in both, not just the raw layer.
            lines = self._ocr.read_image(crop)
            if not lines:
                continue
            lines.sort(key=lambda ln: (ln.box.y + ln.box.h / 2, ln.box.x))
            text = " ".join(ln.text for ln in lines).strip()
            if not text:
                continue
            conf = sum(ln.confidence for ln in lines) / len(lines)
            out[key] = (text, conf)
        return out

    def _read_tell_boxes(self, frame: Frame, window: WindowDef, ic) -> dict:
        """OCR each FIELDLESS ``text`` tell's own box (cell-relative) -> {tell_id:(text,conf)}.
        A text tell bound to a field reuses that field's read for free; a fieldless one has
        nothing to reuse, so we read its own box directly (recognition-only, batched through
        ``_focus_reads``). Returns {} when the item has no such tell -> zero extra OCR."""
        pending = []
        for t in ic.item.tells:
            if t.kind is not TellKind.text or t.field:
                continue
            fb = FractionBox(ic.ox + t.box.x * ic.iw, ic.oy + t.box.y * ic.ih,
                             t.box.w * ic.iw, t.box.h * ic.ih)
            pending.append((t.id, fb.to_pixels(frame.client.w, frame.client.h)))
        return self._focus_reads(frame, window, pending) if pending else {}

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
        row_ys = fit_row_lattice(centers, heights, sc.row_stride, lo, hi, cap,
                                 pitch_tol=sc.pitch_tolerance)
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
            # carry the line's LEFT edge + width too, so columns can be anchored on content
            # (align_x) instead of tiled geometrically — immune to blank data-area margins.
            lf = [((ln.box.x + ln.box.w / 2) / cw, (ln.box.y + ln.box.h / 2) / ch, ln.box.h / ch,
                   ln.text, ln.confidence, ln.box.x / cw, ln.box.w / cw) for ln in lines]
            ics = locate_item_cells(frame, window, lf, self._templates)
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
        # No data area set yet: nothing to clip to and maybe no taught boxes at all, so OCR the
        # WHOLE canvas — the raw-OCR layer then shows every line the engine found (field reads are
        # unaffected: _gather still assigns lines by their box). clip is None iff data_area is None.
        if clip is None:
            ih, iw = frame.image.shape[:2]
            clip = PixelBox(0, 0, iw, ih)
        lines = self._ocr_union(frame, text_boxes, window.preprocess, clip)
        return cells, lines, None

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

    @staticmethod
    def _data_yfrac(window: WindowDef, cy: float) -> float | None:
        """A cell-centre's window-fraction y mapped to 0..1 within the data_area (top..bottom).
        None when no data_area is configured (then a row has no list position)."""
        da = window.data_area
        if da is None or not da.h:
            return None
        return min(1.0, max(0.0, (cy - da.y) / da.h))

    @staticmethod
    def _data_xfrac(window: WindowDef, cx: float) -> float | None:
        """A cell-centre's window-fraction x mapped to 0..1 within the data_area (left..right)."""
        da = window.data_area
        if da is None or not da.w:
            return None
        return min(1.0, max(0.0, (cx - da.x) / da.w))

    def _read_cells(self, frame: Frame, window: WindowDef, fields: dict[str, FieldDef]):
        """The SINGLE read core both collection (:meth:`read`) and the teaching preview
        (:meth:`read_preview`) are built on, so they can never diverge (CLAUDE.md rule 7).

        Locates the cells, runs ONE OCR pass (plus a batched focus-read of the boxes it
        missed), resolves every field, and returns ``(cells, lines, ics, [_CellRead])`` — the
        raw read with confidence/flags/per-field detail. Neither gating nor presentation
        happens here; each caller layers its own on top.
        """
        cells, lines, ics = self._resolve_cells(frame, window, fields)
        targets = self._targets_from_cells(cells, frame)
        n = len(cells)
        cr = [_CellRead() for _ in range(n)]

        # gather every field from the single detection pass; queue the boxes it missed, then
        # read them all in ONE batched recognition pass.
        base, pending = {}, []
        for ci, field_id, box in targets:
            fdef = fields.get(field_id)
            if self._is_pip(fdef):
                continue
            tc = self._gather(lines, box)
            base[(ci, field_id)] = tc
            # isolate: always crop-read this box alone; else focus-read only the misses
            if (fdef and fdef.isolate) or (not tc[0] and ics is not None):
                pending.append(((ci, field_id), box))
        focus = self._focus_reads(frame, window, pending) if pending else {}

        worst = [1.0] * n
        for ci, field_id, box in targets:
            fdef = fields.get(field_id)
            c = cr[ci]
            if self._is_pip(fdef):
                cnt = self._pip_value(frame, box, fdef)
                unit = "filled" if fdef.type is FieldType.diamonds else "pips"
                c.values[field_id] = cnt
                c.saw = True
                c.fields[field_id] = _FieldRead(raw=f"{cnt} {unit}", conf=0.99, value=cnt,
                                                substituted=None, dropped=False, box=box,
                                                pip_unit=unit)
                continue
            text, conf = focus.get((ci, field_id)) or base[(ci, field_id)]
            raw_ocr = text   # the genuine OCR read, kept so the UI can show the ORIGINAL vs value
            # Post-OCR glyph refinement (runs BEFORE resolve, so the dictionary then sees the
            # corrected glyphs). Matches this box's pixels against the taught atlas — fixes a
            # Q<->G-class confusion the dictionary can't, since both readings are valid terms.
            refined = False
            if text and self._glyphs is not None and fdef and getattr(fdef, "glyph_check", False):
                gcrop = frame.image[box.y : box.y + box.h, box.x : box.x + box.w]
                new = self._glyphs.refine(text, gcrop)
                refined = new != text
                text = new
            substituted = verified = None
            dropped = False
            if self._resolver and fdef:
                resolved = self._resolver.resolve(fdef, text, conf)
                value = resolved.value
                substituted = resolved.substituted
                verified = resolved.verified
                dropped = resolved.dropped
                if resolved.corrected:
                    c.corrected.append(field_id)
            elif fdef:
                res = run_rules(fdef, text)
                value, substituted, dropped = res.value, res.substituted, res.dropped
            else:
                value = text or None
            # a pixel-level glyph_check that actually changed the read is the salient tell for
            # these fields — surface "glyph" over the dictionary's own verdict
            if refined and substituted is None:
                verified = "glyph"
            c.values[field_id] = value
            c.fields[field_id] = _FieldRead(raw=raw_ocr, conf=conf, value=value,
                                            substituted=substituted, dropped=dropped, box=box,
                                            verified=verified)
            if dropped:   # a drop rule (range/dictionary/authored) drops the whole cell
                c.failed = True
            if text:
                c.saw = True
                c.confs[field_id] = conf   # so a field-tell's tell_conf can gate
                if substituted is None and not dropped:
                    # garbage OCR that triggered a fallback must not sink the whole record
                    worst[ci] = min(worst[ci], conf)
                    mc = getattr(fdef, "min_confidence", 0.0) or 0.0
                    if mc and conf < mc:
                        c.failed = True
        for ci, c in enumerate(cr):
            c.confidence = worst[ci] if c.saw else 0.0
        return cells, lines, ics, cr

    def read(self, frame: Frame, window: WindowDef,
             fields: dict[str, FieldDef]) -> tuple[list[Record], float | None]:
        cells, lines, ics, cr = self._read_cells(frame, window, fields)
        records: list[Record] = []
        for ci, c in enumerate(cr):
            rec = Record(values=dict(c.values), confidence=c.confidence, corrected=list(c.corrected),
                         raw={fid: fr.raw for fid, fr in c.fields.items() if fr.raw})
            # Position of the cell within the data_area, so a scrolling consumer can place this
            # row in the grid. Item cells carry their origin/size; a static grid cell takes the
            # mean centre of its field boxes.
            rec.col = cells[ci].col   # discrete column index the grid assigned (stable slot identity)
            if ics is not None:
                rec.ypos = self._data_yfrac(window, ics[ci].oy + ics[ci].ih / 2)
                rec.xpos = self._data_xfrac(window, ics[ci].ox + ics[ci].iw / 2)
            else:
                bs = list(cells[ci].boxes.values())
                if bs:
                    rec.ypos = self._data_yfrac(window, sum(b.y + b.h / 2 for b in bs) / len(bs))
                    rec.xpos = self._data_xfrac(window, sum(b.x + b.w / 2 for b in bs) / len(bs))
            records.append(rec)
        if ics is None:
            return ([r for ci, r in enumerate(records) if not r.is_empty() and not cr[ci].failed], None)
        # Item templates: keep a cell only if all its tells pass (drops popups/empties);
        # resolve template overlaps; and (when >1 template) tag which one matched.
        # A GUARD item (no fields, but has tells — e.g. a "no relic selected" placeholder)
        # carries no data, so its record is empty; include it in overlap resolution anyway
        # (on its tells alone) so it can SUPPRESS a higher-or-equal cell that would otherwise
        # misread the placeholder. It is dropped from the stored output below — it exists to
        # win the tile, not to be saved.
        # a cell the scroll has occluded past its item's min coverage is dismissed before storage
        da = window.data_area.to_fraction()
        valid = [ci for ci, c in enumerate(cr)
                 if not c.failed
                 and not cell_occluded(ics[ci], da)
                 and (not records[ci].is_empty() or (not ics[ci].item.fields and ics[ci].item.tells))
                 and valid_cell(frame, window, records[ci].values, ics[ci], self._templates, fields,
                                c.confs, self._read_tell_boxes(frame, window, ics[ci]))]
        kept = resolve_overlaps(ics, valid)
        tag = len(window.items) > 1
        out = []
        # A terminator template marks the end of the real list: report the top-most kept
        # terminator's viewport position so the collector can cut everything below it. A
        # terminator is usually a fieldless guard (stores nothing) but need not be.
        sentinel_ypos: float | None = None
        for ci in kept:
            it = ics[ci].item
            if it.terminator and records[ci].ypos is not None:
                sentinel_ypos = records[ci].ypos if sentinel_ypos is None else min(sentinel_ypos, records[ci].ypos)
            if not it.fields:   # guard item -> suppressed the tile, stores nothing
                continue
            if tag:
                records[ci].values["_item"] = it.id
            out.append(records[ci])
        return out, sentinel_ypos

    def read_readouts(self, frame: Frame, window: WindowDef,
                      fields: dict[str, FieldDef]) -> dict[str, object]:
        """Read the window's live, non-persisted readouts (health, a buff counter) ->
        ``{readout_id: value}`` — the scalar map triggers/toasts consume. Thin wrapper over
        :meth:`read_readouts_detailed` (drops the confidence)."""
        return {k: value for k, (value, _conf) in
                self.read_readouts_detailed(frame, window, fields).items()}

    def read_readouts_detailed(self, frame: Frame, window: WindowDef,
                               fields: dict[str, FieldDef]) -> dict[str, tuple[object, float]]:
        """Read the window's readouts -> ``{readout_id: (value, confidence)}``. Each reads its
        box through the linked field, exactly like a region.

        A read that fails its field's plausibility gate (min confidence / out of range) or
        yields nothing is OMITTED — a trigger must never fire on a garbage/occluded reading.
        The confidence is the raw OCR confidence of the read (1.0 for a deterministic pip/bar
        value). Nothing here is stored; the collector surfaces the values and hands them to
        triggers, and the UI shows ``value (conf)`` on each readout node.
        """
        out: dict[str, tuple[object, float]] = {}
        cw, ch = frame.client.w, frame.client.h
        for v in window.readouts:
            if not v.enabled:
                continue
            box = v.box.to_fraction().to_pixels(cw, ch)
            fdef = fields.get(v.field)
            if self._is_pip(fdef):
                out[v.id] = (self._pip_value(frame, box, fdef), 1.0)
                continue
            text, conf = self._detect_reads(frame, window, [(v.id, box)]).get(v.id) or ("", 0.0)
            substituted, dropped = None, False
            if self._resolver and fdef:
                resolved = self._resolver.resolve(fdef, text, conf)
                value, substituted, dropped = resolved.value, resolved.substituted, resolved.dropped
            elif fdef:
                res = run_rules(fdef, text)
                value, substituted, dropped = res.value, res.substituted, res.dropped
            else:
                value = text or None
            if value is None or dropped:   # nothing read, or a drop rule rejected it
                continue
            # a genuine read must clear the field's confidence floor
            if substituted is None and fdef:
                mc = getattr(fdef, "min_confidence", 0.0) or 0.0
                if mc and conf < mc:
                    continue
            out[v.id] = (value, conf)
        return out

    def representative_raws(self, frame: Frame, window: WindowDef,
                            fields: dict[str, FieldDef]) -> dict[str, tuple[str, float]]:
        """One representative RAW read for EVERY field, from a SINGLE OCR pass — the batch
        behind the field nodes' rule-trace panels. All the window's readout boxes read in
        one focus pass and all region/grid fields come off ONE ``_read_cells`` pass, so the
        whole node fleet's traces cost one window read instead of one read per field. A
        readout field reads its own box; a region/grid field uses the first cell that read
        it (else its first cell). Returns ``{field_id: (text, conf)}`` (fields never read
        are omitted; the caller defaults them)."""
        cw, ch = frame.client.w, frame.client.h
        out: dict[str, tuple[str, float]] = {}
        # readouts: detection-gated read of every enabled readout box (NOT recognition-only —
        # a blank box must read as empty, not a hallucinated value; see _detect_reads)
        ro_boxes = [(v.id, v.box.to_fraction().to_pixels(cw, ch)) for v in window.readouts if v.enabled]
        ro_reads = self._detect_reads(frame, window, ro_boxes) if ro_boxes else {}
        for v in window.readouts:
            if v.enabled and v.field in fields and v.field not in out:
                out[v.field] = ro_reads.get(v.id) or ("", 0.0)
        # region/grid fields: ONE cell pass, first non-empty read per field (else its first cell)
        if any(fid not in out for fid in fields):
            _, _, _, cr = self._read_cells(frame, window, fields)
            for fid in fields:
                if fid in out:
                    continue
                fallback: tuple[str, float] | None = None
                for c in cr:
                    fr = c.fields.get(fid)
                    if fr is None:
                        continue
                    if fr.raw:
                        out[fid] = (fr.raw, fr.conf)
                        break
                    fallback = fallback or (fr.raw or "", fr.conf)
                else:
                    if fallback is not None:
                        out[fid] = fallback
        return out

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
        cells, lines, ics, cr = self._read_cells(frame, window, fields)
        cw, ch = frame.client.w, frame.client.h

        def asfrac(b):
            return {"x": b.x / cw, "y": b.y / ch, "w": b.w / cw, "h": b.h / ch}

        out = []
        for ci, c in enumerate(cr):
            flds: dict[str, dict] = {}
            for fid, fr in c.fields.items():
                d = {"raw": fr.raw, "value": fr.value, "confidence": round(fr.conf, 3),
                     "box": asfrac(fr.box)}
                if fr.pip_unit is None:
                    # a drop-ruled read stays VISIBLE in the preview (so the author sees the
                    # "81" misread) but flagged — the cell is dropped below, mirroring collection
                    d["substituted"] = fr.substituted
                    d["dropped"] = fr.dropped
                    d["verified"] = fr.verified   # dict/split/fuzzy/glyph, else None
                flds[fid] = d
            out.append({"row": cells[ci].row, "col": cells[ci].col, "fields": flds})

        # mark which cells survive (tells pass AND win overlap resolution), record which
        # template matched, and attach per-tell diagnostics + the reject reason so the
        # UI shows exactly why each cell is kept or dropped. Same gates and confidences as
        # ``read`` (both ride ``_read_cells``), so the preview is what collection would store.
        if ics is not None:
            da = window.data_area.to_fraction()
            valid = []
            for ci, cell in enumerate(out):
                cell["item"] = ics[ci].item.id
                # the located cell's rect (window fractions) so the UI can centre
                # cell-level labels (e.g. the item's name) on the tile
                cell["box"] = {"x": ics[ci].ox, "y": ics[ci].oy, "w": ics[ci].iw, "h": ics[ci].ih}
                vals = {fid: f.get("value") for fid, f in cell["fields"].items()}
                rep = tell_report(frame, vals, ics[ci], self._templates, cr[ci].confs, fields,
                                  self._read_tell_boxes(frame, window, ics[ci]))
                cell["tells"] = rep
                cell["tells_pass"] = all(r["pass"] for r in rep)
                # scroll-occlusion: how much of the cell sits inside the data area, and whether
                # that's below the item's required coverage (same gate as collection). Reported
                # so the canvas can mark a dismissed-by-occlusion cell distinctly.
                fx, fy = cell_cover(ics[ci], da)
                occ = cell_occluded(ics[ci], da)
                cell["cover"] = {"x": round(fx, 3), "y": round(fy, 3)}
                cell["occluded"] = occ
                if occ:
                    ax, got, need = (("vert", fy, ics[ci].item.min_cover_y) if fy < ics[ci].item.min_cover_y
                                     else ("horiz", fx, ics[ci].item.min_cover_x))
                    cell["occ"] = f"{ax} {round(got * 100)}%"   # terse canvas label
                    cell["reason"] = f"occluded ({ax}): {round(got * 100)}% inside, need {round(need * 100)}%"
                # a drop-ruled field drops the cell too (same as collection) — record it as
                # the reject reason; it does not count as a tell failure
                drop_fids = [fid for fid, f in cell["fields"].items() if f.get("dropped")]
                if drop_fids and not occ:
                    cell["reason"] = "dropped by rule: " + ", ".join(drop_fids)
                if cell["tells_pass"] and not drop_fids and not occ:
                    valid.append(ci)
            kept = set(resolve_overlaps(ics, valid))
            for ci, cell in enumerate(out):
                cell["valid"] = ci in kept
                if ci in valid and ci not in kept:
                    cell["reason"] = "overlap: lost to higher-priority template"
                elif cell.get("occluded"):
                    pass   # keep the occlusion reason set above (it's the dismissal cause)
                elif not cell["tells_pass"]:
                    failed = [r["id"] for r in cell["tells"] if not r["pass"]]
                    cell["reason"] = "tell failed: " + ", ".join(failed)

        def _detection(ln):
            return {
                "text": ln.text,
                "confidence": round(ln.confidence, 3),
                "box": {"x": ln.box.x / cw, "y": ln.box.y / ch, "w": ln.box.w / cw, "h": ln.box.h / ch},
            }

        detections = [_detection(ln) for ln in lines]
        # The main read pass is clipped to the data area (items/regions tile there), so the raw-OCR
        # layer would go blank everywhere OUTSIDE it — including where the window's readout boxes
        # live. When there's a data area AND at least one readout, run ONE extra full-frame pass at
        # author time and add just the lines that fall outside the data area, so the raw layer covers
        # the readouts (and the UI can click-snap a readout box to a recognised line). Purely an
        # author-time preview aid: item location, stored reads, and live collection are untouched.
        if window.data_area is not None and any(v.enabled for v in window.readouts):
            da = self._clip(frame, window)
            ih, iw = frame.image.shape[:2]
            extra = self._ocr_union(frame, [], window.preprocess, PixelBox(0, 0, iw, ih))
            detections.extend(_detection(ln) for ln in extra if not _center_in(ln, da))
        result = {"cells": out, "detections": detections}
        if ics is not None:                       # located grid: how far cells drift off content
            result["drift"] = grid_drift(ics, lines, cw, ch)
        return result

    def read_cutout(self, cut, window: WindowDef, item: ItemDef, fields: dict[str, FieldDef]) -> dict:
        """Read ONE frozen item cutout as its authored cell and report what current
        settings extract from it: per-field raw/value/confidence + per-tell pass/score
        + overall validity. The cutout IS the cell, so fields read at their cell-relative
        offsets (mapped through ``cutout_box``) — no row locating is needed. Boxes come
        back in CUTOUT fractions so the item node can draw the read-outs over the crop.
        """
        h, w = cut.shape[:2]
        frame = Frame(image=cut, client=PixelBox(0, 0, w, h))
        cb, ib = item.cutout_box, item.box
        if cb is None or cb.w <= 0 or cb.h <= 0 or ib.w <= 0 or ib.h <= 0:
            return {"fields": {}, "tells": [], "valid": False, "cell": None}
        # cell origin/size in CUTOUT fractions: cell-relative -> window -> cutout fraction
        iw, ih = ib.w / cb.w, ib.h / cb.h
        ox, oy = (ib.x - cb.x) / cb.w, (ib.y - cb.y) / cb.h
        boxes = {
            f.field: FractionBox(ox + f.box.x * iw, oy + f.box.y * ih, f.box.w * iw, f.box.h * ih)
            for f in item.fields
        }
        ic = ItemCell(Cell(row=0, col=0, boxes=boxes), ox, oy, iw, ih, item)

        # one detection pass over the field boxes, then focus-read any it missed
        targets = [(fid, fb.to_pixels(w, h)) for fid, fb in boxes.items()]
        text_boxes = [b for fid, b in targets if not self._is_pip(fields.get(fid))]
        lines = self._ocr_union(frame, text_boxes, window.preprocess, None)
        base, pending = {}, []
        for fid, box in targets:
            fdef = fields.get(fid)
            if self._is_pip(fdef):
                continue
            tc = self._gather(lines, box)
            base[fid] = tc
            # isolate: always crop-read this box alone (item_read already focus-reads misses)
            if (fdef and fdef.isolate) or not tc[0]:
                pending.append((fid, box))
        focus = self._focus_reads(frame, window, pending) if pending else {}

        out_fields, vals, confs = {}, {}, {}
        for fid, box in targets:
            fdef = fields.get(fid)
            fb = boxes[fid]
            bf = {"x": fb.x, "y": fb.y, "w": fb.w, "h": fb.h}
            if self._is_pip(fdef):
                cnt = self._pip_value(frame, box, fdef)
                unit = "filled" if fdef.type is FieldType.diamonds else "pips"
                out_fields[fid] = {"raw": f"{cnt} {unit}", "value": cnt, "confidence": 0.99, "box": bf}
                vals[fid], confs[fid] = cnt, 0.99
                continue
            text, conf = focus.get(fid) or base[fid]
            verified, dropped = None, False
            if self._resolver and fdef:
                resolved = self._resolver.resolve(fdef, text, conf)
                value, rule = resolved.value, resolved.substituted
                verified = resolved.verified
                dropped = resolved.dropped
            elif fdef:
                res = run_rules(fdef, text)
                value, rule, dropped = res.value, res.substituted, res.dropped
            else:
                value, rule = text or None, None
            out_fields[fid] = {"raw": text, "value": value, "confidence": round(conf, 3),
                               "substituted": rule, "dropped": dropped, "box": bf,
                               "verified": verified}
            vals[fid], confs[fid] = value, conf

        tells = tell_report(frame, vals, ic, self._templates, confs, fields,
                            self._read_tell_boxes(frame, window, ic))
        return {"fields": out_fields, "tells": tells,
                "valid": all(t["pass"] for t in tells),
                "cell": {"x": ox, "y": oy, "w": iw, "h": ih}}
