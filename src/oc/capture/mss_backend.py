"""Screen capture via :mod:`mss` (fast, cross-platform)."""

from __future__ import annotations

import threading
from collections.abc import Sequence

import cv2
import mss
import numpy as np

from ..interfaces import CaptureBackend
from ..registry import register_capture
from ..types import Frame, PixelBox, WindowInfo
from .regions import strip_spans


@register_capture("mss")
class MssCaptureBackend(CaptureBackend):
    def __init__(self) -> None:
        # One mss instance is not thread-safe, but per-grab construction cost ~10-15ms; the
        # shared engine.capture is hit from several long-lived threads (collector, precapture,
        # web workers), so keep ONE persistent instance PER THREAD instead.
        self._local = threading.local()

    def _sct(self) -> mss.MSS:
        sct = getattr(self._local, "sct", None)
        if sct is None:
            sct = self._local.sct = mss.MSS()
        return sct

    def _drop_sct(self) -> None:
        sct = getattr(self._local, "sct", None)
        self._local.sct = None
        if sct is not None:
            try:
                sct.close()
            except Exception:   # noqa: BLE001 - a dead handle failing to close is fine
                pass

    def _grab_bgr(self, box: PixelBox) -> np.ndarray:
        region = {"left": box.x, "top": box.y, "width": box.w, "height": box.h}
        try:
            shot = self._sct().grab(region)
        except Exception:   # noqa: BLE001
            # A persistent handle can go stale on a display-config change (resolution
            # switch, monitor unplug) — rebuild the instance and retry once.
            self._drop_sct()
            shot = self._sct().grab(region)
        # mss returns BGRA; drop alpha, keep BGR for OpenCV. cvtColor over a strided
        # [:, :, :3].copy() — ~9x cheaper at 4K (SIMD vs strided copy).
        return cv2.cvtColor(np.asarray(shot), cv2.COLOR_BGRA2BGR)

    def grab(self, box: PixelBox) -> Frame:
        return Frame(image=self._grab_bgr(box), client=box)

    def grab_window(self, window: WindowInfo) -> Frame:
        return self.grab(window.client)

    def grab_window_regions(self, window: WindowInfo, boxes: Sequence[PixelBox]) -> Frame:
        # A grab's cost is dominated by a fixed per-call ~6-7ms (DWM sync), not area —
        # so grab a few full-width strips covering the boxes, never one grab per box
        # (see capture/regions.py for the measurements).
        c = window.client
        spans = strip_spans(boxes, c.h)
        if spans is None:
            return self.grab_window(window)
        canvas = np.zeros((c.h, c.w, 3), np.uint8)
        for y0, y1 in spans:
            canvas[y0:y1] = self._grab_bgr(PixelBox(c.x, c.y + y0, c.w, y1 - y0))
        return Frame(image=canvas, client=c)
