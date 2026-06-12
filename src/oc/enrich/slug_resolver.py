"""Reconcile noisy inventory names to warframe.market slugs.

A collected name (OCR'd display text) often is NOT a market ``url_name``: the market
slugs "Soma Prime" as ``soma_prime_set``, won't list cosmetics at all, and OCR adds
noise. Naive :func:`slugify` therefore misses a lot. This resolver loads the market's
full item catalogue once (cached on disk, weekly TTL) and maps a name to its slug by,
in order: exact display-name match, direct slugify hit, the common "… Set" framing,
then a fuzzy match against display names via the configured :class:`Corrector`.

Returns ``None`` when nothing clears the bar — the name is treated as having no market
match (shown as such), never force-fitted to a wrong slug.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from .wm_client import NET_ERRORS, fetch_items, slugify

_CACHE_TTL = 7 * 86400          # refetch the catalogue at most weekly
_CACHE_FILE = "wm_items.json"


class SlugResolver:
    def __init__(self, items: list[dict], corrector=None, fuzzy: float = 0.9) -> None:
        self._by_name: dict[str, str] = {}   # lower display name -> url_name
        self._slugs: set[str] = set()        # every known url_name
        self._names: list[str] = []          # display names, for fuzzy search
        for it in items:
            url = it.get("url_name")
            nm = it.get("item_name") or url
            if not url:
                continue
            self._slugs.add(url)
            self._by_name[str(nm).strip().lower()] = url
            self._names.append(str(nm))
        self._corrector = corrector
        self._fuzzy = fuzzy
        self._memo: dict[str, str | None] = {}

    def resolve(self, name: str) -> str | None:
        """Best market slug for ``name``, or None. Memoised per name."""
        if name not in self._memo:
            self._memo[name] = self._resolve(name)
        return self._memo[name]

    def _resolve(self, name: str) -> str | None:
        key = str(name).strip().lower()
        if not key:
            return None
        if key in self._by_name:                       # exact display-name match
            return self._by_name[key]
        s = slugify(name)
        if s in self._slugs:                           # direct slug hit
            return s
        if s + "_set" in self._slugs:                  # market sells the set
            return s + "_set"
        if self._corrector is not None and self._names:
            m = self._corrector.best(name, self._names, cutoff=self._fuzzy)
            if m is not None:
                return self._by_name.get(m[0].strip().lower())
        return None


# module cache so one process builds a resolver per game once (fuzzy index is reused)
_resolvers: dict[str, SlugResolver] = {}


def get_resolver(data_dir, game: str, corrector=None, fuzzy: float = 0.9,
                 ttl: float = _CACHE_TTL, refresh: bool = False) -> SlugResolver | None:
    """Cached resolver for ``game``. ``refresh`` forces a fresh catalogue fetch.
    Returns None only if the catalogue can't be loaded (no cache, network down)."""
    if not refresh and game in _resolvers:
        return _resolvers[game]
    items = _load_catalogue(Path(data_dir) / game / _CACHE_FILE, ttl, refresh)
    if items is None:
        return None
    resolver = SlugResolver(items, corrector, fuzzy)
    _resolvers[game] = resolver
    return resolver


def _load_catalogue(path: Path, ttl: float, refresh: bool) -> list[dict] | None:
    if not refresh and path.exists():
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
            if time.time() - doc.get("ts", 0) < ttl and doc.get("items"):
                return doc["items"]
        except (ValueError, OSError):
            pass
    try:
        items = fetch_items()
    except NET_ERRORS:
        if path.exists():               # serve a stale catalogue rather than nothing
            try:
                return json.loads(path.read_text(encoding="utf-8")).get("items")
            except (ValueError, OSError):
                return None
        return None
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"ts": time.time(), "items": items}), encoding="utf-8")
    return items
