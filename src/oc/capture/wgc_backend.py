"""Window-targeted capture via Windows.Graphics.Capture (WGC).

Unlike :mod:`printwindow_backend`, WGC reads the frame DWM has **already
composited** for the desktop — it never asks the target window to re-render. So
capturing a game costs the game ~nothing: none of the per-grab frame-pacing
hitch that ``PrintWindow(PW_RENDERFULLCONTENT)`` inflicts by forcing a fresh
render/present off the game's swapchain. It still works on backgrounded/occluded
windows because DWM keeps a redirection surface for them.

WGC is a **streaming** API: frames arrive on a callback as the compositor
presents (capped at the monitor refresh rate; with a static screen they simply
stop arriving and the last one stands). The :class:`CaptureBackend` contract is a
synchronous ``grab_window``, so we run one long-lived session per window on a
dedicated thread (``windows-capture``'s ``start_free_threaded``), keep the latest
frame under a lock, and hand it back on demand. A ``grab_window`` called faster
than the refresh rate returns the most recent frame (``frame_seq`` lets a
benchmark tell a fresh frame from a repeat).

WGC captures the whole *window* surface (frame + borders), so we crop to the
client area using win32 geometry — except the common borderless-fullscreen case,
where the WGC frame already equals the client area and no crop is needed.

Requires the optional ``windows-capture`` wheel (a Rust-backed WGC binding) and
Windows 10 1803+. If it isn't installed this module fails to import and the
``wgc`` name simply won't resolve (the registry skips it), so ``printwindow``
stays the default.
"""

from __future__ import annotations

import threading
import time

import numpy as np
import win32gui
from windows_capture import WindowsCapture

from ..interfaces import CaptureBackend
from ..registry import register_capture
from ..types import Frame, PixelBox, WindowInfo


class _Session:
    """One live WGC capture targeting a single window title, on its own thread."""

    def __init__(self, title: str) -> None:
        self.title = title
        self._lock = threading.Lock()
        self._latest: np.ndarray | None = None   # BGR, copied out of the native buffer
        self._seq = 0                              # bumped per delivered frame
        self._control = None
        self._closed = False

        # draw_border=False asks WGC to suppress the Win11 yellow capture border, but the
        # border TOGGLE is a Win11-era feature: on Windows 10 the Graphics Capture API
        # rejects any explicit value ("Toggling the capture border is not supported... on
        # this platform") and the start throws. Win10 draws no capture border anyway, so we
        # start with the suppress request and, if it's the unsupported-toggle error, retry
        # with draw_border=None (let the OS default stand). Same defensive retry covers
        # cursor_capture, which some platforms likewise can't toggle.
        try:
            self._control = self._start(title, draw_border=False, cursor_capture=False)
        except Exception as exc:  # noqa: BLE001
            # Win10 can't toggle the border (or cursor) -> retry once with both at the OS
            # default. If THAT still fails it's a real error (missing window etc.) -> raise.
            if "not supported" not in str(exc).lower():
                raise
            self._control = self._start(title, draw_border=None, cursor_capture=None)

    def _start(self, title: str, *, draw_border, cursor_capture):
        cap = WindowsCapture(
            cursor_capture=cursor_capture,  # cursor must never land in an OCR'd region
            draw_border=draw_border,        # suppress the Win11 yellow capture border
            window_name=title,
        )
        # Assign handlers directly: the @event decorator keys off the function's
        # __name__, and start_free_threaded only checks the two slots are set.
        cap.frame_handler = self._on_frame
        cap.closed_handler = self._on_closed
        return cap.start_free_threaded()

    def _on_frame(self, frame, _capture_control) -> None:
        # frame_buffer is a view over native memory valid only for this call -> copy.
        # [:, :, :3] drops alpha (BGRA -> BGR) before the copy so we don't copy alpha.
        img = np.ascontiguousarray(frame.frame_buffer[:, :, :3])
        with self._lock:
            self._latest = img
            self._seq += 1

    def _on_closed(self) -> None:
        self._closed = True

    def latest(self) -> tuple[np.ndarray | None, int]:
        with self._lock:
            return self._latest, self._seq

    def wait_first(self, timeout: float = 0.5) -> bool:
        """Block (bounded) until the first frame is delivered. WGC streams asynchronously,
        so a grab right after start has nothing yet; a single-shot caller (``collect --once``)
        would read an empty frame. Returns True if a frame arrived within ``timeout``."""
        deadline = time.perf_counter() + timeout
        while time.perf_counter() < deadline:
            with self._lock:
                if self._latest is not None:
                    return True
            if self._closed:
                return False
            time.sleep(0.005)
        with self._lock:
            return self._latest is not None

    def stop(self) -> None:
        if self._control is not None:
            ctrl, self._control = self._control, None
            try:
                ctrl.stop()
                # Join the native capture thread before returning. If it's still running at
                # interpreter exit it crashes finalization ("Fatal Python error: ... import
                # state already initialized"). Bounded so a wedged thread can't hang exit.
                wait = getattr(ctrl, "wait", None)
                if callable(wait):
                    t = threading.Thread(target=wait, daemon=True)
                    t.start()
                    t.join(1.0)
            except Exception:
                pass


def _client_crop(hwnd: int, win: WindowInfo, frame_w: int, frame_h: int) -> PixelBox:
    """Where the client area sits inside a full-window WGC frame.

    The WGC frame's origin is the window's top-left (``GetWindowRect``); the client
    area is offset by the border/title thickness. Borderless-fullscreen games have
    no border, so the frame already *is* the client area — detect that by size and
    skip the crop. Everything is clamped into the actual frame bounds.
    """
    cw, ch = win.client.w, win.client.h
    # Frame already client-sized (borderless / fullscreen): no crop.
    if abs(frame_w - cw) <= 2 and abs(frame_h - ch) <= 2:
        return PixelBox(0, 0, min(cw, frame_w), min(ch, frame_h))
    try:
        wl, wt, _wr, _wb = win32gui.GetWindowRect(hwnd)
    except Exception:
        return PixelBox(0, 0, min(cw, frame_w), min(ch, frame_h))
    dx = max(0, win.client.x - wl)
    dy = max(0, win.client.y - wt)
    return PixelBox(dx, dy, max(0, min(cw, frame_w - dx)), max(0, min(ch, frame_h - dy)))


@register_capture("wgc")
class WgcCaptureBackend(CaptureBackend):
    def __init__(self) -> None:
        self._session: _Session | None = None
        self._mss = None   # lazy fallback for arbitrary screen-region grabs
        # Belt-and-suspenders: a live WGC session runs a free-threaded NATIVE capture
        # thread; if it's still alive when the interpreter finalizes it crashes exit
        # ("Fatal Python error: ... import state already initialized"). Callers SHOULD
        # close() (the collector does), but a one-shot CLI that just grabs and returns
        # (e.g. `oc capture`) easily forgets. atexit guarantees the thread is joined no
        # matter who forgot — close() stays idempotent so an explicit close isn't doubled.
        import atexit

        atexit.register(self.close)

    def _ensure_session(self, title: str) -> _Session:
        s = self._session
        if s is not None and s.title == title and not s._closed:
            return s
        if s is not None:
            s.stop()
        self._session = _Session(title)
        # Give the fresh stream a moment to deliver its first frame so the very next
        # grab returns real pixels (a single-shot tick has no retry to fall back on).
        self._session.wait_first()
        return self._session

    @property
    def frame_seq(self) -> int:
        """Monotonic count of frames WGC has delivered for the active session — a
        benchmark uses it to distinguish a real new frame from a repeated read."""
        return self._session._seq if self._session is not None else 0

    def grab_window(self, window: WindowInfo) -> Frame:
        cw, ch = window.client.w, window.client.h
        if cw <= 0 or ch <= 0:   # minimized / no client area -> empty (collector skips)
            return Frame(image=np.zeros((1, 1, 3), np.uint8), client=window.client)
        if not window.title:
            # WGC can only target by title; without one, fall back to a screen grab.
            return self.grab(window.client)

        session = self._ensure_session(window.title)
        img, _seq = session.latest()
        if img is None:
            # No frame yet (session just started / window never presented). Empty
            # frame -> the collector treats it as an unread tick and retries.
            return Frame(image=np.zeros((1, 1, 3), np.uint8), client=window.client)

        fh, fw = img.shape[:2]
        box = _client_crop(window.handle, window, fw, fh)
        if box.w <= 0 or box.h <= 0:
            return Frame(image=np.zeros((1, 1, 3), np.uint8), client=window.client)
        crop = img[box.y : box.y + box.h, box.x : box.x + box.w]
        return Frame(image=np.ascontiguousarray(crop), client=window.client)

    def grab(self, box: PixelBox) -> Frame:
        # WGC is per-window; arbitrary screen regions go through mss, same as the
        # printwindow backend.
        if self._mss is None:
            from .mss_backend import MssCaptureBackend

            self._mss = MssCaptureBackend()
        return self._mss.grab(box)

    def close(self) -> None:
        if self._session is not None:
            self._session.stop()
            self._session = None
