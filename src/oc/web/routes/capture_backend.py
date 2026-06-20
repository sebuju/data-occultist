"""Switch the capture backend (wgc / printwindow / mss) at runtime, persisted across restarts.

Mirrors :mod:`routes.ocr`: ``settings.yaml`` holds the baseline ``capture:`` name (built at
``Engine.build``); a sidecar file overrides it live so a UI pick survives reloads without
rewriting the yaml. Swapping closes the outgoing backend first — the WGC backend runs a
free-threaded native capture thread that MUST be joined (``close()``) or interpreter exit
crashes ("Fatal Python error: ... import state already initialized").
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter

from ...registry import build_capture, capture_names
from ..deps import get_engine, get_settings

router = APIRouter(prefix="/api/capture", tags=["capture"])


def _backend_file() -> Path:
    return Path(get_settings().data_dir) / ".capture_backend"


def read_backend() -> str:
    """The persisted backend name, or the ``settings.yaml`` baseline if none/invalid.
    Tolerates a sidecar naming a backend that no longer registers (e.g. ``wgc`` without
    the wheel) by falling back to the settings default."""
    names = capture_names()
    try:
        v = _backend_file().read_text(encoding="utf-8").strip()
        if v in names:
            return v
    except OSError:
        pass
    return get_settings().capture.name


def _write_backend(name: str) -> None:
    try:
        p = _backend_file()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(name, encoding="utf-8")
    except OSError:
        pass


def _swap(name: str) -> None:
    """Point the live engine at a freshly-built backend, closing the outgoing one first
    (joins WGC's native thread). No-op if it's already the active backend's class."""
    engine = get_engine()
    new = build_capture(name)
    old = engine.capture
    engine.capture = new
    close = getattr(old, "close", None)
    if callable(close):
        try:
            close()
        except Exception:  # noqa: BLE001 - a wedged close must not block the swap
            pass


def apply_persisted() -> None:
    """Apply the persisted backend choice at startup, if it differs from the baseline the
    engine was built with. Called from the web warmup after the engine exists."""
    name = read_backend()
    if name != get_settings().capture.name:
        _swap(name)


def _state() -> dict:
    return {"name": read_backend(), "names": capture_names()}


@router.get("/backend")
def get_backend():
    return _state()


@router.post("/backend")
def set_backend(name: str):
    if name not in capture_names():
        return _state()
    _swap(name)
    _write_backend(name)
    return _state()
