"""Which live session a saved frame belongs to.

Two writers save live frames: the server collector (``collect.live.LiveSession._save_frame``) and
the read-only tuning loop, which hits ``/api/captures/<game>/live/grab`` once per round from the
browser. Both need the SAME notion of "the run currently recording" so one live start = one folder
under ``captures/<game>/live/<session>/`` — this module is that one holder (see
:func:`oc.web.captures_store.save_live` for the on-disk side).

Sessions are begun/ended explicitly (collector start/stop; the live toggle posts begin/end for the
tuning loop). ``current_or_begin`` adds an idle backstop so a client that dies without ever calling
``end`` can't glue tomorrow's frames onto today's recording.
"""

from __future__ import annotations

import threading
import time

from . import captures_store

# A save arriving more than this long after the previous one, with no explicit begin in between,
# starts a fresh session — the backstop for a client that never sent its `end`.
_IDLE = 300.0

_lock = threading.Lock()
_cur: dict[str, tuple[str, float]] = {}   # game -> (session id, monotonic time of last touch)


def begin(game: str) -> str:
    """Start a new session for ``game`` and return its id. No folder is created here — the first
    actual frame save makes it, so a run that captures nothing leaves nothing behind."""
    sid = captures_store.new_session_id()
    with _lock:
        _cur[game] = (sid, time.monotonic())
    return sid


def current(game: str) -> str | None:
    """The session ``game`` is recording into, or None when no live run is open."""
    with _lock:
        held = _cur.get(game)
    return held[0] if held else None


def current_or_begin(game: str) -> str:
    """The open session for ``game``, starting one if there is none (or if the last save is older
    than the idle window). Touches the session so the idle clock runs from the newest save."""
    now = time.monotonic()
    with _lock:
        held = _cur.get(game)
        if held is not None and now - held[1] <= _IDLE:
            _cur[game] = (held[0], now)
            return held[0]
    return begin(game)


def end(game: str) -> None:
    """Close ``game``'s session — the next save starts a new one."""
    with _lock:
        _cur.pop(game, None)
