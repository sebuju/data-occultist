"""File-source endpoints: read now, live-preview an in-progress config, and auto-find files.

The teach UI authors a file-source node (where the file is, which format, the extraction rules)
and needs three things this route provides: fire a read on demand, see what the current rules
would produce WITHOUT writing (live preview), and locate the file across the disk. Editing the
node's config is a normal profile save (it persists in the YAML like any other node).
"""

from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException

from ...profile import list_profiles, load_profile
from ...profile.models import FileSourceDef
from ...registry import build_parser, parser_names
from ...source.locate import find_candidates, resolve_path
from ...source.reader import default_reader
from ...source.runner import read_source
from ..deps import get_settings

router = APIRouter(prefix="/api/sources", tags=["sources"])

_PREVIEW_ROWS = 200       # cap returned rows (mirrors the front-end DS_ROW_CAP)
_PREVIEW_LINES = 4000     # only parse the tail of a big log for an instant preview


def _profile_or_404(game: str):
    settings = get_settings()
    if game not in list_profiles(settings.profiles_dir):
        raise HTTPException(status_code=404, detail=f"No profile {game!r}")
    return load_profile(settings.profiles_dir, game)


def _line_ending(path: str) -> str:
    """Detect the file's line ending from raw bytes (read_text would normalise it away)."""
    try:
        with open(path, "rb") as fh:
            chunk = fh.read(65536)
    except OSError:
        return ""
    if b"\r\n" in chunk:
        return "CRLF"
    if b"\n" in chunk:
        return "LF"
    if b"\r" in chunk:
        return "CR"
    return ""


@router.get("/formats")
def formats():
    """Registered parser format names (for the node's format select)."""
    return {"formats": parser_names()}


@router.post("/{game}/find")
def find(game: str, body: dict = Body(default={})):
    """Auto-find candidate files for ``filename`` (a glob) across generic OS roots + extra roots."""
    _profile_or_404(game)
    filename = (body.get("filename") or "").strip()
    roots = body.get("roots") or []
    return {"candidates": find_candidates(filename, roots)}


@router.post("/{game}/preview")
def preview(game: str, body: dict = Body(...)):
    """Parse the in-progress source config WITHOUT writing. ``body`` is a FileSourceDef shape;
    an optional ``sample`` string parses pasted text instead of reading the file. Returns the
    rows the rules produce, the detected line ending, and matched/total line counts."""
    _profile_or_404(game)
    try:
        source = FileSourceDef.model_validate(body)
    except Exception as exc:   # noqa: BLE001 - surface a 422-ish reason to the editor
        raise HTTPException(status_code=422, detail=f"bad source config: {exc}") from exc

    parser = build_parser(source.format) if source.format in parser_names() else None
    if parser is None:
        raise HTTPException(status_code=400, detail=f"unknown format {source.format!r}")

    sample = body.get("sample")
    line_ending = ""
    path = None
    if sample:
        text = str(sample)
    else:
        path = resolve_path(source)
        if not path:
            return {"rows": [], "matched": 0, "total": 0, "line_ending": "",
                    "path": None, "note": "file not found"}
        text = default_reader().read(path, tail=False)
        line_ending = _line_ending(path)

    total = 0
    if getattr(parser, "stream", False):
        lines = text.splitlines()
        total = len([ln for ln in lines if ln.strip()])
        if len(lines) > _PREVIEW_LINES:        # only parse the tail of a huge log
            text = "\n".join(lines[-_PREVIEW_LINES:])
    else:
        total = 1
    rows = parser.parse(text, source.match, source.fields)
    return {"rows": rows[:_PREVIEW_ROWS], "matched": len(rows), "total": total,
            "line_ending": line_ending, "path": path}


@router.post("/{game}/{source_id}/read")
def read_now(game: str, source_id: str):
    """Read ``source_id`` now and write its rows to the dataset (the manual 'read' button)."""
    profile = _profile_or_404(game)
    source = profile.file_source(source_id)
    if source is None:
        raise HTTPException(status_code=404, detail=f"No source {source_id!r}")
    rows = read_source(game, source, get_settings().data_dir, profile=profile)
    return {"source": source_id, "dataset": source.dataset, "rows": rows}
