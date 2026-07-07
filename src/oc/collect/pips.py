"""Count glowing pips/dots in a region (e.g. a Warframe mod's rank).

Some values aren't text: mod rank is a row of lit dots. OCR can't read that, so a
``pips`` field counts them from pixels instead.

Counting bright BLOBS (connected components) fails on the real strip: the pips are
strung along a thin, continuous glow LINE, so adjacent pips fuse into one component
(a maxed 10-pip strip read as ~4-6). Instead project the lit mask onto the x-axis as
a per-column VERTICAL THICKNESS: the thin line is a low baseline, each pip a tall
peak. Isolating the peaks (above the baseline) and counting the runs recovers the
count regardless of the connecting glow — the same pitch/row idea the diamonds
counter uses. No per-game count/spacing is baked in.
"""

from __future__ import annotations

import cv2
import numpy as np


def count_pips(image: np.ndarray, threshold: int | None = None, min_pip_h: int = 3) -> int:
    """Count lit rank pips in a BGR crop by column thickness (see module docstring).

    ``threshold`` is the brightness (max of BGR) a pixel must exceed to count as lit;
    ``None`` picks it relative to the crop's brightest pixel so a dim capture still
    reads. ``min_pip_h`` is the smallest pip height (px) — a crop whose tallest lit
    column is thinner than this is treated as bare line / noise (0 pips)."""
    if image is None or image.size == 0:
        return 0
    bright = image.max(axis=2)  # brightest channel per pixel
    top = int(bright.max())
    if top < 60:  # nothing lit
        return 0
    thr = threshold if threshold is not None else max(100, int(0.55 * top))
    mask = bright > thr
    if not mask.any():
        return 0
    # Focus on the pip ROW: the densest lit row ± H/3, so stray bright pixels above or
    # below it (a frame sliver, a neighbouring line) don't distort the projection.
    yc = int(mask.sum(axis=1).argmax())
    r = max(2, image.shape[0] // 3)
    colh = mask[max(0, yc - r): yc + r + 1, :].sum(axis=0).astype(int)  # thickness per column
    peak = int(colh.max())
    if peak < min_pip_h:  # only a thin line / noise — no pip peaks
        return 0
    # Columns riding a pip sit well above the bare-line baseline; 0.6·peak splits them
    # from the line (and from the dip between two adjacent pips).
    lit = colh >= max(min_pip_h, 0.6 * peak)
    widths: list[int] = []
    start: int | None = None
    for i, on in enumerate(np.append(lit, False)):
        if on and start is None:
            start = i
        elif not on and start is not None:
            widths.append(i - start)
            start = None
    if not widths:
        return 0
    # A run wider than one pip is fused neighbours — split it by the median pip width.
    w0 = float(np.median(widths))
    return sum(max(1, round(w / w0)) for w in widths)


def count_filled_diamonds(image: np.ndarray) -> int:
    """Count FILLED diamonds in a rank strip — a Warframe arcane's level: a row of ◇
    outlines that fill to ◆ as it ranks up. Locates EVERY diamond (filled or hollow,
    gold or dim — see :func:`_diamond_boxes`), so it reads an unranked arcane (5 marks,
    0 filled) just as well as a ranked one, then counts the ones whose INTERIOR is lit
    (a solid ◆) versus a dark hollow ◇."""
    if image is None or image.size == 0:
        return 0
    boxes = _diamond_boxes(image)
    if not boxes:
        return 0
    bright = image.max(axis=2)
    lit = max(60.0, 0.5 * float(bright.max()))              # an interior this bright = filled
    filled = 0
    for x, y, w, h in boxes:
        ix, iy = x + w // 4, y + h // 4                     # central core, clear of the outline
        core = bright[iy : iy + max(1, h // 2), ix : ix + max(1, w // 2)]
        if core.size and float(core.mean()) >= lit:
            filled += 1
    return filled


def _is_diamond_contour(approx: np.ndarray, w: int, h: int, area: float) -> bool:
    """A diamond is a square rotated ~45°: a convex 4-gon whose corners sit at the
    MIDPOINTS of its bounding-box edges (top, right, bottom, left), not at the corners.
    An axis-aligned square or a letter block has its 4-gon corners AT the bbox corners.
    Testing the vertex positions is rotation-specific and rejects text fragments.

    Round glyphs (e/o/c in a name like "Receiver") defeat the vertex test alone: a
    4-point approx of a round blob ALSO puts its vertices at the bbox edge midpoints.
    A diamond fills ~0.5 of its bbox while a disc fills ~0.79 and a block ~1.0, so the
    fill ratio is the discriminator that text shapes can't fake. ``area`` must be the
    ORIGINAL contour's area — the 4-gon approx of a disc is its inscribed square,
    whose area matches a diamond's exactly."""
    if len(approx) != 4 or not cv2.isContourConvex(approx) or w < 6 or h < 6:
        return False
    if not (0.6 <= w / h <= 1.7):
        return False
    if not (0.32 <= area / (w * h) <= 0.56):
        return False
    pts = approx.reshape(-1, 2).astype(float)
    cx, cy = pts[:, 0].mean(), pts[:, 1].mean()
    # two vertices on the vertical mid-line (top/bottom points), two on the horizontal
    on_vert = sum(1 for px, _py in pts if abs(px - cx) < 0.22 * w)
    on_horiz = sum(1 for _px, py in pts if abs(py - cy) < 0.22 * h)
    return on_vert == 2 and on_horiz == 2


def _rank_row(boxes: list[tuple[int, int, int, int]]) -> list[tuple[int, int, int, int]]:
    """Keep only the marks that form a rank ROW — ≥3 diamonds whose centres sit on one
    horizontal line at a near-uniform pitch. An arcane always shows its FULL strip
    (3 or 5 marks, filled or hollow), never a lone mark — so isolated diamond-ish blobs
    in icon art or glyph fragments (e.g. a sigil's emblem) that pass the contour test
    one-by-one still don't line up, and without this filter two strays were enough to
    call a plain item an arcane.

    A filled mark's contour hugs its lit core while a hollow mark's traces the outer
    ring, so sizes differ WITHIN one real strip — alignment uses centres, and the size
    gate is a loose band around the row's median height."""
    best: list[tuple[int, int, int, int]] = []
    for _x, y, _w, h in boxes:
        cy = y + h / 2
        row = [b for b in boxes if abs(b[1] + b[3] / 2 - cy) <= 0.5 * max(h, b[3])]
        med = sorted(b[3] for b in row)[len(row) // 2]
        row = [b for b in row if 0.4 * med <= b[3] <= 2.5 * med]
        if len(row) > len(best):
            best = row
    if len(best) < 3:
        return []
    xs = sorted(b[0] + b[2] / 2 for b in best)
    gaps = [b - a for a, b in zip(xs, xs[1:])]
    if max(gaps) > 2.2 * min(gaps):
        return []                                        # scattered, not a strip
    return best


def _diamond_boxes(image: np.ndarray, min_area: int = 20) -> list[tuple[int, int, int, int]]:
    """Locate every diamond MARK in a rank strip — filled OR hollow, ranked OR not —
    returning each as a bounding box ``(x, y, w, h)``.

    A ranked diamond glows gold but an UNRANKED one is a faint blue-grey outline barely
    above the dark backdrop — so we can't threshold on brightness or colour. Mark pixels
    brighter than their LOCAL surroundings (a high-pass), trace contours, and keep only
    rotated-square 4-gons (see :func:`_is_diamond_contour`). Nested ring contours
    (outer+inner of a hollow mark) are de-duplicated by centre, and the survivors
    must line up as a rank row (see :func:`_rank_row`) or none are returned."""
    if image is None or image.size == 0:
        return []
    gray = image.max(axis=2)
    k = max(9, (gray.shape[0] | 1))                      # blur window wider than a mark
    bg = cv2.blur(gray, (k, k))
    hp = gray.astype(np.int16) - bg.astype(np.int16)     # local contrast (outline vs backdrop)
    mask = (hp > 4).astype(np.uint8)
    cnts, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    boxes: list[tuple[int, int, int, int]] = []
    for c in cnts:
        area = cv2.contourArea(c)
        if area < min_area:
            continue
        approx = cv2.approxPolyDP(c, 0.08 * cv2.arcLength(c, True), True)
        x, y, w, h = cv2.boundingRect(approx)
        if not _is_diamond_contour(approx, w, h, area):
            continue
        cx, cy = x + w / 2, y + h / 2
        if any(abs(cx - (ox + ow / 2)) < (w + ow) * 0.3 and abs(cy - (oy + oh / 2)) < h * 0.5
               for ox, oy, ow, oh in boxes):
            continue                                     # same mark's other ring edge
        boxes.append((x, y, w, h))
    return _rank_row(boxes)


def count_diamonds(image: np.ndarray) -> int:
    """Count diamond SHAPES in a rank strip, filled OR hollow, ranked OR not — i.e.
    "is there a rank strip here at all?". Separates an arcane (a row of ◇/◆) from an
    item with none. See :func:`_diamond_boxes`."""
    return len(_diamond_boxes(image))
