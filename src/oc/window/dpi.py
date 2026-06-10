"""Make the process DPI-aware on Windows.

Why this matters: with Windows display scaling (e.g. 125%), a DPI-*unaware*
process is lied to by the OS — `GetClientRect`/screen metrics report virtualized
*logical* pixels and screen captures come back downscaled and soft. That both
hurts OCR and risks the window provider (win32) and capture backend (mss)
disagreeing about pixel space.

Declaring per-monitor DPI awareness makes every API report true *physical*
pixels, so a 4K display reads as 3840x2160 and captures are pixel-sharp. Must be
called once, early, before windows/DCs are created.
"""

from __future__ import annotations

import sys

_done = False


def set_process_dpi_aware() -> bool:
    """Best-effort enable per-monitor DPI awareness. Returns True if applied.

    No-op (returns False) off Windows or if already set. Tries newest API first,
    falling back across Windows versions.
    """
    global _done
    if _done or not sys.platform.startswith("win"):
        return False
    import ctypes

    # PER_MONITOR_AWARE_V2 context handle is (-4).
    try:
        if ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
            _done = True
            return True
    except (AttributeError, OSError):
        pass

    try:  # Windows 8.1+: 2 == PROCESS_PER_MONITOR_DPI_AWARE
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
        _done = True
        return True
    except (AttributeError, OSError):
        pass

    try:  # Vista+ system-DPI aware fallback
        ctypes.windll.user32.SetProcessDPIAware()
        _done = True
        return True
    except (AttributeError, OSError):
        return False
