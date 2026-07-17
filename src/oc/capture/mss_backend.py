"""Screen capture via :mod:`mss` (fast, cross-platform)."""

from __future__ import annotations

import threading

import cv2
import mss
import numpy as np

from ..interfaces import CaptureBackend
from ..registry import register_capture
from ..types import Frame, PixelBox, WindowInfo


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

    def grab(self, box: PixelBox) -> Frame:
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
        img = cv2.cvtColor(np.asarray(shot), cv2.COLOR_BGRA2BGR)
        return Frame(image=img, client=box)

    def grab_window(self, window: WindowInfo) -> Frame:
        return self.grab(window.client)
