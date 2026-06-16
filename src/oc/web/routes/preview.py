"""Preview endpoint: OCR the current (unsaved) box layout and report what it reads.

The teaching UI POSTs the in-progress profile (one window + fields). The server
captures the live window and runs the reader over the window's regions/grid,
returning raw text + extracted value + confidence per cell — so the user can see
exactly what each box gets out of the image before saving.
"""

from __future__ import annotations

import cv2
from fastapi import APIRouter, HTTPException, Query

from ...collect.reader import RegionReader
from ...detect.matcher import DetectMatcher
from ...learn.dictionary import build_dictionaries
from ...learn.lexicon import Lexicon
from ...learn.resolver import FieldResolver
from ...ocr.serialize import ocr_job
from ...profile import GameProfile, KeyDef, list_profiles
from ...runtime import load_live_profile
from ...store.dataset_store import DatasetStore
from ...types import Frame, PixelBox
from .. import captures_store
from ..deps import get_engine, get_locator, get_settings
from ..video_source import get_video_source

router = APIRouter(prefix="/api", tags=["preview"])


def _frame_for(engine, profile, game, capture):
    # Testing harness: when a video is loaded AND enabled, the live-grab path
    # (capture=None) reads the current decoded video frame instead of the window,
    # so live mode runs with no game open. An explicit stashed capture still wins.
    if not (game and capture):
        vs = get_video_source()
        if vs.enabled:
            img = vs.current_image()
            if img is None:
                raise HTTPException(status_code=409, detail="test video has no frame")
            h, w = img.shape[:2]
            return Frame(image=img, client=PixelBox(0, 0, w, h))
    if game and capture:
        path = captures_store.path_for(get_settings().captures_dir, game, capture)
        if path is None:
            raise HTTPException(status_code=404, detail="capture not found")
        img = cv2.imread(str(path))
        if img is None:
            raise HTTPException(status_code=500, detail="failed to read capture")
        h, w = img.shape[:2]
        return Frame(image=img, client=PixelBox(0, 0, w, h))
    win = get_locator().locate(profile)
    if win is None:
        raise HTTPException(status_code=404, detail="game window not found")
    return engine.capture.grab_window(win)


@router.post("/detect")
def detect(profile: GameProfile, game: str | None = Query(None), capture: str | None = Query(None)):
    """Evaluate each window detector + state against the image: matched + what it read."""
    if not profile.windows:
        return {"detect": {}, "states": {}}
    engine = get_engine()
    frame = _frame_for(engine, profile, game, capture)
    window = profile.windows[0]
    matcher = DetectMatcher(engine.ocr, str(get_settings().profiles_dir))

    # one job: run the whole detect pass without interleaving with another OCR job
    with ocr_job():
        detect = {d.id: matcher.evaluate(d, frame) for d in window.detect}
        states = {}
        for s in window.states:
            evs = [matcher.evaluate(d, frame) for d in s.detect]
            states[s.id] = {
                "matched": bool(evs) and all(e["matched"] for e in evs),
                "read": " | ".join(e["read"] for e in evs),
            }

    scrollbar = None
    sc = window.scroll
    if sc and sc.scrollbar:
        from ...collect.scrollbar import scroll_detail
        box = sc.scrollbar.to_fraction().to_pixels(frame.client.w, frame.client.h)
        crop = frame.image[box.y : box.y + box.h, box.x : box.x + box.w]
        d = scroll_detail(crop, sc.scrollbar_orientation)
        if d is not None:
            vertical = sc.scrollbar_orientation != "horizontal"
            scrollbar = {
                "pos": d["pos"],
                "px": (box.y if vertical else box.x) + d["thumb_px"],   # thumb top in window pixels
                "conf": d["conf"],
            }

    return {"detect": detect, "states": states, "scrollbar": scrollbar,
            "device": getattr(engine.ocr, "device", "cpu")}


def _window_match(matcher, win, frame):
    """Evaluate a window's ENABLED detectors against a frame. Returns (matched, evs).
    Mirrors the classifier: a window matches when it has >=1 enabled detector and ALL pass."""
    dets = [d for d in win.detect if d.enabled]
    evs = [{"id": d.id, **matcher.evaluate(d, frame)} for d in dets]
    matched = bool(evs) and all(e["matched"] for e in evs)
    return matched, evs


@router.get("/detect/collisions/{game}")
def detect_collisions(game: str):
    """Cross-check every window against every other. For each window that has a bound
    reference capture, run that image through ALL windows' detectors and report when a
    window other than the owner also matches (ambiguous) or wins the classify tie-break
    (misclassification). This is what catches one window's loose detectors false-matching
    another's screen (e.g. a relic detector firing on the equipment window).

    Per-window verdict:
      ok            — only the owner matched
      collision     — another window also fully matched (ambiguous on this image)
      misclassified — another window WINS (more detectors) -> classify picks the wrong one
      self_no_match — the owner's own image doesn't match the owner (detectors too strict)
      no_image      — no bound capture to test against
    """
    settings = get_settings()
    if game not in list_profiles(settings.profiles_dir):
        raise HTTPException(status_code=404, detail=f"no profile {game!r}")
    profile = load_live_profile(settings.profiles_dir, game)
    engine = get_engine()
    matcher = DetectMatcher(engine.ocr, str(settings.profiles_dir))
    bindings = captures_store.get_bindings(settings.captures_dir, game)

    out = []
    for w in profile.windows:
        cap = captures_store.first(bindings.get(w.id))   # the window's primary page
        if not cap:
            out.append({"window": w.id, "capture": None, "verdict": "no_image",
                        "winner": None, "collides_with": [], "matches": []})
            continue
        try:
            frame = _frame_for(engine, profile, game, cap)
        except HTTPException:
            out.append({"window": w.id, "capture": cap, "verdict": "no_image",
                        "winner": None, "collides_with": [], "matches": []})
            continue
        matches = []
        with ocr_job():   # one OCR job for the whole cross-check of this image
            for v in profile.windows:
                matched, evs = _window_match(matcher, v, frame)
                if matched or v.id == w.id:   # always include the owner so self-miss shows
                    matches.append({"window": v.id, "matched": matched,
                                    "ndet": len([d for d in v.detect if d.enabled]),
                                    "detectors": evs})
        matched_ids = [m["window"] for m in matches if m["matched"]]
        winner = max((m for m in matches if m["matched"]), key=lambda m: m["ndet"], default=None)
        winner_id = winner["window"] if winner else None
        collides = [i for i in matched_ids if i != w.id]
        if w.id not in matched_ids:
            verdict = "self_no_match"
        elif winner_id != w.id:
            verdict = "misclassified"
        elif collides:
            verdict = "collision"
        else:
            verdict = "ok"
        out.append({"window": w.id, "capture": cap, "winner": winner_id,
                    "collides_with": collides, "verdict": verdict, "matches": matches})
    return {"windows": out}


def _read_window(engine, profile, game, capture):
    """Shared read for /preview and /preview/commit: grab the frame (stashed image or live
    window), build the read-only resolver, and OCR window[0]'s regions. Returns
    (frame, window, result) — result is the ``read_preview`` dict (cells + fields)."""
    frame = _frame_for(engine, profile, game, capture)
    window = profile.windows[0]
    fields = {f.id: f for f in profile.fields_for(window)}
    # load each item's frozen cutout so the row anchor can be calibrated to where the
    # locator's text actually sits in it (keeps every field box at its authored place)
    cutouts = {}
    for it in window.items or []:
        if it.cutout:
            cp = captures_store.cutout_path(get_settings().captures_dir, game or profile.name, it.cutout)
            ci = cv2.imread(str(cp)) if cp else None
            if ci is not None:
                cutouts[it.id] = ci
    # read-only resolver: applies the game's dictionaries (exact then fuzzy) so the
    # preview shows the SAME snapped values the collector would, but never learns/mutates.
    lex = Lexicon.for_game(get_settings().data_dir, profile.name)
    pooled, dict_map = build_dictionaries(profile, engine.corrector)
    resolver = FieldResolver(lex, engine.corrector, engine.settings.tuning.accept_confidence,
                             dictionary=pooled, dictionaries=dict_map, learn_enabled=False)
    reader = RegionReader(engine.ocr, resolver, cutouts=cutouts)
    with ocr_job():   # one job: the whole window read runs without interleaving another
        result = reader.read_preview(frame, window, fields)
    return frame, window, result


def _cell_values(cell):
    """The field_id -> value dict a cell would store under (mirrors the key build)."""
    vals = {fid: f.get("value") for fid, f in cell["fields"].items()}
    if cell.get("item"):
        vals["_item"] = cell["item"]
    return vals


@router.post("/preview")
def preview(profile: GameProfile, game: str | None = Query(None), capture: str | None = Query(None)):
    """OCR the current regions. If ``game``+``capture`` are given, read that stashed
    image (the one shown in the image node); otherwise capture the live window."""
    if not profile.windows:
        raise HTTPException(status_code=400, detail="profile has no window")
    engine = get_engine()
    frame, window, result = _read_window(engine, profile, game, capture)
    # the dedup key each cell would store under — same spec the collector resolves,
    # so the teaching UI previews record identity live
    km = profile.key_map_for(window.dataset_id)
    for cell in result["cells"]:
        cell["key"] = km.build(_cell_values(cell))
    return {"client": [frame.client.w, frame.client.h],
            "device": getattr(engine.ocr, "device", "cpu"), **result}


@router.post("/preview/commit")
def preview_commit(profile: GameProfile, game: str | None = Query(None), capture: str | None = Query(None)):
    """Re-read the current regions and COMMIT the keyable cells into the window's dataset
    store — the same ledger-backed store live collection writes, as one revertable batch.
    Re-runs the read server-side (never trusts client-sent values); cells whose key is
    unresolvable (a key part unread) are skipped, never guessed."""
    if not profile.windows:
        raise HTTPException(status_code=400, detail="profile has no window")
    engine = get_engine()
    _, window, result = _read_window(engine, profile, game, capture)

    dataset = window.dataset_id
    store = DatasetStore(get_settings().data_dir, profile.name, dataset,
                         key=profile.key_map_for(dataset))
    store.begin_batch()   # this commit is one revertable batch
    written = skipped = 0
    for cell in result["cells"]:
        values = _cell_values(cell)
        if store.record_seen(values) is not None:
            written += 1
        else:
            skipped += 1
    store.save()
    return {"dataset": dataset, "written": written, "skipped": skipped,
            "cells": len(result["cells"])}


@router.post("/item/read")
def item_read(profile: GameProfile, game: str = Query(...), win: str = Query(...), item: str = Query(...)):
    """Read ONE item's frozen cutout with the current (unsaved) settings and report
    what it extracts: per-field value/confidence + per-tell pass/score + validity. This
    is the same read the collector runs on a located cell, scoped to the reference crop
    so the item node shows exactly what its boxes get out of the image."""
    window = next((w for w in profile.windows if w.id == win), None)
    if window is None:
        raise HTTPException(status_code=404, detail="window not found")
    it = next((i for i in (window.items or []) if i.id == item), None)
    if it is None:
        raise HTTPException(status_code=404, detail="item not found")
    if not it.cutout:
        raise HTTPException(status_code=400, detail="item has no cutout")
    cp = captures_store.cutout_path(get_settings().captures_dir, game, it.cutout)
    cut = cv2.imread(str(cp)) if cp else None
    if cut is None:
        raise HTTPException(status_code=404, detail="cutout not found")

    engine = get_engine()
    fields = {f.id: f for f in profile.fields_for(window)}
    lex = Lexicon.for_game(get_settings().data_dir, profile.name)
    pooled, dict_map = build_dictionaries(profile, engine.corrector)
    resolver = FieldResolver(lex, engine.corrector, engine.settings.tuning.accept_confidence,
                             dictionary=pooled, dictionaries=dict_map, learn_enabled=False)
    reader = RegionReader(engine.ocr, resolver)
    with ocr_job():
        result = reader.read_cutout(cut, window, it, fields)
    h, w = cut.shape[:2]
    # the dedup key this read would store under (None = unkeyable, e.g. a part empty)
    spec = (it.key or window.key or KeyDef()).spec()
    vals = {fid: f.get("value") for fid, f in result["fields"].items()}
    return {"cutout": [w, h], "key": spec.build(vals), "key_fields": list(spec.fields),
            "device": getattr(engine.ocr, "device", "cpu"), **result}
