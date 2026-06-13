"""Evaluate a profile's triggers and fire price-node sweeps.

A :class:`TriggerDef` says *when* to price; this runner turns that into calls to the shared
:func:`oc.enrich.price_runner.start_sweep`. It's driven by the collector loop (so on_change
fires the moment a watched window reads new rows) and is independent of any window — interval
triggers fire on schedule even with no game running.

Three kinds:

* ``interval``  — fire every ``interval_s`` seconds (:meth:`tick`, called each loop pass).
* ``on_change`` — fire when a watched dataset gains records (:meth:`on_change`), pricing ONLY
  those changed keys (resolved to slugs) so a relic-reward read prices ~4 items, not the world.
* ``manual``    — never auto-fires (the sweep button drives it); declared only for wiring.

``fire`` and ``clock`` are injectable so the scheduling logic is unit-testable without sleeping
or hitting the network.
"""

from __future__ import annotations

import time
from collections.abc import Callable

from ..enrich.price_collector import inventory_slugs
from ..enrich.price_runner import start_sweep, sweep_status
from ..enrich.slug_resolver import get_resolver
from ..enrich.wm_client import slugify


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
                self._fire_targets(t, items=None)   # node sources / catalogue decide
                fired.append(t.id)
        return fired

    # ---- on_change ---------------------------------------------------------

    def on_change(self, dataset: str | None, changed_records: list[dict]) -> list[str]:
        """Fire on_change triggers watching ``dataset``, pricing only ``changed_records``.
        Returns fired trigger ids."""
        if not dataset or not changed_records:
            return []
        fired: list[str] = []
        items = None
        for t in self._profile.triggers:
            if not t.enabled or t.kind != "on_change" or dataset not in t.watch:
                continue
            if items is None:
                items = self._items_for(changed_records)
            self._fire_targets(t, items=items)
            fired.append(t.id)
        return fired

    # ---- helpers -----------------------------------------------------------

    def _items_for(self, records: list[dict]) -> list[tuple[str, str]]:
        if self._resolve is None:
            r = get_resolver(self._data_dir, self._profile.name)
            self._resolve = r.resolve if r is not None else slugify
        return inventory_slugs(records, "name", self._resolve)

    def _fire_targets(self, trigger, items) -> None:
        for pid in trigger.targets:
            pn = next((p for p in self._profile.price_nodes if p.id == pid), None)
            if pn is None or not pn.enabled:
                continue
            # don't re-fire a node whose sweep is already running — start_sweep would no-op
            # anyway (per-node running flag + per-game gate + cross-process file lock), but skip
            # up front so a busy node is never disturbed or double-counted.
            if sweep_status(self._profile.name, pn.dataset).get("running"):
                continue
            try:
                self._fire(pn, items)
            except Exception:   # a misbehaving fire must never crash the collector loop
                pass

    def _default_fire(self, price_node, items) -> None:
        start_sweep(self._data_dir, self._profile.name, price_node,
                    profile=self._profile, items=items)
