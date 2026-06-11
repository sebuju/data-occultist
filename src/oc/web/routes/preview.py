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
from ...detect.anchor import AnchorMatcher, text_match_score
from ...learn.dictionary import Dictionary
from ...learn.lexicon import Lexicon
from ...learn.resolver import FieldResolver
from ...ocr.serialize import ocr_job
from ...profile import GameProfile
from ...types import Frame, PixelBox
from .. import captures_store
from ..deps import get_engine, get_locator, get_settings

router = APIRouter(prefix="/api", tags=["preview"])


def _frame_for(engine, profile, game, capture):
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


def _eval_anchor(a, frame, matcher, ocr):
    """Return {matched, read, score} for a detector/state anchor."""
    if a.template:
        score = matcher.score(a, frame)
        return {"matched": score >= a.threshold, "read": "(template)", "score": round(score, 2)}
    box = a.search.to_fraction().to_pixels(frame.client.w, frame.client.h)
    lines = ocr.read_region(frame, box)
    read = " ".join(ln.text for ln in lines).strip()
    score = text_match_score((a.text or "").lower(), read.lower(), a.included)
    return {"matched": bool(a.text) and score >= a.threshold, "read": read, "score": round(score, 2)}


@router.post("/detect")
def detect(profile: GameProfile, game: str | None = Query(None), capture: str | None = Query(None)):
    """Evaluate each window detector + state against the image: matched + what it read."""
    if not profile.windows:
        return {"anchors": {}, "states": {}}
    engine = get_engine()
    frame = _frame_for(engine, profile, game, capture)
    window = profile.windows[0]
    matcher = AnchorMatcher(engine.ocr, str(get_settings().profiles_dir))

    # one job: run the whole detect pass without interleaving with another OCR job
    with ocr_job():
        anchors = {a.id: _eval_anchor(a, frame, matcher, engine.ocr) for a in window.anchors}
        states = {}
        for s in window.states:
            evs = [_eval_anchor(a, frame, matcher, engine.ocr) for a in s.anchors]
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

    return {"anchors": anchors, "states": states, "scrollbar": scrollbar}


@router.post("/preview")
def preview(profile: GameProfile, game: str | None = Query(None), capture: str | None = Query(None)):
    """OCR the current regions. If ``game``+``capture`` are given, read that stashed
    image (the one shown in the image node); otherwise capture the live window."""
    if not profile.windows:
        raise HTTPException(status_code=400, detail="profile has no window")
    engine = get_engine()

    if game and capture:
        path = captures_store.path_for(get_settings().captures_dir, game, capture)
        if path is None:
            raise HTTPException(status_code=404, detail="capture not found")
        img = cv2.imread(str(path))
        if img is None:
            raise HTTPException(status_code=500, detail="failed to read capture")
        h, w = img.shape[:2]
        frame = Frame(image=img, client=PixelBox(0, 0, w, h))
    else:
        win = get_locator().locate(profile)
        if win is None:
            raise HTTPException(status_code=404, detail="game window not found")
        frame = engine.capture.grab_window(win)

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
    dictionary = Dictionary(profile.dictionary_terms(), engine.corrector)
    resolver = FieldResolver(lex, engine.corrector, engine.settings.tuning.accept_confidence,
                             dictionary=dictionary, learn_enabled=False)
    reader = RegionReader(engine.ocr, resolver, cutouts=cutouts)
    with ocr_job():   # one job: the whole window read runs without interleaving another
        result = reader.read_preview(frame, window, fields)
    return {"client": [frame.client.w, frame.client.h], **result}
