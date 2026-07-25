"""Shared offline-bench helpers: load bound captures, build a reader, score its reads.

Both benches (``bench_preprocess`` = preprocess modes, ``bench_ocr_models`` = OCR model
variants) run the SAME frames through the SAME reader construction so only the thing
under test differs. Everything common lives here; a bench script owns just its variant
axis and its table.

Importing this module puts ``src`` on ``sys.path``, so a bench runs straight from a
checkout with no editable install — import it BEFORE any ``oc.*`` import.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from oc.collect.reader import RegionReader          # noqa: E402
from oc.learn.dictionary import build_dictionaries  # noqa: E402
from oc.learn.resolver import FieldResolver         # noqa: E402
from oc.web import captures_store                   # noqa: E402

import cv2  # noqa: E402


def name_field(window) -> str | None:
    """The window's primary text field id (the item name), for scoring."""
    for f in window.fields:
        if f.type.value == "text":
            return f.id
    return window.fields[0].id if window.fields else None


def frame_for(engine, game, cap):
    """One bound capture filename -> a full-client :class:`Frame` (None if unreadable)."""
    from oc.types import Frame, PixelBox

    path = captures_store.path_for(engine.settings.captures_dir, game, cap)
    if not path:
        return None
    img = cv2.imread(str(path))
    if img is None:
        return None
    h, w = img.shape[:2]
    return Frame(image=img, client=PixelBox(0, 0, w, h))


def load_frames(engine, game, window_id) -> list[tuple[str, object]]:
    """Every readable bound capture for a window, as ``(filename, Frame)`` pairs."""
    caps = captures_store.get_bindings(engine.settings.captures_dir, game).get(window_id) or []
    if isinstance(caps, str):
        caps = [caps]
    pairs = [(c, frame_for(engine, game, c)) for c in caps]
    return [(c, f) for c, f in pairs if f is not None]


def build_reader(engine, profile, game, window, ocr=None) -> RegionReader:
    """A reader wired exactly as the live path wires one.

    ``ocr`` overrides the engine's OCR backend — that is the whole point for
    ``bench_ocr_models``, which swaps the recogniser while holding the dictionaries,
    resolver and cutout templates fixed.
    """
    from oc.collect.items import item_templates

    pooled, dmap = build_dictionaries(profile, engine.corrector)
    resolver = FieldResolver(engine.corrector, engine.settings.tuning.accept_confidence,
                             dictionary=pooled, dictionaries=dmap)
    templates = item_templates([window], captures_store.cutout_loader(
        engine.settings.captures_dir, game))
    return RegionReader(ocr or engine.ocr, resolver, templates)


def reads_for(reader, frame, window, fields, fid, key: str = "value") -> list[tuple[str, float]]:
    """Every valid cell's ``(text, confidence)`` for one frame, for field ``fid``.

    ``key`` picks WHICH text: ``"value"`` is the resolved result (rules + dictionary
    correction applied), ``"raw"`` is what OCR actually returned. Benching an OCR change
    against ``value`` can silently understate it — two recognisers that misread a name
    differently both snap to the same dictionary entry and look identical. Compare ``raw``
    to see the recogniser itself; compare ``value`` to see what the pipeline finally stores.
    """
    result = reader.read_preview(frame, window, fields)
    out = []
    for cell in result["cells"]:
        if not cell.get("valid", True):
            continue
        f = cell["fields"].get(fid)
        if f and f.get(key):
            out.append((str(f[key]), float(f.get("confidence") or 0.0)))
    return out


def correction_rate(reader, frame, window, fields, fid) -> tuple[int, int]:
    """``(corrected, total)`` valid reads for one frame — how often the resolved value
    differs from the raw OCR text. A high rate means the dictionary is absorbing recogniser
    errors, so a ``value``-based comparison cannot see model differences.
    """
    result = reader.read_preview(frame, window, fields)
    corrected = total = 0
    for cell in result["cells"]:
        if not cell.get("valid", True):
            continue
        f = cell["fields"].get(fid)
        if not f or not f.get("value"):
            continue
        total += 1
        corrected += str(f.get("raw") or "") != str(f.get("value") or "")
    return corrected, total
