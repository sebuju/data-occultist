"""Out-of-process overlay host — the ONE place a window is actually drawn over the game.

Run as a script, never imported by the server::

    python _overlay_child.py --serve --url http://127.0.0.1:8000/overlay?game=warframe

Prints ``ready`` once the window is up and configured, then reads one JSON command per stdin line
and acks ``ok``/``err``. Commands:

    {"cmd": "attach", "hwnd": 12345}   follow this window's client rect (0 = stop following)
    {"cmd": "show"} / {"cmd": "hide"}  raise / hide the overlay
    {"cmd": "quit"}                    exit

Data never crosses this pipe. The child is a browser: the page it loads subscribes to the server's
existing SSE stream like any other client, so live values arrive without the parent relaying them.
The pipe carries lifecycle only. Holding stdin open is also the parent-death sensor — EOF and the
overlay goes away with the server (same trick as ``oc.input.win32_hook``).

Deliberately self-contained: stdlib + ``webview`` only, never the ``oc`` package, so a spawn is
cheap and can't drag in the OCR/capture stack.

**Why a child process.** ``webview.start()`` owns the thread it runs on and never returns until the
window closes, so it cannot live in the uvicorn process. A separate process also means a wedged
WebView2 costs one OS-kill instead of the whole server, and keeps the WinForms/pythonnet stack out
of the process that loads onnxruntime.

Three Windows quirks this file exists to work around. All three were measured, not assumed — see
the Phase 0 results in the plan:

1. **pywebview leaves an opaque form behind a "transparent" window.** At
   ``webview/platforms/winforms.py:782-787`` the transparent branch assigns
   ``DefaultBackgroundColor`` to the Python ``EdgeChrome`` *wrapper* (a no-op; the real control is
   ``self.browser.webview``) and never sets the form's own ``BackColor`` — so the form stays
   ``SystemColors.Control`` grey and shows straight through the genuinely-transparent WebView2.
   Measured: 99.76% of non-widget pixels opaque. Fix here: paint the form a key colour and
   colour-key it away with ``WS_EX_LAYERED`` + ``LWA_COLORKEY`` (down to 4.6%).

   Consequence, and it is a HARD constraint on the widget layer: transparency is **binary**. A
   pixel is fully opaque or fully gone. Translucent panels are impossible (a half-alpha background
   blends against the key colour inside the page and lands on a non-key shade, so it renders as a
   solid slab), text antialiasing fringes at glyph edges, and nothing may ever paint ``KEY_RGB`` or
   it punches a hole.

2. **The overlay is captured by the grab that feeds OCR.** The ``adaptive`` capture backend uses
   ``mss`` on the foreground path — a screen-region grab, which includes anything drawn on top.
   Measured: 11.4% of the OCR input was overlay pixels, i.e. the overlay would feed itself.
   ``SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)`` removes it completely (0.000%). This
   is mandatory, not hardening.

3. **A transparent pywebview window steals the foreground.** ``focus=False`` does apply
   ``WS_EX_NOACTIVATE`` (``winforms.py:294``) but ``edgechromium.py:347`` still calls
   ``form.Activate()`` on navigation when transparent, and that wins — measured, the overlay held
   the foreground. Mitigated by navigating exactly ONCE (at creation; all later content changes
   happen in-page over SSE) and re-asserting the attached window afterwards.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import sys
import threading
import time
from ctypes import wintypes

# --------------------------------------------------------------------------- win32

GWL_EXSTYLE = -20
WS_EX_TRANSPARENT = 0x00000020
WS_EX_LAYERED = 0x00080000
WS_EX_NOACTIVATE = 0x08000000
WS_EX_TOOLWINDOW = 0x00000080

LWA_COLORKEY = 0x00000001
WDA_EXCLUDEFROMCAPTURE = 0x00000011      # Win10 2004+; older builds fail the call

HWND_TOPMOST = -1
SWP_NOACTIVATE = 0x0010
SWP_NOOWNERZORDER = 0x0200
SWP_SHOWWINDOW = 0x0040
SW_HIDE = 0
SW_SHOWNOACTIVATE = 4

# The colour-key: every pixel matching it becomes a hole, so it must be a shade the UI will never
# paint. Near-black but not black, so a genuine #000000 in content still renders.
KEY_RGB = (1, 2, 3)

# How often the overlay re-checks the attached window's client rect. A borderless game does not
# move, so this is about surviving alt-tab/resolution changes, not smooth dragging — cheap either
# way (two win32 calls, no GPU work, no redraw unless the rect actually changed).
FOLLOW_S = 0.1

user32 = ctypes.WinDLL("user32", use_last_error=True)

# Explicit signatures: the ctypes defaults truncate HWNDs and LONG_PTRs on 64-bit — the same class
# of bug oc.notify._killjob documents.
user32.GetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int]
user32.GetWindowLongPtrW.restype = ctypes.c_ssize_t
user32.SetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_ssize_t]
user32.SetWindowLongPtrW.restype = ctypes.c_ssize_t
user32.SetLayeredWindowAttributes.argtypes = [wintypes.HWND, wintypes.COLORREF,
                                              ctypes.c_ubyte, wintypes.DWORD]
user32.SetWindowDisplayAffinity.argtypes = [wintypes.HWND, wintypes.DWORD]
user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
                                ctypes.c_int, ctypes.c_int, wintypes.UINT]
user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
user32.SetForegroundWindow.argtypes = [wintypes.HWND]
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.IsWindow.argtypes = [wintypes.HWND]
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]

_ENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def _set_dpi_aware() -> None:
    """Declare per-monitor DPI awareness BEFORE any window exists.

    Without this the child is a scaled process: Windows silently multiplies every coordinate we
    pass to SetWindowPos by the monitor scale, so an overlay told to sit on a 1536x1728 client rect
    lands at 1920x2160 on a 125% display and misses the game entirely (measured).

    Same three-step fallback as ``oc.window.dpi`` — duplicated on purpose, because this file must
    not import the ``oc`` package (see the module docstring). Keep the two in sync.
    """
    try:
        # -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (Win10 1703+)
        if ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
            return
    except Exception:  # noqa: BLE001 - fall through to the older APIs
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)   # PROCESS_PER_MONITOR_DPI_AWARE
        return
    except Exception:  # noqa: BLE001
        pass
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:  # noqa: BLE001 - unscaled is better than crashing
        pass


def _dbg(msg: str) -> None:
    """Diagnostics go to stderr, which the parent sends to DEVNULL. stdout is the ack protocol and
    must carry nothing but ready/ok/err."""
    print(f"[overlay] {msg}", file=sys.stderr, flush=True)


def _awareness():
    """This process's DPI awareness — decides whether every coordinate below is physical or
    virtualized, which is exactly the bug class this file has already hit once."""
    try:
        ctx = ctypes.windll.user32.GetThreadDpiAwarenessContext()
        val = ctypes.windll.user32.GetAwarenessFromDpiAwarenessContext(ctx)
        return {0: "UNAWARE", 1: "SYSTEM", 2: "PER_MONITOR", 3: "PER_MONITOR_V2"}.get(val, val)
    except Exception as e:  # noqa: BLE001 - diagnostics only
        return f"?({e})"


def _client_box(hwnd):
    """(x, y, w, h) of ``hwnd``'s client area in absolute screen coords — the same math as
    ``oc.window.win32_provider._client_box``, so the overlay lines up with the region boxes the
    profile stores as fractions of exactly this rect. None if the window is gone."""
    if not hwnd or not user32.IsWindow(hwnd):
        return None
    r = wintypes.RECT()
    if not user32.GetClientRect(hwnd, ctypes.byref(r)):
        return None
    tl = wintypes.POINT(r.left, r.top)
    if not user32.ClientToScreen(hwnd, ctypes.byref(tl)):
        return None
    w, h = r.right - r.left, r.bottom - r.top
    if w <= 0 or h <= 0:
        return None
    return tl.x, tl.y, w, h


def _add_exstyle(hwnd, bits) -> None:
    cur = user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)
    user32.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, cur | bits)


def _child_hwnds(parent) -> list:
    """WebView2 hosts its own child HWNDs; the parent's ex-style does not cover them, so
    click-through has to be applied to each."""
    out: list = []

    def cb(hwnd, _):
        out.append(hwnd)
        return True

    user32.EnumChildWindows(parent, _ENUMPROC(cb), 0)
    return out


# --------------------------------------------------------------------------- the host


class OverlayHost:
    def __init__(self, url: str) -> None:
        self._url = url
        self._window = None
        self._hwnd = None
        self._target = 0          # the window we follow (0 = none)
        self._visible = False
        self._last_box = None
        self._stop = threading.Event()

    # ---- setup ------------------------------------------------------------

    def _resolve_hwnd(self, timeout: float = 20.0):
        """pywebview window -> HWND, mirroring oc.web.desktop._hwnd_of."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            native = getattr(self._window, "native", None)
            if native is not None:
                h = getattr(native, "Handle", None)
                if h is not None:
                    try:
                        return int(h.ToInt64())
                    except Exception:  # noqa: BLE001 - older bindings hand back a plain int
                        return int(h)
            time.sleep(0.05)
        return None

    def _colorkey(self) -> None:
        """Quirk 1: paint the host form the key colour and punch it out. Without this the overlay
        is an opaque grey sheet."""
        r, g, b = KEY_RGB
        try:
            import clr
            clr.AddReference("System.Drawing")
            from System.Drawing import Color
            form = self._window.native
            # WinForms property sets belong on the UI thread.
            if getattr(form, "InvokeRequired", False):
                from System import Action
                form.Invoke(Action(lambda: setattr(form, "BackColor", Color.FromArgb(255, r, g, b))))
            else:
                form.BackColor = Color.FromArgb(255, r, g, b)
        except Exception:  # noqa: BLE001 - an opaque overlay is bad but must not kill the host
            print("err colorkey", flush=True)
        _add_exstyle(self._hwnd, WS_EX_LAYERED)
        user32.SetLayeredWindowAttributes(self._hwnd, r | (g << 8) | (b << 16), 0, LWA_COLORKEY)

    def _harden(self) -> None:
        """Click-through, no-activate, off the taskbar, and out of every screen capture."""
        _add_exstyle(self._hwnd,
                     WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW)
        for kid in _child_hwnds(self._hwnd):
            _add_exstyle(kid, WS_EX_TRANSPARENT)   # quirk: parent ex-style misses WebView2 children
        # Quirk 2: mandatory. Without it the overlay lands in the mss grab that feeds OCR.
        user32.SetWindowDisplayAffinity(self._hwnd, WDA_EXCLUDEFROMCAPTURE)

    def setup(self) -> None:
        self._hwnd = self._resolve_hwnd()
        _dbg(f"setup hwnd={self._hwnd} awareness={_awareness()}")
        if not self._hwnd:
            print("err nohwnd", flush=True)
            return
        self._colorkey()
        self._harden()
        self._apply_visible()                       # start hidden until the parent says otherwise
        threading.Thread(target=self._follow_loop, daemon=True).start()
        print("ready", flush=True)

    # ---- geometry / visibility --------------------------------------------

    def _apply_visible(self) -> None:
        if not self._hwnd:
            return
        user32.ShowWindow(self._hwnd, SW_SHOWNOACTIVATE if self._visible else SW_HIDE)

    def _place(self, box) -> None:
        """Move/size the overlay onto ``box`` and re-assert topmost, without ever activating it.
        One SetWindowPos does position + size + z-order + no-activate."""
        x, y, w, h = box
        flags = SWP_NOACTIVATE | SWP_NOOWNERZORDER | (SWP_SHOWWINDOW if self._visible else 0)
        ok = user32.SetWindowPos(self._hwnd, wintypes.HWND(HWND_TOPMOST), x, y, w, h, flags)
        got = wintypes.RECT()
        user32.GetWindowRect(self._hwnd, ctypes.byref(got))
        _dbg(f"place asked={box} ok={bool(ok)} got=({got.left},{got.top},"
             f"{got.right - got.left},{got.bottom - got.top})")

    def _follow_loop(self) -> None:
        """Track the attached window's client rect. Only touches the window when the rect actually
        changed — a static borderless game costs two win32 calls per tick and nothing else."""
        while not self._stop.wait(FOLLOW_S):
            if not self._target or not self._visible:
                continue
            box = _client_box(self._target)
            if box is None or box == self._last_box:
                continue
            self._last_box = box
            try:
                self._place(box)
            except Exception:  # noqa: BLE001 - a transient placement failure retries next tick
                pass

    # ---- commands ---------------------------------------------------------

    def command(self, msg: dict) -> None:
        cmd = str(msg.get("cmd") or "")
        if cmd == "attach":
            self._target = int(msg.get("hwnd") or 0)
            self._last_box = None                   # force a re-place on the next follow tick
            box = _client_box(self._target)
            if box:
                self._last_box = box
                self._place(box)
            # Quirk 3: creation navigated once and that stole the foreground. Hand it back to the
            # window we are overlaying. Best-effort — Windows' foreground lock can refuse it.
            if self._target:
                user32.SetForegroundWindow(self._target)
        elif cmd in ("show", "hide"):
            self._visible = cmd == "show"
            box = _client_box(self._target) if self._target else None
            if box:
                self._last_box = box
                self._place(box)
            self._apply_visible()
        elif cmd == "capturable":
            # Let the overlay back INTO screen captures. Off by default and normally left off —
            # while on, the overlay lands in the mss grab that feeds OCR (quirk 2). Exists because
            # SetWindowDisplayAffinity only works from the thread that owns the window, so nothing
            # outside this process can toggle it: verifying the exclusion actually works, or
            # deliberately including the overlay in a recording, both have to go through here.
            on = bool(msg.get("on"))
            user32.SetWindowDisplayAffinity(self._hwnd, 0 if on else WDA_EXCLUDEFROMCAPTURE)
            _dbg(f"capturable={on}")
        elif cmd == "quit":
            self.shutdown()
        else:
            raise ValueError(f"unknown cmd {cmd!r}")

    def shutdown(self) -> None:
        self._stop.set()
        try:
            self._window.destroy()
        except Exception:  # noqa: BLE001 - already gone
            import os
            os._exit(0)

    # ---- stdin pump -------------------------------------------------------

    def serve_stdin(self) -> None:
        """One JSON command per line; ack ok/err. EOF = the parent died -> take the overlay with
        it (the server must never leave an undismissable click-through window on screen)."""
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                self.command(json.loads(line))
                print("ok", flush=True)
            except Exception:  # noqa: BLE001 - a bad command must never take the host down
                print("err", flush=True)
        self.shutdown()


def _serve(url: str) -> int:
    # Must precede any window creation, or every coordinate we set gets DPI-scaled behind us.
    _set_dpi_aware()

    import webview

    window = webview.create_window(
        "occ-overlay", url,
        transparent=True,      # EdgeChromium only (winforms.py:786)
        frameless=True,
        on_top=True,
        focus=False,           # applies WS_EX_NOACTIVATE for us (winforms.py:294)
        easy_drag=False,
        width=800, height=600,     # placeholder; the first "attach" sizes it to the game
    )
    host = OverlayHost(url)
    host._window = window

    def _boot(_w=None):
        # Runs only once the GUI loop is up and the form really exists — configuring earlier
        # hardens a window that has not been created yet (and finds none of the WebView2 child
        # HWNDs click-through depends on).
        try:
            window.events.loaded.wait(15)
        except Exception:  # noqa: BLE001 - older/newer pywebview event shapes
            time.sleep(1.0)
        host.setup()
        host.serve_stdin()

    webview.start(_boot, window)   # calls _boot on a thread after the GUI starts; blocks here
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--serve", action="store_true")
    ap.add_argument("--url", default="about:blank")
    args = ap.parse_args()
    if not args.serve:
        print("err: --serve is required", file=sys.stderr)
        return 2
    return _serve(args.url)


if __name__ == "__main__":
    raise SystemExit(main())
