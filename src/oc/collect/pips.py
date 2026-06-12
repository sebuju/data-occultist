"""Count glowing pips/dots in a region (e.g. a Warframe mod's rank).

Some values aren't text: mod rank is a row of lit dots. OCR can't read that, so a
``pips`` field counts bright blobs instead. Heuristic and teachable-friendly:
threshold on brightness, then count connected components within a size range.
"""

from __future__ import annotations

import cv2
import numpy as np


def count_pips(image: np.ndarray, threshold: int = 170, min_area: int = 6, max_area_frac: float = 0.25) -> int:
    """Count bright blobs in a BGR crop. ``threshold`` is on the brightness (max of
    BGR); ``min_area`` filters noise; ``max_area_frac`` rejects big bright regions."""
    if image is None or image.size == 0:
        return 0
    bright = image.max(axis=2)  # brightest channel per pixel
    _, mask = cv2.threshold(bright, threshold, 255, cv2.THRESH_BINARY)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))

    n, _labels, stats, _centroids = cv2.connectedComponentsWithStats(mask, connectivity=8)
    max_area = max_area_frac * image.shape[0] * image.shape[1]
    count = 0
    for i in range(1, n):  # skip background label 0
        area = stats[i, cv2.CC_STAT_AREA]
        if min_area <= area <= max_area:
            count += 1
    return count


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
