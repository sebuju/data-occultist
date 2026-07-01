"""File-source endpoints: read now, live-preview an in-progress config, and auto-find files.

The teach UI authors a file-source node (where the file is, which format, the extraction rules)
and needs three things this route provides: fire a read on demand, see what the current rules
would produce WITHOUT writing (live preview), and locate the file across the disk. Editing the
node's config is a normal profile save (it persists in the YAML like any other node).
"""

from __future__ import annotations

import os
import threading

from fastapi import APIRouter, Body, HTTPException

from ...profile import list_profiles, load_profile
from ...profile.models import FileSourceDef, SourceField
from ...registry import build_parser, parser_names
from ...source.extract import DISMISSED, SOURCE_LINE
from ...source.locate import expand, find_candidates, resolve_path
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


_PEEK_BYTES = 256 * 1024   # head of a candidate to show in the auto-find picker


@router.post("/{game}/peek")
def peek(game: str, body: dict = Body(...)):
    """Return the head of a candidate file's raw text (auto-find picker preview). ``body.path`` is an
    absolute path from /find; env-vars/``~`` are still expanded so a hand-typed path also works."""
    _profile_or_404(game)
    raw = (body.get("path") or "").strip()
    path = expand(raw)
    if not path or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="file not found")
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            chunk = fh.read(_PEEK_BYTES)
    except OSError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    text = chunk.decode("utf-8", errors="replace")
    return {"path": path, "text": text, "size": size,
            "truncated": size > len(chunk), "line_ending": _line_ending(path)}


def _source_of(body: dict) -> FileSourceDef:
    """Validate a FileSourceDef-shaped body (the in-progress node config), or 422."""
    try:
        return FileSourceDef.model_validate(body)
    except Exception as exc:   # noqa: BLE001 - surface a 422-ish reason to the editor
        raise HTTPException(status_code=422, detail=f"bad source config: {exc}") from exc


def _parser_of(source: FileSourceDef):
    """Build the source's registered parser, or 400 on an unknown format."""
    parser = build_parser(source.format) if source.format in parser_names() else None
    if parser is None:
        raise HTTPException(status_code=400, detail=f"unknown format {source.format!r}")
    return parser


def _source_text(source: FileSourceDef, body: dict):
    """Resolve the source's text for preview/resolve: a pasted ``sample`` wins; else read the
    located file whole. Returns ``(text, path, line_ending)`` with ``path=None`` and empty text
    when no file resolves (and no sample was given)."""
    sample = body.get("sample")
    if sample:
        return str(sample), None, ""
    path = resolve_path(source)
    if not path:
        return "", None, ""
    return default_reader().read(path, tail=False), path, _line_ending(path)


@router.post("/{game}/preview")
def preview(game: str, body: dict = Body(...)):
    """Parse the in-progress source config WITHOUT writing. ``body`` is a FileSourceDef shape;
    an optional ``sample`` string parses pasted text instead of reading the file. Returns the rows
    the rules produce (``rows``), the rows a REQUIRED field DISMISSED (``dismissed`` — shown in the
    second preview, never written), the detected line ending, and matched/total line counts."""
    _profile_or_404(game)
    source = _source_of(body)
    parser = _parser_of(source)

    text, path, line_ending = _source_text(source, body)
    if path is None and not text:
        return {"rows": [], "dismissed": [], "matched": 0, "dismissed_count": 0, "total": 0,
                "line_ending": "", "path": None, "note": "file not found"}

    total = 0
    if getattr(parser, "stream", False):
        lines = text.splitlines()
        total = len([ln for ln in lines if ln.strip()])
        # mirror the read: with tail on, only the last tail_lines lines; always cap to _PREVIEW_LINES.
        cap = _PREVIEW_LINES
        if source.tail and source.tail_lines and source.tail_lines > 0:
            cap = min(_PREVIEW_LINES, source.tail_lines)
        if len(lines) > cap:
            lines = lines[-cap:]
            text = "\n".join(lines)
        # A stream parser knows each row's source line number, so attach the raw line it matched
        # (SOURCE_LINE) — a preview-only column the vttables show so a row traces back to its line.
        produced = [{**rec, SOURCE_LINE: (lines[ln - 1] if 1 <= ln <= len(lines) else "")}
                    for ln, rec in parser.parse_indexed(text, source.match, source.fields)]
    else:
        total = 1
        produced = parser.parse(text, source.match, source.fields)
    kept = [r for r in produced if not r.get(DISMISSED)]
    dismissed = [{k: v for k, v in r.items() if k != DISMISSED}
                 for r in produced if r.get(DISMISSED)]
    return {"rows": kept[:_PREVIEW_ROWS], "dismissed": dismissed[:_PREVIEW_ROWS],
            "matched": len(kept), "dismissed_count": len(dismissed), "total": total,
            "line_ending": line_ending, "path": path}


@router.post("/{game}/resolve")
def resolve(game: str, body: dict = Body(...)):
    """Inspect the file's own data and PROPOSE extraction columns (the node's "auto-resolve").
    The parser walks its format's structure (json/yaml/ini/xml leaves, or a log line's whitespace
    columns) and returns full :class:`SourceField` dicts — defaults filled, ids deduped — that the
    UI drops straight onto the node. The user then renames/refines; nothing is written or guessed
    into the dataset here."""
    _profile_or_404(game)
    source = _source_of(body)
    parser = _parser_of(source)

    text, path, _ = _source_text(source, body)
    if path is None and not text:
        return {"fields": [], "note": "file not found"}
    if getattr(parser, "stream", False):           # only sniff the tail of a huge log
        lines = text.splitlines()
        if len(lines) > _PREVIEW_LINES:
            text = "\n".join(lines[-_PREVIEW_LINES:])

    fields: list[dict] = []
    seen: set[str] = set()
    for d in parser.suggest(text, source.match) or []:
        fid = (str(d.get("id") or "").strip()) or "field"
        base, n = fid, 1
        while fid in seen:
            n += 1
            fid = f"{base}_{n}"
        seen.add(fid)
        try:
            fields.append(SourceField(**{**d, "id": fid}).model_dump())
        except Exception:   # noqa: BLE001 - a malformed suggestion is skipped, never fatal
            continue
    return {"fields": fields}


# sources currently reading — so a second 'read now' (or a watcher tick) can't double-process the
# same file while a long read is in flight.
_reading: set[tuple[str, str]] = set()
_reading_lock = threading.Lock()


@router.post("/{game}/{source_id}/read")
def read_now(game: str, source_id: str):
    """Kick a read of ``source_id`` and return immediately. A big log (especially with
    ``line_position``, which also writes a position per row) can take many seconds — far longer
    than an HTTP request should block — so the read runs on a daemon thread and its rows stream
    into the dataset via the change bus (the node refreshes live). Returns ``started`` (or
    ``busy`` if a read of this source is already running)."""
    profile = _profile_or_404(game)
    source = profile.file_source(source_id)
    if source is None:
        raise HTTPException(status_code=404, detail=f"No source {source_id!r}")
    data_dir = get_settings().data_dir
    key = (game, source_id)
    with _reading_lock:
        if key in _reading:
            return {"source": source_id, "dataset": source.dataset, "started": False, "busy": True}
        _reading.add(key)

    def _run() -> None:
        try:
            read_source(game, source, data_dir, profile=profile)
        except Exception:   # noqa: BLE001 - a read failure must not wedge the in-flight guard
            pass
        finally:
            with _reading_lock:
                _reading.discard(key)

    threading.Thread(target=_run, daemon=True).start()
    return {"source": source_id, "dataset": source.dataset, "started": True}
