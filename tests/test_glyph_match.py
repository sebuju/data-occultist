"""Glyph refinement: a taught atlas corrects a pixel-distinct confusion the dictionary can't.

Synthetic, deterministic, no game data — teaches two clearly-different rendered characters,
then asserts a crop whose pixels are one character is corrected when OCR claimed the other,
while conservative guards (unsegmentable input, untaught OCR char, empty atlas) never guess.

The real-font Q<->G proof runs offline against captured relic frames; this pins the LOGIC.
"""

from __future__ import annotations

import cv2
import numpy as np

from oc.collect.glyph_match import GlyphMatcher


def _glyph(ch, size=72):
    """A single character rendered white-on-black (a distinct, realistic glyph)."""
    img = np.zeros((size, size, 3), dtype=np.uint8)
    cv2.putText(img, ch, (12, size - 16), cv2.FONT_HERSHEY_SIMPLEX, 2.0, (255, 255, 255), 4, cv2.LINE_AA)
    return img


def _row_of(glyphs, gap=26, pad=14):
    """Lay BGR glyph crops left-to-right on black with clear gaps between them."""
    h = max(g.shape[0] for g in glyphs) + pad * 2
    xs, x = [], pad
    for g in glyphs:
        xs.append(x)
        x += g.shape[1] + gap
    w = max(x0 + g.shape[1] for x0, g in zip(xs, glyphs)) + pad
    canvas = np.zeros((h, w, 3), dtype=np.uint8)
    for x0, g in zip(xs, glyphs):
        gh, gw = g.shape[:2]
        canvas[pad : pad + gh, x0 : x0 + gw] = g
    return canvas


def _atlas(a="H", b="O"):
    return GlyphMatcher.build({a: [_glyph(a)], b: [_glyph(b)]})


def test_corrects_confused_glyph_against_atlas():
    m = _atlas("H", "O")
    crop = _row_of([_glyph("H"), _glyph("O")])   # pixels are H then O
    assert m.refine("OO", crop) == "HO"          # first glyph corrected O->H, second kept


def test_correct_read_is_left_untouched():
    m = _atlas("H", "O")
    crop = _row_of([_glyph("O"), _glyph("H")])    # pixels are O then H, and OCR agrees
    assert m.refine("OH", crop) == "OH"


def test_unsegmentable_input_refuses_to_guess():
    m = _atlas("H", "O")
    crop = _row_of([_glyph("O")])                 # ONE glyph, but the string claims two
    assert m.refine("OO", crop) == "OO"           # can't anchor 2 positions -> untouched


def test_untaught_ocr_char_is_left_alone():
    m = _atlas("H", "O")
    crop = _row_of([_glyph("H"), _glyph("O")])
    # OCR char 'X' has no taught template -> no baseline -> not substituted even though the
    # pixels match H; the second (a taught 'O' that agrees) also stays.
    assert m.refine("XO", crop) == "XO"


def test_empty_atlas_is_falsy_and_passthrough():
    m = GlyphMatcher.build({})
    assert not m
    assert m.refine("Q3", _row_of([_glyph("Q")])) == "Q3"


def test_glow_band_above_text_is_ignored():
    m = _atlas("H", "O")
    crop = _row_of([_glyph("H"), _glyph("O")])
    # a dim gradient band glued on top (relic reveal glow) must not defeat text-band isolation
    glow = np.full((30, crop.shape[1], 3), 70, dtype=np.uint8)
    assert m.refine("OO", np.vstack([glow, crop])) == "HO"
