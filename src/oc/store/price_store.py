"""Time-series price store: one slug -> many daily candles, persisted per game.

Unlike :class:`DatasetStore` (a keyed *current-state* snapshot), prices are genuine
time-series — many points per item — so they get their own store. Each
warframe.market statistics fetch yields ~90 daily candles; we upsert them by date,
so repeated fetches dedup the overlap and the record *accumulates history past the
API's 90-day window* the longer the collector runs.

On disk: ``data/<game>/prices.state.json`` ::

    {
      "_meta": {"version": 1, "updated": "<iso>"},
      "slugs": {
        "soma_prime": {
          "name": "Soma Prime",
          "updated": "<iso>",
          "live": {"min": 36, "median": 60.0, "volume": 14221},  # 48h sell, or null
          "candles": {
            "2026-03-14": {"volume":149,"min":84,"max":90,"avg":87.0,
                           "median":89.0,"wa":88.3,"ma":85.9},
            ...
          }
        }
      }
    }

The store is read by the web prices page and written by the recurring collector; the
save is atomic (temp + ``os.replace``) so a concurrent reader never sees half a file.
"""

from __future__ import annotations

import json
import os
import statistics
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ..enrich.wm_client import online_sell_prices


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _num(v):
    """Coerce to int/float, or None if missing/unparseable."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return int(f) if f.is_integer() else f


def _candle(raw: dict) -> tuple[str, dict] | None:
    """Normalise one warframe.market statistics entry to ``(date, candle)``.

    ``date`` is the ``YYYY-MM-DD`` from the entry's ``datetime``; the candle keeps the
    fields we chart/aggregate. Returns None if it has no usable date or median.
    """
    dt = raw.get("datetime") or ""
    date = str(dt)[:10]
    median = _num(raw.get("median"))
    if len(date) != 10 or median is None:
        return None
    return date, {
        "volume": _num(raw.get("volume")),
        "min": _num(raw.get("min_price")),
        "max": _num(raw.get("max_price")),
        "avg": _num(raw.get("avg_price")),
        "median": median,
        "wa": _num(raw.get("wa_price")),
        "ma": _num(raw.get("moving_avg")),
    }


class PriceStore:
    def __init__(self, data_dir: Path | str, game: str) -> None:
        # NOT ``prices.state.json`` — a price-producer dataset is conventionally named
        # ``prices``, and a DatasetStore for it writes ``prices.state.json``; the two
        # would clobber each other. The time-series store gets its own distinct file.
        base = Path(data_dir) / game
        self._path = base / "price_store.json"
        # tiny sidecar the price node reads so it never has to parse the (large) full
        # store just to show its slug count + movers — see :meth:`_write_index`.
        self._index_path = base / "price_index.json"
        self._slugs: dict[str, dict] = {}
        # Slugs a sweep tried and the market 404'd (no such item / bad name guess).
        # Kept so the UI can show "no market match" instead of an indistinct blank,
        # and so a later reconcile pass knows which names still need a real slug.
        self._misses: dict[str, dict] = {}
        self._load()

    # ---- persistence -------------------------------------------------------

    def _load(self) -> None:
        if not self._path.exists():
            return
        try:
            doc = json.loads(self._path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return
        if isinstance(doc, dict):
            self._slugs = doc.get("slugs", {}) or {}
            self._misses = doc.get("misses", {}) or {}

    def save(self, *, write_index: bool = True) -> None:
        """Persist the store. ``write_index=False`` skips the summary sidecar rebuild
        (:meth:`_write_index` runs :meth:`movers`, an O(all slugs x candles) scan) — used by the
        in-sweep periodic saves, which fire repeatedly; the sidecar is rebuilt once on the final
        save. Both the JSON encode here and that scan hold the GIL, so doing them on every
        progress save stalls the server's event loop."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        doc = {"_meta": {"version": 1, "updated": _utcnow_iso()},
               "slugs": self._slugs, "misses": self._misses}
        # Unique temp per write so two writers never clobber each other's temp file.
        tmp = self._path.with_suffix(f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=False, sort_keys=True), encoding="utf-8")
        # os.replace can transiently fail on Windows ([WinError 5]) when another handle is
        # open on the target — a concurrent reader (the web poll), an AV scan, or the
        # indexer. It clears in milliseconds, so retry briefly before giving up.
        for attempt in range(20):
            try:
                os.replace(tmp, self._path)
                break
            except PermissionError:
                if attempt == 19:
                    tmp.unlink(missing_ok=True)
                    raise
                time.sleep(0.05)
        if write_index:
            self._write_index()

    def _write_index(self) -> None:
        """Write the small summary sidecar (slug count + top movers). Best-effort — a
        failure here never breaks a sweep."""
        try:
            idx = {"updated": _utcnow_iso(), "slugs": len(self._slugs),
                   "movers": self.movers(days=7, threshold=0.15, limit=12)}
            tmp = self._index_path.with_suffix(f".{os.getpid()}.tmp")
            tmp.write_text(json.dumps(idx, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, self._index_path)
        except OSError:
            pass

    @staticmethod
    def read_index(data_dir: Path | str, game: str) -> dict:
        """The summary sidecar for ``game`` (``{slugs, movers, updated}``), or ``{}``.
        Cheap — never parses the full candle store."""
        path = Path(data_dir) / game / "price_index.json"
        if not path.exists():
            return {}
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return {}

    def mark_missing(self, slug: str, name: str, code: int = 404) -> None:
        """Record that ``slug`` has no market entry (a 404). Does NOT save."""
        self._misses[slug] = {"name": name, "code": code, "ts": _utcnow_iso()}

    # ---- ingest ------------------------------------------------------------

    def ingest_statistics(self, slug: str, name: str, payload: dict) -> int:
        """Merge a warframe.market statistics payload for ``slug``. Upserts daily
        candles from ``statistics_closed.90days`` (keyed by date) and refreshes the
        live 48h sell snapshot. Returns how many distinct candle dates this slug holds
        after the merge. Does NOT save — caller batches saves."""
        entry = self._slugs.setdefault(slug, {"name": name, "candles": {}})
        entry["name"] = name or entry.get("name") or slug
        entry["updated"] = _utcnow_iso()
        self._misses.pop(slug, None)   # a prior 404 recovered
        candles: dict = entry.setdefault("candles", {})

        closed = (payload.get("statistics_closed") or {}).get("90days") or []
        for raw in closed:
            # Mods/sets can carry a buy AND a sell candle per day — keep the sell side
            # (what you'd realise); items without the split have no order_type.
            if raw.get("order_type") == "buy":
                continue
            parsed = _candle(raw)
            if parsed is not None:
                date, candle = parsed
                candles[date] = candle  # newest fetch wins for that day

        entry["live"] = _live_snapshot(payload)
        return len(candles)

    def ingest_orders(self, slug: str, name: str, orders: list[dict], depth: int = 5) -> int:
        """Merge a live ``/orders`` fetch for ``slug``: store the current lowest online
        SELL (``min``) and the median of the lowest ``depth`` (resists a lone lowball) as
        an instantaneous ``live_orders`` snapshot. Orders are point-in-time with no date,
        so this is NOT a candle — it overwrites the slug's single live snapshot each sweep.
        Returns the number of online sellers found. Does NOT save — caller batches."""
        entry = self._slugs.setdefault(slug, {"name": name, "candles": {}})
        entry["name"] = name or entry.get("name") or slug
        entry["updated"] = _utcnow_iso()
        self._misses.pop(slug, None)   # a prior 404 recovered
        prices = online_sell_prices(orders)
        low = prices[:depth]
        entry["live_orders"] = {
            "min": _num(low[0]) if low else None,
            "median": round(statistics.median(low), 1) if low else None,
            "sellers": len(prices),
            "ts": _utcnow_iso(),
        }
        return len(prices)

    # ---- queries -----------------------------------------------------------

    def slugs(self) -> list[str]:
        return sorted(self._slugs)

    def status_of(self, slug: str) -> str:
        """``priced`` (has a usable price), ``missing`` (market 404'd this slug), or
        ``pending`` (never fetched / no data yet)."""
        if self.price(slug) is not None:
            return "priced"
        if slug in self._misses:
            return "missing"
        return "pending"

    def history(self, slug: str) -> list[dict]:
        """Daily candles for ``slug``, oldest-first, each with a ``date`` field."""
        entry = self._slugs.get(slug)
        if not entry:
            return []
        return [{"date": d, **c} for d, c in sorted(entry.get("candles", {}).items())]

    def latest_candle(self, slug: str) -> dict | None:
        hist = self.history(slug)
        return hist[-1] if hist else None

    def price(self, slug: str) -> float | int | None:
        """Best current sell estimate: the live 48h median if present, else the most
        recent daily candle's median."""
        entry = self._slugs.get(slug)
        if not entry:
            return None
        live = entry.get("live") or {}
        if live.get("median") is not None:
            return live["median"]
        latest = self.latest_candle(slug)
        return latest["median"] if latest else None

    def info(self, slug: str) -> dict | None:
        """Compact summary for one slug: name, current price, candle count, updated."""
        entry = self._slugs.get(slug)
        if not entry:
            return None
        return {
            "slug": slug,
            "name": entry.get("name", slug),
            "price": self.price(slug),
            "candles": len(entry.get("candles", {})),
            "updated": entry.get("updated"),
        }

    def snapshot(self, slug: str) -> dict | None:
        """The current price row a producer pushes into its output dataset: keyed by
        ``name`` so a view can join it to inventory. None if the slug isn't stored.

        Fields are conditional so the two producer modes never null out each other's
        columns when they feed the SAME dataset (records merge by name): the
        statistics-derived ``price_*``/``volume`` appear only when there's candle/live-stat
        data, and the live-orders ``live_*`` only when an orders sweep stored them."""
        entry = self._slugs.get(slug)
        if not entry:
            return None
        snap = {"name": entry.get("name", slug), "slug": slug, "updated": entry.get("updated")}
        price = self.price(slug)
        if price is not None:
            latest = self.latest_candle(slug) or {}
            snap["price_min"] = latest.get("min")
            snap["price_median"] = price
            snap["volume"] = latest.get("volume")
        lo = entry.get("live_orders")
        if lo:
            snap["live_ask"] = lo.get("min")
            snap["live_median"] = lo.get("median")
            snap["live_sellers"] = lo.get("sellers")
        return snap

    def movers(self, days: int = 7, threshold: float = 0.15, limit: int = 50) -> list[dict]:
        """Items whose current median moved >= ``threshold`` (fraction) vs ``days`` ago.

        Baseline is the candle on/just-before (latest date - ``days``); change is
        ``(now - then) / then``. Sorted by absolute change, biggest first.
        """
        out = []
        for slug, entry in self._slugs.items():
            candles = entry.get("candles") or {}
            if len(candles) < 2:
                continue
            dates = sorted(candles)
            now_date = dates[-1]
            cutoff = (datetime.fromisoformat(now_date) - timedelta(days=days)).isoformat()[:10]
            prior = [d for d in dates if d <= cutoff]
            then_date = prior[-1] if prior else dates[0]
            if then_date == now_date:
                continue
            now = candles[now_date].get("median")
            then = candles[then_date].get("median")
            if not now or not then:
                continue
            pct = (now - then) / then
            if abs(pct) >= threshold:
                out.append({
                    "slug": slug, "name": entry.get("name", slug),
                    "now": now, "then": then, "pct": round(pct, 4),
                    "from": then_date, "to": now_date,
                })
        out.sort(key=lambda r: abs(r["pct"]), reverse=True)
        return out[:limit]

    def portfolio(self, records: list[dict], slug_of, name_field: str = "name",
                  count_field: str = "count") -> dict:
        """Join inventory ``records`` to current prices. ``slug_of(name)`` maps a record's
        name to a market slug. Returns ``{rows, total, priced, unpriced}`` where each row
        is ``{name, slug, count, price, value}`` and ``total`` is the summed value."""
        rows, total = [], 0
        counts = {"priced": 0, "missing": 0, "pending": 0}
        for rec in records:
            name = rec.get(name_field)
            if not name:
                continue
            count = _num(rec.get(count_field)) or 1
            slug = slug_of(str(name))
            if not slug:                       # no market match for this name at all
                counts["missing"] += 1
                rows.append({"name": name, "slug": "", "count": count,
                             "price": None, "value": None, "status": "missing"})
                continue
            price = self.price(slug)
            status = self.status_of(slug)
            counts[status] += 1
            value = round(price * count, 1) if price is not None else None
            if value is not None:
                total += value
            rows.append({"name": name, "slug": slug, "count": count,
                         "price": price, "value": value, "status": status})
        # priced first (by value desc), then missing, then pending
        order = {"priced": 0, "missing": 1, "pending": 2}
        rows.sort(key=lambda r: (order[r["status"]], -(r["value"] or 0)))
        return {"rows": rows, "total": round(total, 1),
                "priced": counts["priced"], "missing": counts["missing"],
                "pending": counts["pending"], "unpriced": counts["missing"] + counts["pending"]}


_ONLINE_SELL = "sell"


def _live_snapshot(payload: dict) -> dict | None:
    """Most recent 48h *sell* candle as a tiny current-price snapshot, or None."""
    live = (payload.get("statistics_live") or {}).get("48hours") or []
    sells = [e for e in live if e.get("order_type") in (None, _ONLINE_SELL)]
    if not sells:
        return None
    newest = max(sells, key=lambda e: e.get("datetime") or "")
    return {"min": _num(newest.get("min_price")), "median": _num(newest.get("median")),
            "volume": _num(newest.get("volume"))}
