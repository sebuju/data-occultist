"""`oc capture <game>` — grab the game window once and save a PNG."""

from __future__ import annotations

from pathlib import Path

import cv2

from ..engine import Engine
from ..locate import locate_window
from ..profile import load_profile


def register(sub) -> None:
    p = sub.add_parser("capture", help="save one screenshot of a game window")
    p.add_argument("game", help="profile name")
    p.add_argument("--out", default="capture.png", help="output PNG path")
    p.set_defaults(func=run)


def run(args) -> int:
    engine = Engine.build()
    profile = load_profile(engine.settings.profiles_dir, args.game)
    win = locate_window(engine, profile)
    if win is None:
        print(f"Window for {args.game!r} not found (is the game running and visible?)")
        return 1
    frame = engine.capture.grab_window(win)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(out), frame.image):
        print(f"Failed to write {out}")
        return 1
    print(f"Saved {out}  ({frame.client.w}x{frame.client.h})")
    return 0
