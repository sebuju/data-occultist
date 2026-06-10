"""Switch the OCR engine between CPU and GPU at runtime."""

from __future__ import annotations

from fastapi import APIRouter

from ...ocr.rapidocr_engine import cuda_available
from ..deps import get_engine

router = APIRouter(prefix="/api/ocr", tags=["ocr"])


def _state() -> dict:
    ocr = get_engine().ocr
    return {"device": getattr(ocr, "device", "cpu"), "gpu_available": cuda_available()}


@router.get("/device")
def get_device():
    return _state()


@router.post("/device")
def set_device(device: str):
    ocr = get_engine().ocr
    if hasattr(ocr, "set_device"):
        ocr.set_device(device == "gpu")
    return _state()
