"""OCR via RapidOCR (ONNX runtime). No system binary required."""

from __future__ import annotations

import json
import threading
import time

import cv2
import numpy as np

from ..interfaces import OcrEngine
from ..registry import register_ocr
from ..types import OcrLine, PixelBox
from .cuda import patch_arena_shrinkage
from .cuda import register_cuda_dlls as _register_cuda_dlls
from .serialize import OCR_LOCK as _INFER_LOCK

_CUDA_SEARCH_PATCHED = False
_CLS_DROPPED = False
_GPU_MEM_LIMIT = 6 * 1024 ** 3   # hard cap on the CUDA arena (bytes) — bounds runaway growth
# (2 GB was too tight: 4K frames OOM'd -> 500s. 6 GB still caps the kNextPowerOfTwo
#  growth well under an 8 GB card while leaving headroom for a single det+rec pass.)
_BUILD_LOCK = threading.Lock()


def _to_float(v, default: float = 0.0) -> float:
    try:
        return max(0.0, float(v))
    except (TypeError, ValueError):
        return default


def _to_int(v, default: int = 0) -> int:
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return default
# _INFER_LOCK (imported above) is the per-call safety net around inference. The real
# serialization is job-level via ocr_job() (serialize.py); this shared re-entrant lock
# just guarantees even a stray un-wrapped call can't run concurrently with anything else.


def _patch_cuda_conv_search() -> None:
    """RapidOCR's CUDA provider options are tuned for a benchmark, not a long-lived
    service. Patch them on the EP builder (not exposed through RapidOCR's config):

    - ``cudnn_conv_algo_search`` EXHAUSTIVE -> HEURISTIC: EXHAUSTIVE benchmarks every
      cuDNN conv algorithm on the first inference AND every new input shape — a
      minute-plus stall and repeated stalls as OCR feeds many image sizes. HEURISTIC
      picks instantly.
    - ``gpu_mem_limit`` -> a HARD cap: by default the arena is unbounded and the BFC
      allocator never frees, so OCR's endless stream of distinct rec-crop widths
      accumulates blocks until it eats all VRAM (7+ GB) and spills to shared system RAM.
      A cap forces the allocator to reuse/evict instead of growing forever.
    - ``arena_extend_strategy`` is LEFT at the default kNextPowerOfTwo on purpose: it
      buckets sizes into powers of two so a 480- and 512-wide crop share one block.
      kSameAsRequested (exact-size blocks) is far worse here — every distinct width gets
      its own block that nothing else can reuse, which is what ran it up to 7 GB.
    - ``cudnn_conv_use_max_workspace`` -> "0": stop cuDNN from grabbing the largest
      possible scratch buffer per layer (huge with variable shapes).

    Together these keep GPU use bounded (sub-2 GB) without the creeping growth. No-op if
    the internals move (best-effort)."""
    global _CUDA_SEARCH_PATCHED
    if _CUDA_SEARCH_PATCHED:
        return
    _CUDA_SEARCH_PATCHED = True
    try:
        from rapidocr_onnxruntime.utils import infer_engine as ie

        orig = ie.OrtInferSession._get_ep_list
        cuda_ep = ie.EP.CUDA_EP.value
        lean = {
            "cudnn_conv_algo_search": "HEURISTIC",
            "cudnn_conv_use_max_workspace": "0",
            "gpu_mem_limit": str(_GPU_MEM_LIMIT),
        }

        def _get_ep_list(self):
            eps = orig(self)
            for name, opts in eps:
                if name == cuda_ep and isinstance(opts, dict):
                    opts.update(lean)
            return eps

        ie.OrtInferSession._get_ep_list = _get_ep_list
    except Exception:
        pass


def _patch_arena_shrinkage() -> None:
    """Free unused CUDA arena at each run's end so idle VRAM falls back to the loaded
    models instead of the ratcheted peak (see :func:`oc.ocr.cuda.patch_arena_shrinkage`).
    This backend's session class lives in ``rapidocr_onnxruntime``; the shared patcher
    does the work so both backends share one implementation."""
    try:
        from rapidocr_onnxruntime.utils import infer_engine as ie

        patch_arena_shrinkage(ie.OrtInferSession)
    except Exception:
        pass


def _drop_cls() -> None:
    """Don't load the angle-classification model. Game UI text is horizontal, so cls is
    dead weight — a whole extra ONNX session (its own GPU arena) that only rotates text
    we know isn't rotated. RapidOCR builds ``TextClassifier`` unconditionally, so replace
    it with a no-op that passes the crops straight through. Smaller footprint, one fewer
    model pass per read. Best-effort; no-op if internals move."""
    global _CLS_DROPPED
    if _CLS_DROPPED:
        return
    _CLS_DROPPED = True
    try:
        from rapidocr_onnxruntime import main as _m

        class _NoCls:
            def __init__(self, *a, **k):
                pass

            def __call__(self, img, *a, **k):
                return img, [], 0.0   # crops unchanged, no cls result, no time

        _m.TextClassifier = _NoCls
    except Exception:
        pass


_SESS_OPTS_PATCHED = False


def _patch_sess_opts() -> None:
    """ORT's intra-op thread pool SPIN-WAITS between inferences by default — worker
    threads burn whole cores busy-polling for the next task, which on a shared machine
    is CPU stolen from the game for nothing (OCR runs ~once a second; the pool spins
    the rest of the time). Disable spinning on every session RapidOCR builds; threads
    then sleep between calls at the cost of a microseconds-slower wake-up. Applied to
    CPU and CUDA sessions alike (a CUDA session still owns a CPU-side pool).
    Best-effort; no-op if the internals move."""
    global _SESS_OPTS_PATCHED
    if _SESS_OPTS_PATCHED:
        return
    _SESS_OPTS_PATCHED = True
    try:
        from rapidocr_onnxruntime.utils import infer_engine as ie

        orig = ie.OrtInferSession._init_sess_opts

        def _init_sess_opts(config):
            sess_opt = orig(config)
            sess_opt.add_session_config_entry("session.intra_op.allow_spinning", "0")
            return sess_opt

        ie.OrtInferSession._init_sess_opts = staticmethod(_init_sess_opts)
    except Exception:
        pass


@register_ocr("rapidocr")
class RapidOcrEngine(OcrEngine):
    """Wraps :class:`rapidocr_onnxruntime.RapidOCR`.

    The model is loaded lazily on first use so importing this module (e.g. for
    registry discovery) stays cheap.
    """

    def __init__(self, **options) -> None:
        # Baseline CPU. The web UI's device MODE (cpu/gpu/auto) drives runtime switching;
        # CLI use opts in via settings.ocr.options.use_gpu. GPU for small interactive reads
        # rarely pays (CUDA init + per-call overhead) — auto-mode reserves it for batches.
        self._gpu = bool(options.pop("use_gpu", False))
        # GPU pacing knobs (popped so they never reach RapidOCR). A single OCR read is one
        # big CUDA burst that stalls a game's frame present for its whole duration; splitting
        # the recognition into chunks with a sleep between submissions lets the game present
        # frames in the gaps. yield_ms = sleep between GPU submissions (0 = off, one burst).
        # rec_chunk = crops per text_rec submission before yielding (0 = single batch).
        self._yield_ms = _to_float(options.pop("yield_ms", 0.0))
        self._rec_chunk = _to_int(options.pop("rec_chunk", 0))
        self._options = options
        self._engine = None
        self._scale = 1   # integer downscale factor for big frames (1 = off; 2 -> quarter area)
        if self._gpu:
            _register_cuda_dlls()

    @property
    def scale(self) -> int:
        return self._scale

    def set_scale(self, n) -> None:
        """Detection budget: 2 -> the detector sees half the side length (a quarter of
        the pixels), 4 -> a quarter. Implemented as the DETECTOR'S own resize limit,
        not by subsampling the frame: RapidOCR caps any input at a 2000px long side
        and then UPSCALES anything whose short side is under 736 right back up, so
        pre-shrinking the frame changed almost nothing (a 4K frame was detected at
        ~2000px regardless — no speed or memory win). Recognition still crops from the
        full-detail frame, so text quality holds. Changing the value rebuilds the
        model on next use (cheap, same as a device switch)."""
        try:
            n = max(1, int(n))
        except (TypeError, ValueError):
            n = 1
        if n != self._scale:
            self._scale = n
            self._engine = None   # det limits are constructor config -> rebuild lazily

    @property
    def yield_ms(self) -> float:
        return self._yield_ms

    def set_yield_ms(self, ms) -> None:
        """GPU pacing: milliseconds slept between consecutive GPU submissions in a read, so a
        game can present a frame in the gap instead of waiting out one long burst. 0 = off (one
        continuous burst). Takes effect immediately — no model rebuild (it only gates a sleep)."""
        self._yield_ms = _to_float(ms, self._yield_ms)

    @property
    def intra_threads(self) -> int:
        """CPU threads per inference (0 = ORT default: one per core). Mirrors the
        ppocr5 backend's knob so the settings modal drives either backend."""
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
            self._options.pop("intra_op_num_threads", None)   # 0 = ORT default
        self._engine = None   # thread caps are session config -> rebuild lazily

    @property
    def ocr_sig(self) -> str:
        """Fingerprint of everything that can change what this backend READS (see the
        ppocr5 twin) — backend name, detection scale, model options. Perf-only knobs
        (thread caps; yield_ms/rec_chunk are pacing and already live outside
        ``_options``) and the cpu/gpu device are excluded."""
        opts = {k: v for k, v in self._options.items()
                if k not in ("intra_op_num_threads", "inter_op_num_threads")}
        return f"rapidocr|scale={self._scale}|" + json.dumps(opts, sort_keys=True, default=str)

    @property
    def device(self) -> str:
        return "gpu" if self._gpu else "cpu"

    @property
    def gpu_active(self) -> bool:
        """True iff a GPU OCR session is currently LOADED (holding VRAM) — drives the web
        UI's kill-GPU affordance. False after ``release()`` until the next read rebuilds
        the engine, and always False on CPU."""
        return self._engine is not None and self._gpu

    def set_device(self, gpu: bool) -> None:
        """Switch CPU<->GPU at runtime. Rebuilds the model on next use."""
        gpu = bool(gpu)
        if gpu == self._gpu and self._engine is not None:
            return
        self._gpu = gpu
        if gpu:
            _register_cuda_dlls()
        self._engine = None   # force re-init with the new providers

    def release(self) -> None:
        """Drop the loaded model so its ONNX CUDA session is destroyed, freeing the GPU
        arena / VRAM it was squatting on. The device selection is left untouched: the
        next read rebuilds the engine lazily (on GPU if still selected)."""
        import gc

        self._engine = None   # last ref to the RapidOCR/ORT sessions -> dtor frees CUDA
        gc.collect()

    def _ensure_engine(self):
        if self._engine is None:
            # Build under a lock: the startup warmup thread and a first real request can
            # both arrive here with _engine None and would otherwise build two CUDA
            # sessions at once (slow contention). Double-checked so the warm path is free.
            with _BUILD_LOCK:
                if self._engine is None:
                    from rapidocr_onnxruntime import RapidOCR

                    _drop_cls()   # before construction: no angle-classification session gets built
                    _patch_sess_opts()   # threads sleep between calls instead of spinning
                    opts = dict(self._options)
                    # A grid read recognises dozens of crops; the default batch of 6
                    # means ~8 sequential model calls. Bigger batches = fewer launches
                    # (settings.ocr.options.rec_batch_num still overrides).
                    opts.setdefault("rec_batch_num", 16)
                    if self._scale > 1:
                        # read_image hands the detector an ALREADY-SHRUNK frame and it
                        # must stay shrunk: the default det preprocess ('min'/736)
                        # re-inflates anything whose short side is under 736. A low
                        # 'min' limit disables that. ('max' looks like the right knob
                        # but this RapidOCR ignores the configured limit for anything
                        # except 'min' — TextDetector.get_preprocess overrides it.)
                        opts.update(det_limit_type="min", det_limit_side_len=320)
                    # Force the providers BOTH ways. With onnxruntime-gpu installed
                    # RapidOCR auto-selects CUDA even when we never asked for it, so an
                    # unset flag means "cpu" silently runs on the GPU and the reported
                    # device lies. Setting it explicitly makes the selection authoritative.
                    opts.update(det_use_cuda=self._gpu, rec_use_cuda=self._gpu)
                    if self._gpu:   # CUDA for detection and recognition
                        _patch_cuda_conv_search()   # before any CUDA session is built
                        _patch_arena_shrinkage()    # free dead arena chunks after each run
                    self._engine = RapidOCR(**opts)
        return self._engine

    def read_line(self, image: np.ndarray) -> tuple[str, float]:
        """Recognition-only: skip detection (and angle classification) for a crop the
        caller knows is one line. Many times cheaper than ``read_image``."""
        if image is None or image.size == 0:
            return "", 0.0
        engine = self._ensure_engine()
        with _INFER_LOCK:
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

    def _text_rec(self, engine, crops: list[np.ndarray]) -> list:
        """Batched recognition over ``crops``, optionally paced. When GPU pacing is on
        (``yield_ms`` > 0 and ``rec_chunk`` > 0) and there's more than one chunk, run
        ``text_rec`` on slices of ``rec_chunk`` crops and ``time.sleep(yield_ms)`` between
        slices — splitting one long CUDA burst into shorter ones so a game can present a
        frame in each gap. Results are concatenated in input order. Off => one batched call
        (current behavior). Returns the raw rec_res list."""
        if not crops:
            return []
        chunk = self._rec_chunk
        if chunk <= 0 or self._yield_ms <= 0 or len(crops) <= chunk:
            with _INFER_LOCK:
                rec_res, _elapse = engine.text_rec(crops)
            return rec_res or []
        gap = self._yield_ms / 1000.0
        out: list = []
        for i in range(0, len(crops), chunk):
            with _INFER_LOCK:
                rec_res, _elapse = engine.text_rec(crops[i : i + chunk])
            out.extend(rec_res or [])
            if i + chunk < len(crops):
                time.sleep(gap)   # no kernels enqueued during the gap -> game's present can slip in
        return out

    def read_lines(self, images: list[np.ndarray]) -> list[tuple[str, float]]:
        """Recognise many single-line crops in ONE batched pass: RapidOCR's recogniser
        groups them by aspect ratio and runs a few GPU batches instead of a call per
        crop. Result is aligned to the input by index; empty crops yield ("", 0.0)."""
        out: list[tuple[str, float]] = [("", 0.0)] * len(images)
        keep, crops = [], []
        for i, im in enumerate(images):
            if im is not None and im.size:
                keep.append(i)
                crops.append(im)
        if not crops:
            return out
        engine = self._ensure_engine()
        rec_res = self._text_rec(engine, crops)   # batched recognition (paced), input order
        for j, res in enumerate(rec_res or []):
            if j < len(keep) and isinstance(res, (list, tuple)) and len(res) >= 2:
                out[keep[j]] = (str(res[0]), float(res[1]))
        return out

    def prepare(self) -> None:
        # Build the RapidOCR/ORT sessions now (no-op once built) so the first real read
        # isn't charged for the multi-second model construction.
        self._ensure_engine()

    def read_image(self, image: np.ndarray) -> list[OcrLine]:
        engine = self._ensure_engine()
        f = self._scale
        h, w = image.shape[:2]
        if f <= 1 or max(h, w) <= 600:   # no downscale / small crop: the normal pipeline
            with _INFER_LOCK:
                result, _elapsed = engine(image)
            if not result:
                return []
            return [self._line(pts, text, score) for pts, text, score in result]

        # Downscaled read: DETECT on a reduced frame (detection is the pass whose cost
        # scales with resolution), then RECOGNISE crops cut from the ORIGINAL frame so
        # text quality is untouched. RapidOCR cannot be configured into this split: it
        # caps any input at a 2000px long side, its det preprocess ignores the
        # configured side limit unless limit_type='min', and 'min' only ever UPSCALES —
        # a 4K frame was always detected at ~2000px no matter what was pre-shrunk or
        # configured, which is why the scale setting used to show no benefit.
        small = cv2.resize(image, (w // f, h // f), interpolation=cv2.INTER_AREA)
        with _INFER_LOCK:
            dt_boxes, _elapse = engine.text_det(small)
        if dt_boxes is None or len(dt_boxes) == 0:
            return []
        # det boxes back to full-frame coords, clipped against rounding overshoot (CPU work)
        boxes = [np.clip(b * f, (0, 0), (w - 1, h - 1)).astype(np.float32)
                 for b in engine.sorted_boxes(dt_boxes)]
        crops = engine.get_crop_img_list(image, boxes)
        if self._yield_ms > 0:
            time.sleep(self._yield_ms / 1000.0)   # gap between the detect burst and the rec burst
        rec_res = self._text_rec(engine, crops)   # paced recognition
        floor = float(getattr(engine, "text_score", 0.5))
        lines: list[OcrLine] = []
        for pts, res in zip(boxes, rec_res or []):
            if not isinstance(res, (list, tuple)) or len(res) < 2:
                continue
            text, score = str(res[0]), float(res[1])
            if text and score >= floor:   # same filter the stock pipeline applies
                lines.append(self._line(pts, text, score))
        return lines

    @staticmethod
    def _line(box_pts, text: str, score: float) -> OcrLine:
        # box_pts: 4 (x, y) corners. Reduce to an axis-aligned bounds.
        xs = [p[0] for p in box_pts]
        ys = [p[1] for p in box_pts]
        x0, y0 = int(min(xs)), int(min(ys))
        return OcrLine(text=text, confidence=float(score),
                       box=PixelBox(x0, y0, int(max(xs)) - x0, int(max(ys)) - y0))
