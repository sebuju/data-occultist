"""Interactive line-detection demo.

Loads an equipment capture and finds horizontal / vertical lines. Shows two
panels side by side:

    [ detected lines only ] [ lines overlaid on original ]

Tuning knobs are exposed as OpenCV trackbars and the panels redraw whenever any
of them changes. Two detection modes:

    mode 0 = Canny  (Canny edges  -> probabilistic Hough, split by angle)
    mode 1 = Morph  (adaptive thresh -> long horiz/vert structuring elements)
    mode 2 = Sobel  (gradient magnitude -> threshold -> probabilistic Hough)
    mode 3 = LSD    (Line Segment Detector -> direct segments, split by angle)

Run:
    python scripts/line_demo.py [path/to/image.jpg]

with no argument it grabs the newest capture under captures/warframe/.
Keys: q or Esc to quit.
"""

from __future__ import annotations

import glob
import os
import sys

import cv2
import numpy as np

WIN = "line demo  (q=quit)"
H_COLOR = (0, 0, 255)    # horizontal lines -> red   (BGR)
V_COLOR = (0, 255, 0)    # vertical lines   -> green
MAX_W = 2700             # cap full 3-panel width (override: --width N)


def newest_capture() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    pats = [
        os.path.join(root, "captures", "warframe", "*.jpg"),
        os.path.join(root, "captures", "warframe", "*.png"),
    ]
    files: list[str] = []
    for p in pats:
        files.extend(glob.glob(p))
    if not files:
        raise SystemExit("no captures found under captures/warframe/")
    return max(files, key=os.path.getmtime)


def _split_by_angle(segments, tol):
    """Split (x1,y1,x2,y2) segments into (horizontal, vertical) by angle tol."""
    h_lines, v_lines = [], []
    for x1, y1, x2, y2 in segments:
        ang = abs(np.degrees(np.arctan2(y2 - y1, x2 - x1)))  # 0..180
        ang = min(ang, 180 - ang)                            # fold to 0..90
        if ang <= tol:
            h_lines.append((int(x1), int(y1), int(x2), int(y2)))
        elif ang >= 90 - tol:
            v_lines.append((int(x1), int(y1), int(x2), int(y2)))
    return h_lines, v_lines


def _hough(edges, p):
    raw = cv2.HoughLinesP(
        edges,
        rho=1,
        theta=np.pi / 180,
        threshold=max(1, p["threshold"]),
        minLineLength=p["min_len"],
        maxLineGap=p["max_gap"],
    )
    segs = [] if raw is None else list(raw[:, 0])
    return _split_by_angle(segs, p["angle_tol"])


def detect_canny(gray, p):
    """Canny edges -> probabilistic Hough."""
    lo = p["canny_lo"]
    hi = max(lo + 1, p["canny_hi"])
    edges = cv2.Canny(gray, lo, hi)
    h, v = _hough(edges, p)
    return h, v, edges


def detect_sobel(gray, p):
    """Gradient magnitude (Sobel) -> threshold -> probabilistic Hough."""
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    mag = cv2.magnitude(gx, gy)
    mag = cv2.normalize(mag, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    # canny_lo slider doubles as the magnitude threshold here
    _, edges = cv2.threshold(mag, p["canny_lo"], 255, cv2.THRESH_BINARY)
    h, v = _hough(edges, p)
    return h, v, edges


_LSD = cv2.createLineSegmentDetector()


def detect_lsd(gray, p):
    """Line Segment Detector -> direct segments, length-filtered, split by angle."""
    lines = _LSD.detect(gray)[0]
    segs = []
    if lines is not None:
        for x1, y1, x2, y2 in lines[:, 0]:
            if np.hypot(x2 - x1, y2 - y1) >= p["min_len"]:
                segs.append((x1, y1, x2, y2))
    h, v = _split_by_angle(segs, p["angle_tol"])
    return h, v, None


def detect_morph(gray, p):
    """Return (h_lines, v_lines, mask) using morphological line extraction."""
    block = p["canny_lo"] | 1          # reuse slider as adaptive block size (odd)
    block = max(3, block)
    binv = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, block, 5
    )
    h, w = gray.shape
    # min_len slider sets how long a run must be (as a fraction-ish pixel count)
    hlen = max(3, p["min_len"])
    vlen = max(3, p["min_len"])

    h_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (hlen, 1))
    v_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, vlen))
    h_mask = cv2.morphologyEx(binv, cv2.MORPH_OPEN, h_kernel)
    v_mask = cv2.morphologyEx(binv, cv2.MORPH_OPEN, v_kernel)

    h_lines = _mask_to_segments(h_mask, axis="h", p=p)
    v_lines = _mask_to_segments(v_mask, axis="v", p=p)
    mask = cv2.bitwise_or(h_mask, v_mask)
    return h_lines, v_lines, mask


def _mask_to_segments(mask, axis, p):
    """Collapse a line mask into bounding-box segments per connected component."""
    n, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    segs = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if axis == "h" and w >= p["min_len"]:
            cy = y + h // 2
            segs.append((x, cy, x + w, cy))
        elif axis == "v" and h >= p["min_len"]:
            cx = x + w // 2
            segs.append((cx, y, cx, y + h))
    return segs


# short slider name -> param key in the p dict
PARAM = {"lo": "canny_lo", "hi": "canny_hi", "thr": "threshold",
         "minln": "min_len", "gap": "max_gap", "ang": "angle_tol"}
ALL_KNOBS = ["lo", "hi", "thr", "minln", "gap", "ang"]

# per-mode short description of each knob (shown in the legend)
DESC = {
    0: {"lo": "canny low", "hi": "canny high", "thr": "hough votes",
        "minln": "min line len", "gap": "max line gap", "ang": "h/v angle tol"},
    1: {"lo": "adapt block", "hi": "", "thr": "",
        "minln": "min run len", "gap": "", "ang": ""},
    2: {"lo": "mag thresh", "hi": "", "thr": "hough votes",
        "minln": "min line len", "gap": "max line gap", "ang": "h/v angle tol"},
    3: {"lo": "", "hi": "", "thr": "",
        "minln": "min seg len", "gap": "", "ang": "h/v angle tol"},
}

# which sliders are live per mode (everything else is pinned + dimmed)
ACTIVE = {
    0: {"lo", "hi", "thr", "minln", "gap", "ang"},
    1: {"lo", "minln"},
    2: {"lo", "thr", "minln", "gap", "ang"},
    3: {"minln", "ang"},
}

MODE_NAME = ("canny", "morph", "sobel", "lsd")


def draw_legend(panel, p):
    mode = p["mode"]
    rows = [("red=horiz  green=vert", True), ("", True),
            (f"mode  {MODE_NAME[mode]}", True)]
    for kn in ALL_KNOBS:
        active = kn in ACTIVE[mode]
        val = p[PARAM[kn]] if active else "-"            # '-' when not in use
        desc = DESC[mode][kn]
        rows.append((f"{kn:5} {desc:13} = {val}", active))
    y = 22
    for text, active in rows:
        if text:
            fg = (255, 255, 255) if active else (120, 120, 120)
            cv2.putText(panel, text, (8, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5,
                        (0, 0, 0), 3, cv2.LINE_AA)          # outline for contrast
            cv2.putText(panel, text, (8, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5,
                        fg, 1, cv2.LINE_AA)
        y += 20
    return panel


def letterbox(panel, w, h):
    """Scale panel to fit a w x h window, padding with black (no distortion)."""
    ph, pw = panel.shape[:2]
    scale = min(w / pw, h / ph)
    nw, nh = max(1, int(pw * scale)), max(1, int(ph * scale))
    resized = cv2.resize(panel, (nw, nh), interpolation=cv2.INTER_AREA)
    canvas = np.zeros((h, w, 3), np.uint8)
    y0, x0 = (h - nh) // 2, (w - nw) // 2
    canvas[y0:y0 + nh, x0:x0 + nw] = resized
    return canvas


def render(img, p):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    detector = (detect_canny, detect_morph, detect_sobel, detect_lsd)[p["mode"]]
    h_lines, v_lines, _ = detector(gray, p)

    middle = np.zeros_like(img)
    combined = img.copy()
    for (x1, y1, x2, y2) in h_lines:
        cv2.line(middle, (x1, y1), (x2, y2), H_COLOR, 1)
        cv2.line(combined, (x1, y1), (x2, y2), H_COLOR, 1)
    for (x1, y1, x2, y2) in v_lines:
        cv2.line(middle, (x1, y1), (x2, y2), V_COLOR, 1)
        cv2.line(combined, (x1, y1), (x2, y2), V_COLOR, 1)

    mname = ("canny", "morph", "sobel", "lsd")[p["mode"]]
    label = f"mode={mname}  H={len(h_lines)}  V={len(v_lines)}"
    cv2.putText(combined, label, (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                (255, 255, 255), 2, cv2.LINE_AA)

    draw_legend(middle, p)
    panel = np.hstack([middle, combined])
    if panel.shape[1] > MAX_W:
        scale = MAX_W / panel.shape[1]
        panel = cv2.resize(panel, None, fx=scale, fy=scale,
                           interpolation=cv2.INTER_AREA)
    return panel


def main():
    global MAX_W
    argv = sys.argv[1:]
    if "--width" in argv:
        i = argv.index("--width")
        MAX_W = int(argv[i + 1])
        del argv[i:i + 2]
    path = argv[0] if argv else newest_capture()
    img = cv2.imread(path)
    if img is None:
        raise SystemExit(f"could not read image: {path}")
    print(f"image: {path}  ({img.shape[1]}x{img.shape[0]})")

    cv2.namedWindow(WIN, cv2.WINDOW_NORMAL)
    # (name, default, max)
    knobs = [
        ("mode", 0, 3),
        ("lo", 50, 255),
        ("hi", 150, 500),
        ("thr", 80, 400),
        ("minln", 60, 600),
        ("gap", 8, 100),
        ("ang", 5, 45),
    ]
    maxes = {name: mx for name, _d, mx in knobs}
    for name, default, mx in knobs:
        cv2.createTrackbar(name, WIN, default, mx, lambda _v: None)

    def set_enabled(mode):
        """Pin (freeze) sliders unused by this mode, restore the rest."""
        for kn in ALL_KNOBS:
            pos = cv2.getTrackbarPos(kn, WIN)
            if kn in ACTIVE[mode]:                 # enable -> full range
                cv2.setTrackbarMax(kn, WIN, maxes[kn])
                cv2.setTrackbarMin(kn, WIN, 0)
            else:                                  # disable -> pin at current pos
                cv2.setTrackbarMax(kn, WIN, pos)
                cv2.setTrackbarMin(kn, WIN, pos)

    last = None
    last_rect = None
    last_mode = -1
    panel = None
    while True:
        mode = cv2.getTrackbarPos("mode", WIN)
        if mode != last_mode:
            set_enabled(mode)
            last_mode = mode
        p = {
            "mode": mode,
            "canny_lo": cv2.getTrackbarPos("lo", WIN),
            "canny_hi": cv2.getTrackbarPos("hi", WIN),
            "threshold": cv2.getTrackbarPos("thr", WIN),
            "min_len": cv2.getTrackbarPos("minln", WIN),
            "max_gap": cv2.getTrackbarPos("gap", WIN),
            "angle_tol": cv2.getTrackbarPos("ang", WIN),
        }
        key = tuple(p.values())
        rect = cv2.getWindowImageRect(WIN)          # (x, y, w, h) of image area
        changed = key != last
        if changed:
            panel = render(img, p)
            last = key
        if panel is not None and (changed or rect != last_rect):
            disp = panel
            if rect and rect[2] > 0 and rect[3] > 0:
                disp = letterbox(panel, rect[2], rect[3])
            cv2.imshow(WIN, disp)
            last_rect = rect

        k = cv2.waitKey(30) & 0xFF
        if k in (ord("q"), 27):  # q or Esc
            break
        if cv2.getWindowProperty(WIN, cv2.WND_PROP_VISIBLE) < 1:
            break
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
