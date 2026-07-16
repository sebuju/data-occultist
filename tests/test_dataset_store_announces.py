"""Invariant: EVERY DatasetStore mutation announces on the change bus.

This pins the rule the codebase repeatedly got wrong — a mutator that writes data but forgets
to publish (e.g. the old `edit_event`) silently breaks the Pretty UI refresh, on_change trigger
firing, and the graph flow blobs. Any new mutator must keep this green.
"""

from oc.store import changes
from oc.store.dataset_store import DatasetStore
from oc.store.keys import KeySpec


def _spy():
    """A change-bus subscriber that counts publishes and remembers the last records list."""
    state = {"n": 0, "last": None}

    def cb(_game, _dataset, records, _data_changed=True, _batch=None):
        state["n"] += 1
        state["last"] = records
        state["changed"] = _data_changed
        state["batch"] = _batch
    return state, cb


def _expect(spy, action, *, should=True):
    """Run ``action``; assert whether it published on the change bus. Returns its result."""
    before = spy["n"]
    out = action()
    assert (spy["n"] > before) is should, f"announce expected={should}, got {spy['n'] - before}"
    return out


def test_every_mutator_announces(tmp_path):
    store = DatasetStore(tmp_path, "g", "d", key=KeySpec(("name",)))
    spy, cb = _spy()
    off = changes.subscribe(cb)
    try:
        b1 = store.begin_batch()

        # add + update both announce; an identical re-read does NOT (nothing changed)
        assert _expect(spy, lambda: store.record_seen({"name": "a", "v": "1"})) is not None
        assert _expect(spy, lambda: store.record_seen({"name": "a", "v": "2"})) is not None
        assert _expect(spy, lambda: store.record_seen({"name": "a", "v": "2"}), should=False) is None

        store.record_seen({"name": "b", "v": "1"})

        # reconcile (removes the absent key) announces
        _expect(spy, lambda: store.reconcile({"a"}))

        # single-event revert / un-revert
        newest = store.history(0)[0]["id"]
        _expect(spy, lambda: store.set_reverted(newest, True))
        _expect(spy, lambda: store.set_reverted(newest, False))

        # batch revert announces; batch RESTORE announces AND carries the re-applied rows
        _expect(spy, lambda: store.revert_batch(b1, True))
        _expect(spy, lambda: store.revert_batch(b1, False))
        assert spy["last"], "restore must announce the rows it re-applied (for on_change pricing)"

        # the bug we fixed: editing an event's values must announce
        oldest = store.history(0)[-1]["id"]
        assert _expect(spy, lambda: store.edit_event(oldest, {"name": "a", "v": "9"}))

        # permanent deletions announce
        assert _expect(spy, lambda: store.remove_event(oldest))
        _expect(spy, lambda: store.remove_batch(b1))

        # clear announces
        store.record_seen({"name": "c", "v": "1"})
        _expect(spy, lambda: store.clear_data())
    finally:
        off()
