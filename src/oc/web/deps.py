"""Shared state for the web app: one Engine + Settings per process."""

from __future__ import annotations

from functools import lru_cache

from ..engine import Engine
from ..locate import WindowLocator
from ..settings import Settings


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings.load()


@lru_cache(maxsize=1)
def get_engine() -> Engine:
    return Engine.build(get_settings())


@lru_cache(maxsize=1)
def get_locator() -> WindowLocator:
    return WindowLocator(get_engine())
