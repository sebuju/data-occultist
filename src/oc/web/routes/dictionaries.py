"""Dictionary term-file endpoints for the teach UI's dictionary picker.

Dictionaries are game-agnostic word lists shared across profiles, living as files
under ``config/dictionaries/``. The picker lists what's available (name + word
count) and, when an existing file is chosen, fetches its terms so the new node
shows them immediately rather than waiting for a reload."""

from __future__ import annotations

from fastapi import APIRouter

from ...profile import list_dictionaries, read_dictionary
from ..deps import get_settings

router = APIRouter(prefix="/api/dictionaries", tags=["dictionaries"])


@router.get("")
def all_dictionaries():
    """Available term files, each ``{source, count}``, sorted by filename."""
    return list_dictionaries(get_settings().profiles_dir)


@router.get("/{source}")
def get_dictionary(source: str):
    """One term file's contents -> ``{source, terms}``; missing file -> empty terms."""
    return {"source": source, "terms": read_dictionary(get_settings().profiles_dir, source)}
