"""A recorded video as a stand-in for the live game window.

The testing harness imports a screen-capture clip and plays it FRAME-BY-FRAME
through the same live pipeline the real window uses — so live-mode detection +
OCR can be exercised without the game running. There is exactly one source per
process (a singleton); the web panel drives it (load / seek / step / enable),
and ``preview._frame_for`` reads the current decoded frame instead of grabbing
the window when ``enabled`` is set.

Decoding is lazy and cached: the current frame is decoded once on seek/step and
held, so the per-tick detect + preview reads of live mode both see the SAME
frame (no desync from advancing on every HTTP call). Frame advance is driven by
the browser, not wall-clock, so playback rate and OCR rate stay decoupled — the
reader simply reads whichever frame is current.
"""

from __future__ import annotations

import threading

import cv2
import numpy as np


class VideoSource:
    def __init__(self) -> None:
        self._lock = threading.Lock()   # cv2.VideoCapture is not thread-safe; endpoints run in a pool
        self._cap: cv2.VideoCapture | None = None
        self._name = ""
        self._count = 0
        self._fps = 0.0
        self._index = -1
        self._image: np.ndarray | None = None   # decoded current frame (BGR), held for reuse
        self.enabled = False                     # feed live mode from this video instead of the window

    # ---- mutation (all under the lock) ------------------------------------
    def load(self, path, name: str) -> dict:
        with self._lock:
            self._close_locked()
            cap = cv2.VideoCapture(str(path))
            if not cap.isOpened():
                cap.release()
                raise ValueError(f"cannot open video: {name}")
            self._cap = cap
            self._name = name
            self._count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            self._fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
            self._index = -1
            self._decode_locked(0)
            return self._info_locked()

    def seek(self, index: int) -> dict:
        with self._lock:
            self._decode_locked(int(index))
            return self._info_locked()

    def step(self, n: int = 1) -> dict:
        with self._lock:
            self._decode_locked(self._index + int(n))
            return self._info_locked()

    def set_enabled(self, on: bool) -> dict:
        with self._lock:
            self.enabled = bool(on) and self._cap is not None
            return self._info_locked()

    def close(self) -> dict:
        with self._lock:
            self._close_locked()
            return self._info_locked()

    def status(self) -> dict:
        with self._lock:
            return self._info_locked()

    # ---- read (used by the live frame path) -------------------------------
    def current_image(self) -> np.ndarray | None:
        # The reader only reads the frame, never mutates it, so handing out the
        # held array (no copy) is safe and cheap.
        return self._image

    # ---- internals (caller holds the lock) --------------------------------
    def _decode_locked(self, index: int) -> None:
        cap = self._cap
        if cap is None:
            return
        index = max(0, index)
        if self._count:
            index = min(index, self._count - 1)
        # read() auto-advances the position, so a +1 step needs no (slow) seek;
        # any other target seeks first.
        if index != self._index + 1:
            cap.set(cv2.CAP_PROP_POS_FRAMES, index)
        ok, img = cap.read()
        if not ok or img is None:   # past end / unreadable: hold the last good frame
            return
        self._image = img
        self._index = index

    def _close_locked(self) -> None:
        if self._cap is not None:
            self._cap.release()
        self._cap = None
        self._name = ""
        self._count = 0
        self._fps = 0.0
        self._index = -1
        self._image = None
        self.enabled = False

    def _info_locked(self) -> dict:
        h, w = (self._image.shape[:2] if self._image is not None else (0, 0))
        return {
            "loaded": self._cap is not None,
            "name": self._name,
            "index": max(0, self._index),
            "count": self._count,
            "fps": round(self._fps, 3),
            "enabled": self.enabled,
            "width": int(w),
            "height": int(h),
        }


_SOURCE = VideoSource()


def get_video_source() -> VideoSource:
    return _SOURCE
