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
import threading
import time

from ..engine import Engine
from ..ocr.device_switch import enter_device, exit_device
from ..profile.models import GameProfile
from ..store import store_for
from ..store.flow_events import publish_flow
from . import readout_history
from .collector import Collector, TickStatus

# How many recent debug entries the live session keeps for the panel's debug log. Bounded so a
# long-running collector can't grow memory without limit; the UI polls incrementally by seq.
_DEBUG_CAP = 300

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
        self._flow_prev_readouts: dict[str, object] = {}  # last readout values a flow blob was sent for
        # "auto" device policy: set to "gpu" by the web layer to run the live loop on GPU
        # (every frame OCRs many regions -> GPU throughput wins), then restore the baseline
        # device on stop (which frees the GPU). None = use whatever device the engine is on.
        self.batch_device: str | None = None

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

    def start(self, interval: float | None = None) -> None:
        if self.is_running():
            return
        if interval is None:
            interval = self._engine.settings.tuning.collect_interval
        self._join_prev()
        with self._lock:
            self._interval = max(0.0, float(interval))
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
            self._flow_prev_readouts = {}
            self._error = None
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
            # Collector.run owns the trigger loop + flushes via close() on the way out.
            collector.run(self._interval, on_tick=self._on_tick, should_stop=self._stop.is_set)
        except Exception as exc:  # pragma: no cover - defensive
            with self._lock:
                self._error = str(exc)
        finally:
            exit_device(self._engine, restore)

    def _save_frame(self, frame) -> None:
        """Save one frame into the game's live/ image bucket — the same bucket the read-only
        tuning loop writes to. Only called on a tick that WROTE a record, so the bucket fills
        with frames that produced data, not every recognised grab. Best-effort: an encode/disk
        hiccup must never disturb collection."""
        try:
            import cv2

            from ..web import captures_store
            ok, buf = cv2.imencode(".jpg", frame.image, [cv2.IMWRITE_JPEG_QUALITY, 90])
            if ok:
                captures_store.save(self._engine.settings.captures_dir, self._profile.name,
                                    buf.tobytes(), sub=captures_store.LIVE)
        except Exception:  # pragma: no cover - defensive
            pass

    def _on_tick(self, result) -> None:
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
                self._feed_registers(self._readouts_all, self._readout_confs_all)
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
                    # written keys/values this tick (added or updated) — the "pushed to dataset" side
                    "changed": [{k: v for k, v in c.items() if not str(k).startswith("_")}
                                for c in (result.changed or [])],
                })

    # ---- readout flow blobs ------------------------------------------------

    def _readout_targets(self, rid: str) -> list[str]:
        """Graph node ids a readout FEEDS — every toast and register whose sources reference it.
        Matches the readout's OUT edges the canvas draws (``ro:<win>:<id>`` -> ``toast:``/
        ``register:`` in model.js), so a flow blob addressed to one animates that exact edge."""
        out: list[str] = []
        for toast in getattr(self._profile, "toasts", []) or []:
            if any(self._readout_ref(s) == rid for s in (getattr(toast, "sources", []) or [])):
                out.append(f"toast:{toast.id}")
        for reg in getattr(self._profile, "registers", []) or []:
            if any(self._readout_ref(s) == rid for s in (reg.sources or [])):
                out.append(f"register:{reg.id}")
        return out

    def _emit_readout_flow(self, window_id: str, readouts: dict) -> None:
        """Animate a data blob from each readout that CHANGED value this tick to every node it
        feeds, mirroring the producer/source data hops (:func:`publish_flow`). Change-gated so the
        continuous readout loop doesn't spam the wire (an unchanged HUD reading sends nothing);
        a consensus-HELD readout is absent from this GATED map, so it emits nothing either. Called
        under the lock — publish_flow is a fire-and-forget fan-out, cheap and non-blocking."""
        if not window_id or not readouts:
            return
        prev = self._flow_prev_readouts
        for rid, val in readouts.items():
            if rid in prev and prev[rid] == val:
                continue
            prev[rid] = val
            src = f"ro:{window_id}:{rid}"
            for dst in self._readout_targets(rid):
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
            self._feed_registers(self._readouts_all, self._readout_confs_all, registers)

    def _feed_registers(self, readouts: dict, confs: dict, registers=None) -> None:
        """Update each register's held entries from the accumulated live-readout map (caller holds
        the lock) -- so a newly-wired source picks up its value immediately from whatever window
        last reported it, not only when its own window is next read. Each key holds a ROLLING RING
        of the last ``capacity`` values: a NEW value (differs from the current tail) is appended and
        the ring truncated to the newest N; an UNCHANGED value only bumps conf/last_seen (so a
        static HUD can't flood the ring with duplicates). Latest = ring tail. A source never seen
        this session is simply skipped. A register with ``persist`` set flushes its held map to that
        dataset when any entry's LATEST value actually changed this tick (conf/last_seen alone don't
        count — else every tick would write, even an unchanged screen). Capacity is read per-tick
        from the RegisterDef, so lowering N truncates here on the next tick and raising it regrows."""
        now = time.time()
        regs = registers if registers is not None else (getattr(self._profile, "registers", []) or [])
        for reg in regs:
            if not getattr(reg, "enabled", True):
                continue
            cap = max(1, int(getattr(reg, "capacity", 1) or 1))
            dirty = False
            for src in reg.sources or []:
                rid = self._readout_ref(src)
                if rid is None or rid not in readouts:
                    continue
                m = self._registers.setdefault(reg.id, {})
                prev = m.get(rid)
                val = readouts[rid]
                prev_latest = prev["values"][-1] if prev else None
                if prev is None or prev_latest != val:
                    dirty = True
                    vals = (prev["values"] if prev else [])[:]
                    vals.append(val)
                    vals = vals[-cap:]
                else:
                    vals = prev["values"][-cap:]   # unchanged value: keep ring, honour a lowered cap
                m[rid] = {
                    "values": vals,
                    "conf": confs.get(rid),
                    "first_seen": prev["first_seen"] if prev else now,
                    "last_seen": now,
                }
            if dirty and getattr(reg, "persist", ""):
                self._flush_register(reg)

    def _flush_register(self, reg) -> None:
        """Mirror one register's held map into its ``persist`` dataset — one row per wired
        readout (``{name: <readout id>, value: <held value>}``), so state that only ever
        existed as a live readout (e.g. loadout slot contents) becomes queryable like any other
        dataset. Best-effort: a write hiccup must never disturb collection."""
        try:
            dataset = reg.persist
            store = self._persist_stores.get(dataset)
            if store is None:
                store = store_for(self._engine.settings.data_dir, self._profile.name,
                                  dataset, profile=self._profile)
                self._persist_stores[dataset] = store
            rows = [{"name": rid, "value": e["values"][-1]}
                    for rid, e in self._registers.get(reg.id, {}).items()]
            if rows:
                store.record_many(rows)
        except Exception:  # pragma: no cover - defensive, mirrors _save_frame
            pass

    def register_records(self, reg_id: str) -> list[dict]:
        """Current held map for one register as table rows (newest last_seen first). ``value`` is
        the ring tail (latest); ``depth`` is how many recent values the key currently holds."""
        with self._lock:
            m = self._registers.get(reg_id) or {}
            rows = [{"key": rid, "value": e["values"][-1], "conf": e["conf"],
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
        """Latest held value (ring tail) for one key of a register, or None if not held."""
        with self._lock:
            e = (self._registers.get(reg_id) or {}).get(key)
            return e["values"][-1] if e else None

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
        """Drop every held entry for one register (its map button)."""
        with self._lock:
            self._registers.pop(reg_id, None)

    def rename_register(self, old_id: str, new_id: str) -> None:
        """Carry a register's held map to its new id (client renamed the node). Without this the
        map stays keyed under the stale id and the renamed node reads empty until the next
        collector tick repopulates it from readouts."""
        with self._lock:
            if old_id in self._registers:
                self._registers[new_id] = self._registers.pop(old_id)

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
                "recognized": [{"key": k, "count": n, "miss": k in ("", "idle", "unrecognised", "no_window")}
                               for k, n in sorted(self._recog.items(), key=lambda kv: kv[1], reverse=True)],
                "error": self._error,
            }
