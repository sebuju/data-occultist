"""CUDA plumbing shared by the ONNX-runtime OCR backends.

The pip ``nvidia-*-cu12`` wheels ship the CUDA/cuDNN DLLs but nothing puts them on
the search path, and "is the GPU package installed" is a question several callers
ask (device switching, the web UI's device picker). Both backends (old
``rapidocr_onnxruntime`` and new-gen ``rapidocr``) run on ONNX Runtime, so this
lives here rather than in either backend module.
"""

from __future__ import annotations

import glob
import os

_CUDA_DLLS_REGISTERED = False


def register_cuda_dlls() -> None:
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


def patch_arena_shrinkage(infer_session_cls) -> None:
    """Make an ONNX-runtime inference-session class free unused CUDA arena at each run's end.

    The CUDA BFC arena NEVER returns memory on its own: after one OCR burst the process
    squats on the whole peak working set forever, and OCR's varied input shapes (every
    text-line crop is a new width) keep forcing fresh arena chunks — repeated bursts
    (every page reload runs a detect + rec pass) ratchet VRAM upward until the
    gpu_mem_limit cap. It looks exactly like a leak because it IS one that never reclaims.

    ORT frees unused arena chunks at the END of a run when the run carries
    ``memory.enable_memory_arena_shrinkage``, but RapidOCR never passes RunOptions.
    Rather than reimplement ``__call__``, we inject the RunOptions into ``session.run``
    for the duration of the call and delegate to the ORIGINAL ``__call__``, so the
    backend keeps its own output handling. CPU sessions pass through untouched. Idempotent per class;
    best-effort (a no-op if onnxruntime is absent). Costs a few cudaFrees per run — noise
    next to the inference — and idle GPU use falls back to the loaded models instead of
    gigabytes of dead arena. OCR is globally serialized (one shared lock), so the
    per-call swap of the instance's ``run`` never races another thread."""
    if getattr(infer_session_cls, "_arena_shrink_patched", False):
        return
    try:
        import onnxruntime as ort
    except Exception:
        return
    ro = ort.RunOptions()
    ro.add_run_config_entry("memory.enable_memory_arena_shrinkage", "gpu:0")
    orig = infer_session_cls.__call__

    def call(self, *args, **kwargs):
        sess = getattr(self, "session", None)
        if sess is None or "CUDAExecutionProvider" not in sess.get_providers():
            return orig(self, *args, **kwargs)   # CPU session: leave untouched
        real_run = sess.run

        def run_with_shrink(output_names, input_feed, run_options=None, **kw):
            return real_run(output_names, input_feed, run_options or ro, **kw)

        sess.run = run_with_shrink   # instance-level shadow; restored below
        try:
            return orig(self, *args, **kwargs)
        finally:
            sess.run = real_run

    infer_session_cls.__call__ = call
    infer_session_cls._arena_shrink_patched = True
