"""Testing harness endpoints: feed a recorded video through the live OCR pipeline.

Upload a screen-capture clip, then play/seek/step it and enable it as the live
frame source. With it enabled, live mode (and the preview/detect endpoints'
live-grab path) read decoded video frames instead of the game window — so the
whole detect + OCR chain can be tested with no game running. See
``video_source.VideoSource`` for the playback model.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, UploadFile

from ..deps import get_settings
from ..video_source import get_video_source

router = APIRouter(prefix="/api/video", tags=["video"])


def _videos_dir() -> Path:
    d = Path(get_settings().data_dir) / "_test_videos"
    d.mkdir(parents=True, exist_ok=True)
    return d


@router.post("/upload")
async def upload(file: UploadFile):
    name = Path(file.filename or "video").name
    dest = _videos_dir() / name
    with dest.open("wb") as out:
        shutil.copyfileobj(file.file, out)
    try:
        return get_video_source().load(dest, name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/status")
def status():
    return get_video_source().status()


@router.post("/seek")
def seek(index: int = Query(...)):
    return get_video_source().seek(index)


@router.post("/step")
def step(n: int = Query(1)):
    return get_video_source().step(n)


@router.post("/enable")
def enable(on: bool = Query(...)):
    return get_video_source().set_enabled(on)


@router.post("/close")
def close():
    return get_video_source().close()
