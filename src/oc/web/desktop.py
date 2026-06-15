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

    # Resize is driven by the front-end's edge grips (the window is frameless, so the OS
    # gives no sizing border; the page sees the edge mouse and calls this). Move + resize in
    # ONE bridge call so the window doesn't jitter between the two steps. JS numbers -> int.
    def set_bounds(self, x, y, width, height) -> None:
        if _window is not None:
            _window.move(int(x), int(y))
            _window.resize(int(width), int(height))


def _hwnd_of(window):
    """The native Win32 HWND (int) for a pywebview window, or None.

    WinForms/EdgeChromium hands back a .NET ``IntPtr``, not a Python int. Returns None
    off-Windows, on a backend without a HWND, or before the window is shown.
    """
    try:
        handle = window.native.Handle
        return handle.ToInt64() if hasattr(handle, "ToInt64") else int(handle)
    except Exception:  # pragma: no cover - non-Windows / backend without a HWND
        return None


def _set_window_icon(window, ico_path) -> None:
    """Pin the taskbar / alt-tab icon to the app favicon via WM_SETICON.

    pywebview's ``start(icon=)`` sets the form icon, but under ``pythonw`` the taskbar can
    still show the interpreter's icon. Sending WM_SETICON for both the small (title /
    alt-tab) and big (taskbar) sizes pins OUR icon on the actual window. Paired with the
    explicit AppUserModelID set in ``open_window`` so Windows treats this as its own app
    rather than grouping it under pythonw. No-ops off-Windows / when the .ico is missing.
    """
    hwnd = _hwnd_of(window)
    if hwnd is None or not ico_path.exists():
        return
    try:
        import ctypes

        user32 = ctypes.windll.user32
        IMAGE_ICON, LR_LOADFROMFILE, WM_SETICON = 1, 0x0010, 0x0080
        for px, which in ((16, 0), (32, 1)):   # ICON_SMALL=0 (title/alt-tab), ICON_BIG=1 (taskbar)
            hicon = user32.LoadImageW(None, str(ico_path), IMAGE_ICON, px, px, LR_LOADFROMFILE)
            if hicon:
                user32.SendMessageW(hwnd, WM_SETICON, which, hicon)
    except Exception:  # pragma: no cover - defensive; never block window startup
        return


def open_window(url: str, *, title: str = "data-rig", size: tuple[int, int] = (1400, 900)):
    """Open a native window onto ``url`` and block until it is closed.

    pywebview's ``start()`` must own the main thread, so call this last. A missing
    ``desktop`` extra surfaces as a clear install hint rather than an ImportError.

    The window is **frameless** — the front-end draws its own title bar and edge resize
    grips (visible only inside the desktop window, never in a browser) and drives move /
    resize / min / max / close through the ``js_api`` bridge. ``easy_drag`` is off so only
    the front-end's ``pywebview-drag-region`` bar moves the window, not the whole page.
    Frameless is kept dead-simple (no win32 frame hacks): the OS draws nothing, so there's
    no stray border, and resizing is owned entirely by the page's grips.
    """
    try:
        import webview
    except ModuleNotFoundError as exc:  # pragma: no cover - env-dependent
        raise SystemExit(
            "The desktop window needs pywebview. Install it with:\n"
            '    pip install -e ".[desktop]"\n'
            "(on Windows it uses the Edge WebView2 runtime, preinstalled on Win11)."
        ) from exc

    # Taskbar icon = the app favicon (static/favicon.ico, same artwork as favicon.svg,
    # generated by packaging/make_icon.py). Give the process an explicit AppUserModelID
    # FIRST so Windows treats this as its own app instead of grouping it under pythonw
    # (and showing pythonw's icon). No-ops off-Windows.
    from pathlib import Path

    icon = Path(__file__).resolve().parent / "static" / "favicon.ico"
    try:
        import ctypes

        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("data-rig.desktop")
    except Exception:  # pragma: no cover - non-Windows / shell32 unavailable
        pass

    global _window
    chrome = _WindowChrome()
    _window = webview.create_window(
        title, url, width=size[0], height=size[1],
        frameless=True, easy_drag=False, resizable=True, js_api=chrome,
    )

    # On show (native handle now exists): pin the favicon onto the window so the taskbar
    # shows it, not the python/pythonw icon.
    def _on_shown() -> None:
        _set_window_icon(_window, icon)

    _window.events.shown += _on_shown
    webview.start(icon=str(icon) if icon.exists() else None)
