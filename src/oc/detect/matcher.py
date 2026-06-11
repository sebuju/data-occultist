"""Evaluate a single :class:`DetectDef` against a captured frame.

A detector matches either by template image (visual landmark) or by OCR text
inside a search box. Both resolve their search box from window-fraction coords to
pixels using the frame's client area.
"""

from __future__ import annotations

from pathlib import Path

from ..interfaces import OcrEngine
from ..profile.models import DetectDef
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
    matches (e.g. 'INVTNTORYSELL' ~ 'INVENTORY / SELL').

    ``partial_ratio`` aligns the shorter string anywhere inside the longer one, so a
    long OCR read that merely *contains* the target would otherwise score ~1.0. A read
    far longer than the expected text means the box caught a paragraph (wrong screen),
    not the landmark — so it's dismissed.
    """
    nw, ng = _norm(want), _norm(got)
    if not nw or not ng:
        return 0.0
    if len(ng) > max(len(nw) * 3, len(nw) + 8):
        return 0.0
    from rapidfuzz import fuzz
    a, b = (ng, nw) if included else (nw, ng)   # look for a inside b
    return fuzz.partial_ratio(a, b) / 100.0


class DetectMatcher:
    def __init__(self, ocr: OcrEngine, profile_dir: Path | str) -> None:
        self._ocr = ocr
        self._dir = Path(profile_dir)

    def score(self, det: DetectDef, frame: Frame) -> float:
        """Return a 0..1 confidence that this detector is present."""
        box = det.search.to_fraction().to_pixels(frame.client.w, frame.client.h)
        if det.template:
            tmpl = load_template(self._dir / det.template)
            crop = frame.image[box.y : box.y + box.h, box.x : box.x + box.w]
            return best_match(crop, tmpl)
        if det.text:
            lines = self._ocr.read_region(frame, box)
            joined = " ".join(ln.text for ln in lines).strip().lower()
            return text_match_score(det.text.lower(), joined, det.included)
        return 0.0

    def matches(self, det: DetectDef, frame: Frame) -> bool:
        return self.score(det, frame) >= det.threshold
