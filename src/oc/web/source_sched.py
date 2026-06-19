"""Background file-source watcher + lifecycle-trigger firer for the teach app.

Two jobs, both driven by the web process (file sources never run in the OCR capture loop):

* **Watch** — for every enabled ``watch="on_change"`` file source, a daemon thread stats the
  file and reads it through the shared :func:`oc.source.runner.read_source`. A trailing
  ``throttle_s`` rate-limits reads while a file keeps changing AND guarantees the latest state
  is read once it settles (read at most once per window, always eventually catching the newest
  signature). Coalesced via the shared :class:`SourceReader`, so two nodes on one file = one read.
* **Lifecycle triggers** — fire ``on_app_start`` triggers once when this daemon launches, and
  expose :func:`fire_capture` for the live/precapture routes to call when a capture session starts.

Reuses :class:`TriggerRunner` so firing logic is identical to the collector's.
"""

from __future__ import annotations

import threading
import time

from ..collect.triggers import TriggerRunner
from ..profile import list_profiles
from ..runtime import load_live_profile
from ..source.locate import resolve_path
from ..source.reader import default_reader
from ..source.runner import read_source

_lock = threading.Lock()
# game -> source_id -> {sig, read_sig, last_read(monotonic), rows, read_at(monotonic)}
_state: dict[str, dict[str, dict]] = {}
_started = False


def _watch_tick(settings) -> None:
    reader = default_reader()
    now = time.monotonic()
    for game in list_profiles(settings.profiles_dir):
        try:
            profile = load_live_profile(settings.profiles_dir, game)
        except Exception:   # noqa: BLE001 - one bad profile must not kill the loop
            continue
        gstate = _state.setdefault(game, {})
        live_ids = set()
        for src in profile.file_sources:
            if not src.enabled or src.watch != "on_change":
                continue
            live_ids.add(src.id)
            path = resolve_path(src)
            if not path:
                continue
            sig = reader.stat(path)
            if sig is None:
                continue
            st = gstate.setdefault(src.id, {"sig": None, "read_sig": None, "last_read": 0.0,
                                            "rows": 0, "read_at": 0.0})
            st["sig"] = sig
            # Read when the file's signature differs from what we last read AND the throttle
            # window has elapsed: this caps reads to one per window while a log streams, and
            # the final signature is still picked up on the next tick after it goes quiet.
            if sig != st["read_sig"] and now - st["last_read"] >= max(0.0, src.throttle_s):
                try:
                    st["rows"] = read_source(game, src, settings.data_dir, profile=profile, reader=reader)
                    st["read_sig"] = sig
                    st["last_read"] = st["read_at"] = now
                except Exception:   # noqa: BLE001
                    pass
        # drop state for sources no longer watched (renamed/disabled) so it can't leak
        for sid in [s for s in gstate if s not in live_ids]:
            gstate.pop(sid, None)


def _loop(settings) -> None:
    from .shutdown import is_shutting_down
    while not is_shutting_down():
        with _lock:
            try:
                _watch_tick(settings)
            except Exception:   # noqa: BLE001
                pass
        time.sleep(0.5)


def _fire_kind_all(settings, fire) -> None:
    """Run ``fire(runner)`` for every profile that has a matching enabled lifecycle trigger."""
    for game in list_profiles(settings.profiles_dir):
        try:
            profile = load_live_profile(settings.profiles_dir, game)
            if profile.triggers:
                fire(TriggerRunner(profile, settings.data_dir))
        except Exception:   # noqa: BLE001
            continue


def fire_capture(game: str, settings) -> None:
    """Fire ``on_capture`` triggers for ``game`` — called when a live/precapture session starts."""
    try:
        profile = load_live_profile(settings.profiles_dir, game)
        if any(t.enabled and t.kind == "on_capture" for t in profile.triggers):
            TriggerRunner(profile, settings.data_dir).fire_capture()
    except Exception:   # noqa: BLE001 - a lifecycle fire must never break the capture start
        pass


def start(settings) -> None:
    """Launch the watcher thread once and fire ``on_app_start`` triggers (called from lifespan)."""
    global _started
    if _started:
        return
    _started = True
    _fire_kind_all(settings, lambda r: r.fire_app_start())
    threading.Thread(target=_loop, args=(settings,), daemon=True).start()


def sources(game: str, settings) -> list[dict]:
    """Live file-source view for ``game`` (for the Activity panel): each enabled source with its
    resolved path, watch mode, last-read row count and seconds-since-read."""
    with _lock:
        try:
            profile = load_live_profile(settings.profiles_dir, game)
        except Exception:   # noqa: BLE001
            return []
        gstate = _state.get(game, {})
        now = time.monotonic()
        out: list[dict] = []
        for src in profile.file_sources:
            if not src.enabled:
                continue
            st = gstate.get(src.id) or {}
            read_at = st.get("read_at", 0.0)
            out.append({
                "id": src.id, "format": src.format, "watch": src.watch,
                "dataset": src.dataset, "path": resolve_path(src),
                "rows": st.get("rows", 0),
                "ago_s": round(now - read_at) if read_at else None,
            })
        return out
