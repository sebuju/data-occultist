"""Live warframe.market checks — the real network path end to end, via the generic http node.

These hit the public API, so they're gated to never FAIL on an outage:
* a session-scoped probe skips the whole module (with a message) when the API is unreachable;
* a module-level circuit breaker trips on the first connectivity error mid-run, so every
  remaining network test skips immediately instead of re-hitting a dead endpoint.

Run just these with ``pytest -m network``; skip them with ``pytest -m "not network"``.
"""

import time

import pytest

from oc.enrich.http_get import NET_ERRORS, http_get_json
from oc.enrich.price_runner import start_sweep
from oc.profile.models import (
    HttpArraySpec, HttpField, HttpFilter, HttpRequest, HttpSpec, GameProfile, ProducerDef,
)
from oc.store import DatasetStore, KeySpec

pytestmark = pytest.mark.network

# Mods are always tradeable and their market slug is just the lowercased name, so we can
# resolve without fetching the (large) catalogue. They reliably have online sellers.
_KNOWN = ["Serration", "Vitality"]
_ORDERS_URL = "https://api.warframe.market/v2/orders/item/{key}"
_HEADERS = {"platform": "pc", "User-Agent": "oc/0.1", "Accept": "application/json"}

_down = False   # circuit breaker: set once the API proves unreachable this run


def _trip(exc):
    global _down
    _down = True
    pytest.skip(f"warframe.market unreachable: {exc!r}")


def _guard():
    if _down:
        pytest.skip("warframe.market unreachable earlier this run")


def _spec():
    flt = [HttpFilter(path="type", op="eq", value="sell"),
           HttpFilter(path="user.status", op="in", value=["online", "ingame"])]
    return HttpSpec(
        request=HttpRequest(url=_ORDERS_URL, headers=_HEADERS, timeout=20),
        key_transform="lowercase", root="data",
        fields=[HttpField(out_field="price_min", type="number",
                          array=HttpArraySpec(filter=flt, pluck="platinum", agg="min"))])


@pytest.fixture(scope="session")
def market():
    """Probe the API once; skip the whole module (never fail) if it's down."""
    try:
        http_get_json(_ORDERS_URL.format(key="serration"), headers=_HEADERS, timeout=15.0)
    except Exception as e:                       # noqa: BLE001 - any probe failure -> skip, not fail
        pytest.skip(f"warframe.market unreachable: {e!r}")
    return True


def test_orders_fetch_returns_live_prices(market):
    _guard()
    try:
        payload = http_get_json(_ORDERS_URL.format(key="serration"), headers=_HEADERS, timeout=20.0)
    except NET_ERRORS as e:
        _trip(e)
    orders = payload.get("data") or []
    assert isinstance(orders, list) and orders
    plats = [o["platinum"] for o in orders if o.get("type") == "sell"]
    assert all(isinstance(p, int) and p > 0 for p in plats)


def _wait(state, timeout=90.0):
    t0 = time.time()
    while state.running and time.time() - t0 < timeout:
        time.sleep(0.5)
    return state


def test_start_sweep_prices_only_its_sources(market, tmp_path):
    _guard()
    # an inventory dataset with two known items; the node sources ONLY this dataset
    ds = DatasetStore(tmp_path, "g", "master", key=KeySpec(fields=("name",)))
    ds.begin_batch()
    for nm in _KNOWN:
        ds.record_seen({"name": nm})
    ds.save()

    pn = ProducerDef(id="live", dataset="prices_live", type="http", mode="orders",
                     sources=["master"], http=_spec())
    profile = GameProfile(name="g", datasets=[{"id": "master"}, {"id": "prices_live"}], producers=[pn])
    state = start_sweep(tmp_path, "g", pn, profile=profile, workers=2)
    _wait(state)

    assert not state.running
    if state.fetched == 0:                       # a mid-run outage swallowed by the sweep -> skip, not fail
        _trip(RuntimeError("no items priced (API likely unreachable)"))

    out = DatasetStore(tmp_path, "g", "prices_live", key=KeySpec(fields=("name",)))
    names = {r["name"] for r in out.records()}
    assert names                                 # priced at least one
    assert names <= set(_KNOWN)                  # and ONLY the sourced items, never the whole catalogue
