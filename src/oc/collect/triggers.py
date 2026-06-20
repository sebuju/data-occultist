"""Evaluate a profile's triggers and fire price-node sweeps.

A :class:`TriggerDef` says *when* to price; this runner turns that into calls to the shared
:func:`oc.enrich.price_runner.start_sweep`. It's driven by the collector loop (so on_change
fires the moment a watched window reads new rows) and is independent of any window — interval
triggers fire on schedule even with no game running.

Kinds:

* ``interval``     — fire every ``interval_s`` seconds (:meth:`tick`, called each loop pass).
* ``on_change``    — fire when a watched dataset gains records (:meth:`on_change`), pricing ONLY
  those changed keys (resolved to slugs) so a relic-reward read prices ~4 items, not the world.
* ``on_app_start`` — fire once when the teach/web app boots (:meth:`fire_app_start`).
* ``on_capture``   — fire when a capture session starts, live OR precapture (:meth:`fire_capture`).
* ``manual``       — never auto-fires (the sweep button drives it); declared only for wiring.

A trigger ``target`` is a price-node id OR a file-source id: pricing nodes sweep the market,
file sources read a log/config file. The runner dispatches by which kind owns the id.

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

from ..enrich.price_collector import inventory_slugs
from ..enrich.price_runner import start_sweep, sweep_status
from ..enrich.slug_resolver import get_resolver
from ..enrich.wm_client import slugify
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
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._profile = profile
        self._data_dir = data_dir
        self._clock = clock
        self._fire = fire or self._default_fire
        # last-fire time per interval trigger; seed to "now" so the first fire waits a
        # full interval rather than firing immediately on startup.
        now = clock()
        self._last: dict[str, float] = {
            t.id: now for t in profile.triggers if t.kind == "interval"}
        self._resolve = None   # built lazily on first on_change (needs the catalogue)

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
        """Fire on_change triggers watching ``dataset``, pricing only ``changed_records``.
        Returns fired trigger ids.

        A DIRECT dataset watch fires whenever the dataset changes (the records ARE new). A
        SUBSET watch fires only when the subset's COMPUTED output actually changes — a source
        update that leaves the join byte-for-byte identical (e.g. a price for an item the
        inventory doesn't hold) is NOT a change to the watched data, so it must not fire."""
        if not dataset or not changed_records:
            return []
        fired: list[str] = []
        items = None
        sig_changed: dict[str, bool] = {}   # watched subset id -> did its output change (this flush)
        stored = read_subset_sigs(self._data_dir, self._profile.name)
        new_sigs: dict[str, str] = {}       # subset id -> fresh sig to persist
        for t in self._profile.triggers:
            if not t.enabled or t.kind != "on_change":
                continue
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
                aggregate="latest" if agg == "all" else agg), agg)
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

    def _items_for(self, records: list[dict]) -> list[tuple[str, str]]:
        if self._resolve is None:
            r = get_resolver(self._data_dir, self._profile.name)
            self._resolve = r.resolve if r is not None else slugify
        return inventory_slugs(records, "name", self._resolve)

    def _fire_targets(self, trigger, items) -> None:
        """Dispatch each target id by what owns it: a producer sweeps/refreshes, a file source reads."""
        by_producer = {p.id: p for p in self._profile.producers}
        by_source = {s.id: s for s in self._profile.file_sources}
        for tid in trigger.targets:
            if tid in by_producer:
                fire_target(self._profile.name, by_producer[tid], items,
                            trigger_id=trigger.id, fire=self._fire)
            elif tid in by_source:
                self._read_source(by_source[tid], trigger.id)

    def _read_source(self, source, trigger_id: str) -> None:
        """Fire a file-source target: read it and emit the trigger->source control pulse. A
        misbehaving read must never crash the loop / a request."""
        from ..source.runner import read_source
        try:
            read_source(self._profile.name, source, self._data_dir, profile=self._profile)
            publish_flow(self._profile.name, "trigger", f"trigger:{trigger_id}",
                         f"src:{source.id}", 1)
        except Exception:   # noqa: BLE001
            pass

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
