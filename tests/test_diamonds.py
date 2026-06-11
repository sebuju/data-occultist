import cv2
import numpy as np

from oc.collect.pips import count_diamonds, count_filled_diamonds


def _diamond(cx, cy, r):
    return np.array([[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]], np.int32)


def _strip():
    return np.full((40, 150, 3), 20, np.uint8)   # dark background


GOLD = (40, 120, 180)   # BGR: warm (r > b), like a Warframe rank diamond


def test_counts_only_filled_diamonds():
    img = _strip()
    cv2.fillPoly(img, [_diamond(25, 20, 14)], GOLD)     # filled (solid ~0.5 fill)
    cv2.fillPoly(img, [_diamond(75, 20, 14)], GOLD)     # filled
    cv2.polylines(img, [_diamond(125, 20, 14)], True, GOLD, 1)  # hollow outline (~0.1 fill)
    assert count_filled_diamonds(img) == 2


def test_zero_when_all_outlines():
    img = _strip()
    for cx in (25, 75, 125):
        cv2.polylines(img, [_diamond(cx, 20, 14)], True, GOLD, 1)
    assert count_filled_diamonds(img) == 0


def test_empty():
    assert count_filled_diamonds(np.full((20, 60, 3), 20, np.uint8)) == 0


def test_count_diamonds_counts_filled_and_hollow():
    img = _strip()
    cv2.fillPoly(img, [_diamond(25, 20, 14)], GOLD)             # filled
    cv2.polylines(img, [_diamond(75, 20, 14)], True, GOLD, 1)   # hollow
    cv2.polylines(img, [_diamond(125, 20, 14)], True, GOLD, 1)  # hollow
    assert count_diamonds(img) == 3                             # presence: all three


def test_count_diamonds_zero_on_plain():
    assert count_diamonds(_strip()) == 0                        # an item with no rank strip


def test_text_is_not_diamonds():
    # a name like "Receiver" landing in the rank-strip box: round glyphs (e/o/c)
    # approximate to 4-gons with midpoint vertices, so only the fill-ratio test
    # tells them from real diamond marks
    img = np.full((40, 220, 3), 20, np.uint8)
    cv2.putText(img, "Receiver", (4, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (200, 200, 200), 2)
    assert count_diamonds(img) == 0
    assert count_filled_diamonds(img) == 0


def test_disc_is_not_a_diamond():
    img = _strip()
    cv2.circle(img, (75, 20), 12, GOLD, -1)             # filled disc, e.g. a round glyph
    assert count_diamonds(img) == 0


def test_unranked_arcane_located_but_zero_filled():
    # a fully UNRANKED arcane: five hollow ◇ — the strip is detected (5 marks) yet the
    # rank reads 0. count_filled must not need a filled mark to "see" the diamonds.
    img = _strip()
    for cx in (25, 50, 75, 100, 125):
        cv2.polylines(img, [_diamond(cx, 20, 10)], True, GOLD, 1)
    assert count_diamonds(img) == 5
    assert count_filled_diamonds(img) == 0
