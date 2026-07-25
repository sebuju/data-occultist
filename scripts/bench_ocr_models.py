"""Compare OCR recogniser models on bound captures — accuracy first.

Offline (no live game): loads a window's bound frames from ``captures/<game>/_bindings.json``
and re-reads them under several ``ppocr5`` model configurations, holding EVERYTHING else
fixed (same frames, same authored preprocess, same dictionaries/resolver/templates). Only
the model changes, so a difference in the table is the model's doing.

    python scripts/bench_ocr_models.py relic_rewards
    python scripts/bench_ocr_models.py relic_rewards --shape '^(Lith|Meso|Neo|Axi) [A-Z]\\d+ Relic$'
    python scripts/bench_ocr_models.py relic_rewards --dump          # side-by-side, flag DIFFs
    python scripts/bench_ocr_models.py relic_rewards --only base,v5-en
    python scripts/bench_ocr_models.py --list

Why these variants: the shipped default is a MULTILINGUAL model (``multi_PP-OCRv6_rec_small``)
whose decode space spans thousands of classes, while the text being read is English game UI.
Two independent axes can help, and they pull in opposite directions on cost:
  - BIGGER  (``v6-med-*``): more capable backbone, same huge vocabulary.
  - NARROWER (``v5-en`` / ``v5-latin``): a recogniser that CANNOT emit CJK cannot confuse a
    Latin glyph for one — but rides an older, smaller v5 backbone.
Which wins is empirical, hence this bench.

Detection is left alone by default: it only finds boxes, and box-finding is not the
failure mode being chased. ``v6-med-both`` is the one variant that also moves the detector.

Overrides use DOTTED keys (``Rec.model_type``) rather than the flat aliases, because a flat
``model_type`` fans out to Det AND Rec (see ``_FLAT`` in ``oc/ocr/rapidocr3_map.py``) — which
would silently drag detection along with the recogniser.

Metrics (higher = better, except ``diff`` and ``ms``):
  cells   readable value cells found across all frames
  conf    mean recognition confidence of those reads
  floor%  share of reads at/above tuning.min_confidence
  shape%  share matching --shape (a correctness proxy needing no labelled truth)
  acc%    exact-value accuracy vs --truth
  diff    cells whose value differs from the baseline variant (churn, not error)
  ms      mean OCR compute per frame (excludes model build and lock wait)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

# benchlib puts src/ on sys.path — keep it above every oc.* import
from benchlib import (  # noqa: E402
    build_reader,
    correction_rate,
    load_frames,
    name_field,
    reads_for,
)

from oc.engine import Engine                    # noqa: E402
from oc.learn.dictionary import _norm            # noqa: E402
from oc.ocr.serialize import ocr_job            # noqa: E402
from oc.registry import build_ocr               # noqa: E402
from oc.runtime import load_live_profile        # noqa: E402


# label -> dotted-key overrides merged onto settings.yaml's ocr.options. The first entry
# is the baseline every other variant is diffed against. An empty dict = ship as-configured.
#
# v6 has NO per-language models (only multi_PP-OCRv6_rec_{tiny,small,medium}), so a
# Latin-only recogniser must come from v5, which offers en_/latin_ in `mobile` size only.
# Mixing a v6 detector with a v5 recogniser is untested upstream — if it fails to build,
# the variant reports FAILED rather than taking the whole run down.
VARIANTS: dict[str, dict] = {
    "base":        {},
    "v6-med-rec":  {"Rec.model_type": "medium"},
    "v6-med-both": {"Rec.model_type": "medium", "Det.model_type": "medium"},
    "v5-en":       {"Rec.ocr_version": "PP-OCRv5", "Rec.lang_type": "en",
                    "Rec.model_type": "mobile"},
    "v5-latin":    {"Rec.ocr_version": "PP-OCRv5", "Rec.lang_type": "latin",
                    "Rec.model_type": "mobile"},
    "v5-server":   {"Rec.ocr_version": "PP-OCRv5", "Rec.lang_type": "ch",
                    "Rec.model_type": "server"},
}


def run_variant(engine, profile, game, window, fields, fid, frames, overrides, key="value"):
    """Read every frame under one model config. Returns ``(per_frame_texts, confs, ms, corr)``.

    ``key`` selects raw-vs-resolved text (see ``benchlib.reads_for``). ``corr`` is
    ``(corrected, total)`` for the RESOLVED path, so the table can say how much of the
    result is the dictionary's doing rather than the recogniser's.

    The OCR engine is built and warmed BEFORE timing starts (models download/load lazily on
    first use, and that one-time cost would otherwise land in the first frame's number), and
    released after so the next variant doesn't share the accelerator with this one.
    """
    options = {**engine.settings.ocr.options, **overrides}
    ocr = build_ocr(engine.settings.ocr.name, **options)
    try:
        ocr.prepare()
        reader = build_reader(engine, profile, game, window, ocr=ocr)
        per_frame, confs, elapsed = [], [], []
        corrected = total = 0
        for _cap, frame in frames:
            t0 = time.perf_counter()
            with ocr_job(ocr):
                reads = reads_for(reader, frame, window, fields, fid, key=key)
            elapsed.append((time.perf_counter() - t0) * 1000.0)
            per_frame.append([v for v, _ in reads])
            confs.extend(c for _, c in reads)
            with ocr_job(ocr):
                c, t = correction_rate(reader, frame, window, fields, fid)
            corrected += c
            total += t
        ms = sum(elapsed) / len(elapsed) if elapsed else 0.0
        return per_frame, confs, ms, (corrected, total)
    finally:
        release = getattr(ocr, "release", None)
        if callable(release):
            release()


def diff_count(per_frame, base_per_frame) -> int:
    """Cells whose value differs from the baseline, aligned by (frame, cell index).

    A position present in one run and absent in the other counts as a difference — a
    variant that stops reading a cell at all has changed the result just as much as one
    that reads it differently.
    """
    n = 0
    for got, want in zip(per_frame, base_per_frame):
        for i in range(max(len(got), len(want))):
            a = got[i] if i < len(got) else None
            b = want[i] if i < len(want) else None
            n += a != b
    return n


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("window", nargs="?")
    ap.add_argument("--game", default="warframe")
    ap.add_argument("--field", default=None, help="field id to score (default: primary text field)")
    ap.add_argument("--truth", default=None, help='{"<capture>": ["Expected", ...]} for acc%%')
    ap.add_argument("--shape", default=None,
                    help="regex a correct read must match (correctness proxy, no truth needed). "
                         r"relic codes: '^(Lith|Meso|Neo|Axi) [A-Z]\d+ Relic$'")
    ap.add_argument("--raw", action="store_true",
                    help="compare the RAW OCR text instead of the resolved value. Use this to "
                         "judge a recogniser: dictionary correction can snap two different "
                         "misreads to the same name and hide a real model difference")
    ap.add_argument("--only", default=None, help="comma list of variant labels to run")
    ap.add_argument("--dump", action="store_true",
                    help="per frame, lay every variant's reads side by side and flag DIFFs")
    ap.add_argument("--list", action="store_true", help="print the variant table and exit")
    args = ap.parse_args()

    if args.list:
        print()
        for label, ov in VARIANTS.items():
            desc = ", ".join(f"{k}={v}" for k, v in ov.items()) or "as configured in settings.yaml"
            print(f"  {label:<14}{desc}")
        print()
        return
    if not args.window:
        ap.error("window is required (or pass --list)")

    labels = [s.strip() for s in args.only.split(",")] if args.only else list(VARIANTS)
    unknown = [x for x in labels if x not in VARIANTS]
    if unknown:
        sys.exit(f"unknown variant(s) {unknown}; known: {sorted(VARIANTS)}")

    engine = Engine.build()
    profile = load_live_profile(engine.settings.profiles_dir, args.game)
    window = next((w for w in profile.windows if w.id == args.window), None)
    if window is None:
        sys.exit(f"no window {args.window!r} in {args.game}")
    fields = {f.id: f for f in profile.fields_for(window)}
    fid = args.field or name_field(window)
    if fid not in fields:
        sys.exit(f"no field {fid!r} in {args.window!r}; have {sorted(fields)}")
    floor = engine.settings.tuning.min_confidence

    frames = load_frames(engine, args.game, args.window)
    if not frames:
        sys.exit(f"no bound captures for {args.window!r}")

    truth = {}
    if args.truth:
        truth = {k: {_norm(n) for n in v}
                 for k, v in json.loads(Path(args.truth).read_text()).items()}
    shape = re.compile(args.shape) if args.shape else None

    print(f"\n{args.window}: {len(frames)} frames, field {fid!r}, floor {floor}")
    # `device` is the CUDA cpu/gpu flag only — DirectML runs WHILE it reads "cpu" (see
    # Rapid3OcrEngine.dml_active), so report the EP explicitly or the header lies about
    # which processor the numbers below were measured on.
    dev = getattr(engine.ocr, "device", "?")
    if getattr(engine.ocr, "dml_requested", False):
        dev = "directml (iGPU)"
    elif getattr(engine.ocr, "gpu_active", False) or dev == "gpu":
        dev = "cuda"
    print(f"device: {dev}  |  engine: {getattr(engine.ocr, 'engine_type', '?')}"
          f"  |  baseline: {labels[0]}\n")

    key = "raw" if args.raw else "value"
    print(f"comparing: {key} text"
          + ("" if args.raw else "  (dictionary correction applied — pass --raw to judge the "
                                "recogniser itself)"))

    results, failures = {}, {}
    for label in labels:
        try:
            results[label] = run_variant(engine, profile, args.game, window, fields, fid,
                                         frames, VARIANTS[label], key=key)
        except Exception as exc:   # noqa: BLE001 - a variant that won't build must not kill the run
            failures[label] = f"{type(exc).__name__}: {exc}"
            print(f"  {label}: FAILED — {failures[label]}")

    if not results:
        sys.exit("every variant failed to build")
    base_label = next(iter(results))
    base_per_frame = results[base_label][0]

    # `diff` is the column that matters. `conf` is reported but must NOT be ranked on:
    # this recogniser routinely returns near-perfect confidence for wrong text, so a
    # confidence delta with identical text says nothing about accuracy.
    print(f"\n{'variant':<14}{'cells':>7}{'conf':>8}{'floor%':>8}{'shape%':>8}{'acc%':>7}"
          f"{'corr%':>7}{'diff':>7}{'ms':>9}")
    print("-" * 75)
    for label, (per_frame, confs, ms, (corr_n, corr_t)) in results.items():
        n = len(confs)
        values = [v for row in per_frame for v in row]
        mean = sum(confs) / n if n else 0.0
        floorp = 100 * sum(1 for c in confs if c >= floor) / n if n else 0.0
        shape_s = f"{100 * sum(1 for v in values if shape.match(v)) / n:6.0f}%" if (shape and n) else "      -"
        if truth:
            matched = sum(len(truth.get(cap, set()) & {_norm(v) for v in row})
                          for (cap, _f), row in zip(frames, per_frame))
            want_total = sum(len(truth.get(cap, set())) for cap, _f in frames)
            acc_s = f"{100 * matched / want_total:6.0f}" if want_total else "     -"
        else:
            acc_s = "     -"
        diff = "-" if label == base_label else str(diff_count(per_frame, base_per_frame))
        corr_s = f"{100 * corr_n / corr_t:6.0f}" if corr_t else "     -"
        print(f"{label:<14}{n:>7}{mean:>8.3f}{floorp:>7.0f}%{shape_s:>8}{acc_s:>7}"
              f"{corr_s:>7}{diff:>7}{ms:>8.0f}ms")
    print()
    base_corr_n, base_corr_t = results[base_label][3]
    if base_corr_t:
        print(f"dictionary rewrote {base_corr_n}/{base_corr_t} of the baseline's raw reads"
              f" ({100 * base_corr_n / base_corr_t:.0f}%)"
              + ("" if args.raw else " — that much of the 'value' comparison is correction, "
                                     "not recognition"))
    print()

    if args.dump:
        # Where variants disagree is where the glyphs are fragile — the rows worth eyeballing
        # against the actual capture before trusting any aggregate number above.
        disagreements = 0
        for i, (cap, _frame) in enumerate(frames):
            rows = {label: res[0][i] for label, res in results.items()}
            width = max((len(r) for r in rows.values()), default=0)
            print(f"\n{cap}")
            for j in range(width):
                cells = {m: (v[j] if j < len(v) else "-") for m, v in rows.items()}
                dis = len({c for c in cells.values() if c != "-"}) > 1
                disagreements += dis
                print("   " + " | ".join(f"{m}:{cells[m]}" for m in cells)
                      + ("  <-- DIFF" if dis else ""))
        print(f"\n{disagreements} cell(s) where variants disagree\n")

    if failures:
        print("failed variants:")
        for label, why in failures.items():
            print(f"  {label}: {why}")
        print()


if __name__ == "__main__":
    main()
