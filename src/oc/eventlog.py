"""In-process activity-log bus — human-facing "what is happening" messages.

Backend code publishes one-line activity notes (trigger watches + fires, external API
fetches) here; the web app subscribes and streams them to the browser's log bar over SSE.
Decoupled exactly like :mod:`oc.store.changes`: backends NEVER import the web layer, they only
call :func:`publish`. A bounded ring buffer lets a just-connected client backfill recent lines.

Publishers may run on any thread (collector loop, sweep workers, request handlers), so the bus
is plain and thread-safe; subscribers that need an event loop bridge it themselves.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Callable

# subscriber signature: cb(event: dict)
_Sub = Callable[[dict], None]

_lock = threading.Lock()
_subs: list[_Sub] = []
_buffer: deque[dict] = deque(maxlen=500)
_seq = 0


def publish(msg: str, level: str = "info", *, game: str | None = None, **fields) -> dict:
    """Announce one activity line. ``level`` maps to a log-bar style (info/run/ok/warn/err);
    ``game`` scopes it so the UI shows only the current game's lines. A ``file_only=True``
    field (passed via ``**fields`` — see ``routes/logbar.py``'s ``/emit``) marks an event as
    client-originated diagnostics: it still gets persisted to the logbar file by that
    module's subscriber, but ``routes/events.py`` excludes it from the SSE fan-out/backfill
    so the browser that published it doesn't get it echoed back. Returns the event."""
    global _seq
    with _lock:
        _seq += 1
        ev = {"seq": _seq, "ts": time.time(), "msg": str(msg), "level": level,
              "game": game, **fields}
        _buffer.append(ev)
        subs = list(_subs)
    for cb in subs:
        try:
            cb(ev)
        except Exception:  # noqa: BLE001 - one bad subscriber must never break a publisher
            pass
    return ev


def slog(msg: str, *, game: str | None = None) -> None:
    """Print one line to the server console (stdout) with a 24h timestamp — for backend
    events worth seeing in the terminal running the app (e.g. timed/on_change trigger fires),
    separate from the browser log bar that :func:`publish` feeds."""
    stamp = time.strftime("%d/%m/%y %H:%M:%S")
    tag = f"[{game}] " if game else ""
    print(f"{stamp} {tag}{msg}", flush=True)


def recent(after_seq: int = 0, game: str | None = None) -> list[dict]:
    """Buffered events with ``seq`` > ``after_seq`` (for a reconnecting client to backfill).
    A ``game`` filters to that game's lines plus global (gameless) ones."""
    with _lock:
        evs = list(_buffer)
    out = [e for e in evs if e["seq"] > after_seq]
    if game is not None:
        out = [e for e in out if e.get("game") in (None, game)]
    return out


def subscribe(cb: _Sub) -> Callable[[], None]:
    """Register a subscriber; returns an unsubscribe function."""
    with _lock:
        _subs.append(cb)

    def _off() -> None:
        with _lock:
            if cb in _subs:
                _subs.remove(cb)
    return _off
