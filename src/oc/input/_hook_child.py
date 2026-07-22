"""Out-of-process low-level input hook — the ONE place the ``WH_KEYBOARD_LL``/``WH_MOUSE_LL``
callbacks actually run. Windows-only.

Run as a throwaway script (``python _hook_child.py``), never imported by the server:
:class:`oc.input.win32_hook.Win32InputHook` spawns one of these for a live run and reads its
stdout. That process boundary is the whole point.

Why a separate PROCESS and not (as before) a thread in the server: an LL hook callback runs INSIDE
the OS's global input dispatch — Windows blocks ALL system-wide keyboard/mouse input for every
process until the callback returns, and ``WH_MOUSE_LL`` fires the callback on EVERY mouse move (a
high-polling-rate mouse = ~1000/sec). A Python callback has to reacquire the GIL to run at all;
while the server's OCR/capture loop holds the GIL, that reacquire is delayed on every move, so the
callback returns late and the OS stalls global input — the lag scales with how much the mouse
moves. Thread priority can't fix it (CPython's GIL handoff isn't OS-priority-aware). In a dedicated
process the GIL is uncontended, so the callback returns in microseconds no matter what the server is
doing. A backlogged reader on the parent side just buffers bytes in the OS pipe; it can never stall
the child's hook proc, so it can never stall system input.

This script is deliberately self-contained: it imports only stdlib + ctypes, never the ``oc``
package, so a spawn is cheap and nothing here is coupled to the capture/OCR stack.

Protocol: one JSON object per line on stdout, ``{"device","action","button","x","y","ts"}`` — the
exact dict shape :meth:`oc.collect.triggers.TriggerRunner.on_input` consumes. Mouse MOVES are
handled entirely here (they only update the tracked cursor position so a keypress can be stamped
with a location) and are NEVER written out — the wire carries button/key EDGES only.
"""

from __future__ import annotations

import ctypes
import json
import os
import sys
import threading
import time
from ctypes import wintypes

# ---- Win32 constants ------------------------------------------------------------------------
_WH_KEYBOARD_LL = 13
_WH_MOUSE_LL = 14
_WM_KEYDOWN = 0x0100
_WM_KEYUP = 0x0101
_WM_SYSKEYDOWN = 0x0104
_WM_SYSKEYUP = 0x0105
_WM_LBUTTONDOWN = 0x0201
_WM_LBUTTONUP = 0x0202
_WM_RBUTTONDOWN = 0x0204
_WM_RBUTTONUP = 0x0205
_WM_MBUTTONDOWN = 0x0207
_WM_MBUTTONUP = 0x0208
_WM_XBUTTONDOWN = 0x020B
_WM_XBUTTONUP = 0x020C

# VK -> stable button name for keys with no printable ASCII form. Letters (0x41-0x5A) and digits
# (0x30-0x39) map straight to their lowercased ASCII char (VK codes happen to equal ASCII there),
# so they're handled in code, not this table. Keep these tokens byte-identical to the JS side
# (web/static/js/graph/io_wire.js) -- both must speak the same key vocabulary.
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


def _watch_parent() -> None:
    """Die the instant the parent dies, for ANY reason. The parent (``Win32InputHook``) holds our
    stdin write-end open for its whole life and never sends a byte, so this read blocks until that
    handle closes -- which happens when the parent process exits however it exits (clean stop,
    crash, taskkill, power loss of the console). ``os._exit`` skips atexit/finalizers on purpose:
    the OS removes our LL hooks automatically on process death, and we want an unconditional exit
    that can't be swallowed. This is the backstop for when the parent's KillJob couldn't be set up,
    and it fires even while no input is arriving (so the broken-stdout-pipe path never gets a
    chance to)."""
    try:
        sys.stdin.buffer.read()   # blocks until EOF == parent gone
    except Exception:   # noqa: BLE001 - any stdin error means we can't trust the parent link: exit
        pass
    os._exit(0)


def main() -> int:
    # Watchdog first, before we ever install a hook: no path through this process may outlive the
    # parent. Daemon so it can't itself keep us alive.
    threading.Thread(target=_watch_parent, name="parent-watch", daemon=True).start()

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

    # ctypes defaults every undeclared function to argtypes=None/restype=c_int -- on 64-bit Python
    # that TRUNCATES a returned 64-bit handle/pointer down to 32 bits, turning GetModuleHandleW's
    # real handle into garbage and making SetWindowsHookExW fail with ERROR_MOD_NOT_FOUND (126) even
    # though nothing is missing. Declare every signature explicitly so handles round-trip full width.
    kernel32.GetModuleHandleW.restype = wintypes.HMODULE
    kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
    kernel32.GetLastError.restype = wintypes.DWORD
    user32.SetWindowsHookExW.restype = wintypes.HANDLE
    user32.SetWindowsHookExW.argtypes = [ctypes.c_int, HOOKPROC, wintypes.HMODULE, wintypes.DWORD]
    user32.CallNextHookEx.restype = ctypes.c_long
    user32.CallNextHookEx.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM]
    user32.UnhookWindowsHookEx.restype = wintypes.BOOL
    user32.UnhookWindowsHookEx.argtypes = [wintypes.HANDLE]
    user32.GetMessageW.restype = ctypes.c_int
    user32.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]
    user32.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
    user32.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]

    out = sys.stdout
    pos = [0, 0]   # last cursor position; list so the closures can mutate it

    def emit(device: str, action: str, button: str, x: int, y: int) -> None:
        # One JSON line per edge. A broken pipe (parent gone) is our shutdown signal: stop the
        # message pump so the process exits cleanly instead of throwing once per subsequent event.
        try:
            out.write(json.dumps(
                {"device": device, "action": action, "button": button, "x": x, "y": y,
                 "ts": time.monotonic()}) + "\n")
            out.flush()
        except (OSError, ValueError):
            user32.PostQuitMessage(0)

    def kb_proc(nCode, wParam, lParam):
        if nCode == 0:
            info = ctypes.cast(lParam, ctypes.POINTER(KBDLLHOOKSTRUCT)).contents
            name = _key_name(info.vkCode)
            x, y = pos
            if wParam in (_WM_KEYDOWN, _WM_SYSKEYDOWN):
                emit("key", "down", name, x, y)
            elif wParam in (_WM_KEYUP, _WM_SYSKEYUP):
                emit("key", "up", name, x, y)
        return user32.CallNextHookEx(None, nCode, wParam, lParam)

    def ms_proc(nCode, wParam, lParam):
        if nCode == 0:
            info = ctypes.cast(lParam, ctypes.POINTER(MSLLHOOKSTRUCT)).contents
            x, y = info.pt.x, info.pt.y
            pos[0], pos[1] = x, y   # tracked unconditionally -- a click's own (x, y) is always
            # fresh anyway, this only backs kb_proc's "where was the mouse for this keypress".
            # A bare move falls through every branch below and emits NOTHING (never hits the wire).
            if wParam == _WM_LBUTTONDOWN:
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

    kb_ref = HOOKPROC(kb_proc)   # keep alive for the process's life -- ctypes doesn't hold a ref
    ms_ref = HOOKPROC(ms_proc)
    hmod = kernel32.GetModuleHandleW(None)
    kb_hook = user32.SetWindowsHookExW(_WH_KEYBOARD_LL, kb_ref, hmod, 0)
    ms_hook = user32.SetWindowsHookExW(_WH_MOUSE_LL, ms_ref, hmod, 0)
    # SetWindowsHookExW returns NULL on failure (e.g. UIPI: the target game runs elevated and this
    # process doesn't) with no exception. Report on stderr (the parent logs it) so on_input silently
    # not firing has a visible cause, then exit -- there's nothing to pump.
    if not kb_hook or not ms_hook:
        sys.stderr.write(
            f"input hook failed to install (kb={bool(kb_hook)} ms={bool(ms_hook)}, "
            f"GetLastError={kernel32.GetLastError()}) -- if the game runs elevated, run oc elevated too\n")
        sys.stderr.flush()
        if kb_hook:
            user32.UnhookWindowsHookEx(kb_hook)
        if ms_hook:
            user32.UnhookWindowsHookEx(ms_hook)
        return 1
    try:
        msg = wintypes.MSG()
        while True:
            r = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
            if r <= 0:   # 0 = WM_QUIT (emit posts it on a dead pipe), -1 = error
                break
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))
    finally:
        user32.UnhookWindowsHookEx(kb_hook)
        user32.UnhookWindowsHookEx(ms_hook)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
