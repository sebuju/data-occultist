"""Evaluate a single :class:`DetectDef` against a captured frame.

A detector matches either by template image (visual landmark) or by OCR text
inside a search box. Both resolve their search box from window-fraction coords to
pixels using the frame's client area.
"""

from __future__ import annotations

from pathlib import Path

from ..interfaces import OcrEngine
from ..profile.models import DetectCombine, DetectDef
from ..types import Frame
from .template import best_match, load_template


def detector_passes(matched: bool, negate: bool) -> bool:
    """A single detector's verdict accounting for its polarity: a positive detector
    passes when the landmark MATCHED; a ``negate`` detector passes when it did NOT."""
    return (not matched) if negate else matched


def combine_passes(passes, mode) -> bool:
    """Combine per-detector pass/fail by window ``mode``: ``any`` -> OR, else AND.

    ``passes`` may be a generator (so the classifier keeps its OCR short-circuit). The
    caller must guarantee it is non-empty — an empty detector set means "no detector",
    which is no match, but ``all([])`` would wrongly be True; callers guard that first.
    """
    return any(passes) if mode == DetectCombine.any else all(passes)


def _norm(s: str, strip: str = "alnum", case_sensitive: bool = False) -> str:
    """Canonicalise text before comparison. ``strip`` chooses what is ignored:
    ``alnum`` keeps only letters/digits (drops spaces + punctuation — the historical
    behaviour, e.g. 'INVENTORY / SELL' -> 'inventorysell'); ``spaces`` drops only
    whitespace; ``none`` keeps everything. Case is folded unless ``case_sensitive``."""
    import re
    if not case_sensitive:
        s = s.lower()
    if strip == "alnum":
        keep = r"[^a-z0-9]" if not case_sensitive else r"[^A-Za-z0-9]"
        return re.sub(keep, "", s)
    if strip == "spaces":
        return re.sub(r"\s", "", s)
    return s


def text_match_score(
    want: str,
    got: str,
    *,
    mode: str = "partial",
    included: bool = False,
    case_sensitive: bool = False,
    min_chars: int = 0,
    strip: str = "alnum",
) -> float:
    """Fuzzy 0..1 score that detector text ``want`` is present in OCR read ``got``.

    ``mode`` picks how strictly the two are compared:

    - ``partial`` (default) — ``partial_ratio`` aligns the shorter string anywhere
      inside the longer, so a read that merely *contains* (or, with ``included``, is
      contained by) the target scores ~1.0. Two length guards keep that honest:
      a read far LONGER than the target caught a paragraph (wrong screen); a read far
      SHORTER is a fragment/noise (a 3-char "war" sits inside "reward"). This mode is
      loose: 'WARDSI' still scores ~0.9 against 'rewards' off the shared "wards".
    - ``full`` — whole-string ``ratio``; extra/missing chars both cost, so 'WARDSI' vs
      'rewards' drops to ~0.77 and is rejected at the usual 0.8 floor.
    - ``exact`` — normalised equality only (1.0 or 0.0).
    - ``prefix`` — the read must begin the target (or the target begins the read when
      ``included``); a near-prefix scores by similarity of the leading slice.

    ``case_sensitive`` and ``strip`` feed :func:`_norm`. ``min_chars`` is a hard floor
    on the normalised read length — below it nothing matches, deterministically killing
    tiny-blob false positives regardless of mode.
    """
    nw = _norm(want, strip, case_sensitive)
    ng = _norm(got, strip, case_sensitive)
    if not nw or not ng:
        return 0.0
    if len(ng) < min_chars:
        return 0.0
    from rapidfuzz import fuzz
    if mode == "exact":
        return 1.0 if nw == ng else 0.0
    if mode == "prefix":
        a, b = (ng, nw) if included else (nw, ng)   # does b start with a?
        if b.startswith(a):
            return 1.0
        return fuzz.ratio(a, b[: len(a)]) / 100.0
    if mode == "full":
        return fuzz.ratio(nw, ng) / 100.0
    # partial (default): keep the length guards that reject paragraphs/fragments.
    if len(ng) > max(len(nw) * 3, len(nw) + 8):
        return 0.0
    if len(ng) < 0.75 * len(nw):   # fragment, not the landmark
        return 0.0
    a, b = (ng, nw) if included else (nw, ng)   # look for a inside b
    return fuzz.partial_ratio(a, b) / 100.0


def match_detail(
    want: str,
    got: str,
    *,
    mode: str = "partial",
    included: bool = False,
    case_sensitive: bool = False,
    min_chars: int = 0,
    strip: str = "alnum",
) -> dict:
    """Editor-only companion to :func:`text_match_score`: returns what the read looked
    like through the matcher's eyes so the UI can SHOW its reasoning, not just a number.

    - ``got_raw``  — the OCR read as compared (outer whitespace already trimmed).
    - ``got_norm`` — the read after ``strip`` + case-folding (what actually got matched).
    - ``want_norm``— the target after the same normalisation.
    - ``got_len``  — len(``got_norm``); compare against ``min_chars`` for the floor.
    - ``span``     — ``[start, end)`` within ``got_norm`` of the characters that carried a
                     match (so the UI highlights them), or ``None`` when nothing aligned.

    NOT on the runtime path — ``text_match_score`` stays the single source of the score.
    """
    nw = _norm(want, strip, case_sensitive)
    ng = _norm(got, strip, case_sensitive)
    out = {"want_norm": nw, "got_norm": ng, "got_raw": got,
           "min_chars": min_chars, "got_len": len(ng), "span": None}
    if not nw or not ng or len(ng) < min_chars:
        return out
    if mode == "exact":
        if nw == ng:
            out["span"] = [0, len(ng)]
        return out
    if mode == "prefix":
        a, b = (ng, nw) if included else (nw, ng)
        k = 0
        m = min(len(a), len(b))
        while k < m and a[k] == b[k]:
            k += 1
        out["span"] = [0, min(k, len(ng))] if k else None
        return out
    if mode == "full":
        out["span"] = [0, len(ng)]   # whole-string compare — every char is "in play"
        return out
    # partial: align the shorter inside the longer and report the region within got_norm.
    from rapidfuzz import fuzz
    a, b = (ng, nw) if included else (nw, ng)   # text_match_score looks for `a` inside `b`
    al = fuzz.partial_ratio_alignment(a, b)
    if al is not None:
        s, e = (al.src_start, al.src_end) if included else (al.dest_start, al.dest_end)
        out["span"] = [max(0, s), min(e, len(ng))]
    return out


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
        score = text_match_score(
            det.text or "", read,
            mode=det.match, included=det.included,
            case_sensitive=det.case_sensitive, min_chars=det.min_chars, strip=det.strip,
        )
        return read, score

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
            matched = s >= det.threshold
            return {"matched": matched, "passes": detector_passes(matched, det.negate),
                    "negate": det.negate, "read": "(template)",
                    "score": round(s, 2), "threshold": det.threshold}
        read, s = self._text_score(det, frame)
        matched = bool(det.text) and s >= det.threshold
        out = {"matched": matched, "passes": detector_passes(matched, det.negate),
               "negate": det.negate, "read": read,
               "score": round(s, 2), "threshold": det.threshold}
        # editor reasoning: before/after-strip text, the min-chars count, and which chars
        # carried the match (so the detect node can show WHY, not just a score).
        out.update(match_detail(det.text or "", read, mode=det.match, included=det.included,
                                case_sensitive=det.case_sensitive, min_chars=det.min_chars,
                                strip=det.strip))
        return out
