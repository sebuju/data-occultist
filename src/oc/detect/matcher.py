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
    read that merely *contains* (or is contained by) the target would otherwise score
    ~1.0. Two guards reject that:
    - Too LONG: a read far longer than the target means the box caught a paragraph
      (wrong screen), not the landmark.
    - Too SHORT: a read far shorter than the target is a fragment/noise — e.g. a 3-char
      blob "war" sits inside "reward" and would score 1.0, so a near-empty box would
      false-match. Require the read to cover most of the target's length.
    """
    nw, ng = _norm(want), _norm(got)
    if not nw or not ng:
        return 0.0
    if len(ng) > max(len(nw) * 3, len(nw) + 8):
        return 0.0
    if len(ng) < 0.75 * len(nw):   # fragment, not the landmark
        return 0.0
    from rapidfuzz import fuzz
    a, b = (ng, nw) if included else (nw, ng)   # look for a inside b
    return fuzz.partial_ratio(a, b) / 100.0


class DetectMatcher:
    def __init__(self, ocr: OcrEngine, profile_dir: Path | str) -> None:
        self._ocr = ocr
        self._dir = Path(profile_dir)
        # Per-frame OCR memo: classify() tests every window, and many windows reuse
        # the SAME landmark box (the title bar 'INVENTORY'/'NAME'), so without this a
        # frame OCRs the same pixels a dozen times. Keyed by box; reset when the frame
        # object changes (a held reference keeps identity stable while it's cached).
        self._memo: dict[tuple[int, int, int, int], tuple[str, float]] = {}
        self._memo_frame: Frame | None = None

    def _read_text_box(self, frame: Frame, box) -> tuple[str, float]:
        """Recognition-only read of one landmark box, memoised per frame. ``read_line``
        skips text DETECTION (the dominant OCR cost) — a detect box bounds one label, so
        the caller already knows it's a single line. Many times cheaper than the full
        ``read_region``/``read_image`` pass used before."""
        if frame is not self._memo_frame:
            self._memo = {}
            self._memo_frame = frame
        key = (box.x, box.y, box.w, box.h)
        cached = self._memo.get(key)
        if cached is None:
            crop = frame.image[box.y : box.y + box.h, box.x : box.x + box.w]
            cached = self._ocr.read_line(crop) if crop.size else ("", 0.0)
            self._memo[key] = cached
        return cached

    def _text_score(self, det: DetectDef, frame: Frame) -> tuple[str, float]:
        """(read text, 0..1 score) for a text detector — the ONE runtime read path
        (``read_line``, recognition-only). Both ``score`` and ``evaluate`` go through here
        so the editor preview can never read a detect box differently than classify() will."""
        box = det.search.to_fraction().to_pixels(frame.client.w, frame.client.h)
        text, _conf = self._read_text_box(frame, box)
        read = text.strip()
        return read, text_match_score((det.text or "").lower(), read.lower(), det.included)

    def score(self, det: DetectDef, frame: Frame) -> float:
        """Return a 0..1 confidence that this detector is present."""
        if det.template:
            box = det.search.to_fraction().to_pixels(frame.client.w, frame.client.h)
            tmpl = load_template(self._dir / det.template)
            crop = frame.image[box.y : box.y + box.h, box.x : box.x + box.w]
            return best_match(crop, tmpl)
        if det.text:
            return self._text_score(det, frame)[1]
        return 0.0

    def matches(self, det: DetectDef, frame: Frame) -> bool:
        return self.score(det, frame) >= det.threshold

    def evaluate(self, det: DetectDef, frame: Frame) -> dict:
        """{matched, read, score, threshold} for the editor preview — using the EXACT
        runtime path (``score``/``_text_score``), so what the UI shows is what classify()
        does. (The old preview used ``read_region`` — full detection — and silently
        disagreed with the recognition-only runtime read.)"""
        if det.template:
            s = self.score(det, frame)
            return {"matched": s >= det.threshold, "read": "(template)",
                    "score": round(s, 2), "threshold": det.threshold}
        read, s = self._text_score(det, frame)
        return {"matched": bool(det.text) and s >= det.threshold, "read": read,
                "score": round(s, 2), "threshold": det.threshold}
