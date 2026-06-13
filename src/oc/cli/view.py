"""`data-rig view` — open the web UI in a native window onto a RUNNING server.

This launcher starts no server and stops no server: it just points a desktop window
at an existing ``data-rig rig`` (default ``http://127.0.0.1:8000``). Closing the window
leaves that server running — only release mode (`data-rig app` / the shortcut) owns and
kills its own server.
"""

from __future__ import annotations


def register(sub) -> None:
    p = sub.add_parser("view", help="open the UI in a native window (server must be running)")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.set_defaults(func=run)


def run(args) -> int:
    from ..web.desktop import open_window

    open_window(f"http://{args.host}:{args.port}")
    return 0
