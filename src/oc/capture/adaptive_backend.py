"""Composite capture: a cheap CPU grab while the game is foreground, a background-capable
grab when it isn't — so the GPU / re-render cost of window-surface capture is paid ONLY
when the game is backgrounded, never while you actively play.

Per grab it asks the OS which window is foreground:
  - target IS foreground -> the ``foreground`` sub-backend (default ``mss``: a plain
    desktop BitBlt of the real on-screen pixels — CPU only, no GPU, no game re-render).
    The window is on top, so screen pixels == its client area.
  - target is background / occluded -> the ``background`` sub-backend (default
    ``printwindow``: reads the window's OWN surface even occluded, at a per-grab re-render
    cost — also GPU-light). ``wgc`` is the other choice (background-safe, no re-render, but
    streams off the GPU/DWM the whole time).

Both names come from options and are built THROUGH the registry, so this COMPOSES the
existing backends rather than forking them (CLAUDE.md rule 7). If the foreground grab comes
back black (exclusive-fullscreen games return black to a desktop BitBlt) it falls back to
the background grab for that frame — the same guard precapture uses.
"""

from __future__ import annotations

import win32gui

from ..interfaces import CaptureBackend
from ..registry import register_capture
from ..types import Frame, PixelBox, WindowInfo


@register_capture("adaptive")
class AdaptiveCapture(CaptureBackend):
    # A grab is a real BitBlt / re-render, not a free cached read — never tight-loop poll it
    # (also keeps precapture's own foreground/background split active; see _grab_frame).
    streaming = False

    def __init__(self, foreground: str = "mss", background: str = "printwindow", **_) -> None:
        # Lazy import: build_capture triggers backend discovery, which re-imports this module.
        from ..registry import build_capture

        self.foreground, self.background = foreground, background
        self._fg = build_capture(foreground)
        self._bg = build_capture(background)

    def _is_foreground(self, window: WindowInfo) -> bool:
        try:
            return win32gui.GetForegroundWindow() == window.handle
        except Exception:   # noqa: BLE001 - a probe hiccup must never break a grab
            return False

    def grab_window(self, window: WindowInfo) -> Frame:
        if self._is_foreground(window):
            try:
                f = self._fg.grab_window(window)
                # Exclusive-fullscreen returns black to a desktop BitBlt -> use the surface grab.
                if f.image is not None and f.image.size and int(f.image.max()) > 8:
                    return f
            except Exception:   # noqa: BLE001 - fall through to the background grab
                pass
        return self._bg.grab_window(window)

    def grab(self, box: PixelBox) -> Frame:
        # A bare screen rectangle carries no window handle to test; the foreground
        # (screen-region) backend is the right grabber for absolute-screen boxes — background
        # surface capture is window-targeted only.
        return self._fg.grab(box)
