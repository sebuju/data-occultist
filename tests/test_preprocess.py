"""OCR crop preprocess — colour mask (incl. the int-overflow guard) and upscale. Pure logic."""

import numpy as np

from oc.collect.preprocess import apply
from oc.profile.models import Preprocess, PreprocessMode


def _img(bgr, h=4, w=4):
    a = np.empty((h, w, 3), np.uint8)
    a[:, :] = bgr
    return a


def test_color_mask_keeps_taught_colour_as_black_on_white():
    # a white crop, mask on white -> the pixels are KEPT (rendered black glyph on white bg).
    out = apply(_img((255, 255, 255)), Preprocess(mode=PreprocessMode.color, colors=["#ffffff"], tolerance=60))
    assert (out == 0).all()


def test_color_mask_high_contrast_no_int_overflow():
    # THE overflow guard: a full-255 per-channel diff (white target vs black pixel) squares to
    # 65025, which overflows int16 -> a negative sum -> NaN distance that would WRONGLY keep the
    # pixel. With int32 the distance (~441) correctly exceeds tolerance, so black is dropped to
    # the white background. This is exactly the case that matters: white HUD text on a dark bg.
    out = apply(_img((0, 0, 0)), Preprocess(mode=PreprocessMode.color, colors=["#ffffff"], tolerance=60))
    assert (out == 255).all()   # black pixels are NOT within tolerance of white -> background


def test_color_mask_within_tolerance_band():
    # a near-white pixel (diff ~30) is kept; a mid-grey (diff ~380) is dropped.
    near = apply(_img((235, 235, 235)), Preprocess(mode=PreprocessMode.color, colors=["#ffffff"], tolerance=60))
    grey = apply(_img((128, 128, 128)), Preprocess(mode=PreprocessMode.color, colors=["#ffffff"], tolerance=60))
    assert (near == 0).all()
    assert (grey == 255).all()


def test_color_mask_skips_empty_or_bad_hex():
    # the UI can hold a blank / half-typed colour row — it must be skipped, not crash on int("",16).
    out = apply(_img((255, 255, 255)), Preprocess(mode=PreprocessMode.color, colors=["", "#zzz", "#ffffff"], tolerance=60))
    assert (out == 0).all()   # the one valid colour (white) still masks; the junk rows are ignored


def test_scale_upscales_crop():
    out = apply(_img((10, 20, 30), h=8, w=10), Preprocess(mode=PreprocessMode.none, scale=2))
    assert out.shape[:2] == (16, 20)


def test_none_mode_is_identity():
    src = _img((10, 20, 30))
    out = apply(src, Preprocess(mode=PreprocessMode.none, scale=1.0))
    assert np.array_equal(out, src)
