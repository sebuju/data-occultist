"""Evaluate a profile's triggers and fire price-node sweeps.

A :class:`TriggerDef` says *when* to price; this runner turns that into calls to the shared
:func:`oc.enrich.price_runner.start_sweep`. ``on_change`` is driven by the dataset change bus
(:mod:`oc.store.changes`), so it fires on ANY write to a watched dataset — collector, price
sweep, manual form, batch restore — not only live collection. Interval triggers fire on
schedule even with no game running.

Kinds:

* ``interval``     — fire every ``interval_s`` seconds (:meth:`tick`, called each loop pass).
* ``on_change``    — fire when a watched dataset gains records (:meth:`on_change`), pricing ONLY
  those changed keys (resolved to slugs) so a relic-reward read prices ~4 items, not the world.
  A watched SUBSET only justifies a fire when its computed/visible output actually changed.
* ``on_any_change``— same watch mechanics as ``on_change``, but a subset watch fires on EVERY
  write reaching it, even one that leaves the subset's visible output unchanged (e.g. a hidden
  join column). Use when "data entered" itself is the signal, not "the joined view differs".
* ``on_new_batch``  — fire once per NEW batch of a watched dataset (:meth:`on_change`, off the same
  change bus), even when the row values are identical to the previous batch. A re-pushed relic
  screen is a fresh batch, so it re-fires (→ re-sweep → re-toast) where on_change (value-gated)
  would not. Watches a dataset OR a subset over it (fires on the subset's leaf dataset's batch).
* ``on_app_start`` — fire once when the teach/web app boots (:meth:`fire_app_start`).
* ``on_capture``   — fire when a capture session starts, live OR precapture (:meth:`fire_capture`).
* ``on_live_start``— fire when the server live-collection session starts (:meth:`fire_live_start`).
* ``on_live_stop`` — fire when the server live-collection session stops (:meth:`fire_live_stop`).
* ``manual``       — never auto-fires (the sweep button drives it); declared only for wiring.

A trigger ``target`` is a price-node id, a file-source id, a toast/sound id, OR an action id:
pricing nodes sweep the market, file sources read a log/config file, toasts/sounds notify, and an
action node clears/clones/moves a dataset (see :class:`oc.profile.models.ActionDef` and
:func:`oc.store.dataset_ops.fire_dataset_target`). The runner dispatches by which kind owns the id.

``fire`` and ``clock`` are injectable so the scheduling logic is unit-testable without sleeping
or hitting the network.
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from ..enrich.price_runner import start_sweep, sweep_status
from ..eventlog import publish as logev
from ..eventlog import slog
from ..store.fire_events import publish_fire
from ..store.flow_events import publish_flow


# ---- last-activation tracking (shared across firers via a tiny sidecar) -------------

def _fires_path(data_dir, game: str) -> Path:
    return Path(data_dir) / game / ".trigger_fires.json"


def read_fires(data_dir, game: str) -> dict:
    """``{trigger_id: iso-timestamp}`` of the last time each trigger fired, or ``{}``."""
    p = _fires_path(data_dir, game)
    if not p.exists():
        return {}
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def record_fire(data_dir, game: str, trigger_id: str) -> None:
    """Stamp ``trigger_id`` as fired now (UTC). Cross-firer visible (web + collector)."""
    p = _fires_path(data_dir, game)
    d = read_fires(data_dir, game)
    d[trigger_id] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(d), encoding="utf-8")
    except OSError:
        pass


# ---- watched-subset output signatures ------------------------------------------------
# A subset (a join over several datasets) only meaningfully "changed" when its COMPUTED rows
# change — not when any source it reads is touched. We hash each watched subset's output and
# remember it here so an on_change trigger watching a subset fires only on a real change.

def _sigs_path(data_dir, game: str) -> Path:
    return Path(data_dir) / game / ".subset_sigs.json"


def read_subset_sigs(data_dir, game: str) -> dict:
    """``{subset_id: sha256_hex}`` of each watched subset's last-seen output, or ``{}``."""
    p = _sigs_path(data_dir, game)
    if not p.exists():
        return {}
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def write_subset_sigs(data_dir, game: str, sigs: dict) -> None:
    """Persist subset output signatures (so a restart doesn't re-fire on the first change)."""
    p = _sigs_path(data_dir, game)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(sigs), encoding="utf-8")
    except OSError:
        pass


class TriggerRunner:
    def __init__(self, profile, data_dir, *, fire: Callable | None = None,
                 notifier=None, clock: Callable[[], float] = time.monotonic,
                 wall: Callable[[], datetime] | None = None,
                 timer_factory: Callable[..., object] = threading.Timer) -> None:
        self._profile = profile
        self._data_dir = data_dir
        self._clock = clock
        # factory for the trailing-settle debounce timer (threading.Timer(secs, fn, args=[...]));
        # injectable so tests drive _settle_flush deterministically instead of sleeping on a thread.
        self._timer_factory = timer_factory
        # wall-clock provider (real UTC time) for kind="true_interval", which measures elapsed
        # time against the PERSISTED last-fired timestamp (survives restart/config edit) rather
        # than the injectable monotonic clock. Injectable so true_interval stays unit-testable.
        self._wall = wall or (lambda: datetime.now(timezone.utc))
        self._fire = fire or self._default_fire
        # OS-notification backend (oc.interfaces.Notifier) for toast-node targets; None ->
        # toast targets are silently skipped (e.g. a runner built without one). Never used in
        # the capture loop — only when a fired trigger names a toast node.
        self._notifier = notifier
        # Latest {readout_id: value} seen, so a fired toast can interpolate {{ro_1}} tokens in
        # its text. Readouts are ephemeral (never stored) — the collector pushes them each tick
        # via set_readouts(); other fire paths (web routes) supply their own values to fire_toast.
        self._readouts_latest: dict = {}
        # Latest {register id -> {key -> exposed value}} pushed each tick (set_registers), so a gate
        # over a register key can be evaluated at fire time on ANY trigger kind (not just the tick a
        # key moved). Mirror of _readouts_latest for the register side.
        self._reg_latest: dict = {}
        # Latest {register id -> {key -> [ring members oldest->newest]}} pushed each tick
        # (set_register_rings), so a COUNT-facet source (register:<id>#<key>@count|@nonblank|@distinct)
        # can count over a key's ring of recent values instead of testing its single exposed value.
        self._reg_rings: dict = {}
        # Previous NUMERIC value per source ref ("readout:<id>" / "register:<reg>#<key>") — the one
        # store the gate edge ops (crosses_up/crosses_down/changed) and the on_readout move-pulse
        # compare against. Updated at the end of on_readout / on_register (mirrors the old
        # _readout_prev / _register_prev, unified by source string).
        self._source_prev: dict[str, float] = {}
        # Previous pass/block result per gate id — so emit_gate_flow animates a blob only when a
        # gate's decision FLIPS (a steady value never spams the flow layer). Seeded on first sight.
        self._gate_prev: dict[str, bool] = {}
        # last-fire time per interval trigger; seed to "now" so the first fire waits a
        # full interval rather than firing immediately on startup.
        now = clock()
        self._last: dict[str, float] = {
            t.id: now for t in profile.triggers if t.kind == "interval"}
        # monotonic time of each trigger's LAST actual fire (any kind) — the throttle clock. A
        # fire within throttle_ms of this is suppressed (recorded as throttled, not fired).
        self._last_fire_any: dict[str, float] = {}
        # on_new_batch: last batch number an on_new_batch trigger fired on, per (trigger, dataset).
        # In-memory (the runner is cached per game), so a fresh process fires on the first batch it
        # sees — acceptable, mirrors interval reseed. We fire on any CHANGE in batch number (!=),
        # not only an increase, so a dataset clear (which resets the batch to 0) doesn't wedge the
        # trigger until the count climbs back past the last-fired number.
        self._new_batch_last: dict[tuple[str, str], int] = {}
        # trailing-settle debounce state (guarded by _settle_lock). For a trigger with settle_ms:
        # the pending fire args (kept latest-wins), the live timer, and the monotonic time the
        # current window opened (for the settle_max_ms deadline). A fire is deferred while the
        # window keeps re-arming and emitted once it quiets (or the deadline hits).
        self._settle_lock = threading.Lock()
        self._settle_pending: dict[str, tuple] = {}   # id -> (why, items, node, value)
        self._settle_timer: dict[str, object] = {}    # id -> Timer
        self._settle_first: dict[str, float] = {}     # id -> window-open monotonic time

    # ---- throttle + shared fire funnel -------------------------------------

    def _throttled(self, t) -> bool:
        """Is a fire of ``t`` inside its ``throttle_ms`` window since its last actual fire?"""
        thr = getattr(t, "throttle_ms", None)
        if not thr or thr <= 0:
            return False
        last = self._last_fire_any.get(t.id)
        return last is not None and (self._clock() - last) < (thr / 1000.0)

    def _emit_fire(self, t, why: str, items, node: str = "", value: object = None) -> bool:
        """Throttle-gate then fire ``t``'s targets, stamping the last-fired sidecar and the
        (non-persisted) fire history. Returns True if it fired, False if throttle suppressed it.
        The single funnel every AUTO fire path (interval/lifecycle/on_change/on_readout) routes
        through, so throttle + history behave identically regardless of what fired the trigger.

        ``node``/``value`` (on_readout only) record the readout node whose reading justified the
        fire and the actual value that crossed, for the history satellite."""
        from .trigger_history import record as record_hist
        ts = self._wall().isoformat(timespec="milliseconds")
        if self._throttled(t):
            logev(f"trigger {t.id} throttled ({why})", level="info", game=self._profile.name)
            record_hist(self._profile.name, t.id, why=why, targets=list(t.targets),
                        throttled=True, ts=ts, node=node, value=value)
            return False
        logev(f"trigger {t.id} fired ({why})", level="run", game=self._profile.name)
        slog(f"trigger {t.id} fired ({why})", game=self._profile.name)
        # Resolve targets THROUGH any router (fan-out by a live value): server targets fire here,
        # the chosen sound ids ride the fire cue (sounds are client-played).
        fire_ids, sound_ids = self._resolve_fire(t)
        self._fire_targets(t, fire_ids, items=items)
        record_fire(self._data_dir, self._profile.name, t.id)
        # Instant live cue for the browser: sounds are client-played, and the polled activity
        # snapshot (disk sidecar + ~1s SSE pump) is too slow. Push the fire the moment it happens
        # so the sound tracks the trigger, not the poll. A fire with no sound target still
        # publishes (client no-ops) -- the server stays game-dumb about target kinds. ``sound_ids``
        # names the sounds a router selected (empty -> the client plays the trigger's own sounds).
        publish_fire(self._profile.name, t.id, sound_ids)
        record_hist(self._profile.name, t.id, why=why, targets=list(t.targets),
                    throttled=False, ts=ts, node=node, value=value)
        self._last_fire_any[t.id] = self._clock()
        return True

    # ---- trailing-settle debounce (mirror of throttle) ---------------------

    def _route_fire(self, t, why: str, items, node: str = "", value: object = None) -> bool:
        """Auto-fire entry point. With no ``settle_ms`` this is just ``_emit_fire`` (fire now). With
        ``settle_ms`` set, the fire is DEFERRED into a trailing window: the latest args are stashed
        (latest-wins) and a timer (re)armed, so a burst of justified fires — a sweep dripping rows,
        several sequential sweeps as OCR settles — collapses into ONE ``_emit_fire`` once the watched
        data goes quiet (or ``settle_max_ms`` elapses). Returns True only for a SYNCHRONOUS fire; a
        deferred fire returns False and lands later via ``_settle_flush``. Manual "fire now" does not
        route here — it bypasses settle exactly as it bypasses throttle."""
        if not self._gates_pass(t):
            from .trigger_history import record as record_hist
            logev(f"trigger {t.id} gated ({why})", level="info", game=self._profile.name)
            record_hist(self._profile.name, t.id, why=why, targets=list(t.targets),
                        throttled=True, ts=self._wall().isoformat(timespec="milliseconds"),
                        node=node, value=value)
            return False
        settle_ms = getattr(t, "settle_ms", None)
        if not settle_ms or settle_ms <= 0:
            return self._emit_fire(t, why, items, node, value)
        now = self._clock()
        max_ms = getattr(t, "settle_max_ms", None)
        fire_now = False
        with self._settle_lock:
            self._settle_pending[t.id] = (why, items, node, value)
            first = self._settle_first.setdefault(t.id, now)
            old = self._settle_timer.pop(t.id, None)
            if old is not None:
                try:
                    old.cancel()
                except Exception:  # noqa: BLE001 - a bad fake timer must not break firing
                    pass
            wait = settle_ms / 1000.0
            if max_ms and max_ms > 0:
                remaining = (max_ms / 1000.0) - (now - first)
                if remaining <= 0:
                    fire_now = True          # deadline hit — stop waiting, fire below
                else:
                    wait = min(wait, remaining)
            if not fire_now:
                self._arm_settle_locked(t.id, wait)
        if fire_now:
            self._settle_flush(t.id)         # outside the lock — _emit_fire may sweep/toast
        return False

    def _arm_settle_locked(self, tid: str, wait: float) -> None:
        """(Re)start the trailing-settle timer for ``tid``. Caller holds ``self._settle_lock``."""
        self._arm_timer_locked(tid, wait, self._settle_flush)

    def _arm_timer_locked(self, tid: str, wait: float, fn: Callable[[str], None]) -> None:
        """(Re)start the debounce timer for ``tid`` to call ``fn(tid)`` after ``wait`` s. Shared by
        the settle debounce and the on_ready completion gate (a trigger is one kind, so the single
        ``_settle_timer`` slot never collides). Caller holds ``self._settle_lock``."""
        timer = self._timer_factory(max(0.0, wait), fn, args=[tid])
        try:
            timer.daemon = True
        except Exception:  # noqa: BLE001 - injected fake timers need not support .daemon
            pass
        self._settle_timer[tid] = timer
        timer.start()

    def _settle_flush(self, tid: str) -> None:
        """Emit a settled trigger's deferred fire — the timer callback and the deadline path both
        land here. Pops the pending args and clears the window, then routes through ``_emit_fire`` so
        throttle, history, last-fired sidecar and the watch-hop animation behave exactly like an
        immediate fire."""
        with self._settle_lock:
            self._settle_timer.pop(tid, None)
            pending = self._settle_pending.pop(tid, None)
            self._settle_first.pop(tid, None)
        if pending is None:
            return
        why, items, node, value = pending
        t = next((x for x in self._profile.triggers if x.id == tid), None)
        if t is None or not t.enabled:
            return
        self._emit_fire(t, why, items, node, value)

    # ---- on_ready: a watched PRODUCER's sweep finished -----------------------

    def on_sweep_done(self, node_id: str) -> list[str]:
        """Fire every ``on_ready`` trigger that watches producer ``node_id`` — its sweep just
        completed and its data is already written. Deterministic: the fire is CAUSED by completion
        (called from the reap via the sweep-done bus), so a toast can never precede the prices. Fires
        once per completion, even if the sweep wrote nothing (the fetch still finished). No timers."""
        if not node_id:
            return []
        fired: list[str] = []
        for t in self._profile.triggers:
            if not t.enabled or t.kind != "on_ready":
                continue
            if node_id not in (t.watch or []):
                continue
            if self._emit_fire(t, f"{node_id} fetched", items=None):
                fired.append(t.id)
                publish_flow(self._profile.name, "watch",
                             f"producer:{node_id}", f"trigger:{t.id}", 1)
        return fired

    # ---- interval ----------------------------------------------------------

    def tick(self) -> list[str]:
        """Fire every interval / true_interval trigger whose interval has elapsed. Returns
        fired ids.

        ``interval`` measures against the monotonic clock, reseeded to "now" whenever the runner
        is (re)built — so a restart or config edit starts a fresh full wait. ``true_interval``
        measures REAL elapsed time against the PERSISTED last-fired timestamp, so its cadence
        continues across restarts/config edits (an overdue trigger fires immediately)."""
        now = self._clock()
        fired: list[str] = []
        fires = None   # persisted last-fired map, read lazily only if a true_interval exists
        for t in self._profile.triggers:
            if not t.enabled:
                continue
            if t.kind == "interval":
                if now - self._last.get(t.id, now) >= t.interval_s:
                    self._last[t.id] = now
                    if self._route_fire(t, f"interval, every {int(t.interval_s)}s", items=None):
                        fired.append(t.id)
            elif t.kind == "true_interval":
                if fires is None:
                    fires = read_fires(self._data_dir, self._profile.name)
                if self._true_interval_due(t, fires.get(t.id)):
                    if self._route_fire(t, f"true interval, every {int(t.interval_s)}s", items=None):
                        fired.append(t.id)
        return fired

    def _true_interval_due(self, t, last_iso: str | None) -> bool:
        """Has ``t``'s real-time interval elapsed since its persisted last fire? Never fired /
        unparseable timestamp = due now (fire immediately, e.g. right after a restart)."""
        if not last_iso:
            return True
        try:
            last = datetime.fromisoformat(last_iso)
        except ValueError:
            return True
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        return (self._wall() - last).total_seconds() >= t.interval_s

    # ---- one-shot lifecycle kinds (app boot / capture start) ---------------

    def fire_app_start(self) -> list[str]:
        """Fire every enabled ``on_app_start`` trigger once (called when the web app boots)."""
        return self._fire_kind("on_app_start", "app start")

    def fire_capture(self) -> list[str]:
        """Fire every enabled ``on_capture`` trigger (called when a live/precapture session starts)."""
        return self._fire_kind("on_capture", "capture start")

    def fire_live_start(self) -> list[str]:
        """Fire every enabled ``on_live_start`` trigger (called when the server live session starts)."""
        return self._fire_kind("on_live_start", "live start")

    def fire_live_stop(self) -> list[str]:
        """Fire every enabled ``on_live_stop`` trigger (called when the server live session stops)."""
        return self._fire_kind("on_live_stop", "live stop")

    def _fire_kind(self, kind: str, why: str) -> list[str]:
        fired: list[str] = []
        for t in self._profile.triggers:
            if not t.enabled or t.kind != kind:
                continue
            if self._route_fire(t, why, items=None):
                fired.append(t.id)
        return fired

    # ---- on_change ---------------------------------------------------------

    def on_change(self, dataset: str | None, changed_records: list[dict],
                  batch: int | None = None) -> list[str]:
        """Fire ``on_change``/``on_any_change``/``on_new_batch`` triggers watching ``dataset``,
        pricing only ``changed_records``. Returns fired trigger ids.

        A DIRECT dataset watch fires whenever the dataset changes (the records ARE new) for
        either kind. A SUBSET watch differs by kind: ``on_change`` fires only when the subset's
        COMPUTED output actually changes — a source update that leaves the join byte-for-byte
        identical (e.g. a price for an item the inventory doesn't hold) is NOT a change to the
        watched data, so it must not fire; ``on_any_change`` skips that check and fires on every
        write reaching the subset, regardless of whether its visible output moved.

        ``changed_records`` may be empty — a clear / removal changed the watched data but leaves
        nothing to price. A direct watch still fires (its data changed); an ``on_change`` subset
        watch fires iff its computed output changed; an ``on_any_change`` subset watch always
        fires. Either way ``_fire_targets`` prices nothing (empty items).

        ``on_new_batch`` (design A, off the change bus) fires once per NEW batch of the changed
        dataset even when the row values are byte-for-byte identical to the previous batch (a
        re-pushed relic screen) — the value-gating on_change/on_any_change apply is exactly what it
        must bypass. ``batch`` is the writing store's batch number (see ``DatasetStore.begin_batch``);
        we fire when it differs from the last batch this trigger fired on for that dataset. A watch
        may be the dataset itself OR a subset that reads it (batches live on the leaf dataset, so a
        subset watch fires on its underlying dataset's batch); only a non-empty ``changed_records``
        fires (a clear/removal announces [] and must not re-sweep). It fires the target with
        ``items=None`` — repricing the producer's whole SOURCE, not ``changed_records`` — because a
        batch's rows confirm across several ticks, so the flush that trips the batch carries only a
        subset of them (see the fire site)."""
        if not dataset:
            return []
        fired: list[str] = []
        items = None
        sig_changed: dict[str, bool] = {}   # watched subset id -> did its output change (this flush)
        stored = read_subset_sigs(self._data_dir, self._profile.name)
        new_sigs: dict[str, str] = {}       # subset id -> fresh sig to persist
        for t in self._profile.triggers:
            if not t.enabled or t.kind not in ("on_change", "on_any_change"):
                continue
            if t.kind == "on_any_change":
                # no output-changed gate: any write reaching a watched dataset/subset justifies.
                justifying = [w for w in t.watch
                              if w == dataset or self._subset_reaches(w, dataset, set())]
            else:
                justifying = [w for w in t.watch
                              if self._watch_justifies(w, dataset, stored, sig_changed, new_sigs)]
            if not justifying:
                continue
            if items is None:
                items = self._items_for(changed_records)
            why = f"{dataset} changed ({len(changed_records)} rows, {len(items)} to price)"
            if not self._route_fire(t, why, items=items):
                continue   # throttled OR deferred into a settle window — no watch-hop animation yet
            # animate the watch hop watched dataset/view -> trigger (the change that fired it
            # flows INTO the trigger), only for the watches that actually justified this fire
            for w in justifying:
                node = f"sub:{w}" if self._profile.subset_def(w) else f"ds:{w}"
                publish_flow(self._profile.name, "watch", node, f"trigger:{t.id}", 1)
            fired.append(t.id)
        # on_new_batch: fire once per new batch of the changed dataset (see docstring). A watch may
        # be the dataset itself OR a subset that (transitively) reads it — batches live on the leaf
        # dataset, so a subset watch fires on ITS underlying dataset's batch, no value/output gate.
        if batch is not None and changed_records:
            for t in self._profile.triggers:
                if not t.enabled or t.kind != "on_new_batch":
                    continue
                justifying = [w for w in (t.watch or [])
                              if w == dataset or self._subset_reaches(w, dataset, set())]
                if not justifying:
                    continue
                key = (t.id, dataset)
                first = self._new_batch_last.get(key) != batch
                self._new_batch_last[key] = batch   # stamp before firing so a throttle can't re-fire
                # A batch's rows CONFIRM over several OCR ticks, arriving as SEPARATE same-batch
                # flushes. With a settle window we RE-ARM on each such flush so the single fire lands
                # once the screen goes QUIET (the whole offering has confirmed) — a short settle_ms
                # then fires ~that long after the LAST row, not a long fixed wait after the first.
                # With no settle window we fire once, on the first flush (skip the rest).
                settling = bool(getattr(t, "settle_ms", 0) or 0)
                if not first and not settling:
                    continue                       # one fire per batch, settle off -> coalesce
                # Fire with items=None (NOT the changed rows): the trip flush carries only the rows
                # confirmed SO FAR, so passing them would price only 1-2 of a relic's 4 rewards.
                # items=None instead reprices the producer's own SOURCE (the user-scoped current-batch
                # view, e.g. the 4 offered rewards), so the sweep prices the whole screen — the same
                # "price the source" semantic interval/lifecycle fires use. (on_change keeps its
                # price-only-changed items.)
                why = f"{dataset} batch #{batch} ({len(changed_records)} rows, reprice source)"
                if not self._route_fire(t, why, items=None):
                    continue   # throttled / deferred into a settle window — no watch-hop animation yet
                for w in justifying:
                    node = f"sub:{w}" if self._profile.subset_def(w) else f"ds:{w}"
                    publish_flow(self._profile.name, "watch", node, f"trigger:{t.id}", 1)
                fired.append(t.id)
        if new_sigs:
            write_subset_sigs(self._data_dir, self._profile.name, {**stored, **new_sigs})
        return fired

    # ---- on_readout -------------------------------------------------------

    @staticmethod
    def _num(v) -> float | None:
        """Coerce a readout value to float, or None if it isn't a number."""
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    @classmethod
    def _readout_meets(cls, op: str, val, thr: float, prev) -> bool:
        """Does ``val`` satisfy ``op thr``? ``crosses_*`` compare against ``prev`` (the
        previous reading) so they detect a transition; the level ops test the value alone
        (the trigger's edge-state stops a held condition from re-firing)."""
        v = cls._num(val)
        if v is None:
            return False
        if op == "gte":
            return v >= thr
        if op == "lte":
            return v <= thr
        if op == "gt":
            return v > thr
        if op == "lt":
            return v < thr
        if op == "eq":
            return v == thr
        if op == "ne":
            return v != thr
        p = cls._num(prev)
        if op == "crosses_up":
            return p is not None and p < thr <= v
        if op == "crosses_down":
            return p is not None and p > thr >= v
        return False

    def set_readouts(self, values: dict) -> None:
        """Cache the latest ``{readout_id: value}`` readings so a toast fired by ANY trigger
        (interval / lifecycle / readout) can interpolate ``{{ro_1}}`` tokens with live values, and a
        gate over a readout can be evaluated at fire time. Called by the collector each tick before
        it evaluates triggers."""
        if values:
            self._readouts_latest.update(values)

    def set_registers(self, snapshot: dict) -> None:
        """Cache the latest ``{register id -> {key -> exposed value}}`` so a gate over a register key
        can be evaluated at fire time on ANY trigger kind. Called by the live session each tick (see
        :meth:`oc.collect.live.LiveSession._feed_registers`). Mirror of :meth:`set_readouts`."""
        if snapshot:
            self._reg_latest = snapshot

    def set_register_rings(self, rings: dict) -> None:
        """Cache each register key's full ring of recent values (``{reg -> {key -> [members
        oldest->newest]}}``) so a COUNT-facet source — ``register:<id>#<key>@count`` (how many held) /
        ``@nonblank`` (how many are not blank, i.e. the ACTUAL values) / ``@distinct`` (how many
        distinct) — can be evaluated at fire time. Pushed each tick alongside :meth:`set_registers` by
        the live session. Guards truthiness like :meth:`set_registers` (an empty push keeps the last)."""
        if rings:
            self._reg_rings = rings

    @staticmethod
    def _split_facet(key: str) -> tuple[str, str]:
        """Split a register key ref into ``(key, facet)``. A trailing ``@<facet>`` selects a COUNT
        over the key's ring of recent values instead of its exposed value; no ``@`` -> ``(key, "")``."""
        k, at, facet = key.partition("@")
        return k, facet if at else ""

    @staticmethod
    def _facet_count(ring, facet: str):
        """How many values a register key's ring holds, per ``facet``. ``None`` when no ring is cached
        (e.g. a headless collector never pushed rings) so a count source simply doesn't hold. ``count``
        = ring depth (every held read, blanks included); ``nonblank`` = members that aren't ``None``/``""``
        (the "actual values"); ``distinct`` = unique non-blank members by text form. Unknown facet ->
        ``None``."""
        if ring is None:
            return None
        if facet == "count":
            return len(ring)
        real = [v for v in ring if v is not None and str(v) != ""]
        if facet == "nonblank":
            return len(real)
        if facet == "distinct":
            return len({str(v) for v in real})
        return None

    # ---- gates: the trigger's value predicate, lifted into reusable nodes -----------------
    # A trigger's ``kind`` supplies the PULSE (when to evaluate); a gate supplies the LEVEL (whether
    # the pulsed value satisfies a condition). Fire = pulse AND every gate holds (checked in
    # _route_fire). Edge ops (crosses_*/changed) compare against _source_prev, which the on_readout /
    # on_register pulse-detectors refresh each tick for the sources they watch — so crosses/changed
    # gates are meant for a source the trigger's own event watches (the common case).

    def _source_value(self, source: str):
        """The current live value a gate/router ``source`` ref points at, or None. ``readout:<id>``
        reads the cached readouts; ``register:<id>#<key>`` reads the cached register snapshot; a bare
        id is treated as a readout (mirrors LiveSession._resolve_source's grammar)."""
        if not source:
            return None
        kind, _, rest = source.partition(":")
        if kind == "readout":
            return self._readouts_latest.get(rest)
        if kind == "register":
            reg, _, key = rest.partition("#")
            if not key:
                return None
            key, facet = self._split_facet(key)
            if facet:   # a count over the key's ring of recent values, not its exposed value
                return self._facet_count((self._reg_rings.get(reg) or {}).get(key), facet)
            return (self._reg_latest.get(reg) or {}).get(key)
        return self._readouts_latest.get(source)

    def _cond_holds(self, cond, value, prev) -> bool:
        """Does one :class:`~oc.profile.models.GateCond` hold for ``value`` (``prev`` = its previous
        reading, for the edge ops)? Numeric / edge ops reuse :meth:`_readout_meets` (+ between +
        changed); text / shape ops defer to :func:`oc.collect.fields._matches` — one predicate set."""
        when = getattr(cond.when, "value", cond.when)
        arg = cond.arg or ""
        if when == "always":
            return True
        if when == "changed":
            v = self._num(value)
            return v is not None and v != self._num(prev)
        if when == "between":
            v = self._num(value)
            nums = [n for n in (self._num(x) for x in arg.split(",")) if n is not None]
            if v is None or len(nums) < 2:
                return False
            lo, hi = sorted(nums[:2])
            return lo <= v <= hi
        if when in ("gte", "lte", "gt", "lt", "eq", "ne", "crosses_up", "crosses_down"):
            thr = self._num(arg)
            return thr is not None and self._readout_meets(when, value, thr, prev)
        from ..profile.models import RuleWhen
        from .fields import _matches
        try:
            rw = RuleWhen(when)
        except ValueError:
            return False
        return _matches(rw, "" if value is None else str(value), arg)

    def _condset_holds(self, source: str, conds, logic: str) -> bool:
        """Evaluate a condition set (a gate, or one router branch) against ``source``'s live value.
        Empty ``conds`` -> True (an always-match, e.g. a router's ``else`` branch)."""
        if not conds:
            return True
        value = self._source_value(source)
        prev = self._source_prev.get(source)
        results = [self._cond_holds(c, value, prev) for c in conds]
        return all(results) if (logic or "or") == "and" else any(results)

    def _gate_holds(self, gate) -> bool:
        """Does a gate pass? ``negate`` flips it (a block-list). A disabled gate is a no-op (passes)."""
        if not getattr(gate, "enabled", True):
            return True
        held = self._condset_holds(gate.source, gate.conds, gate.logic)
        return (not held) if getattr(gate, "negate", False) else held

    def _gates_pass(self, t) -> bool:
        """Do ALL gates a trigger references hold (AND across gates)? No gates -> pass. A missing gate
        id is skipped (a dangling ref must not permanently wedge a trigger)."""
        gate_ids = getattr(t, "gates", None)
        if not gate_ids:
            return True
        by_gate = {g.id: g for g in getattr(self._profile, "gates", [])}
        for gid in gate_ids:
            g = by_gate.get(gid)
            if g is not None and not self._gate_holds(g):
                return False
        return True

    def _source_node(self, source: str) -> str | None:
        """The GRAPH NODE id a gate/router ``source`` ref points at (for the flow animation), mirroring
        the front-end model.refNode: ``readout:<id>`` -> ``ro:<win>:<id>``; ``register:<id>#<key>``
        -> ``register:<id>``. None if unresolvable."""
        if not source:
            return None
        kind, _, rest = source.partition(":")
        if kind == "readout":
            win = self._readout_window(rest)
            return f"ro:{win}:{rest}" if win else None
        if kind == "register":
            return f"register:{rest.split('#')[0]}"
        return None

    def emit_gate_flow(self) -> None:
        """Animate the value that flips a gate's decision: a ``data`` blob source -> gate on the tick
        its pass/block result FLIPS. Called each live tick; an unchanged result emits nothing, so a
        steady value never spams the flow layer. First sight of a gate seeds its state without a blob.
        The gate -> trigger decision is NOT a blob — the graph tints that line ok/danger by live pass/
        block instead (see :meth:`gate_states`), so nothing streams from a gate to its triggers here."""
        gates = getattr(self._profile, "gates", None)
        if not gates:
            return
        game = self._profile.name
        for g in gates:
            if not getattr(g, "enabled", True):
                continue
            holds = self._gate_holds(g)
            prev = self._gate_prev.get(g.id)
            self._gate_prev[g.id] = holds
            if prev is None or holds == prev:
                continue   # seed, or no flip -> no animation
            src = self._source_node(g.source)
            if src:
                publish_flow(game, "data", src, f"gate:{g.id}", 1)

    def gate_states(self) -> dict[str, bool]:
        """Per-gate live pass/block: ``{gate_id: holds}`` for every ENABLED gate, evaluated against
        the live caches. ``True`` = the gate currently PASSES, ``False`` = it BLOCKS. A display hint —
        the graph tints each gate -> trigger line ok (pass) / danger (block); disabled gates are
        omitted (the line stays grey, as it does when live is off)."""
        return {g.id: self._gate_holds(g) for g in (getattr(self._profile, "gates", None) or [])
                if getattr(g, "enabled", True)}

    def gated_ids(self) -> list[str]:
        """Ids of enabled, gated triggers whose gates currently BLOCK them (evaluated against the
        live caches). A display hint: the activity snapshot flags these nodes as 'gated off' while
        live is running, so a glance at the graph shows which cues are silenced right now."""
        return [t.id for t in self._profile.triggers
                if t.enabled and getattr(t, "gates", None) and not self._gates_pass(t)]

    def _resolve_fire(self, t) -> tuple[list[str], list[str]]:
        """Expand ``t.targets`` THROUGH any router into ``(fire_ids, sound_ids)``: server targets
        (producer/file-source/toast/action) to fire now, and sound ids to name in the fire cue (the
        browser plays those). A router forwards its FIRST matching branch's targets (a branch with no
        conds matches always); a disabled router forwards nothing. Direct sound targets land in
        ``sound_ids`` too, so the cue always carries the full set the client should play. A disabled
        sound is dropped entirely (never played, never a phantom fire_id) — its ``enabled`` flag is
        honored here since sounds are client-played off the fire cue, not dispatched in ``_fire_targets``."""
        by_router = {r.id: r for r in getattr(self._profile, "routers", [])}
        sound_set = {s.id for s in getattr(self._profile, "sounds", [])}
        off_sounds = {s.id for s in getattr(self._profile, "sounds", []) if not getattr(s, "enabled", True)}
        fire_ids: list[str] = []
        sound_ids: list[str] = []

        def add(tid: str) -> None:
            if tid in off_sounds:
                return   # disabled sound: not played, and not a stray fire_id
            if tid in sound_set:
                if tid not in sound_ids:
                    sound_ids.append(tid)
            elif tid not in fire_ids:
                fire_ids.append(tid)

        for tid in t.targets or []:
            r = by_router.get(tid)
            if r is None:
                add(tid)
                continue
            if not getattr(r, "enabled", True):
                continue
            for b in r.branches or []:
                if self._condset_holds(r.source, b.conds, b.logic):
                    for x in b.targets or []:
                        add(x)
                    break   # first match wins
        return fire_ids, sound_ids

    def on_readout(self, values: dict) -> list[str]:
        """Pulse every ``on_readout`` trigger whose watched readout MOVED this tick, then fire it if
        its gates hold (:meth:`_route_fire`). ``values`` is ``{readout_id: value}`` read this tick.

        A move (value differs from last tick) is the pulse — a static held reading never re-fires,
        exactly as the old edge-triggering did; the VALUE condition is now a gate over the readout.
        The first sighting (no prev) counts as a move, so a trigger fires on ENTERING a condition."""
        if not values:
            return []
        self.set_readouts(values)   # a readout-fired toast interpolates the freshest values
        fired: list[str] = []
        for t in self._profile.triggers:
            if not t.enabled or t.kind != "on_readout":
                continue
            moved = next((w for w in t.readout_watch if w in values
                          and self._num(values[w]) != self._source_prev.get(f"readout:{w}")), None)
            if moved is None:
                continue
            if self._route_fire(t, f"readout {moved}", items=None, node=moved, value=values[moved]):
                fired.append(t.id)
                # animate the watch hop readout -> trigger (the reading flows INTO the trigger),
                # mirroring the on_change watch hop. Matches the drawn watch edge ro:<win>:<id>.
                win = self._readout_window(moved)
                if win:
                    publish_flow(self._profile.name, "watch", f"ro:{win}:{moved}", f"trigger:{t.id}", 1)
        # remember this tick's readings so crosses_*/changed gates + the move-pulse see the transition
        for w, v in values.items():
            n = self._num(v)
            if n is not None:
                self._source_prev[f"readout:{w}"] = n
        return fired

    # ---- on_register ------------------------------------------------------

    def on_register(self, events: list[dict], snapshot: dict) -> list[str]:
        """Pulse every ``on_register`` trigger a watched register key MOVED for this tick, then fire
        it if its gates hold (:meth:`_route_fire`).

        ``events`` is ``[{"reg", "key", "value"}, ...]`` for the keys whose exposed value moved this
        tick (the value-gate is done upstream in :meth:`oc.collect.live.LiveSession._feed_registers`)
        — that move IS the pulse. ``snapshot`` is ``{reg: {key: exposed_value}}`` for every held key.
        The per-key VALUE condition is now a gate over ``register:<id>#<key>``; this handler only
        detects the pulse and defers the predicate to :meth:`_gates_pass`."""
        self.set_registers(snapshot)
        if not events:
            self._update_register_prev(snapshot)
            return []
        watched_moves = [(e["reg"], e["key"], e.get("value")) for e in events]
        fired: list[str] = []
        for t in self._profile.triggers:
            if not t.enabled or t.kind != "on_register":
                continue
            watched = set(t.register_watch or [])
            hit = next(((reg, key, val) for reg, key, val in watched_moves if reg in watched), None)
            if hit is None:
                continue
            hit_reg, hit_key, hit_val = hit
            if self._route_fire(t, f"register {hit_reg}.{hit_key}", items=None,
                                node=hit_reg, value=hit_val):
                fired.append(t.id)
                # animate the watch hop register -> trigger (mirrors the on_readout / on_change hops).
                publish_flow(self._profile.name, "watch", f"register:{hit_reg}", f"trigger:{t.id}", 1)
        self._update_register_prev(snapshot)
        return fired

    def _update_register_prev(self, snapshot: dict) -> None:
        """Remember this tick's exposed register values so crosses_*/changed gates see the transition
        next tick (keyed by the ``register:<reg>#<key>`` source ref). Also stamps each key's ring
        COUNTS (``@count``/``@nonblank``/``@distinct``) so an edge gate over a count sees its previous
        value too."""
        for reg, keys in (snapshot or {}).items():
            for k, v in keys.items():
                n = self._num(v)
                if n is not None:
                    self._source_prev[f"register:{reg}#{k}"] = n
        for reg, keys in (self._reg_rings or {}).items():
            for k, ring in keys.items():
                for facet in ("count", "nonblank", "distinct"):
                    c = self._facet_count(ring, facet)
                    if c is not None:
                        self._source_prev[f"register:{reg}#{k}@{facet}"] = float(c)

    # ---- helpers -----------------------------------------------------------

    def _readout_window(self, rid: str) -> str | None:
        """The window id owning readout ``rid`` (its graph node is ``ro:<win>:<rid>``), or None.
        Used to address the watch-hop flow blob at the readout's drawn edge."""
        for w in self._profile.windows:
            for v in getattr(w, "readouts", None) or []:
                if v.id == rid:
                    return w.id
        return None

    def _watch_justifies(self, w: str, dataset: str, stored: dict,
                         sig_changed: dict, new_sigs: dict) -> bool:
        """Does watch ``w`` justify firing for a change to ``dataset``?
        A direct dataset match always does; a subset only if its output changed (memoised in
        ``sig_changed`` per flush, fresh sig staged into ``new_sigs`` to persist)."""
        if w == dataset:
            return True
        if not self._subset_reaches(w, dataset, set()):
            return False
        if w not in sig_changed:
            cur = self._subset_sig(w)
            # cur is None only on a compute error -> fall back to firing (old always-fire
            # behaviour), and don't poison the stored baseline with a bad sig.
            sig_changed[w] = cur is None or stored.get(w) != cur
            if cur is not None:
                new_sigs[w] = cur
        return sig_changed[w]

    def _subset_sig(self, sid: str) -> str | None:
        """Hash of subset ``sid``'s VISIBLE output — only the columns the view actually shows.

        Crucially the hash is over the projected (column-restricted) rows, NOT the raw row dicts:
        ``compute_view`` strips bookkeeping cols (``present``/``_batch``/…) but a row still carries
        every JOINED column, including ones the subset HID (``updated``, ``live_median``, …). A
        price refresh rewrites such hidden timestamps every few seconds without changing anything
        the user sees — hashing the full dict would flip the sig and fire the trigger constantly.
        Projecting to ``columns`` makes the sig track only the watched data. ``None`` on any
        compute error."""
        view = self._subset_view(sid)
        if view is None:
            return None
        cols = view["columns"]
        visible = [{c: r.get(c) for c in cols} for r in view["rows"]]
        blob = json.dumps(visible, sort_keys=True, default=str).encode("utf-8")
        return hashlib.sha256(blob).hexdigest()

    def _subset_view(self, sid: str) -> dict | None:
        """Compute subset ``sid`` (``{"columns", "rows"}``) via the same store fetch the change-bus
        firer uses, so on_change gating and the on_ready gate see identical rows. ``None`` on any
        compute error (a non-subset id, a bad join). Rows carry every joined column, not just the
        visible ones — project to ``columns`` when a stable/visible view is needed (see _subset_sig)."""
        from ..enrich.subset import compute_view_rows
        from ..store import rows_at, store_for
        try:
            fetch = lambda ds, agg: rows_at(store_for(  # noqa: E731
                self._data_dir, self._profile.name, ds, profile=self._profile,
                aggregate="latest" if agg == "all" else agg), agg, present_only=True)
            return compute_view_rows(self._profile, sid, fetch)
        except Exception:  # noqa: BLE001 - a bad compute must never crash the firer
            return None

    def _subset_reaches(self, sid: str, dataset: str, seen: set) -> bool:
        """Does view ``sid`` read ``dataset`` through its (transitive) inputs?"""
        if sid in seen:
            return False
        seen.add(sid)
        sub = self._profile.subset_def(sid)
        if sub is None:
            return False
        for inp in sub.inputs():
            if inp == dataset or self._subset_reaches(inp, dataset, seen):
                return True
        return False

    def _items_for(self, records: list[dict]) -> list[str]:
        """Unique item names among the changed records — the producer applies its own key
        transform (a generic ``http`` node has no notion of a slug here)."""
        seen: dict[str, None] = {}
        for r in records:
            n = r.get("name")
            if n and str(n) not in seen:
                seen[str(n)] = None
        return list(seen.keys())

    def _fire_targets(self, trigger, target_ids, items) -> None:
        """Dispatch each resolved target id by what owns it: a producer sweeps/refreshes, a file
        source reads, a toast node raises an OS notification, and an action node clears/clones/moves
        a dataset (sounds are skipped here — the web UI plays them client-side). ``target_ids`` is
        the flat, router-resolved list (see :meth:`_resolve_fire`), NOT ``trigger.targets``."""
        by_producer = {p.id: p for p in self._profile.producers}
        by_source = {s.id: s for s in self._profile.file_sources}
        by_toast = {x.id: x for x in getattr(self._profile, "toasts", [])}
        by_action = {x.id: x for x in getattr(self._profile, "actions", [])}
        for tid in target_ids:
            if tid in by_producer:
                # items == [] means an on_change fire with nothing to price (a clear / removal):
                # skip the sweep (items=None would price the WHOLE dataset — wrong). interval /
                # lifecycle fires pass items=None and still sweep here.
                if items == []:
                    continue
                fire_target(self._profile.name, by_producer[tid], items,
                            trigger_id=trigger.id, fire=self._fire)
            elif tid in by_source:
                self._read_source(by_source[tid], trigger.id)
            elif tid in by_toast:
                fire_toast(self._profile.name, by_toast[tid], self._notifier,
                           trigger_id=trigger.id, values=self._readouts_latest,
                           data_dir=self._data_dir, profile=self._profile)
            elif tid in by_action:
                fire_action(self._profile.name, by_action[tid], self._data_dir,
                            profile=self._profile, trigger_id=trigger.id)

    def _read_source(self, source, trigger_id: str) -> None:
        """Fire a file-source target via the shared funnel (see :func:`read_source_target`)."""
        read_source_target(self._profile.name, source, self._data_dir,
                           profile=self._profile, trigger_id=trigger_id)

    def _default_fire(self, price_node, items) -> None:
        start_sweep(self._data_dir, self._profile.name, price_node,
                    profile=self._profile, items=items)


def fire_target(game: str, price_node, items, *, trigger_id: str,
                fire: Callable[[object, object], None]) -> bool:
    """Fire ONE price-node target of a trigger — the single funnel every fire path uses
    (collector interval/on_change AND the web "fire now" route), so the per-fire side effects
    never drift between callers. Skips a node whose sweep is already running; on a real fire it
    runs ``fire`` then emits the trigger->price control pulse. Returns True if it fired.

    ``fire(price_node, items)`` performs the actual sweep start (injectable for tests / so the
    web route can supply its own data_dir/profile). ``record_fire`` stays with the CALLER — it's
    a per-trigger stamp, fired once after all targets, not per target."""
    if price_node is None or not getattr(price_node, "enabled", False):
        return False
    # A node whose sweep is already running: with queue_mode "drop" (default) skip up front so a
    # busy node is never disturbed. With "latest"/"queue" DON'T skip — let start_sweep enqueue the
    # new batch so it runs when the current sweep finishes.
    mode = getattr(price_node, "queue_mode", "drop") or "drop"
    if mode == "drop" and sweep_status(game, price_node.dataset).get("running"):
        logev(f"  -> {price_node.id} skipped (already sweeping)", level="info", game=game)
        return False
    try:
        fire(price_node, items)
        publish_flow(game, "trigger", f"trigger:{trigger_id}", f"producer:{price_node.id}", 1)
        return True
    except Exception:   # a misbehaving fire must never crash the collector loop / a request
        return False


def toast_spec(toast, values: dict | None = None, *, data_dir=None, profile=None, game=None):
    """Build the :class:`oc.interfaces.ToastSpec` for a toast node, interpolating its
    title/message/attribution ``{{tokens}}`` — the ONE place a toast's text is rendered, shared by
    the fire funnel and the test route so a test toast reads identically to a fired one.

    ``values`` is the live ``{readout_id: value}`` map (``{{readout:id}}`` / bare tokens). When
    ``data_dir`` + ``profile`` are supplied the context ALSO resolves ``{{dataset:...}}`` /
    ``{{subset:...}}`` tokens against the current stored records, mirroring the pretty page.
    ``app_name``/``icon`` are literal. The styled ``texts`` blocks each render their own tokens;
    when a toast has no blocks the legacy ``title``/``message`` are rendered instead (the notifier
    falls back to them)."""
    from ..interfaces import ToastSpec, ToastText
    from .templating import TokenContext, render
    game = game or getattr(profile, "name", None)
    ctx = TokenContext(values, data_dir=data_dir, profile=profile, game=game)
    texts = [ToastText(content=render(t.content, ctx), style=t.style, align=t.align,
                       max_lines=t.max_lines)
             for t in getattr(toast, "texts", None) or []]
    hero, inline = _render_toast_images(toast, ctx, data_dir, game)
    # Replace-by-tag identity: a set (token-rendered) replace_key posts the toast under a stable
    # Windows tag so a later fire REPLACES the visible notification in place instead of stacking.
    # Tag is hashed to respect Windows' 64-char tag limit; group is the game (deterministic).
    tag = group = ""
    rkey = render(getattr(toast, "replace_key", "") or "", ctx).strip()
    if rkey:
        tag = hashlib.sha1(rkey.encode("utf-8")).hexdigest()[:16]  # noqa: S324 - identity, not crypto
        group = str(game or "")
        # Accumulating body: append this fire's text blocks + inline images to the persisted tally
        # (keyed by rkey) and render the WHOLE tally, so the toast GROWS instead of wiping (the rich
        # relic card is an inline image, so the image tally is the part that grows). The tagged
        # re-show RE-POPS a banner each fire (the user wants to SEE the update) while replace-by-tag
        # keeps the Action Center at one entry. Server-side JSON + snapshot PNGs only — no WinRT
        # handle held (the original lock-up hazard); the OCR/settle gates stop a single screen's
        # jitter from firing more than once, so one screen = one pop.
        if getattr(toast, "accumulate", False) and data_dir is not None:
            from ..notify import toast_accum
            blocks = [{"content": t.content, "style": t.style, "align": t.align,
                       "max_lines": t.max_lines} for t in texts]
            flat_blocks, inline = toast_accum.append(
                data_dir, game, rkey, blocks, inline,
                int(getattr(toast, "accumulate_cap", 10) or 0))
            texts = [ToastText(content=b.get("content", ""), style=b.get("style", ""),
                               align=b.get("align", ""), max_lines=b.get("max_lines", 0) or 0)
                     for b in flat_blocks]
    return ToastSpec(
        title=render(toast.title, ctx),
        message=render(toast.message, ctx),
        texts=texts,
        app_name=toast.app_name, duration=toast.duration, icon=toast.icon,
        show_icon=getattr(toast, "show_icon", True),
        attribution=render(toast.attribution, ctx), muted=toast.muted,
        hero_image=hero, inline_images=inline, tag=tag, group=group)


def _render_toast_images(toast, ctx, data_dir, game):
    """Render each of the toast's images to a stable per-toast cache PNG, grouped by placement.
    Returns ``(hero_path, [inline_paths])`` — the FIRST ``hero``-placed image wins the single hero
    slot; ``inline`` images stack in order; ``none`` is skipped. Paths are absolute (the notifier
    turns them into ``file://`` URIs, which reject a relative path). Overwritten each fire so the
    live token values are fresh."""
    if not data_dir:
        return "", []
    from pathlib import Path

    from ..notify.toast_image import render_to_file
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in f"{game}_{toast.id}")
    base = Path(data_dir) / str(game) / ".toast_images"
    hero, inline = "", []
    for idx, spec in enumerate(getattr(toast, "images", None) or []):
        place = getattr(spec, "placement", "none")
        if place == "none" or (place == "hero" and hero):   # skip disabled + extra hero images
            continue
        out = render_to_file(spec, ctx, base / f"{safe}_img{idx}.png")
        if not out:
            continue
        if place == "hero":
            hero = str(out.resolve())
        else:
            inline.append(str(out.resolve()))
    return hero, inline


def fire_toast(game: str, toast, notifier, *, trigger_id: str, values: dict | None = None,
               data_dir=None, profile=None) -> bool:
    """Fire ONE toast-node target — the single funnel both the collector dispatch and the web
    fire route use, so a manual fire behaves identically to an automatic one. Builds the spec
    (interpolating its ``{{tokens}}`` against ``values`` + any wired datasets/subsets) and hands it
    to the ``notifier``, then emits the trigger->toast control pulse. A disabled node or a missing
    notifier is a no-op; the notifier itself swallows OS errors, so this never crashes a fire.
    Returns True if raised."""
    if toast is None or not getattr(toast, "enabled", True) or notifier is None:
        return False
    try:
        notifier.notify(toast_spec(toast, values, data_dir=data_dir, profile=profile, game=game))
    except Exception:   # noqa: BLE001 - a misbehaving notifier must never crash the loop / a request
        return False
    publish_flow(game, "trigger", f"trigger:{trigger_id}", f"toast:{toast.id}", 1)
    return True


def fire_action(game: str, action, data_dir, *, profile, trigger_id: str | None = None) -> bool:
    """Fire ONE action-node target of a trigger — run its op (clear/clone/move) on each of its
    ``sources``, which are prefixed refs naming DATASETS (``"dataset:<id>"``) and/or REGISTERS
    (``"register:<id>"``). The single funnel both the collector dispatch and the web fire-now route
    use, so automatic and manual fires can't drift (the action node is fired via ``targets`` exactly
    like a toast). Emits the trigger->action control pulse, then each action->target pulse (inside
    :func:`oc.store.dataset_ops.fire_dataset_target` / :func:`oc.collect.register_ops.
    fire_register_target`). A disabled / actionless node is a no-op. A register source needs a live
    session holding its map — resolved here; with none, register ops are a graceful no-op. Returns
    True if it ran on any source."""
    if action is None or not getattr(action, "enabled", True) or not getattr(action, "action", ""):
        return False
    # a manual web fire has no trigger node (trigger_id is None), so skip the trigger->action
    # control pulse — the action->target pulses inside the funnels still fire.
    if trigger_id:
        publish_flow(game, "trigger", f"trigger:{trigger_id}", f"action:{action.id}", 1)
    from ..store.dataset_ops import fire_dataset_target
    from .register_ops import fire_register_target
    from .live import active_session
    session = None
    ran = False
    for ref in getattr(action, "sources", []):
        kind, _, rid = ref.partition(":")
        if kind == "dataset":
            if fire_dataset_target(game, data_dir, profile, action, rid):
                ran = True
        elif kind == "register":
            if session is None:
                session = active_session(game)
            if fire_register_target(game, data_dir, profile, session, action, rid):
                ran = True
    return ran


def read_source_target(game: str, source, data_dir, *, profile, trigger_id: str) -> bool:
    """Fire ONE file-source target of a trigger — the single funnel every fire path uses
    (collector interval/on_change AND the web "fire now" route), the file-source analogue of
    :func:`fire_target`. Reads the source then emits the trigger->source control pulse. A
    misbehaving read must never crash the loop / a request. Returns True if the read ran."""
    from ..source.runner import read_source
    try:
        read_source(game, source, data_dir, profile=profile)
        publish_flow(game, "trigger", f"trigger:{trigger_id}", f"src:{source.id}", 1)
        return True
    except Exception:   # noqa: BLE001
        return False
