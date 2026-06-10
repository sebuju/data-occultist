"""`oc price <game>` — enrich a collected window's records with market prices.

Post-capture step. Reads ``data/<game>/<window>.jsonl`` and writes an
``.enriched.jsonl`` alongside it with warframe.market price fields.
"""

from __future__ import annotations

from pathlib import Path

from ..enrich import enrich_file
from ..registry import build_enricher
from ..settings import Settings


def register(sub) -> None:
    p = sub.add_parser("price", help="enrich collected records with warframe.market prices")
    p.add_argument("game", help="profile name")
    p.add_argument("--window", default="equipment", help="which window's data file")
    p.add_argument("--source", default="warframe_market", help="enricher backend name")
    p.add_argument("--name-field", default="name", help="record field holding the item name")
    p.set_defaults(func=run)


def run(args) -> int:
    settings = Settings.load()
    src = Path(settings.data_dir) / args.game / f"{args.window}.jsonl"
    if not src.exists():
        print(f"No data file: {src}. Run `oc collect {args.game}` first.")
        return 1

    enricher = build_enricher(args.source, name_field=args.name_field)
    count = 0

    def _row(merged):
        nonlocal count
        count += 1
        price = merged.get("wm_price_median")
        print(f"  {merged.get(args.name_field, '?'):30} {price if price is not None else '-'}")

    out = enrich_file(src, enricher, on_row=_row)
    print(f"Enriched {count} rows -> {out}")
    return 0
