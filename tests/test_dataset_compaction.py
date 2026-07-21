"""Rolling batch retention by COMPACTION: batches past the window fold into a per-key base
event instead of being deleted, so the surviving batches replay over a backbone that still
answers for the whole history.

The load-bearing property throughout: a compacted store must return the SAME records, values
and counts as an uncompacted control store fed the identical observations. Anything that only
checks "batches went down" would pass while quietly losing data.
"""

import pytest

from oc.profile.models import DatasetDef, GameProfile
from oc.store import inspect, store_for
from oc.store.dataset_store import DatasetStore
from oc.store.dataset_ops import run_dataset_action
from oc.store.keys import KeyMap, KeySpec


def _store(tmp_path, keep=0, agg="latest", dedup=True, name="ds"):
    key = KeyMap(default=KeySpec(fields=("name",)), dedup=dedup)
    return DatasetStore(tmp_path, "g", name, key=key, aggregate=agg, keep_batches=keep)


def _feed(store, batches):
    """Write `batches` (a list of per-batch row lists), one begin_batch per batch."""
    for rows in batches:
        store.begin_batch()
        for r in rows:
            store.record_seen(r)


_OBS = 9   # total observations across BATCHES, for the modes where each stays its own row


def _by_key(store):
    return {r["key"]: r for r in store.records()}


# Both keys are re-observed ACROSS batches, so folding genuinely merges several observations of
# the same key into one base (weight > 1). A fixture with one observation per key per batch folds
# to weight-1 bases and would let a broken `mean`/`_count` weighting pass unnoticed.
BATCHES = [
    [{"name": "a", "v": 1}],
    [{"name": "a", "v": 2}, {"name": "b", "v": 9}],
    [{"name": "a", "v": 3}, {"name": "b", "v": 7}],
    [{"name": "a", "v": 4}],
    [{"name": "a", "v": 5}, {"name": "b", "v": 8}],
    [{"name": "a", "v": 6}],
]


# ---- the window itself ------------------------------------------------------

def test_no_limit_keeps_every_batch(tmp_path):
    s = _store(tmp_path, keep=0)
    _feed(s, BATCHES)
    assert s.batch_count() == len(BATCHES)


def test_under_the_cap_folds_nothing(tmp_path):
    s = _store(tmp_path, keep=10)
    _feed(s, BATCHES)
    assert s.batch_count() == len(BATCHES)
    assert s.fold_batches() == 0


def test_live_writes_settle_at_exactly_the_limit(tmp_path):
    """`keep` is the TOTAL batch budget, base included — "keep 2" must leave 2, not 3. The live
    path is the fiddly one: begin_batch folds BEFORE its own batch has written any events, so it
    reserves that slot. Without the reservation the ledger settles one over the number the user
    set, which is exactly what "I asked for 30 and got 31" looked like."""
    s = _store(tmp_path, keep=2)
    _feed(s, BATCHES)
    assert s.batch_count() == 2
    _feed(s, [[{"name": "a", "v": i}] for i in range(20)])
    assert s.batch_count() == 2, "retention must bound the ledger, not merely slow it"


def test_fold_converges_and_stops_asking(tmp_path):
    """A settled dataset must report itself settled. The base is the OLDEST batch, so it always
    sits below the cutoff — treat that as foldable and the UI offers "fold" forever while nothing
    changes, and every begin_batch burns a transaction + change-bus announce for nothing."""
    s = _store(tmp_path, keep=0)
    _feed(s, [[{"name": f"k{i % 3}", "v": i}] for i in range(40)])
    assert s.batch_count() == 40

    assert s.fold_batches(5) == 35                 # 40 -> 5 (4 detailed + 1 base): 36 folded into 1
    assert s.batch_count() == 5, "keep=5 must leave 5 batches, base included"

    s2 = _store(tmp_path, keep=5)
    assert s2.would_fold() is False, "a settled dataset must stop offering to fold"
    rev = s2.rev
    assert s2.fold_batches() == 0
    assert s2.rev == rev, "a no-op fold must not write (no rev bump, no announce)"


# ---- the property that matters: same data, fewer batches --------------------

def test_the_fixture_actually_folds_multiple_observations(tmp_path):
    """Guards the tests below from going vacuous. If a fold only ever produced weight-1 bases
    (one observation per key per folded batch) the parity checks would pass without ever
    exercising the weighting that `mean` and `_count` depend on."""
    s = _store(tmp_path, keep=2)
    _feed(s, BATCHES)
    weights = [r["weight"] for r in
               s._conn.execute("SELECT weight FROM events WHERE weight>1").fetchall()]
    assert weights, "no base event folded more than one observation — fixture is too weak"
    assert max(weights) > 1
    assert len(s._conn.execute("SELECT id FROM events").fetchall()) < sum(len(b) for b in BATCHES)


@pytest.mark.parametrize("agg", ["latest", "first", "sum", "mean", "max", "min"])
def test_compacted_store_matches_an_uncompacted_control(tmp_path, agg):
    """Every aggregate must survive the fold. `mean` is the one that breaks without the
    per-observation weight — a base standing for 3 reads must not count as a single read."""
    live = _store(tmp_path / "live", keep=2, agg=agg)
    ctrl = _store(tmp_path / "ctrl", keep=0, agg=agg)
    _feed(live, BATCHES)
    _feed(ctrl, BATCHES)
    got, want = _by_key(live), _by_key(ctrl)
    assert set(got) == set(want)
    for k in want:
        assert got[k]["v"] == want[k]["v"], f"{agg}: {k} folded to {got[k]['v']}, want {want[k]['v']}"
        assert got[k]["_count"] == want[k]["_count"], f"{agg}: {k} lost its observation count"


def test_fold_preserves_first_seen_and_arrival_order(tmp_path):
    live = _store(tmp_path / "live", keep=2)
    ctrl = _store(tmp_path / "ctrl", keep=0)
    _feed(live, BATCHES)
    _feed(ctrl, BATCHES)
    got, want = _by_key(live), _by_key(ctrl)
    for k in want:
        assert got[k]["first_seen"] == want[k]["first_seen"], f"{k} lost its first_seen"
        assert got[k]["_seq"] == want[k]["_seq"], f"{k} lost its arrival order"


def test_key_seen_only_in_folded_batches_survives(tmp_path):
    """The whole point over plain deletion: an old key must not disappear."""
    s = _store(tmp_path, keep=2)
    _feed(s, [[{"name": "old", "v": 1}], [{"name": "x"}], [{"name": "y"}], [{"name": "z"}]])
    assert "old" in _by_key(s)


def test_removed_key_stays_removed_through_a_fold(tmp_path):
    s = _store(tmp_path, keep=99)
    _feed(s, [[{"name": "a"}, {"name": "b"}]])
    s.begin_batch()
    s.remove_keys(["b"])
    _feed(s, [[{"name": "a"}], [{"name": "a"}]])
    s.fold_batches(2)
    rows = _by_key(s)
    assert "b" in rows, "a soft-removed row must not vanish when its batches fold"
    assert rows["b"]["present"] is False, "a removed key must not resurrect present"
    assert rows["a"]["present"] is True


# ---- idempotence + robustness ----------------------------------------------

def test_folding_twice_changes_nothing(tmp_path):
    """A second fold at the same window is a genuine no-op — the base folds back into itself
    rather than compounding (which would re-weight and drift the aggregates).

    Asserts `rev` is untouched, not merely that the return value is 0: a fold that runs and
    achieves nothing ALSO returns 0, so the old return-value-only check passed happily while the
    fold kept re-running on every call."""
    s = _store(tmp_path, keep=2)
    _feed(s, BATCHES)
    s.fold_batches(2)
    before, rev = _by_key(s), s.rev
    assert s.fold_batches(2) == 0
    assert s.rev == rev, "the second fold must not touch the ledger at all"
    assert _by_key(s) == before


def test_repeated_folds_match_a_single_late_fold(tmp_path):
    """Folding every run (begin_batch) must land where folding once at the end would."""
    rolling = _store(tmp_path / "roll", keep=2)
    late = _store(tmp_path / "late", keep=0)
    _feed(rolling, BATCHES)
    _feed(late, BATCHES)
    late.fold_batches(2)
    assert _by_key(rolling) == _by_key(late)


def test_a_batch_gap_does_not_shift_the_window(tmp_path):
    s = _store(tmp_path, keep=0)
    _feed(s, BATCHES)
    s.remove_batch(2)                    # leaves a hole in the batch numbering
    kept = {r["_batch"] for r in s.records()}
    s.fold_batches(2)
    assert s.batch_count() <= 3
    assert max(kept) in {r["_batch"] for r in s.records()}, "the newest batch must survive"


def test_a_folded_key_keeps_its_learned_position(tmp_path):
    s = _store(tmp_path, keep=2)
    _feed(s, [[{"name": "a"}]])
    s.set_positions({"a": (0.0, 1.0)})
    _feed(s, [[{"name": "b"}], [{"name": "c"}], [{"name": "d"}]])
    assert "a" in _by_key(s), "the key folds forward rather than being deleted..."
    assert "a" in s.positions(), "...so its learned slot must fold forward too"


def test_positions_of_keys_absent_from_the_ledger_are_swept(tmp_path):
    """The orphan sweep: a slot for a key with no events left must not survive a fold, else
    `positions` grows without bound under a forever-folded dataset."""
    s = _store(tmp_path, keep=2)
    _feed(s, [[{"name": "a"}]])
    s.set_positions({"ghost": (0.0, 1.0)})
    assert "ghost" in s.positions()
    _feed(s, [[{"name": "b"}], [{"name": "c"}], [{"name": "d"}]])
    assert "ghost" not in s.positions()


# ---- the modes where folding would DESTROY rather than compact --------------

def test_no_dedup_never_folds(tmp_path):
    """dedup off = every observation is its own row; there is no 'many' side to collapse."""
    s = _store(tmp_path, keep=1, dedup=False)
    _feed(s, BATCHES)
    assert s.fold_batches() == 0
    assert len(s.records()) == _OBS      # every observation still its own row


def test_aggregate_all_never_folds(tmp_path):
    s = _store(tmp_path, keep=1, agg="all")
    _feed(s, BATCHES)
    assert s.fold_batches() == 0
    assert len(s.all_records()) == _OBS


# ---- summary + the action path ---------------------------------------------

def test_summary_reports_batches_only_when_a_limit_is_set(tmp_path):
    unlimited = _store(tmp_path / "u", keep=0)
    _feed(unlimited, BATCHES)
    assert unlimited.summary()["batches"] is None, "an unlimited dataset must not pay the count"

    limited = _store(tmp_path / "l", keep=2)
    _feed(limited, BATCHES)
    s = limited.summary()
    assert s["batches"] == limited.batch_count()
    assert s["keep_batches"] == 2


def _profile(keep):
    return GameProfile(name="g", datasets=[DatasetDef(id="ds", keep_batches=keep)])


# ---- the PRODUCTION read path ----------------------------------------------
# Every test above builds a DatasetStore directly with keep_batches=N. That skips the wiring
# the app actually uses, which is how a green suite still shipped an inert knob: the flow poll
# reaches the store through inspect.summarize, which never passed the profile, so the store's
# limit stayed 0 and the UI could never see that a dataset was over it. These cover the funnel
# rather than the constructor.

def test_store_for_resolves_keep_batches_from_the_profile(tmp_path):
    store = store_for(tmp_path, "g", "ds", profile=_profile(2))
    assert store._keep == 2, "the store funnel must learn the limit from the profile"


def test_summarize_reports_the_limit_the_profile_set(tmp_path):
    """The exact call flow.py makes per dataset on every poll. Without the profile threaded
    through, `batches` comes back None and the compact button can never appear."""
    p = _profile(2)
    _feed(_store(tmp_path, keep=0), BATCHES)      # written with no retention, like a pre-existing store
    got = inspect.summarize(tmp_path, "g", "ds", p.key_map_for("ds"), p.aggregate_for("ds"),
                            keep_batches=p.keep_batches_for("ds"))
    assert got["keep_batches"] == 2
    assert isinstance(got["batches"], int) and got["batches"] > 2


def test_summarize_stays_cheap_for_an_unlimited_dataset(tmp_path):
    p = _profile(0)
    _feed(_store(tmp_path, keep=0), BATCHES)
    got = inspect.summarize(tmp_path, "g", "ds", p.key_map_for("ds"), p.aggregate_for("ds"),
                            keep_batches=p.keep_batches_for("ds"))
    assert got["batches"] is None, "no limit -> don't pay for the batch count"


def test_compact_action_folds(tmp_path):
    p = _profile(2)
    _feed(_store(tmp_path, keep=0), BATCHES)      # write with no retention...
    out = run_dataset_action(tmp_path, "g", p, source="ds", action="compact")
    assert out["action"] == "compact"
    assert out["rows"] > 0                        # ...the action does the folding
    assert _store(tmp_path, keep=0).batch_count() <= 3


def test_compact_action_is_a_noop_under_the_cap(tmp_path):
    p = _profile(99)
    _feed(_store(tmp_path, keep=0), BATCHES)
    assert run_dataset_action(tmp_path, "g", p, source="ds", action="compact") == {}


def test_compact_action_is_a_noop_without_a_limit(tmp_path):
    p = _profile(0)
    _feed(_store(tmp_path, keep=0), BATCHES)
    assert run_dataset_action(tmp_path, "g", p, source="ds", action="compact") == {}


# ---- file-level compaction (VACUUM) -----------------------------------------
# Distinct from batch folding: that reduces ROWS, this returns the pages SQLite freed back to the
# OS. SQLite never shrinks a file on its own, so a churned store keeps its high-water size (the
# real one measured 84% freelist) until this runs.

def test_vacuum_reclaims_space_after_a_bulk_delete(tmp_path):
    from oc.store.dataset_store import vacuum_database
    s = _store(tmp_path, keep=0)
    _feed(s, [[{"name": f"k{i}", "v": "x" * 500}] for i in range(400)])
    s.clear_data()                      # frees a lot of pages; the FILE stays large
    before = (tmp_path / "g" / "store.sqlite").stat().st_size

    out = vacuum_database(tmp_path, "g")
    assert out["ok"] is True
    assert out["before"] == before
    assert out["after"] < before, "VACUUM must actually hand pages back to the OS"
    assert out["freed"] == before - out["after"]


def test_vacuum_preserves_every_row(tmp_path):
    """Non-destructive is the whole reason this needs no confirm step."""
    from oc.store.dataset_store import vacuum_database
    s = _store(tmp_path, keep=0)
    _feed(s, BATCHES)
    before = _by_key(s)
    assert vacuum_database(tmp_path, "g")["ok"] is True
    assert _by_key(_store(tmp_path, keep=0)) == before


def test_vacuum_on_a_missing_store_is_a_noop(tmp_path):
    from oc.store.dataset_store import vacuum_database
    assert vacuum_database(tmp_path, "nope") == {"ok": False, "before": 0, "after": 0, "freed": 0}
