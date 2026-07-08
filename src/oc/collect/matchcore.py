"""Shared normalised-cross-correlation kernel for "does this crop match this saved template"
comparisons — used by item template tells (:mod:`tells`) and the taught cutout atlas
(:mod:`atlas_match`). NOT used by :func:`oc.detect.template.best_match`, which slides a
template across a much larger haystack (state/window detection) and deliberately hard-fails
on an oversized template rather than shrinking it — a different search, not a copy of this one.
"""

from __future__ import annotations

import cv2
import numpy as np


def ncc_scaled(crop: np.ndarray, template: np.ndarray | None) -> float:
    """Peak ``TM_CCOEFF_NORMED`` of ``template`` against ``crop``, shrinking the template
    (aspect-preserving) first if it's larger than the crop in either dimension.

    A saved template is authored a hair larger/smaller than a live crop frame-to-frame (OCR-
    located cells, capture jitter); hard-failing to 0 on an oversized template would make the
    match flicker, so it degrades gracefully instead of vanishing."""
    if crop is None or template is None or crop.size == 0 or template.size == 0:
        return 0.0
    ch, cw = crop.shape[:2]
    th, tw = template.shape[:2]
    if th > ch or tw > cw:
        scale = min(ch / th, cw / tw)
        nw, nh = max(1, int(tw * scale)), max(1, int(th * scale))
        template = cv2.resize(template, (nw, nh), interpolation=cv2.INTER_AREA)
    res = cv2.matchTemplate(crop, template, cv2.TM_CCOEFF_NORMED)
    return float(res.max())
