"""Resolve (and cache) the on-screen window for a game profile.

Process enumeration can be very slow on Windows (first scan ~seconds, e.g. AV
inspection), so we never want to do it per frame. :class:`WindowLocator` finds the
window once, then on subsequent calls just revalidates the cached handle via
``WindowProvider.from_handle`` (microseconds) and only re-scans if the window has
gone away. Shared by the collector loop and the web teaching UI.

``locate_window`` remains for one-shot CLI use where caching adds nothing.
"""

from __future__ import annotations

from .engine import Engine
from .profile.models import GameProfile
from .types import WindowInfo


def _scan(engine: Engine, profile: GameProfile) -> WindowInfo | None:
    proc = engine.process.find_by_names(profile.process_names)
    if proc is not None:
        win = engine.window.find_for_pid(proc.pid)
        if win is not None:
            return win
    if profile.window_title_hint:
        return engine.window.find_by_title(profile.window_title_hint)
    return None


def locate_window(engine: Engine, profile: GameProfile) -> WindowInfo | None:
    """One-shot, uncached lookup (for CLI commands)."""
    return _scan(engine, profile)


class WindowLocator:
    """Caches the located window per profile and revalidates cheaply."""

    def __init__(self, engine: Engine) -> None:
        self._engine = engine
        self._cache: dict[str, int] = {}  # profile name -> window handle

    def locate(self, profile: GameProfile) -> WindowInfo | None:
        handle = self._cache.get(profile.name)
        if handle is not None:
            info = self._engine.window.from_handle(handle)
            if info is not None:
                return info  # still valid; geometry refreshed
            self._cache.pop(profile.name, None)  # gone -> fall through to rescan

        info = _scan(self._engine, profile)
        if info is not None:
            self._cache[profile.name] = info.handle
        return info
