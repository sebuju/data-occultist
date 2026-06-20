"""Fast floating-number processing.

A pipeline tuned for ONE job: read numbers that flash on screen and drift away (combat
damage numbers, score popups) as fast as possible, tracking each so it is read exactly
once. Three stages, each its own module so they swap independently:

- :mod:`oc.numbers.detect`  — OCR-free blob finder: a frame -> candidate number boxes.
- :mod:`oc.numbers.track`   — associates boxes across frames into motion tracks (numbers
  float in a steady direction), so a number visible for N frames is ONE thing, not N.
- :mod:`oc.numbers.process` — OCRs each track once (when ripe), parses the value, and
  emits it, with a dedup guard so the same number is never read twice.

Pair it with :mod:`oc.capture.fastcap`: capture a burst at high FPS, then feed the frames
through :class:`oc.numbers.process.NumberProcessor`. Not wired into the collector.
"""

from .detect import Blob, DetectConfig, NumberDetector
from .process import NumberConfig, NumberProcessor, ReadNumber
from .track import NumberTracker, Track, TrackConfig

__all__ = [
    "Blob",
    "DetectConfig",
    "NumberDetector",
    "Track",
    "TrackConfig",
    "NumberTracker",
    "ReadNumber",
    "NumberConfig",
    "NumberProcessor",
]
