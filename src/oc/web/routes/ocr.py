"""Switch the OCR engine between CPU and GPU at runtime, persisted across restarts."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter

from ...ocr.rapidocr_engine import cuda_available
from ..deps import get_engine, get_settings

router = APIRouter(prefix="/api/ocr", tags=["ocr"])


def _device_file() -> Path:
    return Path(get_settings().data_dir) / ".ocr_device"


def _read_persisted() -> str | None:
    try:
        v = _device_file().read_text(encoding="utf-8").strip()
        return v if v in ("cpu", "gpu") else None
    except OSError:
        return None


def _write_persisted(device: str) -> None:
    try:
        p = _device_file()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(device, encoding="utf-8")
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
    """Apply the persisted CPU/GPU choice AND downscale factor to the engine — called at
    startup so the selection survives reloads and restarts."""
    ocr = get_engine().ocr
    dev = _read_persisted()
    if dev and hasattr(ocr, "set_device"):
        ocr.set_device(dev == "gpu")
    if hasattr(ocr, "set_scale"):
        ocr.set_scale(_read_scale())


def _state() -> dict:
    ocr = get_engine().ocr
    return {"device": getattr(ocr, "device", "cpu"), "gpu_available": cuda_available(),
            "scale": getattr(ocr, "scale", 1)}


@router.get("/device")
def get_device():
    return _state()


@router.post("/device")
def set_device(device: str):
    ocr = get_engine().ocr
    if hasattr(ocr, "set_device"):
        ocr.set_device(device == "gpu")
    state = _state()
    _write_persisted(state["device"])
    return state


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
