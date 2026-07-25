"""Quantify how each preprocess mode affects OCR recognition on bound captures.

Offline (no live game): loads a window's bound frames from ``captures/<game>/_bindings.json``,
re-runs the reader under each ``PreprocessMode`` (x optional scales), and prints a ranked
table of recognition quality so you can SEE which mode helps before authoring it.

    python scripts/bench_preprocess.py relic_rewards
    python scripts/bench_preprocess.py relic_rewards --colors "#ffffff,#e8c56a" --scale 1,2
    python scripts/bench_preprocess.py relic_rewards --truth truth.json   # exact-match accuracy

``truth.json`` (optional): {"<capture-filename>": ["Expected Name", ...], ...}.

Metric per mode (higher = better, except distinct):
  cells   readable name cells found across all frames
  conf    mean recognition confidence of those reads
  floor%  share of reads at/above tuning.min_confidence
  acc%    exact-name accuracy vs truth (only with --truth)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# benchlib puts src/ on sys.path — keep it above every oc.* import
from benchlib import build_reader, load_frames, name_field, reads_for  # noqa: E402

from oc.engine import Engine                         # noqa: E402
from oc.learn.dictionary import _norm                 # noqa: E402
from oc.ocr.serialize import ocr_job                 # noqa: E402
from oc.runtime import load_live_profile             # noqa: E402
from oc.profile.models import Preprocess, PreprocessMode  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("window")
    ap.add_argument("--game", default="warframe")
    ap.add_argument("--colors", default="#ffffff,#e8c56a", help="hex text colours for color mode")
    ap.add_argument("--tol", type=int, default=60)
    ap.add_argument("--scale", default="1", help="comma list of upscale factors to try")
    ap.add_argument("--truth", default=None)
    ap.add_argument("--shape", default=None,
                    help="regex a correct read must match (auto correctness proxy). "
                         r"relic codes: '^(Lith|Meso|Neo|Axi) [A-Z]\d+ Relic$'")
    ap.add_argument("--dump", action="store_true",
                    help="print per-frame reads across modes and flag where modes disagree")
    args = ap.parse_args()

    engine = Engine.build()
    profile = load_live_profile(engine.settings.profiles_dir, args.game)
    window = next((w for w in profile.windows if w.id == args.window), None)
    if window is None:
        sys.exit(f"no window {args.window!r} in {args.game}")
    fields = {f.id: f for f in profile.fields_for(window)}
    name_fid = name_field(window)
    floor = engine.settings.tuning.min_confidence

    frames = load_frames(engine, args.game, args.window)
    if not frames:
        sys.exit(f"no bound captures for {args.window!r}")

    truth = {}
    if args.truth:
        truth = {k: {_norm(n) for n in v} for k, v in json.loads(Path(args.truth).read_text()).items()}

    colors = [c.strip() for c in args.colors.split(",") if c.strip()]
    scales = [float(s) for s in args.scale.split(",")]
    plans = []
    for scale in scales:
        plans.append((f"none@{scale:g}", Preprocess(mode=PreprocessMode.none, scale=scale)))
        plans.append((f"threshold@{scale:g}", Preprocess(mode=PreprocessMode.threshold, scale=scale)))
        plans.append((f"color@{scale:g}", Preprocess(mode=PreprocessMode.color, colors=colors, tolerance=args.tol, scale=scale)))
        plans.append((f"invert@{scale:g}", Preprocess(mode=PreprocessMode.invert, scale=scale)))

    reader = build_reader(engine, profile, args.game, window)

    if args.dump:
        # Per frame, read every mode and lay the values side by side, sorted by cell
        # position so the same relic lines up. Rows where modes disagree = fragile glyphs.
        modes = [("none", Preprocess(mode=PreprocessMode.none)),
                 ("otsu", Preprocess(mode=PreprocessMode.threshold)),
                 ("color", Preprocess(mode=PreprocessMode.color, colors=colors, tolerance=args.tol)),
                 ("invert", Preprocess(mode=PreprocessMode.invert))]
        disagreements = 0
        for cap, frame in frames:
            per_mode = {}
            for mlabel, pp in modes:
                window.preprocess = pp
                with ocr_job(engine.ocr):
                    per_mode[mlabel] = [v for v, _ in reads_for(reader, frame, window, fields, name_fid)]
            n = max(len(v) for v in per_mode.values())
            print(f"\n{cap}")
            for i in range(n):
                cells = {m: (v[i] if i < len(v) else "-") for m, v in per_mode.items()}
                dis = len({c for c in cells.values() if c != "-"}) > 1
                flag = "  <-- DIFF" if dis else ""
                disagreements += dis
                print("   " + " | ".join(f"{m}:{cells[m]}" for m in per_mode) + flag)
        print(f"\n{disagreements} cell(s) where modes disagree\n")
        return

    shape = re.compile(args.shape) if args.shape else None

    print(f"\n{args.window}: {len(frames)} frames, name field {name_fid!r}, floor {floor}\n")
    print(f"{'mode':<16}{'cells':>7}{'conf':>8}{'floor%':>8}{'shape%':>8}{'acc%':>7}")
    print("-" * 54)
    for label, pp in plans:
        window.preprocess = pp
        confs, matched, expected_total, shaped = [], 0, 0, 0
        with ocr_job(engine.ocr):
            for cap, frame in frames:
                reads = reads_for(reader, frame, window, fields, name_fid)
                confs.extend(c for _, c in reads)
                if shape:
                    shaped += sum(1 for v, _ in reads if shape.match(v))
                if truth:
                    want = truth.get(cap, set())
                    got = {_norm(v) for v, _ in reads}
                    matched += len(want & got)
                    expected_total += len(want)
        n = len(confs)
        mean = sum(confs) / n if n else 0.0
        floorp = 100 * sum(1 for c in confs if c >= floor) / n if n else 0.0
        shapep = 100 * shaped / n if (shape and n) else float("nan")
        acc = 100 * matched / expected_total if expected_total else float("nan")
        shape_s = f"{shapep:6.0f}%" if shape else "      -"
        acc_s = f"{acc:6.0f}" if expected_total else "     -"
        print(f"{label:<16}{n:>7}{mean:>8.3f}{floorp:>7.0f}%{shape_s:>8}{acc_s:>7}")
    print()


if __name__ == "__main__":
    main()
