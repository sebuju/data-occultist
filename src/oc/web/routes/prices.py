"""Price/producer endpoints: a background producer sweep + its status.

The price node is a producer: ``refresh`` runs its sweep in a subprocess (throttled,
cancellable) and pushes one current record per source item into its output dataset.
``status`` polls progress; ``summary`` reports just the sweep status. Joining producer
output to inventory is a *view*'s job now, not an endpoint here.
"""

from __future__ import annotations

from fastapi import APIRouter

from ...enrich.price_runner import cancel_sweep, producer_for, start_sweep, sweep_status
from ...profile import list_profiles
from ...runtime import load_live_profile
from ..deps import get_settings

router = APIRouter(prefix="/api/prices", tags=["prices"])


def _profile(game: str):
    settings = get_settings()
    if game in list_profiles(settings.profiles_dir):
        return load_live_profile(settings.profiles_dir, game)
    return None


# ---- background sweep (orchestrated in enrich.price_runner) -----------------

@router.post("/{game}/refresh")
def refresh(game: str, dataset: str = "prices", type: str = "http",
            mode: str = "", throttle: float = 0.4,
            timeout: float = 30.0, limit: int = 0, workers: int = 6):
    """Start a background producer sweep of ``dataset``. The producer node's ``sources`` decide
    what's fetched; its ``type`` (``http`` / ``relic``) decides how. A second call while this
    node is running is a no-op; if a DIFFERENT node in the same game is sweeping, returns
    ``blocked`` instead of starting (one sweep/game)."""
    profile = _profile(game)
    pn = producer_for(profile, dataset, type=type, mode=mode, throttle=throttle)
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


@router.get("/{game}/summary")
def summary(game: str, dataset: str = "prices"):
    """A producer's OWN sweep status (not its output dataset's contents — that's the dataset
    node's job)."""
    return {"game": game, "dataset": dataset, "status": sweep_status(game, dataset)}


# ---- preview / probe (the producer's satellite) -----------------------------

@router.get("/{game}/preview")
def preview(game: str, dataset: str = "prices", limit: int = 50):
    """What an http producer WILL fetch + output, without running a sweep: the resolved item
    names -> keys from its sources, plus the columns it emits. Powers the producer satellite."""
    from ...enrich.http_producer import resolved_inputs
    profile = _profile(game)
    node = producer_for(profile, dataset)
    return resolved_inputs(get_settings().data_dir, game, profile, node, limit=limit)


@router.post("/{game}/probe")
def probe(game: str, dataset: str = "prices", item: str = ""):
    """Live test-fetch ONE item through the taught URL + mapping and return the (trimmed) raw
    response next to the mapped row — so the user can debug paths/filters against the real API.
    ``item`` defaults to the first resolved source item."""
    from ...enrich.http_producer import probe_item
    profile = _profile(game)
    node = producer_for(profile, dataset)
    return probe_item(get_settings().data_dir, game, profile, node, item=item or None)
