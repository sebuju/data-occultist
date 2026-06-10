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
        self._options = options
        self._engine = None

    def _ensure_engine(self):
        if self._engine is None:
            from rapidocr_onnxruntime import RapidOCR

            self._engine = RapidOCR(**self._options)
        return self._engine

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
