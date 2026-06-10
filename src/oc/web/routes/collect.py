"""Run live collection ticks from the node editor's 'save' toggle.

Keeps a Collector per game in-process so stability/dedup state carries across ticks
(the DatasetStore persists to disk regardless). ``reset`` rebuilds it with the
current saved profile.
"""

from __future__ import annotations

from fastapi import APIRouter

from ...collect.collector import Collector
from ...profile import load_profile
from ..deps import get_engine, get_settings

router = APIRouter(prefix="/api/collect", tags=["collect"])

_collectors: dict[str, Collector] = {}


@router.post("/{game}")
def collect_tick(game: str, reset: bool = False):
    settings = get_settings()
    if reset or game not in _collectors:
        old = _collectors.pop(game, None)
        if old:
            old.close()
        profile = load_profile(settings.profiles_dir, game)
        _collectors[game] = Collector(get_engine(), profile)
    res = _collectors[game].tick()
    return {"status": res.status.value, "read": res.read, "new": res.new,
            "total": res.total, "window": res.window_id}
