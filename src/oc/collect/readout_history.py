"""In-memory recent-read history per readout — non-persisted, process-memory only.

The teach UI's readout *history* satellite node shows the last few reads of a readout: WHEN it
was read, the RAW OCR text, each rule's pass/skip/drop step, and the final resolved value — the
same rule trace the readout node itself shows, laid out one row per read. Like the trigger-fire
history ([[trigger_history]]), this is deliberately transient: a ring buffer in module memory,
wiped on restart (a live debugging view, not an audit log — the user asked for no persistence).

The collector calls :func:`record` for every evaluated readout read (every OCR-due tick), keyed by
``(game, window_id, readout_id)``. :func:`recent` is read by the live heartbeat (``live.status()``)
and delivered to the client, which paints it into an OPEN satellite (empty/no-op when hidden).
"""

from __future__ import annotations

from collections import deque

_CAP = 200
# (game, window_id, readout_id) -> deque of newest-first read records
_history: dict[tuple[str, str, str], deque] = {}


def record(game: str, window_id: str, readout_id: str, *, ts: str, raw, value,
           dropped: bool, trace: list, conf: float) -> None:
    """Append one readout read to its ring (newest first). ``ts`` is an ISO timestamp (the caller
    stamps it). ``trace`` is the per-rule step list from :func:`oc.collect.fields.run_rules`
    (``{i, when, then, in, out, fired, ignored?}`` each), ``value`` the final resolved value,
    ``dropped`` whether a rule rejected the read, ``raw`` the pre-rules OCR text (``None`` for
    pip/symbol readouts that carry no OCR text)."""
    key = (game, window_id, readout_id)
    dq = _history.get(key)
    if dq is None:
        dq = _history[key] = deque(maxlen=_CAP)
    dq.appendleft({"ts": ts, "raw": raw, "value": value, "dropped": dropped,
                   "trace": list(trace or []), "conf": round(conf, 3)})


def record_reads(game: str, window_id: str, ro_trace: list, ts: str) -> None:
    """Record every evaluated readout read this tick to its history ring. ``ro_trace`` is
    ``RegionReader.read_readouts_detailed``'s ``trace_sink`` — one ``{id, value, raw, dropped,
    conf, trace}`` per enabled readout. Shared by the collector loop and the teach-UI test feed
    (rule 7 — one recorder, not two)."""
    for rec in ro_trace:
        record(game, window_id, rec["id"], ts=ts, raw=rec["raw"], value=rec["value"],
               dropped=rec["dropped"], trace=rec["trace"], conf=rec["conf"])


def recent(game: str, window_id: str, readout_id: str) -> list[dict]:
    """This readout's recent reads, newest first (empty if it hasn't been read this session)."""
    return list(_history.get((game, window_id, readout_id), ()))


def snapshot(game: str) -> dict:
    """``{"<window>:<readout>": [recent reads]}`` for every readout of ``game`` with reads this
    session. Module-level twin of the (now removed) per-session builder, so the activity heartbeat
    can surface readout history WITHOUT a running live collector — the ring is fed by both live
    collection and the teach-UI test feed (mirrors :func:`producer_history.snapshot`)."""
    out: dict[str, list] = {}
    for (g, win, rid), dq in _history.items():
        if g == game and dq:
            out[f"{win}:{rid}"] = list(dq)
    return out


def clear(game: str, window_id: str | None = None) -> None:
    """Drop history for one window's readouts, or (``window_id=None``) every readout of ``game``."""
    for key in [k for k in _history if k[0] == game and (window_id is None or k[1] == window_id)]:
        _history.pop(key, None)
