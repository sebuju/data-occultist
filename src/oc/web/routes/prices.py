"""Price endpoints: a background warframe.market *producer* sweep + history reads.

The price node is a producer: ``refresh`` sweeps the whole market catalogue in a daemon
thread (throttled, cancellable) and pushes one current snapshot record per item into its
output dataset, while daily candles accumulate in the :class:`PriceStore`. ``status``
polls progress; ``item``/``movers``/``summary`` read the store for the node's chart and
mover list. Joining prices to inventory is a *view*'s job now, not an endpoint here.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter

from ...enrich.price_runner import cancel_sweep, start_sweep, sweep_status
from ...profile import list_profiles, load_profile
from ...profile.models import PriceNodeDef
from ...store import PriceStore
from ..deps import get_settings

router = APIRouter(prefix="/api/prices", tags=["prices"])


# Read-side cache: parsing the (large) price store on every chart click / movers poll is
# wasteful when nothing changed. Reuse a parsed instance until the file's mtime moves.
_store_cache: dict[str, tuple[float, PriceStore]] = {}


def _price_store(game: str) -> PriceStore:
    path = Path(get_settings().data_dir) / game / "price_store.json"
    mtime = path.stat().st_mtime if path.exists() else 0.0
    cached = _store_cache.get(game)
    if cached and cached[0] == mtime:
        return cached[1]
    store = PriceStore(get_settings().data_dir, game)
    _store_cache[game] = (mtime, store)
    return store


def _profile(game: str):
    settings = get_settings()
    if game in list_profiles(settings.profiles_dir):
        return load_profile(settings.profiles_dir, game)
    return None


def _price_node(profile, dataset: str, mode: str, throttle: float) -> PriceNodeDef:
    """The configured price node feeding ``dataset`` (its ``sources`` decide what gets
    priced), or an ephemeral whole-catalogue node when none is taught — preserving the
    original behaviour for a dataset with no price node."""
    if profile is not None:
        for pn in profile.price_nodes:
            if pn.dataset == dataset:
                return pn
    return PriceNodeDef(id=dataset, dataset=dataset, mode=mode, throttle=throttle)


# ---- background sweep (orchestrated in enrich.price_runner) -----------------

@router.post("/{game}/refresh")
def refresh(game: str, dataset: str = "prices", mode: str = "statistics", throttle: float = 0.4,
            timeout: float = 30.0, limit: int = 0, workers: int = 6):
    """Start a background producer sweep of ``dataset`` (``mode`` = statistics | orders).
    The node's ``sources`` decide what's priced (owned gear, relic rewards, …); with no
    sources it sweeps the whole catalogue. A second call while this node is running is a
    no-op; if a DIFFERENT node in the same game (or process) is sweeping, returns
    ``blocked`` instead of starting (one sweep/game)."""
    profile = _profile(game)
    pn = _price_node(profile, dataset, mode, throttle)
    state = start_sweep(get_settings().data_dir, game, pn, profile=profile,
                        timeout=timeout, limit=limit, workers=workers)
    return state.public()


@router.post("/{game}/cancel")
def cancel(game: str, dataset: str = "prices"):
    """Ask this node's running sweep to stop after the current item."""
    return cancel_sweep(game, dataset)


@router.get("/{game}/status")
def status(game: str, dataset: str = "prices"):
    return sweep_status(game, dataset)


# ---- reads ------------------------------------------------------------------

@router.get("/{game}/movers")
def movers(game: str, days: int = 7, threshold: float = 0.15, limit: int = 50):
    """Items whose median moved >= ``threshold`` over ``days``, biggest swing first."""
    return {"game": game, "days": days, "threshold": threshold,
            "movers": _price_store(game).movers(days=days, threshold=threshold, limit=limit)}


@router.get("/{game}/item/{slug}")
def item(game: str, slug: str):
    """One item's daily candle history + summary, for the detail chart."""
    store = _price_store(game)
    info = store.info(slug)
    if info is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail=f"no price data for {slug!r}")
    return {**info, "history": store.history(slug)}


@router.get("/{game}/summary")
def summary(game: str, dataset: str = "prices"):
    """What the price node shows: stored-slug count, top movers, and sweep status. Reads
    the tiny index sidecar (never parses the full candle store), so it stays fast even
    mid-sweep with a huge catalogue."""
    idx = PriceStore.read_index(get_settings().data_dir, game)
    return {
        "game": game, "dataset": dataset,
        "slugs": idx.get("slugs", 0),
        "movers": idx.get("movers", []),
        "status": sweep_status(game, dataset),
    }
