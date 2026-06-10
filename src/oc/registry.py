"""Name -> implementation registries.

Each backend kind has its own registry. Implementations register with a decorator:

    @register_ocr("rapidocr")
    class RapidOcrEngine(OcrEngine): ...

and are constructed by name:

    engine = build_ocr("rapidocr", **opts)

Importing :func:`build_*` triggers a lazy import of the bundled implementation
modules so their decorators run. To add a backend, drop in a module that calls the
matching ``register_*`` and reference it by name in ``settings.yaml`` — no edits to
calling code.
"""

from __future__ import annotations

import importlib
from collections.abc import Callable
from typing import TypeVar

from .interfaces import (
    CaptureBackend,
    Corrector,
    Enricher,
    OcrEngine,
    ProcessDetector,
    WindowClassifier,
    WindowProvider,
)

T = TypeVar("T")

_CAPTURE: dict[str, type[CaptureBackend]] = {}
_WINDOW: dict[str, type[WindowProvider]] = {}
_PROCESS: dict[str, type[ProcessDetector]] = {}
_OCR: dict[str, type[OcrEngine]] = {}
_CLASSIFIER: dict[str, type[WindowClassifier]] = {}
_CORRECTOR: dict[str, type[Corrector]] = {}
_ENRICHER: dict[str, type[Enricher]] = {}

# Modules that, when imported, self-register their backends. Add new backend
# modules here (or rely on plugins importing them) so names resolve.
_IMPL_MODULES = (
    "oc.capture.mss_backend",
    "oc.capture.printwindow_backend",
    "oc.window.win32_provider",
    "oc.process.psutil_detector",
    "oc.ocr.rapidocr_engine",
    "oc.detect.anchor_classifier",
    "oc.learn.rapidfuzz_corrector",
    "oc.learn.difflib_corrector",
    "oc.enrich.warframe_market",
)


def _register(table: dict[str, type[T]], name: str) -> Callable[[type[T]], type[T]]:
    def deco(cls: type[T]) -> type[T]:
        table[name] = cls
        return cls

    return deco


def register_capture(name: str):
    return _register(_CAPTURE, name)


def register_window(name: str):
    return _register(_WINDOW, name)


def register_process(name: str):
    return _register(_PROCESS, name)


def register_ocr(name: str):
    return _register(_OCR, name)


def register_classifier(name: str):
    return _register(_CLASSIFIER, name)


def register_corrector(name: str):
    return _register(_CORRECTOR, name)


def register_enricher(name: str):
    return _register(_ENRICHER, name)


_loaded = False


def _ensure_loaded() -> None:
    global _loaded
    if _loaded:
        return
    for mod in _IMPL_MODULES:
        try:
            importlib.import_module(mod)
        except Exception:  # noqa: BLE001 - a missing optional backend must not break others
            # e.g. win32 backend on non-Windows. Its name simply won't resolve.
            pass
    _loaded = True


def _build(table: dict[str, type[T]], kind: str, name: str, **opts) -> T:
    _ensure_loaded()
    try:
        cls = table[name]
    except KeyError:
        raise KeyError(
            f"No {kind} backend named {name!r}. Available: {sorted(table)}"
        ) from None
    return cls(**opts)


def build_capture(name: str, **opts) -> CaptureBackend:
    return _build(_CAPTURE, "capture", name, **opts)


def build_window(name: str, **opts) -> WindowProvider:
    return _build(_WINDOW, "window", name, **opts)


def build_process(name: str, **opts) -> ProcessDetector:
    return _build(_PROCESS, "process", name, **opts)


def build_ocr(name: str, **opts) -> OcrEngine:
    return _build(_OCR, "ocr", name, **opts)


def build_classifier(name: str, **opts) -> WindowClassifier:
    return _build(_CLASSIFIER, "classifier", name, **opts)


def build_corrector(name: str, **opts) -> Corrector:
    return _build(_CORRECTOR, "corrector", name, **opts)


def build_enricher(name: str, **opts) -> Enricher:
    return _build(_ENRICHER, "enricher", name, **opts)
