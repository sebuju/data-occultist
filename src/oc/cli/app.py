"""`data-occultist app` — release mode: start the server + native window, kill the server on close.

Terminal-runnable twin of the install.ps1 desktop shortcut; both call the same
``desktop_main.run_release``. Closing the window stops the in-process server.
"""

from __future__ import annotations


def register(sub) -> None:
    p = sub.add_parser("app", help="run server + native window (closing window stops the server)")
    p.set_defaults(func=run)


def run(_args) -> int:
    from ..desktop_main import run_release

    return run_release()
