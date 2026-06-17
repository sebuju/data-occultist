"""Tests for the price subsystem: PriceStore (candles/movers/portfolio/misses),
the slug resolver, inventory slugging, and the warframe.market URL builder.

All pure-logic — no network. The one HTTP-shaped test monkeypatches the client's
``_get`` to assert the request URL is built (and encoded) correctly.
"""

import json

import pytest

from oc.enrich import price_collector, wm_client
from oc.enrich.price_collector import inventory_slugs, sweep_catalogue
from oc.enrich.slug_resolver import SlugResolver
from oc.store import DatasetStore, KeySpec, PriceStore


# ---- statistics payload helper ---------------------------------------------

def _stats(closed=(), live=(), buys=()):
    """Build a warframe.market statistics payload.

    ``closed`` / ``live`` / ``buys`` are ``(date, median)`` pairs; ``buys`` are tagged
    ``order_type=buy`` in the closed 90days array (should be ignored on ingest)."""
    def candle(date, m, **extra):
        return {"datetime": f"{date}T00:00:00.000+00:00", "volume": 10,
                "min_price": m - 1, "max_price": m + 2, "avg_price": m,
                "wa_price": m, "median": m, "moving_avg": m, **extra}
    closed_rows = [candle(d, m) for d, m in closed] + [candle(d, m, order_type="buy") for d, m in buys]
    live_rows = [candle(d, m, order_type="sell") for d, m in live]
    return {"statistics_closed": {"90days": closed_rows, "48hours": []},
            "statistics_live": {"90days": [], "48hours": live_rows}}


# ---- orders payload helper --------------------------------------------------

def _order(platinum, order_type="sell", status="online"):
    # v2 /orders payload: the order's buy/sell field is ``type`` (v1's ``order_type``
    # was renamed; v1 is now 403-deprecated). ``user.status`` is ingame/online/offline.
    return {"platinum": platinum, "type": order_type, "user": {"status": status}}


def _orders(*specs):
    """Build an orders list. Each spec is ``platinum`` (online sell) or a
    ``(platinum, order_type, status)`` tuple for buys / offline users."""
    out = []
    for s in specs:
        out.append(_order(*s) if isinstance(s, tuple) else _order(s))
    return out


# ---- PriceStore: ingest + candles ------------------------------------------

def test_ingest_parses_and_dedups_candles(tmp_path):
    s = PriceStore(tmp_path, "g")
    n = s.ingest_statistics("soma_prime_set", "Soma Prime Set",
                            _stats(closed=[("2026-06-01", 100), ("2026-06-02", 110)]))
    assert n == 2
    hist = s.history("soma_prime_set")
    assert [c["date"] for c in hist] == ["2026-06-01", "2026-06-02"]   # sorted oldest-first
    assert hist[-1]["median"] == 110 and hist[-1]["min"] == 109 and hist[-1]["max"] == 112


def test_ingest_same_date_overwrites(tmp_path):
    s = PriceStore(tmp_path, "g")
    s.ingest_statistics("x", "X", _stats(closed=[("2026-06-01", 100)]))
    s.ingest_statistics("x", "X", _stats(closed=[("2026-06-01", 130)]))   # newer fetch wins
    hist = s.history("x")
    assert len(hist) == 1 and hist[0]["median"] == 130


def test_ingest_skips_buy_candles(tmp_path):
    s = PriceStore(tmp_path, "g")
    # a buy candle shares the day with a sell candle — only the sell survives
    s.ingest_statistics("mod", "Mod", _stats(closed=[("2026-06-01", 70)], buys=[("2026-06-01", 999)]))
    assert s.history("mod")[0]["median"] == 70


def test_price_prefers_live_then_latest_candle(tmp_path):
    s = PriceStore(tmp_path, "g")
    s.ingest_statistics("a", "A", _stats(closed=[("2026-06-01", 100), ("2026-06-02", 110)],
                                         live=[("2026-06-03", 60)]))
    assert s.price("a") == 60                       # live 48h sell wins
    s.ingest_statistics("b", "B", _stats(closed=[("2026-06-01", 100), ("2026-06-02", 110)]))
    assert s.price("b") == 110                      # no live -> latest candle median


def test_price_unknown_slug_is_none(tmp_path):
    assert PriceStore(tmp_path, "g").price("nope") is None


# ---- snapshot (the producer's per-item row) ---------------------------------

def test_snapshot_row(tmp_path):
    s = PriceStore(tmp_path, "g")
    s.ingest_statistics("acceltra_prime_set", "Acceltra Prime Set",
                        _stats(closed=[("2026-06-07", 40), ("2026-06-08", 48)]))
    snap = s.snapshot("acceltra_prime_set")
    assert snap == {"name": "Acceltra Prime Set", "slug": "acceltra_prime_set",
                    "price_min": 47, "price_median": 48, "volume": 10,
                    "updated": snap["updated"]}
    assert PriceStore(tmp_path, "g").snapshot("missing") is None


# ---- live orders (right-now lowest sell) ------------------------------------

def test_online_sell_prices_filters_and_sorts():
    orders = _orders(50, 30, (10, "buy", "online"), (5, "sell", "offline"), 40)
    # only online SELL orders, ascending: 30, 40, 50
    assert wm_client.online_sell_prices(orders) == [30, 40, 50]


def test_ingest_orders_min_median_sellers(tmp_path):
    s = PriceStore(tmp_path, "g")
    n = s.ingest_orders("soma_prime", "Soma Prime", _orders(60, 30, 40, 50, 70, 35))
    assert n == 6                                   # six online sellers
    lo = s._slugs["soma_prime"]["live_orders"]
    # min = cheapest; median = median of the lowest 5 (30,35,40,50,60) = 40
    assert lo["min"] == 30 and lo["median"] == 40 and lo["sellers"] == 6


def test_ingest_orders_no_online_sellers(tmp_path):
    s = PriceStore(tmp_path, "g")
    s.ingest_orders("x", "X", _orders((10, "sell", "offline"), (5, "buy", "online")))
    lo = s._slugs["x"]["live_orders"]
    assert lo == {"min": None, "median": None, "sellers": 0, "ts": lo["ts"]}


def test_snapshot_live_fields_conditional(tmp_path):
    s = PriceStore(tmp_path, "g")
    # orders-only slug: live_* present, price_* absent (no candles)
    s.ingest_orders("a", "A", _orders(20, 30))
    snap = s.snapshot("a")
    assert snap["live_ask"] == 20 and snap["live_median"] == 25 and snap["live_sellers"] == 2
    assert "price_median" not in snap and "price_min" not in snap and "volume" not in snap
    # stats-only slug: price_* present, live_* absent
    s.ingest_statistics("b", "B", _stats(closed=[("2026-06-08", 48)]))
    snap_b = s.snapshot("b")
    assert snap_b["price_median"] == 48 and "live_ask" not in snap_b
    # both: a slug swept by both modes carries both column sets
    s.ingest_orders("b", "B", _orders(45))
    both = s.snapshot("b")
    assert both["price_median"] == 48 and both["live_ask"] == 45


def test_sweep_catalogue_orders_mode(tmp_path, monkeypatch):
    def fake_orders(slug, timeout=30.0):
        return _orders(99, 47, 60)
    monkeypatch.setattr(price_collector, "fetch_orders", fake_orders)

    items = [("soma_prime", "Soma Prime")]
    res = sweep_catalogue(tmp_path, "g", "live", throttle=0, mode="orders", items=items)
    assert res["fetched"] == 1

    ds = DatasetStore(tmp_path, "g", "live", key=KeySpec(fields=("name",)))
    row = next(r for r in ds.records() if r["name"] == "Soma Prime")
    assert row["live_ask"] == 47 and row["live_sellers"] == 3
    assert "price_median" not in row                # orders mode writes no candle columns


# ---- catalogue producer sweep ----------------------------------------------

def test_sweep_catalogue_writes_dataset_and_history(tmp_path, monkeypatch):
    def fake_stats(slug, timeout=30.0):
        return _stats(closed=[("2026-06-07", 40), ("2026-06-08", 48)])
    monkeypatch.setattr(price_collector, "fetch_statistics", fake_stats)

    items = [("acceltra_prime_set", "Acceltra Prime Set"), ("soma_prime_set", "Soma Prime Set")]
    res = sweep_catalogue(tmp_path, "g", "prices", throttle=0, items=items)
    assert res["fetched"] == 2

    # snapshot rows landed in the output dataset, keyed by name
    ds = DatasetStore(tmp_path, "g", "prices", key=KeySpec(fields=("name",)))
    rows = {r["name"]: r for r in ds.records()}
    assert set(rows) == {"Acceltra Prime Set", "Soma Prime Set"}
    assert rows["Soma Prime Set"]["price_median"] == 48 and rows["Soma Prime Set"]["slug"] == "soma_prime_set"
    # history accumulated in the (separately-named) price store
    assert len(PriceStore(tmp_path, "g").history("acceltra_prime_set")) == 2


def test_sweep_flushes_partial_on_cancel(tmp_path, monkeypatch):
    monkeypatch.setattr(price_collector, "fetch_statistics",
                        lambda slug, timeout=30.0: _stats(closed=[("2026-06-08", 10)]))
    items = [(f"s{i}", f"N{i}") for i in range(10)]
    seen = {"n": 0}

    def stop_after_two():
        seen["n"] += 1
        return seen["n"] > 2          # cancel partway through

    sweep_catalogue(tmp_path, "g", "prices", throttle=0, items=items, should_stop=stop_after_two)
    rows = DatasetStore(tmp_path, "g", "prices", key=KeySpec(fields=("name",))).records()
    assert 0 < len(rows) < 10         # partial data persisted, not the whole list
    assert len(PriceStore(tmp_path, "g").slugs()) == len(rows)


def test_index_sidecar_written(tmp_path, monkeypatch):
    monkeypatch.setattr(price_collector, "fetch_statistics",
                        lambda slug, timeout=30.0: _stats(closed=[("2026-06-01", 100), ("2026-06-08", 130)]))
    sweep_catalogue(tmp_path, "g", "prices", throttle=0, items=[("a", "A"), ("b", "B")])
    idx = PriceStore.read_index(tmp_path, "g")
    assert idx["slugs"] == 2
    assert any(m["slug"] in ("a", "b") for m in idx["movers"])   # +30% mover captured
    assert PriceStore.read_index(tmp_path, "missinggame") == {}


def test_price_store_file_distinct_from_prices_dataset(tmp_path, monkeypatch):
    # regression: PriceStore must NOT use prices.state.json — a "prices" dataset's
    # DatasetStore writes that path and would clobber the time-series store.
    monkeypatch.setattr(price_collector, "fetch_statistics",
                        lambda slug, timeout=30.0: _stats(closed=[("2026-06-08", 10)]))
    sweep_catalogue(tmp_path, "g", "prices", throttle=0, items=[("x", "X")])
    assert (tmp_path / "g" / "price_store.json").exists()
    assert (tmp_path / "g" / "prices.state.json").exists()        # the dataset's own file
    assert PriceStore(tmp_path, "g").price("x") == 10             # not clobbered


# ---- movers -----------------------------------------------------------------

def test_movers_threshold_and_direction(tmp_path):
    s = PriceStore(tmp_path, "g")
    s.ingest_statistics("up", "Up", _stats(closed=[("2026-06-01", 100), ("2026-06-08", 130)]))
    s.ingest_statistics("flat", "Flat", _stats(closed=[("2026-06-01", 100), ("2026-06-08", 102)]))
    s.ingest_statistics("down", "Down", _stats(closed=[("2026-06-01", 100), ("2026-06-08", 60)]))
    movers = s.movers(days=7, threshold=0.1)
    by = {m["slug"]: m for m in movers}
    assert "flat" not in by                          # 2% < 10% threshold
    assert by["up"]["pct"] == pytest.approx(0.30)
    assert by["down"]["pct"] == pytest.approx(-0.40)
    assert [m["slug"] for m in movers] == ["down", "up"]   # sorted by |pct| desc


def test_movers_needs_two_candles(tmp_path):
    s = PriceStore(tmp_path, "g")
    s.ingest_statistics("one", "One", _stats(closed=[("2026-06-08", 100)]))
    assert s.movers(days=7, threshold=0.0) == []


# ---- portfolio + status -----------------------------------------------------

def test_portfolio_sums_and_statuses(tmp_path):
    s = PriceStore(tmp_path, "g")
    s.ingest_statistics("acceltra_prime_set", "Acceltra Prime Set",
                        _stats(closed=[("2026-06-08", 45)]))
    s.mark_missing("junk_slug", "Junk")
    records = [
        {"name": "Acceltra Prime", "count": 2},      # resolves -> priced
        {"name": "Junk", "count": 1},                # resolves to a 404'd slug -> missing
        {"name": "Unpriced", "count": 5},            # resolves but never swept -> pending
        {"name": "Nomatch", "count": 1},             # resolver returns "" -> missing
    ]
    slug_of = {"Acceltra Prime": "acceltra_prime_set", "Junk": "junk_slug",
               "Unpriced": "unpriced_slug", "Nomatch": ""}.get
    folio = s.portfolio(records, lambda n: slug_of(n, ""))
    assert folio["total"] == 90.0                    # 45 * 2
    assert folio["priced"] == 1 and folio["pending"] == 1 and folio["missing"] == 2
    rows = {r["name"]: r for r in folio["rows"]}
    assert rows["Acceltra Prime"]["status"] == "priced" and rows["Acceltra Prime"]["value"] == 90
    assert rows["Junk"]["status"] == "missing"
    assert rows["Unpriced"]["status"] == "pending"
    assert rows["Nomatch"]["status"] == "missing" and rows["Nomatch"]["slug"] == ""
    assert folio["rows"][0]["status"] == "priced"    # priced sorts first


def test_status_of_transitions(tmp_path):
    s = PriceStore(tmp_path, "g")
    assert s.status_of("z") == "pending"
    s.mark_missing("z", "Z")
    assert s.status_of("z") == "missing"
    s.ingest_statistics("z", "Z", _stats(closed=[("2026-06-08", 10)]))
    assert s.status_of("z") == "priced"              # a successful ingest clears the miss


# ---- persistence ------------------------------------------------------------

def test_save_load_roundtrip(tmp_path):
    s = PriceStore(tmp_path, "g")
    s.ingest_statistics("a", "A", _stats(closed=[("2026-06-08", 10)]))
    s.mark_missing("b", "B")
    s.save()
    s2 = PriceStore(tmp_path, "g")
    assert s2.price("a") == 10
    assert s2.status_of("b") == "missing"
    # the file is valid json with the documented top-level keys (distinct from a
    # DatasetStore's prices.state.json, so a "prices" dataset can't clobber it)
    doc = json.loads((tmp_path / "g" / "price_store.json").read_text(encoding="utf-8"))
    assert set(doc) >= {"_meta", "slugs", "misses"}


def test_save_retries_on_permission_error(tmp_path, monkeypatch):
    s = PriceStore(tmp_path, "g")
    s.ingest_statistics("a", "A", _stats(closed=[("2026-06-08", 10)]))
    import os
    real_replace = os.replace
    calls = {"n": 0}

    def flaky(src, dst):
        calls["n"] += 1
        if calls["n"] < 3:                           # fail twice, then succeed
            raise PermissionError("WinError 5")
        return real_replace(src, dst)

    monkeypatch.setattr(os, "replace", flaky)
    monkeypatch.setattr("time.sleep", lambda *_: None)   # don't actually wait
    s.save()
    assert calls["n"] >= 3                                # retried twice, then succeeded
    assert PriceStore(tmp_path, "g").price("a") == 10


# ---- SlugResolver -----------------------------------------------------------

_CATALOGUE = [
    {"url_name": "acceltra_prime_set", "item_name": "Acceltra Prime Set"},
    {"url_name": "primed_continuity", "item_name": "Primed Continuity"},
    {"url_name": "soma_prime_receiver", "item_name": "Soma Prime Receiver"},
]


def test_resolver_exact_name():
    r = SlugResolver(_CATALOGUE)
    assert r.resolve("Primed Continuity") == "primed_continuity"
    assert r.resolve("primed continuity") == "primed_continuity"   # case-insensitive


def test_resolver_direct_slug():
    r = SlugResolver(_CATALOGUE)
    assert r.resolve("Soma Prime Receiver") == "soma_prime_receiver"


def test_resolver_set_heuristic():
    # inventory shows "Acceltra Prime"; market only sells the set
    r = SlugResolver(_CATALOGUE)
    assert r.resolve("Acceltra Prime") == "acceltra_prime_set"


def test_resolver_unmatched_is_none():
    r = SlugResolver(_CATALOGUE)
    assert r.resolve("35mm Film") is None
    assert r.resolve("") is None


def test_resolver_fuzzy_via_corrector():
    class FakeCorrector:
        def best(self, candidate, vocab, cutoff=0.0):
            return ("Primed Continuity", 0.95)        # always snaps to this
    r = SlugResolver(_CATALOGUE, corrector=FakeCorrector(), fuzzy=0.9)
    assert r.resolve("Primd Continuty") == "primed_continuity"   # OCR-ish noise


def test_resolver_real_rapidfuzz_near_miss():
    from oc.learn.rapidfuzz_corrector import RapidFuzzCorrector
    r = SlugResolver(_CATALOGUE, corrector=RapidFuzzCorrector(), fuzzy=0.8)
    assert r.resolve("Primed Continuiy") == "primed_continuity"   # one dropped char


# ---- inventory_slugs --------------------------------------------------------

def test_inventory_slugs_dedups_and_skips_unresolved():
    records = [
        {"name": "Arcane Aegis", "arcane_level": 3},
        {"name": "Arcane Aegis", "arcane_level": 5},   # same slug -> deduped
        {"name": "Nope"},
        {"count": 1},                                  # no name -> skipped
    ]
    resolve = {"Arcane Aegis": "arcane_aegis", "Nope": None}.get
    pairs = inventory_slugs(records, resolve=lambda n: resolve(n))
    assert pairs == [("arcane_aegis", "Arcane Aegis")]


def test_inventory_slugs_default_slugify():
    pairs = inventory_slugs([{"name": "Soma Prime"}])
    assert pairs == [("soma_prime", "Soma Prime")]


# ---- URL building (the unicode crash regression) ----------------------------

def test_item_path_percent_encodes_non_ascii():
    path = wm_client._item_path("aölsim")
    assert "ö" not in path and "%C3%B6" in path
    assert path.startswith("/v1/items/")


def test_fetch_statistics_builds_encoded_url(monkeypatch):
    seen = {}

    def fake_get(path, timeout):
        seen["path"] = path
        return {"payload": {"statistics_closed": {"90days": []}}}

    monkeypatch.setattr(wm_client, "_get", fake_get)
    wm_client.fetch_statistics("höfn")
    assert seen["path"] == "/v1/items/h%C3%B6fn/statistics"


def test_clear_stale_locks_removes_orphaned_sweep_locks(tmp_path):
    # A sweep killed mid-run strands its per-game lock; startup must clear it (else every
    # later sweep is blocked for ~30 min). Plant locks for two games and one stray dir.
    from oc.enrich.price_runner import _lock_path, clear_stale_locks

    for game in ("warframe", "other"):
        p = _lock_path(tmp_path, game)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("999 0")
    (tmp_path / "nolock").mkdir()

    cleared = clear_stale_locks(tmp_path)
    assert sorted(cleared) == ["other", "warframe"]
    assert not _lock_path(tmp_path, "warframe").exists()
    assert not _lock_path(tmp_path, "other").exists()
    # idempotent + safe on a clean tree
    assert clear_stale_locks(tmp_path) == []
    assert clear_stale_locks(tmp_path / "missing") == []
