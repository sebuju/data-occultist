"""Score an item's *tells* — the signals that say "this cell really is an item".

Each tell is tested in a pixel crop of a cell-relative region:

  * ``filled``   — variance/edge energy in the crop (an icon vs an empty gap);
  * ``color``    — fraction of pixels near a taught colour;
  * ``border``   — like ``color`` but only on the box's perimeter band (a frame/outline);
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


def _color_dist(crop: np.ndarray, hex_color: str | None) -> np.ndarray | None:
    """Per-pixel BGR distance from every pixel of ``crop`` to ``hex_color`` — the shared
    colour primitive both the mask (presence) and the distance readout derive from. None
    when there's nothing to test."""
    if crop is None or crop.size == 0 or not hex_color:
        return None
    bgr = np.array(hex_to_bgr(hex_color), dtype=np.float32)
    return np.linalg.norm(crop.astype(np.float32) - bgr, axis=2)


def _perimeter_ring(shape: tuple[int, int], width: float) -> np.ndarray | None:
    """Boolean mask of the box's perimeter band (thickness ``width`` as a fraction of the
    shorter side). None when the band would swallow the whole box — the caller then treats
    it as a whole-fill region, not a ring."""
    h, w = shape
    band = max(1, int(round((width or 0.0) * min(h, w))))
    if band * 2 >= min(h, w):     # band swallows the whole box -> it's just a color tell
        return None
    ring = np.zeros((h, w), dtype=bool)
    ring[:band, :] = ring[-band:, :] = ring[:, :band] = ring[:, -band:] = True
    return ring


def _color_mask(crop: np.ndarray, hex_color: str | None, tolerance: int) -> np.ndarray | None:
    """Boolean mask of pixels within ``tolerance`` BGR distance of ``hex_color`` — the
    shared colour-presence primitive both ``color`` (whole fill) and ``border`` (perimeter
    band only) score on. None when there's nothing to test."""
    dist = _color_dist(crop, hex_color)
    return None if dist is None else dist < tolerance


def color_score(crop: np.ndarray, hex_color: str | None, tolerance: int) -> float:
    near = _color_mask(crop, hex_color, tolerance)
    return float(near.mean()) if near is not None else 0.0


def border_score(crop: np.ndarray, hex_color: str | None, tolerance: int, width: float) -> float:
    """Colour presence on the box's PERIMETER band only (a rarity frame, a selection
    outline), not its fill. ``width`` is the band thickness as a fraction of the box's
    shorter side; the score is the share of near-colour pixels within that ring."""
    near = _color_mask(crop, hex_color, tolerance)
    if near is None:
        return 0.0
    ring = _perimeter_ring(near.shape, width)
    return float(near.mean()) if ring is None else float(near[ring].mean())


def color_distance(crop: np.ndarray, hex_color: str | None, width: float = 0.0) -> float | None:
    """Smallest BGR distance from any tested pixel to ``hex_color`` — the editor's tuning
    aid: set ``tolerance`` above this to start catching the target. ``width>0`` measures
    only the perimeter band (matching ``border_score``). None when there's nothing to test."""
    dist = _color_dist(crop, hex_color)
    if dist is None:
        return None
    if width:
        ring = _perimeter_ring(dist.shape, width)
        if ring is not None:
            dist = dist[ring]
    return float(dist.min())


def template_score(crop: np.ndarray, template: np.ndarray | None) -> float:
    if crop is None or template is None or crop.size == 0 or template.size == 0:
        return 0.0
    ch, cw = crop.shape[:2]
    th, tw = template.shape[:2]
    # matchTemplate requires template <= crop. Rows here are OCR-located (not a fixed grid),
    # so a located cell is a few px smaller/larger than the authoring cutout frame-to-frame.
    # A template authored a hair larger than the live crop would otherwise hard-fail to 0
    # (the old guard) — making the tell flicker. Shrink the template to fit (aspect-preserving)
    # instead of dropping the read, so the match degrades gracefully rather than vanishing.
    if th > ch or tw > cw:
        scale = min(ch / th, cw / tw)
        nw, nh = max(1, int(tw * scale)), max(1, int(th * scale))
        template = cv2.resize(template, (nw, nh), interpolation=cv2.INTER_AREA)
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
    if tell.kind is TellKind.border:
        return border_score(crop, tell.color, tell.tolerance, tell.width)
    if tell.kind is TellKind.template:
        return template_score(crop, template)
    if tell.kind is TellKind.diamonds:
        return diamonds_score(crop)
    return 0.0


def is_visual(tell: Tell) -> bool:
    return tell.kind is not TellKind.text
