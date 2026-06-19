from oc.collect.rows import detect_row_centers, fit_row_lattice


def test_clusters_lines_into_rows():
    # three rows of two lines each, scrolled to a sub-row offset (start at 0.13)
    pitch = 0.1
    centers, heights = [], []
    for r in range(3):
        y = 0.13 + r * pitch
        centers += [y, y + 0.002]   # two lines share a row band
        heights += [0.03, 0.03]
    rows = detect_row_centers(centers, heights, pitch, 0.0, 1.0, 10)
    assert len(rows) == 3
    assert rows[0] < rows[1] < rows[2]
    assert abs(rows[0] - 0.131) < 0.01    # band centre near the scrolled start


def test_respects_data_area_bounds():
    centers = [0.05, 0.5, 0.95]
    heights = [0.03, 0.03, 0.03]
    rows = detect_row_centers(centers, heights, 0.1, 0.2, 0.8, None)
    assert rows == [0.5]                   # 0.05 and 0.95 fall outside [0.2, 0.8]


def test_caps_at_max_rows():
    centers = [0.1 + i * 0.1 for i in range(8)]
    heights = [0.03] * 8
    rows = detect_row_centers(centers, heights, 0.1, 0.0, 1.0, 5)
    assert len(rows) == 5


def test_empty_when_no_lines():
    assert detect_row_centers([], [], 0.1, 0.0, 1.0, 5) == []


def test_anchor_top_and_bottom():
    # one row, a 2-line name: line centres 0.40 and 0.44, height 0.02
    centers, heights = [0.40, 0.44], [0.02, 0.02]
    def one(anchor):
        r = detect_row_centers(centers, heights, 0.2, 0.0, 1.0, anchor=anchor)
        return round(r[0], 3)
    assert one("center") == 0.42
    assert one("bottom") == 0.44    # bottommost line centre (line-count invariant for bottom-aligned names)
    assert one("top") == 0.39       # top of the topmost line


# --- fit_row_lattice: findings are evidence, the grid is a regular lattice ----------

def _diffs(rows):
    return [b - a for a, b in zip(rows, rows[1:])]


def _regular(rows, pitch, eps=1e-6):
    """Every consecutive gap equals ``pitch`` — i.e. one regular lattice."""
    return all(abs(d - pitch) < eps for d in _diffs(rows))


def _has(rows, y, eps=1e-6):
    return any(abs(r - y) < eps for r in rows)


def test_lattice_single_finding_emits_only_that_row():
    # One band -> no measurable pitch -> never speculatively tile the area.
    rows = fit_row_lattice([0.2], [0.05], 0.2, 0.0, 1.0)
    assert len(rows) == 1
    assert abs(rows[0] - 0.2) < 1e-6


def test_lattice_evenly_spaced_findings_are_regular():
    rows = fit_row_lattice([0.2, 0.4, 0.6], [0.05] * 3, 0.2, 0.0, 1.0)
    assert _regular(rows, 0.2)
    for y in (0.2, 0.4, 0.6):
        assert _has(rows, y)


def test_lattice_off_unless_pitch_tol_set():
    # No pitch_tol -> static window: candidate bands returned at face value, no fill.
    rows = fit_row_lattice([0.2, 0.6], [0.05, 0.05], 0.2, 0.0, 1.0)
    assert rows == [0.2, 0.6]
    assert not _has(rows, 0.4)


def test_lattice_interpolates_missing_row():
    # The 0.4 row's name was occluded (no finding) — the lattice fills it back in.
    rows = fit_row_lattice([0.2, 0.6], [0.05, 0.05], 0.2, 0.0, 1.0, pitch_tol=0.5)
    assert _has(rows, 0.4)
    assert _regular(rows, 0.2)


def test_lattice_rejects_off_lattice_noise():
    # A stray band far from the rows must not add an irregular row — it is absorbed
    # to the nearest lattice line, leaving one regular grid.
    rows = fit_row_lattice([0.2, 0.4, 0.6, 0.95], [0.05] * 4, 0.2, 0.0, 1.0, pitch_tol=0.5)
    assert _regular(rows, 0.2, eps=1e-9)


def test_lattice_regularizes_jittered_findings():
    rows = fit_row_lattice([0.2, 0.41, 0.59, 0.82], [0.05] * 4, 0.2, 0.0, 1.0, pitch_tol=0.5)
    ds = _diffs(rows)
    assert ds and max(abs(d - ds[0]) for d in ds) < 1e-9


def test_lattice_pitch_clamp_pulls_to_bound():
    # Real rows sit at pitch 0.25 but authored pitch is 0.2; tol 0.1 bounds the derived
    # pitch to [0.18, 0.22], so the lattice tightens to 0.22.
    centers = [0.25, 0.5, 0.75]
    free = fit_row_lattice(centers, [0.05] * 3, 0.2, 0.0, 1.2)
    assert abs(_diffs(free)[0] - 0.25) < 1e-6        # unclamped derives 0.25
    clamped = fit_row_lattice(centers, [0.05] * 3, 0.2, 0.0, 1.2, pitch_tol=0.1)
    assert abs(_diffs(clamped)[0] - 0.22) < 1e-6     # clamped to authored * 1.1
