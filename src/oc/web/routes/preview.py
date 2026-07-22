"""Preview endpoint: OCR the current (unsaved) box layout and report what it reads.

The teaching UI POSTs the in-progress profile (one window + fields). The server
captures the live window and runs the reader over the window's regions/grid,
returning raw text + extracted value + confidence per cell — so the user can see
exactly what each box gets out of the image before saving.
"""

from __future__ import annotations

import cv2
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ...collect.commit import commit_records
from ...collect.fields import run_rules
from ...collect.atlas_match import build_atlas
from ...collect.items import item_templates
from ...collect.reader import RegionReader
from ...detect.matcher import DetectMatcher, combine_passes
from ...detect.select import WinCand, aggregate_fit, select_winner
from ...learn.dictionary import build_dictionaries
from ...learn.resolver import FieldResolver
from ...ocr.serialize import ocr_job
from ...profile import GameProfile, KeyDef, list_profiles
from ...runtime import load_live_profile
from ...store import store_for
from ...store.flow_events import publish_flow
from ...types import Frame, PixelBox
from .. import captures_store
from ..deps import get_engine, get_locator, get_ocr_cache, get_settings
from ..ocr_cache import cache_key
from ..video_source import get_video_source
from .live import session_for

router = APIRouter(prefix="/api", tags=["preview"])


def _ocr_cache_for(game, image_id, config, prefer_cache):
    """Resolve the per-game OCR cache and this read's key. Returns ``(cache, key,
    hit)`` where ``hit`` is a cached payload when ``prefer_cache`` and present, else
    None. ``cache``/``key`` are None when caching doesn't apply (no stashed image)."""
    if not (game and image_id):
        return None, None, None   # live grab -> pixels vary, never cache
    cache = get_ocr_cache(game)
    # The engine's own fingerprint joins the key: swapping OCR backend / inference
    # engine busts the cache instead of serving reads made by the previous one.
    ocr = get_engine().ocr
    key = cache_key(image_id, config, getattr(ocr, "ocr_sig", type(ocr).__name__))
    hit = cache.get(key) if prefer_cache else None
    if hit is not None:
        # A hit returns early in the caller (no put(), no save() below) — self-heal the
        # sidecar here in case it was deleted externally while this process kept serving
        # the in-memory entry (save() is a cheap no-op unless dirty or the file is gone).
        cache.save()
    return cache, key, hit


def _feed_readouts_live(engine, profile, game, capture, registers=None):
    """Full live-like readout fold for a deliberate ``test`` feed (``/api/preview?feed=1``): read
    THIS image's readouts WITH their rule trace and hand them to the game's live session, so the
    consensus/history gate, register feed, readout->register/toast data blob, and ``on_readout``
    watch triggers all fire exactly as they would live (see ``LiveSession.feed_readouts``). Feeding
    a window's stashed images one at a time thus reproduces live readout behaviour.

    This is the ONLY ``/preview`` path that touches the live session: it fires solely on an explicit
    user feed (the feed / feed all buttons and an image change, all ``feed=1``). A plain one-shot
    canvas preview (``feed`` off) never calls this and has NO live-session side effect — a mere
    refresh, boot preview, or post-live-exit readout read can't populate a register, move the
    consensus state, or fire a watch line."""
    if not game:
        return
    sess = session_for(game, create=True)
    if sess is None or not profile.windows:
        return
    frame, window, fields, reader = _window_reader(engine, profile, game, capture)
    if not window.readouts:
        return
    ro_trace: list[dict] = []
    with ocr_job(engine.ocr):   # one job: the readout read runs without interleaving another
        detailed = reader.read_readouts_detailed(frame, window, fields, trace_sink=ro_trace,
                                                 apply_gates=False)   # teaching read: show the raw value
    # pass the FRESH request profile so a process/register wired since the live session started is
    # fed + flow-animated without a live restart (mirrors the `registers=` fresh-wiring override).
    sess.feed_readouts(detailed, ro_trace, window, window.id, registers, profile)


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
def detect(profile: GameProfile, game: str | None = Query(None), capture: str | None = Query(None),
           prefer_cache: bool = Query(False)):
    """Evaluate each window detector + state against the image: matched + what it read."""
    window = profile.windows[0] if profile.windows else None
    if window is None:
        return {"detect": {}, "states": {}}
    # Cache on the stashed image + the detectors that act on it (no fields/lexicon — detect
    # is template/text matching only). A box/detector edit changes the dump → fresh read.
    cfg = {"window": window.model_dump(mode="json") if window else None}
    cache, key, hit = _ocr_cache_for(game, capture, cfg, prefer_cache)
    if hit is not None:
        return {**hit, "cached": True}
    engine = get_engine()
    frame = _frame_for(engine, profile, game, capture)
    matcher = DetectMatcher(engine.ocr, str(get_settings().profiles_dir))

    # one job: run the whole detect pass without interleaving with another OCR job
    with ocr_job(engine.ocr) as job:
        detect = {d.id: matcher.evaluate(d, frame) for d in window.detect} if window else {}
        # overall window verdict — mirrors the classifier (only ENABLED detectors count,
        # each per its polarity, combined by detect_mode), so the UI shows pass/fail.
        enabled = [detect[d.id]["passes"] for d in (window.detect if window else []) if d.enabled]
        window_pass = combine_passes(enabled, window.detect_mode) if enabled else False
        states = {}
        for s in (window.states if window else []):
            evs = [matcher.evaluate(d, frame) for d in s.detect]
            states[s.id] = {
                "matched": bool(evs) and all(e["passes"] for e in evs),
                "read": " | ".join(e["read"] for e in evs),
            }

    scrollbar = None
    sc = window.scroll if window else None
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

    result = {"detect": detect, "states": states, "scrollbar": scrollbar,
              "window": {"pass": window_pass, "mode": window.detect_mode if window else "all"},
              "device": getattr(engine.ocr, "device", "cpu"), "ms": round(job.ms)}
    if cache is not None:
        cache.put(key, result)
        cache.save()
    return result


class _ScrollPosBody(BaseModel):
    game: str = ""        # which profile's captures/<game>/scroll/ to save the cutout under
    image: str            # PNG data URL (or bare base64) of a scrollbar cutout
    orientation: str = "vertical"


@router.post("/scroll/pos")
def scroll_pos(body: _ScrollPosBody):
    """Read the thumb position (0..1 over the reachable track) from a scrollbar cutout, and
    save the cutout to disk. The teaching UI posts crops captured at known scroll offsets; each
    cutout's ``pos`` plus its rows-from-top is one calibration sample (see the scrollbar node's
    cutout tool) — the base64 is sent once here and never stored inline in the profile, only
    the returned filename is (``ScrollSample.file``)."""
    import base64

    import numpy as np

    from ...collect.scrollbar import scroll_detail
    data = body.image.split(",", 1)[-1]            # tolerate a data: URL prefix
    try:
        raw = base64.b64decode(data)
    except Exception as exc:
        raise HTTPException(400, "bad base64 image") from exc
    img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if img is None or img.size == 0:
        raise HTTPException(400, "could not decode image")
    d = scroll_detail(img, body.orientation)
    name = None
    if body.game:
        name = captures_store.save_scroll_cutout(get_settings().captures_dir, body.game, raw)
    if d is None:
        return {"pos": None, "conf": 0.0, "name": name}
    return {"pos": d["pos"], "conf": d["conf"], "thumb_px": d["thumb_px"], "thumb_len": d["thumb_len"],
            "name": name}


def _window_match(matcher, win, frame):
    """Evaluate a window's ENABLED detectors against a frame. Returns (matched, evs).
    Mirrors the classifier: each detector passes per its polarity, combined by detect_mode."""
    dets = [d for d in win.detect if d.enabled]
    evs = [{"id": d.id, **matcher.evaluate(d, frame)} for d in dets]
    matched = combine_passes([e["passes"] for e in evs], win.detect_mode) if evs else False
    return matched, evs


def _window_fit(evs, mode) -> float:
    """Aggregate 0..1 fit of a window's detector evals — the best-fit tie-break. Same rule as the
    classifier via the shared ``aggregate_fit`` (rule 7): a ``negate`` detector contributes
    ``1 - score`` (how absent its landmark is), then weakest under ``all`` / strongest under ``any``."""
    contribs = [(1.0 - e["score"]) if e.get("negate") else e["score"] for e in evs]
    return aggregate_fit(contribs, mode)


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
      misclassified — another window WINS the classify order (priority mode: a higher-priority
                      window also matches this image; best-fit mode: a higher-scoring/more-detector
                      window matches) -> the runtime classifier would pick that one, not the owner
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
        with ocr_job(engine.ocr):   # one OCR job for the whole cross-check of this image
            for v in profile.windows:
                matched, evs = _window_match(matcher, v, frame)
                if matched or v.id == w.id:   # always include the owner so self-miss shows
                    matches.append({"window": v.id, "matched": matched,
                                    "ndet": len([d for d in v.detect if d.enabled]),
                                    "score": _window_fit(evs, v.detect_mode),
                                    "detectors": evs})
        matched_ids = [m["window"] for m in matches if m["matched"]]
        # Winner via the SHARED select_winner (rule 7) so the preview can never disagree with the
        # runtime classifier: priority mode -> first passing window in priority order (true/false),
        # best-fit mode -> highest score then most detectors. (The old copy here used best-fit
        # unconditionally and falsely flagged priority-protected windows as misclassified.)
        winner_id = select_winner(profile, [WinCand(m["window"], m["matched"], m["score"], m["ndet"])
                                            for m in matches])
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


def _window_reader(engine, profile, game, capture):
    """Shared setup for /preview and /preview/commit: grab the frame (stashed image or
    live window), load item cutouts, and build the read-only resolver-backed reader.
    Returns (frame, window, fields, reader); each caller then picks ``read_preview``
    (display) or ``read`` (the gated collection path)."""
    frame = _frame_for(engine, profile, game, capture)
    window = profile.windows[0]
    fields = {f.id: f for f in profile.fields_for(window)}
    # resolver applies the game's dictionaries (exact then fuzzy) so the preview shows
    # the SAME snapped values the collector would.
    pooled, dict_map = build_dictionaries(profile, engine.corrector)
    resolver = FieldResolver(engine.corrector, engine.settings.tuning.accept_confidence,
                             dictionary=pooled, dictionaries=dict_map)
    templates = item_templates([window], captures_store.cutout_loader(
        get_settings().captures_dir, game or profile.name))
    atlas = build_atlas(profile.atlas,
                       captures_store.atlas_loader(get_settings().captures_dir, game or profile.name))
    reader = RegionReader(engine.ocr, resolver, templates, atlas)
    return frame, window, fields, reader


def _read_window(engine, profile, game, capture):
    """Shared read for /preview: returns (frame, window, result) — result is the
    ``read_preview`` dict (cells + fields)."""
    frame, window, fields, reader = _window_reader(engine, profile, game, capture)
    with ocr_job(engine.ocr) as job:   # one job: the whole window read runs without interleaving another
        result = reader.read_preview(frame, window, fields)
        # what each readout box reads off THIS image — shown on the canvas at author time
        # (the same values the live collector would surface), with their read confidence so a
        # readout node can show ``value (conf)`` even when live mode is off.
        detailed = reader.read_readouts_detailed(frame, window, fields, apply_gates=False)  # teaching read
        result["readouts"] = {k: value for k, (value, *_r) in detailed.items()}
        result["readout_confs"] = {k: conf for k, (_v, conf, *_r) in detailed.items()}
        # Full map: every enabled readout, empty/low-confidence defaulted to "" instead of
        # omitted -- mirrors TickResult.readouts_all so the register/.ro-live preview fallback
        # shows a blank slot as empty rather than missing (see live.py/register_node.js).
        result["readouts_all"] = {v.id: result["readouts"].get(v.id, "") for v in window.readouts if v.enabled}
        result["readout_confs_all"] = {v.id: result["readout_confs"].get(v.id) for v in window.readouts if v.enabled}
    result["ms"] = round(job.ms)   # real compute time (lock-wait excluded) for the log bar
    return frame, window, result


def _cell_values(cell):
    """The field_id -> value dict a cell would store under (mirrors the key build)."""
    vals = {fid: f.get("value") for fid, f in cell["fields"].items()}
    if cell.get("item"):
        vals["_item"] = cell["item"]
    return vals


@router.post("/preview")
def preview(profile: GameProfile, game: str | None = Query(None), capture: str | None = Query(None),
            prefer_cache: bool = Query(False), feed: bool = Query(False)):
    """OCR the current regions. If ``game``+``capture`` are given, read that stashed
    image (the one shown in the image node); otherwise capture the live window.

    ``feed`` (the ``test`` button) makes this read behave like a live tick for READOUTS:
    it feeds registers, runs the consensus/history gate, emits the readout->register data blob,
    and fires ``on_readout`` watch lines (see :func:`_feed_readouts_live`). Off (a plain canvas
    preview/refresh) it is a pure OCR read with NO live-session side effect — it does not populate
    registers, so a mere refresh (or a boot / post-live-exit read) can't pollute that state. Register
    population is thus gated to explicit user feeds (feed / feed all / image change) and the live
    collector tick only."""
    if not profile.windows:
        raise HTTPException(status_code=400, detail="profile has no window")
    window = profile.windows[0]
    # Cache on the stashed image + everything that shapes the read: the window boxes/grid,
    # the fields, and the resolver's accept floor.
    cfg = {"window": window.model_dump(mode="json"),
           "fields": [f.model_dump(mode="json") for f in profile.fields],
           "accept": get_settings().tuning.accept_confidence}
    cache, key, hit = _ocr_cache_for(game, capture, cfg, prefer_cache)
    if hit is not None:
        # cache serves the grid read; a feed still re-reads readouts (cheap) for the live fold.
        # feed off = pure preview, no live-session touch (no register populate on refresh/boot).
        if feed:
            _feed_readouts_live(get_engine(), profile, game, capture, profile.registers)
        return {**hit, "cached": True}
    engine = get_engine()
    frame, window, result = _read_window(engine, profile, game, capture)
    # the dedup key each cell would store under — same spec the collector resolves,
    # so the teaching UI previews record identity live. A window with no dataset
    # stores nothing, so there is no key to preview.
    if window.dataset_id is not None:
        km = profile.key_map_for(window.dataset_id)
        for cell in result["cells"]:
            cell["key"] = km.build(_cell_values(cell))
    out = {"client": [frame.client.w, frame.client.h],
           "device": getattr(engine.ocr, "device", "cpu"), **result}
    # scrollbar thumb position from this same image — drives the window canvas row-index labels
    # (the collector maps a row's index from this pos + the static cutout gain).
    sc = window.scroll
    if sc and sc.scrollbar:
        from ...collect.scrollbar import scroll_detail
        box = sc.scrollbar.to_fraction().to_pixels(frame.client.w, frame.client.h)
        crop = frame.image[box.y : box.y + box.h, box.x : box.x + box.w]
        d = scroll_detail(crop, sc.scrollbar_orientation)
        if d is not None:
            vertical = sc.scrollbar_orientation != "horizontal"
            out["scrollbar"] = {"pos": d["pos"],
                                "px": (box.y if vertical else box.x) + d["thumb_px"],
                                "conf": d["conf"]}
    if cache is not None:
        cache.put(key, out)
        cache.save()
    # Only an explicit feed touches the live session; a plain preview leaves registers alone.
    if feed:
        _feed_readouts_live(engine, profile, game, capture, profile.registers)
    return out


@router.post("/rule_trace")
def rule_trace(profile: GameProfile, game: str | None = Query(None),
               capture: str | None = Query(None)):
    """Debug EVERY field's rule pipeline in ONE window read: take a representative read of
    each field off the CURRENT canvas, run its rules over that value, and return the
    per-rule ``in -> out`` trace + final value per field. The field nodes all pull from
    this single batch (coalesced client-side) so the trace fleet costs one OCR pass, not
    one per node. Returns ``{fields: {field_id: {trace, value, dropped, raw}}}``.

    The OCR half (the representative raw+confidence per field) is cached exactly like
    ``/preview`` -- keyed on everything that shapes OCR EXCEPT each field's ``rules``
    pipeline, which is pure post-OCR value logic (see ``FieldDef``'s docstring) and costs
    microseconds. So a stashed image serves from cache (no engine touch, cache hit on
    every boot) while the rules always run fresh over the cached raw -- a rule edit
    updates the trace instantly with zero OCR, and a box/grid/image change busts the key
    and re-reads."""
    if not profile.windows:
        raise HTTPException(status_code=400, detail="profile has no window")
    window = profile.windows[0]
    # ``window.model_dump`` would embed window.fields wholesale (rules included) --
    # exclude it and hash the RESOLVED per-window field list (fields_for: window.fields,
    # falling back to the game-level profile.fields) with each field's ``rules`` stripped
    # instead, so a rule-only edit (on either a window-specific or game-level field def)
    # can never move the key.
    cfg = {"window": window.model_dump(mode="json", exclude={"fields"}),
           "fields": [{**f.model_dump(mode="json"), "rules": None} for f in profile.fields_for(window)],
           "accept": get_settings().tuning.accept_confidence}
    cache, key, hit = _ocr_cache_for(game, capture, cfg, prefer_cache=True)
    engine = get_engine()
    frame, window, fields, reader = _window_reader(engine, profile, game, capture)
    if hit is not None:
        raws = hit
    else:
        with ocr_job(engine.ocr):
            raws = reader.representative_raws(frame, window, fields)
        if cache is not None:
            cache.put(key, raws)
            cache.save()
    out = {}
    for fid, field in fields.items():
        raw, conf = raws.get(fid, ("", 0.0))
        res = run_rules(field, raw, dict_hook=reader._resolver.apply_dictionary,
                        confidence=conf, trace=True)
        out[fid] = {"trace": res.trace or [], "value": res.value,
                    "dropped": res.dropped, "raw": raw}
    return {"fields": out}


@router.post("/preview/commit")
def preview_commit(profile: GameProfile, game: str | None = Query(None), capture: str | None = Query(None)):
    """Re-read the current regions and COMMIT into the window's dataset store — the same
    ledger-backed store live collection writes, as one revertable batch.

    Runs the SAME gates as live collection so a manual commit can't inject data the
    collector would have rejected: ``reader.read`` already drops cells that fail tells /
    out-of-range / a field's own ``min_confidence``, then the global ``min_confidence``
    floor drops any record whose worst field is too weak. The only collection gate not
    applied is the confirmer (temporal stability), which is inherently multi-frame — a
    one-shot manual commit has a single frame to confirm against. Re-runs the read
    server-side (never trusts client-sent values); records whose key is unresolvable (a
    key part unread) are skipped, never guessed."""
    if not profile.windows:
        raise HTTPException(status_code=400, detail="profile has no window")
    engine = get_engine()
    frame, window, fields, reader = _window_reader(engine, profile, game, capture)
    with ocr_job(engine.ocr) as job:
        records, _sentinel, _pruned = reader.read(frame, window, fields)
    floor = engine.settings.tuning.min_confidence
    gated = [r for r in records if r.confidence >= floor]   # worst-field floor, as in collection
    low_conf = len(records) - len(gated)

    dataset = window.dataset_id
    if dataset is None:
        # no dataset -> nowhere to commit; don't mint a store on disk
        return {"dataset": None, "written": 0, "skipped": len(gated) + low_conf,
                "low_conf": low_conf, "cells": len(records), "ms": round(job.ms)}
    store = store_for(get_settings().data_dir, profile.name, dataset, profile=profile)
    store.begin_batch()   # this commit is one revertable batch
    written, no_key, _changed = commit_records(store, gated)   # the SAME write path collection uses
    store.save()
    if written:
        # Source-aware data hop: this commit came from THIS window, so animate only its edge.
        publish_flow(profile.name, "data", f"win:{window.id}", f"ds:{dataset}", written)
    # ``skipped`` = everything read but not written (below floor + unkeyable); ``low_conf``
    # breaks out the floor drops so the status can say why.
    return {"dataset": dataset, "written": written, "skipped": low_conf + no_key,
            "low_conf": low_conf, "cells": len(records), "ms": round(job.ms)}


@router.post("/item/read")
def item_read(profile: GameProfile, game: str = Query(...), win: str = Query(...), item: str = Query(...),
              prefer_cache: bool = Query(False)):
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
    # Cache on the immutable cutout image + the window/fields/dictionary that drive the read.
    cfg = {"window": window.model_dump(mode="json"),
           "fields": [f.model_dump(mode="json") for f in profile.fields],
           "accept": get_settings().tuning.accept_confidence}
    cache, key, hit = _ocr_cache_for(game, f"{it.cutout}\x00{item}", cfg, prefer_cache)
    if hit is not None:
        return {**hit, "cached": True}
    cp = captures_store.cutout_path(get_settings().captures_dir, game, it.cutout)
    cut = cv2.imread(str(cp)) if cp else None
    if cut is None:
        raise HTTPException(status_code=404, detail="cutout not found")

    engine = get_engine()
    fields = {f.id: f for f in profile.fields_for(window)}
    pooled, dict_map = build_dictionaries(profile, engine.corrector)
    resolver = FieldResolver(engine.corrector, engine.settings.tuning.accept_confidence,
                             dictionary=pooled, dictionaries=dict_map)
    templates = item_templates([window], lambda _name: cut)   # the cutout IS this item's reference
    atlas = build_atlas(profile.atlas,
                       captures_store.atlas_loader(get_settings().captures_dir, profile.name))
    reader = RegionReader(engine.ocr, resolver, templates, atlas)
    with ocr_job(engine.ocr) as job:
        result = reader.read_cutout(cut, window, it, fields)
    h, w = cut.shape[:2]
    # the dedup key this read would store under (None = unkeyable, e.g. a part empty)
    spec = (it.key or window.key or KeyDef()).spec()
    vals = {fid: f.get("value") for fid, f in result["fields"].items()}
    out = {"cutout": [w, h], "key": spec.build(vals), "key_fields": list(spec.fields),
           "device": getattr(engine.ocr, "device", "cpu"), "ms": round(job.ms), **result}
    if cache is not None:
        cache.put(key, out)
        cache.save()
    return out
