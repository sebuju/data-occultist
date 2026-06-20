"""OCR-free detection of number-like blobs in a frame.

Detection is the cheap front of the pipeline: find WHERE bright text sits without
recognising it, so the expensive OCR runs on a handful of small crops instead of the
whole frame every frame. Floating combat numbers are high-contrast glyphs over a busy
game scene; a threshold + a horizontal close (to fuse the separate digits of one number
into a single blob) + connected components gives tight per-number boxes fast.

This is intentionally OCR-free and value-agnostic — it can't tell a number from any other
bright glyph cluster. Filtering to actual numbers happens after OCR in
:mod:`oc.numbers.process`. Tracking (:mod:`oc.numbers.track`) only needs the boxes.

``cv2`` is imported lazily so importing this module (and the pure-logic tracker) costs
nothing on a box without OpenCV.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..types import PixelBox


@dataclass
class DetectConfig:
    """Knobs for blob detection. Defaults suit bright HUD/combat text on a dark-ish scene.

    Thresholding:
        ``threshold``     ``"otsu"`` (auto global), ``"fixed"`` (use ``thresh_value``), or
                          ``"adaptive"`` (local mean — best when brightness varies across
                          the frame). All operate on luma unless ``color`` is set.
        ``thresh_value``  cutoff for ``"fixed"`` (0..255).
        ``invert``        threshold dark-on-light text instead of bright-on-dark.
        ``color``         optional ``(lo, hi)`` BGR tuples; pixels inside the range form the
                          mask instead of luma threshold (isolate one damage-type colour).
        ``colors``        optional LIST of ``(lo, hi)`` BGR ranges, OR'd together — for text
                          that comes in several distinct colours (e.g. white/yellow/orange/red
                          crit tiers). Takes precedence over ``color``/luma threshold. The
                          caller supplies the palette (no colours are baked in here).

    Glyph fusion / morphology:
        ``close_w``       horizontal close kernel width (px) — bridges the gaps BETWEEN the
                          digits of one number so they form a single blob. Too large fuses
                          neighbouring numbers; too small splits a number into digits.
        ``close_h``       vertical close kernel height (px) — usually 1 (don't merge stacked
                          numbers).
        ``dilate``        extra isotropic dilation (px) to thicken thin glyphs before CC.

    Size gating (reject UI chrome, single specks, huge bars):
        ``min_w/min_h``   minimum blob size in px.
        ``max_w/max_h``   maximum blob size in px (``0`` = no cap).
        ``min_area``      minimum filled pixel area.
        ``min_fill``      minimum filled-fraction (area / bbox area) — drops sparse/loose
                          clusters that aren't compact glyph runs.
        ``max_aspect``    maximum width/height ratio (drops long thin lines / bars).
        ``min_aspect``    minimum width/height ratio (drops TALL blobs — e.g. enemy bodies,
                          which are taller than wide; a multi-digit number is wider than tall).

    Performance:
        ``downscale``     integer factor to detect at (boxes are scaled back up). ``2`` finds
                          blobs on a quarter of the pixels — big speed win, coarser boxes.
        ``max_blobs``     hard cap on returned blobs per frame (largest-area first).
    """

    threshold: str = "otsu"          # "otsu" | "fixed" | "adaptive"
    thresh_value: int = 180
    invert: bool = False
    color: tuple[tuple[int, int, int], tuple[int, int, int]] | None = None
    colors: list[tuple[tuple[int, int, int], tuple[int, int, int]]] | None = None

    close_w: int = 11
    close_h: int = 1
    dilate: int = 0

    min_w: int = 6
    min_h: int = 8
    max_w: int = 0
    max_h: int = 0
    min_area: int = 30
    min_fill: float = 0.15
    max_aspect: float = 12.0
    min_aspect: float = 0.0

    downscale: int = 1
    max_blobs: int = 64


@dataclass(frozen=True)
class Blob:
    """A detected candidate, in full-frame pixel coordinates.

    ``box`` bounds it, ``cx/cy`` is the (intensity-independent) centroid the tracker
    associates on, ``area`` is the filled pixel count.
    """

    box: PixelBox
    cx: float
    cy: float
    area: int


class NumberDetector:
    """Finds number-like blobs in a BGR frame. Stateless across frames (tracking is the
    tracker's job); reuses preallocated morphology kernels between calls."""

    def __init__(self, config: DetectConfig | None = None) -> None:
        self.config = config or DetectConfig()
        self._cv2 = None
        self._kclose = None
        self._kdilate = None

    def _cv(self):
        if self._cv2 is None:
            import cv2

            self._cv2 = cv2
        return self._cv2

    def _kernels(self):
        cv2 = self._cv()
        cfg = self.config
        if self._kclose is None:
            self._kclose = cv2.getStructuringElement(
                cv2.MORPH_RECT, (max(1, cfg.close_w), max(1, cfg.close_h)))
            if cfg.dilate > 0:
                k = 2 * cfg.dilate + 1
                self._kdilate = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
        return self._kclose, self._kdilate

    def _mask(self, image: np.ndarray) -> np.ndarray:
        cv2 = self._cv()
        cfg = self.config
        ranges = cfg.colors if cfg.colors else ([cfg.color] if cfg.color else None)
        if ranges and image.ndim == 3:
            mask = None
            for lo, hi in ranges:
                part = cv2.inRange(image, np.array(lo, np.uint8), np.array(hi, np.uint8))
                mask = part if mask is None else cv2.bitwise_or(mask, part)
            return mask
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
        ttype = cv2.THRESH_BINARY_INV if cfg.invert else cv2.THRESH_BINARY
        if cfg.threshold == "fixed":
            _, m = cv2.threshold(gray, cfg.thresh_value, 255, ttype)
        elif cfg.threshold == "adaptive":
            m = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, ttype, 21, -5)
        else:  # otsu
            _, m = cv2.threshold(gray, 0, 255, ttype | cv2.THRESH_OTSU)
        return m

    def mask(self, image: np.ndarray) -> np.ndarray:
        """The binary mask the blob search runs on (threshold/colour + morphology), at
        detection scale. Exposed for diagnostics: save it to SEE what the colour ranges /
        threshold actually select on a real frame (sparse = ranges too tight)."""
        cv2 = self._cv()
        cfg = self.config
        f = max(1, cfg.downscale)
        src = image[::f, ::f] if f > 1 else image
        m = self._mask(src)
        kclose, kdilate = self._kernels()
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, kclose)
        if kdilate is not None:
            m = cv2.dilate(m, kdilate)
        return m

    def detect(self, image: np.ndarray) -> list[Blob]:
        """Return candidate number blobs in ``image`` (BGR or gray), full-frame coords."""
        if image is None or image.size == 0:
            return []
        cv2 = self._cv()
        cfg = self.config
        f = max(1, cfg.downscale)

        mask = self.mask(image)

        n, _labels, stats, centroids = cv2.connectedComponentsWithStats(mask, connectivity=8)
        blobs: list[Blob] = []
        for i in range(1, n):  # 0 is background
            x, y, w, h, area = (int(stats[i, cv2.CC_STAT_LEFT]),
                                int(stats[i, cv2.CC_STAT_TOP]),
                                int(stats[i, cv2.CC_STAT_WIDTH]),
                                int(stats[i, cv2.CC_STAT_HEIGHT]),
                                int(stats[i, cv2.CC_STAT_AREA]))
            # scale gates compare in detection-space; boxes get scaled back after.
            if w < cfg.min_w or h < cfg.min_h:
                continue
            if cfg.max_w and w > cfg.max_w:
                continue
            if cfg.max_h and h > cfg.max_h:
                continue
            if area < cfg.min_area:
                continue
            if w * h > 0 and area / (w * h) < cfg.min_fill:
                continue
            aspect = w / h if h else 999.0
            if aspect > cfg.max_aspect:
                continue
            if aspect < cfg.min_aspect:   # too tall/narrow (enemy body, not a number line)
                continue
            cx, cy = float(centroids[i][0]), float(centroids[i][1])
            if f > 1:
                x, y, w, h = x * f, y * f, w * f, h * f
                cx, cy, area = cx * f, cy * f, area * f * f
            blobs.append(Blob(PixelBox(x, y, w, h), cx, cy, area))

        if len(blobs) > cfg.max_blobs:
            blobs.sort(key=lambda b: b.area, reverse=True)
            blobs = blobs[:cfg.max_blobs]
        return blobs
