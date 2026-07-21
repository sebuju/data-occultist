"""Per-dataset store backed by a revertable event ledger in SQLite.

One **SQLite database per game** lives at ``data/<game>/store.sqlite``; every dataset is
rows in the shared ``events`` table keyed by a ``dataset`` column (so views can join
datasets within a game on one connection). The ledger is authoritative: the current state
is the result of REPLAYING every non-reverted event in order. Events are grouped into
**batches** (one collection/save run), revertable wholesale.

Schema::

    datasets(dataset PK, key_meta, next_id, batch)
    events(dataset, id, batch, ts, op, key, values_json, changed_json, reverted,
           PRIMARY KEY (dataset, id))

``key`` is the dedup key computed via the CURRENT :class:`KeySpec`/:class:`KeyMap` at write
time and kept in sync by an open-time re-key pass when the spec changes (raw ``values`` are
the source of truth, so a key change re-keys the dataset). A record with any key part
missing is unkeyable and dropped, never guessed.

How rows are keyed (which fields, joined how) is taught on the window/item that reads them;
the resolved key spec is passed in here. The old JSONL ledger + JSON snapshot/summary caches
are gone — SQLite gives ACID + WAL concurrency, so a reader can never see a stale snapshot
that lags the ledger (the bug class the previous design fought).
"""

from __future__ import annotations

import json
import sqlite3
import time
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from . import changes, stats_store
from .change import ChangeEvent, ChangeOp
from .keys import KeyMap, KeySpec


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# how a key's MANY observations collapse to one displayed value (per-dataset choice).
# "all" is the opt-OUT: don't collapse — emit every observation as its own row.
AGGREGATES = ("latest", "first", "sum", "mean", "max", "min", "all")

# row plumbing, not data columns — hidden from a dataset's column preview / stripped before
# a record's values are re-recorded (e.g. as a reconcile remove).
_PLUMBING = ("key", "present", "first_seen", "last_seen", "removed_at", "_count", "_seq", "_batch", "_pos")

_DB_NAME = "store.sqlite"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS datasets (
  dataset  TEXT PRIMARY KEY,
  key_meta TEXT,
  next_id  INTEGER NOT NULL DEFAULT 1,
  batch    INTEGER NOT NULL DEFAULT 0,
  rev      INTEGER NOT NULL DEFAULT 0,   -- bumps on every mutation
  cur_rev  INTEGER NOT NULL DEFAULT -1,  -- the rev the `current` materialisation was built at
  cur_agg  TEXT                          -- the aggregate policy `current` was built under
);
CREATE TABLE IF NOT EXISTS events (
  dataset      TEXT NOT NULL,
  id           INTEGER NOT NULL,
  batch        INTEGER NOT NULL,
  ts           TEXT NOT NULL,
  op           TEXT NOT NULL,
  key          TEXT,
  values_json  TEXT NOT NULL,
  changed_json TEXT,
  reverted     INTEGER NOT NULL DEFAULT 0,
  -- How many raw observations this event stands for. 1 for every ordinary event; a BASE event
  -- minted by compaction (see _fold_batches) carries the count it folded, so counts and means
  -- weight by it instead of counting rows. A real column, not a JSON field, so `SUM(weight)`
  -- aggregates in plain SQL with no JSON1 dependency.
  weight       INTEGER NOT NULL DEFAULT 1,
  -- NULL on an ordinary event. On a base event: {"first_ts":…, "last_ts":…} — the span the fold
  -- covered, which the single `ts` column can't carry (a fold would otherwise shrink a key's
  -- visible lifetime to a point).
  fold_json    TEXT,
  PRIMARY KEY (dataset, id)
);
CREATE INDEX IF NOT EXISTS ix_events_ds_key   ON events(dataset, key, id);
CREATE INDEX IF NOT EXISTS ix_events_ds_batch ON events(dataset, batch);
-- Covering partial index for the `current` boundary rebuild (_compute_boundary): the
-- per-key COUNT / MIN(id) / MAX(id) over live rows scan this index-only instead of the
-- whole dataset partition (reverted/removed rows are excluded from the index entirely).
CREATE INDEX IF NOT EXISTS ix_events_live ON events(dataset, key, id) WHERE reverted=0 AND op!='remove';
CREATE TABLE IF NOT EXISTS current (
  dataset    TEXT NOT NULL,
  key        TEXT NOT NULL,
  present     INTEGER,
  first_seen  TEXT,
  last_seen   TEXT,
  values_json TEXT,
  cnt         INTEGER,
  seq         INTEGER,
  maxbatch    INTEGER,
  PRIMARY KEY (dataset, key)
);
CREATE TABLE IF NOT EXISTS positions (
  dataset TEXT NOT NULL,
  key     TEXT NOT NULL,
  pos     REAL NOT NULL,
  xpos    REAL,
  PRIMARY KEY (dataset, key)
);
"""



def _num(v):
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return None


def _fmt_pos(slot: tuple[float | None, float] | None) -> str | None:
    """The ``_pos`` display for a learned grid slot ``(xpos, vpos)``: the row INDEX then the
    column INDEX — both whole numbers (discrete list position, column 0..cols-1). Shown when
    the column is known (legacy rows have no column). ``None`` when not mirrored."""
    if slot is None:
        return None
    x, v = slot
    return f"({int(round(v))}, {int(round(x))})" if x is not None else f"({int(round(v))},)"


def _fold_of(row) -> dict | None:
    """The compaction view of one ``events`` row — ``{"n", "first_ts", "last_ts"}`` — assembled
    from its ``weight`` column and ``fold_json`` span, or ``None`` for an ordinary event. Keeps
    the split storage (a real ``weight`` column so SQL can ``SUM`` it, JSON for the span) behind
    one shape, so :func:`replay` and callers never handle the two halves separately."""
    weight = row["weight"] if "weight" in row.keys() else 1
    span = row["fold_json"] if "fold_json" in row.keys() else None
    if (weight or 1) <= 1 and not span:
        return None
    return {"n": weight or 1, **(json.loads(span) if span else {})}


def obs_weight(record: dict) -> int:
    """How many raw observations one record stands for. 1 for an ordinary observation; a
    compaction BASE record carries ``n`` (see ``events.fold_json``) because it replaced that
    many. Every count/mean must go through this rather than counting records, else a folded
    dataset under-reports ``_count`` and skews ``mean`` toward its most recent batches."""
    return max(1, int(record.get("n") or 1))


def aggregate_records(records: list[dict], policy: str = "latest") -> dict:
    """Collapse a key's observation list (each ``{"values":{...}, "ts":...}``, oldest→
    newest) to one row of values per the dataset's ``policy``.

    ``latest``/``first`` take that observation's values wholesale. ``sum``/``mean``/
    ``max``/``min`` apply per field over the NUMERIC observations; a field with no numeric
    values (e.g. ``name``) falls back to its latest value, so key fields are preserved.

    A record may carry ``n`` — a compaction base standing for ``n`` folded observations (see
    :func:`obs_weight`). A base's stored value is ALREADY this same fold applied to those
    observations, so for the associative policies (``sum``/``max``/``min``) it composes directly
    and the weight must NOT be applied again — multiplying a folded subtotal by ``n`` would
    double-count it. Only ``mean`` is non-associative: it weights each value by ``n`` and divides
    by the total weight, which keeps ``mean`` over a compacted ledger identical to ``mean`` over
    the raw one.
    """
    if not records:
        return {}
    latest = records[-1].get("values", {})
    if policy == "first":
        return dict(records[0].get("values", {}))
    if policy not in ("sum", "mean", "max", "min"):
        return dict(latest)                       # "latest" / unknown
    fields: list[str] = []
    for r in records:
        for k in r.get("values", {}):
            if k not in fields:
                fields.append(k)
    out: dict = {}
    for k in fields:
        # (value, weight) per observation that HAS a numeric value for this field. The weight
        # only matters to `mean`; a base's value is already a fold under this same policy, so
        # sum/max/min compose it as-is (see the docstring).
        pairs = [(n, obs_weight(r)) for r, n in
                 ((r, _num(r.get("values", {}).get(k))) for r in records) if n is not None]
        if not pairs:
            out[k] = latest.get(k)
            continue
        if policy == "max":
            v = max(n for n, _ in pairs)
        elif policy == "min":
            v = min(n for n, _ in pairs)
        elif policy == "sum":
            v = sum(n for n, _ in pairs)     # a folded base already holds its subtotal
        else:   # mean — weighted, so a folded base counts for the n observations it replaced
            v = sum(n * w for n, w in pairs) / sum(w for _, w in pairs)
        out[k] = int(v) if float(v).is_integer() else round(v, 2)
    return out


def rows_at(store, aggregate: str, *, present_only: bool = True) -> list[dict]:
    """Rows a VIEW sees from one dataset store under its chosen aggregate. ``"all"`` returns
    every observation (no collapse — :meth:`DatasetStore.all_records`); any other policy returns
    the keyed/collapsed :meth:`DatasetStore.records`. The ONE place the "all" opt-out is honoured,
    so the web view, trigger change-gate, and any future reader stay in lockstep.

    ``present_only`` (DEFAULT, and the only safe value for a view/producer) drops
    reconciled-removed rows — a ``present=0`` row is a sold/deleted item still on the ledger,
    NOT live data, so it must never surface in a subset join or re-price. This defaults ON so
    that FORGETTING it is safe: a caller that genuinely wants removed rows (e.g. a history/audit
    view) must opt out with ``present_only=False`` on purpose. Do not reintroduce a default-off
    footgun — a removed relic leaking into a join is exactly the bug this guards."""
    rows = store.all_records() if aggregate == "all" else store.records()
    return [r for r in rows if r.get("present", True)] if present_only else rows


def replay(events: list[ChangeEvent], reverted: set[int],
           key: KeyMap | KeySpec = KeySpec(), aggregate: str = "latest") -> dict[str, dict]:
    """Rebuild the keyed state from the ledger, skipping reverted events.

    A key holds MANY observations: each non-reverted add/update appends the record it
    carried (so the whole history of a key is kept, not just its last value), and the
    dataset's ``aggregate`` policy collapses that list into the displayed ``values``. The
    key is recomputed from each event's raw ``values`` with the CURRENT key spec, so a key
    change re-keys the dataset on the next replay; a remove flips ``present`` off. Events
    unkeyable under the current spec (a key part missing/empty) are skipped.

    A compaction base event (``ev.fold``) replays as ONE observation carrying the weight ``n``
    of the observations it replaced, and widens ``first_seen``/``last_seen`` to the span it
    folded — a base has a single ``ts``, so without this a fold would visibly shrink a key's
    lifetime to a point.
    """
    no_dedup = getattr(key, "dedup", True) is False
    state: dict[str, dict] = {}
    for ev in events:
        if ev.id in reverted:
            continue
        if no_dedup:
            # 1->many OFF: every non-remove observation is its own record, keyed per event.
            if ev.op is ChangeOp.remove:
                continue
            state[f"#{ev.id}"] = {"records": [{"values": dict(ev.values), "ts": ev.ts, "batch": ev.batch}],
                                  "first_seen": ev.ts, "last_seen": ev.ts, "present": True, "_seq": ev.id}
            continue
        k = key.build(ev.values)
        if k is None:
            continue
        entry = state.get(k)
        if ev.op is ChangeOp.remove:
            if entry is not None:
                entry["present"] = False
                entry["removed_at"] = ev.ts
            continue
        obs = {"values": dict(ev.values), "ts": ev.ts, "batch": ev.batch}
        first_ts, last_ts = ev.ts, ev.ts
        if ev.fold:
            obs["n"] = obs_weight(ev.fold)
            first_ts = ev.fold.get("first_ts") or ev.ts
            last_ts = ev.fold.get("last_ts") or ev.ts
        if entry is None:
            # _seq = the add event's id: a monotonic rolling id capturing arrival order,
            # stable across replays (same ledger -> same ids). Sort by it for "order they came".
            state[k] = {"records": [obs], "first_seen": first_ts, "last_seen": last_ts,
                        "present": True, "_seq": ev.id}
        else:
            entry["records"].append(obs)
            entry["last_seen"] = last_ts
            entry["present"] = True
            entry.pop("removed_at", None)
    for entry in state.values():
        entry["values"] = aggregate_records(entry["records"], aggregate)
    return state


# ---- connection ------------------------------------------------------------

def _migrate_ds_key_index(conn: sqlite3.Connection) -> None:
    """One-time repair for a DB created before ``ix_events_ds_key`` widened to
    ``(dataset, key, id)``. The old 2-column ``(dataset, key)`` shape sent the
    "last event for this key" lookup in :meth:`DatasetStore._plan_observation` down the
    ``(dataset, id)`` primary-key index instead (SQLite's planner preferred it to avoid a
    sort) — for a key not yet in the ledger (the common case: writing fresh rows) that's a
    full scan of the dataset's whole event partition per row, turning ``record_many`` O(n^2).
    ``CREATE INDEX IF NOT EXISTS`` never widens an existing index under the same name, so a
    pre-existing 2-column index must be dropped and rebuilt once; a fresh or already-migrated
    DB sees 3 columns and this is a single cheap no-op ``PRAGMA``."""
    cols = conn.execute("PRAGMA index_info(ix_events_ds_key)").fetchall()
    if 0 < len(cols) < 3:
        conn.execute("DROP INDEX ix_events_ds_key")
        conn.execute("CREATE INDEX IF NOT EXISTS ix_events_ds_key ON events(dataset, key, id)")


def _migrate_events_fold_cols(conn: sqlite3.Connection) -> None:
    """Add the ``events.weight`` / ``events.fold_json`` columns to a DB created before compaction
    existed. ``CREATE TABLE IF NOT EXISTS`` never adds a column to an existing table, so an older
    store keeps the 9-column shape and every read of these raises. A fresh or already-migrated DB
    sees them and this is one cheap ``PRAGMA``. The defaults are exactly right for pre-existing
    rows: they are ordinary, unfolded events of weight 1 with no folded span."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(events)")}
    if not cols:
        return
    if "weight" not in cols:
        conn.execute("ALTER TABLE events ADD COLUMN weight INTEGER NOT NULL DEFAULT 1")
    if "fold_json" not in cols:
        conn.execute("ALTER TABLE events ADD COLUMN fold_json TEXT")


def _connect(db_path: Path) -> sqlite3.Connection:
    """Open (creating) the per-game DB in WAL mode. ``isolation_level=None`` = autocommit;
    multi-statement writes wrap themselves in explicit ``BEGIN IMMEDIATE``/``COMMIT``."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), check_same_thread=False, isolation_level=None)
    conn.row_factory = sqlite3.Row
    # busy_timeout FIRST so later statements WAIT on a lock instead of failing instantly. Then set
    # WAL + schema, retrying the whole setup on a transient "database is locked": switching journal
    # mode / first-time WAL file creation needs a brief exclusive lock that busy_timeout doesn't
    # cover, so a connection opened WHILE another writes (a background source read, a sweep) can
    # otherwise die on contention. A few short backoffs ride it out.
    conn.execute("PRAGMA busy_timeout=5000")
    for delay in (0.05, 0.1, 0.2, 0.4, 0.0):   # last attempt re-raises
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.executescript(_SCHEMA)
            _migrate_ds_key_index(conn)
            _migrate_events_fold_cols(conn)
            return conn
        except sqlite3.OperationalError as e:
            if not delay or "locked" not in str(e).lower():
                raise
            time.sleep(delay)
    return conn   # unreachable (loop returns or raises)


def _db_path(data_dir: Path | str, game: str) -> Path:
    return Path(data_dir) / game / _DB_NAME


# ---- module-level dataset ops ----------------------------------------------

def rename_dataset(data_dir: Path | str, game: str, old: str, new: str) -> bool:
    """Repoint a dataset's stored rows from ``old`` to ``new``. Returns True if anything
    moved. Refuses (``FileExistsError``) if ``new`` already has data — merging two ledgers
    would collide event ids."""
    db = _db_path(data_dir, game)
    if not db.exists():
        return False
    conn = _connect(db)
    if (conn.execute("SELECT 1 FROM datasets WHERE dataset=?", (new,)).fetchone()
            or conn.execute("SELECT 1 FROM events WHERE dataset=? LIMIT 1", (new,)).fetchone()):
        raise FileExistsError(f"dataset {new!r} already has data")
    conn.execute("BEGIN IMMEDIATE")
    try:
        n1 = conn.execute("UPDATE events SET dataset=? WHERE dataset=?", (new, old)).rowcount
        n2 = conn.execute("UPDATE datasets SET dataset=? WHERE dataset=?", (new, old)).rowcount
        conn.execute("UPDATE current SET dataset=? WHERE dataset=?", (new, old))
        conn.execute("UPDATE positions SET dataset=? WHERE dataset=?", (new, old))
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return bool(n1 or n2)


def delete_dataset(data_dir: Path | str, game: str, dataset: str) -> bool:
    """Permanently delete a dataset's stored rows. Returns True if anything was deleted.
    Unlike ``clear_data`` (which empties but keeps the dataset), this removes it entirely."""
    db = _db_path(data_dir, game)
    removed = False
    if db.exists():
        conn = _connect(db)
        conn.execute("BEGIN IMMEDIATE")
        try:
            n1 = conn.execute("DELETE FROM events WHERE dataset=?", (dataset,)).rowcount
            n2 = conn.execute("DELETE FROM datasets WHERE dataset=?", (dataset,)).rowcount
            conn.execute("DELETE FROM current WHERE dataset=?", (dataset,))
            conn.execute("DELETE FROM positions WHERE dataset=?", (dataset,))
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        removed = bool(n1 or n2)
    return removed


def clear_table(data_dir: Path | str, game: str, table: str) -> int:
    """Empty ONE physical SQLite table (rows only, schema kept). ``table`` is validated
    against the live table list — never interpolated raw — so this can't run arbitrary SQL.
    Returns the row count deleted (0 when the DB or table is absent).

    Low-level surgery: the tables are inter-related (``current`` materialises ``events``),
    so clearing one alone can leave the others showing stale counts until the next write
    rebuilds them. Prefer :func:`drop_database` (whole, coherent reset) or a dataset's
    ``clear_data`` / :func:`delete_dataset`; this exists for when you really mean one table."""
    db = _db_path(data_dir, game)
    if not db.exists():
        return 0
    conn = _connect(db)
    try:
        valid = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
        if table not in valid:
            raise KeyError(f"no table {table!r}")
        return conn.execute(f"DELETE FROM {table}").rowcount   # autocommit; name is allow-listed
    finally:
        conn.close()


def _vacuum(conn: sqlite3.Connection) -> bool:
    """Rewrite the DB file, handing freed pages back to the OS. True when it ran.

    SQLite never shrinks a file on its own: deleted pages go on a freelist and are reused by
    later writes, so a store that has been cleared/re-collected/compacted keeps its high-water
    size forever (measured here: 84% of a 194 MB file was freelist). VACUUM is the only way back.

    Non-destructive — it rebuilds the same content — but it needs an exclusive lock and cannot run
    inside a transaction, so it returns False rather than raising when another connection is
    mid-write. The caller retries later; nothing is lost either way.

    The checkpoint is NOT optional. Under WAL — which this store always runs in — ``VACUUM`` writes
    the rebuilt database into the ``-wal`` file and leaves the main file at its old size, so vacuum
    alone reclaims exactly nothing on disk (measured: 460 kB before and after; only the checkpoint
    took it to 48 kB). ``TRUNCATE`` folds the WAL back and shrinks the file, and it works even with
    other connections open, which is the normal state of a running server."""
    try:
        conn.execute("VACUUM")
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        return True
    except sqlite3.OperationalError:
        return False


def vacuum_database(data_dir: Path | str, game: str) -> dict:
    """Compact the game store, returning ``{ok, before, after, freed}`` in bytes.

    ``ok`` False means the file was busy (a collection sweep mid-write) — the store is untouched
    and a retry is safe."""
    db = _db_path(data_dir, game)
    if not db.exists():
        return {"ok": False, "before": 0, "after": 0, "freed": 0}
    before = db.stat().st_size
    conn = _connect(db)
    try:
        ok = _vacuum(conn)
    finally:
        conn.close()
    after = db.stat().st_size
    return {"ok": ok, "before": before, "after": after, "freed": max(0, before - after)}


def drop_database(data_dir: Path | str, game: str) -> list[str]:
    """Drop the whole game store and leave a fresh, empty one in its place — every dataset
    gone, but the (re-created) schema present so the store is fresh, not absent. Returns the
    dataset names that existed, so the caller can announce each as changed (panels + the
    graph's dataset nodes refresh; a node resurrects its dataset on the next write).

    Empties by row-delete + ``VACUUM`` rather than unlinking the file, so a concurrent
    reader/writer (WAL) is never fighting a vanished file handle — same mechanism the rest
    of the store uses."""
    db = _db_path(data_dir, game)
    if not db.exists():
        return []
    conn = _connect(db)
    try:
        names = [r[0] for r in conn.execute("SELECT dataset FROM datasets ORDER BY dataset")]
        conn.execute("BEGIN IMMEDIATE")
        try:
            for t in ("events", "current", "datasets", "positions"):
                conn.execute(f"DELETE FROM {t}")
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        _vacuum(conn)   # reclaim the file size so "fresh" shows as a small DB
        return names
    finally:
        conn.close()


class DatasetStore:
    def __init__(
        self,
        data_dir: Path | str,
        game: str,
        dataset: str,
        key: KeyMap | KeySpec = KeySpec(),
        clock: Callable[[], str] = _utcnow_iso,
        aggregate: str = "latest",
        keep_batches: int = 0,
    ) -> None:
        base = Path(data_dir) / game
        self._game = game
        self._dataset = dataset
        self._key = key
        self._agg = aggregate or "latest"
        self._keep = max(0, int(keep_batches or 0))   # 0 = unlimited; see _fold_batches
        self._clock = clock
        self._no_dedup = getattr(key, "dedup", True) is False
        self._base = base
        self._conn = _connect(_db_path(data_dir, game))
        self._next_id = 1
        self._batch = 0
        self._load()

    # ---- load ---------------------------------------------------------------

    def _load(self) -> None:
        row = self._conn.execute(
            "SELECT next_id, batch, key_meta FROM datasets WHERE dataset=?",
            (self._dataset,)).fetchone()
        if row is not None:
            self._next_id = row["next_id"]
            self._batch = row["batch"]
            self._maybe_rekey(row["key_meta"])
        # No row => an unwritten dataset: leave next_id=1/batch=0 and create NOTHING, so
        # merely reading a nonexistent dataset can't resurface it (phantom prevention).

    def _key_meta_json(self) -> str:
        return json.dumps(self._key.meta(), sort_keys=True)

    def _maybe_rekey(self, stored_meta: str | None) -> None:
        """When the dataset was last keyed under a different spec, recompute every event's
        ``key`` column from its raw values with the CURRENT spec (the ledger re-keys itself)
        and bump ``rev`` so the cached ``current`` materialisation rebuilds on the next read.

        For ``no_dedup`` the per-event keys (``#id``) don't depend on the spec, so the key
        column is left alone — but a spec change (e.g. toggling 1->many OFF, or editing the
        key while it's off) must STILL persist the new meta and bump ``rev``; otherwise the
        stale deduped ``current`` survives the toggle and the view never re-materialises."""
        if stored_meta == self._key_meta_json():
            return
        self._conn.execute("BEGIN IMMEDIATE")
        try:
            if not self._no_dedup:
                rows = self._conn.execute(
                    "SELECT id, values_json FROM events WHERE dataset=?", (self._dataset,)).fetchall()
                for r in rows:
                    k = self._key.build(json.loads(r["values_json"]))
                    self._conn.execute("UPDATE events SET key=? WHERE dataset=? AND id=?",
                                       (k, self._dataset, r["id"]))
            self._conn.execute("UPDATE datasets SET key_meta=?, rev=rev+1 WHERE dataset=?",
                               (self._key_meta_json(), self._dataset))
            self._conn.execute("COMMIT")
        except Exception:
            self._conn.execute("ROLLBACK")
            raise

    # ---- write helpers -----------------------------------------------------

    def _ensure_dataset_row(self) -> None:
        self._conn.execute(
            "INSERT OR IGNORE INTO datasets(dataset,key_meta,next_id,batch) VALUES(?,?,?,?)",
            (self._dataset, self._key_meta_json(), self._next_id, self._batch))

    def _insert_core(self, op: ChangeOp, key: str, values: dict, changed: dict | None = None) -> ChangeEvent:
        """The event INSERT + ``rev`` bump WITHOUT its own transaction — the caller MUST already
        hold an open ``BEGIN IMMEDIATE``. This lets :meth:`_commit_observation` fold the insert,
        the ``current`` maintenance, and the ``cur_rev`` stamp into ONE commit so a concurrent
        reader never observes ``rev > cur_rev`` (which would force a full O(events) rebuild).
        Does NOT advance ``self._next_id`` — the caller does that only after a successful COMMIT
        (so a rollback can't desync the in-memory cursor)."""
        ts = self._clock()
        c = self._conn
        self._ensure_dataset_row()
        eid = self._next_id
        c.execute(
            "INSERT INTO events(dataset,id,batch,ts,op,key,values_json,changed_json,reverted) "
            "VALUES(?,?,?,?,?,?,?,?,0)",
            (self._dataset, eid, self._batch, ts, op.value, key,
             json.dumps(values, default=str),
             json.dumps(changed) if changed else None))
        c.execute("UPDATE datasets SET next_id=?, batch=?, rev=rev+1 WHERE dataset=?",
                  (eid + 1, self._batch, self._dataset))
        return ChangeEvent(ts, op, key, values, changed or {}, id=eid, batch=self._batch)

    def _insert(self, op: ChangeOp, key: str, values: dict, changed: dict | None = None) -> ChangeEvent:
        c = self._conn
        c.execute("BEGIN IMMEDIATE")
        try:
            ev = self._insert_core(op, key, values, changed)
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
        self._next_id = ev.id + 1
        return ev

    def _commit_observation(self, op: ChangeOp, event_key: str, values: dict,
                            changed: dict | None = None, *, per_event_key: bool = False) -> ChangeEvent:
        """Insert one confirmed observation, fold it into the ``current`` materialisation, and
        re-stamp ``cur_rev`` — all in ONE atomic transaction. Because the ``rev`` bump and the
        ``cur_rev`` stamp commit together, a reader on another connection never catches the
        old 3-transaction gap where ``rev > cur_rev`` triggered a full, multi-hundred-ms rebuild
        of the whole dataset mid-write. ``current`` must be valid going in, so we refresh it
        first (cheap when already current; one rebuild at a sweep's first write).

        ``per_event_key`` (the ``no_dedup`` path) keys ``current`` by the event id (``#<id>``,
        known only after the insert) while the stored event key stays ``event_key``."""
        self._ensure_current()
        c = self._conn
        c.execute("BEGIN IMMEDIATE")
        try:
            ev = self._insert_core(op, event_key, values, changed)
            self._current_upsert(f"#{ev.id}" if per_event_key else event_key, ev, values)
            self._stamp_current()   # cur_rev = rev (the rev this insert just advanced to)
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
        self._next_id = ev.id + 1
        return ev

    def begin_batch(self) -> int:
        """Start a new batch; subsequent ``record_seen``/``reconcile`` events belong to it.
        One run (a precapture save, a collection pass) = one revertable batch.

        Also the enforcement point for ``keep_batches``: without folding here the retention
        window would hold only until the next collection pass refilled the dataset. Cheap when
        under the cap (one indexed ``LIMIT 1`` probe) and a no-op when no limit is set.

        Folds to ``keep - 1``, not ``keep``: this runs BEFORE the batch it is starting has written
        any events, so that batch is invisible to the fold's own ``COUNT(DISTINCT batch)``. Budget
        the full ``keep`` here and the imminent write pushes the ledger to ``keep + 1`` — the live
        path would settle one over the limit the user set, even though the on-demand fold lands
        exactly on it. Reserving the slot keeps both paths agreeing on ``keep``."""
        self._batch += 1
        self._conn.execute("UPDATE datasets SET batch=? WHERE dataset=?", (self._batch, self._dataset))
        if self._keep > 0:
            # floor of 1: keep=1 has no room to reserve, so it settles at the base + this batch.
            self.fold_batches(max(1, self._keep - 1))
        return self._batch

    # ---- compaction --------------------------------------------------------

    def _can_fold(self) -> bool:
        """Whether compaction is meaningful for this dataset. With the 1->many collapse off
        (``dedup: false``) or under ``aggregate: "all"``, EVERY observation is its own row —
        there is no per-key 'many' side to collapse, so folding would delete rows outright
        instead of compacting them. Refuse rather than destroy: the UI hides the knob for these
        modes, and this makes the server agree even if something calls in anyway."""
        return not self._no_dedup and self._agg != "all"

    def _fold_cutoff(self, keep: int) -> int | None:
        """The oldest batch to KEEP IN FULL DETAIL, or ``None`` when a fold would achieve nothing.

        ``keep`` is the ledger's TOTAL batch budget, and the base counts against it: the newest
        ``keep - 1`` batches stay in full detail and everything older collapses into the one base
        batch below them, so the ledger settles at exactly ``keep``. (Budgeting only the detailed
        batches would settle at ``keep + 1`` — "keep 30" leaving 31 — because the base is an extra
        batch of its own.)

        Returns ``None`` when the single batch below the cutoff is ALREADY that base: re-folding
        it just rewrites it to itself, so the count can't drop and there is nothing to discard.
        Without that check the base — always the oldest batch, hence always below the cutoff —
        makes the dataset look permanently foldable, so the UI nags forever and every
        ``begin_batch`` burns a pointless transaction and change-bus announce.

        Derived from the batches actually present rather than ``self._batch - keep``, so gaps left
        by ``remove_batch``, a ``batch_mode`` change, or an earlier fold can't shift the window.
        Index-only against ``ix_events_ds_batch`` and bounded by ``keep`` rows, so this doubles as
        the cheap "is this dataset over its limit" probe behind :meth:`would_fold`."""
        if keep <= 0:
            return None
        detail = keep - 1                    # full-detail slots; the base takes the last one
        if detail > 0:
            row = self._conn.execute(
                "SELECT DISTINCT batch FROM events WHERE dataset=? ORDER BY batch DESC LIMIT 1 OFFSET ?",
                (self._dataset, detail - 1)).fetchone()
            if row is None:
                return None                  # fewer than `detail` batches — nothing old enough
            cutoff = row["batch"]
        else:
            # keep=1: no detailed slot at all, everything collapses into a single base.
            top = self._conn.execute(
                "SELECT MAX(batch) m FROM events WHERE dataset=?", (self._dataset,)).fetchone()["m"]
            if top is None:
                return None
            cutoff = top + 1
        below = [r["batch"] for r in self._conn.execute(
            "SELECT DISTINCT batch FROM events WHERE dataset=? AND batch<? ORDER BY batch DESC LIMIT 2",
            (self._dataset, cutoff))]
        if not below:
            return None                      # already inside the window
        if len(below) == 1 and self._is_base_batch(below[0]):
            return None                      # converged: the only thing below is the base itself
        return cutoff

    def _is_base_batch(self, batch: int) -> bool:
        """Whether ``batch`` is already a compaction base (holds at least one folded event)."""
        return self._conn.execute(
            "SELECT 1 FROM events WHERE dataset=? AND batch=? AND fold_json IS NOT NULL LIMIT 1",
            (self._dataset, batch)).fetchone() is not None

    def batch_count(self) -> int:
        """How many distinct batches the ledger holds (folded base events included)."""
        return self._conn.execute(
            "SELECT COUNT(DISTINCT batch) n FROM events WHERE dataset=?", (self._dataset,)).fetchone()["n"]

    def would_fold(self) -> bool:
        """Whether a fold right now would actually destroy something — the ONE predicate behind
        both the on-demand action and the UI's warning. Everything hangs off this being exact:
        the button must appear only when folding really would discard detail, so a limit set
        above the current batch count stays a silent, harmless setting."""
        return self._can_fold() and self._fold_cutoff(self._keep) is not None

    def fold_batches(self, keep: int | None = None) -> int:
        """Collapse every batch older than the newest ``keep`` into a per-key BASE event, and
        return how many batches were folded away (0 = nothing to do).

        This is a rolling window that RETAINS rather than deletes: each key's old observations
        are folded — under the dataset's own ``aggregate`` — into one event carrying the count
        it replaced (``weight``) and the span it covered (``fold_json``), and the surviving
        recent batches replay on top of that backbone exactly as before. So a key seen only long
        ago still exists, and ``sum``/``mean``/``_count`` still answer over its whole history;
        only the per-observation detail of the folded batches is gone.

        The base reuses the key's OLDEST event id, so ``_seq`` (arrival order) stays stable and
        ``next_id`` never moves. Reverted old events are dropped by the fold, which makes those
        reverts permanent — the one genuinely lossy part beyond the per-observation detail.
        """
        keep = self._keep if keep is None else max(0, int(keep or 0))
        if keep <= 0 or not self._can_fold():
            return 0
        cutoff = self._fold_cutoff(keep)
        if cutoff is None:
            return 0
        c = self._conn
        rows = c.execute(
            "SELECT id, ts, batch, op, key, values_json, weight, fold_json FROM events "
            "WHERE dataset=? AND batch<? AND reverted=0 AND key IS NOT NULL ORDER BY id",
            (self._dataset, cutoff)).fetchall()
        folded_batches = {r["batch"] for r in c.execute(
            "SELECT DISTINCT batch FROM events WHERE dataset=? AND batch<?", (self._dataset, cutoff))}
        per_key: dict[str, list] = {}
        for r in rows:
            per_key.setdefault(r["key"], []).append(r)

        c.execute("BEGIN IMMEDIATE")
        try:
            for key, evs in per_key.items():
                keep_id = evs[0]["id"]                    # oldest -> preserves _seq
                obs = [r for r in evs if r["op"] != ChangeOp.remove.value]
                if not obs:
                    # the key only ever got removes down here; collapse them to one remove base
                    # so it stays removed without carrying every removal event forward.
                    c.execute("DELETE FROM events WHERE dataset=? AND batch<? AND key=? AND id!=?",
                              (self._dataset, cutoff, key, keep_id))
                    continue
                recs, weight = [], 0
                for r in obs:
                    fold = _fold_of(r)
                    rec = {"values": json.loads(r["values_json"]), "ts": r["ts"], "batch": r["batch"]}
                    if fold:
                        rec["n"] = obs_weight(fold)
                    recs.append(rec)
                    weight += obs_weight(rec)
                # re-fold INCLUDING any existing base, so compacting again is idempotent
                values = aggregate_records(recs, self._agg)
                first_span, last_span = _fold_of(obs[0]) or {}, _fold_of(obs[-1]) or {}
                span = {"first_ts": first_span.get("first_ts") or obs[0]["ts"],
                        "last_ts": last_span.get("last_ts") or obs[-1]["ts"]}
                # The base DISPLAYS the aggregate, but dedup must still compare an incoming read
                # against the last RAW observation. Under sum/mean/max/min the aggregate is a
                # synthetic value that was never observed, so comparing against it silently ate a
                # genuine later read that happened to equal it (mean(9,7)=8 swallowing a real 8).
                # Carried only when it actually differs — under latest/first they're the same value.
                raw_last = last_span.get("last") or recs[-1]["values"]
                if raw_last != values:
                    span["last"] = raw_last
                c.execute(
                    "UPDATE events SET ts=?, op=?, values_json=?, changed_json=NULL, batch=?, "
                    "weight=?, fold_json=? WHERE dataset=? AND id=?",
                    (span["last_ts"], ChangeOp.add.value, json.dumps(values, default=str), cutoff - 1,
                     weight, json.dumps(span), self._dataset, keep_id))
                # A key soft-removed down here must STAY removed — but the base itself can't be
                # the remove: replay only flips `present` off on an EXISTING entry, so a lone
                # remove base would make the row vanish instead of showing present=0. Keep the
                # trailing remove as its own event after the value base.
                spare = evs[-1]["id"] if evs[-1]["op"] == ChangeOp.remove.value else None
                if spare is not None and spare != keep_id:
                    c.execute("UPDATE events SET batch=? WHERE dataset=? AND id=?",
                              (cutoff - 1, self._dataset, spare))
                c.execute("DELETE FROM events WHERE dataset=? AND batch<? AND key=? AND id NOT IN (?,?)",
                          (self._dataset, cutoff, key, keep_id, spare if spare is not None else keep_id))
            # unkeyable / reverted leftovers below the cutoff have no base to fold into
            c.execute("DELETE FROM events WHERE dataset=? AND batch<? AND (reverted!=0 OR key IS NULL)",
                      (self._dataset, cutoff))
            # keys that no longer exist anywhere in the ledger must not keep a learned slot,
            # else `positions` grows without bound under a forever-folded dataset.
            c.execute("DELETE FROM positions WHERE dataset=? AND key NOT IN "
                      "(SELECT DISTINCT key FROM events WHERE dataset=? AND key IS NOT NULL)",
                      (self._dataset, self._dataset))
            c.execute("UPDATE datasets SET rev=rev+1, cur_rev=-1 WHERE dataset=?", (self._dataset,))
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
        # the base batch (cutoff-1) replaces every batch below the cutoff
        dropped = max(0, len(folded_batches) - 1)
        self._announce([])   # rows may have merged/vanished -> refresh readers; [] fires no on_change
        return dropped

    def _announce(self, records: list, *, data_changed: bool = True) -> None:
        """Tell the change bus this dataset's data changed (UI push + on_change triggers).
        ``records`` are the values just added/updated, for trigger pricing; [] = UI-only.
        ``data_changed=False`` marks a metadata-only ping (learned scroll positions) that
        refreshes the UI but must not fire on_change triggers. The current batch number rides
        along so on_new_batch triggers can fire once per new batch (see ``begin_batch``)."""
        changes.publish(self._game, self._dataset, records, data_changed=data_changed,
                        batch=self._batch)

    def save(self) -> None:
        """No-op: writes are committed transactionally as they happen. Kept for callers that
        used to flush the JSON snapshot cache."""
        return None

    def ensure_loaded(self) -> None:
        """No-op: the DB is always the live source of truth (no snapshot cache to heal)."""
        return None

    def close(self) -> None:
        """Close the DB connection. Optional — a dropped store closes its connection on GC;
        call this to release the file handle deterministically (e.g. before deleting data)."""
        conn = getattr(self, "_conn", None)
        if conn is not None:
            conn.close()
            self._conn = None

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass

    # ---- mutation ----------------------------------------------------------

    def _plan_observation(self, values: dict):
        """Decide what observation ``values`` produces against the CURRENT ledger state, doing
        the dedup/merge/changed reads but WITHOUT writing. Returns
        ``(op, event_key, stored_values, changed, per_event_key, announce_values)`` or ``None``
        when the read is identical to the latest (nothing to track). The single source of the
        "what does this record do" decision, shared by :meth:`record_seen` (one txn each) and
        :meth:`record_many` (one txn for the whole batch) so the two can never drift."""
        if self._no_dedup:
            # 1->many OFF: every read is its own record (keyed per event), never merged.
            v = dict(values)
            return (ChangeOp.add, "", v, None, True, v)
        key = self._key.build(values)
        if key is None:
            return None
        c = self._conn
        last = c.execute(
            "SELECT op FROM events WHERE dataset=? AND key=? AND reverted=0 ORDER BY id DESC LIMIT 1",
            (self._dataset, key)).fetchone()
        present = bool(last) and last["op"] != ChangeOp.remove.value
        obs = c.execute(
            "SELECT values_json, fold_json FROM events WHERE dataset=? AND key=? AND reverted=0 "
            "AND op!='remove' ORDER BY id DESC LIMIT 1", (self._dataset, key)).fetchone()
        if obs is None:
            v = dict(values)
            return (ChangeOp.add, key, v, None, False, v)
        # A compaction base stores the AGGREGATE in values_json; `fold.last` carries the last raw
        # observation it folded. Dedup/merge must use the raw one — under sum/mean the aggregate
        # is a value that was never actually read, so comparing against it drops real observations.
        fold = json.loads(obs["fold_json"]) if obs["fold_json"] else None
        latest = (fold or {}).get("last") or json.loads(obs["values_json"])
        merged = {**latest, **values}
        changed = {f: [latest.get(f), merged.get(f)] for f in merged if latest.get(f) != merged.get(f)}
        was_absent = not present
        if not changed and not was_absent:
            return None                            # identical to latest → nothing to add
        op = ChangeOp.add if was_absent else ChangeOp.update
        return (op, key, dict(merged), changed, False, dict(merged))

    def record_seen(self, values: dict) -> ChangeEvent | None:
        """Register a confirmed record. A NEW key starts an observation list; an existing
        key APPENDS a fresh observation when the merged record differs from its latest
        (so the key accumulates a history). Returns the event, or ``None`` when the read is
        identical to the current latest (nothing to track)."""
        plan = self._plan_observation(values)
        if plan is None:
            return None
        op, event_key, vals, changed, per_event, announce = plan
        # Fold this observation in atomically — the per-record write stays O(1) and, because the
        # rev bump + cur_rev stamp commit together, a concurrent read never catches a rev>cur_rev
        # gap and triggers a full O(events) rebuild.
        ev = self._commit_observation(op, event_key, vals, changed, per_event_key=per_event)
        self._announce([announce])
        return ev

    def record_many(self, rows: list[dict]) -> list[ChangeEvent | None]:
        """Bulk-register confirmed records in ONE transaction with ONE change-bus announce.

        A file source can match tens of thousands of lines; routing each through
        :meth:`record_seen` means a separate fsync COMMIT **and** a separate change-bus publish
        per row. That publish flood is the real killer: each one schedules a callback onto the
        web app's single asyncio loop (the SSE push), so 80k rows starve the loop and every HTTP
        endpoint stops responding — exactly the "no response after reading the log" wedge. This
        folds the whole read into one atomic batch: the SAME per-row dedup/merge decision (via
        :meth:`_plan_observation`, so behaviour can't drift from ``record_seen``), one COMMIT, and
        one announce carrying every changed row. Within the single open transaction each insert is
        visible to the next row's plan, so keys that repeat across the batch dedup correctly.

        Returns a list aligned 1:1 with ``rows`` (``None`` for a row that changed nothing), so a
        caller can map each input to its event (e.g. line-number positions)."""
        rows = list(rows)
        if not rows:
            return []
        self._ensure_current()   # current must be valid going in (cheap when already current)
        c = self._conn
        start_id = self._next_id
        out: list[ChangeEvent | None] = []
        announced: list[dict] = []
        c.execute("BEGIN IMMEDIATE")
        try:
            for values in rows:
                plan = self._plan_observation(values)
                if plan is None:
                    out.append(None)
                    continue
                op, event_key, vals, changed, per_event, announce = plan
                ev = self._insert_core(op, event_key, vals, changed)
                # advance the in-memory cursor NOW (inside the txn) so the next insert gets a
                # fresh id — _insert_core reads self._next_id but only the post-COMMIT path
                # normally advances it.
                self._next_id = ev.id + 1
                self._current_upsert(f"#{ev.id}" if per_event else event_key, ev, vals)
                out.append(ev)
                announced.append(announce)
            self._stamp_current()
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            self._next_id = start_id   # txn rolled back -> restore the cursor
            raise
        if announced:
            self._announce(announced)
        return out

    def present_keys(self) -> set[str]:
        """The keys currently present (``present=1``) — what a live mirror reconciles against."""
        return {r["key"] for r in self._current_records() if r.get("present", True)}

    def remove_keys(self, keys: set[str]) -> list[ChangeEvent]:
        """Soft-remove a given set of keys: flip each absent (``present=0``) and log a
        ``remove`` event, keeping its last observation. A key not present is skipped."""
        if not keys:
            return []
        events: list[ChangeEvent] = []
        for row in self._current_records():   # _ensure_current() inside -> current is valid here
            if not row.get("present", True):
                continue
            key = row["key"]
            if key not in keys:
                continue
            vals = {k: v for k, v in row.items() if k not in _PLUMBING}
            events.append(self._insert(ChangeOp.remove, key, vals))
            # a remove just flips the key absent; its values stay (the last observation)
            self._conn.execute("UPDATE current SET present=0 WHERE dataset=? AND key=?",
                               (self._dataset, key))
            # a gone key's learned scroll position is meaningless -> drop it
            self._conn.execute("DELETE FROM positions WHERE dataset=? AND key=?",
                               (self._dataset, key))
        if events:
            self._stamp_current()
            self._announce([])
        return events

    def remove_after(self, pos_cutoff: float) -> list[ChangeEvent]:
        """Soft-remove every present key whose learned scroll row index is past ``pos_cutoff``.

        A terminator/sentinel item marks the end of the real list — nothing valid can sit after
        it — so a record still parked at a later row index is stale (an old misread that scrolled
        out of view and was never replaced). Keys with no learned position are left untouched.
        Reuses :meth:`remove_keys` (which also drops the removed keys' ``positions`` rows)."""
        rows = self._conn.execute(
            "SELECT key FROM positions WHERE dataset=? AND pos > ?",
            (self._dataset, float(pos_cutoff))).fetchall()
        keys = {r["key"] for r in rows} & self.present_keys()
        return self.remove_keys(keys)

    def reconcile(self, present_keys: set[str]) -> list[ChangeEvent]:
        """Mark stored keys absent from a *complete* pass as removed.

        ``present_keys`` must already be normalised. Only call when confident the pass saw
        the whole dataset, else occlusion logs false removals."""
        return self.remove_keys(self.present_keys() - present_keys)

    # ---- scroll positions (mirror datasets) --------------------------------

    def positions(self) -> dict[str, tuple[float | None, float]]:
        """Each key's last-seen grid slot ``(xpos, vpos)`` — ``xpos`` the column (0..1 of
        data_area width), ``vpos`` the scroll-invariant row index — learned by mirror-sync.
        ``xpos`` is ``None`` for legacy rows written before the column was persisted. Empty
        for a dataset that has never been mirrored. Survives the ``current`` rebuild (own
        table)."""
        return {r["key"]: (r["xpos"], r["pos"]) for r in self._conn.execute(
            "SELECT key, pos, xpos FROM positions WHERE dataset=?", (self._dataset,)).fetchall()}

    def set_positions(self, mapping: dict[str, tuple[float, float]]) -> None:
        """Upsert learned grid slots ``{key: (xpos, vpos)}``. Pure metadata: no ``rev`` bump and
        no ``current`` rebuild — it isn't a record change. It DOES fire a UI-only change-bus
        notification (empty records, like ``set_reverted``), so the records grid's ``_pos`` column
        refreshes live; without it, a position learned with no accompanying record change left the
        grid showing stale/partial ``_pos`` until the table was reopened."""
        if not mapping:
            return
        self._conn.executemany(
            "INSERT OR REPLACE INTO positions(dataset, key, pos, xpos) VALUES(?,?,?,?)",
            [(self._dataset, k, float(v), float(x)) for k, (x, v) in mapping.items()])
        self._announce([], data_changed=False)   # UI-only: refresh the live grid's _pos; not a data change

    # ---- ledger / revert ---------------------------------------------------

    def set_reverted(self, event_id: int, reverted: bool = True) -> None:
        """Revert (or un-revert) a single event."""
        self._conn.execute("UPDATE events SET reverted=? WHERE dataset=? AND id=?",
                           (1 if reverted else 0, self._dataset, int(event_id)))
        self._bump_rev()
        self._announce([])

    def revert_batch(self, batch: int, reverted: bool = True) -> None:
        """Revert (or restore) a whole batch — every record it added/changed falls back to
        its previous accepted value."""
        bi = int(batch)
        self._conn.execute("UPDATE events SET reverted=? WHERE dataset=? AND batch=?",
                           (1 if reverted else 0, self._dataset, bi))
        self._bump_rev()
        if reverted:
            self._announce([])
        else:
            # restoring re-applies this batch's live rows -> announce them so on_change prices
            # them. Owned by the mutation, not the caller, so every restore path is covered.
            rows = self._conn.execute(
                "SELECT values_json FROM events WHERE dataset=? AND batch=? AND reverted=0",
                (self._dataset, bi)).fetchall()
            recs = [v for v in (json.loads(r["values_json"]) for r in rows) if v]
            self._announce(recs)

    def clear_data(self) -> None:
        """Empty the dataset — delete every event, keep the (now empty) dataset registered so
        it still lists. Nothing stays restorable. Clearing an already-empty dataset changes
        nothing, so it does NOT bump ``rev`` or announce (an on_change watch must not fire on a
        no-op clear)."""
        if not self._conn.execute(
                "SELECT 1 FROM events WHERE dataset=? LIMIT 1", (self._dataset,)).fetchone():
            return
        c = self._conn
        c.execute("BEGIN IMMEDIATE")
        try:
            c.execute("DELETE FROM events WHERE dataset=?", (self._dataset,))
            c.execute("DELETE FROM current WHERE dataset=?", (self._dataset,))
            c.execute("DELETE FROM positions WHERE dataset=?", (self._dataset,))
            c.execute("UPDATE datasets SET next_id=1, batch=0, rev=rev+1, cur_rev=-1 WHERE dataset=?",
                      (self._dataset,))
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
        self._next_id = 1
        self._batch = 0
        self._announce([])

    def remove_batch(self, batch: int) -> None:
        """Permanently delete a batch's events from the ledger (not just revert)."""
        bi = int(batch)
        if not self._conn.execute("SELECT 1 FROM events WHERE dataset=? AND batch=? LIMIT 1",
                                  (self._dataset, bi)).fetchone():
            return
        self._conn.execute("DELETE FROM events WHERE dataset=? AND batch=?", (self._dataset, bi))
        self._bump_rev()
        self._announce([])

    def edit_event(self, event_id: int, values: dict) -> bool:
        """Replace one event's recorded values (re-keys it if the key field changed).
        Permanent."""
        eid = int(event_id)
        if not self._conn.execute("SELECT 1 FROM events WHERE dataset=? AND id=?",
                                  (self._dataset, eid)).fetchone():
            return False
        key = "" if self._no_dedup else self._key.build(values)
        self._conn.execute("UPDATE events SET values_json=?, key=? WHERE dataset=? AND id=?",
                           (json.dumps(values, default=str), key, self._dataset, eid))
        self._bump_rev()
        self._announce([dict(values)])   # edited row -> UI refresh + on_change re-price
        return True

    def remove_event(self, event_id: int) -> bool:
        """Permanently delete one event from the ledger."""
        eid = int(event_id)
        n = self._conn.execute("DELETE FROM events WHERE dataset=? AND id=?",
                               (self._dataset, eid)).rowcount
        if not n:
            return False
        self._bump_rev()
        self._announce([])
        return True

    # ---- event loading (for replay-based views) ----------------------------

    def _load_all_events(self) -> tuple[list[ChangeEvent], set[int]]:
        rows = self._conn.execute(
            "SELECT id,batch,ts,op,key,values_json,changed_json,reverted,weight,fold_json "
            "FROM events WHERE dataset=? ORDER BY id", (self._dataset,)).fetchall()
        events: list[ChangeEvent] = []
        reverted: set[int] = set()
        for r in rows:
            events.append(ChangeEvent(
                r["ts"], ChangeOp(r["op"]), r["key"] or "",
                json.loads(r["values_json"]),
                json.loads(r["changed_json"]) if r["changed_json"] else {},
                id=r["id"], batch=r["batch"], fold=_fold_of(r)))
            if r["reverted"]:
                reverted.add(r["id"])
        return events, reverted

    def _state(self) -> dict[str, dict]:
        events, reverted = self._load_all_events()
        return replay(events, reverted, self._key, self._agg)

    # ---- current-state materialisation -------------------------------------

    def _bump_rev(self) -> None:
        """Mark the dataset mutated so the next read rebuilds the ``current`` materialisation.
        Cheap and idempotent; a no-op when the dataset has no row yet."""
        self._conn.execute("UPDATE datasets SET rev=rev+1 WHERE dataset=?", (self._dataset,))

    def _compute_state(self) -> list[dict]:
        """The current keyed records, computed from the ledger — the EXPENSIVE step, run only
        on a ``current`` rebuild (after a write), never on a steady read. Each entry is
        ``{key, present, first_seen, last_seen, cnt, seq, maxbatch, values}``.

        ``latest``/``first`` (and no_dedup) use indexed SQL aggregation; numeric aggregates
        (sum/mean/max/min) need every observation, so they fold the ledger via :func:`replay`."""
        if self._no_dedup:
            rows = self._conn.execute(
                "SELECT id, ts, batch, values_json FROM events "
                "WHERE dataset=? AND reverted=0 AND op!='remove' ORDER BY id", (self._dataset,)).fetchall()
            return [{"key": f"#{r['id']}", "present": True, "first_seen": r["ts"], "last_seen": r["ts"],
                     "cnt": 1, "seq": r["id"], "maxbatch": r["batch"],
                     "values": json.loads(r["values_json"])} for r in rows]
        if self._agg in ("latest", "first"):
            return self._compute_boundary(self._agg)
        out = []
        for k, e in self._state().items():
            recs = e.get("records", [])
            out.append({"key": k, "present": e.get("present", True),
                        "first_seen": e.get("first_seen"), "last_seen": e.get("last_seen"),
                        # summed WEIGHTS, not len(): a folded base is one record standing for many
                        "cnt": sum(obs_weight(o) for o in recs), "seq": e.get("_seq"),
                        "maxbatch": max((o.get("batch", 0) for o in recs), default=0),
                        "values": e.get("values", {})})
        return out

    def _compute_boundary(self, agg: str) -> list[dict]:
        ds = self._dataset
        c = self._conn
        # SUM(weight), not COUNT(*): a compaction base is one row standing for the observations
        # it folded, so counting rows would under-report `_count` on a compacted dataset.
        stats = {r["key"]: r for r in c.execute(
            "SELECT key, SUM(weight) cnt, MIN(id) seq, MAX(batch) maxbatch "
            "FROM events WHERE dataset=? AND reverted=0 AND op!='remove' AND key IS NOT NULL "
            "GROUP BY key", (ds,)).fetchall()}
        if not stats:
            return []

        def boundary(which: str) -> dict:
            q = (f"SELECT e.key key, e.values_json vj, e.ts ts, e.fold_json fj FROM events e "
                 f"JOIN (SELECT key, {which}(id) m FROM events "
                 f"      WHERE dataset=? AND reverted=0 AND op!='remove' AND key IS NOT NULL GROUP BY key) g "
                 f"ON e.key=g.key AND e.id=g.m WHERE e.dataset=?")
            # a base event's own ts is a point; its fold span carries the real first/last it
            # replaced, so the boundary timestamps survive compaction.
            out = {}
            for r in c.execute(q, (ds, ds)).fetchall():
                span = json.loads(r["fj"]) if r["fj"] else {}
                ts = span.get("first_ts" if which == "MIN" else "last_ts") or r["ts"]
                out[r["key"]] = (r["vj"], ts)
            return out

        firstb = boundary("MIN")
        lastb = boundary("MAX")
        pres = {r["key"]: r["op"] for r in c.execute(
            "SELECT e.key key, e.op op FROM events e "
            "JOIN (SELECT key, MAX(id) m FROM events "
            "      WHERE dataset=? AND reverted=0 AND key IS NOT NULL GROUP BY key) g "
            "ON e.key=g.key AND e.id=g.m WHERE e.dataset=?", (ds, ds)).fetchall()}
        out = []
        for key, st in stats.items():
            fvj, fts = firstb[key]
            lvj, lts = lastb[key]
            out.append({"key": key, "present": pres.get(key, "add") != ChangeOp.remove.value,
                        "first_seen": fts, "last_seen": lts,
                        "cnt": st["cnt"], "seq": st["seq"], "maxbatch": st["maxbatch"],
                        "values": json.loads(fvj if agg == "first" else lvj)})
        return out

    def _ensure_current(self) -> None:
        """Make the ``current`` table reflect the latest ledger, rebuilding only when a write
        bumped ``rev`` past the materialisation's ``cur_rev``. Steady reads are then a plain
        ``SELECT`` over ``current`` — O(distinct keys), independent of history depth."""
        row = self._conn.execute("SELECT rev, cur_rev, cur_agg FROM datasets WHERE dataset=?",
                                 (self._dataset,)).fetchone()
        if row is None or (row["cur_rev"] == row["rev"] and row["cur_agg"] == self._agg):
            return   # materialisation is current for this rev AND aggregate policy
        rev = row["rev"]
        # the ledger->current rebuild is the "replay" cost — time it under the "rp" op (the
        # stats-panel "replays" bucket). Only runs on a post-write rebuild, never a steady read.
        with stats_store.time_block(self._game, f"ds:{self._dataset}", "rp", n_fn=lambda: len(entries)):
            entries = self._compute_state()   # expensive — but only on a post-write rebuild
        c = self._conn
        c.execute("BEGIN IMMEDIATE")
        try:
            c.execute("DELETE FROM current WHERE dataset=?", (self._dataset,))
            c.executemany(
                "INSERT INTO current(dataset,key,present,first_seen,last_seen,values_json,cnt,seq,maxbatch) "
                "VALUES(?,?,?,?,?,?,?,?,?)",
                [(self._dataset, e["key"], 1 if e["present"] else 0, e["first_seen"], e["last_seen"],
                  json.dumps(e["values"], default=str), e["cnt"], e["seq"], e["maxbatch"]) for e in entries])
            # stamp the rev we computed AT — if a write advanced rev meanwhile, cur_rev won't
            # match the new rev, so the next read rebuilds (never trusts a lagging snapshot).
            c.execute("UPDATE datasets SET cur_rev=?, cur_agg=? WHERE dataset=?",
                      (rev, self._agg, self._dataset))
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise

    def _stamp_current(self) -> None:
        """Mark the ``current`` materialisation up to date with the live ``rev`` (and the
        active aggregate). Called after a write has incrementally maintained ``current``, so
        a following read trusts it without a full rebuild."""
        self._conn.execute("UPDATE datasets SET cur_rev=rev, cur_agg=? WHERE dataset=?",
                           (self._agg, self._dataset))

    def _current_upsert(self, key: str, ev: ChangeEvent, values: dict) -> None:
        """Fold ONE new add/update observation into the key's ``current`` row in place — O(1)
        for latest/first, so a sweep's per-record write never rebuilds the whole table. Numeric
        aggregates can't be folded incrementally, so recompute just that key from its events."""
        if self._agg in ("sum", "mean", "max", "min"):
            self._recompute_current_key(key)
            return
        c = self._conn
        row = c.execute("SELECT cnt, values_json, maxbatch FROM current WHERE dataset=? AND key=?",
                        (self._dataset, key)).fetchone()
        if row is None:
            # OR REPLACE: `current` is a rebuildable cache, not source of truth. A phantom row
            # (leftover after an event delete before its rebuild, or a cross-process write racing
            # the SELECT above under autocommit) must self-heal here, never throw a fatal
            # UNIQUE-constraint that kills the writing thread. Matches _recompute_current_key.
            c.execute("INSERT OR REPLACE INTO current(dataset,key,present,first_seen,last_seen,values_json,cnt,seq,maxbatch) "
                      "VALUES(?,?,1,?,?,?,1,?,?)",
                      (self._dataset, key, ev.ts, ev.ts, json.dumps(values, default=str), ev.id, ev.batch))
        else:
            vals = row["values_json"] if self._agg == "first" else json.dumps(values, default=str)
            c.execute("UPDATE current SET present=1, last_seen=?, values_json=?, cnt=?, maxbatch=? "
                      "WHERE dataset=? AND key=?",
                      (ev.ts, vals, row["cnt"] + 1, max(row["maxbatch"], ev.batch), self._dataset, key))

    def _recompute_current_key(self, key: str) -> None:
        """Rebuild one key's ``current`` row from its events (for numeric aggregates, or any
        path that changed which of a key's events are live). O(observations-for-key)."""
        c = self._conn
        ds = self._dataset
        rows = c.execute(
            "SELECT id, ts, batch, values_json, op, weight, fold_json FROM events "
            "WHERE dataset=? AND key=? AND reverted=0 ORDER BY id", (ds, key)).fetchall()
        obs = [r for r in rows if r["op"] != ChangeOp.remove.value]
        if not obs:
            c.execute("DELETE FROM current WHERE dataset=? AND key=?", (ds, key))
            return
        # carry each event's fold weight into the records so the aggregate (mean) and the count
        # below both see the observations a compaction base stands for, not just the one row.
        recs = []
        for r in obs:
            fold = _fold_of(r)
            rec = {"values": json.loads(r["values_json"]), "ts": r["ts"], "batch": r["batch"]}
            if fold:
                rec["n"] = obs_weight(fold)
            recs.append(rec)
        values = aggregate_records(recs, self._agg)
        present = rows[-1]["op"] != ChangeOp.remove.value
        first_span, last_span = _fold_of(obs[0]) or {}, _fold_of(obs[-1]) or {}
        c.execute(
            "INSERT OR REPLACE INTO current(dataset,key,present,first_seen,last_seen,values_json,cnt,seq,maxbatch) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (ds, key, 1 if present else 0,
             first_span.get("first_ts") or obs[0]["ts"], last_span.get("last_ts") or obs[-1]["ts"],
             json.dumps(values, default=str),
             sum(obs_weight(r) for r in recs), obs[0]["id"], max(o["batch"] for o in obs)))

    def _current_records(self) -> list[dict]:
        self._ensure_current()
        posmap = self.positions()   # learned slot (xpos, vpos) per key (mirror datasets); {} otherwise
        return [{"key": r["key"], "present": bool(r["present"]),
                 "first_seen": r["first_seen"], "last_seen": r["last_seen"],
                 "_count": r["cnt"], "_seq": r["seq"], "_batch": r["maxbatch"],
                 "_pos": _fmt_pos(posmap.get(r["key"])),   # "row · col" (row index primary, column 0..1)
                 **json.loads(r["values_json"])}
                for r in self._conn.execute(
                    "SELECT key,present,first_seen,last_seen,values_json,cnt,seq,maxbatch "
                    "FROM current WHERE dataset=?", (self._dataset,)).fetchall()]

    # ---- queries -----------------------------------------------------------

    @property
    def rev(self) -> int:
        """The dataset's mutation counter — bumps on every write. Cheap PK lookup; used to
        gate cached view results (a rev change = a source changed = recompute). 0 when the
        dataset row doesn't exist yet (an unwritten dataset can't have stale consumers)."""
        row = self._conn.execute("SELECT rev FROM datasets WHERE dataset=?", (self._dataset,)).fetchone()
        return row["rev"] if row else 0

    @property
    def present_count(self) -> int:
        return sum(1 for r in self._current_records() if r.get("present", True))

    @property
    def last_change(self) -> dict | None:
        """The newest ledger event's ``{ts, op}``. ``None`` when the ledger is empty."""
        row = self._conn.execute(
            "SELECT ts, op FROM events WHERE dataset=? ORDER BY id DESC LIMIT 1",
            (self._dataset,)).fetchone()
        return {"ts": row["ts"], "op": row["op"]} if row else None

    def records(self, limit: int = 0) -> list[dict]:
        """All current records, present first then by key. ``limit<=0`` means no cap."""
        rows = self._current_records()
        rows.sort(key=lambda r: (not r["present"], r["key"]))
        return rows[:limit] if limit and limit > 0 else rows

    def all_records(self, limit: int = 0) -> list[dict]:
        """Every non-reverted observation as its OWN row (no per-key collapse) — the 'many'
        side a view's aggregate would otherwise reduce to one. Oldest→newest; carries the same
        bookkeeping cols (``key``/``_batch``/``_seq``/…) as :meth:`records` so views treat it
        identically. ``limit<=0`` means no cap."""
        rows = self._conn.execute(
            "SELECT id, key, batch, ts, values_json FROM events "
            "WHERE dataset=? AND reverted=0 AND op!='remove' ORDER BY id"
            + (" LIMIT ?" if limit and limit > 0 else ""),
            (self._dataset, limit) if limit and limit > 0 else (self._dataset,)).fetchall()
        return [{"key": r["key"], "present": True, "first_seen": r["ts"], "last_seen": r["ts"],
                 "_count": 1, "_seq": r["id"], "_batch": r["batch"],
                 **json.loads(r["values_json"])} for r in rows]

    def key_of(self, values: dict) -> str | None:
        """The record's dedup key under this store's spec, or ``None`` if unkeyable."""
        return self._key.build(values)

    def observations(self, key: str) -> list[dict]:
        """The full observation history under one key, oldest→newest (each row carries its
        ``ts``). This is the 'many' side a view's aggregate collapses."""
        if self._no_dedup:
            if not str(key).startswith("#"):
                return []
            rows = self._conn.execute(
                "SELECT ts, values_json FROM events WHERE dataset=? AND id=? AND reverted=0 AND op!='remove'",
                (self._dataset, int(str(key)[1:]))).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT ts, values_json FROM events WHERE dataset=? AND key=? AND reverted=0 "
                "AND op!='remove' ORDER BY id", (self._dataset, key)).fetchall()
        return [{"ts": r["ts"], **json.loads(r["values_json"])} for r in rows]

    def summary(self) -> dict:
        """Cheap dashboard digest: counts + a column preview + the last change. Reads the counts
        straight off `current` with COUNT/SUM and samples just 20 rows for column names — it does
        NOT materialise + json.loads every record (the old `_current_records()` path, O(keys)),
        so the flow-list endpoint that summarises every dataset stays cheap as key counts grow."""
        self._ensure_current()   # make `current` valid; the counts/sample below trust it
        c = self._conn
        total, present = c.execute(
            "SELECT COUNT(*), COALESCE(SUM(present), 0) FROM current WHERE dataset=?",
            (self._dataset,)).fetchone()
        cols: list[str] = []
        for (vj,) in c.execute("SELECT values_json FROM current WHERE dataset=? LIMIT 20",
                               (self._dataset,)):
            for k in json.loads(vj):   # raw record values — no plumbing keys to filter
                if k not in _PLUMBING and k not in cols:
                    cols.append(k)
        last = self.last_change
        # Batch count rides the flow poll ONLY for a dataset that has a retention limit — that's
        # the one place the UI needs it (to decide whether folding would destroy anything). It
        # costs an index scan, and this digest is deliberately cheap for the flow-list endpoint
        # that summarises every dataset, so an unlimited dataset (the majority, and the huge
        # ones) pays nothing and reports None.
        return {"dataset": self._dataset, "present": present, "total": total,
                "removed": total - present, "columns": cols,
                "batches": self.batch_count() if self._keep > 0 else None,
                "keep_batches": self._keep,
                "last_ts": last["ts"] if last else None,
                "last_op": last["op"] if last else None}

    def history(self, limit: int = 50) -> list[dict]:
        """Individual ledger events newest-first, each flagged reverted."""
        q = ("SELECT id,batch,ts,op,key,values_json,changed_json,reverted "
             "FROM events WHERE dataset=? ORDER BY id DESC")
        args: tuple = (self._dataset,)
        if limit and limit > 0:
            q += " LIMIT ?"
            args = (self._dataset, limit)
        out = []
        for r in self._conn.execute(q, args).fetchall():
            d = {"id": r["id"], "batch": r["batch"], "ts": r["ts"], "op": r["op"],
                 "key": r["key"], "values": json.loads(r["values_json"]),
                 "reverted": bool(r["reverted"])}
            if r["changed_json"]:
                d["changed"] = json.loads(r["changed_json"])
            out.append(d)
        return out

    def batches(self, limit: int = 50) -> list[dict]:
        """The ledger as runs, newest-first: counts + a key sample, with a reverted flag
        (true when every event in the run is reverted)."""
        q = ("SELECT batch, COUNT(*) AS count, "
             "SUM(CASE WHEN op='add' THEN 1 ELSE 0 END) AS adds, "
             "SUM(CASE WHEN op='update' THEN 1 ELSE 0 END) AS updates, "
             "SUM(CASE WHEN op='remove' THEN 1 ELSE 0 END) AS removes, "
             "MIN(reverted) AS allrev "
             "FROM events WHERE dataset=? GROUP BY batch ORDER BY batch DESC")
        args: tuple = (self._dataset,)
        if limit and limit > 0:
            q += " LIMIT ?"
            args = (self._dataset, limit)
        meta = self._conn.execute(q, args).fetchall()
        out = []
        for m in meta:
            evs = self._conn.execute(
                "SELECT ts, key FROM events WHERE dataset=? AND batch=? ORDER BY id",
                (self._dataset, m["batch"])).fetchall()
            out.append({
                "batch": m["batch"],
                "started": evs[0]["ts"] if evs else None,
                "ts": evs[-1]["ts"] if evs else None,
                "count": m["count"],
                "adds": m["adds"], "updates": m["updates"], "removes": m["removes"],
                "reverted": bool(m["allrev"]),
                "keys": [(e["key"] or "·") for e in evs[:8]],
            })
        return out

    def batch_events(self, batch: int) -> list[dict]:
        """Every event of one batch in ledger order, each flagged reverted."""
        rows = self._conn.execute(
            "SELECT id,batch,ts,op,key,values_json,changed_json,reverted "
            "FROM events WHERE dataset=? AND batch=? ORDER BY id", (self._dataset, int(batch))).fetchall()
        out = []
        for r in rows:
            d = {"id": r["id"], "batch": r["batch"], "ts": r["ts"], "op": r["op"],
                 "key": r["key"], "values": json.loads(r["values_json"]),
                 "reverted": bool(r["reverted"])}
            if r["changed_json"]:
                d["changed"] = json.loads(r["changed_json"])
            out.append(d)
        return out

    def preview_batch(self, batch: int) -> list[dict]:
        """What APPLYING this batch changes in the dataset, independent of whether it is
        currently applied: diff between the dataset with the batch fully off vs fully on
        (all other batches kept in their current reverted state). One row per affected key:
        kind add/update/remove, with before/after values and per-field old→new."""
        bi = int(batch)
        events, reverted = self._load_all_events()
        bids = {e.id for e in events if e.batch == bi}
        if not bids:
            return []
        base = replay(events, reverted | bids, self._key, self._agg)    # batch off
        after = replay(events, reverted - bids, self._key, self._agg)   # batch on
        out = []
        for k in sorted(set(base) | set(after)):
            b, a = base.get(k), after.get(k)
            bp = bool(b and b.get("present"))
            ap = bool(a and a.get("present"))
            bv = (b or {}).get("values") or {}
            av = (a or {}).get("values") or {}
            if not bp and ap:
                kind = "add"
            elif bp and not ap:
                kind = "remove"
            elif bp and ap and bv != av:
                kind = "update"
            else:
                continue
            changed = {f: [bv.get(f), av.get(f)] for f in set(bv) | set(av) if bv.get(f) != av.get(f)}
            out.append({"key": k, "kind": kind,
                        "before": bv if bp else None, "after": av if ap else None,
                        "changed": changed})
        return out
