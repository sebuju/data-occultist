"""OCR via RapidOCR (ONNX runtime). No system binary required."""

from __future__ import annotations

import glob
import os

import numpy as np

from ..interfaces import OcrEngine
from ..registry import register_ocr
from ..types import OcrLine, PixelBox

_CUDA_DLLS_REGISTERED = False


def _register_cuda_dlls() -> None:
    """Add the pip-installed NVIDIA CUDA/cuDNN DLL folders to the search path so the
    CUDA execution provider can load (the nvidia-*-cu12 wheels drop DLLs under
    site-packages/nvidia/<lib>/bin on Windows). No-op off Windows / if absent."""
    global _CUDA_DLLS_REGISTERED
    if _CUDA_DLLS_REGISTERED:
        return
    _CUDA_DLLS_REGISTERED = True
    if os.name != "nt":
        return
    try:
        import nvidia
        base = os.path.dirname(nvidia.__file__)
        dirs = glob.glob(os.path.join(base, "*", "bin")) + glob.glob(os.path.join(base, "*", "lib"))
        for d in dirs:
            try:
                os.add_dll_directory(d)
            except OSError:
                pass
        if dirs:   # also on PATH — onnxruntime's CUDA provider resolves its deps that way
            os.environ["PATH"] = os.pathsep.join(dirs) + os.pathsep + os.environ.get("PATH", "")
    except Exception:
        pass


def cuda_available() -> bool:
    """True when onnxruntime exposes the CUDA provider (the GPU package is installed)."""
    try:
        import onnxruntime as ort
        return "CUDAExecutionProvider" in ort.get_available_providers()
    except Exception:
        return False


@register_ocr("rapidocr")
class RapidOcrEngine(OcrEngine):
    """Wraps :class:`rapidocr_onnxruntime.RapidOCR`.

    The model is loaded lazily on first use so importing this module (e.g. for
    registry discovery) stays cheap.
    """

    def __init__(self, **options) -> None:
        self._gpu = bool(options.pop("use_gpu", False))   # settings.ocr.options.use_gpu
        self._options = options
        self._engine = None
        if self._gpu:
            _register_cuda_dlls()

    @property
    def device(self) -> str:
        return "gpu" if self._gpu else "cpu"

    def set_device(self, gpu: bool) -> None:
        """Switch CPU<->GPU at runtime. Rebuilds the model on next use."""
        gpu = bool(gpu)
        if gpu == self._gpu and self._engine is not None:
            return
        self._gpu = gpu
        if gpu:
            _register_cuda_dlls()
        self._engine = None   # force re-init with the new providers

    def _ensure_engine(self):
        if self._engine is None:
            from rapidocr_onnxruntime import RapidOCR

            opts = dict(self._options)
            if self._gpu:   # CUDA for detection, recognition and angle classification
                opts.update(det_use_cuda=True, rec_use_cuda=True, cls_use_cuda=True)
            self._engine = RapidOCR(**opts)
        return self._engine

    def read_line(self, image: np.ndarray) -> tuple[str, float]:
        """Recognition-only: skip detection (and angle classification) for a crop the
        caller knows is one line. Many times cheaper than ``read_image``."""
        if image is None or image.size == 0:
            return "", 0.0
        engine = self._ensure_engine()
        result, _elapsed = engine(image, use_det=False, use_cls=False, use_rec=True)
        if not result:
            return "", 0.0
        # rec-only returns [(text, score), ...] (no box) — join the pieces.
        texts, scores = [], []
        for item in result:
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                texts.append(str(item[-2]))
                scores.append(float(item[-1]))
        if not texts:
            return "", 0.0
        return " ".join(t for t in texts).strip(), sum(scores) / len(scores)

    def read_image(self, image: np.ndarray) -> list[OcrLine]:
        engine = self._ensure_engine()
        result, _elapsed = engine(image)
        if not result:
            return []
        lines: list[OcrLine] = []
        for box_pts, text, score in result:
            # box_pts: 4 (x, y) corners. Reduce to an axis-aligned bounds.
            xs = [p[0] for p in box_pts]
            ys = [p[1] for p in box_pts]
            x0, y0 = int(min(xs)), int(min(ys))
            lines.append(
                OcrLine(
                    text=text,
                    confidence=float(score),
                    box=PixelBox(x0, y0, int(max(xs)) - x0, int(max(ys)) - y0),
                )
            )
        return lines
