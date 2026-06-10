"""OCR via RapidOCR (ONNX runtime). No system binary required."""

from __future__ import annotations

import numpy as np

from ..interfaces import OcrEngine
from ..registry import register_ocr
from ..types import OcrLine, PixelBox


@register_ocr("rapidocr")
class RapidOcrEngine(OcrEngine):
    """Wraps :class:`rapidocr_onnxruntime.RapidOCR`.

    The model is loaded lazily on first use so importing this module (e.g. for
    registry discovery) stays cheap.
    """

    def __init__(self, **options) -> None:
        # convenience: `use_gpu: true` in settings.ocr.options turns on CUDA for all
        # three sub-models (requires onnxruntime-gpu installed). Equivalent to setting
        # det_use_cuda/rec_use_cuda/cls_use_cuda individually.
        if options.pop("use_gpu", False):
            options.setdefault("det_use_cuda", True)
            options.setdefault("rec_use_cuda", True)
            options.setdefault("cls_use_cuda", True)
        self._options = options
        self._engine = None

    def _ensure_engine(self):
        if self._engine is None:
            from rapidocr_onnxruntime import RapidOCR

            self._engine = RapidOCR(**self._options)
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
