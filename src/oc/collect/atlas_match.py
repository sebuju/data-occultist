"""Taught cutout atlas: post-OCR glyph refinement AND whole-box symbol classification, both
matched by template correlation against a game-authored atlas of small reference crops.

The dictionary/lexicon layer corrects a *word* by snapping it to a known term — but it is
helpless when two readings are BOTH valid vocabulary (e.g. relic codes "Lith Q3" and "Lith G3"
both exist, so a Q<->G confusion is un-disambiguable by fuzzy match). The glyph must be settled
at the PIXEL level. Some fields aren't text at all — a mod's school glyph is one of a small
fixed set of icons (Madurai/Vazarin/Naramon/...) that must be recognised by matching the WHOLE
box against taught references, colour-agnostically (the same glyph renders grey/red/green
depending on polarity state).

:class:`AtlasMatcher` does both, teachably: the game teaches how each character or icon looks
(:class:`~oc.profile.models.CutoutDef`, authored in the UI), and

* a field marked ``glyph_check`` has its OCR'd characters matched against the GLYPH-kind
  entries — a character is substituted ONLY when a *different* taught glyph out-scores the
  OCR's own at that position by a margin, never a guess (:meth:`refine`);
* a field of ``type: symbol`` has its whole box matched against the SYMBOL-kind entries — the
  best-scoring label is the value, or none when nothing clears the threshold
  (:meth:`classify`).

The two kinds share teaching, storage and the match kernel but NEVER compete against each
other — a school icon must not be offered as a glyph-refinement candidate and vice versa.

Both are colour-agnostic via :func:`_binary` (Otsu binarise, minority class forced to white),
which collapses grey/red/green renderings of the same glyph to the same binary shape.

Glyph matching is done by SLIDING each taught template (scaled to the read's text-band height)
across the band and taking the peak normalised cross-correlation, NOT by cropping fixed glyph
cells. This font's intra- and inter-glyph column gaps overlap, so fixed segmentation mis-merges
strokes into blobs; a sliding match is immune to that — it finds a glyph wherever it sits.
Rough positions (equal-spaced then snapped to ink valleys, :func:`_positions`) only anchor WHICH
read character a detection belongs to; the sliding tolerates their imprecision.

Symbol matching classifies the whole box (no text-band isolation — an icon isn't a text row):
each taught template is scaled to fit the crop (:func:`~oc.collect.matchcore.ncc_scaled`) and
the best-scoring label wins.

There is ZERO game knowledge here — which glyphs/symbols exist and what they look like is data.
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
# A symbol classification must clear this NCC score, or nothing is trusted enough to report —
# the box is left unclassified (a key part stays unread; a readout is omitted) rather than
# guessing. Separate constant from _MIN_SCORE: a whole-icon match and a single-glyph match
# have different score distributions.
_MIN_SCORE_SYMBOL = 0.5
# A crop with less inked area than this fraction has nothing to classify (blank/near-blank —
# an occluded box, no icon rendered) -> refuse to guess rather than risk a spurious match. This
# also guards a real OpenCV quirk: TM_CCOEFF_NORMED on a near-constant (flat) crop is a 0/0
# normalisation that can return a bogus near-1.0 "match" against ANY template.
_MIN_INK_FRAC = 0.01
# A row counts as "ink" when its foreground pixel count exceeds this fraction of the band's
# peak — separates the (dim, gradient) glow band above relic text from the text row itself.
_ROW_INK = 0.18
# Each character boundary is seeded at equal spacing (this font is near-monospace) then snapped
# to the lowest-ink column within +/- this fraction of the per-char step — nudging the cut off a
# glyph's centre and into the valley between glyphs, without ever failing to make n pieces.
_SNAP_FRAC = 0.35
# When sliding a template around a character's rough position, search this much either side of
# its span (as a fraction of band height) — enough slack to absorb segmentation error.
_SLIDE_SLACK = 0.6


def _binary(bgr: np.ndarray) -> np.ndarray | None:
    """BGR crop -> binary uint8 (0/255) with the TEXT/ICON as white (255) on black.

    Otsu splits fore/background; we then force the foreground to be the minority class
    (text/icon ink is fewer pixels than its backdrop), so bright-on-dark and the rare
    dark-on-bright both come out white-on-black — this is what makes matching colour-agnostic:
    a grey, red, or green glyph on the same backdrop binarises to the same shape."""
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


def segment_boxes(bgr: np.ndarray, n: int) -> list[tuple[int, int, int, int]] | None:
    """Split a BGR word crop into ``n`` single-glyph pixel boxes ``(x, y, w, h)`` in the crop's
    own coordinates, left-to-right (the auto-glypher: one word -> a box per character). Uses the
    same text-band isolation + count-driven positioning as :meth:`AtlasMatcher.refine`, so the
    boxes hug the text row. Returns None when it can't make ``n`` pieces."""
    bin_ = _binary(bgr)
    if bin_ is None or n <= 0:
        return None
    lo, hi = _band_range(bin_)
    band = bin_[lo:hi, :]
    spans = _positions(band, n)
    if spans is None:
        return None
    return [(x0, lo, x1 - x0, hi - lo) for x0, x1 in spans]


def segment_word(bgr: np.ndarray, n: int) -> list[np.ndarray] | None:
    """Split a BGR word crop into ``n`` single-glyph BGR crops, left-to-right. Thin wrapper over
    :func:`segment_boxes` that materialises each box into a crop. Returns None on failure."""
    boxes = segment_boxes(bgr, n)
    if boxes is None:
        return None
    return [bgr[y : y + h, x : x + w] for x, y, w, h in boxes]


def _content_x(band: np.ndarray) -> tuple[int, int]:
    """The inked x-extent of a band (trim blank left/right margins)."""
    cols = (band > 0).sum(axis=0)
    nz = np.flatnonzero(cols)
    return (int(nz[0]), int(nz[-1]) + 1) if nz.size else (0, band.shape[1])


def _ink_bbox(bin_: np.ndarray) -> np.ndarray:
    """Trim a binary image to its inked bounding box (both axes) — an icon isn't a text row, so
    unlike glyph matching there's no font baseline to isolate; just tighten to the content."""
    rows = np.flatnonzero((bin_ > 0).any(axis=1))
    cols = np.flatnonzero((bin_ > 0).any(axis=0))
    if rows.size == 0 or cols.size == 0:
        return bin_
    return bin_[rows[0] : rows[-1] + 1, cols[0] : cols[-1] + 1]


def _positions(band: np.ndarray, n: int) -> list[tuple[int, int]] | None:
    """Rough x-span per character. Seed the ``n-1`` boundaries at EQUAL spacing across the
    inked content (this font is near-monospace, so equal cuts land close) then snap each to
    the lowest-ink column within a local window — sliding the boundary off a glyph body into
    the valley beside it. Unlike pure gap-detection this always makes ``n`` pieces (relic
    intra-/inter-glyph gaps overlap, so gap-detection either finds too few or cuts mid-glyph).

    For :meth:`AtlasMatcher.refine` these only anchor which read character a sliding detection
    belongs to (edges are forgiven by the slide); for the auto-glypher they are the per-char
    crops themselves. Returns None only when the content is too narrow for ``n`` pieces."""
    if n <= 0:
        return None
    x0, x1 = _content_x(band)
    width = x1 - x0
    if width < n:                                # can't carve n non-empty columns
        return None
    if n == 1:
        return [(x0, x1)]
    ink = (band[:, x0:x1] > 0).sum(axis=0).astype(np.float64)   # per-column ink, content-relative
    step = width / n
    snap = max(1, round(step * _SNAP_FRAC))
    cuts, prev = [], 0
    for i in range(1, n):
        seed = round(i * step)
        a = max(prev + 1, seed - snap)
        b = min(width - 1, seed + snap + 1)
        c = seed if a >= b else a + int(np.argmin(ink[a:b]))
        c = min(max(c, prev + 1), width - (n - i))   # strictly increasing, leaving room for the rest
        cuts.append(c)
        prev = c
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


def _shape_ncc(crop: np.ndarray, template: np.ndarray) -> float:
    """Whole-shape NCC: resize ``template`` to ``crop``'s EXACT size (not merely to fit inside
    it) before correlating, so ``matchTemplate`` returns ONE global comparison instead of
    sliding a smaller template around looking for a locally-similar patch. A sliding search
    (as glyph refinement wants, and as item template tells tolerate) would happily find a
    plain filled region inside a differently-shaped icon and falsely "match" it — classifying
    a whole icon needs the two shapes compared as wholes, not best-effort located."""
    ch, cw = crop.shape[:2]
    if template.shape[:2] != (ch, cw):
        template = cv2.resize(template, (cw, ch), interpolation=cv2.INTER_AREA)
    res = cv2.matchTemplate(crop.astype(np.float32), template.astype(np.float32), cv2.TM_CCOEFF_NORMED)
    return float(res[0, 0])


def _build_glyph_pool(samples: dict[str, list[np.ndarray]]) -> dict[str, list[np.ndarray]]:
    """From ``{char: [BGR crop, …]}`` build the atlas of binary TEXT-BAND-trimmed templates."""
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
    return atlas


def _build_symbol_pool(samples: dict[str, list[np.ndarray]]) -> dict[str, list[np.ndarray]]:
    """From ``{label: [BGR crop, …]}`` build the atlas of binary INK-BBOX-trimmed templates
    (no text-band isolation — an icon isn't a font row)."""
    atlas: dict[str, list[np.ndarray]] = {}
    for label, crops in samples.items():
        if not label:
            continue
        for crop in crops:
            bin_ = _binary(crop)
            if bin_ is None:
                continue
            tmpl = _ink_bbox(bin_)
            if tmpl.shape[0] >= 2 and tmpl.shape[1] >= 2:
                atlas.setdefault(label, []).append(tmpl.copy())
    return atlas


class AtlasMatcher:
    """Holds the taught cutout atlas — two independent pools, glyph and symbol — and both
    refines an OCR string (glyph pool) and classifies a whole box (symbol pool)."""

    def __init__(self, glyphs: dict[str, list[np.ndarray]], symbols: dict[str, list[np.ndarray]]) -> None:
        self._glyphs = {c: t for c, t in glyphs.items() if t}
        self._syms = {label: t for label, t in symbols.items() if t}

    def __bool__(self) -> bool:
        return bool(self._glyphs) or bool(self._syms)

    @classmethod
    def build(cls, glyph_samples: dict[str, list[np.ndarray]] | None = None,
              symbol_samples: dict[str, list[np.ndarray]] | None = None) -> "AtlasMatcher":
        """From ``{char/label: [BGR crop, …]}`` per pool, build the atlas of binary templates.
        Unusable crops are skipped."""
        return cls(_build_glyph_pool(glyph_samples or {}), _build_symbol_pool(symbol_samples or {}))

    # ---- glyph refinement (per-character, sliding match within a text band) --------------

    def _score_at(self, band: np.ndarray, char: str, lo: int, hi: int) -> float | None:
        """Best sliding score of taught ``char`` in the band's ``[lo, hi]`` window (None if
        the char is untaught -> no baseline to compare against)."""
        templates = self._glyphs.get(char)
        if not templates:
            return None
        return max(_slide(band, t, lo, hi) for t in templates)

    def _best_at(self, band: np.ndarray, lo: int, hi: int) -> tuple[str | None, float]:
        """Best-matching taught character in the band's ``[lo, hi]`` window + its score."""
        best_char, best = None, -1.0
        for char, templates in self._glyphs.items():
            s = max(_slide(band, t, lo, hi) for t in templates)
            if s > best:
                best_char, best = char, s
        return best_char, best

    def refine(self, text: str, bgr_crop: np.ndarray) -> str:
        """Return ``text`` with glyph confusions corrected against the glyph pool.

        Conservative by construction: the OCR char must itself be a taught glyph (so there is
        a baseline to beat), and a different taught glyph must out-score it AT THE SAME
        POSITION by ``_MARGIN`` while itself clearing ``_MIN_SCORE``. Any shortfall leaves the
        character exactly as OCR read it."""
        if not text or not self._glyphs or bgr_crop is None:
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

    # ---- symbol classification (whole-box, scale-to-fit match) ---------------------------

    def classify(self, bgr_crop: np.ndarray) -> tuple[str, float]:
        """Classify a whole box against the symbol pool -> ``(label, score)``, or ``("", 0.0)``
        when nothing clears ``_MIN_SCORE_SYMBOL`` — never a guess (an unclassified box drops a
        key field's record / omits a readout, same as any other unread value)."""
        if bgr_crop is None or not self._syms:
            return "", 0.0
        bin_ = _binary(bgr_crop)
        if bin_ is None or float((bin_ > 0).mean()) < _MIN_INK_FRAC:
            return "", 0.0   # blank/near-blank crop: nothing to classify, never guess
        crop = _ink_bbox(bin_)
        best_label, best = None, -1.0
        for label, templates in self._syms.items():
            s = max(_shape_ncc(crop, t) for t in templates)
            if s > best:
                best_label, best = label, s
        if best_label is not None and best >= _MIN_SCORE_SYMBOL:
            return best_label, best
        return "", 0.0


def build_atlas(cutouts, load_image) -> AtlasMatcher | None:
    """Build an :class:`AtlasMatcher` from a profile's ``atlas`` (:class:`CutoutDef` list) and
    an ``load_image(name) -> BGR ndarray | None`` loader (knows the captures dir). Splits
    cutouts into the glyph/symbol pools by ``kind``. Returns None when nothing is taught, so
    the reader skips both refinement and classification entirely."""
    glyph_samples: dict[str, list[np.ndarray]] = {}
    symbol_samples: dict[str, list[np.ndarray]] = {}
    for c in (cutouts or []):
        if not getattr(c, "enabled", True):
            continue   # muted sample: kept in the profile/UI but excluded from the matcher
        img = load_image(c.image)
        if img is None:
            continue
        pool = symbol_samples if getattr(c, "kind", "glyph") == "symbol" else glyph_samples
        pool.setdefault(c.label, []).append(img)
    if not glyph_samples and not symbol_samples:
        return None
    matcher = AtlasMatcher.build(glyph_samples, symbol_samples)
    return matcher if matcher else None
