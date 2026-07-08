"""Taught cutout atlas: glyph refinement + symbol classification — pure logic, synthetic data.

Glyph refinement: a taught atlas corrects a pixel-distinct confusion the dictionary can't,
teaches two clearly-different rendered characters, then asserts a crop whose pixels are one
character is corrected when OCR claimed the other, while conservative guards (unsegmentable
input, untaught OCR char, empty atlas) never guess. The real-font Q<->G proof runs offline
against captured relic frames; this pins the LOGIC.

Symbol classification: a taught icon atlas (e.g. a mod school glyph) is matched whole-box,
colour-agnostically (grey/red/green all binarise to the same shape), and the two pools
(glyph vs symbol) never compete against each other.
"""

from __future__ import annotations

import cv2
import numpy as np

from oc.collect.atlas_match import AtlasMatcher


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
    return AtlasMatcher.build(glyph_samples={a: [_glyph(a)], b: [_glyph(b)]})


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
    m = AtlasMatcher.build()
    assert not m
    assert m.refine("Q3", _row_of([_glyph("Q")])) == "Q3"
    assert m.classify(_glyph("Q")) == ("", 0.0)


def test_glow_band_above_text_is_ignored():
    m = _atlas("H", "O")
    crop = _row_of([_glyph("H"), _glyph("O")])
    # a dim gradient band glued on top (relic reveal glow) must not defeat text-band isolation
    glow = np.full((30, crop.shape[1], 3), 70, dtype=np.uint8)
    assert m.refine("OO", np.vstack([glow, crop])) == "HO"


# ---- symbol classification ------------------------------------------------------------

def _icon(shape, color=(255, 255, 255), size=64):
    """A simple OUTLINED shape on black — a stand-in for a mod school glyph (real school
    icons are line-art, not solid blobs). Outlined so the shape's interior stays black,
    giving genuine internal structure to discriminate on — a SOLID fill's interior is flat/
    constant regardless of silhouette, which defeats shape matching entirely. ``shape`` is
    "square", "circle", or "plus" so taught templates are visually distinct."""
    img = np.zeros((size, size, 3), dtype=np.uint8)
    c = size // 2
    if shape == "square":
        cv2.rectangle(img, (c - 20, c - 20), (c + 20, c + 20), color, 4)
    elif shape == "circle":
        cv2.circle(img, (c, c), 22, color, 4)
    else:   # "plus"
        cv2.line(img, (c, c - 22), (c, c + 22), color, 6)
        cv2.line(img, (c - 22, c), (c + 22, c), color, 6)
    return img


def _symbol_atlas():
    return AtlasMatcher.build(symbol_samples={
        "Madurai": [_icon("square")],
        "Vazarin": [_icon("circle")],
        "Naramon": [_icon("plus")],
    })


def test_classify_picks_the_matching_label():
    m = _symbol_atlas()
    label, score = m.classify(_icon("circle"))
    assert label == "Vazarin"
    assert score >= 0.5


def test_classify_is_colour_agnostic():
    # taught in white, matched against a differently-coloured (red) rendering of the SAME
    # shape — the school glyph changes colour with polarity state in-game.
    m = AtlasMatcher.build(symbol_samples={"Madurai": [_icon("square", color=(255, 255, 255))]})
    label, _score = m.classify(_icon("square", color=(0, 0, 255)))
    assert label == "Madurai"
    label_green, _ = m.classify(_icon("square", color=(0, 200, 0)))
    assert label_green == "Madurai"


def test_classify_refuses_to_guess_on_unrelated_crop():
    m = _symbol_atlas()
    blank = np.zeros((64, 64, 3), dtype=np.uint8)   # nothing drawn -> no ink to match at all
    assert m.classify(blank) == ("", 0.0)


def test_glyph_and_symbol_pools_never_cross_match():
    # a glyph-kind "O" and a symbol-kind "circle" look similar, but classify() must only ever
    # consult the symbol pool and refine() only the glyph pool.
    m = AtlasMatcher.build(glyph_samples={"O": [_glyph("O")]},
                           symbol_samples={"Vazarin": [_icon("circle")]})
    label, _score = m.classify(_icon("circle"))
    assert label == "Vazarin"          # never "O"
    refined = m.refine("O", _glyph("O"))
    assert refined == "O"              # unaffected by the symbol pool being present too
