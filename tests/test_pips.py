from pathlib import Path

import cv2
import numpy as np

from oc.collect.pips import count_pips

FIXTURES = Path(__file__).parent / "fixtures"


def test_counts_bright_dots():
    img = np.zeros((40, 200, 3), np.uint8)
    for cx in (20, 50, 80, 110, 140):           # 5 lit pips
        cv2.circle(img, (cx, 20), 4, (255, 255, 255), -1)
    assert count_pips(img) == 5


def test_zero_when_dark():
    assert count_pips(np.zeros((40, 200, 3), np.uint8)) == 0


def test_ignores_tiny_noise():
    img = np.zeros((40, 200, 3), np.uint8)
    img[10, 10] = (255, 255, 255)               # single-pixel speck, below min_pip_h
    assert count_pips(img) == 0


def test_pips_touching_on_a_line_are_split():
    # 10 pips strung on a continuous 2px glow line — the case that fuses under blob-counting.
    img = np.zeros((30, 320, 3), np.uint8)
    img[14:16, 10:310] = (200, 160, 120)        # the thin connecting line
    for i in range(10):                          # 10 tall pips, touching (no dark gap)
        cx = 25 + i * 30
        cv2.circle(img, (cx, 15), 11, (255, 230, 200), -1)
    assert count_pips(img) == 10


def test_real_rank10_strip():
    # a real Warframe arsenal rank strip: a maxed (10-pip) mod on its glow line
    img = cv2.imread(str(FIXTURES / "pips_rank10.png"))
    assert img is not None
    assert count_pips(img) == 10


def test_real_rank5_strip():
    img = cv2.imread(str(FIXTURES / "pips_rank5.png"))
    assert img is not None
    assert count_pips(img) == 5
