"""Per-node execution-duration store — "is anything getting too slow?".

Timing happens all over (collection ticks, OCR, ledger replays, view recomputes, price
sweeps, precapture). This is the ONE primitive that gathers those durations, ties each to
the graph node it belongs to, keeps a live rollup for the stats panel to poll, and persists
a bounded history per node for the on-click trend chart.

Storage is one CSV per node — ``data/<game>/stats/<safe(node)>.csv``:

    #stats v1 ds:prices
    ts,op,ms,n
    1750000000,rp,12.4,240

The node id lives in the header comment (so the file is self-describing and a rename is a
file move), never in a row. Rows carry only ``ts`` (unix epoch seconds), a 2-char ``op``
code (see :data:`OPS`), ``ms`` (elapsed), and ``n`` (items processed). The aggregate
(count/min/max/avg/last) is NOT stored — it's recomputed in memory from the rows.

Delimiter safety is enforced, not assumed: every field is numeric or a fixed 2-char code,
and read/write go through the stdlib ``csv`` module (never hand-split), so a stray value can
never corrupt the body. The free-form node id is confined to the header line, read raw.

Persistence is cheap: ``record_timing`` updates the in-memory rollup every call but only
buffers the row; a throttled flush appends them, and a file is compacted (last
``MAX_SAMPLES`` rows kept) only once it grows past ``2 * MAX_SAMPLES`` — so a per-second
tick never costs a per-call write.

Thread-safe: publishers run on any thread (collector loop, sweep workers, request handlers).
"""

from __future__ import annotations

import csv
import re
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

STATS_CSV_VERSION = 1
MAX_SAMPLES = 500          # rows kept per node after compaction (also the chart history depth)
# The rollup's avg/min/max are computed over the most-recent WINDOW_N samples, NOT all-time —
# so a card reflects recent behaviour and matches the panel's default chart window. Mirrors
# STAT_LAST_N in web/static/js/graph/panels/stats.js; keep the two in sync.
WINDOW_N = 20
_COMPACT_AT = 2 * MAX_SAMPLES
_FLUSH_EVERY_S = 10.0      # wall-clock between throttled flushes
_FLUSH_ROWS = 64           # ...or flush sooner once this many rows are buffered for a game

# 2-char op code -> human label. Single source of truth; the front end mirrors this for
# display. A code not in here is rejected on write (so it can't smuggle a delimiter in).
OPS = {
    "tk": "tick",        # win: — one whole collection pass
    "oc": "ocr",         # win: — OCR inference only (the dominant cost)
    "ro": "readouts",    # win: — readout OCR (live HUD boxes; only for windows that declare any)
    "cp": "capture",     # win: — window grab (capture backend)
    "st": "settle",      # win: — settle thumbnail + staleness diff
    "cl": "classify",    # win: — window/state classification pass
    "sg": "signature",   # win: — grid-region change hash (OCR-skip gate)
    "cf": "confirm",     # win: — temporal confirmation gate
    "cm": "commit",      # win: — store write + flow/mirror bookkeeping
    "rp": "replay",      # ds:  — ledger replay
    "rc": "recompute",   # sub: — view recompute
    "sw": "sweep",       # price: — one price sweep
    "fr": "frame",       # precap — precapture per-frame OCR pipeline
}

_HEADER = f"#stats v{STATS_CSV_VERSION}"
_COLUMNS = ("ts", "op", "ms", "n")


def _safe(name: str) -> str:
    """Map a node id to a filename-legal stem (``:`` is illegal on Windows)."""
    return re.sub(r"[^A-Za-z0-9._-]", "_", name)


@dataclass
class _Agg:
    """Live rollup for one (node, op). Never serialized — rebuilt from the CSV rows."""
    count: int = 0
    last_ms: float = 0.0
    min_ms: float = float("inf")
    max_ms: float = 0.0
    sum_ms: float = 0.0
    last_ts: float = 0.0
    samples: deque = field(default_factory=lambda: deque(maxlen=MAX_SAMPLES))  # (ts, ms, n)

    def add(self, ts: float, ms: float, n: int) -> None:
        self.count += 1
        self.last_ms = ms
        self.last_ts = ts
        self.sum_ms += ms
        if ms < self.min_ms:
            self.min_ms = ms
        if ms > self.max_ms:
            self.max_ms = ms
        self.samples.append((ts, ms, n))

    def as_row(self, node: str, op: str) -> dict:
        # avg/min/max are windowed to the most-recent WINDOW_N samples (the same set the
        # panel's default chart plots) so the card tracks recent perf rather than a lifetime
        # average diluted by every run ever. ``count`` stays the lifetime total.
        win = list(self.samples)[-WINDOW_N:]
        ms = [s[1] for s in win]
        w_avg = sum(ms) / len(ms) if ms else 0.0
        return {
            "node": node, "op": op, "label": OPS.get(op, op),
            "count": self.count,
            "window": len(ms),
            "last_ms": round(self.last_ms, 2),
            "avg_ms": round(w_avg, 2),
            "min_ms": round(min(ms), 2) if ms else 0.0,
            "max_ms": round(max(ms), 2) if ms else 0.0,
            "last_ts": int(self.last_ts),
        }


_lock = threading.RLock()
_data_dir: Path | None = None
# {game: {node: {op: _Agg}}}
_cache: dict[str, dict[str, dict[str, _Agg]]] = {}
# {game: {node: [ (ts, op, ms, n), ... ]}} pending disk append
_buffer: dict[str, dict[str, list[tuple]]] = {}
_loaded: set[str] = set()
_last_flush: dict[str, float] = {}


def configure(data_dir) -> None:
    """Point the store at the data directory (called once at engine/app startup). Until
    set, timing is collected in memory only and never persisted."""
    global _data_dir
    with _lock:
        _data_dir = Path(data_dir) if data_dir is not None else None


def _stats_dir(game: str) -> Path | None:
    return (_data_dir / game / "stats") if _data_dir is not None else None


def _path(game: str, node: str) -> Path | None:
    d = _stats_dir(game)
    return (d / f"{_safe(node)}.csv") if d is not None else None


# ---- read / load -----------------------------------------------------------------------

def _parse_file(path: Path) -> tuple[str, dict[str, _Agg]]:
    """Return ``(node, {op: _Agg})`` rebuilt from one CSV. Malformed rows are skipped, never
    fatal. The node id comes from the header comment, not the (lossy) filename."""
    node = ""
    ops: dict[str, _Agg] = {}
    try:
        with path.open("r", encoding="utf-8", newline="") as fh:
            first = fh.readline()
            if first.startswith("#"):
                # "#stats v1 <node-id>" — node id is the remainder (may contain colons/spaces)
                parts = first.rstrip("\r\n").split(" ", 2)
                node = parts[2] if len(parts) > 2 else ""
            else:
                fh.seek(0)   # legacy / headerless: treat whole file as rows
            reader = csv.reader(fh)
            for row in reader:
                if not row or row == list(_COLUMNS):   # skip the column header line
                    continue
                if len(row) != len(_COLUMNS):
                    continue
                try:
                    ts, op, ms, n = float(row[0]), row[1], float(row[2]), int(float(row[3]))
                except (TypeError, ValueError):
                    continue
                if op not in OPS:
                    continue
                ops.setdefault(op, _Agg()).add(ts, ms, n)
    except OSError:
        pass
    return node, ops


def _ensure_loaded(game: str) -> None:
    if game in _loaded:
        return
    _loaded.add(game)
    d = _stats_dir(game)
    if d is None or not d.exists():
        return
    nodes = _cache.setdefault(game, {})
    for path in d.glob("*.csv"):
        node, ops = _parse_file(path)
        if node and ops:
            nodes[node] = ops


# ---- write -----------------------------------------------------------------------------

def record_timing(game: str, node: str, op: str, ms: float, n: int = 0) -> None:
    """Record one timing sample for ``node`` (e.g. ``"ds:prices"``). ``op`` MUST be a known
    2-char code (:data:`OPS`); an unknown op is dropped. Cheap: updates the in-memory rollup
    and buffers the row — the disk append is throttled."""
    if op not in OPS or not game or not node:
        return
    try:
        ms = float(ms)
    except (TypeError, ValueError):
        return
    ts = time.time()
    with _lock:
        _ensure_loaded(game)
        _cache.setdefault(game, {}).setdefault(node, {}).setdefault(op, _Agg()).add(ts, ms, int(n))
        _buffer.setdefault(game, {}).setdefault(node, []).append((int(ts), op, round(ms, 2), int(n)))
        pending = sum(len(rows) for rows in _buffer[game].values())
        due = time.monotonic() - _last_flush.get(game, 0.0) >= _FLUSH_EVERY_S
    if pending >= _FLUSH_ROWS or due:
        _flush(game)


class time_block:
    """Context manager: time a block and record it as one sample.

    ``with time_block(game, "ds:prices", "rp", n_fn=lambda: rows): ...`` — ``n_fn`` (optional)
    is read on exit so ``n`` can reflect a count computed inside the block."""

    def __init__(self, game: str, node: str, op: str, n: int = 0, n_fn=None):
        self.game, self.node, self.op, self.n, self.n_fn = game, node, op, n, n_fn
        self._t0 = 0.0

    def __enter__(self):
        self._t0 = time.perf_counter()
        return self

    def __exit__(self, *exc):
        ms = (time.perf_counter() - self._t0) * 1000.0
        n = self.n
        if self.n_fn is not None:
            try:
                n = int(self.n_fn())
            except Exception:  # noqa: BLE001 - a bad count must not swallow the real exception
                n = self.n
        record_timing(self.game, self.node, self.op, ms, n)
        return False   # never suppress an exception from the timed block


# ---- flush / compaction ----------------------------------------------------------------

def _write_new(path: Path, node: str, rows: list[tuple]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as fh:
        fh.write(f"{_HEADER} {node}\n")
        w = csv.writer(fh)
        w.writerow(_COLUMNS)
        w.writerows(rows)


def _append(path: Path, node: str, rows: list[tuple]) -> None:
    if not path.exists():
        _write_new(path, node, rows)
        return
    with path.open("a", encoding="utf-8", newline="") as fh:
        csv.writer(fh).writerows(rows)


def _compact(game: str, node: str, path: Path) -> None:
    """Rewrite the file keeping only the last ``MAX_SAMPLES`` rows (across all ops), from the
    in-memory rings — bounds file size without rewriting on every append."""
    ops = _cache.get(game, {}).get(node, {})
    merged: list[tuple] = []
    for op, agg in ops.items():
        for ts, ms, n in agg.samples:
            merged.append((int(ts), op, round(ms, 2), int(n)))
    merged.sort(key=lambda r: r[0])
    merged = merged[-MAX_SAMPLES:]
    _write_new(path, node, merged)


def _flush(game: str) -> None:
    with _lock:
        _last_flush[game] = time.monotonic()
        pending = _buffer.get(game)
        if not pending or _data_dir is None:
            if pending:
                pending.clear()
            return
        items = [(node, rows) for node, rows in pending.items() if rows]
        pending.clear()
    for node, rows in items:
        path = _path(game, node)
        if path is None:
            continue
        try:
            _append(path, node, rows)
            # compact if the file outgrew the cap (cheap stat-free heuristic: line count)
            try:
                with path.open("r", encoding="utf-8") as fh:
                    lines = sum(1 for _ in fh)
            except OSError:
                lines = 0
            if lines > _COMPACT_AT + 2:   # +2 for the version + column header lines
                with _lock:
                    _compact(game, node, path)
        except OSError:
            pass


def flush_all() -> None:
    """Flush every game's buffer (call on shutdown)."""
    with _lock:
        games = list(_buffer.keys())
    for game in games:
        _flush(game)


# ---- query (for the stats panel) -------------------------------------------------------

def aggregate(game: str) -> list[dict]:
    """One rollup row per (node, op) for ``game`` — what the panel polls. Instant (memory)."""
    with _lock:
        _ensure_loaded(game)
        out = []
        for node, ops in _cache.get(game, {}).items():
            for op, agg in ops.items():
                out.append(agg.as_row(node, op))
    return out


def history(game: str, node: str, op: str = "") -> list[list]:
    """Recent samples ``[[ts, ms, n], ...]`` for one node (optionally one op), in time order
    — the lazy on-click trend. Bounded by ``MAX_SAMPLES`` per op."""
    with _lock:
        _ensure_loaded(game)
        ops = _cache.get(game, {}).get(node, {})
        rows: list[list] = []
        for o, agg in ops.items():
            if op and o != op:
                continue
            for ts, ms, n in agg.samples:
                rows.append([int(ts), round(ms, 2), int(n)])
        rows.sort(key=lambda r: r[0])
    return rows


# ---- node lifecycle (rename / remove follow the graph) ---------------------------------

def rename_node(game: str, old: str, new: str) -> None:
    """Carry a node's history across a rename: move its CSV (rewriting the header node) and
    remap the in-memory rollup. Mirrors the single rename seam in the front-end model."""
    if old == new:
        return
    _flush(game)
    with _lock:
        _ensure_loaded(game)
        nodes = _cache.get(game, {})
        if old in nodes:
            nodes[new] = nodes.pop(old)
        old_path, new_path = _path(game, old), _path(game, new)
    if old_path is None or new_path is None or not old_path.exists():
        return
    try:
        _, _ = _parse_file(old_path)   # validate readable; rewrite with the new header node
        new_path.parent.mkdir(parents=True, exist_ok=True)
        # rewrite from the in-memory ring so the header carries the new id and rows are capped
        with _lock:
            _compact(game, new, new_path)
        if old_path.exists() and old_path != new_path:
            old_path.unlink()
    except OSError:
        pass


def remove_node(game: str, node: str) -> None:
    """Drop a node's stats when the node is deleted."""
    with _lock:
        _buffer.get(game, {}).pop(node, None)
        _cache.get(game, {}).pop(node, None)
        path = _path(game, node)
    if path is not None:
        try:
            path.unlink()
        except OSError:
            pass


# Node-id shapes that record_timing emits (see the callers): the prefixed graph nodes plus the
# few bare stat nodes. prune_stale only ever touches a file whose node id is one of these, so an
# unexpected file in the stats dir is left alone rather than deleted on a wrong guess.
_STAT_PREFIXES = ("win:", "ds:", "sub:", "producer:", "price:")   # price: = legacy sweep node, superseded by producer:
_BARE_STAT_NODES = {"precap", "game", "gate"}   # precap = live; game/gate = the removed worthiness gate


def _prunable(node: str) -> bool:
    return node.startswith(_STAT_PREFIXES) or node in _BARE_STAT_NODES


def prune_stale(game: str, live_nodes: set[str]) -> list[str]:
    """Once-per-boot sweep: delete stat CSVs whose node id is no longer a live graph node, so a
    renamed/deleted node (or an out-of-band write) can't leave an orphan card in the panel.
    ``live_nodes`` is the current node-id set (see ``GameProfile.stat_node_ids``). Conservative by
    design: does NOTHING when ``live_nodes`` is empty (a failed profile load must not wipe every
    file), and only removes a file whose node id is a recognised stat kind (:func:`_prunable`) —
    an unknown shape is untouched. Returns the purged node ids (log them; never silent)."""
    if not live_nodes:
        return []
    d = _stats_dir(game)
    if d is None or not d.exists():
        return []
    _flush(game)
    purged: list[str] = []
    for path in list(d.glob("*.csv")):
        node, _ = _parse_file(path)   # node id from the self-describing header, not the lossy name
        if not node or node in live_nodes or not _prunable(node):
            continue
        remove_node(game, node)
        purged.append(node)
    return purged


def _reset_for_tests() -> None:
    """Clear all in-memory state (tests only)."""
    with _lock:
        _cache.clear()
        _buffer.clear()
        _loaded.clear()
        _last_flush.clear()
