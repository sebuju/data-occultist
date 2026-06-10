"""Score an item's *tells* — the signals that say "this cell really is an item".

Each tell is tested in a pixel crop of a cell-relative region:

  * ``filled``   — variance/edge energy in the crop (an icon vs an empty gap);
  * ``color``    — fraction of pixels near a taught colour;
  * ``template`` — best normalised match of a saved sub-image;
  * ``text``     — handled by the reader (a field's OCR read must be non-empty).

Scores are 0..1 and compared against the tell's ``threshold``. Visual tells are
cheap (no OCR), so one of them can also locate rows by sliding down a column.
"""

from __future__ import annotations

import cv2
import numpy as np

from ..profile.models import Tell, TellKind
from .pips import count_diamonds


def hex_to_bgr(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return (b, g, r)


def filled_score(crop: np.ndarray) -> float:
    """How much visual content the crop has — 0 for a flat/empty slot, ->1 for a
    busy icon. Standard deviation of brightness, normalised."""
    if crop is None or crop.size == 0:
        return 0.0
    gray = crop.max(axis=2) if crop.ndim == 3 else crop
    return float(min(1.0, gray.std() / 64.0))


def color_score(crop: np.ndarray, hex_color: str | None, tolerance: int) -> float:
    if crop is None or crop.size == 0 or not hex_color:
        return 0.0
    bgr = np.array(hex_to_bgr(hex_color), dtype=np.float32)
    dist = np.linalg.norm(crop.astype(np.float32) - bgr, axis=2)
    return float((dist < tolerance).mean())


def template_score(crop: np.ndarray, template: np.ndarray | None) -> float:
    if crop is None or template is None or crop.size == 0 or template.size == 0:
        return 0.0
    if crop.shape[0] < template.shape[0] or crop.shape[1] < template.shape[1]:
        return 0.0
    res = cv2.matchTemplate(crop, template, cv2.TM_CCOEFF_NORMED)
    return float(res.max())


def diamonds_score(crop: np.ndarray) -> float:
    """Presence of a rank-diamond strip, 0..1. Saturates at 3 marks -> 1.0: arcanes cap
    at different ranks (3-mark and 5-mark strips both exist), and the tell only asks "is
    there a rank strip here at all" (an arcane) vs none (a plain item). Normalising by 5
    would score a 3-mark arcane 0.6 and miss it."""
    if crop is None or crop.size == 0:
        return 0.0
    return float(min(1.0, count_diamonds(crop) / 3.0))


def visual_score(tell: Tell, crop: np.ndarray, template: np.ndarray | None = None) -> float:
    """Score a non-text tell on a crop. Returns 0 for text tells (reader handles those)."""
    if tell.kind is TellKind.filled:
        return filled_score(crop)
    if tell.kind is TellKind.color:
        return color_score(crop, tell.color, tell.tolerance)
    if tell.kind is TellKind.template:
        return template_score(crop, template)
    if tell.kind is TellKind.diamonds:
        return diamonds_score(crop)
    return 0.0


def is_visual(tell: Tell) -> bool:
    return tell.kind is not TellKind.text
