"""Backend contracts.

Every pluggable subsystem is an ABC here. Concrete implementations live in their
own modules and register themselves by name (see :mod:`oc.registry`). Code that
*uses* a backend depends only on these ABCs, never on a concrete class, so any
implementation can be swapped by changing a name in ``settings.yaml``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Callable, Sequence
from dataclasses import dataclass

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
    def find_by_title(self, title_substring: str, exact: bool = False) -> WindowInfo | None: ...

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

    # True => grab_window() is a cheap, non-blocking read of a cached frame that captures the
    # window's OWN surface (works backgrounded/occluded, no game re-render, no desktop BitBlt).
    # A streaming backend can be polled tight-loop for free; a non-streaming one must not.
    streaming: bool = False

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

    def prepare(self) -> None:
        """Build/load any heavy model NOW, outside any timed read region. Called before a
        job's timer starts so a first-time lazy build isn't charged to that read's compute.
        Safe to call repeatedly (no-op once ready). Default does nothing — backends with
        lazy model construction override it."""

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

    def read_lines(self, images) -> list[tuple[str, float]]:
        """Recognise MANY single-line crops, result aligned to input by index. Default
        loops :meth:`read_line`; a backend that can batch the recogniser overrides this
        to run them in one pass (far fewer GPU launches)."""
        return [self.read_line(im) for im in images]

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
    def best(self, candidate: str, vocabulary: Sequence[str],
             cutoff: float = 0.0) -> tuple[str, float] | None:
        """Return ``(term, score)`` for the closest match, or ``None`` if vocab is
        empty or nothing scores >= ``cutoff``.

        ``score`` is normalised 0..1 (1.0 = identical). Callers that will discard
        matches below a threshold should pass it as ``cutoff`` — a backend can prune
        the search dramatically with it (rapidfuzz short-circuits per term)."""


@dataclass
class ProducerCtx:
    """Everything a :class:`ProducerSource` needs for one refresh. Built by the producer
    runner around the sweep gate, so a backend stays free of the orchestration (locking,
    status sidecar, threading). ``node`` is the producer's :class:`~oc.profile.models.ProducerDef`
    (duck-typed here — backends read ``dataset``/``throttle``/``mode``/``sources``/``source_field``)
    so this module needs no profile-model import.

    ``on_item(done, total, slug, name, ok)`` fires per completed unit of work (for progress);
    ``should_stop()`` is polled to abort a cancelled refresh promptly. ``items`` is an explicit
    work list (e.g. an on_change trigger's changed keys) or ``None`` to let the backend decide.
    """

    data_dir: str
    game: str
    node: object
    dataset: str
    key: object | None = None
    profile: object | None = None
    items: list | None = None
    timeout: float = 30.0
    limit: int = 0
    workers: int = 6
    on_item: Callable[[int, int, str, str, bool], None] | None = None
    should_stop: Callable[[], bool] | None = None


class ProducerSource(ABC):
    """A network *producer* fired on a schedule/trigger: it fetches external data and writes
    current records into an output dataset — the producer pattern parallel to OCR capture and
    file sources. Heavy + cancellable, so it runs only on an explicit refresh (the manual button
    or a trigger), never in the capture loop. Selected by name (``ProducerDef.type`` ->
    ``registry._PRODUCER``): ``http`` (fetch a taught URL, map JSON -> columns — per item, or
    one fetch expanded into many rows in list mode)."""

    @abstractmethod
    def run(self, ctx: ProducerCtx) -> dict:
        """Run one refresh: fetch + write rows into ``ctx.dataset``. Emit progress via
        ``ctx.on_item`` and abort promptly when ``ctx.should_stop()`` turns true. Returns a
        small summary dict (e.g. ``{"total", "fetched", "failed"}``)."""


class SourceParser(ABC):
    """Turn a game file's text into record dicts, per a file-source node's extraction rules.

    A producer parallel to OCR: it reads a log/config file rather than the screen. ``stream``
    marks a line-oriented parser (a log — many records, tailable by byte offset) versus a
    whole-document parser (ini/json/xml/yaml — the file is one structured value). ``match`` and
    ``fields`` are the node's rules (lists of :class:`SourceMatch` / :class:`SourceField`); they
    are passed in rather than imported here so this module stays free of the profile models.
    """

    stream: bool = False

    @abstractmethod
    def parse(self, text: str, match, fields) -> list[dict]:
        """Parse ``text`` into a list of ``{field_id: value}`` records using the rules."""

    def parse_indexed(self, text: str, match, fields) -> list[tuple[int, dict]]:
        """Like :meth:`parse` but pairs each record with a 1-based POSITION. The base default
        is emit order (1, 2, 3 …); a line-oriented parser overrides it to report the record's
        true SOURCE LINE number (so unmatched lines still advance the count). Used when a
        file-source feeds line numbers as the dataset position."""
        return list(enumerate(self.parse(text, match, fields), start=1))

    def suggest(self, text: str, match) -> list[dict]:
        """Propose extraction columns by inspecting the file's own data — the UI's "auto-resolve"
        offers them as a starting point the user then refines. Each entry is a partial
        :class:`oc.profile.models.SourceField` kwargs dict (``{"id", "method", ...}``); the caller
        wraps it into a full field (filling defaults + deduping ids). The base default proposes
        nothing — a parser that can read structure out of its format overrides this."""
        return []


class WindowClassifier(ABC):
    """Decide which profile-defined window (and state) a frame shows.

    Returns ``(window_id, state_id)`` or ``None`` if nothing matches. Concrete
    classifiers may use template matching, OCR text detectors, or anything else.
    """

    @abstractmethod
    def classify(self, frame: Frame, profile) -> tuple[str, str | None] | None: ...


@dataclass
class ToastSpec:
    """One OS desktop notification to raise, backend-agnostic — the value a
    :class:`Notifier` speaks. Authored per toast node in the profile (see
    ``oc.profile.models.ToastDef``); ``app_name`` is the notification's source label
    (its AppUserModelID), ``duration`` is ``"short"`` or ``"long"``, ``icon`` an
    optional app-logo image path, ``muted`` silences the toast sound."""

    title: str = ""
    message: str = ""
    app_name: str = "data-occultist"
    duration: str = "short"
    icon: str = ""
    attribution: str = ""
    muted: bool = False


class Notifier(ABC):
    """Raise an OS desktop notification. Fired server-side when a trigger targets a
    toast node — never in the capture loop, so a notification backend can never hurt
    collection robustness. Selected by name (``settings.notifier`` -> ``registry._NOTIFIER``);
    a backend whose platform lib is missing simply doesn't register and the engine
    falls back to the ``null`` no-op notifier."""

    @abstractmethod
    def notify(self, spec: ToastSpec) -> None:
        """Raise one toast. Must never raise: a failed notification must not crash a fire."""
