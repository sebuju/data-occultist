"""DirectML plumbing for the ONNX-runtime OCR backend.

DirectML (``DmlExecutionProvider``) is the only path to a non-NVIDIA GPU on
Windows — an AMD/Intel iGPU or dGPU — so OCR can run off the game's CUDA card. It
needs the ``onnxruntime-directml`` build (which can't coexist with
``onnxruntime-gpu``: both own the ``onnxruntime`` module — use a separate venv).
Lives beside :mod:`oc.ocr.cuda` as sibling ORT-provider plumbing.
"""

from __future__ import annotations

_DML_CFG_PATCHED = False


def dml_available() -> bool:
    """True when onnxruntime exposes the DirectML provider (the ``onnxruntime-directml``
    build is installed). The CUDA/CPU builds return False — mirrors
    :func:`oc.ocr.cuda.cuda_available` for the DML path."""
    try:
        import onnxruntime as ort
        return "DmlExecutionProvider" in ort.get_available_providers()
    except Exception:
        return False


def patch_dml_provider_cfg() -> None:
    """Coerce rapidocr's DirectML EP-config to a plain, string-valued ``dict``.

    ``ProviderConfig.dml_ep_cfg()`` returns ``self.cfg.dml_ep_cfg`` RAW — an omegaconf
    ``DictConfig`` — whereas the CUDA sibling wraps it in ``dict(...)``. ONNX Runtime's
    provider-args check only accepts ``str`` or ``(str, dict)`` entries, and a
    ``DictConfig`` is not a ``dict`` subclass, so a pinned ``dml_ep_cfg.device_id``
    makes session creation raise and silently FALL BACK TO CPU — the iGPU never runs.
    We also stringify the values (the DML EP rejects non-string option values, e.g. an
    int ``device_id``). Without a pinned ``device_id`` DML grabs adapter 0 (often the
    dGPU), so this is what lets OCR target a specific idle adapter.

    Idempotent; best-effort (no-op if ``rapidocr`` isn't importable). Called from the
    OCR engine only when ``use_dml`` is set."""
    global _DML_CFG_PATCHED
    if _DML_CFG_PATCHED:
        return
    try:
        from omegaconf import OmegaConf
        from rapidocr.inference_engine.onnxruntime.provider_config import ProviderConfig
    except Exception:  # noqa: BLE001 - rapidocr/omegaconf absent -> nothing to patch
        return

    def dml_ep_cfg(self):
        cfg = self.cfg.dml_ep_cfg
        if cfg is not None:
            return {k: str(v) for k, v in OmegaConf.to_container(cfg, resolve=True).items()}
        # rapidocr's own fallback when no dml block is authored (both wrap in dict())
        if self.is_cuda_available():
            return self.cuda_ep_cfg()
        return self.cpu_ep_cfg()

    ProviderConfig.dml_ep_cfg = dml_ep_cfg
    _DML_CFG_PATCHED = True
