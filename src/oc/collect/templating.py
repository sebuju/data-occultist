"""Server-side ``{{token}}`` substitution for notification text.

The Python analogue of the pretty UI's ``renderDynamicText`` (``static/js/pretty/binding.js``):
same ``{{ token }}`` grammar, slice/aggregate syntax, and number tidying — but it runs where a
toast actually fires (server-side, in the trigger runner / web routes), so it can't call the
browser one. The two MUST stay in lockstep; when the pretty grammar grows, port it here.

Token grammar (a subset of pretty's — the sources a toast can wire to):

* ``{{readout:id}}``            a live readout value (``{readout_id: value}``, ephemeral)
* ``{{id}}``                    bare == ``readout:id`` (back-compat with older toast text)
* ``{{dataset:id}}``           row count of a dataset
* ``{{dataset:id.field|agg}}`` one field aggregated (count|sum|mean|min|max|first|latest)
* ``{{dataset:id[a:b]|join:", "}}``  python-style row slice, joined into a string
* ``{{subset:id...}}``          same forms over a computed view

A :class:`TokenContext` resolves against the live readouts plus (given ``data_dir``/``profile``)
lazily-read dataset and subset rows — so ``dataset:``/``subset:`` tokens print real values when a
toast pops, mirroring the pretty page.
"""

from __future__ import annotations

import re

from ..numfmt import split_dp
from ..profile import wiring

# The {{token}} heads, read from the wiring table so this grammar and the rename sweep that
# rewrites it (profile/pretty_repoint.py) can never name a kind differently.
_HEAD_READOUT = wiring.BY_NAME["readout"].token_head
_HEAD_DATASET = wiring.BY_NAME["dataset"].token_head
_HEAD_SUBSET = wiring.BY_NAME["subset"].token_head

_TOKEN = re.compile(r"\{\{(.+?)\}\}")
_SLICE = re.compile(r"\[([^\]]*)\]\s*$")
# ` ?? ` splits a token into `left ?? default` — the default renders (literal) when the left
# resolves to nothing (None/""); see render(). Whitespace-padded so it can't collide with a `??`
# inside a |join delimiter. Mirror of binding.js splitDefault; the two MUST stay in lockstep.
_DEFAULT = re.compile(r"\s\?\?\s")


def split_default(inner: str) -> tuple[str, str | None]:
    """Pull a trailing `` ?? default`` off a token body. Returns ``(left, default)`` where
    ``default`` is the literal fallback text (trimmed), or ``(inner, None)`` when there is no
    `` ?? ``. Splits on the FIRST `` ?? `` so ``{{ a ?? b ?? c }}`` -> default ``"b ?? c"``."""
    m = _DEFAULT.search(inner)
    if not m:
        return inner, None
    return inner[:m.start()].strip(), inner[m.end():].strip()


def _fmt(v) -> str:
    """Match the pretty renderer: ints bare, floats to 2dp, everything else str()."""
    if isinstance(v, bool):
        return str(v)
    if isinstance(v, (int, float)):
        f = float(v)
        return str(int(f)) if f.is_integer() else f"{f:.2f}"
    return str(v)


# ---- slice / aggregate (ports of binding.js parseSlice/applySlice/aggregate/joinRows) --------

def _to_int(s):
    s = str(s).strip()
    if s == "":
        return None
    try:
        return int(s)
    except ValueError:
        return None


def _parse_slice(spec: str):
    """``"n"`` -> single index; ``"a:b"`` / ``"a:b:c"`` -> range (any part may be blank)."""
    spec = spec.strip()
    if ":" not in spec:
        i = _to_int(spec)
        return None if i is None else {"index": i}
    p = spec.split(":")
    return {"start": _to_int(p[0]), "stop": _to_int(p[1]),
            "step": _to_int(p[2]) if len(p) > 2 else None}


def _split_slice(body: str):
    """Pull a trailing ``[...]`` slice off a token body. Returns ``(rest, slice|None)``."""
    m = _SLICE.search(body)
    if not m:
        return body, None
    return body[:m.start()], _parse_slice(m.group(1))


def _apply_slice(rows: list, sl) -> list:
    """Apply a parsed slice to ``rows`` with python semantics (negative indices, step, blanks)."""
    if not sl:
        return rows
    n = len(rows)
    if sl.get("index") is not None:
        i = sl["index"]
        i = n + i if i < 0 else i
        return [rows[i]] if 0 <= i < n else []
    step = sl.get("step")
    step = 1 if step in (None, 0) else step
    start, stop = sl.get("start"), sl.get("stop")
    # python slicing already honours negatives/blanks/step — mirror it directly.
    return rows[slice(start, stop, step)]


def _aggregate(rows: list, field: str, agg: str):
    vals = [r.get(field) for r in rows]
    vals = [v for v in vals if v is not None and v != ""]
    nums = []
    for v in vals:
        try:
            nums.append(float(v))
        except (TypeError, ValueError):
            pass
    # empty result -> None (not "") so render()'s keep_missing keeps the literal {{token}} in the
    # PREVIEW when a source has no data yet; a real fire (keep_missing=False) still renders empty.
    if agg == "count":
        return len(rows)
    if agg == "sum":
        return sum(nums)
    if agg == "mean":
        return sum(nums) / len(nums) if nums else None
    if agg == "min":
        return min(nums) if nums else None
    if agg == "max":
        return max(nums) if nums else None
    if agg == "first":
        return vals[0] if vals else None
    # "latest" and any unknown -> last observed value
    return vals[-1] if vals else None


def _join_rows(rows: list, field: str | None, delim: str) -> str:
    def val_of(r):
        if field:
            return r.get(field)
        k = next((x for x in r.keys() if not str(x).startswith("_")), None)
        return r.get(k) if k else ""
    out = [val_of(r) for r in rows]
    return delim.join(_fmt(v) for v in out if v is not None and v != "")


# ---- resolution context -----------------------------------------------------------------------

class TokenContext:
    """Resolves a toast's ``{{token}}`` against live readouts + (lazily) dataset/subset rows.

    ``readouts`` is the ephemeral ``{readout_id: value}`` map. Dataset/subset resolution needs
    ``data_dir`` + ``profile`` (to open stores / compute views); without them those tokens empty,
    same as an unavailable source in the pretty renderer. Reads are memoised so a toast that names
    the same dataset in title AND message opens it once."""

    def __init__(self, readouts: dict | None = None, *, data_dir=None, profile=None, game=None):
        self.readouts = readouts or {}
        self._data_dir = data_dir
        self._profile = profile
        self._game = game or getattr(profile, "name", None)
        self._ds_cache: dict[str, list] = {}
        self._sub_cache: dict[str, list] = {}

    def dataset_rows(self, ds_id: str) -> list:
        if self._data_dir is None or self._profile is None or not self._game:
            return []
        if ds_id not in self._ds_cache:
            self._ds_cache[ds_id] = self._read_dataset(ds_id)
        return self._ds_cache[ds_id]

    def subset_rows(self, sid: str) -> list:
        if self._data_dir is None or self._profile is None or not self._game:
            return []
        if sid not in self._sub_cache:
            self._sub_cache[sid] = self._read_subset(sid)
        return self._sub_cache[sid]

    def _read_dataset(self, ds_id: str) -> list:
        try:
            from ..store import rows_at, store_for
            store = store_for(self._data_dir, self._game, ds_id,
                              profile=self._profile,
                              aggregate=self._profile.aggregate_for(ds_id))
            return rows_at(store, self._profile.aggregate_for(ds_id), present_only=True)
        except Exception:   # noqa: BLE001 - a bad read must never crash a fire; token empties
            return []

    def _read_subset(self, sid: str) -> list:
        try:
            from ..enrich.subset import compute_view_rows
            from ..store import rows_at, store_for

            def fetch(ds, agg):
                return rows_at(store_for(self._data_dir, self._game, ds, profile=self._profile,
                                         aggregate="latest" if agg == "all" else agg),
                               agg, present_only=True)

            return compute_view_rows(self._profile, sid, fetch)["rows"]
        except Exception:   # noqa: BLE001
            return []


def resolve_token(ctx: TokenContext, inner: str):
    """Resolve one ``{{token}}`` inner string to a scalar (port of binding.js resolveToken)."""
    parts = str(inner or "").split("|")
    src = parts[0].strip()
    agg = "|".join(parts[1:]).strip() or "latest"
    head, _, rest_raw = src.partition(":")
    # which heads exist is the wiring table's call (Kind.token_head) — the same rows the graph
    # renames and the checker validates, so a head can't be minted here that nothing else knows.
    if head == _HEAD_READOUT:
        return ctx.readouts.get(rest_raw.strip())
    if head in (_HEAD_DATASET, _HEAD_SUBSET):
        is_sub = head == _HEAD_SUBSET
        rest, sl = _split_slice(rest_raw)
        seg = rest.split(".", 1)
        rid = seg[0].strip()
        field = seg[1].strip() if len(seg) > 1 else ""
        rows = ctx.subset_rows(rid) if is_sub else ctx.dataset_rows(rid)
        if sl:
            rows = _apply_slice(rows, sl)
        if agg == "join" or agg.startswith("join:"):
            c = agg.find(":")
            delim = agg[c + 1:].strip().strip("\"'") if c >= 0 else ", "
            return _join_rows(rows, field or None, delim)
        if not field:
            return len(rows)
        return _aggregate(rows, field, agg)
    # bare token (no known prefix) == a readout id — back-compat with older {{ro_id}} toast text
    if ":" not in src:
        return ctx.readouts.get(src)
    return None


def render(text: str, ctx: TokenContext, *, keep_missing: bool = False) -> str:
    """Replace every ``{{token}}`` in ``text`` using ``ctx``. No ``{{`` -> passes straight through.
    A ``|round:N`` (or ``|.Nf``) suffix formats the value to N decimals; otherwise numbers tidy to
    int-bare / 2dp as the pretty renderer does. ``keep_missing`` leaves a token whose value is
    unresolvable (``None``) as its literal ``{{...}}`` — used by the image PREVIEW so an unfed
    token still shows where it will land instead of vanishing."""
    if not text or "{{" not in text:
        return text or ""

    def sub(m: re.Match) -> str:
        base, default = split_default(m.group(1).strip())
        core, dp = split_dp(base)
        v = resolve_token(ctx, core)
        if v is None or v == "":
            if default is not None:   # authored `?? fallback` wins, even in preview (keep_missing)
                return default
            return m.group(0) if keep_missing else ""
        if dp is not None:
            try:
                return f"{float(v):.{dp}f}"
            except (TypeError, ValueError):
                return _fmt(v)
        return _fmt(v)

    return _TOKEN.sub(sub, text)


def token_blanks(text: str, ctx: TokenContext) -> list[bool]:
    """Per-``{{token}}`` blankness in ``text`` — one bool per token found, in order. A token is
    blank when it resolves to ``None``/``""`` AND has no authored ``?? fallback`` (a fallback always
    renders something, so it never counts as blank). Mirrors ``render()``'s per-token resolution
    but reports blankness instead of building the substituted string — used by a toast block's
    ``skip_mode`` (any/all) so the decision is about the TOKENS themselves, not whether the fully
    rendered string happens to be blank (which literal surrounding text would mask)."""
    out = []
    for m in _TOKEN.finditer(text or ""):
        base, default = split_default(m.group(1).strip())
        core, _dp = split_dp(base)
        v = resolve_token(ctx, core)
        out.append((v is None or v == "") and default is None)
    return out


def render_template(text: str, values: dict | None) -> str:
    """Back-compat readouts-only render: ``values`` is a flat ``{readout_id: value}`` map.
    Kept so callers that only have live readouts (no dataset access) still work; dataset/subset
    tokens empty. New callers should build a :class:`TokenContext` and use :func:`render`."""
    return render(text, TokenContext(values))
