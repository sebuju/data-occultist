"""Run an enricher over a collected JSONL file, writing an enriched copy."""

from __future__ import annotations

import json
from pathlib import Path

from ..interfaces import Enricher


def enrich_file(
    src: Path | str,
    enricher: Enricher,
    dst: Path | str | None = None,
    on_row=None,
) -> Path:
    """Read ``src`` (one JSON object per line), merge enrichment, write ``dst``.

    ``dst`` defaults to ``<src stem>.enriched.jsonl``. ``on_row(values)`` is called
    after each row for progress reporting.
    """
    src = Path(src)
    dst = Path(dst) if dst else src.with_suffix(".enriched.jsonl")
    with src.open(encoding="utf-8") as fin, dst.open("w", encoding="utf-8") as fout:
        for line in fin:
            line = line.strip()
            if not line:
                continue
            values = json.loads(line)
            extra = enricher.enrich(values)
            merged = {**values, **extra}
            fout.write(json.dumps(merged, ensure_ascii=False) + "\n")
            if on_row:
                on_row(merged)
    return dst
