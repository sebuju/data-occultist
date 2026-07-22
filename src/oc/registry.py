"""Name -> implementation registries.

Each backend kind has its own registry. Implementations register with a decorator:

    @register_ocr("ppocr5")
    class RapidOcr3Engine(OcrEngine): ...

and are constructed by name:

    engine = build_ocr("ppocr5", **opts)

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
    InputSource,
    Notifier,
    OcrEngine,
    ProcessDetector,
    ProducerSource,
    SourceParser,
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
_PRODUCER: dict[str, type[ProducerSource]] = {}
_PARSER: dict[str, type[SourceParser]] = {}
_NOTIFIER: dict[str, type[Notifier]] = {}
_INPUT: dict[str, type[InputSource]] = {}

# Modules that, when imported, self-register their backends. Add new backend
# modules here (or rely on plugins importing them) so names resolve.
_IMPL_MODULES = (
    "oc.capture.mss_backend",
    "oc.capture.printwindow_backend",
    "oc.capture.wgc_backend",
    "oc.capture.adaptive_backend",
    "oc.window.win32_provider",
    "oc.process.psutil_detector",
    "oc.ocr.rapidocr3_engine",
    "oc.detect.classifier",
    "oc.learn.rapidfuzz_corrector",
    "oc.learn.difflib_corrector",
    "oc.enrich.http_producer",
    "oc.source.parsers.log_lines",
    "oc.source.parsers.ini",
    "oc.source.parsers.json",
    "oc.source.parsers.xml",
    "oc.source.parsers.yaml",
    "oc.notify.null",
    "oc.notify.windows_toast",
    "oc.input.win32_hook",
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


def register_producer(name: str):
    return _register(_PRODUCER, name)


def register_parser(name: str):
    return _register(_PARSER, name)


def register_notifier(name: str):
    return _register(_NOTIFIER, name)


def register_input(name: str):
    return _register(_INPUT, name)


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


def capture_names() -> list[str]:
    """Registered capture-backend names (after discovery). A backend whose module
    fails to import — e.g. ``wgc`` without ``windows-capture`` — simply won't appear."""
    _ensure_loaded()
    return sorted(_CAPTURE)


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


def build_notifier(name: str, **opts) -> Notifier:
    """Build the named notifier, falling back to the ``null`` no-op if the requested
    backend didn't register (e.g. ``windows`` on a box without ``toasted``), so
    a toast target on a non-Windows host degrades to silence instead of erroring."""
    _ensure_loaded()
    if name not in _NOTIFIER:
        name = "null"
    return _build(_NOTIFIER, "notifier", name, **opts)


def build_producer(name: str, **opts) -> ProducerSource:
    return _build(_PRODUCER, "producer", name, **opts)


def producer_names() -> list[str]:
    """Registered producer-backend names (after discovery), for the node's type picker."""
    _ensure_loaded()
    return sorted(_PRODUCER)


def build_parser(name: str, **opts) -> SourceParser:
    return _build(_PARSER, "parser", name, **opts)


def parser_names() -> list[str]:
    """Registered source-parser format names (after discovery)."""
    _ensure_loaded()
    return sorted(_PARSER)


def build_input(name: str, **opts) -> InputSource | None:
    """Build the named input-hook backend, or None if it didn't register (e.g. ``win32`` on a
    non-Windows host) — a missing backend degrades to "on_input triggers never pulse", never an
    error, mirroring :func:`build_notifier`'s graceful fallback."""
    _ensure_loaded()
    if name not in _INPUT:
        return None
    return _build(_INPUT, "input", name, **opts)


def input_names() -> list[str]:
    """Registered input-hook backend names (after discovery)."""
    _ensure_loaded()
    return sorted(_INPUT)
