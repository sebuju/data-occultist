"""Screen capture via :mod:`mss` (fast, cross-platform)."""

from __future__ import annotations

import mss
import numpy as np

from ..interfaces import CaptureBackend
from ..registry import register_capture
from ..types import Frame, PixelBox, WindowInfo


@register_capture("mss")
class MssCaptureBackend(CaptureBackend):
    def __init__(self) -> None:
        # One mss instance is not thread-safe; create per grab to stay simple.
        pass

    def grab(self, box: PixelBox) -> Frame:
        region = {"left": box.x, "top": box.y, "width": box.w, "height": box.h}
        with mss.mss() as sct:
            shot = sct.grab(region)
        # mss returns BGRA; drop alpha, keep BGR for OpenCV.
        img = np.asarray(shot)[:, :, :3].copy()
        return Frame(image=img, client=box)

    def grab_window(self, window: WindowInfo) -> Frame:
        return self.grab(window.client)
