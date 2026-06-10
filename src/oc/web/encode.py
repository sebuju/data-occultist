"""Encode a captured frame to bytes for the browser preview.

JPEG is used for the teaching preview because it is ~10x smaller than PNG at 4K
(faster transfer/decode). This only affects the on-screen backdrop the user draws
boxes over — OCR always runs on the raw server-side frame, so JPEG artifacts never
touch the collected data.
"""

from __future__ import annotations

import cv2

from ..types import Frame


def frame_to_jpeg(frame: Frame, quality: int = 85) -> bytes:
    ok, buf = cv2.imencode(".jpg", frame.image, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("Failed to JPEG-encode frame")
    return buf.tobytes()
