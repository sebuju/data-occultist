"""Post-OCR glyph refinement via template matching against a taught glyph atlas.

The dictionary/lexicon layer corrects a *word* by snapping it to a known term — but it
is helpless when two readings are BOTH valid vocabulary (e.g. relic codes "Lith Q3" and
"Lith G3" both exist, so a Q<->G confusion is un-disambiguable by fuzzy match). The glyph
must be settled at the PIXEL level.

:class:`GlyphMatcher` does exactly that, teachably: the game teaches how each character
looks (:class:`~oc.profile.models.GlyphDef`, authored in the UI), and a field marked
``glyph_check`` has its characters matched against that atlas. A character is substituted
ONLY when a *different* taught glyph out-scores the OCR's own at that position by a margin —
never a guess.

Matching is done by SLIDING each taught template (scaled to the read's text-band height)
across the band and taking the peak normalised cross-correlation, NOT by cropping fixed
glyph cells. This font's intra- and inter-glyph column gaps overlap, so fixed segmentation
mis-merges strokes into blobs; a sliding match is immune to that — it finds a glyph wherever
it sits. Rough positions (from the widest column gaps) only anchor WHICH read character a
detection belongs to; the sliding tolerates their imprecision.

There is ZERO game knowledge here — which glyphs exist and what they look like is data.
"""

from __future__ import annotations

import cv2
import numpy as np

# A different taught glyph must beat the OCR char's own template at the same position by at
# least this NCC margin before we dare substitute it — the guard against a coin-flip swap.
_MARGIN = 0.05
# ...and the winner must itself correlate at least this well, or the pixels are too unlike any
# taught glyph to trust (partial occlusion, wrong preprocessing) -> leave the read alone.
_MIN_SCORE = 0.55
# A row counts as "ink" when its foreground pixel count exceeds this fraction of the band's
# peak — separates the (dim, gradient) glow band above relic text from the text row itself.
_ROW_INK = 0.18
# A column is a "gap" (glyph boundary candidate) when its ink is at/below this fraction of peak.
_GAP_INK = 0.04
# When sliding a template around a character's rough position, search this much either side of
# its span (as a fraction of band height) — enough slack to absorb segmentation error.
_SLIDE_SLACK = 0.6


def _binary(bgr: np.ndarray) -> np.ndarray | None:
    """BGR crop -> binary uint8 (0/255) with the TEXT as white (255) on black.

    Otsu splits fore/background; we then force the foreground to be the minority class
    (text is fewer pixels than its backdrop), so bright-text-on-dark and the rare
    dark-text-on-bright both come out white-on-black."""
    if bgr is None or bgr.size == 0 or bgr.shape[0] < 3 or bgr.shape[1] < 3:
        return None
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY) if bgr.ndim == 3 else bgr
    _t, bin_ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    if int((bin_ > 0).sum()) * 2 > bin_.size:   # white is the majority -> it's the background
        bin_ = cv2.bitwise_not(bin_)
    return bin_


def _band_range(bin_: np.ndarray) -> tuple[int, int]:
    """Row range [lo, hi) of the densest contiguous text band — the text line — excluding the
    animated glow band above/below it. Without this the column projection sees ink in every
    column (the glow spans the full width) and matching is swamped by non-text pixels."""
    rows = (bin_ > 0).sum(axis=1).astype(np.float64)
    peak = rows.max()
    if peak <= 0:
        return 0, bin_.shape[0]
    inky = rows >= peak * _ROW_INK
    best_lo = best_hi = 0
    best_sum = -1.0
    i, n = 0, len(inky)
    while i < n:
        if not inky[i]:
            i += 1
            continue
        j = i
        while j < n and inky[j]:
            j += 1
        run_sum = float(rows[i:j].sum())   # rank runs by total ink, not length
        if run_sum > best_sum:
            best_sum, best_lo, best_hi = run_sum, i, j
        i = j
    return (best_lo, best_hi) if best_hi > best_lo else (0, bin_.shape[0])


def _text_band(bin_: np.ndarray) -> np.ndarray:
    lo, hi = _band_range(bin_)
    return bin_[lo:hi, :]


def segment_word(bgr: np.ndarray, n: int) -> list[np.ndarray] | None:
    """Split a BGR word crop into ``n`` single-glyph BGR crops, left-to-right (the auto-glypher:
    one labelled word -> a crop per character). Uses the same text-band isolation + count-driven
    positioning as :meth:`GlyphMatcher.refine`. Returns None when it can't make ``n`` pieces."""
    bin_ = _binary(bgr)
    if bin_ is None or n <= 0:
        return None
    lo, hi = _band_range(bin_)
    band = bin_[lo:hi, :]
    spans = _positions(band, n)
    if spans is None:
        return None
    return [bgr[lo:hi, x0:x1] for x0, x1 in spans]


def _content_x(band: np.ndarray) -> tuple[int, int]:
    """The inked x-extent of a band (trim blank left/right margins)."""
    cols = (band > 0).sum(axis=0)
    nz = np.flatnonzero(cols)
    return (int(nz[0]), int(nz[-1]) + 1) if nz.size else (0, band.shape[1])


def _positions(band: np.ndarray, n: int) -> list[tuple[int, int]] | None:
    """Rough x-span per character by cutting the band at its ``n-1`` WIDEST interior column
    gaps (the most-separating valleys are true character boundaries; thin intra-glyph dips
    are ignored). Only anchors which read character a sliding detection belongs to — exact
    edges don't matter. Returns None when there aren't enough gaps to make ``n`` pieces."""
    if n <= 0:
        return None
    x0, x1 = _content_x(band)
    if n == 1:
        return [(x0, x1)]
    cols = (band[:, x0:x1] > 0).sum(axis=0).astype(np.float64)
    peak = cols.max()
    if peak <= 0:
        return None
    gap = cols <= peak * _GAP_INK
    # interior gap runs -> (centre, width)
    runs: list[tuple[int, int]] = []
    i, m = 0, len(gap)
    while i < m:
        if not gap[i]:
            i += 1
            continue
        j = i
        while j < m and gap[j]:
            j += 1
        if i > 0 and j < m:                      # interior only (skip leading/trailing margin)
            runs.append((i, j))
        i = j
    if len(runs) < n - 1:
        return None
    widest = sorted(runs, key=lambda r: r[1] - r[0], reverse=True)[: n - 1]
    cuts = sorted((r[0] + r[1]) // 2 for r in widest)
    spans, prev = [], 0
    for c in cuts:
        spans.append((x0 + prev, x0 + c))
        prev = c
    spans.append((x0 + prev, x1))
    return spans


def _slide(band: np.ndarray, tmpl: np.ndarray, lo: int, hi: int) -> float:
    """Peak NCC of ``tmpl`` slid across the band's ``[lo, hi]`` x-window. The template is
    scaled to the band's height first (so a differently-sized taught glyph still matches),
    then correlated at every offset — the max is its presence score in that window."""
    bh = band.shape[0]
    if tmpl.shape[0] != bh:
        s = bh / tmpl.shape[0]
        tmpl = cv2.resize(tmpl, (max(1, round(tmpl.shape[1] * s)), bh), interpolation=cv2.INTER_AREA)
    slack = int(_SLIDE_SLACK * bh)
    a = max(0, lo - slack)
    b = min(band.shape[1], hi + slack)
    win = band[:, a:b]
    if win.shape[1] < tmpl.shape[1]:             # window narrower than the glyph: pad right
        win = np.pad(win, ((0, 0), (0, tmpl.shape[1] - win.shape[1])), constant_values=0)
    res = cv2.matchTemplate(win.astype(np.float32), tmpl.astype(np.float32), cv2.TM_CCOEFF_NORMED)
    return float(res.max())


class GlyphMatcher:
    """Holds the taught glyph atlas (binary text-band crops) and refines an OCR string."""

    def __init__(self, atlas: dict[str, list[np.ndarray]]) -> None:
        # char -> list of binary (uint8 0/255) single-glyph templates
        self._atlas = {c: t for c, t in atlas.items() if t}

    def __bool__(self) -> bool:
        return bool(self._atlas)

    @classmethod
    def build(cls, samples: dict[str, list[np.ndarray]]) -> "GlyphMatcher":
        """From ``{char: [BGR crop, …]}`` (each crop a single taught glyph) build the atlas of
        binary text-band templates. Unusable crops are skipped."""
        atlas: dict[str, list[np.ndarray]] = {}
        for char, crops in samples.items():
            if not char:
                continue
            for crop in crops:
                bin_ = _binary(crop)
                if bin_ is None:
                    continue
                band = _text_band(bin_)
                cx0, cx1 = _content_x(band)
                tmpl = band[:, cx0:cx1]
                if tmpl.shape[0] >= 2 and tmpl.shape[1] >= 2:
                    atlas.setdefault(char, []).append(tmpl.copy())
        return cls(atlas)

    def _score_at(self, band: np.ndarray, char: str, lo: int, hi: int) -> float | None:
        """Best sliding score of taught ``char`` in the band's ``[lo, hi]`` window (None if
        the char is untaught -> no baseline to compare against)."""
        templates = self._atlas.get(char)
        if not templates:
            return None
        return max(_slide(band, t, lo, hi) for t in templates)

    def _best_at(self, band: np.ndarray, lo: int, hi: int) -> tuple[str | None, float]:
        """Best-matching taught character in the band's ``[lo, hi]`` window + its score."""
        best_char, best = None, -1.0
        for char, templates in self._atlas.items():
            s = max(_slide(band, t, lo, hi) for t in templates)
            if s > best:
                best_char, best = char, s
        return best_char, best

    def refine(self, text: str, bgr_crop: np.ndarray) -> str:
        """Return ``text`` with glyph confusions corrected against the atlas.

        Conservative by construction: the OCR char must itself be a taught glyph (so there is
        a baseline to beat), and a different taught glyph must out-score it AT THE SAME
        POSITION by ``_MARGIN`` while itself clearing ``_MIN_SCORE``. Any shortfall leaves the
        character exactly as OCR read it."""
        if not text or not self._atlas or bgr_crop is None:
            return text
        core_idx = [i for i, c in enumerate(text) if not c.isspace()]
        if not core_idx:
            return text
        bin_ = _binary(bgr_crop)
        if bin_ is None:
            return text
        band = _text_band(bin_)
        spans = _positions(band, len(core_idx))
        if spans is None:
            return text   # can't anchor character positions -> refuse to guess
        out = list(text)
        for k, ti in enumerate(core_idx):
            ch = text[ti]
            lo, hi = spans[k]
            base = self._score_at(band, ch, lo, hi)
            if base is None:
                continue                       # OCR char untaught -> no baseline -> leave it
            best_char, best = self._best_at(band, lo, hi)
            if best_char is not None and best_char != ch and best >= _MIN_SCORE and best - base >= _MARGIN:
                out[ti] = best_char
        return "".join(out)


def glyph_atlas(glyphs, load_glyph) -> GlyphMatcher | None:
    """Build a :class:`GlyphMatcher` from a profile's ``glyphs`` (:class:`GlyphDef` list) and
    a ``load_glyph(name) -> BGR ndarray | None`` loader (knows the captures dir). Returns
    None when nothing is taught, so the reader skips refinement entirely."""
    samples: dict[str, list[np.ndarray]] = {}
    for g in (glyphs or []):
        img = load_glyph(g.image)
        if img is not None:
            samples.setdefault(g.char, []).append(img)
    if not samples:
        return None
    matcher = GlyphMatcher.build(samples)
    return matcher if matcher else None
