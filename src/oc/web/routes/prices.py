"""Price endpoints: a background warframe.market *producer* sweep + history reads.

The price node is a producer: ``refresh`` sweeps the whole market catalogue in a daemon
thread (throttled, cancellable) and pushes one current snapshot record per item into its
output dataset, while daily candles accumulate in the :class:`PriceStore`. ``status``
polls progress; ``item``/``movers``/``summary`` read the store for the node's chart and
mover list. Joining prices to inventory is a *view*'s job now, not an endpoint here.
"""

from __future__ import annotations

import threading
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter

from ...enrich.price_collector import sweep_catalogue
from ...profile import list_profiles, load_profile
from ...store import PriceStore
from ..deps import get_settings

router = APIRouter(prefix="/api/prices", tags=["prices"])


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


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


def _dataset_key(game: str, dataset: str):
    settings = get_settings()
    if game in list_profiles(settings.profiles_dir):
        return load_profile(settings.profiles_dir, game).key_map_for(dataset)
    return None


# ---- background sweep -------------------------------------------------------

@dataclass
class SweepState:
    game: str
    dataset: str
    total: int = 0
    done: int = 0
    fetched: int = 0
    failed: int = 0
    running: bool = False
    cancel: bool = False
    last: str = ""
    started: str = ""
    finished: str = ""

    def public(self) -> dict:
        d = asdict(self)
        d.pop("cancel", None)
        return d


@dataclass
class _Runner:
    state: SweepState | None = None
    thread: threading.Thread | None = field(default=None)


_runners: dict[str, _Runner] = {}


def _runner(game: str) -> _Runner:
    return _runners.setdefault(game, _Runner())


def _run_sweep(game: str, dataset: str, throttle: float, timeout: float, limit: int) -> None:
    runner = _runner(game)
    state = runner.state
    settings = get_settings()

    def on_item(idx, total, slug, name, ok):
        state.total = total
        state.done = idx
        state.last = name
        if ok:
            state.fetched += 1
        else:
            state.failed += 1

    try:
        sweep_catalogue(settings.data_dir, game, dataset, key=_dataset_key(game, dataset),
                        throttle=throttle, timeout=timeout, limit=limit,
                        on_item=on_item, should_stop=lambda: state.cancel)
    finally:
        state.running = False
        state.finished = _utcnow_iso()


@router.post("/{game}/refresh")
def refresh(game: str, dataset: str = "prices", throttle: float = 0.4,
            timeout: float = 30.0, limit: int = 0):
    """Start a background producer sweep: price the whole market catalogue into
    ``dataset``. Returns the initial status; a second call while running is a no-op."""
    runner = _runner(game)
    if runner.state and runner.state.running:
        return runner.state.public()
    runner.state = SweepState(game=game, dataset=dataset, running=True, started=_utcnow_iso())
    runner.thread = threading.Thread(
        target=_run_sweep, args=(game, dataset, throttle, timeout, limit), daemon=True)
    runner.thread.start()
    return runner.state.public()


@router.post("/{game}/cancel")
def cancel(game: str):
    """Ask a running sweep to stop after the current item."""
    runner = _runner(game)
    if runner.state and runner.state.running:
        runner.state.cancel = True
    return runner.state.public() if runner.state else {"running": False}


@router.get("/{game}/status")
def status(game: str):
    runner = _runner(game)
    return runner.state.public() if runner.state else {"running": False, "total": 0, "done": 0}


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
    runner = _runner(game)
    return {
        "game": game, "dataset": dataset,
        "slugs": idx.get("slugs", 0),
        "movers": idx.get("movers", []),
        "status": runner.state.public() if runner.state else {"running": False},
    }
