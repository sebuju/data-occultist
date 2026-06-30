"""Switch the OCR engine between CPU and GPU at runtime, plus the GPU pacing knobs
(downscale + per-burst yield), all persisted across restarts."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter

from ...ocr.rapidocr_engine import cuda_available
from ..deps import get_engine, get_settings

router = APIRouter(prefix="/api/ocr", tags=["ocr"])


# Each runtime OCR knob is one scalar persisted to data/.ocr_<name>: a parse() that turns the
# stored text into a validated value (raising ValueError to fall back) and a default (a value
# or a zero-arg callable, e.g. to read a settings default). Three knobs ride this one helper
# instead of three hand-rolled file pairs (CLAUDE.md rule 7).
def _persisted(name: str, parse, default):
    def _path() -> Path:
        return Path(get_settings().data_dir) / f".ocr_{name}"

    def _default():
        return default() if callable(default) else default

    def read():
        try:
            return parse(_path().read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            return _default()

    def write(value) -> None:
        try:
            p = _path()
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(str(value), encoding="utf-8")
        except OSError:
            pass

    return read, write


# The OCR device MODE: "cpu" / "gpu" / "auto". "auto" runs OCR on CPU for the snappy
# interactive work (authoring nodes, preview, detect — sparse small reads where CUDA
# init + per-call overhead lose) and flips to GPU only for the precapture BATCH (many
# frames at once, where GPU batching wins), then frees the GPU again. Default = "auto".
_MODES = ("cpu", "gpu", "auto")
DEFAULT_MODE = "auto"


def _parse_mode(v: str) -> str:
    if v in _MODES:
        return v
    raise ValueError(v)   # legacy/garbage -> default


def _yield_default() -> float:
    """Settings-file default for the per-burst yield, so an unset dotfile falls back to the
    value shipped in config/settings.yaml (ocr.options.yield_ms) rather than a bare 0."""
    try:
        return float(get_settings().ocr.options.get("yield_ms", 0.0) or 0.0)
    except (AttributeError, TypeError, ValueError):
        return 0.0


read_mode, _write_mode = _persisted("device", _parse_mode, DEFAULT_MODE)
_read_scale, _write_scale = _persisted("scale", lambda v: max(1, int(v)), 1)
_read_yield, _write_yield = _persisted("yield", lambda v: max(0.0, float(v)), _yield_default)


def apply_persisted() -> None:
    """Apply the persisted device MODE, downscale factor, AND per-burst yield to the engine —
    called at startup so the selections survive reloads and restarts. ``auto``/``cpu`` baseline
    the engine on CPU (auto bursts to GPU per precapture batch); ``gpu`` pins it to GPU."""
    ocr = get_engine().ocr
    if hasattr(ocr, "set_device"):
        ocr.set_device(read_mode() == "gpu")
    if hasattr(ocr, "set_scale"):
        ocr.set_scale(_read_scale())
    if hasattr(ocr, "set_yield_ms"):
        ocr.set_yield_ms(_read_yield())


def _state() -> dict:
    ocr = get_engine().ocr
    return {"device": getattr(ocr, "device", "cpu"), "mode": read_mode(),
            "gpu_available": cuda_available(),
            "gpu_active": bool(getattr(ocr, "gpu_active", False)),
            "scale": getattr(ocr, "scale", 1),
            "yield_ms": getattr(ocr, "yield_ms", 0.0)}


def ocr_state() -> dict:
    """Public OCR device snapshot for the activity heartbeat (one poll feeds everything)."""
    return _state()


@router.get("/device")
def get_device():
    return _state()


@router.post("/device")
def set_device(device: str):
    """Set the device MODE (``cpu`` / ``gpu`` / ``auto``). ``gpu`` pins the engine to GPU;
    ``cpu`` and ``auto`` baseline it on CPU (auto bursts to GPU per precapture batch)."""
    mode = device if device in _MODES else DEFAULT_MODE
    ocr = get_engine().ocr
    if hasattr(ocr, "set_device"):
        ocr.set_device(mode == "gpu")
    _write_mode(mode)
    return _state()


@router.post("/release")
def release_gpu():
    """Kill the GPU OCR session to release VRAM. The model is dropped and rebuilt lazily
    on the next read; the device selection is left as-is."""
    ocr = get_engine().ocr
    if hasattr(ocr, "release"):
        ocr.release()
    return _state()


@router.post("/scale")
def set_scale(scale: int):
    ocr = get_engine().ocr
    if hasattr(ocr, "set_scale"):
        ocr.set_scale(scale)
    _write_scale(getattr(ocr, "scale", 1))
    return _state()


@router.post("/yield")
def set_yield(ms: float):
    """Set the per-burst GPU yield (ms slept between OCR submissions). Higher = the read is
    split into more, shorter GPU bursts with gaps a game can present in -> smoother frame
    pacing, slightly slower reads. 0 = off (one continuous burst)."""
    ocr = get_engine().ocr
    if hasattr(ocr, "set_yield_ms"):
        ocr.set_yield_ms(ms)
    _write_yield(getattr(ocr, "yield_ms", 0.0))
    return _state()
