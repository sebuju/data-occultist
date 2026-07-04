"""Per-focus capture backends, persisted across restarts.

Capture always runs a per-grab focus switch: a FOREGROUND grabber (used while the game is
the focused window — cheapest wins, e.g. ``mss``: a CPU BitBlt, no GPU) and a BACKGROUND
grabber (used while it's occluded/backgrounded — must read the window's own surface, e.g.
``printwindow`` or ``wgc``). Each is a plain capture backend chosen by name; the live engine
runs the composite built from the two. Set both to the same name for single-backend
behaviour.

Mirrors :mod:`routes.ocr`: ``settings.yaml`` holds the baseline (built at ``Engine.build``);
sidecar files override it live so a UI pick survives reloads without rewriting the yaml.
Swapping closes the outgoing backend first — the WGC backend runs a free-threaded native
capture thread that MUST be joined (``close()``) or interpreter exit crashes ("Fatal Python
error: ... import state already initialized").
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter

from ...registry import build_capture, capture_names
from ..deps import get_engine, get_settings

router = APIRouter(prefix="/api/capture", tags=["capture"])

# The internal per-grab focus dispatcher's registry name — never shown in the UI; the user
# only picks its foreground/background sub-backends. A composite can't nest inside itself, so
# it's excluded from the selectable grabber list.
_COMPOSITE = "adaptive"


def _sidecar(suffix: str) -> Path:
    return Path(get_settings().data_dir) / f".capture_{suffix}"


def _sub_names() -> list[str]:
    """Backends selectable as the foreground/background grabber — every plain backend (the
    composite dispatcher itself excluded so it can't nest)."""
    return [n for n in capture_names() if n != _COMPOSITE]


def _read_sub(suffix: str, default: str) -> str:
    """A persisted grabber name (foreground/background), falling back to the settings.yaml
    capture option then a hard default. Ignores a sidecar naming a gone/composite backend."""
    valid = _sub_names()
    try:
        v = _sidecar(suffix).read_text(encoding="utf-8").strip()
        if v in valid:
            return v
    except OSError:
        pass
    opt = get_settings().capture.options.get(suffix)
    return opt if opt in valid else default


def read_foreground() -> str:
    return _read_sub("foreground", "mss")


def read_background() -> str:
    return _read_sub("background", "printwindow")


def _write_sidecar(suffix: str, value: str) -> None:
    try:
        p = _sidecar(suffix)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(value, encoding="utf-8")
    except OSError:
        pass


def _build():
    return build_capture(_COMPOSITE, foreground=read_foreground(), background=read_background())


def _swap() -> None:
    """Rebuild the live composite from the persisted foreground/background, closing the
    outgoing backend first (joins WGC's native thread)."""
    engine = get_engine()
    new = _build()
    old = engine.capture
    engine.capture = new
    close = getattr(old, "close", None)
    if callable(close):
        try:
            close()
        except Exception:  # noqa: BLE001 - a wedged close must not block the swap
            pass


def apply_persisted() -> None:
    """Point the live engine at the persisted foreground/background if they differ from what
    it was built with. Called from the web warmup after the engine exists."""
    cap = get_engine().capture
    want = (read_foreground(), read_background())
    cur = (getattr(cap, "foreground", None), getattr(cap, "background", None))
    if cur != want:
        _swap()


def _state() -> dict:
    return {"sub_names": _sub_names(),
            "foreground": read_foreground(),
            "background": read_background()}


@router.get("/backend")
def get_backend():
    return _state()


@router.post("/backend")
def set_backend(foreground: str | None = None, background: str | None = None):
    """Set the foreground and/or background grabber (each a plain backend name), then rebuild
    the live composite. Unknown names are ignored."""
    changed = False
    if foreground in _sub_names():
        _write_sidecar("foreground", foreground)
        changed = True
    if background in _sub_names():
        _write_sidecar("background", background)
        changed = True
    if changed:
        _swap()
    return _state()
