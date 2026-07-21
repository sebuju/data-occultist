"""Feed-saved-images replay: filename timestamp parsing + the ReplayCapture virtual clock."""

import time
from datetime import datetime

import cv2
import numpy as np
import pytest

from oc.collect.replay import ReplayCapture, ReplayProcess, ReplayWindow, parse_stamp
from oc.types import PixelBox, WindowInfo


def _write_jpg(path, val):
    img = np.full((4, 4, 3), val, dtype=np.uint8)
    cv2.imwrite(str(path), img)


def test_parse_stamp_matches_save_scheme():
    ts = parse_stamp("20260721-143005-123456.jpg")
    assert ts == datetime(2026, 7, 21, 14, 30, 5, 123456)


def test_parse_stamp_rejects_junk():
    assert parse_stamp("not-a-stamp.jpg") is None
    assert parse_stamp("thumb.png") is None


def test_replay_advances_on_virtual_clock(tmp_path):
    # two images 0.2s apart in recorded time
    p0, p1 = tmp_path / "a.jpg", tmp_path / "b.jpg"
    _write_jpg(p0, 10)
    _write_jpg(p1, 200)
    t0 = datetime(2026, 7, 21, 12, 0, 0, 0)
    t1 = datetime(2026, 7, 21, 12, 0, 0, 200000)   # +0.2s
    cap = ReplayCapture([(t0, p0), (t1, p1)])
    win = WindowInfo(handle=1, title="x", pid=1, client=PixelBox(0, 0, 4, 4))  # ignored by replay

    # first grab -> the oldest image, clock seeded, not yet exhausted
    f0 = cap.grab_window(win)
    assert int(f0.image[0, 0, 0]) == 10
    assert cap.index == 1 and cap.total == 2
    assert not cap.exhausted

    # after the span + tail elapses, the clock reaches the last image and then exhausts
    time.sleep(0.25)
    f1 = cap.grab_window(win)
    assert int(f1.image[0, 0, 0]) == 200
    assert cap.index == 2
    time.sleep(0.5)   # past span + _TAIL
    cap.grab_window(win)
    assert cap.exhausted


def test_seconds_to_next_and_skip(tmp_path):
    p0, p1 = tmp_path / "a.jpg", tmp_path / "b.jpg"
    _write_jpg(p0, 10)
    _write_jpg(p1, 200)
    t0 = datetime(2026, 7, 21, 12, 0, 0, 0)
    t1 = datetime(2026, 7, 21, 12, 0, 5, 0)   # +5s — a long wait to the next image
    cap = ReplayCapture([(t0, p0), (t1, p1)])
    win = WindowInfo(handle=1, title="x", pid=1, client=PixelBox(0, 0, 4, 4))

    cap.grab_window(win)                       # seed clock at the first image
    w = cap.seconds_to_next()
    assert w is not None and 4.0 < w <= 5.0    # ~5s until the next image

    cap.skip()                                 # jump the clock to the next image
    assert cap.seconds_to_next() <= 0.05       # next is due now
    f = cap.grab_window(win)
    assert int(f.image[0, 0, 0]) == 200        # advanced to the second image
    assert cap.seconds_to_next() is None       # last image -> nothing to wait for
    cap.skip()                                 # no-op at the last image (must not raise)


def test_replay_needs_at_least_one_image():
    with pytest.raises(ValueError):
        ReplayCapture([])


def test_replay_window_and_process_are_synthetic():
    w = ReplayWindow((1920, 1080))
    info = w.from_handle(999)
    assert info.client.w == 1920 and info.client.h == 1080
    assert w.is_foreground(info) is True
    assert w.find_for_pid(5) is info and w.find_by_title("anything") is info

    proc = ReplayProcess(["Warframe.x64.exe"])
    assert proc.find_by_names(["whatever"]).name == "Warframe.x64.exe"
    assert ReplayProcess([]).find_by_names([]).name == "replay"
