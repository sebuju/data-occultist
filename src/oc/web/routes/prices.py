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
    mode: str = "statistics"
    total: int = 0
    done: int = 0
    fetched: int = 0
    failed: int = 0
    running: bool = False
    cancel: bool = False
    # set when a sweep was refused because another node in the same game is sweeping
    # (fetching is serialised per game for the rate limit + shared price store).
    blocked: bool = False
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


# Runner state is per (game, dataset) so each price node tracks its own sweep
# independently. Fetching, though, is serialised PER GAME by _game_gate: two concurrent
# sweeps would blow past warframe.market's rate ceiling and clobber the shared
# price_store.json (and are throughput-neutral under the cap anyway).
_runners: dict[tuple[str, str], _Runner] = {}
_game_gate: dict[str, threading.Lock] = {}
_gate_guard = threading.Lock()


def _runner(game: str, dataset: str) -> _Runner:
    return _runners.setdefault((game, dataset), _Runner())


def _gate(game: str) -> threading.Lock:
    with _gate_guard:
        return _game_gate.setdefault(game, threading.Lock())


def _run_sweep(game: str, dataset: str, mode: str, throttle: float, timeout: float,
               limit: int, workers: int, gate: threading.Lock) -> None:
    state = _runner(game, dataset).state
    settings = get_settings()

    def on_item(done, total, slug, name, ok):
        state.total = total
        state.done = done
        state.last = name
        if ok:
            state.fetched += 1
        else:
            state.failed += 1

    try:
        sweep_catalogue(settings.data_dir, game, dataset, key=_dataset_key(game, dataset),
                        throttle=throttle, timeout=timeout, limit=limit, workers=workers,
                        mode=mode, on_item=on_item, should_stop=lambda: state.cancel)
    finally:
        state.running = False
        state.finished = _utcnow_iso()
        gate.release()


@router.post("/{game}/refresh")
def refresh(game: str, dataset: str = "prices", mode: str = "statistics", throttle: float = 0.4,
            timeout: float = 30.0, limit: int = 0, workers: int = 6):
    """Start a background producer sweep of ``dataset`` (``mode`` = statistics | orders).
    A second call while this node is running is a no-op; if a DIFFERENT node in the same
    game is sweeping, returns a ``blocked`` status instead of starting (one sweep/game)."""
    runner = _runner(game, dataset)
    if runner.state and runner.state.running:
        return runner.state.public()
    gate = _gate(game)
    if not gate.acquire(blocking=False):
        return SweepState(game=game, dataset=dataset, mode=mode, blocked=True).public()
    runner.state = SweepState(game=game, dataset=dataset, mode=mode, running=True,
                              started=_utcnow_iso())
    runner.thread = threading.Thread(
        target=_run_sweep,
        args=(game, dataset, mode, throttle, timeout, limit, workers, gate), daemon=True)
    try:
        runner.thread.start()
    except RuntimeError:           # thread couldn't start — don't strand the gate
        runner.state.running = False
        gate.release()
        raise
    return runner.state.public()


@router.post("/{game}/cancel")
def cancel(game: str, dataset: str = "prices"):
    """Ask this node's running sweep to stop after the current item."""
    runner = _runner(game, dataset)
    if runner.state and runner.state.running:
        runner.state.cancel = True
    return runner.state.public() if runner.state else {"running": False}


@router.get("/{game}/status")
def status(game: str, dataset: str = "prices"):
    runner = _runner(game, dataset)
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
    runner = _runner(game, dataset)
    return {
        "game": game, "dataset": dataset,
        "slugs": idx.get("slugs", 0),
        "movers": idx.get("movers", []),
        "status": runner.state.public() if runner.state else {"running": False},
    }
