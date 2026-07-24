"""Send synthetic keyboard/mouse input via ``SendInput``. Windows-only.

Unlike :func:`oc.window.input.scroll_window` (which POSTs ``WM_MOUSEWHEEL`` straight to a window
handle so it works even backgrounded), this module injects REAL input through the OS input queue —
the only way most games (DirectInput/RawInput readers ignore posted messages) see a key or click at
all. That's why an action using this module hard-gates on the target window being foreground (see
:func:`oc.collect.triggers._run_action`): injected input goes to whatever window the OS currently
has focused, not to a chosen handle.

Keyboard events are sent by SCANCODE (``KEYEVENTF_SCANCODE``), not bare virtual-key code — VK-only
injection is the one that games ignore. ``ctypes`` is used directly (no ``pywin32`` dependency for
this), with every signature declared explicitly (``argtypes``/``restype``) so 64-bit values never
get silently truncated by ctypes' default 32-bit ``c_int`` guess — the same hazard documented in
``input/_hook_child.py``.

The name<->VK vocabulary is NOT redefined here: it's built by inverting
``oc.input._hook_child._VK_NAMES``, the single source of truth also mirrored (by hand, on purpose —
that one's a throwaway subprocess script that can't import this package) by
``web/static/js/graph/io_wire.js``. A key name accepted anywhere in the graph UI is accepted here.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes

from ..input._hook_child import _VK_NAMES

# ---- name <-> VK, inverted from the single source of truth (_hook_child._VK_NAMES) -------------
_NAME_TO_VK: dict[str, int] = {name: vk for vk, name in _VK_NAMES.items()}
for _i in range(26):
    _NAME_TO_VK[chr(ord("a") + _i)] = ord("A") + _i          # a-z -> VK (== uppercase ASCII)
for _i in range(10):
    _NAME_TO_VK[chr(ord("0") + _i)] = ord("0") + _i          # 0-9 -> VK (== ASCII digit)
# _VK_NAMES lists shift/ctrl/alt/win under BOTH their generic and left/right-specific VK codes
# (last one inverted wins the dict comprehension above) — pin the generic/left codes explicitly so
# a plain "shift"/"ctrl"/"alt" sends the code Windows treats as either side, and "win" sends the
# left key (the common one bound in games).
_NAME_TO_VK.update({"shift": 0x10, "ctrl": 0x11, "alt": 0x12, "win": 0x5B})

# VKs that need KEYEVENTF_EXTENDEDKEY set (the nav cluster, right ctrl/alt, both win keys) — without
# it Windows can deliver the WRONG key (e.g. an un-extended "delete" scancode is numpad '.').
_EXTENDED_VKS = {0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0xA3, 0xA5, 0x5B, 0x5C}

_WHEEL_DELTA = 120   # one wheel notch (WHEEL_DELTA) — matches window/input.py's scroll_window

# ---- Win32 SendInput constants -------------------------------------------------------------------
_INPUT_MOUSE, _INPUT_KEYBOARD = 0, 1
_KEYEVENTF_EXTENDEDKEY, _KEYEVENTF_KEYUP, _KEYEVENTF_SCANCODE = 0x0001, 0x0002, 0x0008
_MAPVK_VK_TO_VSC = 0
_MOUSEEVENTF_LEFTDOWN, _MOUSEEVENTF_LEFTUP = 0x0002, 0x0004
_MOUSEEVENTF_RIGHTDOWN, _MOUSEEVENTF_RIGHTUP = 0x0008, 0x0010
_MOUSEEVENTF_MIDDLEDOWN, _MOUSEEVENTF_MIDDLEUP = 0x0020, 0x0040
_MOUSEEVENTF_XDOWN, _MOUSEEVENTF_XUP = 0x0080, 0x0100
_MOUSEEVENTF_WHEEL = 0x0800
_XBUTTON1, _XBUTTON2 = 0x0001, 0x0002

_MOUSE_DOWN = {"left": _MOUSEEVENTF_LEFTDOWN, "right": _MOUSEEVENTF_RIGHTDOWN,
               "middle": _MOUSEEVENTF_MIDDLEDOWN, "x1": _MOUSEEVENTF_XDOWN, "x2": _MOUSEEVENTF_XDOWN}
_MOUSE_UP = {"left": _MOUSEEVENTF_LEFTUP, "right": _MOUSEEVENTF_RIGHTUP,
             "middle": _MOUSEEVENTF_MIDDLEUP, "x1": _MOUSEEVENTF_XUP, "x2": _MOUSEEVENTF_XUP}
_XBUTTON_DATA = {"x1": _XBUTTON1, "x2": _XBUTTON2}

# ---- SendInput's INPUT struct, built ONCE at module level (matches input/_hook_child.py's style)
# -- a ctypes.Structure/Union subclass created fresh on every call would be a DIFFERENT type each
# time (same field layout, different Python identity), and ctypes refuses to pack an instance of
# "the wrong" INPUT class into an INPUT array even when the layouts are identical.
_ULONG_PTR = ctypes.c_size_t


class _MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", _ULONG_PTR)]


class _KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", _ULONG_PTR)]


class _HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", wintypes.DWORD), ("wParamL", wintypes.WORD), ("wParamH", wintypes.WORD)]


class _INPUTunion(ctypes.Union):
    _fields_ = [("mi", _MOUSEINPUT), ("ki", _KEYBDINPUT), ("hi", _HARDWAREINPUT)]


class _INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTunion)]


def _user32():
    """The ``user32`` handle with ``SendInput``/``MapVirtualKeyW`` signatures declared explicitly,
    or ``None`` off-Windows / if anything about loading it fails — every sender below treats that as
    "couldn't send" rather than raising, mirroring ``scroll_window``'s no-op-off-Windows contract."""
    try:
        u = ctypes.windll.user32
        u.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(_INPUT), ctypes.c_int]
        u.SendInput.restype = wintypes.UINT
        u.MapVirtualKeyW.argtypes = [wintypes.UINT, wintypes.UINT]
        u.MapVirtualKeyW.restype = wintypes.UINT
        return u
    except Exception:  # noqa: BLE001 - any failure here means "can't send", not a hard error
        return None


def _send(u, inputs: list) -> bool:
    """POST a batch of already-built INPUT structs as one atomic SendInput call. Returns True only
    if EVERY struct was accepted — a partial count means the OS refused some of them (another app
    has a low-level hook blocking synthetic input, UAC-elevated foreground window, etc.)."""
    arr = (_INPUT * len(inputs))(*inputs)
    try:
        n = u.SendInput(len(inputs), arr, ctypes.sizeof(_INPUT))
    except Exception:  # noqa: BLE001 - treat any Win32 failure as "nothing sent"
        return False
    return n == len(inputs)


def tap_key(name: str) -> bool:
    """Press and release one key by its ``_VK_NAMES``/``io_wire.js`` name (down+up, scancode-based).
    Returns False for an unknown name, off-Windows, or a refused SendInput call."""
    vk = _NAME_TO_VK.get(name)
    u = _user32()
    if vk is None or u is None:
        return False
    scan = u.MapVirtualKeyW(vk, _MAPVK_VK_TO_VSC) & 0xFF
    ext = _KEYEVENTF_EXTENDEDKEY if vk in _EXTENDED_VKS else 0
    down = _INPUT(type=_INPUT_KEYBOARD,
                  ki=_KEYBDINPUT(wVk=0, wScan=scan, dwFlags=_KEYEVENTF_SCANCODE | ext, time=0, dwExtraInfo=0))
    up = _INPUT(type=_INPUT_KEYBOARD,
                ki=_KEYBDINPUT(wVk=0, wScan=scan, dwFlags=_KEYEVENTF_SCANCODE | _KEYEVENTF_KEYUP | ext,
                                time=0, dwExtraInfo=0))
    return _send(u, [down, up])


def click(button: str) -> bool:
    """Press and release one mouse button (``left``/``right``/``middle``/``x1``/``x2``) at the
    CURRENT cursor position (no move — this module never relocates the pointer). Returns False for
    an unknown button, off-Windows, or a refused SendInput call."""
    down_flag = _MOUSE_DOWN.get(button)
    u = _user32()
    if down_flag is None or u is None:
        return False
    xdata = _XBUTTON_DATA.get(button, 0)
    down = _INPUT(type=_INPUT_MOUSE, mi=_MOUSEINPUT(dx=0, dy=0, mouseData=xdata, dwFlags=down_flag, time=0, dwExtraInfo=0))
    up = _INPUT(type=_INPUT_MOUSE,
                mi=_MOUSEINPUT(dx=0, dy=0, mouseData=xdata, dwFlags=_MOUSE_UP[button], time=0, dwExtraInfo=0))
    return _send(u, [down, up])


def wheel(clicks: int) -> bool:
    """Scroll ``clicks`` notches (positive = DOWN, matching ``scroll_window``'s convention) at the
    current cursor position. Returns False off-Windows or on a refused SendInput call."""
    u = _user32()
    if u is None:
        return False
    ev = _INPUT(type=_INPUT_MOUSE,
                mi=_MOUSEINPUT(dx=0, dy=0, mouseData=(clicks * _WHEEL_DELTA) & 0xFFFFFFFF,
                                dwFlags=_MOUSEEVENTF_WHEEL, time=0, dwExtraInfo=0))
    return _send(u, [ev])


def send_token(token: str) -> bool:
    """Dispatch one :class:`oc.profile.models.InputEvent` token — ``"key:<name>"``,
    ``"mouse:<button>"``, or ``"scroll:<up|down>"`` — as a single tap/click/notch. The ``"delay"``
    token is NOT handled here (it's a pure wait, owned by the caller's own timing loop, not a send).
    Returns False for an unrecognised/malformed token or any send failure."""
    kind, _, val = token.partition(":")
    if kind == "key":
        return tap_key(val)
    if kind == "mouse":
        return click(val)
    if kind == "scroll":
        return wheel(1 if val == "down" else -1)
    return False
