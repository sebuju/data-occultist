import numpy as np

from oc.collect.scrollbar import scroll_position


def _track(thumb_at, length=100, thumb=12):
    img = np.full((length, 8, 3), 40, np.uint8)        # dark track
    img[thumb_at:thumb_at + thumb] = 220               # bright thumb
    return img


def test_thumb_top():
    assert scroll_position(_track(0)) < 0.2


def test_thumb_bottom():
    assert scroll_position(_track(88)) > 0.8


def test_thumb_middle():
    p = scroll_position(_track(44))
    assert 0.4 < p < 0.6


def test_empty():
    assert scroll_position(np.zeros((0, 0, 3), np.uint8)) is None
