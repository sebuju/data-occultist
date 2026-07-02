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
