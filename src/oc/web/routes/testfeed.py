"""Testing-inspector endpoint: feed synthetic readout values into a game's live session,
bypassing OCR entirely, so gates/routers/registers/``on_readout`` triggers can be exercised
with no game running and no matching video frame.

The heavy lifting is :meth:`LiveSession.feed_readouts` (the same method
``/api/preview?feed=1`` uses after OCR-ing a real image) — this route just builds the
``detailed``/``ro_trace`` shapes it expects from hand-supplied values instead of a read.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ...profile import GameProfile
from .live import session_for

router = APIRouter(prefix="/api/test", tags=["test"])


class FeedReadoutsBody(BaseModel):
    profile: GameProfile
    window_id: str
    values: dict[str, str | float | int]


@router.post("/feed_readouts")
def feed_readouts(body: FeedReadoutsBody, game: str = Query(...)):
    """Fold ``body.values`` (``{readout_id: value}``) into ``game``'s live session as if
    they had just been OCR'd off that window — same fold ``feed=1`` preview uses (registers,
    processes, gates, routers, ``on_readout`` triggers, SSE flow/fire, ``.ro-live``)."""
    window = next((w for w in body.profile.windows if w.id == body.window_id), None)
    if window is None:
        raise HTTPException(status_code=404, detail="window not found")
    sess = session_for(game, create=True)
    if sess is None:
        raise HTTPException(status_code=404, detail=f"no profile {game!r}")
    ro_ids = {v.id for v in window.readouts if v.enabled}
    unknown = set(body.values) - ro_ids
    if unknown:
        raise HTTPException(status_code=400, detail=f"not a readout on this window: {sorted(unknown)}")
    detailed = {rid: (val, 1.0, str(val), None) for rid, val in body.values.items()}
    # mirror read_readouts_detailed's trace_sink, but only for the readouts this feed actually
    # supplies: each entry is recorded to the readout's history ring, and a readout we never fed
    # was not READ at all — logging it as a dropped read would invent a phantom read (and `conf`
    # is typed float, so there is no "unknown" to put there).
    ro_trace = [
        {"id": rid, "value": val, "raw": str(val), "dropped": False, "conf": 1.0, "trace": []}
        for rid, val in body.values.items()
    ]
    sess.feed_readouts(detailed, ro_trace, window, window.id, body.profile.registers, body.profile)
    return {"fed": sorted(body.values)}
