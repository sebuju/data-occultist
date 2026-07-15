"""Shared state for the web app: one Engine + Settings per process."""

from __future__ import annotations

from functools import lru_cache

from ..engine import Engine
from ..locate import WindowLocator
from ..settings import Settings
from .ocr_cache import OcrCache
from .view_cache import ViewCache


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings.load()


@lru_cache(maxsize=8)
def get_ocr_cache(game: str) -> OcrCache:
    """One persisted OCR-result cache per game, reused across requests (the boot makes
    many cache reads — don't reparse the sidecar each time)."""
    return OcrCache.for_game(get_settings().data_dir, game)


@lru_cache(maxsize=8)
def get_view_cache(game: str) -> ViewCache:
    """One persisted subset-view cache per game, reused across requests — same
    reasoning as :func:`get_ocr_cache`."""
    return ViewCache.for_game(get_settings().data_dir, game)


@lru_cache(maxsize=1)
def get_engine() -> Engine:
    return Engine.build(get_settings())


@lru_cache(maxsize=1)
def get_notifier():
    """The OS-notification backend, built standalone (cheap — no OCR/capture stack) so the
    trigger schedulers can raise toasts without forcing the heavy Engine to build. Falls back
    to the ``null`` no-op notifier off-Windows (see :func:`oc.registry.build_notifier`)."""
    from ..registry import build_notifier

    s = get_settings()
    return build_notifier(s.notifier.name, **s.notifier.options)


@lru_cache(maxsize=1)
def get_locator() -> WindowLocator:
    return WindowLocator(get_engine())
