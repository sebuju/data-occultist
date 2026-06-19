"""Relic-contents enricher.

Maps a Void relic name (e.g. ``"Axi A1"``) to the items it can drop, each with its
rarity, drop chance, and ducat value. Reward / rarity / chance come from the WFCD
``warframe-drop-data`` ``relics.json``; ducats from the warframe.market v2 item
endpoint. The merged table is fetched once and cached to
``<data_dir>/warframe/relic_table.json``.

The *live* enrich path only ever READS that cache (cheap, mtime-memoised). A missing
cache kicks a one-off BACKGROUND build and degrades to a placeholder until it lands, so
a view refresh never blocks on the network — matching the "network never in the live
loop" rule. ``live_safe = True`` lets :func:`oc.enrich.subset.compute_view` run it.
"""

from __future__ import annotations

import json
import re
import threading
import urllib.request
from pathlib import Path

from ..interfaces import Enricher
from ..registry import register_enricher
from ..settings import Settings
from .wm_client import NET_ERRORS, fetch_item_ducats, slugify

_RELICS_URL = "https://raw.githubusercontent.com/WFCD/warframe-drop-data/main/data/relics.json"
_DEFAULT_STATE = "Intact"

# Rewards with no Baro/market ducat value (untradeable) — warframe.market has no entry
# for them, so hard-code 0 to keep the table complete. Keyed by :func:`_norm` of the name.
_DUCAT_FALLBACK = {
    "FORMA BLUEPRINT": 0,
    "2X FORMA BLUEPRINT": 0,
    "FORMA": 0,
    "2X FORMA": 0,
}


def _norm(name: str) -> str:
    """Normalise a name for case/noise-insensitive matching: uppercase, strip a stray
    "RELIC" word, drop punctuation, collapse whitespace. ``"Axi A1 Relic" -> "AXI A1"``."""
    s = re.sub(r"[^A-Z0-9 ]+", " ", str(name).upper())
    s = re.sub(r"\bRELIC\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _cache_path() -> Path:
    return Path(Settings.load().data_dir) / "warframe" / "relic_table.json"


# ---------------------------------------------------------------------------
# Table build (network-heavy — only on the explicit/background build, never live)
# ---------------------------------------------------------------------------

def _fetch_relics_json() -> dict:
    req = urllib.request.Request(
        _RELICS_URL, headers={"User-Agent": "oc/0.1", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:   # noqa: S310 - fixed trusted URL
        return json.loads(r.read().decode("utf-8"))


def _resolve_ducats(items, fetch_ducats=None) -> dict[str, int]:
    """``{itemName -> ducats}`` for every distinct reward, resolved once. Untradeable
    rewards (Forma) use the hard-coded fallback; anything the market can't price -> 0."""
    fetch_ducats = fetch_ducats or fetch_item_ducats
    out: dict[str, int] = {}
    for name in sorted(items):
        fb = _DUCAT_FALLBACK.get(_norm(name))
        if fb is not None:
            out[name] = fb
            continue
        try:
            d = fetch_ducats(slugify(name))
        except NET_ERRORS:
            d = None
        out[name] = int(d) if d else 0
    return out


def build_relic_table(force: bool = False, *, fetch_relics=None, fetch_ducats=None) -> dict:
    """Build ``{relic -> {state -> [{item, rarity, chance, ducats}, ...]}}`` from
    relics.json + market ducats and cache it. ``fetch_relics`` / ``fetch_ducats`` are
    injectable for tests. Network-heavy — never call from the live view path; the
    enricher reads the cache instead."""
    path = _cache_path()
    if path.exists() and not force:
        return _read_cache(path)
    raw = (fetch_relics or _fetch_relics_json)()
    items = {rw["itemName"] for r in raw.get("relics", [])
             for rw in r.get("rewards", []) if rw.get("itemName")}
    ducats = _resolve_ducats(items, fetch_ducats)
    table: dict[str, dict[str, list]] = {}
    for r in raw.get("relics", []):
        rn = r.get("relicName")
        if not rn:                       # e.g. Requiem entries — not standard Void relics
            continue
        name = _norm(f"{r.get('tier', '')} {rn}")
        rewards = [
            {"item": rw["itemName"], "rarity": rw.get("rarity", ""),
             "chance": rw.get("chance"), "ducats": ducats.get(rw["itemName"], 0)}
            for rw in r.get("rewards", []) if rw.get("itemName")
        ]
        table.setdefault(name, {})[r.get("state", _DEFAULT_STATE)] = rewards
    _write_cache(path, table)
    return table


# ---------------------------------------------------------------------------
# Cheap cached read (live-safe) + non-blocking warm
# ---------------------------------------------------------------------------

_lock = threading.Lock()
_cache: dict | None = None
_cache_mtime: float | None = None
_building = False


def _read_cache(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_cache(path: Path, table: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(table, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def _load() -> dict:
    """In-memory view of the on-disk table, reloaded only when the file changes. Returns
    ``{}`` when no cache exists yet (the live path then degrades to a placeholder)."""
    global _cache, _cache_mtime
    path = _cache_path()
    if not path.exists():
        return {}
    mtime = path.stat().st_mtime
    if _cache is None or mtime != _cache_mtime:
        _cache = _read_cache(path)
        _cache_mtime = mtime
    return _cache


def _ensure_built() -> None:
    """Kick a one-off background build when the cache is missing. Non-blocking: the live
    enrich path returns a placeholder until the build lands, then picks it up via mtime."""
    global _building
    if _cache_path().exists():
        return
    with _lock:
        if _building or _cache_path().exists():
            return
        _building = True

    def run() -> None:
        global _building
        try:
            build_relic_table()
        except Exception:   # noqa: BLE001 - best-effort warm; missing data just lingers
            pass
        finally:
            _building = False

    threading.Thread(target=run, name="relic-table-build", daemon=True).start()


def _fmt(r: dict) -> str:
    chance = r.get("chance")
    ch = f"{chance:g}%" if isinstance(chance, (int, float)) else ""
    meta = ", ".join(p for p in (r.get("rarity", ""), ch, f"{r.get('ducats', 0)}d") if p)
    return f"{r.get('item', '')} ({meta})" if meta else str(r.get("item", ""))


@register_enricher("relic_contents")
class RelicContentsEnricher(Enricher):
    """Look up a relic's reward list (item, rarity, drop chance, ducats). ``source_field``
    is the column holding the relic name; ``state`` picks which drop-chance tier to surface
    (default Intact). Cheap + live-safe: reads the cached table only, never the network."""

    live_safe = True

    def __init__(self, source_field: str = "name", state: str = _DEFAULT_STATE) -> None:
        self._field = source_field
        self._state = state

    def enrich(self, values: dict) -> dict:
        relic = values.get(self._field)
        if not relic:
            return {}
        table = _load()
        if not table:
            _ensure_built()
            return {"relic_contents": "(no data yet)", "relic_rewards": ""}
        states = table.get(_norm(str(relic)))
        if not states:
            return {}
        rewards = states.get(self._state) or next(iter(states.values()), [])
        return {
            "relic_contents": str(len(rewards)),
            "relic_rewards": ", ".join(_fmt(r) for r in rewards),
        }
