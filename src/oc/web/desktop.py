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


def open_window(url: str, *, title: str = "data-rig", size: tuple[int, int] = (1400, 900)):
    """Open a native window onto ``url`` and block until it is closed.

    pywebview's ``start()`` must own the main thread, so call this last. A missing
    ``desktop`` extra surfaces as a clear install hint rather than an ImportError.
    """
    try:
        import webview
    except ModuleNotFoundError as exc:  # pragma: no cover - env-dependent
        raise SystemExit(
            "The desktop window needs pywebview. Install it with:\n"
            '    pip install -e ".[desktop]"\n'
            "(on Windows it uses the Edge WebView2 runtime, preinstalled on Win11)."
        ) from exc

    webview.create_window(title, url, width=size[0], height=size[1])
    webview.start()
