"""Template matching helper (OpenCV) used by anchor-based detection."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

_TEMPLATE_CACHE: dict[str, np.ndarray] = {}


def load_template(path: Path | str) -> np.ndarray:
    key = str(path)
    tmpl = _TEMPLATE_CACHE.get(key)
    if tmpl is None:
        tmpl = cv2.imread(key, cv2.IMREAD_COLOR)
        if tmpl is None:
            raise FileNotFoundError(f"Template image not found or unreadable: {path}")
        _TEMPLATE_CACHE[key] = tmpl
    return tmpl


def best_match(haystack: np.ndarray, template: np.ndarray) -> float:
    """Return the peak normalized-correlation score (0..1) of template in haystack."""
    if template.shape[0] > haystack.shape[0] or template.shape[1] > haystack.shape[1]:
        return 0.0
    res = cv2.matchTemplate(haystack, template, cv2.TM_CCOEFF_NORMED)
    _min_v, max_v, _min_l, _max_l = cv2.minMaxLoc(res)
    return float(max_v)
