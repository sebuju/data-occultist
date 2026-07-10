"""Generic HTTP producer — fetch JSON from a taught URL and map JSON paths to dataset
columns. Two shapes, chosen by the spec:

* **per item** (default) — fetch the URL once per source item (``{name}``/``{key}``
  substituted) and map the response to ONE row (warframe.market pricing works this way).
* **list / explode** (``HttpSpec.explode`` set) — fetch the URL ONCE (no sources) and
  expand nested arrays into MANY rows, one per leaf (the WFCD relic table works this
  way: ``explode: [relics, rewards]`` -> one row per (relic, reward)).

This is the one network backend: warframe.market pricing AND the relic reward table are
just ``http`` nodes in a profile (URL, headers, and response mapping authored in the
teach UI), not Python classes. The producer knows nothing about any specific API — it
reads the :class:`~oc.profile.models.HttpSpec` off the node.

The *mapping engine* (:func:`map_response` / :func:`map_rows`) is pure — select an array,
filter it, pluck a field, aggregate, or fill a ``{path}`` template — kept separate so
it's unit-testable with no network.
"""

from __future__ import annotations

import json
import re
import statistics
import time
import urllib.parse
from pathlib import Path

from ..interfaces import ProducerCtx, ProducerSource
from ..registry import register_producer
from ..store import KeySpec, store_for
from .http_get import http_get_json, json_path, key_transform, slugify
from .sweep_engine import run_sweep

# ---------------------------------------------------------------------------
# Mapping engine (pure — no network, no I/O)
# ---------------------------------------------------------------------------


def _num(v: object) -> float | None:
    """Coerce ``v`` to a float, or None if it isn't numeric."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v.strip())
        except ValueError:
            return None
    return None


def _op(actual: object, op: str, value: object) -> bool:
    """Evaluate one predicate. Unknown ops and type-mismatched compares are False."""
    if op == "eq":
        return actual == value
    if op == "ne":
        return actual != value
    if op == "in":
        return isinstance(value, (list, tuple, set)) and actual in value
    if op == "nin":
        return isinstance(value, (list, tuple, set)) and actual not in value
    if op in ("contains", "ncontains"):
        try:
            hit = value in actual  # type: ignore[operator]
        except TypeError:
            # Nothing to search (missing field / non-container): it cannot CONTAIN the value, and
            # it vacuously does NOT contain it. `ncontains` must stay a true negation, else a row
            # simply lacking the field is dropped by the very filter meant to keep it.
            return op == "ncontains"
        return hit if op == "contains" else not hit
    a, b = _num(actual), _num(value)
    if a is None or b is None:
        return False
    return {"gt": a > b, "ge": a >= b, "lt": a < b, "le": a <= b}.get(op, False)


def _passes(elem: object, filters) -> bool:
    """True when ``elem`` clears every filter (ANDed)."""
    return all(_op(json_path(elem, f.path), f.op, f.value) for f in filters)


def _agg(values: list, kept: list, spec) -> object:
    """Fold plucked ``values`` (from ``kept`` elements) to one value per ``spec.agg``."""
    if spec.agg == "count":
        return len(kept)
    if spec.agg == "first":
        return values[0] if values else None
    nums = [n for n in (_num(v) for v in values) if n is not None]
    if not nums:
        return None
    if spec.agg == "sum":
        return sum(nums)
    if spec.agg == "max":
        return max(nums)
    if spec.agg == "median":
        return statistics.median(sorted(nums))
    if spec.agg == "median_low":
        return statistics.median(sorted(nums)[: max(1, spec.depth)])
    return min(nums)                                   # default: "min"


def _eval_array(arr: list, spec) -> object:
    kept = [e for e in arr if _passes(e, spec.filter)]
    values = [json_path(e, spec.pluck) for e in kept] if spec.pluck else list(kept)
    return _agg(values, kept, spec)


_TMPL_RE = re.compile(r"\{([^{}]+)\}")


def _fill_template(obj: object, tmpl: str) -> str:
    """Substitute ``{path}`` placeholders in ``tmpl`` with values pulled from ``obj`` by
    :func:`json_path` (a missing path -> ""), e.g. ``"{tier} {relicName}"`` -> ``"Axi A1"``.
    Lets one output column be composed from several JSON fields (the generic equivalent of a
    view's derived column, but at fetch time)."""
    def one(m: "re.Match") -> str:
        v = json_path(obj, m.group(1).strip())
        return "" if v is None else str(v)
    return _TMPL_RE.sub(one, tmpl)


def _eval_field(obj: object, field) -> object:
    if getattr(field, "template", ""):
        val: object = _fill_template(obj, field.template)
    else:
        base = json_path(obj, field.path)
        if field.array is not None:
            val = _eval_array(base, field.array) if isinstance(base, list) else None
        else:
            val = base
    if field.type == "number":
        val = _num(val)
    return val


def map_response(obj: object, fields: list) -> dict | None:
    """Map a (rooted) JSON response to a row of ``{out_field: value}``.

    Returns None when a ``required`` field yields nothing — the whole row is dropped
    (never guessed). Fields that yield None are simply omitted from the row."""
    row: dict = {}
    for f in fields:
        val = _eval_field(obj, f)
        if f.required and (val is None or val == ""):
            return None
        if val is not None:
            row[f.out_field] = val
    return row


def _explode(rooted: object, paths: list[str]):
    """Walk nested arrays and yield one merged dict per leaf. ``paths`` are dotted array
    paths, each relative to the previous level's element; every ancestor object's fields are
    merged in so a leaf's :func:`map_response` can reference any level (e.g. a relic's ``tier``
    alongside a reward's ``itemName``). ``[""]`` means the rooted value is itself the list."""
    def walk(obj: object, ps: list[str], acc: dict):
        if not ps:
            merged = dict(acc)
            if isinstance(obj, dict):
                merged.update(obj)
            yield merged
            return
        nacc = dict(acc)
        if isinstance(obj, dict):
            nacc.update(obj)
        arr = json_path(obj, ps[0])
        if isinstance(arr, list):
            for e in arr:
                yield from walk(e, ps[1:], nacc)
    yield from walk(rooted, list(paths), {})


def map_rows(rooted: object, spec) -> list[dict]:
    """Map a rooted response to the producer's output rows. With ``spec.explode`` set, one row
    per leaf of the nested-array walk (list mode); otherwise the single per-item row (or none).

    ``spec.row_filter`` (ANDed :class:`HttpFilter` predicates, same primitive the per-field array
    reduction uses) drops a SOURCE element before it is mapped — so junk in the feed never becomes
    a record. Tested against the raw element, so it can key off a field the producer never emits
    as a column (e.g. drop the tier variants of a mod by their ``uniqueName``)."""
    keep = getattr(spec, "row_filter", None) or []
    if spec.explode:
        elems = (m for m in _explode(rooted, spec.explode) if _passes(m, keep))
        return [r for r in (map_response(m, spec.fields) for m in elems) if r is not None]
    if not _passes(rooted, keep):
        return []
    row = map_response(rooted, spec.fields)
    return [row] if row is not None else []


# ---------------------------------------------------------------------------
# Catalogue resolver (generic re-expression of a slug catalogue)
# ---------------------------------------------------------------------------


class _Catalogue:
    """name -> key resolver built from a fetched item list: exact display-name -> a
    slugify hit -> fuzzy match via the configured corrector."""

    def __init__(self, entries: list[dict], corrector=None, fuzzy: float = 0.9,
                 suffix_hints: list[str] | None = None) -> None:
        self._by_name: dict[str, str] = {}
        self._keys: set[str] = set()
        self._names: list[str] = []
        for e in entries:
            key, name = e.get("key"), e.get("name")
            if not key:
                continue
            self._keys.add(key)
            if name:
                self._by_name[str(name).strip().lower()] = key
                self._names.append(str(name))
        self._corrector = corrector
        self._fuzzy = fuzzy
        self._hints = suffix_hints or []
        self._memo: dict[str, str | None] = {}

    def resolve(self, name: str) -> str | None:
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
        if s in self._keys:                            # direct key hit
            return s
        for hint in self._hints:                       # taught framings, e.g. a "…_set" key
            if s + hint in self._keys:
                return s + hint
        if self._corrector is not None and self._names:
            m = self._corrector.best(name, self._names, cutoff=self._fuzzy)
            if m is not None:
                return self._by_name.get(m[0].strip().lower())
        return None


def _load_catalogue(spec, cache: Path) -> list[dict]:
    """Fetched-and-flattened ``[{name, key}]`` for the catalogue, cached on disk with a
    TTL. Serves a stale cache rather than nothing on a network outage."""
    ttl = max(0.0, spec.ttl_days) * 86400
    if cache.exists():
        try:
            doc = json.loads(cache.read_text(encoding="utf-8"))
            if time.time() - doc.get("ts", 0) < ttl and doc.get("entries"):
                return doc["entries"]
        except (ValueError, OSError):
            pass
    try:
        raw = http_get_json(spec.url, headers={"Accept": "application/json"})
    except Exception:  # noqa: BLE001 - any fetch failure -> stale cache or empty
        if cache.exists():
            try:
                return json.loads(cache.read_text(encoding="utf-8")).get("entries") or []
            except (ValueError, OSError):
                return []
        return []
    arr = json_path(raw, spec.items_path)
    entries = [{"name": json_path(e, spec.name_path), "key": json_path(e, spec.key_path)}
               for e in (arr or []) if isinstance(e, dict)]
    try:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps({"ts": time.time(), "entries": entries}), encoding="utf-8")
    except OSError:
        pass
    return entries


def _build_corrector():
    """The configured fuzzy corrector (rapidfuzz), or None if it can't be built —
    the catalogue still works exact-only without it."""
    try:
        from ..registry import build_corrector
        from ..settings import Settings
        s = Settings.load()
        return build_corrector(s.corrector.name, **s.corrector.options)
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------------------
# Source name gathering
# ---------------------------------------------------------------------------


def gather_source_names(data_dir, game: str, profile, sources: list[str],
                        name_field: str = "name") -> list[str]:
    """Unique item names across a node's ``sources`` (datasets/views), first-seen order.
    A bare dataset -> its PRESENT rows; a view -> its computed rows (filters apply)."""
    from .subset import compute_view_rows

    def fetch(ds, _agg):     # a plain dataset's PRESENT records only (sold/removed items excluded)
        return [r for r in store_for(data_dir, game, ds, profile=profile).records()
                if r.get("present", True)]
    seen: dict[str, None] = {}
    for s in sources:
        sub = profile.subset_def(s) if profile else None
        rows = compute_view_rows(profile, s, fetch)["rows"] if sub else fetch(s, None)
        for r in rows:
            nm = r.get(name_field)
            if nm and str(nm) not in seen:
                seen[str(nm)] = None
    return list(seen.keys())


# ---------------------------------------------------------------------------
# Shared request/resolve helpers (used by the producer AND the preview/probe)
# ---------------------------------------------------------------------------


def build_resolver(spec, data_dir, game: str, node_id: str):
    """A ``name -> key`` callable per the spec's ``key_transform``. ``catalogue`` builds a
    fetched (disk-cached) name->key resolver; the others are pure string transforms."""
    if spec.key_transform == "catalogue" and spec.catalogue is not None:
        cache = Path(data_dir) / game / f"{node_id}_catalogue.json"
        cat = _Catalogue(_load_catalogue(spec.catalogue, cache), _build_corrector(),
                         spec.catalogue.fuzzy, spec.catalogue.suffix_hints)
        return cat.resolve

    def resolve(n):
        return key_transform(n, spec.key_transform)
    return resolve


def request_parts(spec, key: str, name: str):
    """Substitute ``{key}``/``{name}`` into the taught URL, headers, and query. ``{key}`` is
    percent-encoded in the URL when ``key_encode``; ``{name}`` is URL-encoded in the path."""
    req = spec.request

    def sub(text: str, url: bool) -> str:
        kk = urllib.parse.quote(key, safe="") if (url and spec.key_encode) else key
        nn = urllib.parse.quote(name, safe="") if url else name
        return text.replace("{key}", kk).replace("{name}", nn)

    url = sub(req.url, True)
    headers = {k: sub(v, False) for k, v in (req.headers or {}).items()}
    query = {k: sub(v, False) for k, v in (req.query or {}).items()}
    return url, headers, (query or None)


def resolved_inputs(data_dir, game: str, profile, node, limit: int = 50) -> dict:
    """Preview: the item names this node's sources feed and how each resolves to a ``{key}``
    (so the user sees what it will request before running). Capped at ``limit``; ``total`` is
    the true count. ``columns`` is the schema this node emits (``name`` + each ``out_field``)."""
    spec = getattr(node, "http", None)
    outs = [f.out_field for f in (spec.fields if spec else []) if f.out_field]
    cols = outs if "name" in outs else ["name", *outs]   # list mode maps its own ``name`` column
    if spec is None:
        return {"inputs": [], "total": 0, "columns": cols}
    if spec.explode:            # list mode: no per-item sources — the one fetch yields every row
        return {"inputs": [], "total": 0, "columns": cols}
    names = gather_source_names(data_dir, game, profile, list(getattr(node, "sources", []) or []),
                                name_field=getattr(node, "source_field", "name"))
    total = len(names)
    shown = names[:limit] if (limit and limit > 0) else names
    resolve = build_resolver(spec, data_dir, game, getattr(node, "id", "producer"))
    return {"inputs": [{"name": n, "key": resolve(n)} for n in shown],
            "total": total, "columns": cols}


def probe_item(data_dir, game: str, profile, node, item: str | None = None,
               sample_cap: int = 20) -> dict:
    """Live test-fetch ONE item: resolve its key, hit the taught URL, and return the (trimmed)
    rooted response next to the mapped row — so the user can debug paths/filters against the
    real API. Never raises: any failure comes back as an ``error`` string."""
    spec = getattr(node, "http", None)
    if spec is None or not getattr(spec, "request", None) or not spec.request.url:
        return {"error": "this node has no http request configured yet"}
    if spec.explode:            # list mode: fetch the one URL, show the sample + expanded rows
        url, headers, query = request_parts(spec, "", "")
        try:
            raw = http_get_json(url, headers=headers, timeout=spec.request.timeout,
                                method=spec.request.method or "GET", query=query)
        except Exception as e:  # noqa: BLE001 - report any fetch/parse failure to the user
            return {"name": "(list)", "key": None, "url": url, "error": str(e)}
        rooted = json_path(raw, spec.root)
        sample = rooted[:sample_cap] if isinstance(rooted, list) else rooted
        return {"name": "(list)", "key": None, "url": url, "sample": sample,
                "mapped": map_rows(rooted, spec)[:sample_cap]}
    if not item:
        names = gather_source_names(data_dir, game, profile, list(getattr(node, "sources", []) or []),
                                    name_field=getattr(node, "source_field", "name"))
        item = names[0] if names else None
    if not item:
        return {"error": "no item to probe — wire a source (or pass one)"}
    resolve = build_resolver(spec, data_dir, game, getattr(node, "id", "producer"))
    key = resolve(str(item))
    if not key:
        return {"name": item, "key": None, "error": "name did not resolve to a key"}
    url, headers, query = request_parts(spec, key, str(item))
    try:
        raw = http_get_json(url, headers=headers, timeout=spec.request.timeout,
                            method=spec.request.method or "GET", query=query)
    except Exception as e:  # noqa: BLE001 - report any fetch/parse failure to the user
        return {"name": item, "key": key, "url": url, "error": str(e)}
    rooted = json_path(raw, spec.root)
    sample = rooted[:sample_cap] if isinstance(rooted, list) else rooted
    return {"name": item, "key": key, "url": url, "sample": sample,
            "mapped": map_response(rooted, spec.fields)}


# ---------------------------------------------------------------------------
# The producer
# ---------------------------------------------------------------------------


@register_producer("http")
class HttpProducer(ProducerSource):
    """Fetch a taught URL per source item and map the JSON response to dataset columns.
    Heavy + cancellable, so it runs only on an explicit refresh (button or trigger)."""

    def run(self, ctx: ProducerCtx) -> dict:
        node = ctx.node
        spec = getattr(node, "http", None)
        if spec is None or not getattr(spec, "request", None) or not spec.request.url:
            return {"total": 0, "fetched": 0, "failed": 0}
        if spec.explode:                                   # list mode: one fetch, many rows
            return self._run_list(ctx, spec)

        # Item names: explicit ctx.items (e.g. on_change changed keys) > the node's sources.
        names = [str(n) for n in ctx.items] if ctx.items else gather_source_names(
            ctx.data_dir, ctx.game, ctx.profile, list(getattr(node, "sources", []) or []),
            name_field=getattr(node, "source_field", "name"))

        # Resolve each name to its fetch key, deduped by key (one fetch covers duplicates).
        resolve = build_resolver(spec, ctx.data_dir, ctx.game, getattr(node, "id", "producer"))
        key_to_name: dict[str, str] = {}
        for name in names:
            k = resolve(name)
            if k and k not in key_to_name:
                key_to_name[k] = name
        items = list(key_to_name.items())
        if ctx.limit and ctx.limit > 0:
            items = items[: ctx.limit]

        def fetch_one(k: str) -> object:
            url, headers, query = request_parts(spec, k, key_to_name[k])
            return http_get_json(url, headers=headers, timeout=spec.request.timeout,
                                 method=spec.request.method or "GET", query=query)

        store = store_for(ctx.data_dir, ctx.game, ctx.dataset, profile=ctx.profile,
                          key=ctx.key or KeySpec(fields=("name",)))
        store.begin_batch()

        def write_one(k: str, name: str, data: object) -> None:
            rooted = json_path(data, spec.root)
            row = map_response(rooted, spec.fields)
            if row is None:
                return
            store.record_seen({"name": name, **row})

        return run_sweep(items, fetch_one, write_one, dataset_store=store,
                         throttle=float(getattr(node, "throttle", 0.4) or 0.0),
                         workers=ctx.workers, on_item=ctx.on_item,
                         should_stop=ctx.should_stop, game=ctx.game, log_dataset=ctx.dataset)

    def _run_list(self, ctx: ProducerCtx, spec) -> dict:
        """List mode: fetch the taught URL ONCE and expand nested arrays into rows (no sources).
        A single call, so there is nothing to sweep/throttle — write the whole batch in one txn."""
        stop = ctx.should_stop or (lambda: False)
        url, headers, query = request_parts(spec, "", "")
        try:
            data = http_get_json(url, headers=headers, timeout=spec.request.timeout,
                                 method=spec.request.method or "GET", query=query)
        except Exception as e:  # noqa: BLE001 - a fetch/parse failure leaves the prior rows intact
            return {"total": 0, "fetched": 0, "failed": 1, "error": str(e)}
        if stop():                                         # cancelled before we wrote anything
            return {"total": 0, "fetched": 0, "failed": 0}
        rows = map_rows(json_path(data, spec.root), spec)
        store = store_for(ctx.data_dir, ctx.game, ctx.dataset, profile=ctx.profile,
                          key=ctx.key or KeySpec(fields=("name",)))
        store.begin_batch()
        store.record_many(rows)                            # one txn, one announce (not per row)
        store.save()
        n = len(rows)
        if ctx.on_item:
            ctx.on_item(n, n, "", ctx.dataset, True)       # register final progress on the sweep
        return {"total": n, "fetched": n, "failed": 0, "done": n}
