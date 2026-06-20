"""Window location via Win32 (pywin32). Windows-only.

Resolves a process to its visible top-level window and reports the *client* area
in absolute screen coordinates (title bar / borders excluded), which is what the
capture backend and fraction-coordinate math expect.
"""

from __future__ import annotations

import win32gui
import win32process

from ..interfaces import WindowProvider
from ..registry import register_window
from ..types import PixelBox, WindowInfo


def _client_box(hwnd: int) -> PixelBox:
    # Client rect is window-relative; map its corners to screen space.
    left, top, right, bottom = win32gui.GetClientRect(hwnd)
    sx, sy = win32gui.ClientToScreen(hwnd, (left, top))
    ex, ey = win32gui.ClientToScreen(hwnd, (right, bottom))
    return PixelBox(x=sx, y=sy, w=ex - sx, h=ey - sy)


def _pid_for_hwnd(hwnd: int) -> int:
    _, pid = win32process.GetWindowThreadProcessId(hwnd)
    return pid


@register_window("win32")
class Win32WindowProvider(WindowProvider):
    def _enum(self):
        out: list[int] = []

        def cb(hwnd, _):
            if win32gui.IsWindowVisible(hwnd) and win32gui.GetWindowText(hwnd):
                out.append(hwnd)
            return True

        win32gui.EnumWindows(cb, None)
        return out

    def _to_info(self, hwnd: int) -> WindowInfo:
        return WindowInfo(
            handle=hwnd,
            title=win32gui.GetWindowText(hwnd),
            pid=_pid_for_hwnd(hwnd),
            client=_client_box(hwnd),
        )

    def find_for_pid(self, pid: int) -> WindowInfo | None:
        best: int | None = None
        for hwnd in self._enum():
            if _pid_for_hwnd(hwnd) == pid:
                # Prefer a non-minimized window with real client area.
                if win32gui.IsIconic(hwnd):
                    continue
                best = hwnd
                break
        return self._to_info(best) if best else None

    def find_by_title(self, title_substring: str, exact: bool = False) -> WindowInfo | None:
        needle = title_substring.lower()
        for hwnd in self._enum():
            t = win32gui.GetWindowText(hwnd).lower()
            if (t == needle) if exact else (needle in t):
                return self._to_info(hwnd)
        return None

    def from_handle(self, handle: int) -> WindowInfo | None:
        if not win32gui.IsWindow(handle) or not win32gui.IsWindowVisible(handle):
            return None
        if win32gui.IsIconic(handle):  # minimized -> no usable client area
            return None
        return self._to_info(handle)

    def is_foreground(self, window: WindowInfo) -> bool:
        return win32gui.GetForegroundWindow() == window.handle
