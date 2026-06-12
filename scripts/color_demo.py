"""Interactive color-flattening demo.

Loads an equipment capture and flattens / compacts its colors. Shows two panels
side by side:

    [ flattened result ] [ original ]

Tuning knobs are exposed as OpenCV trackbars and the panels redraw whenever any
of them changes. Sliders not used by the current mode are pinned (frozen) and
dimmed in the on-image legend. Four flattening modes:

    mode 0 = kmeans     (cluster pixels into k colors)
    mode 1 = posterize  (quantize each channel to N levels)
    mode 2 = meanshift  (pyrMeanShiftFiltering: edge-aware color smoothing)
    mode 3 = bilateral  (bilateral filter: smooth color, keep edges)

Run:
    python scripts/color_demo.py [path/to/image.jpg] [--width N]

with no image argument it grabs the newest capture under captures/warframe/.
Keys: q or Esc to quit.
"""

from __future__ import annotations

import glob
import os
import sys

import cv2
import numpy as np

WIN = "color demo  (q=quit)"
MAX_W = 2700             # cap full 2-panel width (override: --width N)
PROC_W = 900            # downscale working image to this width for responsiveness


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


def flatten_kmeans(img, p):
    """Cluster pixels into k colors and repaint each pixel as its centroid."""
    k = max(2, p["k"])
    z = img.reshape(-1, 3).astype(np.float32)
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 10, 1.0)
    _, labels, centers = cv2.kmeans(z, k, None, crit, 1, cv2.KMEANS_PP_CENTERS)
    out = centers[labels.flatten()].astype(np.uint8)
    return out.reshape(img.shape)


def flatten_posterize(img, p):
    """Quantize each channel to N evenly-spaced levels."""
    n = max(2, p["lvls"])
    step = 255.0 / (n - 1)
    return (np.round(img / step) * step).clip(0, 255).astype(np.uint8)


def flatten_meanshift(img, p):
    """Edge-aware color smoothing via the mean-shift pyramid filter."""
    sp = max(1, p["sp"])
    sr = max(1, p["sr"])
    return cv2.pyrMeanShiftFiltering(img, sp, sr)


def flatten_bilateral(img, p):
    """Smooth color while preserving edges with a bilateral filter."""
    d = max(1, p["d"])
    sig = max(1, p["sig"])
    return cv2.bilateralFilter(img, d, sig, sig)


# short slider name -> param key in the p dict (same name here)
ALL_KNOBS = ["k", "lvls", "sp", "sr", "d", "sig"]
PARAM = {kn: kn for kn in ALL_KNOBS}

# per-mode short description of each knob (shown in the legend)
DESC = {
    0: {"k": "num colors", "lvls": "", "sp": "", "sr": "", "d": "", "sig": ""},
    1: {"k": "", "lvls": "levels/chan", "sp": "", "sr": "", "d": "", "sig": ""},
    2: {"k": "", "lvls": "", "sp": "spatial rad", "sr": "color rad",
        "d": "", "sig": ""},
    3: {"k": "", "lvls": "", "sp": "", "sr": "", "d": "diameter",
        "sig": "sigma col/sp"},
}

# which sliders are live per mode (everything else is pinned + dimmed)
ACTIVE = {
    0: {"k"},
    1: {"lvls"},
    2: {"sp", "sr"},
    3: {"d", "sig"},
}

MODE_NAME = ("kmeans", "posterize", "meanshift", "bilateral")


def draw_legend(panel, p, ncolors):
    mode = p["mode"]
    rows = [(f"flatten  colors={ncolors}", True), ("", True),
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
    flatten = (flatten_kmeans, flatten_posterize,
               flatten_meanshift, flatten_bilateral)[p["mode"]]
    flat = flatten(img, p)
    ncolors = len(np.unique(flat.reshape(-1, 3), axis=0))

    draw_legend(flat, p, ncolors)
    panel = np.hstack([flat, img])
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
    if img.shape[1] > PROC_W:                       # downscale for responsiveness
        s = PROC_W / img.shape[1]
        img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    print(f"image: {path}  (working {img.shape[1]}x{img.shape[0]})")

    cv2.namedWindow(WIN, cv2.WINDOW_NORMAL)
    # (name, default, max)
    knobs = [
        ("mode", 0, 3),
        ("k", 8, 64),
        ("lvls", 4, 32),
        ("sp", 10, 40),
        ("sr", 25, 80),
        ("d", 9, 25),
        ("sig", 75, 200),
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
            "k": cv2.getTrackbarPos("k", WIN),
            "lvls": cv2.getTrackbarPos("lvls", WIN),
            "sp": cv2.getTrackbarPos("sp", WIN),
            "sr": cv2.getTrackbarPos("sr", WIN),
            "d": cv2.getTrackbarPos("d", WIN),
            "sig": cv2.getTrackbarPos("sig", WIN),
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
