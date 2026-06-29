# Live-mode hot-path baseline

`3840x2160` frame, `8x3` grid, reps=2000. Pure-logic stages + a real-tick coverage check (live capture/OCR measured via stats_store).

| stage                              |  median ms |   min ms |   p95 ms |
|------------------------------------|------------|----------|----------|
| settle.thumb (4K)                  |   117.9958 | 114.2098 | 130.8043 |
| settle.is_settled                  |     0.0043 |   0.0041 |   0.0063 |
| region_signature                   |     0.0840 |   0.0816 |   0.1276 |
| scroll_detail                      |     0.6280 |   0.6039 |   1.0412 |
| expand_cells (24-cell)             |     0.0281 |   0.0271 |   0.0297 |
| _targets_from_cells                |     0.0659 |   0.0638 |   0.0880 |
| read (full _read_cells)            |     0.6945 |   0.6659 |   0.8991 |
| _gather (1 box vs all lines)       |     0.0097 |   0.0092 |   0.0127 |
| resolve: exact hit                 |     0.0110 |   0.0108 |   0.0116 |
| resolve: low-conf correct          |     0.0256 |   0.0252 |   0.0282 |
| resolve: unknown passthrough       |     0.0248 |   0.0245 |   0.0295 |
| _signature (json.dumps)            |     0.0015 |   0.0014 |   0.0024 |
| Confirmer.observe (24 recs)        |     0.0584 |   0.0377 |   0.0637 |
| _norm                              |     0.0007 |   0.0007 |   0.0008 |
| text_match_score partial           |     0.0020 |   0.0019 |   0.0040 |
| classifier.classify (3 windows)    |     0.0209 |   0.0136 |   0.0322 |
| locate_item_cells (24)             |     0.1636 |   0.1580 |   0.2431 |
| _clusters                          |     0.0022 |   0.0020 |   0.0023 |
| resolve_overlaps                   |     0.0176 |   0.0170 |   0.0198 |
| commit_records (SQLite)            |     0.2427 |   0.2387 |   0.2513 |

## end-to-end coverage check

| measure | ms |
|---|---|
| TICK end-to-end (real Collector.tick) | 117.8632 |
| sum of stage medians                  | 119.1007 |
| unaccounted glue (delta)              | -1.2375 |

Stages summed: settle.thumb (4K), settle.is_settled, classifier.classify (3 windows), region_signature, read (full _read_cells), Confirmer.observe (24 recs), commit_records (SQLite).
Delta = per-tick glue not separately benched: `fields_for` dict build, `_above_floor`,
`TickResult` construction, and the 6x `stats_store.record_timing` instrumentation calls.
A small positive delta means coverage is complete; a large one means a stage is missing.
