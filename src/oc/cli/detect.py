"""`oc detect` — show which known game profiles are currently running."""

from __future__ import annotations

from ..engine import Engine
from ..locate import locate_window
from ..profile import list_profiles, load_profile


def register(sub) -> None:
    p = sub.add_parser("detect", help="show running known games")
    p.set_defaults(func=run)


def run(_args) -> int:
    engine = Engine.build()
    settings = engine.settings
    names = list_profiles(settings.profiles_dir)
    if not names:
        print("No profiles found in", settings.profiles_dir)
        return 0
    for name in names:
        profile = load_profile(settings.profiles_dir, name)
        win = locate_window(engine, profile)
        if win:
            print(f"[running] {name:16} -> '{win.title}' client={win.client.as_tuple()}")
        else:
            print(f"[ off   ] {name}")
    return 0
