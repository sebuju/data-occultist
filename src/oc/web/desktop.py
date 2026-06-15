"""Desktop-window helpers for the web UI.

Wrap the same FastAPI app the browser uses in a native window via ``pywebview``
(on Windows it renders through the Edge WebView2 runtime — pip-only, no Electron).
Everything pywebview-related is imported lazily so a missing ``desktop`` extra only
breaks the desktop launchers, never ``data-rig rig`` / tests / CI.

Two pieces compose into the launchers:
- ``serve_in_thread`` runs uvicorn on a daemon thread (release mode owns the server
  in-process, so closing the window can stop it and let the lifespan reap workers).
- ``open_window`` shows the native window and blocks until the user closes it.
``data-rig view`` uses only ``open_window`` (it attaches to a server it didn't start);
``data-rig app`` / the shortcut uses both.
"""

from __future__ import annotations

import socket
import threading
import time


def free_port(host: str = "127.0.0.1") -> int:
    """Grab a currently-free TCP port by binding to port 0 and reading it back.

    Release mode picks a fresh port per launch so two instances never clash and we
    never hit "address already in use" on a fixed 8000.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return s.getsockname()[1]


def serve_in_thread(host: str = "127.0.0.1", port: int = 8000, *, timeout: float = 30.0):
    """Start the web app on a uvicorn server running on a daemon thread.

    Returns the live ``uvicorn.Server`` so the caller can stop it cleanly
    (``server.should_exit = True``). Blocks until the server reports ``started`` so
    the window never points at a not-yet-listening socket. The thread is a daemon, so
    even an unclean exit can't keep the process alive.
    """
    import uvicorn

    config = uvicorn.Config("oc.web.app:app", host=host, port=port, log_level="warning")
    server = uvicorn.Server(config)
    threading.Thread(target=server.run, daemon=True).start()

    deadline = time.monotonic() + timeout
    while not server.started:
        if time.monotonic() > deadline:
            raise TimeoutError(f"web server did not start within {timeout:.0f}s")
        time.sleep(0.05)
    return server


# The live frameless Window + its maximised flag live at MODULE level, never as
# attributes of the js_api instance below. pywebview serialises the api object to
# inject it into the page; if it could reach the Window it would recurse forever
# through the native control (``window.native.AccessibilityObject.Bounds.Empty...``)
# and the window freezes at ``pywebviewready``. Keeping the api instance attribute-free
# (empty ``__dict__``) avoids that entirely.
_window = None
_maxed = False


class _WindowChrome:
    """JS-callable window controls for the frameless desktop window.

    The window is opened frameless (no OS title bar), so the front-end draws its own
    bar (``static/js/titlebar.js``) and calls these through pywebview's ``js_api``
    bridge: ``window.pywebview.api.minimize()`` etc. The methods reach the live Window
    via the module global ``_window`` (NOT an instance attribute — see note above) and
    no-op until it is set, so an early call can't raise.
    """

    def minimize(self) -> None:
        if _window is not None:
            _window.minimize()

    def toggle_maximize(self) -> None:
        global _maxed
        if _window is None:
            return
        # pywebview's Window has no public maximize on every backend; prefer it when
        # present (real maximize, taskbar kept), else fall back to fullscreen toggle.
        maximize = getattr(_window, "maximize", None)
        restore = getattr(_window, "restore", None)
        if maximize is not None and restore is not None:
            (restore if _maxed else maximize)()
        else:
            _window.toggle_fullscreen()
        _maxed = not _maxed

    def close(self) -> None:
        if _window is not None:
            _window.destroy()


def _restore_sizing_border(window) -> None:
    """Give a frameless window back native edge/corner resize (+ Aero-snap).

    ``frameless=True`` drops the whole OS frame, including the invisible sizing border,
    so the window can't be dragged-resized. On Windows we re-add the ``WS_THICKFRAME``
    sizing border (and a maximise box for snap) directly on the native HWND — that
    restores real OS resizing from every edge WITHOUT bringing the caption back. The
    front-end's titlebar still owns move/min/max/close. Runs on the ``shown`` event,
    when the native handle exists. Any failure (non-Windows, no HWND) leaves the window
    as-is rather than raising.
    """
    try:
        import ctypes

        # WinForms/EdgeChromium hands back a .NET IntPtr, not a Python int.
        handle = window.native.Handle
        hwnd = handle.ToInt64() if hasattr(handle, "ToInt64") else int(handle)
    except Exception:  # pragma: no cover - non-Windows / backend without a HWND
        return
    GWL_STYLE = -16
    WS_THICKFRAME = 0x00040000
    WS_MAXIMIZEBOX = 0x00010000
    # SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_FRAMECHANGED — restyle in place.
    SWP_FLAGS = 0x0001 | 0x0002 | 0x0004 | 0x0020
    try:
        user32 = ctypes.windll.user32
        style = user32.GetWindowLongW(hwnd, GWL_STYLE)
        user32.SetWindowLongW(hwnd, GWL_STYLE, style | WS_THICKFRAME | WS_MAXIMIZEBOX)
        user32.SetWindowPos(hwnd, 0, 0, 0, 0, 0, SWP_FLAGS)
    except Exception:  # pragma: no cover - defensive; never block window startup
        return


def open_window(url: str, *, title: str = "data-rig", size: tuple[int, int] = (1400, 900)):
    """Open a native window onto ``url`` and block until it is closed.

    pywebview's ``start()`` must own the main thread, so call this last. A missing
    ``desktop`` extra surfaces as a clear install hint rather than an ImportError.

    The window is **frameless** — the front-end draws its own title bar (visible only
    inside the desktop window, never in a browser). ``easy_drag`` is off so only the
    front-end's ``pywebview-drag-region`` bar moves the window, not the whole page.
    """
    try:
        import webview
    except ModuleNotFoundError as exc:  # pragma: no cover - env-dependent
        raise SystemExit(
            "The desktop window needs pywebview. Install it with:\n"
            '    pip install -e ".[desktop]"\n'
            "(on Windows it uses the Edge WebView2 runtime, preinstalled on Win11)."
        ) from exc

    global _window
    chrome = _WindowChrome()
    _window = webview.create_window(
        title, url, width=size[0], height=size[1],
        frameless=True, easy_drag=False, resizable=True, js_api=chrome,
    )
    # Frameless drops the OS sizing border; re-add it once the native handle exists so
    # the window resizes from every edge like a normal one.
    _window.events.shown += lambda: _restore_sizing_border(_window)

    # Taskbar icon = the app favicon (static/favicon.ico, same artwork as favicon.svg,
    # generated by packaging/make_icon.py). Without this the taskbar shows the bare
    # python/pythonw icon. Missing file -> pywebview's default, no crash. (Frameless,
    # so there is no OS title bar — only the taskbar entry uses this.)
    from pathlib import Path

    icon = Path(__file__).resolve().parent / "static" / "favicon.ico"
    webview.start(icon=str(icon) if icon.exists() else None)
