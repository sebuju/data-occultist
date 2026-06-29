"""Screen-settle detection: has the view stopped moving (vs mid-scroll/animation)?

OCR on a frame captured DURING a scroll or fade reads as garbage — the text is
blurred or half-drawn. Both live collection (``collector.tick``) and precapture only
process a SETTLED frame: one that matches the immediately-preceding grab within a
noise tolerance (a cursor twitch is below it and doesn't count as motion). A
transition keeps changing, so no two consecutive grabs match and every transition
frame is skipped; only the steady state passes.

The thumbnail is a tiny grayscale downsample, and the bottom strip is cropped off
first because the game's perf/FPS overlay lives there and ticks every frame — left
in, it would defeat the "two identical grabs" test. Cropping is for the DIFF ONLY;
the full frame is what gets OCR'd / saved, so region fractions are unaffected.
"""

from __future__ import annotations

import cv2
import numpy as np

THUMB = 48           # downsampled side for the perceptual diff
THUMB_TOL = 16       # per-cell brightness delta that counts as "changed"
MIN_CELLS = 10       # fewer changed cells than this -> nothing real moved (cursor/noise)
CROP_PX = 50         # bottom strip dropped before the diff (perf/FPS overlay lives there)


def thumb(image: np.ndarray, crop_px: int = 0) -> np.ndarray | None:
    """Tiny grayscale signature of a frame for the staleness diff, or None for an
    empty/black frame. ``crop_px`` drops that many rows off the bottom first (the
    per-frame perf overlay) so it never registers as motion."""
    if image is None or image.size == 0:
        return None
    if crop_px and image.shape[0] > crop_px:
        image = image[: image.shape[0] - crop_px]
    # A 48x48 perceptual diff doesn't need every one of a 4K frame's ~25M pixels, and the
    # channel-max + area-resize over the full frame dominate a whole collection tick (~120ms
    # at 4K). Stride-subsample to a coarse intermediate FIRST (short side ~4*THUMB), then do
    # the max + resize on that tiny array — ~50x fewer elements touched. The channel-max is
    # kept (not a single channel) so the signature's magnitude — and thus THUMB_TOL/MIN_CELLS
    # — is unchanged; only the sampling grid differs, which a coarse diff is robust to.
    h, w = image.shape[:2]
    step = max(1, min(h, w) // (THUMB * 4))
    small = image[::step, ::step]
    gray = small.max(axis=2) if small.ndim == 3 else np.ascontiguousarray(small)
    return cv2.resize(gray, (THUMB, THUMB), interpolation=cv2.INTER_AREA)


def changed_cells(a: np.ndarray, b: np.ndarray) -> int:
    """How many thumbnail cells differ by more than the brightness tolerance."""
    return int((cv2.absdiff(a, b) > THUMB_TOL).sum())


def is_settled(cur: np.ndarray | None, prev: np.ndarray | None,
               min_cells: int = MIN_CELLS) -> bool:
    """True when ``cur`` matches the previous grab within the noise floor — the screen
    has stopped moving. False on the first frame (no prev) and mid-transition."""
    return cur is not None and prev is not None and changed_cells(cur, prev) < min_cells
