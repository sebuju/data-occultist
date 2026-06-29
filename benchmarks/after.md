# Live-mode hot-path baseline

`3840x2160` frame, `8x3` grid, reps=2000. Pure-logic stages + a real-tick coverage check (live capture/OCR measured via stats_store).

| stage                              |  median ms |   min ms |   p95 ms |
|------------------------------------|------------|----------|----------|
| settle.thumb (4K)                  |     1.1358 |   1.0872 |   1.6568 |
| settle.is_settled                  |     0.0043 |   0.0042 |   0.0071 |
| region_signature                   |     0.0870 |   0.0835 |   0.1491 |
| scroll_detail                      |     0.6290 |   0.6053 |   1.0969 |
| expand_cells (24-cell)             |     0.0277 |   0.0270 |   0.0322 |
| _targets_from_cells                |     0.0664 |   0.0641 |   0.1062 |
| read (full _read_cells)            |     0.7023 |   0.6663 |   0.9318 |
| _gather (1 box vs all lines)       |     0.0094 |   0.0090 |   0.0128 |
| resolve: exact hit                 |     0.0111 |   0.0108 |   0.0141 |
| resolve: low-conf correct          |     0.0387 |   0.0256 |   0.0401 |
| resolve: unknown passthrough       |     0.0256 |   0.0250 |   0.0388 |
| _signature (json.dumps)            |     0.0015 |   0.0014 |   0.0016 |
| Confirmer.observe (24 recs)        |     0.0401 |   0.0389 |   0.0619 |
| _norm                              |     0.0012 |   0.0007 |   0.0013 |
| text_match_score partial           |     0.0020 |   0.0019 |   0.0021 |
| classifier.classify (3 windows)    |     0.0155 |   0.0151 |   0.0165 |
| locate_item_cells (24)             |     0.1654 |   0.1554 |   0.2788 |
| _clusters                          |     0.0021 |   0.0020 |   0.0024 |
| resolve_overlaps                   |     0.0190 |   0.0182 |   0.0307 |
| commit_records (SQLite)            |     0.3027 |   0.2266 |   0.3563 |

## end-to-end coverage check

| measure | ms |
|---|---|
| TICK end-to-end (real Collector.tick) | 2.7177 |
| sum of stage medians                  | 2.2877 |
| unaccounted glue (delta)              | 0.4300 |

Stages summed: settle.thumb (4K), settle.is_settled, classifier.classify (3 windows), region_signature, read (full _read_cells), Confirmer.observe (24 recs), commit_records (SQLite).
Delta = per-tick glue not separately benched: `fields_for` dict build, `_above_floor`,
`TickResult` construction, and the 6x `stats_store.record_timing` instrumentation calls.
A small positive delta means coverage is complete; a large one means a stage is missing.
