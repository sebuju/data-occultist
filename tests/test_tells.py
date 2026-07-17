"""Colour tell scoring — the largest-contiguous-region metric (not raw near-pixel fraction)."""

import numpy as np

from oc.collect.tells import border_score, color_score

WHITE = "#ffffff"


def _blank(h=50, w=50):
    return np.zeros((h, w, 3), np.uint8)


def test_color_score_is_largest_contiguous_area():
    # a SOLID 10x10 white block -> one 100-px region -> 100/2500 = 0.04
    solid = _blank()
    solid[20:30, 20:30] = 255
    # the SAME 100 white pixels, scattered on a spaced grid so none touch -> largest region = 1 px
    scattered = _blank()
    ys, xs = np.meshgrid(np.arange(0, 50, 5), np.arange(0, 50, 5))   # 10x10 = 100 isolated pixels
    scattered[ys.ravel(), xs.ravel()] = 255
    s_solid = color_score(solid, WHITE, 30)
    s_scatter = color_score(scattered, WHITE, 30)
    assert abs(s_solid - 0.04) < 1e-6                 # the whole contiguous block counts
    assert s_scatter < 0.001                          # a lone pixel is the biggest "region"
    assert s_solid > s_scatter * 30                   # same near-pixel COUNT, vastly different score


def test_color_score_zero_when_nothing_near():
    assert color_score(_blank(), WHITE, 30) == 0.0    # all black, nothing near white


def test_border_score_is_largest_contiguous_arc_on_the_ring():
    # a solid white top edge (a contiguous arc on the perimeter) scores high...
    arc = _blank()
    arc[0:3, :] = 255
    # ...scattered single pixels around the ring score low despite similar count
    speck = _blank()
    speck[0, ::6] = 255
    a = border_score(arc, WHITE, 30, width=0.1)
    b = border_score(speck, WHITE, 30, width=0.1)
    assert a > 0.15
    assert b < a / 5
