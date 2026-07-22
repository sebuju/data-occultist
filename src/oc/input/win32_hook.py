"""System-wide keyboard/mouse observation via Win32 low-level hooks. Windows-only.

``WH_KEYBOARD_LL``/``WH_MOUSE_LL`` receive every key/mouse event system-wide REGARDLESS of which
window has focus — including a fullscreen exclusive game — because they're installed in the OS
input pipeline itself, not on a window's message queue. This is passive observation only (we never
synthesize input), so it's the same mechanism a benign overlay/streaming tool uses and doesn't trip
anti-cheat.

A low-level hook must be installed AND pumped from a thread with its own Win32 message loop (the OS
delivers hook callbacks by posting to that thread's queue), so :class:`Win32InputHook` runs a
dedicated daemon thread for its life. ``ctypes`` only (no new dependency) — imported lazily inside
the class so this module loads fine on any platform; it simply never registers there (see
``oc.registry._IMPL_MODULES``, mirroring the win32 window provider).

Caveat: UIPI blocks a hook from seeing input delivered to a MORE privileged process — if the game
runs elevated and this app doesn't, the hook installs but never sees its events. Warframe normally
isn't elevated, so this is a corner case, not the default.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable

from ..interfaces import InputSource
from ..registry import register_input

# ---- Win32 constants (kept local -- this module is the only place that needs them) ----------
_WH_KEYBOARD_LL = 13
_WH_MOUSE_LL = 14
_WM_KEYDOWN = 0x0100
_WM_KEYUP = 0x0101
_WM_SYSKEYDOWN = 0x0104
_WM_SYSKEYUP = 0x0105
_WM_MOUSEMOVE = 0x0200
_WM_LBUTTONDOWN = 0x0201
_WM_LBUTTONUP = 0x0202
_WM_RBUTTONDOWN = 0x0204
_WM_RBUTTONUP = 0x0205
_WM_MBUTTONDOWN = 0x0207
_WM_MBUTTONUP = 0x0208
_WM_XBUTTONDOWN = 0x020B
_WM_XBUTTONUP = 0x020C
_WM_QUIT = 0x0012

# VK -> stable button name for keys with no printable ASCII form. Letters (0x41-0x5A) and digits
# (0x30-0x39) map straight to their lowercased ASCII char (VK codes happen to equal ASCII there),
# so they're handled in code, not this table.
_VK_NAMES = {
    0x08: "backspace", 0x09: "tab", 0x0D: "enter", 0x1B: "esc", 0x20: "space",
    0x21: "pageup", 0x22: "pagedown", 0x23: "end", 0x24: "home",
    0x25: "left", 0x26: "up", 0x27: "right", 0x28: "down",
    0x2D: "insert", 0x2E: "delete",
    0x10: "shift", 0xA0: "shift", 0xA1: "shift",
    0x11: "ctrl", 0xA2: "ctrl", 0xA3: "ctrl",
    0x12: "alt", 0xA4: "alt", 0xA5: "alt",
    0x5B: "win", 0x5C: "win",
    0xBA: ";", 0xBB: "=", 0xBC: ",", 0xBD: "-", 0xBE: ".", 0xBF: "/",
    0xC0: "`", 0xDB: "[", 0xDC: "\\", 0xDD: "]", 0xDE: "'",
    0x60: "num0", 0x61: "num1", 0x62: "num2", 0x63: "num3", 0x64: "num4",
    0x65: "num5", 0x66: "num6", 0x67: "num7", 0x68: "num8", 0x69: "num9",
}
_VK_NAMES.update({0x70 + i: f"f{i + 1}" for i in range(24)})   # F1..F24


def _key_name(vk: int) -> str:
    if 0x41 <= vk <= 0x5A or 0x30 <= vk <= 0x39:   # A-Z / 0-9 share ASCII codepoints with VK
        return chr(vk).lower()
    return _VK_NAMES.get(vk, f"vk{vk}")


@register_input("win32")
class Win32InputHook(InputSource):
    """Low-level global keyboard+mouse hook. See :class:`oc.interfaces.InputSource`."""

    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._thread_id = 0
        self._callback: Callable[[dict], None] | None = None
        self._pos = (0, 0)
        self._ready = threading.Event()

    def start(self, callback: Callable[[dict], None]) -> None:
        if self._thread is not None and self._thread.is_alive():
            self.stop()
        self._callback = callback
        self._ready.clear()
        self._thread = threading.Thread(target=self._run, name="oc-input-hook", daemon=True)
        self._thread.start()
        self._ready.wait(timeout=2.0)   # best-effort: don't block the live-session start forever

    def stop(self) -> None:
        t = self._thread
        if t is None or not t.is_alive():
            return
        try:
            import win32api

            win32api.PostThreadMessage(self._thread_id, _WM_QUIT, 0, 0)
        except Exception:  # noqa: BLE001 - a failed unhook must never crash the caller
            pass
        t.join(timeout=2.0)
        self._thread = None

    # ---- the hook thread: install both hooks, pump messages, unhook on exit ----------------

    def _run(self) -> None:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32

        class KBDLLHOOKSTRUCT(ctypes.Structure):
            _fields_ = [("vkCode", wintypes.DWORD), ("scanCode", wintypes.DWORD),
                        ("flags", wintypes.DWORD), ("time", wintypes.DWORD),
                        ("dwExtraInfo", ctypes.POINTER(wintypes.ULONG))]

        class POINT(ctypes.Structure):
            _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]

        class MSLLHOOKSTRUCT(ctypes.Structure):
            _fields_ = [("pt", POINT), ("mouseData", wintypes.DWORD), ("flags", wintypes.DWORD),
                        ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.POINTER(wintypes.ULONG))]

        HOOKPROC = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)

        def emit(device: str, action: str, button: str, x: int, y: int) -> None:
            cb = self._callback
            if cb is None:
                return
            try:
                cb({"device": device, "action": action, "button": button, "x": x, "y": y,
                    "ts": time.monotonic()})
            except Exception:  # noqa: BLE001 - a bad subscriber must never break the hook thread
                pass

        def kb_proc(nCode, wParam, lParam):
            if nCode == 0:
                info = ctypes.cast(lParam, ctypes.POINTER(KBDLLHOOKSTRUCT)).contents
                name = _key_name(info.vkCode)
                x, y = self._pos
                if wParam in (_WM_KEYDOWN, _WM_SYSKEYDOWN):
                    emit("key", "down", name, x, y)
                elif wParam in (_WM_KEYUP, _WM_SYSKEYUP):
                    emit("key", "up", name, x, y)
            return user32.CallNextHookEx(None, nCode, wParam, lParam)

        def ms_proc(nCode, wParam, lParam):
            if nCode == 0:
                info = ctypes.cast(lParam, ctypes.POINTER(MSLLHOOKSTRUCT)).contents
                x, y = info.pt.x, info.pt.y
                self._pos = (x, y)
                if wParam == _WM_MOUSEMOVE:
                    emit("mouse", "move", "", x, y)
                elif wParam == _WM_LBUTTONDOWN:
                    emit("mouse", "down", "left", x, y)
                elif wParam == _WM_LBUTTONUP:
                    emit("mouse", "up", "left", x, y)
                elif wParam == _WM_RBUTTONDOWN:
                    emit("mouse", "down", "right", x, y)
                elif wParam == _WM_RBUTTONUP:
                    emit("mouse", "up", "right", x, y)
                elif wParam == _WM_MBUTTONDOWN:
                    emit("mouse", "down", "middle", x, y)
                elif wParam == _WM_MBUTTONUP:
                    emit("mouse", "up", "middle", x, y)
                elif wParam == _WM_XBUTTONDOWN:
                    xbtn = "x2" if (info.mouseData >> 16) & 0xFFFF == 2 else "x1"
                    emit("mouse", "down", xbtn, x, y)
                elif wParam == _WM_XBUTTONUP:
                    xbtn = "x2" if (info.mouseData >> 16) & 0xFFFF == 2 else "x1"
                    emit("mouse", "up", xbtn, x, y)
            return user32.CallNextHookEx(None, nCode, wParam, lParam)

        kb_ref = HOOKPROC(kb_proc)   # keep alive for the thread's life -- ctypes doesn't hold a ref
        ms_ref = HOOKPROC(ms_proc)
        self._thread_id = kernel32.GetCurrentThreadId()
        hmod = kernel32.GetModuleHandleW(None)
        kb_hook = user32.SetWindowsHookExW(_WH_KEYBOARD_LL, kb_ref, hmod, 0)
        ms_hook = user32.SetWindowsHookExW(_WH_MOUSE_LL, ms_ref, hmod, 0)
        self._ready.set()
        try:
            msg = wintypes.MSG()
            while True:
                r = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
                if r <= 0:   # 0 = WM_QUIT, -1 = error
                    break
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))
        finally:
            if kb_hook:
                user32.UnhookWindowsHookEx(kb_hook)
            if ms_hook:
                user32.UnhookWindowsHookEx(ms_hook)
