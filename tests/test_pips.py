import cv2
import numpy as np

from oc.collect.pips import count_pips


def test_counts_bright_dots():
    img = np.zeros((40, 200, 3), np.uint8)
    for cx in (20, 50, 80, 110, 140):           # 5 lit pips
        cv2.circle(img, (cx, 20), 4, (255, 255, 255), -1)
    assert count_pips(img) == 5


def test_zero_when_dark():
    assert count_pips(np.zeros((40, 200, 3), np.uint8)) == 0


def test_ignores_tiny_noise():
    img = np.zeros((40, 200, 3), np.uint8)
    img[10, 10] = (255, 255, 255)               # single-pixel speck, below min_area
    assert count_pips(img) == 0
