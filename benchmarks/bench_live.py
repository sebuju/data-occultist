"""Micro-benchmarks for the live-collection hot path (the per-tick chain).

Standalone, no extra deps: stdlib ``time.perf_counter`` loops over synthetic
fixtures (a 4K frame + a stubbed OCR engine), so the PURE-LOGIC stages of a
collector tick can be measured WITHOUT a running game or a GPU. The two stages
that genuinely need hardware -- window capture and OCR inference -- are not here:
their real cost is recorded live by ``oc.store.stats_store`` ("oc"/"tk" and the
new per-stage codes st/cl/sg/cf/cm) during an actual session, and an approximate
OCR baseline is available via ``--real-ocr`` (runs the real CPU engine on a
synthetic text crop).

Run:
    python benchmarks/bench_live.py                # pure-logic stages
    python benchmarks/bench_live.py --reps 4000    # more iterations
    python benchmarks/bench_live.py --real-ocr     # also time the real OCR engine (CPU)
    python benchmarks/bench_live.py --md baseline.md   # write a markdown table

The numbers are a BEFORE baseline: nothing here is optimized yet (see PLAN.md).
"""

from __future__ import annotations

import argparse
import statistics
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

import numpy as np

# run from a source checkout without an editable install
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from oc.collect import settle  # noqa: E402
from oc.collect.grid import expand_cells  # noqa: E402
from oc.collect.items import _clusters, locate_item_cells, resolve_overlaps  # noqa: E402
from oc.collect.reader import RegionReader  # noqa: E402
from oc.collect.scrollbar import scroll_detail  # noqa: E402
from oc.collect.stability import Confirmer, _signature  # noqa: E402
from oc.detect.classifier import DetectClassifier  # noqa: E402
from oc.detect.matcher import _norm, text_match_score  # noqa: E402
from oc.interfaces import OcrEngine  # noqa: E402
from oc.learn.lexicon import Lexicon  # noqa: E402
from oc.learn.rapidfuzz_corrector import RapidFuzzCorrector  # noqa: E402
from oc.learn.resolver import FieldResolver  # noqa: E402
from oc.profile.models import (  # noqa: E402
    Box, DetectDef, FieldDef, FieldType, GameProfile, ItemDef, RegionDef, ScrollDef,
    Tell, TellKind, WindowDef,
)
from oc.types import Frame, OcrLine, PixelBox  # noqa: E402

W, H = 3840, 2160          # a 4K client area (the worst-case the project targets)
ROWS, COLS = 8, 3          # a 24-cell grid (equipment-window scale)


# --------------------------------------------------------------------------- timing

def bench(name: str, fn, reps: int, warm: int = 50) -> dict:
    """Time ``fn`` ``reps`` times after ``warm`` warm-up calls. Returns ms stats."""
    for _ in range(warm):
        fn()
    samples = []
    for _ in range(reps):
        t0 = time.perf_counter()
        fn()
        samples.append((time.perf_counter() - t0) * 1000.0)
    samples.sort()
    return {
        "name": name,
        "median": statistics.median(samples),
        "min": samples[0],
        "p95": samples[min(len(samples) - 1, int(len(samples) * 0.95))],
    }


# --------------------------------------------------------------------------- fixtures

class StubOcr(OcrEngine):
    """Returns a fixed set of lines (no real inference). ``read_line``/``read_lines`` inherit
    the base (loop -> read_image -> join), so a single-line stub reads back its one line —
    which is what the classifier's prewarm batch needs."""

    def __init__(self, lines):
        self._lines = lines

    def read_image(self, image):
        return list(self._lines)


_NAMES = [
    "Soma Prime", "Braton Prime", "Boltor Prime", "Akbronco Prime", "Vasto Prime",
    "Rubico Prime", "Nikana Prime", "Galatine Prime", "Scindo Prime", "Fragor Prime",
    "Empowered Cascadia", "Arcane Energize", "Arcane Grace", "Arcane Aegis", "Madurai",
    "Vazarin", "Naramon", "Zenurik", "Unairu", "Lavos", "Protea", "Wisp", "Gauss", "Xaku",
]


def _frame():
    return Frame(image=np.zeros((H, W, 3), np.uint8), client=PixelBox(0, 0, W, H))


def _grid_window():
    return WindowDef(
        id="equipment",
        dataset="equipment",
        data_area=Box(x=0.05, y=0.1, w=0.9, h=0.8),
        fields=[
            FieldDef(id="name", type=FieldType.text, learn=True, fuzzy=0.8),
            FieldDef(id="count", type=FieldType.number, empty="1", if_text_any=True),
        ],
        regions=[
            RegionDef(id="name", box=Box(x=0.05, y=0.1, w=0.2, h=0.04), field="name"),
            RegionDef(id="count", box=Box(x=0.26, y=0.1, w=0.04, h=0.04), field="count"),
        ],
        scroll=ScrollDef(rows=ROWS, cols=COLS, row_stride=0.09, col_stride=0.3,
                         scrollbar=Box(x=0.97, y=0.1, w=0.01, h=0.8)),
    )


def _grid_lines(window):
    """One OCR line over every field box of every cell -> exercises _gather's per-box
    scan against a realistic line count (ROWS*COLS*fields)."""
    lines = []
    for i, cell in enumerate(expand_cells(window)):
        nm = _NAMES[i % len(_NAMES)]
        for fid, fb in cell.boxes.items():
            pb = fb.to_pixels(W, H)
            text = nm if fid == "name" else "12"
            lines.append(OcrLine(text, PixelBox(pb.x + 4, pb.y + 4, pb.w - 8, pb.h - 8), 0.93))
    return lines


def _item_window():
    """A located-item window (no static grid): name field locates rows by content."""
    return WindowDef(
        id="arcanes",
        dataset="arcanes",
        data_area=Box(x=0.05, y=0.1, w=0.9, h=0.8),
        fields=[FieldDef(id="name", type=FieldType.text, locate=True),
                FieldDef(id="rank", type=FieldType.number)],
        items=[ItemDef(
            id="arcane", box=Box(x=0.0, y=0.0, w=0.3, h=0.11),
            fields=[RegionDef(id="name", box=Box(x=0.0, y=0.0, w=0.7, h=0.4), field="name"),
                    RegionDef(id="rank", box=Box(x=0.7, y=0.0, w=0.3, h=0.4), field="rank")],
            tells=[Tell(id="t", kind=TellKind.text, text="", field="name",
                        box=Box(x=0.0, y=0.0, w=0.7, h=0.4))],
        )],
    )


def _item_lines_frac():
    """(cx, cy, h, text, conf, lx, lw) per name, in window fractions -- the input
    locate_item_cells clusters into rows/cols."""
    da_x, da_y = 0.05, 0.1
    out = []
    for ri in range(ROWS):
        for ci in range(COLS):
            cx = da_x + 0.05 + ci * 0.3
            cy = da_y + 0.04 + ri * 0.095
            nm = _NAMES[(ri * COLS + ci) % len(_NAMES)]
            out.append((cx, cy, 0.02, nm, 0.93, cx - 0.05, 0.14))
    return out


def _classify_profile():
    """Three windows, each recognised by a text detector -- exercises the classifier's
    per-window match + best-fit score (the double-score path)."""
    wins = []
    for name in ("equipment", "arcanes", "mods"):
        wins.append(WindowDef(
            id=name, dataset=name,
            detect=[DetectDef(id=f"{name}_title", text=name.upper(),
                              search=Box(x=0.4, y=0.0, w=0.2, h=0.05), threshold=0.8)],
        ))
    return GameProfile(name="bench", process_names=["x.exe"], windows=wins)


# --------------------------------------------------------------------------- suites

def suite_pure(reps: int) -> list[dict]:
    frame = _frame()
    win = _grid_window()
    fields = {f.id: f for f in win.fields}
    lines = _grid_lines(win)
    reader = RegionReader(StubOcr(lines))

    # change-detection / frame stages
    th_a = settle.thumb(frame.image, crop_px=settle.CROP_PX)
    th_b = settle.thumb(_frame().image, crop_px=settle.CROP_PX)

    # resolver: ~2000-term vocabulary, read-only (no lexicon mutation between reps)
    lex = Lexicon(Path("__bench_no_save__.json"))
    lex.set_terms("name", [f"{n} {i}" for n in _NAMES for i in range(90)])
    resolver = FieldResolver(lex, RapidFuzzCorrector(), accept_confidence=0.88,
                             learn_enabled=False)
    # learn=True so _words builds the vocabulary from the lexicon (the real fuzzy path);
    # learn_enabled=False on the resolver keeps it read-only so reps don't mutate the lexicon.
    name_fd = FieldDef(id="name", type=FieldType.text, learn=True, fuzzy=0.8)

    recs = reader.read(frame, win, fields)

    item_win = _item_window()
    item_lf = _item_lines_frac()
    ics = locate_item_cells(frame, item_win, item_lf)
    cluster_in = [0.1 + i * 0.31 for i in range(COLS) for _ in range(ROWS)]

    clf = DetectClassifier(StubOcr([OcrLine("EQUIPMENT", PixelBox(int(0.45 * W), 10, 300, 60), 0.95)]))
    clf_profile = _classify_profile()

    scrollbar_crop = np.random.randint(0, 255, (1600, 30, 3), np.uint8)

    out = []
    # --- per-frame change gates
    # settle.thumb is ~100ms on a 4K frame -> use far fewer reps (the median is stable)
    out.append(bench("settle.thumb (4K)", lambda: settle.thumb(frame.image, crop_px=settle.CROP_PX),
                     max(20, reps // 50), warm=5))
    out.append(bench("settle.is_settled", lambda: settle.is_settled(th_a, th_b), reps))
    out.append(bench("region_signature", lambda: reader.region_signature(frame, win), reps))
    out.append(bench("scroll_detail", lambda: scroll_detail(scrollbar_crop, "vertical"), reps))
    # --- grid build
    out.append(bench("expand_cells (24-cell)", lambda: expand_cells(win), reps))
    out.append(bench("_targets_from_cells", lambda: reader._pixel_targets(frame, win), reps))
    # --- read assembly (StubOcr -> no real inference, measures gather/resolve glue)
    out.append(bench("read (full _read_cells)", lambda: reader.read(frame, win, fields), reps // 4 or 1))
    out.append(bench("_gather (1 box vs all lines)",
                     lambda: reader._gather(lines, lines[0].box), reps))
    # --- resolver
    out.append(bench("resolve: exact hit", lambda: resolver.resolve(name_fd, "Soma Prime 0", 0.95), reps // 2 or 1))
    out.append(bench("resolve: low-conf correct", lambda: resolver.resolve(name_fd, "Sona Prlme 0", 0.55), reps // 4 or 1))
    out.append(bench("resolve: unknown passthrough", lambda: resolver.resolve(name_fd, "Zzqx Wkbl", 0.55), reps // 4 or 1))
    # --- confirm
    out.append(bench("_signature (json.dumps)", lambda: _signature(recs[0]), reps))
    out.append(bench("Confirmer.observe (24 recs)", lambda: Confirmer(lambda v: str(v.get("name")), 2).observe(recs), reps // 2 or 1))
    # --- detect
    out.append(bench("_norm", lambda: _norm("INVENTORY / SELL"), reps))
    out.append(bench("text_match_score partial", lambda: text_match_score("EQUIPMENT", "EOUIPMENT SCREEN"), reps))
    out.append(bench("classifier.classify (3 windows)", lambda: clf.classify(frame, clf_profile), reps // 2 or 1))
    # --- items
    out.append(bench("locate_item_cells (24)", lambda: locate_item_cells(frame, item_win, item_lf), reps // 4 or 1))
    out.append(bench("_clusters", lambda: _clusters(cluster_in, 0.15), reps))
    out.append(bench("resolve_overlaps", lambda: resolve_overlaps(ics, list(range(len(ics)))), reps))
    return out


def _e2e_window():
    """The grid window plus a text detector, so the REAL classifier recognises it."""
    win = _grid_window()
    win.detect = [DetectDef(id="eq_title", text="EQUIPMENT",
                            search=Box(x=0.4, y=0.0, w=0.2, h=0.05), threshold=0.8)]
    return win


def suite_e2e(reps: int) -> tuple[dict, dict]:
    """Run the REAL ``Collector.tick()`` over a stubbed engine (stub capture + OCR,
    real classifier/reader/confirmer/store). The whole-tick median is the coverage
    check: it should ~equal the sum of the individual stage medians. The gap is the
    work NOT separately benched -- store commit I/O + per-tick glue (fields_for,
    above_floor, TickResult, the 6x stats_store.record_timing calls).

    Returns ``(e2e_row, breakdown)`` where breakdown carries the SQLite commit median
    measured in isolation, so the reconciliation can attribute the delta.
    """
    from oc.collect.collector import Collector
    from oc.collect.commit import commit_records
    from oc.settings import Settings, Tuning
    from oc.store import store_for

    frame = _frame()
    win = _e2e_window()
    profile = GameProfile(name="bench_e2e", process_names=["x.exe"], windows=[win])
    lines = _grid_lines(win)

    tmp = Path(tempfile.mkdtemp(prefix="oc_bench_"))
    settings = Settings()
    settings.data_dir = tmp
    settings.captures_dir = tmp / "captures"
    settings.tuning = Tuning(confirm_frames=1)   # confirm in one frame -> commit runs every tick

    engine = SimpleNamespace(
        settings=settings,
        corrector=RapidFuzzCorrector(),
        ocr=StubOcr(lines),
        classifier=DetectClassifier(StubOcr([OcrLine("EQUIPMENT", PixelBox(int(0.45 * W), 10, 300, 60), 0.95)])),
        capture=SimpleNamespace(grab_window=lambda _win: frame),
        window=SimpleNamespace(is_foreground=lambda _w: True),
        process=SimpleNamespace(),
    )
    c = Collector(engine, profile)
    win_obj = object()
    c._locator = SimpleNamespace(locate=lambda _p: win_obj)   # skip win32 entirely

    def reset():   # force the full-work path every tick (else caches skip OCR/commit)
        c._classify_cache = (None, None)
        c._frame_cache.clear()
        c._confirmers.clear()
        # keep _settle_thumb so is_settled actually runs (same frame -> always settled)

    rr = max(20, reps // 50)
    for _ in range(5):
        reset()
        c.tick()
    samples = []
    for _ in range(rr):
        reset()
        t0 = time.perf_counter()
        c.tick()
        samples.append((time.perf_counter() - t0) * 1000.0)
    samples.sort()
    e2e = {"name": "TICK end-to-end (real)", "median": statistics.median(samples),
           "min": samples[0], "p95": samples[min(len(samples) - 1, int(len(samples) * 0.95))]}

    # commit measured alone (the one tick stage with no standalone row -- it does SQLite I/O)
    store = store_for(tmp, profile.name, "equipment", profile=profile,
                      key=profile.key_map_for("equipment"))
    store.begin_batch()
    recs = RegionReader(StubOcr(lines)).read(frame, win, {f.id: f for f in win.fields})
    commit = bench("commit_records (SQLite)", lambda: commit_records(store, recs), max(50, reps // 20))
    return e2e, {"commit": commit}


def suite_real_ocr(reps: int) -> list[dict]:
    """Approximate OCR cost on the real engine (CPU). Not the per-tick number (that
    depends on the live frame), but a sanity floor for read_image/read_line/read_lines."""
    import cv2

    from oc.ocr.rapidocr_engine import RapidOcrEngine

    eng = RapidOcrEngine()
    eng.prepare()
    crop = np.full((120, 600, 3), 255, np.uint8)
    cv2.putText(crop, "Soma Prime", (10, 80), cv2.FONT_HERSHEY_SIMPLEX, 2.0, (0, 0, 0), 3)
    line = np.full((96, 300, 3), 255, np.uint8)
    cv2.putText(line, "12", (10, 70), cv2.FONT_HERSHEY_SIMPLEX, 2.0, (0, 0, 0), 3)
    batch = [line] * 16
    r = max(1, reps // 50)
    return [
        bench("OCR read_image (det+rec)", lambda: eng.read_image(crop), r, warm=3),
        bench("OCR read_line (rec only)", lambda: eng.read_line(line), r, warm=3),
        bench("OCR read_lines (batch 16)", lambda: eng.read_lines(batch), r, warm=3),
    ]


# --------------------------------------------------------------------------- output

def render(rows: list[dict]) -> str:
    head = f"| {'stage':<34} | {'median ms':>10} | {'min ms':>8} | {'p95 ms':>8} |"
    sep = "|" + "-" * 36 + "|" + "-" * 12 + "|" + "-" * 10 + "|" + "-" * 10 + "|"
    body = [f"| {r['name']:<34} | {r['median']:>10.4f} | {r['min']:>8.4f} | {r['p95']:>8.4f} |"
            for r in rows]
    return "\n".join([head, sep, *body])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=2000)
    ap.add_argument("--real-ocr", action="store_true")
    ap.add_argument("--md", type=str, default="")
    args = ap.parse_args()

    print(f"live-mode hot-path micro-benchmark  ({W}x{H} frame, {ROWS}x{COLS} grid, reps={args.reps})\n")
    rows = suite_pure(args.reps)
    e2e, breakdown = suite_e2e(args.reps)
    rows.append(breakdown["commit"])
    if args.real_ocr:
        rows += suite_real_ocr(args.reps)
    table = render(rows)
    print(table)

    # coverage reconciliation: the real tick's median vs the sum of its stage medians.
    med = {r["name"]: r["median"] for r in rows}
    stage_names = ["settle.thumb (4K)", "settle.is_settled", "classifier.classify (3 windows)",
                   "region_signature", "read (full _read_cells)", "Confirmer.observe (24 recs)",
                   "commit_records (SQLite)"]
    parts = sum(med.get(n, 0.0) for n in stage_names)
    delta = e2e["median"] - parts
    recon = (
        f"\n## end-to-end coverage check\n\n"
        f"| measure | ms |\n|---|---|\n"
        f"| TICK end-to-end (real Collector.tick) | {e2e['median']:.4f} |\n"
        f"| sum of stage medians                  | {parts:.4f} |\n"
        f"| unaccounted glue (delta)              | {delta:.4f} |\n\n"
        f"Stages summed: {', '.join(stage_names)}.\n"
        f"Delta = per-tick glue not separately benched: `fields_for` dict build, `_above_floor`,\n"
        f"`TickResult` construction, and the 6x `stats_store.record_timing` instrumentation calls.\n"
        f"A small positive delta means coverage is complete; a large one means a stage is missing.\n"
    )
    print(recon)

    if args.md:
        path = Path(args.md)
        if not path.is_absolute():
            path = Path(__file__).resolve().parent / path
        path.write_text(
            f"# Live-mode hot-path baseline\n\n"
            f"`{W}x{H}` frame, `{ROWS}x{COLS}` grid, reps={args.reps}. "
            f"Pure-logic stages + a real-tick coverage check (live capture/OCR measured via "
            f"stats_store).\n\n"
            f"{table}\n{recon}",
            encoding="utf-8",
        )
        print(f"\nwrote {path}")


if __name__ == "__main__":
    main()
