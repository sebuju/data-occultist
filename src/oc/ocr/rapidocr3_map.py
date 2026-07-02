"""Pure translation helpers for the new-gen ``rapidocr`` (v3) backend.

The v3 package is configured through a dotted-key params dict mirroring its
config.yaml sections (``Global`` / ``Det`` / ``Rec`` / ``EngineConfig.<engine>``),
and its calls return a ``RapidOCROutput`` object (``.boxes``/``.txts``/``.scores``)
instead of the old list of tuples. Everything that translates between our flat
``settings.yaml`` options / :class:`~oc.types.OcrLine` and those shapes lives here,
dependency-free, so it is unit-testable without ``rapidocr`` installed (the engine
module import-guards on the package; this one must not).
"""

from __future__ import annotations

from ..types import OcrLine, PixelBox

# Flat option -> the dotted param(s) it sets. One flat name fans out to every stage
# that has the knob (det + rec), so settings.yaml stays one line per intent.
_FLAT = {
    "engine_type": ("Det.engine_type", "Rec.engine_type"),
    "ocr_version": ("Det.ocr_version", "Rec.ocr_version"),
    "model_type": ("Det.model_type", "Rec.model_type"),
    "lang_type": ("Det.lang_type", "Rec.lang_type"),
    "rec_batch_num": ("Rec.rec_batch_num",),
    "text_score": ("Global.text_score",),
    "det_limit_side_len": ("Det.limit_side_len",),
    "det_limit_type": ("Det.limit_type",),
    # ORT thread caps: default -1 = one worker per core, which starves a game running
    # on the same machine. openvino's own cap is mirrored from intra so one option
    # tames whichever inference engine is selected.
    "intra_op_num_threads": ("EngineConfig.onnxruntime.intra_op_num_threads",
                             "EngineConfig.openvino.inference_num_threads"),
    "inter_op_num_threads": ("EngineConfig.onnxruntime.inter_op_num_threads",),
}

# v3 defaults its CUDA EP to EXHAUSTIVE conv search — cuDNN benchmarks every conv
# algorithm on the first inference and on every new input shape, a minute-plus stall
# repeated as OCR feeds many image sizes (same lesson as the old backend's
# _patch_cuda_conv_search, but v3 exposes the knob so no monkeypatch is needed).
#
# v3 also leaves ORT's CUDA memory arena at kNextPowerOfTwo with NO gpu_mem_limit:
# the arena DOUBLES on every extension and never returns VRAM to the OS, and OCR's
# varied input shapes keep forcing extensions — observed ratcheting to the full 8GB
# card. kSameAsRequested grows only by what an allocation actually needs, and the
# hard limit caps the arena outright (well above det's real peak at max_side 2000).
_CUDA_PARAMS = {
    "EngineConfig.onnxruntime.use_cuda": True,
    "EngineConfig.onnxruntime.cuda_ep_cfg.cudnn_conv_algo_search": "HEURISTIC",
    "EngineConfig.onnxruntime.cuda_ep_cfg.arena_extend_strategy": "kSameAsRequested",
    "EngineConfig.onnxruntime.cuda_ep_cfg.gpu_mem_limit": 3 * 1024**3,
}


def to_params(options: dict, gpu: bool = False) -> dict:
    """Translate flat backend options into the v3 dotted-key params dict.

    A key that already contains a dot passes through verbatim (escape hatch for any
    v3 param without a flat alias). An unknown flat key raises — a typo in
    settings.yaml must fail loudly, not silently configure nothing. ``use_cls`` is
    always forced off: game UI text is horizontal, the angle classifier is dead
    weight (v1 backend had to monkeypatch this; v3 has the switch)."""
    params: dict = {"Global.use_cls": False}
    for key, value in options.items():
        if "." in key:
            params[key] = value
        elif key in _FLAT:
            for dotted in _FLAT[key]:
                params[dotted] = value
        else:
            raise KeyError(
                f"Unknown ppocr5 option {key!r}. Flat options: {sorted(_FLAT)}; "
                "anything else must be a dotted rapidocr param (e.g. 'Det.thresh')."
            )
    if gpu:
        params.update(_CUDA_PARAMS)
    return params


def to_lines(boxes, txts, scores) -> list[OcrLine]:
    """``RapidOCROutput`` fields -> :class:`OcrLine` list. ``boxes`` is an N×4×2
    array of quad corners (or None when detection found nothing); reduce each quad
    to its axis-aligned bounds, dropping empty-text entries."""
    if boxes is None or txts is None:
        return []
    lines: list[OcrLine] = []
    for pts, text, score in zip(boxes, txts, scores or ()):
        text = str(text).strip()
        if not text:
            continue
        xs = [float(p[0]) for p in pts]
        ys = [float(p[1]) for p in pts]
        x0, y0 = int(min(xs)), int(min(ys))
        lines.append(OcrLine(text=text, confidence=float(score),
                             box=PixelBox(x0, y0, int(max(xs)) - x0, int(max(ys)) - y0)))
    return lines


def join_rec(txts, scores) -> tuple[str, float]:
    """Recognition-only output -> ``(text, confidence)``: join the recognised pieces,
    confidence is their mean. ``("", 0.0)`` when nothing was read."""
    texts, confs = [], []
    for text, score in zip(txts or (), scores or ()):
        text = str(text).strip()
        if text:
            texts.append(text)
            confs.append(float(score))
    if not texts:
        return "", 0.0
    return " ".join(texts), sum(confs) / len(confs)
