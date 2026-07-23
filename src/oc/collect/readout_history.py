"""In-memory recent-read history per readout — non-persisted, process-memory only.

The teach UI's readout *history* satellite node shows the last few reads of a readout: WHEN it
was read, the RAW OCR text, each rule's pass/skip/drop step, and the final resolved value — the
same rule trace the readout node itself shows, laid out one row per read. Like the trigger-/
register-/process-history rings ([[trigger_history]] and siblings) this is deliberately transient:
a ring buffer in module memory, wiped on restart (a live debugging view, not an audit log — the
user asked for no persistence). The ring mechanics live in the shared
:class:`oc.collect.history_ring.HistoryRing` primitive; this module only fixes the readout key +
read-record shape — composite-keyed as ``"<window>:<readout>"`` (HistoryRing itself only knows
``(game, id)``, so a readout's 3-part identity collapses to one id string, exactly the shape
:func:`snapshot` already exposed).

The collector calls :func:`record` for every evaluated readout read (every OCR-due tick), keyed by
``(game, window_id, readout_id)``. :func:`recent` is read by the live heartbeat (``live.status()``)
and delivered to the client, which paints it into an OPEN satellite (empty/no-op when hidden).
"""

from __future__ import annotations

from .history_ring import HistoryRing

_ring = HistoryRing(200, kind="readout")


def _id(window_id: str, readout_id: str) -> str:
    return f"{window_id}:{readout_id}"


def record(game: str, window_id: str, readout_id: str, *, ts: str, raw, value,
           dropped: bool, trace: list, conf: float) -> None:
    """Append one readout read to its ring (newest first). ``ts`` is an ISO timestamp (the caller
    stamps it). ``trace`` is the per-rule step list from :func:`oc.collect.fields.run_rules`
    (``{i, when, then, in, out, fired, ignored?}`` each), ``value`` the final resolved value,
    ``dropped`` whether a rule rejected the read, ``raw`` the pre-rules OCR text (``None`` for
    pip/symbol readouts that carry no OCR text)."""
    _ring.record((game, _id(window_id, readout_id)),
                 {"ts": ts, "raw": raw, "value": value, "dropped": dropped,
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
    return _ring.recent((game, _id(window_id, readout_id)))


def snapshot(game: str) -> dict:
    """``{"<window>:<readout>": [recent reads]}`` for every readout of ``game`` with reads this
    session. Module-level, so the activity heartbeat can surface readout history WITHOUT a running
    live collector — the ring is fed by both live collection and the teach-UI test feed (mirrors
    :func:`producer_history.snapshot`)."""
    return _ring.snapshot(game)


def clear(game: str, window_id: str | None = None) -> None:
    """Drop history for one window's readouts, or (``window_id=None``) every readout of ``game``."""
    if window_id is None:
        _ring.clear(game)
        return
    prefix = f"{window_id}:"
    for comp_id in list(_ring.snapshot(game)):
        if comp_id.startswith(prefix):
            _ring.clear(game, comp_id)
