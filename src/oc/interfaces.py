"""Backend contracts.

Every pluggable subsystem is an ABC here. Concrete implementations live in their
own modules and register themselves by name (see :mod:`oc.registry`). Code that
*uses* a backend depends only on these ABCs, never on a concrete class, so any
implementation can be swapped by changing a name in ``settings.yaml``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Sequence

from .types import Frame, OcrLine, PixelBox, ProcessInfo, WindowInfo


class ProcessDetector(ABC):
    """Find running game processes."""

    @abstractmethod
    def list_processes(self) -> Sequence[ProcessInfo]: ...

    @abstractmethod
    def find_by_names(self, names: Sequence[str]) -> ProcessInfo | None:
        """Return the first running process whose name matches (case-insensitive)."""


class WindowProvider(ABC):
    """Locate and measure a target window on screen."""

    @abstractmethod
    def find_for_pid(self, pid: int) -> WindowInfo | None: ...

    @abstractmethod
    def find_by_title(self, title_substring: str) -> WindowInfo | None: ...

    @abstractmethod
    def from_handle(self, handle: int) -> WindowInfo | None:
        """Re-resolve a window by handle, refreshing its geometry.

        Returns ``None`` if the handle is no longer a valid visible window. Cheap
        (no process scan) — used to revalidate a cached window each frame.
        """

    @abstractmethod
    def is_foreground(self, window: WindowInfo) -> bool: ...


class CaptureBackend(ABC):
    """Grab pixels from the screen."""

    @abstractmethod
    def grab(self, box: PixelBox) -> Frame:
        """Capture an absolute-screen rectangle as a BGR :class:`Frame`."""

    @abstractmethod
    def grab_window(self, window: WindowInfo) -> Frame:
        """Capture a window's client area."""


class OcrEngine(ABC):
    """Turn an image region into text."""

    @abstractmethod
    def read_image(self, image) -> list[OcrLine]:
        """OCR a whole BGR image. Boxes are relative to that image."""

    def read_line(self, image) -> tuple[str, float]:
        """Recognise a crop that is KNOWN to be a single text line — skipping the
        expensive text-detection stage. Returns ``(text, confidence)``.

        Detection dominates OCR cost (a full network pass), so when the caller already
        knows the box bounds one line (a field the user drew), this is many times
        faster. Default falls back to the full pipeline for backends without rec-only.
        """
        lines = self.read_image(image)
        if not lines:
            return "", 0.0
        lines.sort(key=lambda ln: (round(ln.box.y / max(1, ln.box.h)), ln.box.x))
        return " ".join(ln.text for ln in lines).strip(), sum(ln.confidence for ln in lines) / len(lines)

    def read_region(self, frame: Frame, box: PixelBox) -> list[OcrLine]:
        """OCR a sub-rectangle of a frame. Default crops then delegates.

        Override only if a backend can do something smarter than crop-then-read.
        """
        crop = frame.image[box.y : box.y + box.h, box.x : box.x + box.w]
        lines = self.read_image(crop)
        # Translate line boxes back into frame-image coordinates.
        return [
            OcrLine(
                text=ln.text,
                confidence=ln.confidence,
                box=PixelBox(ln.box.x + box.x, ln.box.y + box.y, ln.box.w, ln.box.h),
            )
            for ln in lines
        ]


class Corrector(ABC):
    """Fuzzy-match a noisy candidate string against a known vocabulary.

    Used to repair uncertain OCR output: when confidence is low, the candidate is
    snapped to the closest learned term if similarity clears a threshold.
    """

    @abstractmethod
    def best(self, candidate: str, vocabulary: Sequence[str]) -> tuple[str, float] | None:
        """Return ``(term, score)`` for the closest match, or ``None`` if vocab is empty.

        ``score`` is normalised 0..1 (1.0 = identical).
        """


class Enricher(ABC):
    """Augment a collected record with data from an external source.

    Runs as a *post-processing* step over saved records (never in the capture
    loop), so network latency or outages can't compromise capture robustness.
    Returns a dict of extra fields to merge, or ``{}`` on failure.
    """

    @abstractmethod
    def enrich(self, values: dict) -> dict: ...


class WindowClassifier(ABC):
    """Decide which profile-defined window (and state) a frame shows.

    Returns ``(window_id, state_id)`` or ``None`` if nothing matches. Concrete
    classifiers may use template matching, OCR anchors, or anything else.
    """

    @abstractmethod
    def classify(self, frame: Frame, profile) -> tuple[str, str | None] | None: ...
