"""Replacement-based removal: a stored key is removed only when a DIFFERENT key is read in its
exact grid slot (column + scroll-invariant row INDEX), and only across confirm_frames clean
frames. A flaky OCR miss (slot empty) never removes; a still-present relic read at its slot is
safe. ``vpos`` and ``vlo``/``vhi`` are row indices in the whole list."""

from oc.collect.slice_sync import SliceSync


def _obs(ss, vlo, vhi, read, present, clean=True):
    # read: {key: (xpos, vpos)}; present: iterable of present keys
    return ss.observe(vlo, vhi, dict(read), set(present), clean)


def test_replacement_removes_after_confirm():
    ss = SliceSync(confirm_frames=2)
    # a at column 0.1 / row 3, b at column 0.5 / row 3 (same row, different columns)
    assert _obs(ss, 0.0, 10.0, {"a": (0.1, 3.0), "b": (0.5, 3.0)}, ["a", "b"]) == set()
    # a is consumed: c reflows into a's exact slot (col 0.1, row 3); b still read
    assert _obs(ss, 0.0, 10.0, {"c": (0.1, 3.0), "b": (0.5, 3.0)}, ["a", "b", "c"]) == set()
    assert _obs(ss, 0.0, 10.0, {"c": (0.1, 3.0), "b": (0.5, 3.0)}, ["a", "b", "c"]) == {"a"}


def test_flaky_miss_not_removed():
    # a present but OCR misses it this frame; NOTHING is read in a's slot -> not removed
    ss = SliceSync(confirm_frames=1)
    _obs(ss, 0.0, 10.0, {"a": (0.1, 3.0), "b": (0.5, 3.0)}, ["a", "b"])
    assert _obs(ss, 0.0, 10.0, {"b": (0.5, 3.0)}, ["a", "b"]) == set()   # a's slot empty -> keep
    assert _obs(ss, 0.0, 10.0, {"b": (0.5, 3.0)}, ["a", "b"]) == set()


def test_same_row_other_column_is_not_replacement():
    # b read in the same ROW as a but a DIFFERENT column must not count as replacing a
    ss = SliceSync(confirm_frames=1)
    _obs(ss, 0.0, 10.0, {"a": (0.1, 3.0), "b": (0.5, 3.0)}, ["a", "b"])
    assert _obs(ss, 0.0, 10.0, {"b": (0.5, 3.0)}, ["a", "b"]) == set()


def test_within_half_row_counts_outside_does_not():
    # the slot match tolerates sub-row OCR jitter (ev=0.5) but rejects a clearly different row
    ss = SliceSync(confirm_frames=1)
    _obs(ss, 0.0, 10.0, {"a": (0.1, 3.0)}, ["a"])
    assert _obs(ss, 0.0, 10.0, {"c": (0.1, 3.3)}, ["a", "c"]) == {"a"}     # 0.3 row off -> replaced
    ss2 = SliceSync(confirm_frames=1)
    _obs(ss2, 0.0, 10.0, {"a": (0.1, 3.0)}, ["a"])
    assert _obs(ss2, 0.0, 10.0, {"c": (0.1, 4.0)}, ["a", "c"]) == set()    # a full row off -> keep


def test_present_relic_read_at_its_slot_is_safe():
    ss = SliceSync(confirm_frames=1)
    _obs(ss, 0.0, 10.0, {"a": (0.1, 3.0)}, ["a"])
    # a still read (maybe at a slightly shifted slot) -> never a candidate
    assert _obs(ss, 0.0, 10.0, {"a": (0.1, 3.4)}, ["a"]) == set()


def test_slot_out_of_view_not_judged():
    ss = SliceSync(confirm_frames=1)
    _obs(ss, 60.0, 100.0, {"a": (0.1, 80.0)}, ["a", "b"])     # a learned far down at row 80
    # viewport now at the top; a's slot (80) is out of [0,40] -> not judged even if replaced-looking
    assert _obs(ss, 0.0, 40.0, {"x": (0.1, 20.0)}, ["a", "b"]) == set()


def test_unclean_frame_no_evidence():
    ss = SliceSync(confirm_frames=1)
    _obs(ss, 0.0, 10.0, {"a": (0.1, 3.0)}, ["a"])
    # an occluded frame that happens to read something in a's slot must NOT remove a
    assert _obs(ss, 0.0, 10.0, {"c": (0.1, 3.0)}, ["a", "c"], clean=False) == set()


def test_confirm_resets_when_relic_reappears():
    ss = SliceSync(confirm_frames=3)
    _obs(ss, 0.0, 10.0, {"a": (0.1, 3.0)}, ["a"])
    assert _obs(ss, 0.0, 10.0, {"c": (0.1, 3.0)}, ["a", "c"]) == set()   # replaced 1
    assert _obs(ss, 0.0, 10.0, {"a": (0.1, 3.0)}, ["a", "c"]) == set()   # a back -> absence reset
    assert _obs(ss, 0.0, 10.0, {"c": (0.1, 3.0)}, ["a", "c"]) == set()   # replaced 1 again, not 2


def test_pos_map_and_seed():
    ss = SliceSync(confirm_frames=1)
    _obs(ss, 2.0, 6.0, {"x": (0.3, 4.0)}, ["x"])
    assert ss.pos_map() == {"x": (0.3, 4.0)}           # full (column, row index) slot
    ss2 = SliceSync(confirm_frames=1)
    ss2.seed({"x": (0.3, 4.0)})
    # seeded with its real column -> a DIFFERENT relic read in x's exact slot removes it
    # (this is the cross-run fix: a relic gone between runs no longer lingers)
    assert ss2.observe(0.0, 10.0, {"y": (0.3, 4.0)}, {"x"}, True) == {"x"}


def test_seed_legacy_no_column_not_removed():
    # legacy rows persisted before the column existed seed as (None, vpos) -> still safe
    ss = SliceSync(confirm_frames=1)
    ss.seed({"x": (None, 4.0)})
    assert ss.observe(0.0, 10.0, {"y": (0.3, 4.0)}, {"x"}, True) == set()
