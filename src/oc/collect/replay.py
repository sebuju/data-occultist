"""Feed SAVED live images back through the collector pipeline instead of grabbing fresh window
frames — a "replay" of a recorded live session.

The collector is reused verbatim: it grabs frames through ``engine.capture.grab_window`` and
resolves every window recognises a window via ``engine.process``/``engine.window``. Swapping those
three backends for the stubs here (via :func:`dataclasses.replace` on the :class:`Engine`) makes the
same loop read stored jpegs, with no game running and no change to the pipeline.

Pacing lives here: :class:`ReplayCapture` runs a virtual playback clock seeded from the images' own
capture timestamps (encoded in their filenames, ``%Y%m%d-%H%M%S-%f`` — see
:func:`oc.web.captures_store.save`), so the replay reproduces the real inter-frame wall-clock gaps.
When the clock passes the last image, ``exhausted`` flips true and the caller stops the session.

Fraction math throughout the reader/classifier resolves against ``frame.client`` (the decoded image
size), not the window geometry, so the synthetic :class:`WindowInfo` only needs to exist for the
locator to succeed — its geometry is carried from the first image purely for consistency.
"""

from __future__ import annotations

import time
from collections.abc import Sequence
from datetime import datetime
from pathlib import Path

import cv2

from ..interfaces import CaptureBackend, ProcessDetector, WindowProvider
from ..types import Frame, PixelBox, ProcessInfo, WindowInfo

# small tail (seconds) past the last image's timestamp before we call the run exhausted — gives the
# final frame at least one OCR-due tick to be read before the loop is asked to stop.
_TAIL = 0.5


def parse_stamp(name: str) -> datetime | None:
    """Parse the capture time out of a saved-image filename (``%Y%m%d-%H%M%S-%f.jpg``).
    Returns None for anything that doesn't match the scheme (so stray files are skipped)."""
    stem = Path(name).stem
    try:
        return datetime.strptime(stem, "%Y%m%d-%H%M%S-%f")
    except ValueError:
        return None


def build_image_list(captures_dir: Path | str, game: str) -> list[tuple[datetime, Path]]:
    """Every replayable live image as ``(timestamp, path)`` sorted OLDEST first.

    Source is the game's ``live/`` bucket. ``captures_store.listing`` returns newest-first and
    only well-formed ``*.jpg`` names, but we re-derive the timestamp from each name (the pacing
    clock needs it) and drop anything unparseable."""
    from ..web import captures_store

    base = Path(captures_dir)
    out: list[tuple[datetime, Path]] = []
    for name in captures_store.listing(base, game, sub=captures_store.LIVE):
        ts = parse_stamp(name)
        if ts is None:
            continue
        p = captures_store.path_for(base, game, name, sub=captures_store.LIVE)
        if p is not None:
            out.append((ts, p))
    out.sort(key=lambda it: it[0])
    return out


class ReplayCapture(CaptureBackend):
    """A :class:`CaptureBackend` that serves saved images on a virtual timeline.

    ``grab_window`` ignores the (synthetic) window and returns whichever image the playback clock
    has reached. Repeated grabs of the same image return the cached :class:`Frame`, so the
    collector's own classify/frame caches make redundant reads cheap; a new image is decoded only
    when the clock advances the index."""

    streaming = False

    def __init__(self, images: Sequence[tuple[datetime, Path]]) -> None:
        if not images:
            raise ValueError("ReplayCapture needs at least one image")
        self._images = list(images)
        self.total = len(self._images)
        self.index = 0
        self.exhausted = False
        self._t0_wall: float | None = None
        self._t0_img = self._images[0][0]
        self._span = (self._images[-1][0] - self._t0_img).total_seconds()
        self._cur_idx = -1          # index of the frame currently decoded/cached
        self._cur_frame: Frame | None = None

    def _virtual_elapsed(self) -> float:
        """Seconds into the recorded timeline the playback clock has reached."""
        if self._t0_wall is None:
            self._t0_wall = time.monotonic()
        return time.monotonic() - self._t0_wall

    def _offset(self, i: int) -> float:
        """Recorded seconds from the first image to image ``i``."""
        return (self._images[i][0] - self._t0_img).total_seconds()

    def seconds_to_next(self) -> float | None:
        """Seconds of recorded time until the NEXT image is due on the playback clock, or None when
        the current image is the last one (nothing left to wait for). ``self.index`` is the 1-based
        current position, so it doubles as the 0-based index of the next image."""
        if self.exhausted or self.index >= self.total:
            return None
        return max(0.0, self._offset(self.index) - self._virtual_elapsed())

    def skip(self) -> None:
        """Jump the playback clock forward so the NEXT image is due immediately (pacing from there
        continues normally). No-op at the last image / once exhausted."""
        if self.exhausted or self.index >= self.total:
            return
        self._t0_wall = time.monotonic() - self._offset(self.index)

    def _select(self) -> int:
        """Newest image index whose timestamp is at or before the virtual clock."""
        elapsed = self._virtual_elapsed()
        if elapsed >= self._span + _TAIL:
            self.exhausted = True
        # advance from the current index (timeline is monotonic — no need to rescan from 0)
        i = max(0, self._cur_idx)
        while i + 1 < self.total and (self._images[i + 1][0] - self._t0_img).total_seconds() <= elapsed:
            i += 1
        return i

    def _frame_for(self, i: int) -> Frame:
        if i == self._cur_idx and self._cur_frame is not None:
            return self._cur_frame
        img = cv2.imread(str(self._images[i][1]))
        if img is None:   # unreadable file -> hold the previous frame rather than crash the loop
            if self._cur_frame is not None:
                return self._cur_frame
            raise OSError(f"replay: cannot decode {self._images[i][1]}")
        h, w = img.shape[:2]
        frame = Frame(image=img, client=PixelBox(0, 0, w, h))
        self._cur_idx = i
        self._cur_frame = frame
        self.index = i + 1   # 1-based position for the current/total status readout
        return frame

    def grab_window(self, window: WindowInfo) -> Frame:
        return self._frame_for(self._select())

    def grab_window_regions(self, window: WindowInfo, boxes) -> Frame:
        # sparse grabs make no sense on a stored image — always serve the full frame.
        return self.grab_window(window)

    def grab(self, box: PixelBox) -> Frame:
        frame = self._frame_for(self._select())
        crop = frame.image[box.y : box.y + box.h, box.x : box.x + box.w]
        return Frame(image=crop, client=box)

    def close(self) -> None:   # no live resource to release
        pass


class ReplayWindow(WindowProvider):
    """A one-window provider so :class:`~oc.locate.WindowLocator` resolves with no game running.

    Every lookup returns the same synthetic window carrying the first image's dimensions; it's
    always "foreground". Geometry is only for consistency — the reader resolves fractions against
    the served frame's own client box."""

    def __init__(self, dims: tuple[int, int]) -> None:
        w, h = dims
        self._info = WindowInfo(handle=1, title="replay", pid=1, client=PixelBox(0, 0, w, h))

    def find_for_pid(self, pid: int) -> WindowInfo:
        return self._info

    def find_by_title(self, title_substring: str, exact: bool = False) -> WindowInfo:
        return self._info

    def from_handle(self, handle: int) -> WindowInfo:
        return self._info

    def is_foreground(self, window: WindowInfo) -> bool:
        return True


class ReplayProcess(ProcessDetector):
    """A one-process detector so ``locate._scan`` finds the game whether the profile keys off a
    process name or a title hint."""

    def __init__(self, names: Sequence[str] | None = None) -> None:
        name = (names[0] if names else "replay")
        self._info = ProcessInfo(pid=1, name=name)

    def list_processes(self) -> Sequence[ProcessInfo]:
        return [self._info]

    def find_by_names(self, names: Sequence[str]) -> ProcessInfo:
        return self._info
