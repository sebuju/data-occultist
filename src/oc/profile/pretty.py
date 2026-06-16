"""The Pretty Studio document: a sidecar ``<game>.pretty.yaml`` next to the profile.

Pretty Studio is a convenience surface authored over the same live data the node view
exposes — pages of widgets (labels, tables, charts, controls, forms, buttons) bound to
datasets/subsets/node-inputs, each freely styled and conditionally shown. That *design*
lives here, in its own file beside ``config/games/<game>.yaml``, NOT inside the profile —
so it round-trips independently and a profile load never has to know about it.

The document is intentionally lenient: the front-end (``static/js/pretty/``) is the single
source of truth for a widget's shape, so this model declares only the top-level frame and
lets everything below ride through untyped (``extra="allow"``, like ``GraphLayout``). A new
widget field never needs a model edit and can never 422 a save.

Values a user enters through Pretty controls are NOT stored here — they are transient
runtime overrides (see :mod:`oc.runtime.overrides`).
"""

from __future__ import annotations

from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, Field

from .loader import _atomic_write_text


def pretty_path(profiles_dir: Path | str, name: str) -> Path:
    return Path(profiles_dir) / f"{name}.pretty.yaml"


class PrettyDoc(BaseModel):
    """A whole Pretty Studio design. ``theme`` holds global style defaults; ``pages`` is a
    list of page dicts (``{id, title, style, widgets:[...]}``), opaque to the backend."""

    model_config = ConfigDict(extra="allow")

    version: int = 1
    theme: dict = Field(default_factory=dict)
    pages: list[dict] = Field(default_factory=list)


def _default_doc() -> dict:
    """A fresh document with one empty page, so the UI always has somewhere to drop a widget."""
    return {"version": 1, "theme": {},
            "pages": [{"id": "main", "title": "Main", "style": {}, "widgets": []}]}


def load_pretty(profiles_dir: Path | str, name: str) -> dict:
    """The Pretty document for ``name`` as a plain dict, or a fresh default if none exists
    (or the file is unreadable). Validated through :class:`PrettyDoc` so the top-level frame
    is always well-formed while widget internals pass through untouched."""
    path = pretty_path(profiles_dir, name)
    if not path.exists():
        return _default_doc()
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        return _default_doc()
    if not isinstance(raw, dict):
        return _default_doc()
    doc = PrettyDoc.model_validate(raw)
    out = doc.model_dump(mode="json")
    if not out.get("pages"):
        out["pages"] = _default_doc()["pages"]
    return out


def save_pretty(profiles_dir: Path | str, name: str, doc: dict) -> Path:
    """Persist a Pretty document atomically. Accepts the front-end's raw dict; the model
    normalises the frame (extras preserved)."""
    validated = PrettyDoc.model_validate(doc or {})
    data = validated.model_dump(mode="json")
    path = pretty_path(profiles_dir, name)
    _atomic_write_text(path, yaml.safe_dump(data, sort_keys=False, allow_unicode=True))
    return path
