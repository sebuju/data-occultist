"""Sound-file endpoint for the trigger UI's sound picker.

A trigger can name an optional sound the web UI plays when it fires. The files
live under the web static dir (``static/sounds/``) so the existing static mount
serves them at ``/sounds/<file>`` for free — this route just lists what's there
so the picker's ``<select>`` can be populated. Scanned per request (a cheap glob,
mirroring the dictionaries / captures listings)."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter

router = APIRouter(prefix="/api/sounds", tags=["sounds"])

_SOUNDS = Path(__file__).resolve().parent.parent / "static" / "sounds"
_EXTS = {".wav", ".mp3", ".ogg", ".m4a"}


@router.get("")
def all_sounds() -> list[str]:
    """Audio filenames in ``static/sounds/``, sorted; served by the browser at ``/sounds/<name>``."""
    if not _SOUNDS.exists():
        return []
    return sorted(p.name for p in _SOUNDS.iterdir()
                  if p.is_file() and p.suffix.lower() in _EXTS)
