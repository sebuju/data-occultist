"""Flip the shared OCR engine's device for the duration of a batch / live run, then
restore the baseline.

``"auto"`` device mode baselines the engine on CPU (snappy for sparse interactive reads)
and bursts to GPU only for high-throughput work — the precapture PROCESSING batch and the
live collection loop — where GPU batching wins. This is the ONE place that switch lives so
both callers share it. Going back to CPU drops the ONNX-runtime GPU session so its arena +
weights free; a small CUDA-context floor (~150MB) stays resident until the process exits —
the driver doesn't hand that back per batch, so 'freed on stop' means most, not all, VRAM.
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
    """Restore the pre-batch device. Returning to CPU drops the GPU session; a gc pass
    forces the ONNX-runtime session + arena to release NOW (set_device only clears the
    reference — without the collect the freed VRAM lingers until the next incidental gc).
    A small CUDA-context floor stays held by the driver until the process exits."""
    ocr = getattr(engine, "ocr", None)
    if prev is not None and ocr is not None and hasattr(ocr, "set_device"):
        ocr.set_device(prev == "gpu")
        if prev != "gpu":
            import gc
            gc.collect()
