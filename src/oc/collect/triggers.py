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
* ``on_input``     — pulse on a keyboard/mouse event matching a chord/rect/window (:meth:`on_input`),
  called from an :class:`oc.interfaces.InputSource` hook thread. LIVE ONLY (see :mod:`oc.collect.live`).
* ``on_item``      — pulse when ``item_watch`` (a template in ``window_watch[0]``) is detected/kept
  this tick (:meth:`note_items`), e.g. fire the instant a "terminator" placeholder item is read.
* ``on_window_detected``/``on_window_undetected`` — pulse on a ``window_watch`` window becoming/
  ceasing to be the currently-recognized one (:meth:`note_window`).
* ``on_window_data_start``/``on_window_data_stop`` — pulse on a ``window_watch`` window's dataset
  producing again after a quiet spell / going quiet after producing (:meth:`note_window_data`,
  the quiet check in :meth:`tick`). ``on_window_data_stop`` reuses ``settle_ms`` as the quiet-
  before-fire duration itself, not as a trailing debounce of an already-decided fire — so it
  fires via a direct gate-check + emit (:meth:`_fire_gate_ok`), bypassing :meth:`_route_fire`'s
  settle-defer branch (which would otherwise apply a SECOND quiet wait on top).
* ``manual``       — never auto-fires (the sweep button drives it); declared only for wiring.

A trigger ``target`` is a price-node id, a file-source id, a toast/sound id, OR an action id:
pricing nodes sweep the market, file sources read a log/config file, toasts/sounds notify, and an
action node does whatever is wired into it — clear/clone/move a dataset or register, cue a sound,
fire another action (see :class:`oc.profile.models.ActionDef`, :func:`fire_action` and
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


# Default quiet-before-fire duration for on_window_data_stop when the trigger's own settle_ms is
# unset — a window that's produced data must go this long without producing more before the
# "stopped producing" edge fires. Deliberately generous (a slow OCR confirm cadence between
# genuinely-still-open reads must not misfire this as "stopped").
DEFAULT_WINDOW_QUIET_MS = 2000.0


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
        # Previous value per source ref ("readout:<id>" / "register:<reg>#<key>" / "dataset:<id>" /
        # "subset:<id>") — the one store the gate edge ops (crosses_up/crosses_down/changed) and the
        # on_readout move-pulse compare against. Numeric for readout/register (updated at the end of
        # on_readout / on_register, mirrors the old _readout_prev / _register_prev, unified by source
        # string); a dataset/subset source's value is a content-hash STRING instead (see
        # _dataset_sig/_subset_sig), refreshed only when a trigger referencing it actually fires
        # (_emit_fire) — a dataset/subset has no per-tick pulse the way a readout/register does, so
        # "changed" here means "changed since the last fire", not "changed this tick".
        self._source_prev: dict[str, float | str] = {}
        # Previous pass/block result per gate id — so emit_gate_flow animates a blob only when a
        # gate's decision FLIPS (a steady value never spams the flow layer). Seeded on first sight.
        self._gate_prev: dict[str, bool] = {}
        # Previous SELECTED BRANCH index per router id (None = no branch matched) — so
        # emit_router_flow logs a route-history row only when the selection CHANGES (mirrors
        # _gate_prev). Seeded on first sight.
        self._router_prev: dict[str, int | None] = {}
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
        # Fire-once-per-SCREEN state for on_new_batch (guarded by _settle_lock, keyed (trigger, ds)).
        # A "screen" is a run of watched flushes with no gap longer than the trigger's settle span;
        # one physical relic screen can drip across several ticks AND (on an OCR dropout) mint more
        # than one batch number, so batch-number-alone double-fires. _last_flush_at times the gaps;
        # _screen_fired_at is stamped on the actual emit (not on route, so a still-settling burst
        # keeps re-arming) and suppresses every later flush of the same screen — same-batch drips,
        # the settle_max re-arm, and reopen-split batches all coalesce to one fire. _settle_key
        # carries the screen key into _settle_flush so the deferred emit stamps the right screen
        # without threading (dataset, batch) through the shared _emit_fire.
        self._last_flush_at: dict[tuple[str, str], float] = {}
        self._screen_fired_at: dict[tuple[str, str], float] = {}
        self._settle_key: dict[str, tuple[str, str]] = {}
        # trailing-settle debounce state (guarded by _settle_lock). For a trigger with settle_ms:
        # the pending fire args (kept latest-wins), the live timer, and the monotonic time the
        # current window opened (for the settle_max_ms deadline). A fire is deferred while the
        # window keeps re-arming and emitted once it quiets (or the deadline hits).
        self._settle_lock = threading.Lock()
        self._settle_pending: dict[str, tuple] = {}   # id -> (why, items, node, value)
        self._settle_timer: dict[str, object] = {}    # id -> Timer
        self._settle_first: dict[str, float] = {}     # id -> window-open monotonic time
        # ---- on_input state (see the "on_input" section below) ----
        # Currently-recognized window id + its client box (x,y,w,h), pushed each live tick by
        # set_input_context — an on_input trigger's window/rect gate reads this, never the
        # collector's own state directly (the hook fires on its own thread).
        self._input_context: dict = {"window": None, "box": None}
        # Every key/mouse button currently held, as "key:<name>"/"mouse:<name>" tokens — GLOBAL
        # system state, not per-trigger. Used both for chord checks (a trigger's input_mods) and
        # to suppress OS key-repeat (a held button re-fires WM_KEYDOWN every repeat interval; only
        # the first — the token entering this set — is a real edge).
        self._input_held: set[str] = set()
        # Per-trigger: did the button's matching DOWN edge pass chord+window/rect (so a
        # subsequent UP can complete a "press"/"double" cycle)? Popped on the matching up.
        self._input_down_match: dict[str, bool] = {}
        # Per-trigger: monotonic time of the last completed matching press, for "double" detection.
        self._input_last_press: dict[str, float] = {}
        # ---- window-scoped kinds (on_item / on_window_detected/undetected / on_window_data_*) ----
        # The currently-recognized window id (None = no/unrecognised screen), so note_window can
        # tell a genuine detected<->undetected transition from a repeat call with the same window.
        self._cur_window: str | None = None
        # Window ids currently "producing" (have written data and haven't yet gone quiet for their
        # on_window_data_stop trigger's threshold) — set on note_window_data, cleared once tick()'s
        # quiet check fires on_window_data_stop for that window (re-arms on the next data).
        self._win_active: set[str] = set()
        # Monotonic time of each window's last note_window_data call — what the quiet check in
        # tick() measures elapsed time against.
        self._win_last_data: dict[str, float] = {}

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
        from . import sound_history
        from .trigger_history import record as record_hist
        ts = self._wall().isoformat(timespec="milliseconds")
        if self._throttled(t):
            logev(f"trigger {t.id} throttled ({why})", level="info", game=self._profile.name)
            record_hist(self._profile.name, t.id, why=why, targets=list(t.targets),
                        throttled=True, ts=ts, node=node, value=value)
            return False
        logev(f"trigger {t.id} fired ({why})", level="run", game=self._profile.name)
        slog(f"trigger {t.id} fired ({why})", game=self._profile.name)
        self._advance_content_gate_baselines(t)
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
        for sid in sound_ids:
            sound_history.record(self._profile.name, sid, ts=ts, trigger=t.id)
        record_hist(self._profile.name, t.id, why=why, targets=list(t.targets),
                    throttled=False, ts=ts, node=node, value=value)
        self._last_fire_any[t.id] = self._clock()
        return True

    # ---- trailing-settle debounce (mirror of throttle) ---------------------

    def _fire_gate_ok(self, t, why: str, node: str = "", value: object = None) -> bool:
        """Does ``t``'s value predicate (its wired gates) hold right now? A block is recorded to
        history exactly like a throttle-suppression, so the UI shows why a pulsed trigger didn't
        fire. Factored out of :meth:`_route_fire` so a kind whose OWN timing already means "wait
        for quiet" (``on_window_data_stop`` reusing ``settle_ms`` as its threshold — see
        :meth:`tick`) can gate-check and fire immediately without also going through
        ``_route_fire``'s settle-defer branch, which would apply a second, redundant quiet wait."""
        if self._gates_pass(t):
            return True
        from .trigger_history import record as record_hist
        logev(f"trigger {t.id} gated ({why})", level="info", game=self._profile.name)
        record_hist(self._profile.name, t.id, why=why, targets=list(t.targets),
                    throttled=True, ts=self._wall().isoformat(timespec="milliseconds"),
                    node=node, value=value)
        return False

    def _route_fire(self, t, why: str, items, node: str = "", value: object = None) -> bool:
        """Auto-fire entry point. With no ``settle_ms`` this is just ``_emit_fire`` (fire now). With
        ``settle_ms`` set, the fire is DEFERRED into a trailing window: the latest args are stashed
        (latest-wins) and a timer (re)armed, so a burst of justified fires — a sweep dripping rows,
        several sequential sweeps as OCR settles — collapses into ONE ``_emit_fire`` once the watched
        data goes quiet (or ``settle_max_ms`` elapses). Returns True only for a SYNCHRONOUS fire; a
        deferred fire returns False and lands later via ``_settle_flush``. Manual "fire now" does not
        route here — it bypasses settle exactly as it bypasses throttle."""
        if not self._fire_gate_ok(t, why, node, value):
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
            skey = self._settle_key.pop(tid, None)   # on_new_batch screen key (None for other kinds)
            # Stamp the on_new_batch screen NOW, before releasing the lock to emit (see
            # _screen_fired_at): a drip that lands during the lock-free _emit_fire below must see the
            # screen already fired and coalesce, never re-arm a fresh timer -> double fire. A
            # throttle-suppressed emit rolls it back below so the screen can still fire later.
            if skey is not None:
                self._screen_fired_at[skey] = self._clock()
        if pending is None:
            return
        why, items, node, value = pending
        t = next((x for x in self._profile.triggers if x.id == tid), None)
        if t is None or not t.enabled:
            return
        fired = self._emit_fire(t, why, items, node, value)
        if skey is not None and not fired:      # throttled -> undo the optimistic screen stamp
            with self._settle_lock:
                self._screen_fired_at.pop(skey, None)

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

    # ---- window-scoped kinds: on_item / on_window_detected/undetected / on_window_data_* ---

    def note_window(self, window_id: str | None) -> list[str]:
        """Called once per real (classified) tick with the currently-recognized window id (None =
        no/unrecognised screen this tick — see the collector's feed site, which skips the call
        entirely on an ambiguous pre-classify throttled tick rather than pass a false None here).
        Fires ``on_window_undetected`` for the window just LEFT and ``on_window_detected`` for the
        window just ENTERED, on a genuine transition only (a repeat call with the same id is a
        no-op, so a steady screen doesn't re-fire every tick)."""
        if window_id == self._cur_window:
            return []
        old, self._cur_window = self._cur_window, window_id
        fired: list[str] = []
        for t in self._profile.triggers:
            if not t.enabled:
                continue
            if t.kind == "on_window_undetected" and old and old in (t.window_watch or []):
                if self._route_fire(t, f"{old} no longer detected", items=None):
                    fired.append(t.id)
                    publish_flow(self._profile.name, "watch", f"win:{old}", f"trigger:{t.id}", 1)
            elif t.kind == "on_window_detected" and window_id and window_id in (t.window_watch or []):
                if self._route_fire(t, f"{window_id} detected", items=None):
                    fired.append(t.id)
                    publish_flow(self._profile.name, "watch", f"win:{window_id}", f"trigger:{t.id}", 1)
        return fired

    def note_window_data(self, window_id: str) -> list[str]:
        """Called when a tick produced new/changed rows for ``window_id``. Stamps the window's
        last-data time (what the quiet check in :meth:`tick` measures against) and fires
        ``on_window_data_start`` triggers watching it the moment it transitions from quiet to
        producing (not on every subsequent row — a dripping sweep must not re-fire every tick)."""
        self._win_last_data[window_id] = self._clock()
        if window_id in self._win_active:
            return []
        self._win_active.add(window_id)
        fired: list[str] = []
        for t in self._profile.triggers:
            if not t.enabled or t.kind != "on_window_data_start":
                continue
            if window_id not in (t.window_watch or []):
                continue
            if self._route_fire(t, f"{window_id} started producing", items=None):
                fired.append(t.id)
                publish_flow(self._profile.name, "watch", f"win:{window_id}", f"trigger:{t.id}", 1)
        return fired

    def note_items(self, window_id: str, item_ids: set[str]) -> list[str]:
        """Called with the distinct item template ids DETECTED (kept, incl. fieldless guards/
        terminators) this tick in ``window_id``. Fires every ``on_item`` trigger whose watched
        window/item match — e.g. the instant a "terminator" placeholder item is read.
        ``item_watch == "*"`` is the "any item" wildcard: fires on ANY item detected in the
        watched window, not one specific template."""
        fired: list[str] = []
        if not item_ids:
            return fired
        for t in self._profile.triggers:
            if not t.enabled or t.kind != "on_item" or not t.item_watch:
                continue
            watch = t.window_watch or []
            if not watch or watch[0] != window_id:
                continue
            any_item = t.item_watch == "*"
            if not any_item and t.item_watch not in item_ids:
                continue
            why = "any item read" if any_item else f"item {t.item_watch} read"
            if self._route_fire(t, why, items=None):
                fired.append(t.id)
                dst = f"item:{window_id}:{t.item_watch}" if not any_item else f"win:{window_id}"
                publish_flow(self._profile.name, "watch", dst, f"trigger:{t.id}", 1)
        return fired

    def _check_window_data_stop(self, now: float) -> list[str]:
        """Called every :meth:`tick` pass: fire ``on_window_data_stop`` for a watched window once
        it's been quiet (no :meth:`note_window_data`) for ``settle_ms`` (or
        :data:`DEFAULT_WINDOW_QUIET_MS` when unset) after having produced. ``settle_ms`` here IS the
        quiet-before-fire threshold itself, not a trailing debounce of an already-decided fire — so
        this fires via :meth:`_fire_gate_ok` + :meth:`_emit_fire` directly, bypassing
        :meth:`_route_fire`'s own settle-defer (which would otherwise wait the SAME span twice)."""
        fired: list[str] = []
        for t in self._profile.triggers:
            if not t.enabled or t.kind != "on_window_data_stop":
                continue
            threshold = ((getattr(t, "settle_ms", None) or DEFAULT_WINDOW_QUIET_MS)) / 1000.0
            for w in list(t.window_watch or []):
                if w not in self._win_active:
                    continue
                last = self._win_last_data.get(w, now)
                if now - last < threshold:
                    continue
                self._win_active.discard(w)
                why = f"{w} quiet for {int(threshold)}s"
                if self._fire_gate_ok(t, why) and self._emit_fire(t, why, items=None):
                    fired.append(t.id)
                    publish_flow(self._profile.name, "watch", f"win:{w}", f"trigger:{t.id}", 1)
        return fired

    # ---- interval ----------------------------------------------------------

    def tick(self) -> list[str]:
        """Fire every interval / true_interval trigger whose interval has elapsed, and check every
        ``on_window_data_stop`` trigger's quiet threshold (:meth:`_check_window_data_stop`). Returns
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
        fired.extend(self._check_window_data_stop(now))
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
                # Fire once per continuous SCREEN (settle-window triggers only). One physical screen
                # drips across ticks AND can mint a second batch number on an OCR dropout, so the
                # settle machinery alone double-fires (settle_max re-arm; a reopen-split batch landing
                # after the first window closed). A gap in flushes longer than the settle span means
                # the previous screen ended (a real close, not a mid-screen dropout) -> re-arm;
                # otherwise, once this screen has emitted, drop the flush. With no settle span the old
                # per-batch coalesce below stands (a new batch number is a new fire).
                span = (getattr(t, "settle_max_ms", 0) or getattr(t, "settle_ms", 0) or 0) / 1000.0
                if span > 0:
                    now = self._clock()
                    with self._settle_lock:
                        prev = self._last_flush_at.get(key)
                        self._last_flush_at[key] = now
                        if prev is not None and (now - prev) > span:
                            self._screen_fired_at.pop(key, None)   # quiet gap -> prev screen ended
                        if self._screen_fired_at.get(key) is not None:
                            continue               # this screen already fired -> no re-arm, no fire
                        self._settle_key[t.id] = key   # _settle_flush stamps the screen on emit
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
                # A synchronous emit (settle window off) fired right now; stamp its screen here. A
                # deferred settle fire returns False above and stamps later in _settle_flush instead.
                if span > 0:
                    with self._settle_lock:
                        self._screen_fired_at[key] = self._clock()
                        self._settle_key.pop(t.id, None)
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
        reads the cached readouts; ``register:<id>#<key>`` reads the cached register snapshot;
        ``dataset:<id>`` / ``subset:<id>`` read a content-hash signature of the dataset's current
        rows / the subset's visible output (see _dataset_sig / _subset_sig — meant for the
        ``changed`` op, not level comparisons); a bare id is treated as a readout (mirrors
        LiveSession._resolve_source's grammar)."""
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
        if kind == "dataset":
            return self._dataset_sig(rest)
        if kind == "subset":
            return self._subset_sig(rest)
        return self._readouts_latest.get(source)

    def _dataset_sig(self, ds_id: str) -> str | None:
        """Content signature of dataset ``ds_id``'s current (``latest``, present-only) rows — the
        value a ``dataset:<id>`` gate/router source tests, meant for the ``changed`` op ("has this
        dataset's content changed since the last fire?"). ``None`` on any compute error.

        Strips the store's bookkeeping/plumbing keys (``_PLUMBING`` — key/present/first_seen/
        last_seen/_count/_seq/_batch/_pos) before hashing: a ``latest`` row is exactly those plumbing
        keys plus the authored value columns (see DatasetStore._current_records), and every volatile
        key (last_seen, _count, _batch, _pos, present flips) is plumbing — so stripping it leaves a
        hash over only the stable authored content, immune to re-observation timestamps bumping on
        every read. Mirrors _subset_sig's "hash the stable view, not the raw row" approach, but a
        bare dataset has no view/columns to project to, so the plumbing tuple stands in for that.

        Caveat: if ``ds_id`` is itself a price/producer dataset, a volatile AUTHORED value column
        (its own per-sweep ``updated``/median field) lives inside the value columns and is
        indistinguishable from real content here — it will still churn the hash. Gate on the
        upstream item dataset instead in that case; datasets have no per-column hide today."""
        from ..store import rows_at, store_for
        from ..store.dataset_store import _PLUMBING
        try:
            rows = rows_at(store_for(self._data_dir, self._profile.name, ds_id,
                                      profile=self._profile, aggregate="latest"),
                            "latest", present_only=True)
            stripped = [{k: v for k, v in r.items() if k not in _PLUMBING} for r in rows]
            blob = json.dumps(stripped, sort_keys=True, default=str).encode("utf-8")
            return hashlib.sha256(blob).hexdigest()
        except Exception:  # noqa: BLE001 - a bad compute must never crash the runner
            return None

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
            if v is not None:
                return v != self._num(prev)
            # non-numeric value (e.g. a dataset:<id> content-hash signature) -> raw compare
            return value is not None and value != prev
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

    def _condset_breakdown(self, source: str, conds) -> list[dict]:
        """Per-condition hold breakdown for a condition set (a gate, or one router branch) — the
        satellite-log column source: one ``{"when", "arg", "hold"}`` dict per condition, evaluated
        against ``source``'s CURRENT live value. Mirrors :meth:`_condset_holds`'s per-cond results
        but keeps them separate instead of folding to one bool."""
        if not conds:
            return []
        value = self._source_value(source)
        prev = self._source_prev.get(source)
        return [{"when": getattr(c.when, "value", c.when), "arg": c.arg or "",
                 "hold": self._cond_holds(c, value, prev)} for c in conds]

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

    def _advance_content_gate_baselines(self, t) -> None:
        """After ``t`` actually fires, advance the ``_source_prev`` baseline for every wired gate
        whose source is a ``dataset:<id>``/``subset:<id>`` content-hash — so a ``changed`` gate over
        one reads "changed since the last FIRE", not "changed this tick" (a dataset/subset has no
        per-tick pulse the way a readout/register does, so the on_readout/on_register pulse-detectors
        that normally refresh _source_prev never see it). Only advances on a real, unblocked fire; a
        gate-blocked or throttled attempt must not move the baseline.

        Known limitation: _source_prev is keyed by source ref, so two triggers gated on the SAME
        dataset/subset share one baseline — one firing advances the other's too. Fine for the common
        one-gate/one-trigger toast-dedup case this was built for."""
        gate_ids = getattr(t, "gates", None)
        if not gate_ids:
            return
        by_gate = {g.id: g for g in getattr(self._profile, "gates", [])}
        for gid in gate_ids:
            g = by_gate.get(gid)
            if g is not None and g.source.startswith(("dataset:", "subset:")):
                self._source_prev[g.source] = self._source_value(g.source)

    def _source_node(self, source: str) -> str | None:
        """The GRAPH NODE id a gate/router ``source`` ref points at (for the flow animation), mirroring
        the front-end model.refNode: ``readout:<id>`` -> ``ro:<win>:<id>``; ``register:<id>#<key>``
        -> ``register:<id>``; ``dataset:<id>`` -> ``ds:<id>``; ``subset:<id>`` -> ``sub:<id>``. None
        if unresolvable."""
        if not source:
            return None
        kind, _, rest = source.partition(":")
        if kind == "readout":
            win = self._readout_window(rest)
            return f"ro:{win}:{rest}" if win else None
        if kind == "register":
            return f"register:{rest.split('#')[0]}"
        if kind == "dataset":
            return f"ds:{rest}"
        if kind == "subset":
            return f"sub:{rest}"
        return None

    def emit_gate_flow(self) -> None:
        """Animate the value that flips a gate's decision: a ``data`` blob source -> gate on the tick
        its pass/block result FLIPS. Called each live tick; an unchanged result emits nothing, so a
        steady value never spams the flow layer. First sight of a gate seeds its state without a blob.
        The gate -> trigger decision is NOT a blob — the graph tints that line ok/danger by live pass/
        block instead (see :meth:`gate_states`), so nothing streams from a gate to its triggers here.

        The same flip also feeds the gate's (non-persisted) flip-history satellite — see
        :mod:`oc.collect.gate_history` — so a closed satellite costs nothing and an open one shows
        exactly the flips that animated the flow layer."""
        gates = getattr(self._profile, "gates", None)
        if not gates:
            return
        from . import gate_history
        game = self._profile.name
        for g in gates:
            if not getattr(g, "enabled", True):
                continue
            holds = self._gate_holds(g)
            prev = self._gate_prev.get(g.id)
            self._gate_prev[g.id] = holds
            if prev is None or holds == prev:
                continue   # seed, or no flip -> no animation/log
            src = self._source_node(g.source)
            if src:
                publish_flow(game, "data", src, f"gate:{g.id}", 1)
            gate_history.record(
                game, g.id, ts=self._wall().isoformat(timespec="milliseconds"), source=g.source,
                source_value=self._source_value(g.source),
                conds=self._condset_breakdown(g.source, g.conds),
                logic=g.logic or "or", negate=bool(getattr(g, "negate", False)), holds=holds)

    def emit_router_flow(self) -> None:
        """Log a router's SELECTED-BRANCH change to its (non-persisted) route-history satellite —
        see :mod:`oc.collect.router_history`. Called each live tick (mirrors :meth:`emit_gate_flow`);
        an unchanged selection emits nothing, so a steady value never spams the log. First sight of a
        router seeds its state without a log row. Unlike a gate, a router has no flow-blob animation
        (it doesn't gate/pass a value, it fans out targets) and its actual fire-time routing still
        goes through :meth:`_resolve_fire` independently — this only detects the CHANGE for the log."""
        routers = getattr(self._profile, "routers", None)
        if not routers:
            return
        from . import router_history
        game = self._profile.name
        for r in routers:
            if not getattr(r, "enabled", True):
                continue
            branches = []
            selected = None
            targets: list[str] = []
            for i, b in enumerate(r.branches or []):
                matched = self._condset_holds(r.source, b.conds, b.logic)
                branches.append({"i": i, "matched": matched})
                if matched and selected is None:
                    selected = i
                    targets = list(b.targets or [])
            seen = r.id in self._router_prev   # None IS a valid "no branch matched" state, unlike
            prev = self._router_prev.get(r.id)  # gate's bool prev, so track "seen" separately
            self._router_prev[r.id] = selected
            if not seen or selected == prev:
                continue   # seed, or no change -> no log
            router_history.record(
                game, r.id, ts=self._wall().isoformat(timespec="milliseconds"), source=r.source,
                source_value=self._source_value(r.source), branches=branches, selected=selected,
                targets=targets)

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

    # ---- on_input: raw keyboard/mouse events from an InputSource hook (live only) -----------
    # Called on the HOOK's own thread (see oc.input.win32_hook), not the collector tick — so this
    # must not touch anything the collector thread isn't already prepared to share. It only reads
    # profile triggers (immutable per run) and the small caches below, and routes matches through
    # the same _route_fire funnel as every other kind (gates/throttle/settle/history all apply).

    @staticmethod
    def _mod_token(m: str) -> str:
        """Canonicalise one ``TriggerDef.input_mods`` entry into a held-set token: a bare
        modifier name (``"ctrl"``) is a key; ``"mouse:<button>"`` is already prefixed."""
        return m if m.startswith("mouse:") else f"key:{m}"

    def set_input_context(self, window_id: str | None, box) -> None:
        """Cache the currently-recognized window id + its client box (an ``(x, y, w, h)``
        tuple, or an object with those attributes) so an ``on_input`` trigger's window/rect gate
        can be evaluated on the hook thread without reaching into the collector's own state.
        Called each live tick (mirrors :meth:`set_readouts`/:meth:`set_registers`)."""
        b = None
        if box is not None:
            b = tuple(box) if isinstance(box, (tuple, list)) else (box.x, box.y, box.w, box.h)
        self._input_context = {"window": window_id, "box": b}

    def _input_chord_holds(self, t) -> bool:
        return all(self._mod_token(m) in self._input_held for m in (t.input_mods or []))

    def _input_place_reason(self, t, x: float, y: float) -> str:
        """``""`` if ``t``'s window/rect gate holds for point ``(x, y)`` (screen px), else the
        reason it doesn't (``"window_miss"``/``"rect_miss"``)."""
        if not t.input_window:
            return ""
        if self._input_context.get("window") != t.input_window:
            return "window_miss"
        if not t.input_rect:
            return ""
        box = self._input_context.get("box")
        if not box or box[2] <= 0 or box[3] <= 0:
            return "rect_miss"
        bx, by, bw, bh = box
        fx, fy = (x - bx) / bw, (y - by) / bh
        rx, ry, rw, rh = t.input_rect
        return "" if (rx <= fx <= rx + rw and ry <= fy <= ry + rh) else "rect_miss"

    def _input_reason(self, t, x: float, y: float) -> str:
        """``""`` if ``t``'s full predicate (chord + window/rect) holds right now, else why not."""
        if not self._input_chord_holds(t):
            return "chord_miss"
        return self._input_place_reason(t, x, y)

    def _log_input(self, t, ev: dict, result: str) -> None:
        from .input_history import record as record_log
        record_log(self._profile.name, t.id, ts=self._wall().isoformat(timespec="milliseconds"),
                   event=ev.get("action", ""), button=f"{ev.get('device', '')}:{ev.get('button', '')}",
                   mods=list(t.input_mods or []), x=ev.get("x", 0), y=ev.get("y", 0), result=result)

    def _input_fire_or_log(self, t, matched: bool, reason: str, ev: dict) -> str:
        """Route a MATCHED input pulse through the shared fire funnel (gates/throttle/settle);
        an unmatched pulse (window/rect/chord miss) is never logged -- pure noise. Returns the
        disposition string recorded to the input log: ``"fired"``/``"deferred"`` (settle armed)/
        ``"throttled"``/``"gated"``, or ``reason``."""
        if not matched:
            return reason   # window/rect/chord misses are never logged -- pure noise
        if not self._gates_pass(t):
            self._log_input(t, ev, "gated")
            return "gated"
        if self._throttled(t):
            self._log_input(t, ev, "throttled")
            return "throttled"
        why = f"input {t.input_button or 'any'} {t.input_event}"
        ok = self._route_fire(t, why, items=None)
        disp = "fired" if ok else ("deferred" if (t.settle_ms or 0) > 0 else "gated")
        self._log_input(t, ev, disp)
        return disp

    def on_input(self, ev: dict) -> list[str]:
        """Handle one raw hook event (``{"device", "action", "button", "x", "y", "ts"}`` — see
        :class:`oc.interfaces.InputSource`). Updates the global held-button set (edge-detects a
        real down from OS key-repeat), then evaluates every enabled ``on_input`` trigger whose
        device+button matches. Returns fired trigger ids."""
        device, action, button = ev.get("device", ""), ev.get("action", ""), ev.get("button", "")
        if action == "move":
            return []   # position is read off button events themselves; move never pulses
        x, y = ev.get("x", 0), ev.get("y", 0)
        token = f"{device}:{button}"
        is_down = action == "down"
        was_held = token in self._input_held
        if is_down:
            if was_held:
                return []   # OS key-repeat -- not a real edge
            self._input_held.add(token)
        else:
            self._input_held.discard(token)
        fired: list[str] = []
        for t in self._profile.triggers:
            if not t.enabled or t.kind != "on_input":
                continue
            raw = (t.input_button or "").strip()
            if raw and raw not in ("any",):
                w_device, _, w_button = raw.partition(":")
                if not w_button:   # tolerate a bare key name with no "key:" prefix
                    w_device, w_button = "key", w_device
                if w_device != device or w_button != button:
                    continue
            reason = self._input_reason(t, x, y)
            matched = reason == ""
            if is_down:
                self._input_down_match[t.id] = matched
                if t.input_event != "down":
                    continue   # up/press/double resolve on the release below
                if self._input_fire_or_log(t, matched, reason, ev) == "fired":
                    fired.append(t.id)
                continue
            # release
            down_matched = self._input_down_match.pop(t.id, False)
            if t.input_event == "up":
                if self._input_fire_or_log(t, matched, reason, ev) == "fired":
                    fired.append(t.id)
                continue
            if t.input_event not in ("press", "double"):
                continue
            full_match = down_matched and matched
            if t.input_event == "press":
                r = "" if full_match else (reason or "chord_miss")
                if self._input_fire_or_log(t, full_match, r, ev) == "fired":
                    fired.append(t.id)
                continue
            # double: two full-match presses within input_double_ms of each other
            if not full_match:
                continue   # window/rect/chord misses are never logged -- pure noise
            now = self._clock()
            last = self._input_last_press.get(t.id)
            window = (t.input_double_ms or 350.0) / 1000.0
            self._input_last_press[t.id] = now
            if last is not None and (now - last) <= window:
                self._input_last_press.pop(t.id, None)   # consume the pair -- a 3rd tap starts fresh
                if self._input_fire_or_log(t, True, "", ev) == "fired":
                    fired.append(t.id)
            else:
                self._log_input(t, ev, "awaiting_double")
        return fired

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
    from .templating import TokenContext, render, token_blanks
    game = game or getattr(profile, "name", None)
    ctx = TokenContext(values, data_dir=data_dir, profile=profile, game=game)
    # skip_mode: drop a block based on its OWN {{token}}s' blankness (not whether the fully
    # rendered string happens to be blank — literal text around a token would mask that). "any"
    # skips when at least one token used is blank; "all" only when every token is; a block with
    # no tokens never skips either way.
    texts = []
    skipped = 0
    for t in getattr(toast, "texts", None) or []:
        content = render(t.content, ctx)
        mode = getattr(t, "skip_mode", "none")
        if mode in ("any", "all"):
            blanks = token_blanks(t.content, ctx)
            if blanks and (any(blanks) if mode == "any" else all(blanks)):
                skipped += 1
                continue
        texts.append(ToastText(content=content, style=t.style, align=t.align))
    # skip_mode drops are silent otherwise — a toast that renders with fewer/no blocks looks like a
    # bug ("test does nothing") rather than the authored skip condition doing its job. Surface it on
    # the log bar so a blank-token skip is visibly a decision, not a failure.
    if skipped:
        logev(f"toast {getattr(toast, 'id', '?')}: {skipped} block(s) skipped (blank token)",
              level="info", game=game)
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
            blocks = [{"content": t.content, "style": t.style, "align": t.align} for t in texts]
            flat_blocks, inline = toast_accum.append(
                data_dir, game, rkey, blocks, inline,
                int(getattr(toast, "accumulate_cap", 10) or 0))
            texts = [ToastText(content=b.get("content", ""), style=b.get("style", ""),
                               align=b.get("align", "")) for b in flat_blocks]
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
        # Building the spec (token/dataset resolution + PIL image render) runs on THIS thread —
        # the collector loop / scheduler tick / request handler — so a slow build both delays the
        # toast and steals GIL time from everything else. Surface it when it's material.
        t0 = time.monotonic()
        spec = toast_spec(toast, values, data_dir=data_dir, profile=profile, game=game)
        build_s = time.monotonic() - t0
        if build_s > 1.0:
            logev(f"toast spec build slow ({build_s:.1f}s): {toast.id}", "warn", game=str(game))
        notifier.notify(spec)
    except Exception:   # noqa: BLE001 - a misbehaving notifier must never crash the loop / a request
        return False
    publish_flow(game, "trigger", f"trigger:{trigger_id}", f"toast:{toast.id}", 1)
    return True


def _arm_delay(timer_factory: Callable[..., object], wait: float, fn: Callable[[], None]) -> None:
    """Run ``fn`` once, ``wait`` seconds from now, on a daemon timer. The one deferral primitive the
    action node uses for both its ``delay_ms`` and its repeated sound cues — same shape (and same
    tolerant ``.daemon``) as :meth:`TriggerRunner._arm_timer_locked`, so an injected fake timer
    drives it deterministically in tests instead of sleeping."""
    timer = timer_factory(max(0.0, wait), fn)
    try:
        timer.daemon = True
    except Exception:  # noqa: BLE001 - injected fake timers need not support .daemon
        pass
    timer.start()


def fire_action(game: str, action, data_dir, *, profile, trigger_id: str | None = None,
                seen: set[str] | None = None,
                timer_factory: Callable[..., object] = threading.Timer) -> bool:
    """Fire ONE action node — do whatever is wired into its ``sources``, ``delay_ms`` after being
    fired. The single funnel the collector dispatch, the trigger fire-now route and the action's own
    fire-now route all use, so no path drifts.

    ``sources`` are prefixed refs: DATASETS (``"dataset:<id>"``) and REGISTERS (``"register:<id>"``)
    get the node's op (clear/clone/move) run on them; SOUNDS (``"sound:<id>"``) are cued to the
    browser; ACTIONS (``"action:<id>"``) are fired downstream (chaining), each with their own delay,
    so chain delays accumulate without any accumulation logic. ``seen`` guards a hand-edited YAML
    cycle from recursing forever.

    ALL scheduling happens here, server-side, never in the browser: a backgrounded tab throttles its
    timers (~1s clamp) but not its SSE delivery, so client-side spacing would silently stretch
    whenever the game has focus. The browser only ever plays a cue that just arrived.

    Emits the trigger->action control pulse immediately (the wire should flash when the TRIGGER
    fires, not ``delay_ms`` later), then each action->target pulse inside
    :func:`oc.store.dataset_ops.fire_dataset_target` / :func:`oc.collect.register_ops.
    fire_register_target`. A disabled node is a no-op. A register source needs a live session holding
    its map — resolved lazily; with none, register ops are a graceful no-op. Returns True if
    anything ran or was scheduled."""
    if action is None or not getattr(action, "enabled", True):
        return False
    # a manual web fire has no trigger node (trigger_id is None), so skip the trigger->action
    # control pulse — the action->target pulses inside the funnels still fire.
    if trigger_id:
        publish_flow(game, "trigger", f"trigger:{trigger_id}", f"action:{action.id}", 1)
    seen = set(seen or ())
    if action.id in seen:
        return False   # chain cycle — already fired in this cascade
    seen.add(action.id)

    def run() -> bool:
        return _run_action(game, action, data_dir, profile=profile, seen=seen,
                           timer_factory=timer_factory, trigger_id=trigger_id)
    delay = max(0, int(getattr(action, "delay_ms", 0) or 0))
    if not delay:
        return run()
    # a delay, not a debounce: every fire arms its own timer, so a burst of fires lands as a burst
    # of delayed runs (settle/throttle on the TRIGGER is where coalescing belongs).
    _arm_delay(timer_factory, delay / 1000.0, run)
    return True


def _run_action(game: str, action, data_dir, *, profile, seen: set[str],
                timer_factory: Callable[..., object], trigger_id: str | None = None) -> bool:
    """The action's actual work, run either inline or off its delay timer — dataset/register ops,
    then the sound cue, then the chained action nodes. Split out so ``delay_ms`` defers ONE thing."""
    from . import action_history
    from ..store.dataset_ops import fire_dataset_target
    from .register_ops import fire_register_target
    from .live import active_session
    session = None
    ran = False
    sounds: list[str] = []
    chained: list[str] = []
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
        elif kind == "sound":
            sounds.append(rid)
        elif kind == "action":
            chained.append(rid)
    if sounds and _cue_sounds(game, action, sounds, profile=profile, timer_factory=timer_factory):
        ran = True
    by_action = {x.id: x for x in (getattr(profile, "actions", None) or [])}
    for rid in chained:
        nxt = by_action.get(rid)
        if nxt is not None and fire_action(game, nxt, data_dir, profile=profile, seen=seen,
                                           timer_factory=timer_factory, trigger_id=trigger_id):
            ran = True
    action_history.record(
        game, action.id, ts=datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        trigger=trigger_id, ran=ran, sounds=sounds, chained=chained)
    return ran


def _cue_sounds(game: str, action, sound_ids: list[str], *, profile,
                timer_factory: Callable[..., object]) -> bool:
    """Cue this action's sound sources to the browser ``action.repeat`` times, ``repeat_ms`` apart.
    Sounds are client-played, so a "fire" is exactly a push on the fire-event bus — the same one a
    trigger's own sound targets ride (:func:`oc.store.fire_events.publish_fire`); the cue names the
    action rather than a trigger because a delayed / manual fire has no live trigger to name (the
    client uses that id only for its empty-``sounds`` fallback). Disabled sounds are dropped here,
    exactly as :meth:`TriggerRunner._resolve_fire` drops them. Returns True if anything was cued."""
    from . import sound_history
    off = {s.id for s in (getattr(profile, "sounds", None) or []) if not getattr(s, "enabled", True)}
    known = {s.id for s in (getattr(profile, "sounds", None) or [])}
    ids = [s for s in sound_ids if s in known and s not in off]
    if not ids:
        return False
    tid = f"action:{action.id}"

    def cue() -> None:
        publish_fire(game, tid, list(ids))
        ts = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        for sid in ids:
            sound_history.record(game, sid, ts=ts, trigger=tid)
    repeat = max(1, int(getattr(action, "repeat", 1) or 1))
    every = max(10, int(getattr(action, "repeat_ms", 300) or 300)) / 1000.0
    cue()

    def again(n: int) -> None:
        cue()
        if n + 1 < repeat:
            _arm_delay(timer_factory, every, lambda: again(n + 1))
    if repeat > 1:
        _arm_delay(timer_factory, every, lambda: again(1))
    return True


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
