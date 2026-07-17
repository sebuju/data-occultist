"""Window-targeted capture via GDI ``PrintWindow`` (Windows).

Unlike screen-region capture, this grabs a *specific window's* own surface, so it
works when the window is **unfocused, backgrounded, or occluded** by other windows
— exactly what's needed to read a borderless game while doing something else.

The ``PW_RENDERFULLCONTENT`` flag is essential: without it, DirectX/GPU-rendered
game windows come back fully black. Arbitrary-region grabs (``grab``) fall back to
an internal mss backend, since PrintWindow is inherently per-window.
"""

from __future__ import annotations

import ctypes

import cv2
import numpy as np
import win32gui
import win32ui

from ..interfaces import CaptureBackend
from ..registry import register_capture
from ..types import Frame, PixelBox, WindowInfo

PW_RENDERFULLCONTENT = 0x00000002


@register_capture("printwindow")
class PrintWindowCaptureBackend(CaptureBackend):
    def __init__(self, flags: int = PW_RENDERFULLCONTENT) -> None:
        self._flags = flags
        self._mss = None  # lazy fallback for region grabs

    def grab_window(self, window: WindowInfo) -> Frame:
        hwnd = window.handle
        left, top, right, bottom = win32gui.GetClientRect(hwnd)
        w, h = right - left, bottom - top
        if w <= 0 or h <= 0:
            # Minimized / no client area: return an empty black frame.
            return Frame(image=np.zeros((1, 1, 3), np.uint8), client=window.client)

        hwnd_dc = win32gui.GetWindowDC(hwnd)
        mfc_dc = win32ui.CreateDCFromHandle(hwnd_dc)
        save_dc = mfc_dc.CreateCompatibleDC()
        bmp = win32ui.CreateBitmap()
        try:
            bmp.CreateCompatibleBitmap(mfc_dc, w, h)
            save_dc.SelectObject(bmp)
            ctypes.windll.user32.PrintWindow(hwnd, save_dc.GetSafeHdc(), self._flags)
            info = bmp.GetInfo()
            bits = bmp.GetBitmapBits(True)
            # GDI DIB is BGRA, top-down; drop alpha -> BGR for OpenCV. cvtColor over a
            # strided [:, :, :3].copy() — ~9x cheaper at 4K (SIMD vs strided copy).
            arr = np.frombuffer(bits, dtype=np.uint8).reshape(
                (info["bmHeight"], info["bmWidth"], 4)
            )
            image = cv2.cvtColor(arr, cv2.COLOR_BGRA2BGR)
        finally:
            win32gui.DeleteObject(bmp.GetHandle())
            save_dc.DeleteDC()
            mfc_dc.DeleteDC()
            win32gui.ReleaseDC(hwnd, hwnd_dc)

        return Frame(image=image, client=window.client)

    def grab(self, box: PixelBox) -> Frame:
        # PrintWindow is per-window; arbitrary screen regions go through mss.
        if self._mss is None:
            from .mss_backend import MssCaptureBackend

            self._mss = MssCaptureBackend()
        return self._mss.grab(box)
