"""Suggest a window's reading layout from a capture.

OCR the whole window, find the repeating grid of item names, and propose a name
region + grid (rows/cols/strides) + search area. The user reviews and tweaks — this
just removes the tedious manual box/stride work. Pure heuristic, no game knowledge.
"""

from __future__ import annotations

from collections import Counter
from statistics import median

from ..interfaces import OcrEngine
from ..types import Frame, OcrLine, PixelBox


def _name_like(line: OcrLine) -> bool:
    """A real item name: has letters and isn't a tiny numeric badge."""
    return sum(c.isalpha() for c in line.text) >= 3


def _cluster_rows(lines: list[OcrLine], gap: float) -> list[list[OcrLine]]:
    rows: list[list[OcrLine]] = []
    cur: list[OcrLine] = []
    prev_yc = None
    for ln in sorted(lines, key=lambda x: x.box.y + x.box.h / 2):
        yc = ln.box.y + ln.box.h / 2
        if prev_yc is not None and yc - prev_yc > gap:
            rows.append(cur)
            cur = []
        cur.append(ln)
        prev_yc = yc
    if cur:
        rows.append(cur)
    return rows


def _frac(box: PixelBox, cw: int, ch: int) -> dict:
    return {"x": box.x / cw, "y": box.y / ch, "w": box.w / cw, "h": box.h / ch}


def analyze(frame: Frame, ocr: OcrEngine, search: dict | None = None) -> dict:
    """Analyse the window (or just the ``search`` sub-area, fractions) for a grid."""
    cw, ch = frame.client.w, frame.client.h

    if search:
        sb = PixelBox(
            round(search["x"] * cw), round(search["y"] * ch),
            round(search["w"] * cw), round(search["h"] * ch),
        )
        crop = frame.image[sb.y : sb.y + sb.h, sb.x : sb.x + sb.w]
        raw = ocr.read_image(crop)
        lines = [
            OcrLine(ln.text, PixelBox(ln.box.x + sb.x, ln.box.y + sb.y, ln.box.w, ln.box.h), ln.confidence)
            for ln in raw
        ]
    else:
        lines = ocr.read_image(frame.image)

    names = [ln for ln in lines if _name_like(ln)]
    numbers = [ln for ln in lines if not _name_like(ln) and any(c.isdigit() for c in ln.text)]
    detections = [{"text": ln.text, "confidence": round(ln.confidence, 3), "box": _frac(ln.box, cw, ch)}
                  for ln in lines]
    if len(names) < 2:
        return {"ok": False, "reason": "not enough text found", "detections": detections}

    med_h = median(ln.box.h for ln in names)
    rows = _cluster_rows(names, gap=0.6 * med_h)

    # Drop header/outlier rows: keep rows whose column count is at least half the
    # modal count, so a lone "NAME" header row is excluded from the item grid.
    modal_cols = Counter(len(r) for r in rows).most_common(1)[0][0]
    keep = max(1, (modal_cols + 1) // 2)
    grid_rows = [r for r in rows if len(r) >= keep] or rows
    grid_names = [ln for r in grid_rows for ln in r]

    row_centers = [median(ln.box.y + ln.box.h / 2 for ln in r) for r in grid_rows]
    row_pitch = median(b - a for a, b in zip(row_centers, row_centers[1:])) if len(row_centers) > 1 else med_h * 1.3
    col_diffs: list[float] = []
    for r in grid_rows:
        xs = sorted(ln.box.x for ln in r)
        col_diffs += [b - a for a, b in zip(xs, xs[1:])]
    col_pitch = median(col_diffs) if col_diffs else median(ln.box.w for ln in grid_names) * 1.1

    cols = max(len(r) for r in grid_rows)
    n_rows = len(grid_rows)

    first = min(grid_names, key=lambda x: (x.box.y, x.box.x))
    cell_w = round(median(ln.box.w for ln in grid_names))
    region = PixelBox(first.box.x, first.box.y, cell_w, round(med_h * 1.2))

    # Search area = padded union of the grid's name boxes.
    x0 = min(ln.box.x for ln in grid_names)
    y0 = min(ln.box.y for ln in grid_names)
    x1 = max(ln.box.right for ln in grid_names)
    y1 = max(ln.box.bottom for ln in grid_names)
    search_box = PixelBox(x0, y0, x1 - x0, y1 - y0)

    parts = _suggest_number_parts(grid_names, numbers, first, col_pitch, row_pitch, cw, ch)

    row0 = sorted(grid_rows[0], key=lambda x: x.box.x)
    samples = [ln.text for ln in row0[:cols]]

    return {
        "ok": True,
        "search": _frac(search_box, cw, ch),
        "region": _frac(region, cw, ch),
        "parts": parts,
        "grid": {
            "rows": n_rows,
            "cols": cols,
            "row_stride": round(row_pitch / ch, 5),
            "col_stride": round(col_pitch / cw, 5),
        },
        "samples": samples,
        "detections": detections,
    }


def _suggest_number_parts(names, numbers, first, col_pitch, row_pitch, cw, ch) -> list[dict]:
    """Find numeric values that recur at a consistent spot in each cell (e.g. a
    count or rank) and propose a region for them, positioned in the first cell."""
    if not numbers:
        return []
    # Each number's offset from the nearest name's origin, if within one cell.
    offsets = []
    sizes = []
    for num in numbers:
        ncx, ncy = num.box.x + num.box.w / 2, num.box.y + num.box.h / 2
        best = min(names, key=lambda n: (n.box.x - ncx) ** 2 + (n.box.y - ncy) ** 2)
        dx, dy = num.box.x - best.box.x, num.box.y - best.box.y
        if -col_pitch * 0.5 <= dx <= col_pitch and -row_pitch * 0.5 <= dy <= row_pitch:
            offsets.append((round(dx / (col_pitch or 1), 1), round(dy / (row_pitch or 1), 1)))
            sizes.append((num.box.w, num.box.h, dx, dy))
    if not offsets:
        return []
    (key, support), = Counter(offsets).most_common(1)
    if support < max(2, len(names) // 4):  # must recur across many cells
        return []
    # Median real offset/size for the dominant cluster.
    members = [s for o, s in zip(offsets, sizes) if o == key]
    w = round(median(m[0] for m in members))
    h = round(median(m[1] for m in members))
    dx = round(median(m[2] for m in members))
    dy = round(median(m[3] for m in members))
    box = PixelBox(first.box.x + dx, first.box.y + dy, w, h)
    return [{"field": "count", "type": "number", "box": _frac(box, cw, ch)}]
