"""OCR via the new-gen ``rapidocr`` package (PP-OCRv5/v6 models, selectable
inference engine: onnxruntime / openvino / …). Registered as ``ppocr5``.

Coexists with the old ``rapidocr_onnxruntime`` backend (different distribution,
different import name) — settings.yaml picks one by name, the other stays one
name-flip away. Install the extra first: ``pip install -e ".[ppocr5]"`` (or
``.[ppocr5-openvino]``); without it this module fails to import and the registry
silently skips it, so ``ppocr5`` simply doesn't resolve.

Differences from the old backend, on purpose:
- No ``rec_chunk``/``yield_ms`` GPU pacing and no ``set_scale`` detection budget —
  the v3 public API doesn't expose the det/rec split those ride on. This backend's
  pitch is the faster CPU path; GPU batch work can stay on ``rapidocr``.
- No monkeypatches: cls-off, thread caps and the CUDA conv-search fix are real
  config in v3 (translated in :mod:`oc.ocr.rapidocr3_map`).

Models auto-download on first construction (one network hit, cached under the
package's models dir) — ``prepare()``/the startup warmup absorbs it.
"""

from __future__ import annotations

import json
import threading
from importlib.util import find_spec

import numpy as np

from ..interfaces import OcrEngine
from ..registry import register_ocr
from ..types import OcrLine
from .cuda import register_cuda_dlls
from .rapidocr3_map import join_rec, to_lines, to_params
from .serialize import OCR_LOCK as _INFER_LOCK

if find_spec("rapidocr") is None:   # registry discovery must skip us cleanly
    raise ImportError("rapidocr (v3) is not installed — pip install -e '.[ppocr5]'")

_BUILD_LOCK = threading.Lock()

# Knobs that change how FAST a read runs but never what it reads — kept out of
# ocr_sig so tuning them doesn't invalidate the web OCR cache.
_PERF_ONLY = ("intra_op_num_threads", "inter_op_num_threads", "rec_batch_num")


def _to_enums(params: dict) -> dict:
    """The v3 param parser REJECTS plain strings for its enum-typed keys (raises
    "must be Enum Type"), so convert by the key's last segment. Done here, not in
    the map module, because the enums live in the optional dependency."""
    from rapidocr import EngineType, LangDet, LangRec, ModelType, OCRVersion

    def conv(key: str, v):
        leaf = key.rsplit(".", 1)[-1]
        if isinstance(v, str):
            if leaf == "engine_type":
                return EngineType(v)
            if leaf == "ocr_version":
                return OCRVersion(v)
            if leaf == "model_type":
                return ModelType(v)
            if leaf == "lang_type":
                return LangDet(v) if key.startswith("Det.") else LangRec(v)
        return v

    return {k: conv(k, v) for k, v in params.items()}


@register_ocr("ppocr5")
class Rapid3OcrEngine(OcrEngine):
    """Wraps :class:`rapidocr.RapidOCR` (v3). Lazily built, like the old backend, so
    importing for registry discovery stays cheap."""

    def __init__(self, **options) -> None:
        self._gpu = bool(options.pop("use_gpu", False))
        self._options = options
        self._engine = None
        if self._gpu:
            register_cuda_dlls()

    @property
    def device(self) -> str:
        return "gpu" if self._gpu else "cpu"

    # --- runtime knobs (web UI settings modal; persisted in routes/ocr.py) --------
    # Both mutate the construction options and drop the engine — the next read
    # rebuilds lazily, same lifecycle as a device switch.

    @property
    def engine_type(self) -> str:
        return str(self._options.get("engine_type", "onnxruntime"))

    @property
    def engine_types(self) -> list[str]:
        """Inference engines actually usable here: their runtime is installed. The UI
        builds its picker from this so a missing extra never becomes a dead option."""
        avail = ["onnxruntime"]
        if find_spec("openvino") is not None:
            avail.append("openvino")
        return avail

    def set_engine_type(self, name: str) -> None:
        name = str(name).strip().lower()
        if name not in self.engine_types:
            raise ValueError(f"engine_type {name!r} not available (have: {self.engine_types})")
        if name == self.engine_type and self._engine is not None:
            return
        self._options["engine_type"] = name
        self._engine = None

    @property
    def intra_threads(self) -> int:
        """CPU threads per inference (0 = runtime default: one per core)."""
        try:
            return max(0, int(self._options.get("intra_op_num_threads", 0) or 0))
        except (TypeError, ValueError):
            return 0

    def set_intra_threads(self, n) -> None:
        try:
            n = max(0, int(n))
        except (TypeError, ValueError):
            return
        if n == self.intra_threads and self._engine is not None:
            return
        if n:
            self._options["intra_op_num_threads"] = n
        else:
            self._options.pop("intra_op_num_threads", None)   # 0 = runtime default
        self._engine = None

    @property
    def ocr_sig(self) -> str:
        """Fingerprint of everything that can change what this backend READS — the
        backend itself, the inference engine, model/version options. The web OCR
        cache mixes this into its keys so results cached under one engine are never
        served after a swap. Perf-only knobs (thread caps, batch size) and the
        cpu/gpu device are excluded: they alter speed, not output, and auto device
        mode flips per batch."""
        opts = {k: v for k, v in self._options.items() if k not in _PERF_ONLY}
        return "ppocr5|" + json.dumps(opts, sort_keys=True, default=str)

    @property
    def gpu_active(self) -> bool:
        return self._engine is not None and self._gpu

    def set_device(self, gpu: bool) -> None:
        """Switch CPU<->GPU at runtime. Rebuilds the model on next use."""
        gpu = bool(gpu)
        if gpu == self._gpu and self._engine is not None:
            return
        self._gpu = gpu
        if gpu:
            register_cuda_dlls()
        self._engine = None

    def release(self) -> None:
        """Drop the loaded model so a CUDA session frees its VRAM; next read rebuilds."""
        import gc

        self._engine = None
        gc.collect()

    def prepare(self) -> None:
        self._ensure_engine()

    def _ensure_engine(self):
        if self._engine is None:
            with _BUILD_LOCK:
                if self._engine is None:
                    from rapidocr import RapidOCR

                    params = _to_enums(to_params(self._options, gpu=self._gpu))
                    self._engine = RapidOCR(params=params)
        return self._engine

    def read_image(self, image: np.ndarray) -> list[OcrLine]:
        engine = self._ensure_engine()
        # v3's per-call flags are STATEFUL: update_params skips None, so a flag set by
        # any earlier call sticks on the shared engine. One read_line (use_det=False)
        # would otherwise flip every later read_image to rec-only — which also changes
        # the return TYPE to a boxless TextRecOutput. Always pass all three.
        with _INFER_LOCK:
            out = engine(image, use_det=True, use_cls=False, use_rec=True)
        return to_lines(out.boxes, out.txts, out.scores)

    def read_line(self, image: np.ndarray) -> tuple[str, float]:
        """Recognition-only (detection skipped) for a crop known to be one line."""
        if image is None or image.size == 0:
            return "", 0.0
        engine = self._ensure_engine()
        with _INFER_LOCK:
            out = engine(image, use_det=False, use_cls=False, use_rec=True)
        return join_rec(out.txts, out.scores)
