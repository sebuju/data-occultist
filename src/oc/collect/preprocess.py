"""Apply a window's teachable text-appearance preprocessing to an OCR crop.

Stylised coloured game text is hard for OCR. By teaching the text colour(s), we can
mask just those glyphs into clean black-on-white. Threshold/invert/scale cover the
other common cases. All operate on a BGR image and return a BGR image (OCR-ready).
"""

from __future__ import annotations

import cv2
import numpy as np

from ..profile.models import Preprocess, PreprocessMode


def _hex_to_bgr(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return (b, g, r)


def _color_mask(image: np.ndarray, colors: list[str], tolerance: int) -> np.ndarray:
    """Black glyphs on white where pixels are within tolerance of any taught colour."""
    # int32, NOT int16: a per-channel diff is up to 255, and 255**2 = 65025 overflows int16
    # (max 32767) -> negative sum -> NaN distance, silently corrupting the mask for exactly the
    # high-contrast case that matters (white text on a dark background is a diff of 255).
    img = image.astype(np.int32)
    mask = np.zeros(image.shape[:2], dtype=bool)
    for hexc in colors:
        h = (hexc or "").lstrip("#")
        if len(h) != 6 or any(c not in "0123456789abcdefABCDEF" for c in h):
            continue   # skip an empty / half-typed row (the UI can hold a blank colour)
        bgr = np.array(_hex_to_bgr(hexc), dtype=np.int32)
        dist = np.sqrt(((img - bgr) ** 2).sum(axis=2))
        mask |= dist <= tolerance
    out = np.full(image.shape, 255, dtype=np.uint8)
    out[mask] = 0
    return out


def apply(image: np.ndarray, pp: Preprocess) -> np.ndarray:
    if pp is None or pp.mode is PreprocessMode.none:
        result = image
    elif pp.mode is PreprocessMode.color and pp.colors:
        result = _color_mask(image, pp.colors, pp.tolerance)
    elif pp.mode is PreprocessMode.threshold:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        result = cv2.cvtColor(bw, cv2.COLOR_GRAY2BGR)
    elif pp.mode is PreprocessMode.invert:
        result = 255 - image
    else:
        result = image

    if pp and pp.scale and pp.scale != 1.0 and result.size:
        result = cv2.resize(result, None, fx=pp.scale, fy=pp.scale, interpolation=cv2.INTER_CUBIC)
    return result
