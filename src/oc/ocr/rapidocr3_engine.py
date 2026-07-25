"""OCR via the new-gen ``rapidocr`` package (PP-OCRv5/v6 models, selectable
inference engine: onnxruntime / openvino / …). Registered as ``ppocr5``.

The ``rapidocr`` package is a core dependency; pick an inference runtime via an
extra (``.[gpu]`` for CUDA, ``.[ppocr5-openvino]`` for OpenVINO — plain onnxruntime
CPU otherwise). If no runtime is importable this module fails to import and the
registry silently skips it, so ``ppocr5`` simply doesn't resolve.

Design notes:
- No ``rec_chunk``/``yield_ms`` GPU pacing — the v3 public API doesn't expose the
  per-burst hooks those ride on. ``set_scale`` (the detection budget) IS supported:
  v3 exposes det-only/rec-only calls plus its crop helper, which is exactly the
  split the downscaled read needs (see :meth:`Rapid3OcrEngine.read_image`).
- Almost no monkeypatches: cls-off, thread caps and the CUDA conv-search fix are
  real config in v3 (translated in :mod:`oc.ocr.rapidocr3_map`). The ONE unavoidable
  patch is CUDA arena shrinkage (:func:`oc.ocr.cuda.patch_arena_shrinkage`) — v3
  exposes no per-run RunOptions hook, so the arena would otherwise ratchet VRAM
  upward on every read (varied crop widths mint new shapes it never reclaims).

Models auto-download on first construction (one network hit, cached under the
package's models dir) — ``prepare()``/the startup warmup absorbs it.
"""

from __future__ import annotations

import json
import threading
from importlib.util import find_spec

import cv2
import numpy as np

from ..interfaces import OcrEngine
from ..registry import register_ocr
from ..types import OcrLine
from .charset import apply as apply_charset
from .cuda import patch_arena_shrinkage, register_cuda_dlls
from .directml import patch_dml_provider_cfg
from .rapidocr3_map import join_rec, to_lines, to_params
from .serialize import OCR_LOCK as _INFER_LOCK

if find_spec("rapidocr") is None:   # registry discovery must skip us cleanly
    raise ImportError("rapidocr (v3) is not installed — pip install rapidocr")

_BUILD_LOCK = threading.Lock()

# Knobs that change how FAST a read runs but never what it reads — kept out of
# ocr_sig so tuning them doesn't invalidate the web OCR cache.
_PERF_ONLY = ("intra_op_num_threads", "inter_op_num_threads", "rec_batch_num")


def _preload_onnxruntime(engine_type: str) -> None:
    """Import onnxruntime NOW, at OCR-engine construction, to stake its DLL claim.

    ``Engine.build()`` builds this OCR engine before the capture backend. The WGC
    capture backend pulls in native D3D/WinRT DLLs; if those load into the process
    before onnxruntime, its pybind extension fails to initialise ("DLL initialization
    routine failed") and every OCR read 500s. Loading onnxruntime first — while we're
    still the only native module in the process — avoids the clash. RapidOCR imports
    it lazily at first read (too late), so we force it up front here.

    Only for the onnxruntime engine (openvino brings its own runtime). Best-effort: a
    genuinely missing/broken runtime surfaces with a full traceback at model build."""
    if engine_type != "onnxruntime":
        return
    try:
        import onnxruntime  # noqa: F401
    except Exception:   # noqa: BLE001 - real failure re-raises later at RapidOCR build
        pass


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
        # Ours, not a rapidocr param — popped before to_params, which raises on unknown
        # flat keys. Empty/absent = unconstrained decode (the stock model alphabet).
        self._charset = str(options.pop("charset", "") or "")
        self._options = options
        self._engine = None
        self._scale = 1   # integer downscale factor for big frames (1 = off; 2 -> quarter area)
        self._gpu_mem_gb = 3.0   # CUDA arena ceiling; see _CUDA_PARAMS in the map module
        self._det_unclip_default = 1.6   # engine's own Det.unclip_ratio/box_thresh, captured
        self._det_box_thresh_default = 0.5   # from cfg once built; see _ensure_engine
        if self._gpu:
            register_cuda_dlls()
        _preload_onnxruntime(self.engine_type)

    @property
    def gpu_mem_gb(self) -> float:
        return self._gpu_mem_gb

    def set_gpu_mem_gb(self, gb) -> None:
        """Hard ceiling (GB) for the CUDA memory arena — OCR can never hold more VRAM
        than this. Too low and a big detect batch fails to allocate; the 3GB default
        clears real 4K workloads with room to spare. Rebuilds the GPU session on next
        read when changed (a CPU session doesn't carry the arena, so no rebuild)."""
        try:
            gb = min(64.0, max(0.5, float(gb)))
        except (TypeError, ValueError):
            return
        if gb != self._gpu_mem_gb:
            self._gpu_mem_gb = gb
            if self._gpu:
                self._engine = None

    @property
    def scale(self) -> int:
        return self._scale

    def set_scale(self, n) -> None:
        """Detection budget, same contract as the old backend: 2 -> the detector sees
        half the side length (a quarter of the pixels). Detection is the pass whose
        cost (time AND VRAM) scales with resolution; recognition still crops from the
        full-detail frame, so text quality holds. Changing the value rebuilds the
        model on next use (the det resize limits are construction config)."""
        try:
            n = max(1, int(n))
        except (TypeError, ValueError):
            n = 1
        if n != self._scale:
            self._scale = n
            self._engine = None

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
        backend itself, the inference engine, model/version options, and the
        detection scale (a downscaled detect can find different boxes). The web OCR
        cache mixes this into its keys so results cached under one engine are never
        served after a swap. Perf-only knobs (thread caps, batch size) and the
        cpu/gpu device are excluded: they alter speed, not output, and auto device
        mode flips per batch. scale=1 adds nothing so existing cache keys survive.

        ``charset`` MUST be in here: it changes which characters a read can contain, so
        cached reads taken under a wider alphabet would otherwise still be served after
        it is narrowed. An empty charset adds nothing, so existing keys survive."""
        opts = {k: v for k, v in self._options.items() if k not in _PERF_ONLY}
        scale = f"scale={self._scale}|" if self._scale > 1 else ""
        charset = f"charset={self._charset}|" if self._charset else ""
        return f"ppocr5|{scale}{charset}" + json.dumps(opts, sort_keys=True, default=str)

    @property
    def cuda_capable(self) -> bool:
        """True only when the selected inference engine can use the NVIDIA CUDA provider.
        The cpu/gpu device switch drives onnxruntime's CUDAExecutionProvider; OpenVINO runs
        on CPU / Intel iGPU and IGNORES it, so 'gpu' is a no-op under OpenVINO — the UI greys
        the GPU/Auto device options out (like a missing CUDA install) when this is False."""
        return self.engine_type == "onnxruntime"

    @property
    def gpu_active(self) -> bool:
        # 'gpu' selected AND the engine actually honours it (OpenVINO never does), so the
        # readout / kill-GPU button reflect real CUDA use, not just the device flag.
        return self._engine is not None and self._gpu and self.cuda_capable

    @property
    def dml_requested(self) -> bool:
        """settings.yaml asked for the DirectML EP (use_dml) AND this really is the
        onnxruntime-directml build — how OCR runs on a non-NVIDIA GPU (e.g. an idle iGPU
        off the game's card). False under the CUDA/CPU builds, where use_dml is a no-op
        (the shared settings.yaml carries it either way), so the UI never mislabels CUDA
        as DirectML."""
        from .directml import dml_available
        return bool(self._options.get("EngineConfig.onnxruntime.use_dml")) and dml_available()

    @property
    def dml_active(self) -> bool:
        # DML session actually loaded (an engine built + DML configured & available).
        # Distinct from gpu_active (CUDA) — DML runs while the device flag is 'cpu', so the
        # readout would otherwise call the iGPU "cpu".
        return self._engine is not None and self.dml_requested

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

                    params = to_params(self._options, gpu=self._gpu)
                    # rapidocr's own "RapidOCR" logger spams INFO model-load lines and
                    # a benign "text detection result is empty" WARNING on any
                    # blank/occluded frame (e.g. the boot warmup). We already swallow
                    # empty dets in-code, so gate it to ERROR. Must go through the
                    # Global.log_level param, not a bare logging.setLevel() call —
                    # RapidOCR.__init__ (main.py) unconditionally resets the logger's
                    # level from this config value on every construction.
                    params["Global.log_level"] = "error"
                    if params.get("EngineConfig.onnxruntime.use_dml"):
                        # DirectML path (non-NVIDIA GPU, e.g. an idle iGPU off the game's
                        # card). Without this, rapidocr hands ORT a raw DictConfig for the
                        # DML EP options and session creation silently falls back to CPU —
                        # a pinned dml_ep_cfg.device_id would never reach the adapter.
                        patch_dml_provider_cfg()
                    if self._gpu:
                        # v3 exposes no RunOptions hook, so the CUDA arena would ratchet
                        # VRAM upward every read (varied crop widths = new shapes, never
                        # reclaimed). Patch its session class to shrink the arena per run —
                        # the ONE monkeypatch v3 can't avoid (shared with the old backend).
                        try:
                            from rapidocr.inference_engine.onnxruntime.main import (
                                OrtInferSession,
                            )

                            patch_arena_shrinkage(OrtInferSession)
                        except Exception:  # noqa: BLE001 - best-effort, never block a build
                            pass
                        # runtime-tunable arena ceiling (settings modal) over the map
                        # module's 3GB default
                        params["EngineConfig.onnxruntime.cuda_ep_cfg.gpu_mem_limit"] = \
                            int(self._gpu_mem_gb * 1024**3)
                    if self._scale > 1:
                        # read_image hands the detector an ALREADY-SHRUNK frame and it
                        # must stay shrunk: the default det preprocess ('min'/736)
                        # re-inflates anything whose short side is under 736, and
                        # 'max' looks like the right knob but v3 ignores the
                        # configured limit for anything except 'min'
                        # (TextDetector.get_preprocess hardcodes 960/1500/2000 tiers).
                        # Same lesson, same fix as the old backend. Overrides any
                        # det_limit_* from settings.yaml while a scale is active.
                        params["Det.limit_type"] = "min"
                        params["Det.limit_side_len"] = 320
                    self._engine = RapidOCR(params=_to_enums(params))
                    if self._charset:
                        # Constrain the CTC decode to the allowed alphabet — see
                        # oc.ocr.charset for why this can't be done by swapping in a
                        # smaller character dict. Deliberately NOT best-effort: a charset
                        # that silently failed to apply would read as working while
                        # emitting the very characters it was configured to forbid.
                        apply_charset(self._engine, self._charset)
                    # baseline det params (settings.yaml Det.* passthrough already folded
                    # in above) — the concrete numbers a per-window override falls back to,
                    # since update_params() below skips None and would otherwise leave a
                    # PRIOR call's custom value stuck on the shared engine (see read_image).
                    try:
                        self._det_unclip_default = float(self._engine.cfg.Det.unclip_ratio)
                        self._det_box_thresh_default = float(self._engine.cfg.Det.box_thresh)
                    except (AttributeError, TypeError, ValueError):
                        pass
        return self._engine

    def read_image(self, image: np.ndarray, *, unclip_ratio: float | None = None,
                    box_thresh: float | None = None) -> list[OcrLine]:
        engine = self._ensure_engine()
        f = self._scale
        h, w = image.shape[:2]
        # v3's per-call flags are STATEFUL: update_params skips None, so a flag set by
        # any earlier call sticks on the shared engine. One read_line (use_det=False)
        # would otherwise flip every later read_image to rec-only — which also changes
        # the return TYPE to a boxless TextRecOutput. Always pass all three. Same lesson
        # applies to unclip_ratio/box_thresh: a caller's custom override would otherwise
        # stick on the NEXT default-preprocess read, so resolve None -> the engine's own
        # baseline (captured once in _ensure_engine) and always pass a concrete number.
        ur = unclip_ratio if unclip_ratio is not None else self._det_unclip_default
        bt = box_thresh if box_thresh is not None else self._det_box_thresh_default
        if f <= 1 or max(h, w) <= 600:   # no downscale / small crop: the normal pipeline
            with _INFER_LOCK:
                out = engine(image, use_det=True, use_cls=False, use_rec=True,
                             unclip_ratio=ur, box_thresh=bt)
            return to_lines(out.boxes, out.txts, out.scores)

        # Downscaled read (same split as the old backend): DETECT on a reduced frame —
        # detection is the pass whose time/VRAM scale with resolution — then RECOGNISE
        # crops cut from the ORIGINAL frame so text quality is untouched. v3 exposes
        # the pieces the old backend had to reach into v1 for: a det-only call (boxes
        # come back in the small frame's coords), its quad-crop helper, and a direct
        # rec entry point that never touches the stateful per-call flags.
        small = cv2.resize(image, (w // f, h // f), interpolation=cv2.INTER_AREA)
        with _INFER_LOCK:
            det = engine(small, use_det=True, use_cls=False, use_rec=False,
                         unclip_ratio=ur, box_thresh=bt)
            if det.boxes is None or len(det.boxes) == 0:
                return []
            # det boxes back to full-frame coords, clipped against rounding overshoot
            boxes = [np.clip(np.asarray(b) * f, (0, 0), (w - 1, h - 1)).astype(np.float32)
                     for b in det.boxes]
            crops = engine.crop_text_regions(image, np.asarray(boxes))
            from rapidocr.ch_ppocr_rec import TextRecInput

            rec = engine.text_rec(TextRecInput(img=crops))
        # same floor the stock pipeline applies before returning a line
        try:
            floor = float(engine.cfg.Global.text_score)
        except (AttributeError, TypeError, ValueError):
            floor = 0.5
        keep = [(b, str(t), float(s))
                for b, t, s in zip(boxes, rec.txts or (), rec.scores or ())
                if str(t).strip() and float(s) >= floor]
        if not keep:
            return []
        return to_lines(*zip(*keep))

    def read_line(self, image: np.ndarray) -> tuple[str, float]:
        """Recognition-only (detection skipped) for a crop known to be one line."""
        if image is None or image.size == 0:
            return "", 0.0
        engine = self._ensure_engine()
        with _INFER_LOCK:
            out = engine(image, use_det=False, use_cls=False, use_rec=True)
        return join_rec(out.txts, out.scores)

    def read_lines(self, images) -> list[tuple[str, float]]:
        """Batched recognition-only: ONE rec pass over all crops via v3's direct rec entry
        point (the same piece the downscaled read uses) instead of a call per crop. Purely
        per-crop — no shared canvas, so unlike detection batching this cannot change any
        individual result."""
        imgs = list(images)
        idx = [i for i, im in enumerate(imgs) if im is not None and getattr(im, "size", 0)]
        out: list[tuple[str, float]] = [("", 0.0)] * len(imgs)
        if not idx:
            return out
        engine = self._ensure_engine()
        with _INFER_LOCK:
            from rapidocr.ch_ppocr_rec import TextRecInput

            rec = engine.text_rec(TextRecInput(img=[imgs[i] for i in idx]))
        for i, t, s in zip(idx, rec.txts or (), rec.scores or ()):
            out[i] = join_rec([t], [s])
        return out
