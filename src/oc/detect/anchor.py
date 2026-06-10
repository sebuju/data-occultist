"""Evaluate a single :class:`AnchorDef` against a captured frame.

An anchor matches either by template image (visual landmark) or by OCR text inside
a search box. Both resolve their search box from window-fraction coords to pixels
using the frame's client area.
"""

from __future__ import annotations

from pathlib import Path

from ..interfaces import OcrEngine
from ..profile.models import AnchorDef
from ..types import Frame
from .template import best_match, load_template


def _norm(s: str) -> str:
    """Lowercase, drop everything but letters/digits — so detection ignores spaces,
    punctuation and case (e.g. 'INVENTORY / SELL' -> 'inventorysell')."""
    import re
    return re.sub(r"[^a-z0-9]", "", s.lower())


def text_match_score(want: str, got: str, included: bool = False) -> float:
    """Fuzzy 0..1 score that ``want`` is present in OCR ``got`` (or vice versa if
    ``included``), ignoring spaces/special chars/case, so stylised or noisy OCR still
    matches (e.g. 'INVTNTORYSELL' ~ 'INVENTORY / SELL')."""
    nw, ng = _norm(want), _norm(got)
    if not nw or not ng:
        return 0.0
    from rapidfuzz import fuzz
    a, b = (ng, nw) if included else (nw, ng)   # look for a inside b
    return fuzz.partial_ratio(a, b) / 100.0


class AnchorMatcher:
    def __init__(self, ocr: OcrEngine, profile_dir: Path | str) -> None:
        self._ocr = ocr
        self._dir = Path(profile_dir)

    def score(self, anchor: AnchorDef, frame: Frame) -> float:
        """Return a 0..1 confidence that this anchor is present."""
        box = anchor.search.to_fraction().to_pixels(frame.client.w, frame.client.h)
        if anchor.template:
            tmpl = load_template(self._dir / anchor.template)
            crop = frame.image[box.y : box.y + box.h, box.x : box.x + box.w]
            return best_match(crop, tmpl)
        if anchor.text:
            lines = self._ocr.read_region(frame, box)
            joined = " ".join(ln.text for ln in lines).strip().lower()
            return text_match_score(anchor.text.lower(), joined, anchor.included)
        return 0.0

    def matches(self, anchor: AnchorDef, frame: Frame) -> bool:
        return self.score(anchor, frame) >= anchor.threshold
