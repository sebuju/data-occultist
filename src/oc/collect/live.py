"""Live collection: run the real collector pipeline in a background thread.

The web UI's live mode used to be read-only (detect + OCR preview for tuning). This
makes it actually COLLECT — capture -> classify -> valid_for_save -> read -> confirm
(``tuning.confirm_frames``) -> dedup -> ``DatasetStore`` -> triggers — the exact same
:class:`Collector` the CLI ``collect`` command drives. So data flows into datasets live
(the only way to capture reward-only datasets like ``relics_offered``, which then feed
their downstream views/triggers).

One :class:`LiveSession` per game, cached for the server's life. Thread-safe; status is
polled through the activity heartbeat. The worker runs even when the game is backgrounded
(PrintWindow capture), so collection doesn't need the window focused.
"""

from __future__ import annotations

import collections
import statistics
import threading
import time
from datetime import datetime

from ..engine import Engine
from ..ocr.device_switch import enter_device, exit_device
from ..profile.models import GameProfile
from ..store import store_for
from ..store.flow_events import publish_flow
from . import process_history, readout_history, register_history
from .collector import Collector, TickStatus
from .fields import run_rule_pipeline
from .readout_stability import gate_readouts

# How many recent debug entries the live session keeps for the panel's debug log. Bounded so a
# long-running collector can't grow memory without limit; the UI polls incrementally by seq.
_DEBUG_CAP = 300

# MAD multiplier for the "stable" aggregate: a ring value deviating more than k*MAD from the ring's
# median counts as an outlier and is skipped. k=3 is the usual robust-outlier cutoff (raw MAD, no
# 1.4826 scaling). Fixed by design — the mode is parameterless (no per-register threshold field).
_STABLE_K = 3.0

# The live session per game, keyed by profile name — the ONE holder of a game's register held maps
# (server memory). A LiveSession registers itself here on construction so any firing path can reach
# the held map to run an action-on-register op WITHOUT a web-layer import: the manual "fire now"
# route, a trigger auto-fire during live collection, and the background trigger scheduler all live
# in the same process and share this registry. CLI `collect` never constructs a LiveSession, so
# `active_session` returns None there and register ops are a graceful no-op (the map only exists
# live). Mirrors the web layer's own `_sessions` dict (which reuses one instance per game).
_ACTIVE_SESSIONS: dict[str, "LiveSession"] = {}


def active_session(game: str) -> "LiveSession | None":
    """The live session currently holding ``game``'s register maps, or None (no live session)."""
    return _ACTIVE_SESSIONS.get(game)


class LiveSession:
    """A toggleable live-collection worker for one game. All public methods are thread-safe."""

    def __init__(self, engine: Engine, profile: GameProfile) -> None:
        self._engine = engine
        self._profile = profile
        _ACTIVE_SESSIONS[profile.name] = self   # discoverable for action-on-register (see above)
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._interval = 1.0
        # rolling status (read by status(); written by the worker thread under the lock)
        self._recog: dict[str, int] = {}   # "window/state" frame tally ("" = miss/unrecognised)
        self._written = 0                  # records added/updated this run
        self._frames = 0                   # ticks processed
        self._cur: tuple[str | None, str | None] = (None, None)
        self._phase = False                # was the latest tick reading/holding a recognised window?
        self._last_status = "no_window"    # raw TickStatus of the latest tick (why we're not reading)
        self._scroll: tuple[float, float] | None = None   # latest mirror visible row-index span
        self._scroll_meta: dict | None = None             # latest mirror calibration snapshot
        self._readouts: dict[str, object] = {}           # latest live readout values (ephemeral, GATED)
        self._readout_confs: dict[str, float] = {}       # confidence per readout value (UI display only)
        # Full readout map: every enabled readout of a classified window, empty/low-confidence
        # defaulted to "" instead of omitted (see TickResult.readouts_all). Feeds registers +
        # .ro-live so a blank slot shows/holds empty rather than nothing or a stale prior value.
        # `_readouts`/`_readout_confs` above stay gated -- triggers/toasts must never see this.
        self._readouts_all: dict[str, object] = {}
        self._readout_confs_all: dict[str, float] = {}
        # Register-node maps: {register_id: {readout_id: {value, conf, first_seen, last_seen}}}. Held
        # in server memory only (never persisted). Fed from readouts each tick; deliberately NOT
        # reset by start() — a register accumulates across runs and is wiped only by clear_register.
        self._registers: dict[str, dict[str, dict]] = {}
        # Process-node output maps: {process_id: {key: value}}. Recomputed FRESH each tick from the
        # node's resolved inputs (a process is a pure key-preserved rules transform, no accumulation
        # unlike a register); held in server memory only. Downstream registers/processes read this.
        self._process_values: dict[str, dict[str, object]] = {}
        # DatasetStore per persisted register (RegisterDef.persist), opened lazily on first
        # flush and kept open for the session's life — see ``_flush_register``.
        self._persist_stores: dict[str, object] = {}
        self._t0 = 0.0
        self._error: str | None = None
        # Debug log ring: recent OCR-heavy ticks (raw reads, corrections, what was written to
        # which dataset). Bounded; the panel polls incrementally by monotonic seq. Only ticks
        # that actually read or wrote are recorded, so an idle/gate-closed run stays quiet.
        self._debug: collections.deque = collections.deque(maxlen=_DEBUG_CAP)
        self._debug_seq = 0
        self._dbg_prev_readouts: dict[str, object] = {}   # last-LOGGED readout values (change gate)
        # ONE TriggerRunner shared by the live loop (Collector.run) and the teach-UI test feed
        # (feed_readouts), so their on_readout edge state is identical (rule 7). Built lazily by
        # _trigger_runner; _triggers_for pins the profile it was built from so a swap rebuilds it.
        self._triggers = None
        self._triggers_for: GameProfile | None = None
        # "auto" device policy: set to "gpu" by the web layer to run the live loop on GPU
        # (every frame OCRs many regions -> GPU throughput wins), then restore the baseline
        # device on stop (which frees the GPU). None = use whatever device the engine is on.
        self.batch_device: str | None = None
        # "capture recognised windows" toggle (live panel): when set, the collector saves every
        # OCR-due grab whose frame matched a window to the live/ bucket, not only the write frames.
        # Read into the collector on start().
        self._save_recognized = False
        # Filename of the frame the CURRENT tick saved to the live/ bucket (set by _save_frame,
        # consumed + cleared by the next _on_tick). Surfaced in the debug log only in
        # capture-recognised mode so the OCR log names the image each grab was written to.
        self._last_saved_frame: str | None = None

    # ---- profile -----------------------------------------------------------

    def update_profile(self, profile: GameProfile) -> None:
        """Swap in a freshly-loaded profile — never mid-run (the collector reads it every
        tick). A no-op while collecting; the next start picks it up."""
        with self._lock:
            if self.is_running():
                return
            self._profile = profile

    # ---- control -----------------------------------------------------------

    def is_running(self) -> bool:
        t = self._thread
        return bool(t is not None and t.is_alive())

    def start(self, interval: float | None = None, save_recognized: bool = False) -> None:
        if self.is_running():
            return
        if interval is None:
            interval = self._engine.settings.tuning.collect_interval
        self._join_prev()
        with self._lock:
            self._interval = max(0.0, float(interval))
            self._save_recognized = bool(save_recognized)
            self._recog = {}
            self._written = 0
            self._frames = 0
            self._cur = (None, None)
            self._phase = False
            self._last_status = "no_window"
            self._scroll = None
            self._scroll_meta = None
            self._readouts = {}
            self._readout_confs = {}
            self._readouts_all = {}
            self._readout_confs_all = {}
            self._process_values = {}
            self._error = None
            self._last_saved_frame = None
            self._debug.clear()
            self._debug_seq = 0
            self._t0 = time.monotonic()
            self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> bool:
        """Stop the worker and wait for it to flush + exit. Returns True if it died."""
        self._stop.set()
        t = self._thread
        if t is not None and t.is_alive():
            t.join(timeout)
        return not self.is_running()

    def _join_prev(self) -> None:
        t = self._thread
        if t is not None and t.is_alive():
            self._stop.set()
            t.join(timeout=5.0)
        self._thread = None

    # ---- worker ------------------------------------------------------------

    def _loop(self) -> None:
        restore = enter_device(self._engine, self.batch_device)
        try:
            collector = Collector(self._engine, self._profile)
            collector.on_frame = self._save_frame   # persist a frame only when a record was written
            collector.save_recognized_frames = self._save_recognized   # ...or on every recognised grab (panel toggle)
            # Collector.run owns the trigger loop + flushes via close() on the way out. Pass the
            # session's SHARED runner so a concurrent test feed sees the same on_readout edge state.
            collector.run(self._interval, on_tick=self._on_tick, should_stop=self._stop.is_set,
                          triggers=self._trigger_runner())
        except Exception as exc:  # pragma: no cover - defensive
            with self._lock:
                self._error = str(exc)
        finally:
            exit_device(self._engine, restore)

    def _save_frame(self, frame) -> None:
        """Save one frame into the game's live/ image bucket — the same bucket the read-only
        tuning loop writes to. Called on a tick that WROTE a record (bucket fills with frames that
        produced data), or on every recognised grab when the "capture recognised windows" toggle
        is on. Best-effort: an encode/disk hiccup must never disturb collection."""
        try:
            import cv2

            from ..web import captures_store
            ok, buf = cv2.imencode(".jpg", frame.image, [cv2.IMWRITE_JPEG_QUALITY, 90])
            if ok:
                name = captures_store.save(self._engine.settings.captures_dir, self._profile.name,
                                           buf.tobytes(), sub=captures_store.LIVE)
                # remember the file this tick wrote so _on_tick can name it in the debug log
                # (capture-recognised mode only). Same worker thread as _on_tick -> no lock needed.
                self._last_saved_frame = name
        except Exception:  # pragma: no cover - defensive
            pass

    def _on_tick(self, result) -> None:
        reg_events: list[dict] = []
        reg_snapshot: dict = {}
        with self._lock:
            self._frames += 1
            self._written += result.new
            if result.readouts:
                self._readouts.update(result.readouts)   # GATED values -- toasts/triggers (never garbage)
                self._readout_confs.update(result.readout_confs or {})
                self._emit_readout_flow(getattr(result, "window_id", None), result.readouts)
            if result.readouts_all:
                self._readouts_all.update(result.readouts_all)   # FULL map incl. "" -- registers + .ro-live
                self._readout_confs_all.update(result.readout_confs_all or {})
                # feed from the full accumulated map (every readout seen all session), not just this
                # tick's delta -- a register wired to a readout from a window that isn't the one just
                # read would otherwise wait for that window to be revisited before showing anything.
                self._feed_processes()   # BEFORE registers -> a readout->process->register chain lands this tick
                reg_events = self._feed_registers(self._readouts_all, self._readout_confs_all)
                self._emit_register_process_flow()   # IN blobs: register-slot -> process (every held slot)
                if reg_events:
                    reg_snapshot = self._register_snapshot()
            self._last_status = result.status.value   # why we are / aren't reading right now
            # phase = we're in an OCR-worthy screen. A `saved` tick read it; a `throttled` tick
            # is the SAME screen between two-rate OCR slots (not re-read) — both count as "in a
            # phase", so the live view stays steady instead of flickering to idle every slot.
            if result.status is TickStatus.saved:
                self._phase = True
                self._cur = (result.window_id, result.state_id)
                self._scroll = result.scroll   # None unless a mirror dataset read its scrollbar
                self._scroll_meta = result.scroll_meta
                key = f"{result.window_id}/{result.state_id}"
            elif result.status is TickStatus.throttled:
                self._phase = True             # still in the phase; KEEP _cur (don't reset)
                key = "throttled"
            else:
                self._phase = False
                self._cur = (None, None)
                key = result.status.value   # idle / no_window / not_foreground / unrecognised / state_invalid
            self._recog[key] = self._recog.get(key, 0) + 1
            # Debug log: record a tick that READ a record, WROTE a record, or read a readout whose
            # value CHANGED since the last logged one. A cache-hit / throttled / idle tick carries
            # none of those, so it never spams the log; an unchanged readout is likewise skipped.
            reads = getattr(result, "reads", None) or []
            ro_reads = getattr(result, "readout_reads", None) or []
            changed_ro = []
            for r in ro_reads:
                rid = next(iter(r["values"]), None)
                if rid is None:
                    continue
                val = r["values"][rid]
                if self._dbg_prev_readouts.get(rid, object()) != val:
                    changed_ro.append(r)
                self._dbg_prev_readouts[rid] = val
            # Filename this tick saved (capture-recognised mode saves every recognised grab, so a
            # recorded tick on a matched window has one). Consume + clear so it can't leak onto a
            # later tick that didn't save.
            saved = self._last_saved_frame
            self._last_saved_frame = None
            if reads or result.new or changed_ro:
                self._debug_seq += 1
                self._debug.append({
                    "seq": self._debug_seq,
                    "t": time.time(),
                    "window": result.window_id,
                    "state": result.state_id,
                    "dataset": result.dataset,
                    "new": result.new,
                    "read": result.read,
                    "kept": result.kept,
                    "reads": reads,
                    "readout_reads": changed_ro,
                    # image file this grab was saved to (capture-recognised mode only; None else)
                    "saved": saved if self._save_recognized else None,
                    # written keys/values this tick (added or updated) — the "pushed to dataset" side
                    "changed": [{k: v for k, v in c.items() if not str(k).startswith("_")}
                                for c in (result.changed or [])],
                })
        # on_register fires OUTSIDE the lock (a fired sweep/toast must not hold the session lock),
        # mirroring the collector loop's post-tick on_readout evaluation.
        if reg_events:
            runner = self._trigger_runner()
            if runner is not None:
                runner.on_register(reg_events, reg_snapshot)

    # ---- readout flow blobs ------------------------------------------------

    def _readout_targets(self, rid: str, profile=None) -> list[str]:
        """Graph node ids a readout FEEDS — every toast, register, and process whose sources
        reference it. Matches the readout's OUT edges the canvas draws (``ro:<win>:<id>`` ->
        ``toast:``/``register:``/``process:`` in model.js), so a flow blob addressed to one animates
        that exact edge. ``profile`` overrides the session's possibly-stale wiring (a just-added
        process/register reaches its blob without a live restart — mirrors the ``registers=`` feed)."""
        prof = profile if profile is not None else self._profile
        out: list[str] = []
        for toast in getattr(prof, "toasts", []) or []:
            if any(self._readout_ref(s) == rid for s in (getattr(toast, "sources", []) or [])):
                out.append(f"toast:{toast.id}")
        for reg in getattr(prof, "registers", []) or []:
            if any(self._readout_ref(s) == rid for s in (reg.sources or [])):
                out.append(f"register:{reg.id}")
        for proc in getattr(prof, "processes", []) or []:
            if not getattr(proc, "enabled", True):
                continue
            if any(getattr(inp, "ref", inp) == f"readout:{rid}" for inp in (proc.sources or [])):
                out.append(f"process:{proc.id}")
        return out

    def _emit_readout_flow(self, window_id: str, readouts: dict, profile=None) -> None:
        """Animate a data blob from EVERY readout read this tick to every node it feeds (readout ->
        register/toast/process), mirroring the producer/source data hops (:func:`publish_flow`). No
        change-gate — a valid read always animates its edge; coalescing/throttling is the downstream
        (client) job, not something the backend drops silently. Called under the lock — publish_flow
        is fire-and-forget. ``profile`` overrides the target-lookup wiring (see :meth:`_readout_targets`)."""
        if not window_id or not readouts:
            return
        for rid in readouts:
            src = f"ro:{window_id}:{rid}"
            for dst in self._readout_targets(rid, profile):
                try:
                    publish_flow(self._profile.name, "data", src, dst, 1)
                except Exception:  # noqa: BLE001 - a UI animation must never break the tick
                    pass

    # ---- registers ---------------------------------------------------------

    @staticmethod
    def _readout_ref(src: str) -> str | None:
        """Bare readout id from a register source ref. Sources are prefixed ``"readout:<id>"``
        (the ToastDef.sources shape); a bare ``"<id>"`` is tolerated. Non-readout refs -> None."""
        if ":" in src:
            kind, _, rid = src.partition(":")
            return rid if kind == "readout" else None
        return src or None

    @staticmethod
    def _ring_decimals(values: list) -> int:
        """Most decimal places any numeric member of the ring carries, from its written form
        (``"1.50"`` -> 2, ``"10"`` -> 0). Non-numeric members are skipped. Drives the fold's
        rounding precision (see :meth:`_aggregate_ring`)."""
        m = 0
        for v in values:
            try:
                float(v)
            except (TypeError, ValueError):
                continue
            s = str(v)
            dot = s.find(".")
            if dot >= 0:
                m = max(m, len(s) - dot - 1)
        return m

    @classmethod
    def _aggregate_ring(cls, values: list, mode: str):
        """Collapse a key's ring of recent values to the ONE value the register exposes, per
        ``RegisterDef.aggregate``. ``""``/``"latest"`` (or an unknown mode) -> the ring TAIL
        unchanged. A numeric fold (min/max/avg/sum/median/stable) coerces each member to ``float``
        and skips non-numeric ones -- including a dropped read's ``None`` (a ring ``[6, None, 8]``
        sums to ``14``); with no numeric members (or an empty ring, or an all-dropped ring) it falls
        back to the tail too, so an all-``None`` ring exposes ``None``. A non-numeric register never breaks — it just keeps showing its latest.

        ``common`` is the one NON-numeric fold: it does not coerce — it exposes the most frequent ring
        member by text form (ties -> newest of the tied), so a register of item names/states/labels
        collapses to its dominant value.

        ``stable`` = the NEWEST ring value that agrees with the consensus: skip values deviating more
        than ``_STABLE_K * MAD`` from the ring's median (walking newest->oldest), so a lone confident
        misread (a ``400`` spike among ``4.00`` reads) is rejected in favour of the latest good read.

        A fold that PRODUCES a float (avg/median always; min/max/sum when the result isn't whole)
        is rounded to the ring's own decimal precision PLUS ONE (no decimals in the inputs -> one),
        so an average of whole reads reads ``20.0`` and of two-decimal reads ``x.xxx``. A whole
        min/max/sum stays an int (it merely selected/added existing values — it didn't produce a
        float), so it reads ``20`` not ``20.0``."""
        tail = values[-1] if values else None
        if not values or mode in ("", "latest"):
            return tail
        if mode == "common":
            # Non-numeric fold: expose the most frequent ring member by TEXT form; return the
            # original value (a numeric ring still exposes a number). Tie -> newest of the tied.
            # Dropped reads (None / "") are excluded so a run of blanks can't win; an all-blank
            # ring exposes None.
            members = [v for v in values if v is not None and v != ""]
            if not members:
                return None
            counts = collections.Counter(str(v) for v in members)
            top = max(counts.values())
            winners = {k for k, c in counts.items() if c == top}
            return next((v for v in reversed(members) if str(v) in winners), members[-1])
        nums = []
        for v in values:
            try:
                nums.append(float(v))
            except (TypeError, ValueError):
                continue
        if not nums:
            return tail
        prec = cls._ring_decimals(values) + 1
        try:
            if mode == "avg":
                return round(statistics.fmean(nums), prec)
            if mode == "median":
                return round(statistics.median(nums), prec)
            if mode == "min":
                r = min(nums)
            elif mode == "max":
                r = max(nums)
            elif mode == "sum":
                r = sum(nums)
            elif mode == "stable":
                center = statistics.median(nums)
                thr = _STABLE_K * statistics.median([abs(x - center) for x in nums])
                r = next((v for v in reversed(nums) if abs(v - center) <= thr), tail)
            else:
                return tail
        except statistics.StatisticsError:
            return tail
        if r is None:   # stable found nothing within threshold and the ring tail is a drop
            return None
        # min/max/sum kept an existing value / total -> stay int when whole, else round like a fold
        return int(r) if float(r).is_integer() else round(r, prec)

    def _trigger_runner(self):
        """The session's shared :class:`TriggerRunner`, lazily built from the current profile
        (None when it declares no trigger). ONE instance backs both the live collector loop
        (passed into ``Collector.run``) and the teach-UI test feed (:meth:`feed_readouts`) so
        their ``on_readout`` edge state is the same (rule 7). Rebuilt when the profile is swapped
        (``_triggers_for`` pins the profile object it was built from)."""
        prof = self._profile
        if self._triggers_for is not prof:
            self._triggers = None
            self._triggers_for = prof
        if self._triggers is None and getattr(prof, "triggers", None):
            from .triggers import TriggerRunner
            self._triggers = TriggerRunner(prof, self._engine.settings.data_dir,
                                           notifier=self._engine.notifier)
        return self._triggers

    def feed_readouts(self, detailed: dict, ro_trace: list, ro_field: dict, window,
                      window_id: str, registers=None, profile=None) -> None:
        """Full live-like readout fold for a caller OUTSIDE the collector loop — the teach-UI
        ``test`` feed (``/api/preview?feed=1``). The readout twin of :meth:`feed_registers`:
        runs the SAME consensus + history gate (:func:`gate_readouts`), folds the surviving
        values into the accumulated readout maps, feeds registers, animates the readout ->
        register/toast data blob (:meth:`_emit_readout_flow`), and fires ``on_readout`` watch
        triggers through the session's shared runner (watch blob + side effects) — so feeding
        stashed images reproduces exactly what a live tick does for readouts.

        ``detailed`` is ``read_readouts_detailed``'s RETURN dict (``{id: (value, conf, raw, sub)}``,
        only the SURFACED reads — dropped/low-confidence ones already omitted, exactly as the
        collector builds ``readouts_now``); ``ro_trace`` is the parallel ``trace_sink`` list
        (``{id, value, raw, dropped, conf, trace}`` for EVERY enabled readout) the gate scores +
        records to history; ``ro_field`` maps readout id -> its resolved ``FieldDef``; ``window``
        is the ``WindowDef``; ``registers`` is the FRESH request profile's register wiring."""
        game = self._profile.name
        readouts_now = {k: value for k, (value, *_r) in detailed.items()}
        readout_confs_now = {k: conf for k, (_v, conf, *_r) in detailed.items()}
        ts = datetime.now().isoformat(timespec="milliseconds")
        # Consensus + history (shared with the collector); pops suppressed ids in place.
        suppressed = gate_readouts(game, window_id, ro_field, ro_trace,
                                   readouts_now, readout_confs_now, ts)
        # Full map: every ENABLED readout, empty-defaulted, suppressed excluded (mirrors the tick).
        readouts_all_now = {v.id: readouts_now.get(v.id, "") for v in window.readouts
                            if v.enabled and v.id not in suppressed}
        readout_confs_all_now = {v.id: readout_confs_now.get(v.id) for v in window.readouts
                                 if v.enabled and v.id not in suppressed}
        with self._lock:
            self._readouts.update(readouts_now)               # GATED map (triggers/toasts/.ro-live)
            self._readout_confs.update(readout_confs_now)
            self._readouts_all.update(readouts_all_now)        # FULL map (registers/.ro-live)
            self._readout_confs_all.update(readout_confs_all_now)
            # BEFORE registers -> a readout->process->register chain lands this tick. Pass the FRESH
            # request profile so a process wired since the session started is fed + animated (mirrors
            # the ``registers=`` override the register feed already uses).
            self._feed_processes(processes=(profile.processes if profile is not None else None), profile=profile)
            reg_events = self._feed_registers(self._readouts_all, self._readout_confs_all, registers)
            self._emit_register_process_flow(profile)   # IN blobs: register-slot -> process (every held slot)
            reg_snapshot = self._register_snapshot() if reg_events else {}
            self._emit_readout_flow(window_id, readouts_now, profile)   # readout -> register/toast/process
        # on_readout / on_register fire OUTSIDE the lock (a fired sweep/toast must not hold the
        # session lock), mirroring the collector loop's post-tick trigger evaluation.
        runner = self._trigger_runner()
        if runner is not None and readouts_now:
            runner.set_readouts(readouts_now)
            runner.on_readout(readouts_now)
        if runner is not None and reg_events:
            runner.on_register(reg_events, reg_snapshot)

    def feed_registers(self, readouts: dict, confs: dict, registers=None) -> None:
        """Public, thread-safe twin of :meth:`_feed_registers` for a caller OUTSIDE the
        collector tick loop — namely the ``/api/preview`` teaching-UI read, so a register (and
        any ``persist`` flush) updates from a one-shot OCR read too, not just a running live
        collector. Folds into the SAME accumulated ``readouts_all`` map ``_on_tick`` maintains
        (mirrors its "feed from the full map, not just this call's delta" reasoning) so what a
        register visibly holds — live-fed or preview-fed — is exactly what gets persisted;
        the two sources were diverging before this existed (a register could show a preview
        value with nothing ever reaching its ``persist`` dataset).

        ``registers`` lets the caller pass the register wiring from a FRESHLY-loaded profile
        (the preview request already parsed one) instead of this session's possibly-stale
        ``self._profile`` — so a newly-wired register source (e.g. a just-added readout) reaches
        its ``persist`` dataset without waiting for a live restart. ``None`` -> use the session's
        own profile (the collector-loop caller, whose reads are already from that profile)."""
        with self._lock:
            self._readouts_all.update(readouts or {})
            self._readout_confs_all.update(confs or {})
            self._feed_processes()   # BEFORE registers -> a readout->process->register chain lands this tick
            reg_events = self._feed_registers(self._readouts_all, self._readout_confs_all, registers)
            self._emit_register_process_flow()   # IN blobs: register-slot -> process (every held slot)
            reg_snapshot = self._register_snapshot() if reg_events else {}
        # on_register fires OUTSIDE the lock (mirrors feed_readouts) so a preview-fed register write
        # drives its watch triggers too, not only a live collector tick.
        if reg_events:
            runner = self._trigger_runner()
            if runner is not None:
                runner.on_register(reg_events, reg_snapshot)

    def _feed_registers(self, readouts: dict, confs: dict, registers=None) -> list[dict]:
        """Update each register's held entries from the accumulated live-readout map (caller holds
        the lock) -- so a newly-wired source picks up its value immediately from whatever window
        last reported it, not only when its own window is next read. Each key holds a ROLLING RING
        of the last ``capacity`` values: EVERY read is appended (even one identical to the current
        tail) and the ring truncated to the newest N, so a rolling window / moving aggregate sees
        every sample. Latest = ring tail. A source never seen this session is simply skipped. A
        dropped read (null / empty ``""``) is written to the ring as an explicit ``None`` so the
        rolling window RECORDS the gap (aggregates skip it — see :meth:`_aggregate_ring`); with
        ``ignore_empty`` set it is instead skipped entirely (never written to a keyslot) so a
        momentary blank can't displace a good held value. Every write is logged to the non-persisted
        push-history ring ([[register_history]]) for the push-history satellite. A register with
        ``persist`` set flushes its held map to that dataset only when a key's EXPOSED value (the
        aggregate, or the tail when no aggregate) actually changed this tick — so a static
        non-aggregate register never spams its dataset, but a rolling aggregate that shifts does.
        Capacity is read per-tick from the RegisterDef, so lowering N truncates here on the next
        tick and raising it regrows."""
        now = time.time()
        game = self._profile.name
        # keys whose EXPOSED value moved this tick -> drives on_register triggers (the caller fires
        # them OUTSIDE the lock). Same value-gate as `dirty` below, but tracked per key, not per reg.
        changed: list[dict] = []
        regs = registers if registers is not None else (getattr(self._profile, "registers", []) or [])
        for reg in regs:
            if not getattr(reg, "enabled", True):
                continue
            cap = max(1, int(getattr(reg, "capacity", 1) or 1))
            mode = getattr(reg, "aggregate", "") or ""
            ignore_empty = bool(getattr(reg, "ignore_empty", False))
            dirty = False
            for src in reg.sources or []:
                # readout:<id> keys the ring by the readout id (conf is that readout's, for the UI
                # tint); process:/register: sources contribute their OWN {key: value} pairs, KEY
                # preserved, with no confidence (only key + value flow out of a process). One shared
                # source resolver both registers and processes feed from (rule 7).
                is_readout = src.startswith("readout:") or ":" not in src
                for key, val in self._resolve_source(src, readouts).items():
                    if val is None or val == "":
                        if ignore_empty:
                            continue   # ignore the empty read — don't write it to a keyslot
                        val = None     # record the drop as an explicit null (not "") in the ring
                    m = self._registers.setdefault(reg.id, {})
                    prev = m.get(key)
                    prev_vals = prev["values"] if prev else []
                    prev_exposed = self._aggregate_ring(prev_vals, mode) if prev else None
                    # append EVERY read (duplicates included) -> the ring is a true rolling window
                    full = prev_vals[:]
                    full.append(val)
                    vals = full[-cap:]
                    evicted = full[:-cap]   # samples the append pushed out of the ring (may be empty)
                    # ring_index = the circular write cursor (0,1,..,cap-1,0,..) — WHICH slot this write
                    # lands in, so the push-history shows a rotating slot (not a constant cap-1 tail). The
                    # value it overwrote is that slot's prior content = the evicted-oldest (None until full).
                    writes = (prev["writes"] if prev else 0) + 1
                    register_history.record(
                        game, reg.id,
                        ts=datetime.now().isoformat(timespec="milliseconds"),
                        key=key, value=val, ring_index=(writes - 1) % cap,
                        overwritten=(evicted[-1] if evicted else None))
                    exposed = self._aggregate_ring(vals, mode)
                    if prev is None or prev_exposed != exposed:
                        dirty = True   # exposed value moved -> persist (skips a static non-aggregate)
                        changed.append({"reg": reg.id, "key": key, "value": exposed})
                    m[key] = {
                        "values": vals,
                        "writes": writes,
                        "conf": confs.get(key) if is_readout else None,
                        "first_seen": prev["first_seen"] if prev else now,
                        "last_seen": now,
                    }
            if dirty and getattr(reg, "persist", ""):
                self._flush_register(reg)
        return changed

    def _register_snapshot(self) -> dict:
        """``{register id -> {key -> exposed value}}`` for every held key (the aggregate fold, or the
        ring tail). The on_register runner needs the CURRENT value of every watched key — not just
        the ones that changed this tick — to evaluate an ``and`` across keys and the comparison ops.
        Caller holds ``self._lock`` (read straight off ``self._registers``)."""
        snap: dict = {}
        for reg_id, m in self._registers.items():
            rd = self._reg_def(reg_id)
            mode = getattr(rd, "aggregate", "") or "" if rd else ""
            snap[reg_id] = {k: self._aggregate_ring(e["values"], mode) for k, e in m.items()}
        return snap

    def _reg_def(self, reg_id: str):
        """The RegisterDef for ``reg_id`` in the current profile, or None."""
        for reg in getattr(self._profile, "registers", []) or []:
            if reg.id == reg_id:
                return reg
        return None

    def _register_current(self, reg_id: str) -> dict:
        """One register's exposed per-key map (the aggregate fold, or the ring tail) — the single-
        register twin of :meth:`_register_snapshot`, so a process consuming a register reads exactly
        what the register exposes. Caller holds ``self._lock``."""
        m = self._registers.get(reg_id) or {}
        rd = self._reg_def(reg_id)
        mode = getattr(rd, "aggregate", "") or "" if rd else ""
        return {k: self._aggregate_ring(e["values"], mode) for k, e in m.items()}

    # ---- processes: standalone key-preserved rules pipelines (see ProcessDef) --------

    def _resolve_source(self, src: str, readouts: dict) -> dict:
        """``{key: value}`` a wired source contributes THIS tick — the ONE readout/process/register
        lookup both registers (:meth:`_feed_registers`) and processes (:meth:`_feed_process_one`)
        feed from (rule 7). ``readouts`` is the readout-value map to resolve ``readout:`` refs against
        (the register feed passes its accumulated map arg; the process feed passes ``_readouts_all``).
        Caller holds ``self._lock``. Confidence is NEVER surfaced here — a process carries key + value only.

        * ``readout:<id>``        -> ``{<id>: value}`` (one key = the readout id; absent -> ``{}``)
        * ``process:<id>``        -> that process's whole ``{key: value}`` output (empty -> ``{}``)
        * ``register:<id>``       -> the register's exposed per-key snapshot (ALL its keys)
        * ``register:<id>#<key>`` -> a single sliced key of that register (``{}`` if not held)
        * bare ``"<id>"``         -> treated as ``readout:<id>`` (tolerated legacy shape)
        """
        if ":" not in src:
            return {src: readouts[src]} if src in readouts else {}
        kind, _, rest = src.partition(":")
        if kind == "readout":
            return {rest: readouts[rest]} if rest in readouts else {}
        if kind == "process":
            return dict(self._process_values.get(rest, {}))
        if kind == "register":
            reg_id, _, key = rest.partition("#")
            snap = self._register_current(reg_id)
            if key:
                return {key: snap[key]} if key in snap else {}
            return snap
        return {}

    def _feed_processes(self, processes=None, profile=None) -> None:
        """Recompute every enabled process node's ``{key: value}`` output from its resolved inputs
        (caller holds the lock). Runs BEFORE :meth:`_feed_registers` each tick so a
        ``readout -> process -> register`` chain lands the SAME tick. Processes are evaluated in
        dependency order (a process may consume another process's output — see :meth:`_process_order`);
        a register consumed by a process is read at its currently-held value (registers are fed just
        after, so the rarer ``register -> process`` direction carries a one-tick lag). Each input key
        flows through the shared rules pipeline KEY-PRESERVED; only key + value enter (confidence is
        never read from inputs), and a ``drop`` rule omits that key. Output is rebuilt fresh each tick
        (a process holds no state, unlike a register). ``processes`` / ``profile`` override the
        session's possibly-stale wiring on the preview-feed path (mirrors the ``registers=`` feed)."""
        procs = processes if processes is not None else (getattr(self._profile, "processes", []) or [])
        procs = [p for p in procs if getattr(p, "enabled", True)]
        self._process_values = {}
        for proc in self._process_order(procs):
            self._feed_process_one(proc)
        self._emit_process_flow(profile)   # OUT blobs: process -> register/process (every tick it ran)

    @staticmethod
    def _process_order(procs) -> list:
        """Topological order over the enabled processes so each is evaluated AFTER any process it
        consumes (a ``process:<id>`` input ref). Inputs are single-key today (no ``process:`` refs),
        so this is a no-op ordering in practice, but the guard stays defensive. A dependency cycle
        stops descending (the offending node is emitted in declaration order)."""
        by_id = {p.id: p for p in procs}
        ordered: list = []
        seen: set = set()
        temp: set = set()

        def visit(p):
            if p.id in seen or p.id in temp:
                return   # already emitted, or a cycle -> don't descend again
            temp.add(p.id)
            for src in p.sources or []:
                ref = getattr(src, "ref", src)   # ProcessInput.ref (tolerate a bare string)
                if ref.startswith("process:"):
                    dep = by_id.get(ref.partition(":")[2])
                    if dep is not None:
                        visit(dep)
            temp.discard(p.id)
            seen.add(p.id)
            ordered.append(p)

        for p in procs:
            visit(p)
        return ordered

    def _feed_process_one(self, proc) -> None:
        """Resolve one process's single-key inputs, run the rules pipeline on each value, and emit it
        under the input's ``out`` key (or the input key when ``out`` is blank — the key mangler).
        Writes the ``{out_key: value}`` output into ``self._process_values`` and records each fire
        (input value, trace, output) to :mod:`process_history` under the emitted key."""
        game = self._profile.name
        ftype = getattr(getattr(proc, "type", None), "value", None) or "text"
        rules = getattr(proc, "rules", None) or []
        out: dict[str, object] = {}
        for src in proc.sources or []:
            ref = getattr(src, "ref", src)          # ProcessInput.ref (tolerate a bare string)
            rename = (getattr(src, "out", "") or "").strip()
            for key, val in self._resolve_source(ref, self._readouts_all).items():
                out_key = rename or key              # blank out -> keep the input key
                raw = "" if val is None else str(val)
                res = run_rule_pipeline(rules, ftype, raw, trace=True)
                value = None if res.dropped else res.value
                process_history.record(
                    game, proc.id,
                    ts=datetime.now().isoformat(timespec="milliseconds"),
                    key=out_key, raw=raw, value=value, trace=res.trace)
                if res.dropped:
                    continue   # a `drop` rule removes this key from the output
                out[out_key] = value
        self._process_values[proc.id] = out

    # ---- process flow blobs (in + out edges animate as data moves through) --------

    def _process_consumers(self, proc_id: str, profile=None) -> list[str]:
        """Graph node ids a process FEEDS — registers (and other processes) whose sources reference
        its output (``process:<id>``). Matches the process's OUT edges in model.js. ``profile``
        overrides the session's possibly-stale wiring (preview-feed path)."""
        prof = profile if profile is not None else self._profile
        ref = f"process:{proc_id}"
        out: list[str] = []
        for reg in getattr(prof, "registers", []) or []:
            if ref in (reg.sources or []):
                out.append(f"register:{reg.id}")
        for p in getattr(prof, "processes", []) or []:
            if p.id != proc_id and any(getattr(inp, "ref", inp) == ref for inp in (p.sources or [])):
                out.append(f"process:{p.id}")
        return out

    def _emit_process_flow(self, profile=None) -> None:
        """Animate a data blob from every process that produced output this tick to every node it
        feeds (the process's OUT edges). No change-gate — a process that ran animates its edges;
        downstream coalesces. Called under the lock right after the outputs are recomputed. An empty
        output isn't gated away — there is simply no data on that edge to animate. ``profile``
        overrides the consumer-lookup wiring (see :meth:`_process_consumers`)."""
        for pid, output in self._process_values.items():
            if not output:
                continue   # no data produced this tick -> no edge to animate (absence of data, not a gate)
            for dst in self._process_consumers(pid, profile):
                try:
                    publish_flow(self._profile.name, "data", f"process:{pid}", dst, 1)
                except Exception:  # noqa: BLE001 - a UI animation must never break the tick
                    pass

    def _emit_register_process_flow(self, profile=None) -> None:
        """Animate a data blob from a register to each process consuming one of its slots
        (``register:<id>#<key>``), for every currently-HELD slot each tick — the 'in' hop for a
        register-slot process input. No change-gate: the process reads the slot every tick, so its
        edge animates every tick (downstream coalesces); a slot with no held value has no data to
        animate. ``profile`` overrides the possibly-stale wiring (preview-feed path)."""
        prof = profile if profile is not None else self._profile
        for p in getattr(prof, "processes", []) or []:
            if not getattr(p, "enabled", True):
                continue
            for inp in (p.sources or []):
                ref = getattr(inp, "ref", inp)
                if not ref.startswith("register:") or "#" not in ref:
                    continue
                reg_id, _, key = ref[len("register:"):].partition("#")
                if key in (self._registers.get(reg_id) or {}):   # slot actually holds a value (a real read)
                    try:
                        publish_flow(self._profile.name, "data", f"register:{reg_id}", f"process:{p.id}", 1)
                    except Exception:  # noqa: BLE001 - a UI animation must never break the tick
                        pass

    def rename_process(self, old_id: str, new_id: str) -> None:
        """Carry a process's live output + history to its new id (client renamed the node), so the
        renamed node isn't blank until the next tick recomputes it."""
        with self._lock:
            if old_id in self._process_values:
                self._process_values[new_id] = self._process_values.pop(old_id)
        game = self._profile.name
        for e in process_history.recent(game, old_id)[::-1]:   # oldest-first so appendleft rebuilds newest-first
            process_history.record(game, new_id, ts=e["ts"], key=e["key"], raw=e["raw"],
                                   value=e["value"], trace=e.get("trace"))
        process_history.clear(game, old_id)

    def _flush_register(self, reg) -> None:
        """Mirror one register's held map into its ``persist`` dataset — one row per wired
        readout (``{name: <readout id>, value: <exposed value>}``), so state that only ever
        existed as a live readout (e.g. loadout slot contents) becomes queryable like any other
        dataset. The exposed value honours ``RegisterDef.aggregate`` (a fold over the ring), else
        the ring tail. Best-effort: a write hiccup must never disturb collection."""
        try:
            dataset = reg.persist
            mode = getattr(reg, "aggregate", "") or ""
            store = self._persist_stores.get(dataset)
            if store is None:
                store = store_for(self._engine.settings.data_dir, self._profile.name,
                                  dataset, profile=self._profile)
                self._persist_stores[dataset] = store
            rows = [{"name": rid, "value": self._aggregate_ring(e["values"], mode)}
                    for rid, e in self._registers.get(reg.id, {}).items()]
            if rows:
                store.record_many(rows)
        except Exception:  # pragma: no cover - defensive, mirrors _save_frame
            pass

    def register_records(self, reg_id: str, aggregate: str | None = None) -> list[dict]:
        """Current held map for one register as table rows (newest last_seen first). ``value`` is
        the ring tail (latest); ``values`` is the full ring (oldest->newest) the membank stacks;
        ``writes`` is the total sample count -> the circular write cursor ``(writes-1) % cap`` the
        membank uses to place the ring in stable physical slots and arrow the last-written one;
        ``agg`` is the aggregated value (fold over the ring) or None when no aggregate is set;
        ``depth`` is how many recent values the key currently holds.

        ``aggregate`` overrides the fold mode (the teach UI passes the node's LIVE select so the
        summary repaints instantly — the session profile is frozen mid-run). ``None`` -> use the
        stored ``RegisterDef.aggregate``."""
        mode = aggregate if aggregate is not None else (getattr(self._reg_def(reg_id), "aggregate", "") or "")
        with self._lock:
            m = self._registers.get(reg_id) or {}
            rows = [{"key": rid, "value": e["values"][-1], "conf": e["conf"],
                     "values": list(e["values"]),   # full ring, oldest -> newest (membank stack)
                     "writes": e["writes"],   # total writes -> circular cursor (which slot was last written)
                     "agg": self._aggregate_ring(e["values"], mode) if mode not in ("", "latest") else None,
                     "depth": len(e["values"]),
                     "first_seen": e["first_seen"], "last_seen": e["last_seen"]}
                    for rid, e in m.items()]
        rows.sort(key=lambda r: r["last_seen"], reverse=True)
        return rows

    def register_keys(self, reg_id: str) -> list[str]:
        """The readout keys a register currently holds a value for (empty when none / no session)."""
        with self._lock:
            return list((self._registers.get(reg_id) or {}).keys())

    def register_latest(self, reg_id: str, key: str):
        """Latest exposed value for one key of a register (``RegisterDef.aggregate`` fold over the
        ring when set, else the ring tail), or None if not held."""
        mode = getattr(self._reg_def(reg_id), "aggregate", "") or ""
        with self._lock:
            e = (self._registers.get(reg_id) or {}).get(key)
            return self._aggregate_ring(e["values"], mode) if e else None

    def clear_register_keys(self, reg_id: str, keys) -> None:
        """Drop only the named keys from a register's held map (action clear/move slot targeting).
        Unknown keys are ignored; an emptied register keeps its (now empty) map entry."""
        with self._lock:
            m = self._registers.get(reg_id)
            if not m:
                return
            for k in keys:
                m.pop(k, None)

    def clear_register(self, reg_id: str) -> None:
        """Drop every held entry for one register (its map button) + its push-history ring."""
        with self._lock:
            self._registers.pop(reg_id, None)
        register_history.clear(self._profile.name, reg_id)

    def rename_register(self, old_id: str, new_id: str) -> None:
        """Carry a register's held map + push-history to its new id (client renamed the node).
        Without this the map stays keyed under the stale id and the renamed node reads empty until
        the next collector tick repopulates it from readouts."""
        with self._lock:
            if old_id in self._registers:
                self._registers[new_id] = self._registers.pop(old_id)
        game = self._profile.name
        for e in register_history.recent(game, old_id)[::-1]:   # oldest-first so appendleft rebuilds newest-first
            register_history.record(game, new_id, ts=e["ts"], key=e["key"], value=e["value"],
                                    ring_index=e["ring_index"], overwritten=e["overwritten"])
        register_history.clear(game, old_id)

    # ---- status ------------------------------------------------------------

    def debug(self, after: int = 0) -> dict:
        """Debug-log entries with seq > ``after`` (incremental poll). ``seq`` is the newest
        entry number so a caller knows the high-water mark even when nothing is newer."""
        with self._lock:
            return {
                "running": self.is_running(),
                "seq": self._debug_seq,
                "entries": [e for e in self._debug if e["seq"] > after],
            }

    def _readout_history_snapshot(self) -> dict:
        """``{"<window>:<readout>": [recent reads]}`` for every enabled readout that has been read
        this session (empty ones omitted). Feeds the readout-history satellite via the heartbeat."""
        game = self._profile.name
        out: dict[str, list] = {}
        for w in self._profile.windows:
            for v in (w.readouts or []):
                if not v.enabled:
                    continue
                hist = readout_history.recent(game, w.id, v.id)
                if hist:
                    out[f"{w.id}:{v.id}"] = hist
        return out

    def status(self) -> dict:
        with self._lock:
            running = self.is_running()
            elapsed = max(1e-3, time.monotonic() - self._t0) if self._t0 else 1e-3
            return {
                "running": running,
                "frames": self._frames,
                "written": self._written,
                "interval": self._interval,   # frame limiter (seconds); lets a reloaded UI restore the limit input
                "fps": round(self._frames / elapsed, 1) if running else 0.0,
                "window": self._cur[0],
                "state": self._cur[1],
                "phase": self._phase and running,   # currently reading a data window (a worthy screen)
                "phase_status": self._last_status,  # raw TickStatus — WHY we're not reading (throttled / unrecognised / …)
                "scroll": list(self._scroll) if self._scroll else None,   # [vlo,vhi] row-index span, or null
                "scroll_meta": self._scroll_meta,   # {total,viewport,gain,confident,pinned} or null
                "readouts": dict(self._readouts),   # {readout_id: value} GATED live values (never stored)
                "readout_confs": dict(self._readout_confs),   # {readout_id: confidence} for the values above (UI only)
                # Full map: every enabled readout, empty/low-confidence as "" instead of omitted.
                # Drives .ro-live + the register non-live fallback so a blank slot shows/holds
                # empty rather than nothing (see TickResult.readouts_all / _feed_registers).
                "readouts_all": dict(self._readouts_all),
                "readout_confs_all": dict(self._readout_confs_all),
                # Per-readout recent-read history (non-persisted ring) for the readout-history
                # satellite, keyed "<window>:<readout>". Only readouts with reads this session are
                # included (empty ones omitted to keep the beat light).
                "readout_history": self._readout_history_snapshot(),
                # (register push-history rides the activity payload TOP-LEVEL via
                # routes/activity.py build_activity — live collection AND the teach-UI test feed —
                # not this nested live-status snapshot.)
                "recognized": [{"key": k, "count": n, "miss": k in ("", "idle", "unrecognised", "no_window")}
                               for k, n in sorted(self._recog.items(), key=lambda kv: kv[1], reverse=True)],
                "error": self._error,
            }
