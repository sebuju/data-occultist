"""`data-rig bench <game>` — pure-capture benchmark.

Hammers ``grab_window`` as fast as it can for a few seconds and reports the rate.
No OCR, no classify, no save — this measures the *capture* path alone, which is
the only thing that touches the game per frame.

Two numbers matter and they differ by backend:

* **grabs/s** — how often ``grab_window`` returns. For ``printwindow`` every grab
  forces a fresh render (so this is also the game-stutter rate). For ``wgc`` a
  grab just returns the latest cached frame, so this can run far above the real
  capture rate.
* **frames/s** — distinct frames actually produced. For ``wgc`` this is the WGC
  delivery rate (capped at the monitor refresh; a static screen delivers ~none).
  For backends with no frame counter it equals grabs/s.

``--capture`` overrides the configured backend so you can A/B (e.g.
``bench warframe --capture wgc`` vs ``--capture printwindow``) without editing
settings.yaml.
"""

from __future__ import annotations

import time

from ..engine import Engine
from ..locate import locate_window
from ..profile import load_profile
from ..registry import build_capture


def register(sub) -> None:
    p = sub.add_parser("bench", help="benchmark raw capture throughput (no OCR)")
    p.add_argument("game", help="profile name")
    p.add_argument("--seconds", type=float, default=5.0, help="benchmark duration")
    p.add_argument("--capture", default=None,
                   help="override capture backend (e.g. wgc, printwindow) for this run")
    p.add_argument("--warmup", type=float, default=1.0,
                   help="seconds to prime the backend before timing (WGC needs a first frame)")
    p.set_defaults(func=run)


def run(args) -> int:
    engine = Engine.build()
    profile = load_profile(engine.settings.profiles_dir, args.game)
    win = locate_window(engine, profile)
    if win is None:
        print(f"Window for {args.game!r} not found (is the game running?)")
        return 1

    capture = build_capture(args.capture) if args.capture else engine.capture
    name = args.capture or engine.settings.capture.name
    seq_of = getattr(type(capture), "frame_seq", None)   # property? -> real-frame counter

    # Warmup: WGC's session must deliver at least one frame before timing means
    # anything; also lets any JIT / first-call allocation settle for either backend.
    warm_end = time.perf_counter() + args.warmup
    while time.perf_counter() < warm_end:
        capture.grab_window(win)

    grabs = 0
    seq_start = capture.frame_seq if seq_of is not None else 0
    last_shape = None
    t0 = time.perf_counter()
    end = t0 + args.seconds
    while time.perf_counter() < end:
        frame = capture.grab_window(win)
        grabs += 1
        if frame.image.size > 3:
            last_shape = frame.image.shape
    elapsed = time.perf_counter() - t0

    grabs_per_s = grabs / elapsed if elapsed else 0.0
    res = f"{last_shape[1]}x{last_shape[0]}" if last_shape else "?"
    print(f"backend={name}  window={win.client.w}x{win.client.h}  captured={res}")
    print(f"grabs/s = {grabs_per_s:8.1f}   ({grabs} grabs in {elapsed:.2f}s, "
          f"{1000 * elapsed / grabs:.2f} ms/grab)")
    if seq_of is not None:
        frames = capture.frame_seq - seq_start
        print(f"frames/s = {frames / elapsed if elapsed else 0:7.1f}   "
              f"({frames} distinct WGC frames — capped at the monitor refresh; "
              f"~0 means the screen was static)")
    else:
        print("frames/s =  (= grabs/s; this backend produces a fresh frame per grab)")

    if hasattr(capture, "close"):
        capture.close()
    return 0
