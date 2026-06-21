"""Shared state for the web app: one Engine + Settings per process."""

from __future__ import annotations

from functools import lru_cache

from ..engine import Engine
from ..locate import WindowLocator
from ..settings import Settings
from .ocr_cache import OcrCache


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings.load()


@lru_cache(maxsize=8)
def get_ocr_cache(game: str) -> OcrCache:
    """One persisted OCR-result cache per game, reused across requests (the boot makes
    many cache reads — don't reparse the sidecar each time)."""
    return OcrCache.for_game(get_settings().data_dir, game)


@lru_cache(maxsize=1)
def get_engine() -> Engine:
    return Engine.build(get_settings())


@lru_cache(maxsize=1)
def get_locator() -> WindowLocator:
    return WindowLocator(get_engine())
