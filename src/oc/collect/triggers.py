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
* ``on_app_start`` — fire once when the teach/web app boots (:meth:`fire_app_start`).
* ``on_capture``   — fire when a capture session starts, live OR precapture (:meth:`fire_capture`).
* ``on_live_start``— fire when the server live-collection session starts (:meth:`fire_live_start`).
* ``on_live_stop`` — fire when the server live-collection session stops (:meth:`fire_live_stop`).
* ``manual``       — never auto-fires (the sweep button drives it); declared only for wiring.

A trigger ``target`` is a price-node id OR a file-source id: pricing nodes sweep the market,
file sources read a log/config file. The runner dispatches by which kind owns the id. A trigger
can ALSO act on datasets — see ``dataset_targets``/``dataset_action`` and
:func:`oc.store.dataset_ops.fire_dataset_target`.

``fire`` and ``clock`` are injectable so the scheduling logic is unit-testable without sleeping
or hitting the network.
"""

from __future__ import annotations

import hashlib
import json
import time
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from ..enrich.price_runner import start_sweep, sweep_status
from ..eventlog import publish as logev
from ..eventlog import slog
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
                 notifier=None, clock: Callable[[], float] = time.monotonic) -> None:
        self._profile = profile
        self._data_dir = data_dir
        self._clock = clock
        self._fire = fire or self._default_fire
        # OS-notification backend (oc.interfaces.Notifier) for toast-node targets; None ->
        # toast targets are silently skipped (e.g. a runner built without one). Never used in
        # the capture loop — only when a fired trigger names a toast node.
        self._notifier = notifier
        # Latest {readout_id: value} seen, so a fired toast can interpolate {{ro_1}} tokens in
        # its text. Readouts are ephemeral (never stored) — the collector pushes them each tick
        # via set_readouts(); other fire paths (web routes) supply their own values to fire_toast.
        self._readouts_latest: dict = {}
        # last-fire time per interval trigger; seed to "now" so the first fire waits a
        # full interval rather than firing immediately on startup.
        now = clock()
        self._last: dict[str, float] = {
            t.id: now for t in profile.triggers if t.kind == "interval"}
        # on_readout edge state: whether each trigger's condition was true last evaluation
        # (so a held condition fires once, not every tick) + the previous value per watched
        # readout (for crosses_up/crosses_down, which compare against the prior reading).
        self._readout_state: dict[str, bool] = {}
        self._readout_prev: dict[str, float] = {}

    # ---- interval ----------------------------------------------------------

    def tick(self) -> list[str]:
        """Fire every interval trigger whose interval has elapsed. Returns fired ids."""
        now = self._clock()
        fired: list[str] = []
        for t in self._profile.triggers:
            if not t.enabled or t.kind != "interval":
                continue
            if now - self._last.get(t.id, now) >= t.interval_s:
                self._last[t.id] = now
                logev(f"trigger {t.id} fired (interval, every {int(t.interval_s)}s)",
                      level="run", game=self._profile.name)
                slog(f"trigger {t.id} fired (interval, every {int(t.interval_s)}s)",
                     game=self._profile.name)
                self._fire_targets(t, items=None)   # node sources / catalogue decide
                record_fire(self._data_dir, self._profile.name, t.id)
                fired.append(t.id)
        return fired

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
            logev(f"trigger {t.id} fired ({why})", level="run", game=self._profile.name)
            slog(f"trigger {t.id} fired ({why})", game=self._profile.name)
            self._fire_targets(t, items=None)
            record_fire(self._data_dir, self._profile.name, t.id)
            fired.append(t.id)
        return fired

    # ---- on_change ---------------------------------------------------------

    def on_change(self, dataset: str | None, changed_records: list[dict]) -> list[str]:
        """Fire ``on_change``/``on_any_change`` triggers watching ``dataset``, pricing only
        ``changed_records``. Returns fired trigger ids.

        A DIRECT dataset watch fires whenever the dataset changes (the records ARE new) for
        either kind. A SUBSET watch differs by kind: ``on_change`` fires only when the subset's
        COMPUTED output actually changes — a source update that leaves the join byte-for-byte
        identical (e.g. a price for an item the inventory doesn't hold) is NOT a change to the
        watched data, so it must not fire; ``on_any_change`` skips that check and fires on every
        write reaching the subset, regardless of whether its visible output moved.

        ``changed_records`` may be empty — a clear / removal changed the watched data but leaves
        nothing to price. A direct watch still fires (its data changed); an ``on_change`` subset
        watch fires iff its computed output changed; an ``on_any_change`` subset watch always
        fires. Either way ``_fire_targets`` prices nothing (empty items)."""
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
            logev(f"trigger {t.id} <- {dataset} changed ({len(changed_records)} rows, "
                  f"{len(items)} to price)", level="run", game=self._profile.name)
            slog(f"trigger {t.id} <- {dataset} changed ({len(changed_records)} rows, "
                 f"{len(items)} to price)", game=self._profile.name)
            # animate the watch hop watched dataset/view -> trigger (the change that fired it
            # flows INTO the trigger), only for the watches that actually justified this fire
            for w in justifying:
                node = f"sub:{w}" if self._profile.subset_def(w) else f"ds:{w}"
                publish_flow(self._profile.name, "watch", node, f"trigger:{t.id}", 1)
            self._fire_targets(t, items=items)
            record_fire(self._data_dir, self._profile.name, t.id)
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
        (interval / lifecycle / readout) can interpolate ``{{ro_1}}`` tokens with live values.
        Called by the collector each tick before it evaluates triggers."""
        if values:
            self._readouts_latest.update(values)

    def on_readout(self, values: dict) -> list[str]:
        """Fire ``on_readout`` triggers whose watched readout(s) meet their condition.

        Edge-triggered: a trigger fires the instant its condition becomes true (false->true),
        not every tick while it holds. ``values`` is ``{readout_id: value}`` read this tick.
        Returns fired trigger ids. Variables are ephemeral — nothing here touches a store."""
        if not values:
            return []
        self.set_readouts(values)   # a readout-fired toast interpolates the freshest values
        fired: list[str] = []
        for t in self._profile.triggers:
            if not t.enabled or t.kind != "on_readout":
                continue
            watched = [w for w in t.readout_watch if w in values]
            cond = any(self._readout_meets(t.readout_op, values[w], t.readout_value, self._readout_prev.get(w))
                       for w in watched)
            was = self._readout_state.get(t.id, False)
            self._readout_state[t.id] = cond
            if cond and not was:
                logev(f"trigger {t.id} fired (readout {t.readout_op} {t.readout_value})",
                      level="run", game=self._profile.name)
                slog(f"trigger {t.id} fired (readout {t.readout_op} {t.readout_value})",
                     game=self._profile.name)
                self._fire_targets(t, items=None)
                record_fire(self._data_dir, self._profile.name, t.id)
                fired.append(t.id)
        # remember this tick's readings so crosses_* can see the transition next tick
        for w, v in values.items():
            n = self._num(v)
            if n is not None:
                self._readout_prev[w] = n
        return fired

    # ---- helpers -----------------------------------------------------------

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
        from ..enrich.subset import compute_view_rows
        from ..store import rows_at, store_for
        try:
            fetch = lambda ds, agg: rows_at(store_for(  # noqa: E731
                self._data_dir, self._profile.name, ds, profile=self._profile,
                aggregate="latest" if agg == "all" else agg), agg, present_only=True)
            view = compute_view_rows(self._profile, sid, fetch)
            cols = view["columns"]
            visible = [{c: r.get(c) for c in cols} for r in view["rows"]]
            blob = json.dumps(visible, sort_keys=True, default=str).encode("utf-8")
            return hashlib.sha256(blob).hexdigest()
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

    def _fire_targets(self, trigger, items) -> None:
        """Dispatch each target id by what owns it: a producer sweeps/refreshes, a file source
        reads, a toast node raises an OS notification, and each ``dataset_targets`` entry runs
        the trigger's dataset action."""
        by_producer = {p.id: p for p in self._profile.producers}
        by_source = {s.id: s for s in self._profile.file_sources}
        by_toast = {x.id: x for x in getattr(self._profile, "toasts", [])}
        for tid in trigger.targets:
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
        if getattr(trigger, "dataset_action", ""):
            from ..store.dataset_ops import fire_dataset_target
            for ds in getattr(trigger, "dataset_targets", []):
                fire_dataset_target(self._profile.name, self._data_dir, self._profile, trigger, ds)

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
    # don't re-fire a node whose sweep is already running — start_sweep would no-op anyway
    # (per-node running flag + per-game gate + cross-process file lock), but skip up front so a
    # busy node is never disturbed or double-counted.
    if sweep_status(game, price_node.dataset).get("running"):
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
    return ToastSpec(
        title=render(toast.title, ctx),
        message=render(toast.message, ctx),
        texts=texts,
        app_name=toast.app_name, duration=toast.duration, icon=toast.icon,
        show_icon=getattr(toast, "show_icon", True),
        attribution=render(toast.attribution, ctx), muted=toast.muted,
        hero_image=hero, inline_images=inline)


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
