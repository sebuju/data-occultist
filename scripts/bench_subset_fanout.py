"""Benchmark: write N rows to one dataset, fan the read out through K subset nodes.

Mirrors the real ``/flow/details`` path (routes/flow.py): one shared store memo, each
subset independently ``compute_view_rows``'d. Varies both K (subset count) and the
dataset's row count, so the cost of write vs. fan-out-read scale can be told apart.

Run: python scripts/bench_subset_fanout.py
"""

from __future__ import annotations

import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from oc.enrich.subset import compute_view_rows          # noqa: E402
from oc.profile.models import DatasetDef, GameProfile, JoinSource, SubsetDef  # noqa: E402
from oc.store.dataset_store import DatasetStore, rows_at  # noqa: E402

GAME = "bench"
DATASET = "items"


def make_profile(n_subsets: int) -> GameProfile:
    subsets = [
        SubsetDef(
            id=f"sub{i}",
            sources=[JoinSource(dataset=DATASET, join_field="name")],
            derived=[{"name": "value", "template": "={count}*{price}|round:0"}],
        )
        for i in range(n_subsets)
    ]
    return GameProfile(name=GAME, datasets=[DatasetDef(id=DATASET)], subsets=subsets)


def write_rows(data_dir: Path, n_rows: int) -> float:
    store = DatasetStore(data_dir, GAME, DATASET)
    rows = [{"name": f"item_{i}", "count": i % 50, "price": (i % 30) + 1} for i in range(n_rows)]
    t0 = time.perf_counter()
    store.record_many(rows)
    dt = time.perf_counter() - t0
    store.close()
    return dt


def run_fanout(data_dir: Path, profile: GameProfile, n_subsets: int) -> tuple[float, int]:
    """Same memo-sharing shape as flow_details: one store opened once, K independent
    compute_view_rows calls over it."""
    memo: dict[str, DatasetStore] = {}

    def fetch(ds: str, agg: str) -> list[dict]:
        store = memo.get(ds)
        if store is None:
            store = memo[ds] = DatasetStore(data_dir, GAME, ds, aggregate=agg)
        return rows_at(store, agg, present_only=True)

    t0 = time.perf_counter()
    total_rows = 0
    for i in range(n_subsets):
        result = compute_view_rows(profile, f"sub{i}", fetch)
        total_rows += len(result["rows"])
    dt = time.perf_counter() - t0
    for store in memo.values():
        store.close()
    return dt, total_rows


def main() -> None:
    row_counts = [100, 1_000, 5_000]
    subset_counts = [10, 50, 100]

    print(f"{'rows':>7} {'subsets':>7} {'write_ms':>10} {'fanout_ms':>10} {'per_sub_ms':>11} {'out_rows':>9}")
    for n_rows in row_counts:
        for n_subsets in subset_counts:
            tmp = Path(tempfile.mkdtemp(prefix="oc_bench_"))
            try:
                write_dt = write_rows(tmp, n_rows)
                profile = make_profile(n_subsets)
                fanout_dt, out_rows = run_fanout(tmp, profile, n_subsets)
                per_sub = fanout_dt / n_subsets * 1000
                print(f"{n_rows:>7} {n_subsets:>7} {write_dt*1000:>10.1f} "
                      f"{fanout_dt*1000:>10.1f} {per_sub:>11.2f} {out_rows:>9}")
            finally:
                shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
