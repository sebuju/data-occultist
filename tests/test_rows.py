from oc.collect.rows import detect_row_centers


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
