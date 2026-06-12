"""Send synthetic mouse-wheel input to scroll a target window. Windows-only.

win32 is imported *inside* the call so this module loads on any platform (the scroll
just no-ops, returning False, where win32 isn't available). The wheel is POSTED straight
to the window (WM_MOUSEWHEEL) rather than synthesised at the cursor, so the user's mouse
never moves and the scroll lands on the target even if it isn't under the pointer.
"""

from __future__ import annotations

from ..types import WindowInfo

_WHEEL_DELTA = 120   # one wheel notch (WHEEL_DELTA)


def scroll_window(win: WindowInfo, clicks: int) -> bool:
    """Scroll ``win`` by ``clicks`` notches; positive = DOWN (toward the list's end).
    Posts WM_MOUSEWHEEL to the window handle — does NOT move the cursor. Returns True if
    the message was posted."""
    try:
        import win32api
        import win32con
    except Exception:
        return False
    c = win.client
    cx, cy = c.x + c.w // 2, c.y + c.h // 2          # point the wheel reports, in SCREEN px
    delta = -clicks * _WHEEL_DELTA                    # negative = scroll down
    wparam = (delta & 0xFFFF) << 16                   # HIWORD = signed wheel delta, LOWORD = no keys
    lparam = ((cy & 0xFFFF) << 16) | (cx & 0xFFFF)    # screen x/y of the wheel point
    try:
        win32api.PostMessage(win.handle, win32con.WM_MOUSEWHEEL, wparam, lparam)
        return True
    except Exception:
        return False
