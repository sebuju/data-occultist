"""`oc profiles` — list game profiles on disk."""

from __future__ import annotations

from ..profile import list_profiles
from ..settings import Settings


def register(sub) -> None:
    p = sub.add_parser("profiles", help="list game profiles")
    p.set_defaults(func=run)


def run(_args) -> int:
    settings = Settings.load()
    names = list_profiles(settings.profiles_dir)
    if not names:
        print("No profiles in", settings.profiles_dir)
        return 0
    for n in names:
        print(n)
    return 0
