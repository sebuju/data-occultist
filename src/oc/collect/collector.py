"""Tie the pipeline together: detect -> capture -> classify -> read -> confirm -> sink.

Robustness layers, in order, each able to reject a frame or record:
  * window not present / not foreground / unrecognised -> skip (occluded window)
  * state not save-worthy -> skip ("wrong order")
  * record below the confidence floor -> drop (partial occlusion / garbage OCR)
  * record not yet stable across frames -> hold (transient popups / flicker)
Only records that clear every layer are written, and the per-game dictionary
learned along the way is flushed on shutdown.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from statistics import median

from ..engine import Engine
from ..learn.confusions import ConfusionMap
from ..learn.dictionary import build_dictionaries
from ..learn.lexicon import Lexicon
from ..learn.resolver import FieldResolver
from ..locate import WindowLocator
from ..profile.models import GameProfile, WindowDef
from ..store import DatasetStore, KeyMap, store_for
from ..store.flow_events import publish_flow
from . import settle
from .items import item_templates
from .commit import commit_records
from .reader import Record, RegionReader
from .scrollbar import scroll_detail
from .sink import RecordSink
from .slice_sync import SliceSync
from .stability import Confirmer


# Minimum scrollbar-detection confidence before a frame's slice counts for mirror removal —
# a faint/ambiguous thumb yields no slice, so a misread can never drive a false removal.
_SCROLL_CONF_FLOOR = 0.35


def _detect_search_fracs(profile: GameProfile) -> list:
    """Every window/state detector's search region (as fractions). The window+state a
    frame classifies to depends ONLY on these regions, so hashing them lets the live
    loop skip re-classifying an unchanged screen (precapture caches the same way)."""
    out = []
    for w in profile.windows:
        for d in w.detect:
            if d.enabled:
                out.append(d.search.to_fraction())
        for s in w.states:
            for d in s.detect:
                if d.enabled:
                    out.append(d.search.to_fraction())
    return out


class TickStatus(str, Enum):
    no_window = "no_window"
    not_foreground = "not_foreground"
    moving = "moving"                      # screen still animating/scrolling — wait for it to settle
    unrecognised = "unrecognised"          # no profile window matched
    state_invalid = "state_invalid"        # window matched but state not save-worthy
    saved = "saved"                        # frame processed (new may be 0)


@dataclass
class TickResult:
    status: TickStatus
    window_id: str | None = None
    state_id: str | None = None
    read: int = 0       # records read this frame
    kept: int = 0       # passed the confidence floor
    new: int = 0        # newly confirmed + written
    total: int = 0      # distinct records confirmed so far
    dataset: str | None = None              # the dataset records were written to
    changed: list[dict] = field(default_factory=list)  # values added/updated this tick (for triggers)
    scroll: tuple[float, float] | None = None  # mirror datasets: visible row-index span (vlo,vhi)
    scroll_meta: dict | None = None            # mirror: {total, viewport, gain, confident, pinned}


class Collector:
    def __init__(
        self,
        engine: Engine,
        profile: GameProfile,
        sink: RecordSink | None = None,
    ) -> None:
        self._engine = engine
        self._profile = profile
        self._tuning = engine.settings.tuning
        self._locator = WindowLocator(engine)

        self._lexicon = Lexicon.for_game(engine.settings.data_dir, profile.name)
        self._confusions = ConfusionMap.for_game(engine.settings.data_dir, profile.name)
        pooled, dict_map = build_dictionaries(profile, engine.corrector)
        resolver = FieldResolver(self._lexicon, engine.corrector, self._tuning.accept_confidence,
                                 confusions=self._confusions, dictionary=pooled, dictionaries=dict_map)
        from ..web import captures_store
        templates = item_templates(profile.windows,
                                   captures_store.cutout_loader(engine.settings.captures_dir, profile.name))
        self._reader = RegionReader(engine.ocr, resolver, templates)

        # Confirmers, stores, and observed-key sets are keyed by DATASET, not
        # window, so windows that share a dataset dedup against each other and
        # write to one history-backed store.
        self._explicit_sink = sink
        self._confirmers: dict[str, Confirmer] = {}
        self._stores: dict[str, DatasetStore] = {}
        self._key_maps: dict[str, KeyMap] = {}
        self._observed: dict[str, set[str]] = {}
        # Per-dataset visible-slice sync (``sync_mode: mirror``): tracks each key's last-seen
        # scroll position + absence so a key gone from its slice is removed (see tick()).
        self._slice_sync: dict[str, SliceSync] = {}
        self._scroll_vis: dict[str, float] = {}   # mirror: rows-on-screen measured from row pitch
        # Per-detection batching (``batch_mode: detection`` datasets, e.g. relic offerings):
        # a fresh window detection after a gap starts a NEW revertable batch. ``_tick_no``
        # counts EVERY tick (incl. no-window/unrecognised), so the gap since a dataset was
        # last fed is just a subtraction — no per-tick presence bookkeeping on every return
        # path. ``_pending_batch`` defers ``begin_batch`` to the first actual write, so an
        # empty detection (no confirmed rows) never spawns an empty batch.
        self._tick_no = 0
        self._last_seen_tick: dict[str, int] = {}
        self._pending_batch: set[str] = set()
        # Per-window cache of (region signature, last read records) so an unchanged
        # view re-feeds the confirmer without paying for OCR again.
        self._frame_cache: dict[str, tuple[int, list[Record]]] = {}
        # Detector-region signature -> last classification, so an unchanged screen skips
        # the classify pass (which runs an OCR read per text detector across every
        # window). Single slot: ticks see one screen at a time.
        self._detect_fracs = _detect_search_fracs(profile)
        self._classify_cache: tuple[int | None, tuple[str, str | None] | None] = (None, None)
        # Last grab's settle thumbnail. A frame is OCR'd only once it matches its
        # predecessor within the noise floor (screen has stopped moving) — a mid-scroll
        # grab is blurred and reads as garbage. Single slot: ticks see one screen at a time.
        self._settle_thumb = None
        # optional hook fired with a captured frame ONLY on a tick that wrote a record (so live
        # mode saves an image just when collection produced something, not on every recognised
        # grab) — lets a caller persist what was grabbed without the collector knowing how to store.
        self.on_frame = None

    # ---- save-gating -------------------------------------------------------

    def _state_allows_save(self, window: WindowDef, state_id: str | None) -> bool:
        if not window.states:
            return True  # no declared states => nothing to gate on
        if state_id is None:
            return False  # window has states but we couldn't identify one
        state = next((s for s in window.states if s.id == state_id), None)
        return bool(state and state.valid_for_save)

    def _key_map(self, dataset: str) -> KeyMap:
        """The dataset's resolved key (taught on the item templates/windows that read
        it). Cached; warns once when windows feeding the dataset disagree."""
        if dataset not in self._key_maps:
            if self._profile.key_conflict(dataset):
                logging.getLogger(__name__).warning(
                    "dataset %r: windows disagree on the record key; using the first", dataset)
            self._key_maps[dataset] = self._profile.key_map_for(dataset)
        return self._key_maps[dataset]

    def _confirmer_for(self, window: WindowDef) -> Confirmer:
        dataset = window.dataset_id
        if dataset not in self._confirmers:
            self._confirmers[dataset] = Confirmer(self._key_map(dataset).build, self._tuning.confirm_frames)
        return self._confirmers[dataset]

    def _store_for(self, window: WindowDef) -> DatasetStore:
        dataset = window.dataset_id
        if dataset not in self._stores:
            store = self._stores[dataset] = store_for(
                self._engine.settings.data_dir,
                self._profile.name,
                dataset,
                profile=self._profile,           # resolves the aggregate
                key=self._key_map(dataset),      # conflict-checked map wins over the profile's
            )
            if not self._profile.batch_per_detection(dataset):
                store.begin_batch()   # one collection run = one revertable batch (CLI collect + live)
            # detection-mode datasets begin a batch per detection edge instead (see tick())
            self._observed.setdefault(dataset, set())
        return self._stores[dataset]

    def _above_floor(self, records: list[Record]) -> list[Record]:
        floor = self._tuning.min_confidence
        return [r for r in records if r.confidence >= floor]

    def _detect_signature(self, frame) -> int | None:
        """Cheap downsampled hash of the detector search regions. Identical regions ->
        identical classification, so the classify pass can be skipped."""
        img = frame.image
        if img is None or img.size == 0 or not self._detect_fracs:
            return None
        cw, ch = frame.client.w, frame.client.h
        h = 0
        for fb in self._detect_fracs:
            pb = fb.to_pixels(cw, ch)
            crop = img[pb.y : pb.y + pb.h, pb.x : pb.x + pb.w]
            if crop.size:
                sy = max(1, crop.shape[0] // 16)
                sx = max(1, crop.shape[1] // 16)
                h ^= hash(crop[::sy, ::sx].tobytes())
        return h

    def _classify(self, frame):
        """Classify, reusing the last result while the detector regions are unchanged."""
        sig = self._detect_signature(frame)
        csig, cres = self._classify_cache
        if sig is not None and sig == csig:
            return cres
        match = self._engine.classifier.classify(frame, self._profile)
        self._classify_cache = (sig, match)
        return match

    def _thumb_pos(self, frame, window: WindowDef) -> float | None:
        """The scrollbar thumb position ``p`` (0..1 over the reachable track) for this frame, or
        ``None`` if it can't be read confidently. A window with no scrollbar shows its whole list
        at once -> ``0.0``."""
        sc = window.scroll
        if not (sc and sc.enabled and sc.scrollbar):
            return 0.0
        img = frame.image
        if img is None or img.size == 0:
            return None
        h, w = img.shape[0], img.shape[1]
        box = sc.scrollbar.to_fraction().to_pixels(w, h)
        crop = img[box.y : box.y + box.h, box.x : box.x + box.w]
        if crop.size == 0:
            return None
        d = scroll_detail(crop, sc.scrollbar_orientation)
        if d is None or d["conf"] < _SCROLL_CONF_FLOOR:
            return None
        return d["pos"]

    # ---- pipeline ----------------------------------------------------------

    def tick(self) -> TickResult:
        from ..store import stats_store
        t0 = time.perf_counter()
        self._tick_no += 1   # counts EVERY tick, so the gap since a dataset was last fed is a subtraction
        eng = self._engine
        win = self._locator.locate(self._profile)
        if win is None:
            return TickResult(TickStatus.no_window)
        if self._tuning.require_foreground and not eng.window.is_foreground(win):
            return TickResult(TickStatus.not_foreground)

        frame = eng.capture.grab_window(win)
        # Settle gate: only OCR a frame that has STOPPED moving. A grab taken mid-scroll
        # or mid-animation is blurred/half-drawn and reads as garbage; require this grab
        # to match the previous one within the noise floor (precapture gates the same way).
        # A transition never matches its predecessor, so every moving frame is skipped and
        # only the steady state passes. An empty/black frame (minimized) yields no thumb and
        # falls through to classify, which rejects it as unrecognised.
        # but proceed on the FIRST grab (no predecessor to compare) so a single-shot
        # ``collect --once`` still reads; any stray blurred frame that slips through is
        # caught by the confirmer, which needs the SAME read twice before it saves.
        th = settle.thumb(frame.image, crop_px=settle.CROP_PX)
        if th is not None:
            prev, self._settle_thumb = self._settle_thumb, th
            if prev is not None and not settle.is_settled(th, prev):
                return TickResult(TickStatus.moving)
        match = self._classify(frame)
        if match is None:
            return TickResult(TickStatus.unrecognised)

        window_id, state_id = match
        window = self._profile.window(window_id)
        if window is None:
            return TickResult(TickStatus.unrecognised, window_id=window_id)
        if not self._state_allows_save(window, state_id):
            return TickResult(TickStatus.state_invalid, window_id=window_id, state_id=state_id)

        # Skip OCR when the grid region is pixel-identical to the last tick.
        sig = self._reader.region_signature(frame, window)
        cached = self._frame_cache.get(window_id)
        cache_hit = sig is not None and cached is not None and cached[0] == sig
        if cache_hit:
            records = cached[1]
        else:
            fields = {f.id: f for f in self._profile.fields_for(window)}
            # Time OCR read specifically (only the frames where it actually ran — a
            # cache-hit frame does no OCR, so recording it would understate the real cost).
            _oc = time.perf_counter()
            records = self._reader.read(frame, window, fields)
            stats_store.record_timing(self._profile.name, f"win:{window_id}", "oc",
                                      (time.perf_counter() - _oc) * 1000.0, n=len(records))
            if sig is not None:
                self._frame_cache[window_id] = (sig, records)

        kept = self._above_floor(records)               # occlusion / garbage gate

        dataset = window.dataset_id
        # A window with no dataset produces nothing storable — discard its reads
        # (no confirmer, no store, no disk file). An explicit sink overrides this.
        if self._explicit_sink is None and dataset is None:
            stats_store.record_timing(self._profile.name, f"win:{window_id}", "tk",
                                      (time.perf_counter() - t0) * 1000.0, n=len(records))
            return TickResult(
                TickStatus.saved,
                window_id=window_id,
                state_id=state_id,
                read=len(records),
                kept=len(kept),
                new=0,
                total=0,
                dataset=None,
                changed=[],
            )

        # Per-detection batching: when this dataset hasn't been fed within the grace window
        # (confirm_frames), the relic screen is freshly open — a NEW offering. Mark a new
        # batch (materialised on the first write below) and drop the confirmer so the new
        # offering's rows re-confirm and land in it rather than being suppressed as
        # already-seen from the previous offering.
        if self._explicit_sink is None and self._profile.batch_per_detection(dataset):
            grace = max(1, self._tuning.confirm_frames)
            last = self._last_seen_tick.get(dataset)
            if last is None or (self._tick_no - last) > grace:
                self._pending_batch.add(dataset)
                self._confirmers.pop(dataset, None)   # forget the prior offering's confirmations
            self._last_seen_tick[dataset] = self._tick_no

        confirmer = self._confirmer_for(window)         # shared per dataset
        confirmed = confirmer.observe(kept)             # temporal stability gate

        new = 0
        changed: list[dict] = []
        tick_scroll: tuple[float, float] | None = None   # mirror datasets: current visible slice
        tick_scroll_meta: dict | None = None              # mirror: calibration snapshot for the UI
        if self._explicit_sink is not None:
            for rec in confirmed:
                self._explicit_sink.write(rec)
                new += 1
        else:
            store = self._store_for(window)
            if confirmed and dataset in self._pending_batch:
                store.begin_batch()   # this detection's offering = its own revertable batch
                self._pending_batch.discard(dataset)
            observed = self._observed[dataset]
            for rec in confirmed:                       # legacy detect_removals close-path key set
                key = store.key_of(rec.values)
                if key is not None:
                    observed.add(key)
            new, _skipped, batch_changed = commit_records(store, confirmed)   # the ONE write path
            changed.extend(batch_changed)               # added/updated -> triggers may price it
            if new:
                # Source-aware data hop for the graph blob animation: announce that THIS window
                # (not every window sharing the dataset) fed it, so only its edge lights up.
                publish_flow(self._profile.name, "data", f"win:{window_id}",
                             f"ds:{dataset}", new)

            # Mirror sync: keep the dataset == the live screen. The current frame shows a
            # visible scroll slice; a stored key whose last-seen position is in that slice but
            # which is no longer read has gone -> remove (soft). A partial/occluded frame
            # (kept < read) is not clean and contributes no removal evidence.
            if self._profile.sync_mode_for(dataset) == "mirror":
                p = self._thumb_pos(frame, window)
                if p is not None:
                    clean = bool(records) and len(kept) == len(records)
                    fresh = clean or cache_hit          # this frame contributes evidence
                    sc = window.scroll
                    # STATIC scroll gain authored from cutouts (no live learning) = scrollable
                    # rows per full thumb travel. rows-on-screen is MEASURED from this frame's row
                    # spacing (a continuous list has no fixed pages) and carried between frames.
                    gain = float(sc.calib_gain) if (sc and sc.calib_gain is not None) else 0.0
                    ys = sorted({round(r.ypos, 4) for r in kept if r.ypos is not None})
                    pitch = median([b - a for a, b in zip(ys, ys[1:]) if b - a > 1e-3]) if len(ys) > 1 else None
                    if pitch:
                        self._scroll_vis[dataset] = 1.0 / pitch     # rows visible on screen
                    visible = self._scroll_vis.get(dataset) or float(max(1, (sc.rows if sc else 1)))
                    # row INDEX (integer, like the canvas #N) = floor(viewport top + row's spot).
                    # Floor the viewport-top too so a floored row index never falls just under vlo.
                    offset = p * gain
                    vlo, vhi = float(int(offset)), offset + visible
                    tick_scroll = (vlo, vhi)
                    tick_scroll_meta = {
                        "total": round(gain + visible, 1),
                        "visible": round(visible, 1),
                        "gain": round(gain, 1),
                        "calibrated": sc is not None and sc.calib_gain is not None,
                    }

                    read_cells: dict[str, tuple[float, float]] = {}
                    for r in kept:
                        k = store.key_of(r.values)
                        if k is None:
                            continue
                        yp = r.ypos if r.ypos is not None else 0.0
                        xp = r.xpos if r.xpos is not None else 0.0
                        read_cells[k] = (xp, float(int(offset + yp * visible)))   # integer row index

                    syncer = self._slice_sync.get(dataset)
                    if syncer is None:
                        # carry forward last run's positions so the table shows them immediately.
                        syncer = self._slice_sync[dataset] = SliceSync(self._tuning.confirm_frames)
                        syncer.seed(store.positions())
                    gone = syncer.observe(vlo, vhi, read_cells, store.present_keys(), fresh)
                    if gone:
                        store.remove_keys(gone)
                    if fresh and read_cells:
                        # _pos column + next run: the same (column, row-index) slots slice_sync
                        # just used — column persisted so a gone relic stays a removal candidate.
                        store.set_positions(read_cells)

        # Persist the frame image only when this tick actually WROTE a record (live mode
        # saves the grab) — a recognised-but-nothing-new frame produces no screenshot.
        if new and self.on_frame is not None:
            self.on_frame(frame)

        stats_store.record_timing(self._profile.name, f"win:{window_id}", "tk",
                                  (time.perf_counter() - t0) * 1000.0, n=len(records))
        return TickResult(
            TickStatus.saved,
            window_id=window_id,
            state_id=state_id,
            read=len(records),
            kept=len(kept),
            new=new,
            total=confirmer.count,
            dataset=dataset,
            changed=changed,
            scroll=tick_scroll,
            scroll_meta=tick_scroll_meta,
        )

    def _build_triggers(self):
        """A :class:`TriggerRunner` when the profile declares any trigger, else None.
        Imported lazily so a collector with no triggers pays nothing for the price stack."""
        if not self._profile.triggers:
            return None
        from .triggers import TriggerRunner
        return TriggerRunner(self._profile, self._engine.settings.data_dir)

    def run(self, interval: float | None = None, on_tick=None, should_stop=None) -> None:
        """Loop ticks until interrupted. ``on_tick(TickResult)`` is called each pass.

        ``interval`` — seconds slept between ticks (the throttle). ``None`` falls back to
        ``tuning.collect_interval`` so the loop rate is a setting, not a hard-coded 1.0.

        ``should_stop`` — optional predicate checked before every tick AND in place of the
        plain ``sleep``, so a worker thread can end the loop promptly (the CLI relies on
        ``KeyboardInterrupt`` instead). Either way ``close()`` flushes on the way out.

        After each tick, triggers are evaluated: ``on_change`` triggers fire for records
        this tick added/updated (pricing only those keys), and ``interval`` triggers fire
        when due. Sweeps run in their own background threads, so capture never blocks."""
        if interval is None:
            interval = self._tuning.collect_interval
        triggers = self._build_triggers()
        try:
            while not (should_stop and should_stop()):
                result = self.tick()
                if on_tick:
                    on_tick(result)
                # on_change now fires via the dataset change bus (oc.store.changes) — any write,
                # wherever it comes from, announces itself and the registered firer prices it.
                # The collector only needs to drive the periodic (interval) triggers here.
                if triggers is not None:
                    triggers.tick()
                # interruptible wait: poll should_stop so cancel doesn't wait out the interval
                if should_stop is not None:
                    slept = 0.0
                    while slept < interval and not should_stop():
                        time.sleep(min(0.1, interval - slept))
                        slept += 0.1
                else:
                    time.sleep(interval)
        except KeyboardInterrupt:
            pass
        finally:
            self.close()

    def close(self) -> None:
        self._lexicon.save()
        self._confusions.save()
        # Stop any backend that owns a live thread (e.g. WGC runs a free-threaded native
        # capture thread). Left running, it touches Python during interpreter finalization
        # -> "Fatal Python error: ... import state already initialized" on exit. Best-effort.
        cap_close = getattr(self._engine.capture, "close", None)
        if callable(cap_close):
            try:
                cap_close()
            except Exception:
                pass
        if self._explicit_sink is not None:
            self._explicit_sink.close()
        # Optionally log removals: keys in a store but not seen this run. Only when
        # explicitly enabled, since it assumes the run saw the whole dataset.
        if self._tuning.detect_removals:
            for dataset, store in self._stores.items():
                store.reconcile(self._observed.get(dataset, set()))
        for store in self._stores.values():
            store.save()
