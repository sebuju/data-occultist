"""Assemble concrete backends from :class:`Settings`.

This is the only place that turns backend *names* into live objects. Everything
downstream receives ready-built interfaces, so swapping a backend never reaches
past this module.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .interfaces import (
    CaptureBackend,
    Corrector,
    OcrEngine,
    ProcessDetector,
    WindowClassifier,
    WindowProvider,
)
from .registry import (
    build_capture,
    build_classifier,
    build_corrector,
    build_ocr,
    build_process,
    build_window,
)
from .settings import Settings


@dataclass
class Engine:
    """Bundle of live backends plus the settings they came from."""

    settings: Settings
    capture: CaptureBackend
    window: WindowProvider
    process: ProcessDetector
    ocr: OcrEngine
    classifier: WindowClassifier
    corrector: Corrector

    @classmethod
    def build(cls, settings: Settings | None = None) -> "Engine":
        settings = settings or Settings.load()
        # Declare DPI awareness before any window/capture work so win32 geometry
        # and mss captures share true physical-pixel space (no display-scaling skew).
        from .window.dpi import set_process_dpi_aware

        set_process_dpi_aware()
        ocr = build_ocr(settings.ocr.name, **settings.ocr.options)
        # The classifier needs the OCR engine (text anchors) and where templates live.
        classifier_opts = {
            "ocr": ocr,
            "profile_dir": str(Path(settings.profiles_dir)),
            **settings.classifier.options,
        }
        return cls(
            settings=settings,
            capture=build_capture(settings.capture.name, **settings.capture.options),
            window=build_window(settings.window.name, **settings.window.options),
            process=build_process(settings.process.name, **settings.process.options),
            ocr=ocr,
            classifier=build_classifier(settings.classifier.name, **classifier_opts),
            corrector=build_corrector(settings.corrector.name, **settings.corrector.options),
        )
