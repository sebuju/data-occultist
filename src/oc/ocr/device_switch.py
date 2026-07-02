"""Flip the shared OCR engine's device for the duration of a batch / live run, then
restore the baseline.

``"auto"`` device mode baselines the engine on CPU (snappy for sparse interactive reads)
and bursts to GPU only for high-throughput work — the precapture PROCESSING batch and the
live collection loop — where GPU batching wins. This is the ONE place that switch lives so
both callers share it (going back to CPU drops the CUDA session, freeing the VRAM).
"""

from __future__ import annotations

from typing import Any


def enter_device(engine: Any, want: str | None) -> str | None:
    """Flip ``engine.ocr`` to ``want`` (``"gpu"``/``"cpu"``) for a batch. Returns the device
    to restore afterwards, or ``None`` when no switch happened (already there, no engine,
    or GPU requested but unavailable)."""
    ocr = getattr(engine, "ocr", None)
    if not want or ocr is None or not hasattr(ocr, "set_device"):
        return None
    if getattr(ocr, "device", None) == want:
        return None
    if want == "gpu":
        from .cuda import cuda_available
        if not cuda_available():
            return None
    prev = ocr.device
    ocr.set_device(want == "gpu")
    return prev


def exit_device(engine: Any, prev: str | None) -> None:
    """Restore the pre-batch device. Going back to CPU drops the CUDA session, so the GPU's
    VRAM is freed the moment the batch ends."""
    ocr = getattr(engine, "ocr", None)
    if prev is not None and ocr is not None and hasattr(ocr, "set_device"):
        ocr.set_device(prev == "gpu")
