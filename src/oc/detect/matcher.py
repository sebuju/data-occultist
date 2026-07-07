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
    case_sensitive: bool = False,
    min_chars: int = 0,
    strip: str = "alnum",
) -> float:
    """Fuzzy 0..1 score that detector text ``want`` is present in OCR read ``got``.

    ``mode`` picks how strictly the two are compared:

    - ``partial`` (default) — ``partial_ratio`` aligns the shorter string anywhere inside
      the longer, so a read that merely *contains* the target scores ~1.0. Loose by design:
      'WARDSI' still scores ~0.9 against 'rewards' off the shared "wards". No hidden length
      bounds — if a read is too loose, raise ``min_chars`` or pick ``full``/``prefix``. What
      separates the right window from a coincidental substring is best-fit classify (the window
      whose detectors score HIGHEST wins), not a per-detector cap.
    - ``full`` — whole-string ``ratio``; extra/missing chars both cost, so 'WARDSI' vs
      'rewards' drops to ~0.77 and is rejected at the usual 0.8 floor.
    - ``exact`` — normalised equality only (1.0 or 0.0).
    - ``prefix`` — the read must begin with the target; a near-prefix scores by similarity
      of the leading slice.

    ``case_sensitive`` and ``strip`` feed :func:`_norm`. ``min_chars`` is a hard floor
    on the normalised read length — below it nothing matches, deterministically killing
    tiny-blob false positives regardless of mode.
    """
    nw = _norm(want, strip, case_sensitive)
    ng = _norm(got, strip, case_sensitive)
    if not ng:
        return 0.0
    if len(ng) < min_chars:
        return 0.0
    if not nw:
        return 1.0   # empty target = "any text present" — matches any read meeting min_chars
    from rapidfuzz import fuzz
    if mode == "exact":
        return 1.0 if nw == ng else 0.0
    if mode == "prefix":
        if ng.startswith(nw):   # does the read begin with the target?
            return 1.0
        return fuzz.ratio(nw, ng[: len(nw)]) / 100.0
    if mode == "full":
        return fuzz.ratio(nw, ng) / 100.0
    # partial (default): is the target somewhere in the read? No length guards — best-fit
    # classify decides which window wins, not a hidden per-detector cap.
    return fuzz.partial_ratio(nw, ng) / 100.0


def match_detail(
    want: str,
    got: str,
    *,
    mode: str = "partial",
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
    if not nw or not ng:
        return out
    if len(ng) < min_chars:
        return out
    if mode == "exact":
        if nw == ng:
            out["span"] = [0, len(ng)]
        return out
    if mode == "prefix":
        k = 0
        m = min(len(nw), len(ng))
        while k < m and nw[k] == ng[k]:   # how far the read matches the target from the start
            k += 1
        out["span"] = [0, min(k, len(ng))] if k else None
        return out
    if mode == "full":
        out["span"] = [0, len(ng)]   # whole-string compare — every char is "in play"
        return out
    # partial: align the target inside the read and report the matched region within got_norm.
    from rapidfuzz import fuzz
    al = fuzz.partial_ratio_alignment(nw, ng)   # text_match_score looks for `nw` inside `ng`
    if al is not None:
        out["span"] = [max(0, al.dest_start), min(al.dest_end, len(ng))]
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

    def prewarm(self, frame: Frame, boxes) -> None:
        """Fill the per-frame OCR memo for many landmark boxes in ONE batched recognition
        pass (``read_lines``), instead of a ``read_line`` per box as ``classify`` walks the
        windows' (differently-boxed) titles.

        GPU ONLY: on GPU each tiny sequential read pays a fixed launch/sync cost, so batching
        N reads into one launch is a large win. On CPU it LOSES — it defeats the per-detector
        short-circuit and RapidOCR pads every crop to the batch's max width (the title crops are
        wide at 4K), so the eager batch did MORE work than the sequential rec-only reads (measured
        ~80ms -> ~170ms). So it no-ops unless the engine is actively on GPU."""
        if not getattr(self._ocr, "gpu_active", False):
            return
        if frame is not self._memo_frame:
            self._memo = {}
            self._memo_frame = frame
        keys, crops = [], []
        for box in boxes:
            key = (box.x, box.y, box.w, box.h)
            if key in self._memo:
                continue
            crop = frame.image[box.y : box.y + box.h, box.x : box.x + box.w]
            self._memo[key] = ("", 0.0)   # reserve (dedups within this batch; filled below)
            if crop.size:
                keys.append(key)
                crops.append(crop)
        if crops:
            for key, res in zip(keys, self._ocr.read_lines(crops)):
                self._memo[key] = res

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
            mode=det.match,
            case_sensitive=det.case_sensitive, min_chars=det.min_chars, strip=det.strip,
        )
        return read, score

    def _crop(self, det: DetectDef, frame: Frame):
        box = det.search.to_fraction().to_pixels(frame.client.w, frame.client.h)
        return frame.image[box.y : box.y + box.h, box.x : box.x + box.w]

    def score(self, det: DetectDef, frame: Frame) -> float:
        """Return a 0..1 confidence that this detector is present."""
        if det.template:
            tmpl = load_template(self._dir / det.template)
            return best_match(self._crop(det, frame), tmpl)
        if det.color:
            # Cheap colour-presence kind — reuse the SAME primitives item Tells score on
            # (no OCR). ``width>0`` scores only the box perimeter (a frame/outline).
            from ..collect.tells import border_score, color_score
            crop = self._crop(det, frame)
            return (border_score(crop, det.color, det.tolerance, det.width)
                    if det.width else color_score(crop, det.color, det.tolerance))
        # otherwise a text detector — read the box. Empty ``text`` means "any text present"
        # (``text_match_score`` returns 1.0 for any read meeting ``min_chars``).
        return self._text_score(det, frame)[1]

    def matches(self, det: DetectDef, frame: Frame) -> bool:
        return self.score(det, frame) >= det.threshold

    def evaluate(self, det: DetectDef, frame: Frame) -> dict:
        """{matched, read, score, threshold} for the editor preview — using the EXACT
        runtime path (``score``/``_text_score``), so what the UI shows is what classify()
        does. (The old preview used ``read_region`` — full detection — and silently
        disagreed with the recognition-only runtime read.)"""
        if det.template or det.color:
            # colour/border/template: the "read" concept doesn't apply — the verdict row
            # already carries the pixel-match %/threshold, so echo the detector kind.
            extra: dict = {}
            if det.color:
                from ..collect.tells import border_score, color_distance, color_score
                crop = self._crop(det, frame)
                s = (border_score(crop, det.color, det.tolerance, det.width)
                     if det.width else color_score(crop, det.color, det.tolerance))
                # closest-pixel BGR distance to the target — the editor shows it beside the
                # "(color)" read so the user can tune `tolerance` above it (None = untestable).
                dist = color_distance(crop, det.color, det.width)
                label = "(color)"
                extra["dist"] = None if dist is None else round(dist, 1)
            else:
                s = self.score(det, frame)
                label = "(template)"
            matched = s >= det.threshold
            return {"matched": matched, "passes": detector_passes(matched, det.negate),
                    "negate": det.negate, "read": label,
                    "score": round(s, 2), "threshold": det.threshold, **extra}
        read, s = self._text_score(det, frame)
        matched = s >= det.threshold   # empty text ("any") scores 1.0 on any read meeting min_chars
        out = {"matched": matched, "passes": detector_passes(matched, det.negate),
               "negate": det.negate, "read": read,
               "score": round(s, 2), "threshold": det.threshold}
        # editor reasoning: before/after-strip text, the min-chars count, and which chars
        # carried the match (so the detect node can show WHY, not just a score).
        out.update(match_detail(det.text or "", read, mode=det.match,
                                case_sensitive=det.case_sensitive, min_chars=det.min_chars,
                                strip=det.strip))
        return out
