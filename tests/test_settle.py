"""settle.thumb / is_settled: the screen-stopped-moving gate (pure logic, no game)."""

import numpy as np

from oc.collect import settle


def _frame(val=0, shape=(2160, 3840, 3)):
    return np.full(shape, val, np.uint8)


def test_thumb_shape_and_empty():
    assert settle.thumb(None) is None
    assert settle.thumb(np.zeros((0, 0, 3), np.uint8)) is None
    th = settle.thumb(_frame(40), crop_px=settle.CROP_PX)
    assert th is not None and th.shape == (settle.THUMB, settle.THUMB)


def test_identical_frames_are_settled():
    a = settle.thumb(_frame(40), crop_px=settle.CROP_PX)
    b = settle.thumb(_frame(40), crop_px=settle.CROP_PX)
    assert settle.is_settled(a, b)


def test_first_frame_not_settled():
    a = settle.thumb(_frame(40), crop_px=settle.CROP_PX)
    assert not settle.is_settled(a, None)
    assert not settle.is_settled(None, a)


def test_big_change_is_motion():
    a = settle.thumb(_frame(20), crop_px=settle.CROP_PX)
    b = settle.thumb(_frame(220), crop_px=settle.CROP_PX)   # whole frame jumps brightness
    assert not settle.is_settled(a, b)


def test_tiny_noise_below_floor_still_settled():
    base = _frame(120)
    noisy = base.copy()
    noisy[:5, :5] = 255   # a cursor-sized twitch in one corner -> < MIN_CELLS cells move
    a = settle.thumb(base, crop_px=settle.CROP_PX)
    b = settle.thumb(noisy, crop_px=settle.CROP_PX)
    assert settle.is_settled(a, b)


def test_grayscale_input_handled():
    th = settle.thumb(_frame(60, shape=(2160, 3840)), crop_px=settle.CROP_PX)
    assert th is not None and th.shape == (settle.THUMB, settle.THUMB)
