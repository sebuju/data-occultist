"""Shared value types passed across backend boundaries.

These are deliberately backend-agnostic: a capture backend, an OCR engine, and a
window provider all speak in terms of these types, never in terms of each other's
concrete classes. That is what keeps backends swappable.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class PixelBox:
    """Absolute pixel rectangle on a screen or within an image. Origin top-left."""

    x: int
    y: int
    w: int
    h: int

    @property
    def right(self) -> int:
        return self.x + self.w

    @property
    def bottom(self) -> int:
        return self.y + self.h

    def as_tuple(self) -> tuple[int, int, int, int]:
        return (self.x, self.y, self.w, self.h)


@dataclass(frozen=True)
class FractionBox:
    """Rectangle stored as fractions (0..1) of a reference area's width/height.

    Profiles store region coordinates this way so they survive resolution and
    window-size changes. Resolve to pixels against a concrete client area with
    :meth:`to_pixels`.
    """

    x: float
    y: float
    w: float
    h: float

    def to_pixels(self, area_w: int, area_h: int) -> PixelBox:
        return PixelBox(
            x=round(self.x * area_w),
            y=round(self.y * area_h),
            w=round(self.w * area_w),
            h=round(self.h * area_h),
        )

    @classmethod
    def from_pixels(cls, box: PixelBox, area_w: int, area_h: int) -> FractionBox:
        return cls(box.x / area_w, box.y / area_h, box.w / area_w, box.h / area_h)


@dataclass(frozen=True)
class ProcessInfo:
    pid: int
    name: str


@dataclass(frozen=True)
class WindowInfo:
    """A target window's identity and on-screen client-area geometry."""

    handle: int
    title: str
    pid: int
    # Client area in absolute screen pixels (excludes title bar / borders).
    client: PixelBox


@dataclass
class Frame:
    """A captured image plus the client area it was cropped from.

    ``image`` is HxWx3 BGR uint8 (OpenCV convention). ``client`` records the
    screen rectangle it came from so pixel<->fraction math stays unambiguous.
    """

    image: np.ndarray
    client: PixelBox


@dataclass(frozen=True)
class OcrLine:
    text: str
    box: PixelBox  # relative to the image that was OCR'd
    confidence: float
