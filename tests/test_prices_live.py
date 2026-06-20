"""Live warframe.market checks — the real network path end to end.

These hit the public API, so they're gated to never FAIL on an outage:
* a session-scoped probe skips the whole module (with a message) when the API is unreachable;
* a module-level circuit breaker trips on the first connectivity error mid-run, so every
  remaining network test skips immediately instead of re-hitting a dead endpoint.

Run just these with ``pytest -m network``; skip them with ``pytest -m "not network"``.
"""

import time

import pytest

from oc.enrich import wm_client
from oc.enrich.price_runner import start_sweep
from oc.enrich.wm_client import NET_ERRORS, fetch_orders
from oc.profile.models import GameProfile, ProducerDef
from oc.store import DatasetStore, KeySpec

pytestmark = pytest.mark.network

# Mods are always tradeable and their market slug is just the lowercased name, so we can
# resolve without fetching the (large) catalogue. They reliably have online sellers.
_KNOWN = ["Serration", "Vitality"]

_down = False   # circuit breaker: set once the API proves unreachable this run


def _trip(exc):
    global _down
    _down = True
    pytest.skip(f"warframe.market unreachable: {exc!r}")


def _guard():
    if _down:
        pytest.skip("warframe.market unreachable earlier this run")


@pytest.fixture(scope="session")
def market():
    """Probe the API once; skip the whole module (never fail) if it's down."""
    try:
        fetch_orders("serration", timeout=15.0)
    except Exception as e:                       # noqa: BLE001 - any probe failure -> skip, not fail
        pytest.skip(f"warframe.market unreachable: {e!r}")
    return True


def test_orders_fetch_returns_live_prices(market):
    _guard()
    try:
        orders = fetch_orders("serration", timeout=20.0)
    except NET_ERRORS as e:
        _trip(e)
    assert isinstance(orders, list) and orders
    prices = wm_client.online_sell_prices(orders)
    # a popular mod essentially always has online sellers; prices are positive ints
    assert all(isinstance(p, int) and p > 0 for p in prices)


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

    pn = ProducerDef(id="live", dataset="prices_live", mode="orders", sources=["master"])
    profile = GameProfile(name="g", datasets=[{"id": "master"}, {"id": "prices_live"}], producers=[pn])
    # lowercased name resolves straight to the mod's slug — no catalogue fetch needed
    state = start_sweep(tmp_path, "g", pn, profile=profile, resolve=lambda n: n.lower(), workers=2)
    _wait(state)

    assert not state.running
    if state.fetched == 0:                       # a mid-run outage swallowed by the sweep -> skip, not fail
        _trip(RuntimeError("no items priced (API likely unreachable)"))

    out = DatasetStore(tmp_path, "g", "prices_live", key=KeySpec(fields=("name",)))
    names = {r["name"] for r in out.records()}
    assert names                                 # priced at least one
    assert names <= set(_KNOWN)                  # and ONLY the sourced items, never the whole catalogue
