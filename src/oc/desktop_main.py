"""Release-mode entry: start the web server AND a native window in ONE process,
then kill the server when the window closes.

This is what the install.ps1 desktop shortcut runs (``pythonw -m oc.desktop_main``),
and what ``data-rig app`` runs from a terminal — same code. The server lives on an
in-process daemon thread, so closing the window (which unblocks ``open_window``)
lets us stop it cleanly; even an unclean exit can't leave it running.

Contrast with ``data-rig view``, which only attaches to a server it did not start and
so never stops one.
"""

from __future__ import annotations

import os


def run_release() -> int:
    import sys

    # Under pythonw (the desktop shortcut / #app.bat / app.ps1 -> no console) Python sets
    # sys.stdout/stderr to None. uvicorn's logging and pywebview write to them, which
    # raises and the window never opens (the process dies with exit 1). Point the missing
    # streams at the null device so that library output is harmlessly dropped.
    if sys.stdout is None or sys.stderr is None:
        devnull = open(os.devnull, "w")  # noqa: SIM115 - lives for the whole process
        if sys.stdout is None:
            sys.stdout = devnull
        if sys.stderr is None:
            sys.stderr = devnull

    # Absolute import so this works both as `data-rig app` (installed package) and as
    # `pythonw -m oc.desktop_main` (the install.ps1 shortcut), regardless of __main__.
    from oc.web.desktop import free_port, open_window, serve_in_thread

    port = free_port()
    server = serve_in_thread("127.0.0.1", port)

    # Headless self-test: with OC_DESKTOP_SMOKE=1 we start + probe + stop the server
    # without opening a window. Lets the release path be verified in CI / a terminal
    # (where the real risk is the string-loaded "oc.web.app:app" failing to import).
    if os.environ.get("OC_DESKTOP_SMOKE") == "1":
        import urllib.request
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=10) as r:
                ok = r.status == 200
            print(f"smoke: server on {port} -> {'OK' if ok else 'FAIL'}")
            return 0 if ok else 1
        finally:
            server.should_exit = True

    try:
        open_window(f"http://127.0.0.1:{port}")   # blocks until the window is closed
    finally:
        server.should_exit = True                 # then stop the server (daemon thread)
    return 0


def main() -> int:
    return run_release()


if __name__ == "__main__":
    raise SystemExit(main())
