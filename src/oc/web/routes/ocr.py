"""Switch the OCR engine between CPU and GPU at runtime, persisted across restarts."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter

from ...ocr.rapidocr_engine import cuda_available
from ..deps import get_engine, get_settings

router = APIRouter(prefix="/api/ocr", tags=["ocr"])


def _device_file() -> Path:
    return Path(get_settings().data_dir) / ".ocr_device"


# The OCR device MODE: "cpu" / "gpu" / "auto". "auto" runs OCR on CPU for the snappy
# interactive work (authoring nodes, preview, detect — sparse small reads where CUDA
# init + per-call overhead lose) and flips to GPU only for the precapture BATCH (many
# frames at once, where GPU batching wins), then frees the GPU again. Default = "auto".
_MODES = ("cpu", "gpu", "auto")
DEFAULT_MODE = "auto"


def read_mode() -> str:
    """The persisted device MODE, defaulting to ``auto``. Tolerates the legacy file that
    stored a bare ``cpu``/``gpu``."""
    try:
        v = _device_file().read_text(encoding="utf-8").strip()
        return v if v in _MODES else DEFAULT_MODE
    except OSError:
        return DEFAULT_MODE


def _write_mode(mode: str) -> None:
    try:
        p = _device_file()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(mode, encoding="utf-8")
    except OSError:
        pass


def _scale_file() -> Path:
    return Path(get_settings().data_dir) / ".ocr_scale"


def _read_scale() -> int:
    try:
        return max(1, int(_scale_file().read_text(encoding="utf-8").strip()))
    except (OSError, ValueError):
        return 1


def apply_persisted() -> None:
    """Apply the persisted device MODE AND downscale factor to the engine — called at
    startup so the selection survives reloads and restarts. ``auto``/``cpu`` baseline the
    engine on CPU (auto bursts to GPU per precapture batch); ``gpu`` pins it to GPU."""
    ocr = get_engine().ocr
    if hasattr(ocr, "set_device"):
        ocr.set_device(read_mode() == "gpu")
    if hasattr(ocr, "set_scale"):
        ocr.set_scale(_read_scale())


def _state() -> dict:
    ocr = get_engine().ocr
    return {"device": getattr(ocr, "device", "cpu"), "mode": read_mode(),
            "gpu_available": cuda_available(),
            "gpu_active": bool(getattr(ocr, "gpu_active", False)),
            "scale": getattr(ocr, "scale", 1)}


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
    try:
        p = _scale_file()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(str(getattr(ocr, "scale", 1)), encoding="utf-8")
    except OSError:
        pass
    return _state()
