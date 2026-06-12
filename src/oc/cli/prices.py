"""`oc prices <game>` — throttled warframe.market price sweep over a dataset.

For every distinct item in the dataset's collected records, fetch its market price
statistics and merge the daily candles into ``data/<game>/prices.state.json``. Run
it on a schedule (cron / Task Scheduler) to build long-run price history. Unlike
``oc price`` (a one-shot file enrich), this maintains a growing time-series store.
"""

from __future__ import annotations

from ..enrich.price_collector import sweep_dataset
from ..enrich.slug_resolver import get_resolver
from ..profile import list_profiles, load_profile
from ..registry import build_corrector
from ..settings import Settings


def register(sub) -> None:
    p = sub.add_parser("prices", help="sweep warframe.market price history for a dataset")
    p.add_argument("game", help="profile name")
    p.add_argument("--dataset", default="master", help="dataset whose items to price")
    p.add_argument("--throttle", type=float, default=0.4, help="seconds between requests")
    p.add_argument("--timeout", type=float, default=30.0, help="per-request timeout")
    p.add_argument("--limit", type=int, default=0, help="cap distinct items fetched (0=all)")
    p.add_argument("--name-field", default="name", help="record field holding the item name")
    p.add_argument("--refresh-catalogue", action="store_true",
                   help="re-fetch the market item catalogue before resolving names")
    p.set_defaults(func=run)


def run(args) -> int:
    settings = Settings.load()
    key = None
    if args.game in list_profiles(settings.profiles_dir):
        key = load_profile(settings.profiles_dir, args.game).key_map_for(args.dataset)

    corrector = None
    try:
        corrector = build_corrector(settings.corrector.name, **settings.corrector.options)
    except Exception:  # noqa: BLE001 - resolver still works without fuzzy
        corrector = None
    resolver = get_resolver(settings.data_dir, args.game, corrector=corrector,
                            refresh=args.refresh_catalogue)
    resolve = resolver.resolve if resolver is not None else None
    if resolver is None:
        print("warning: market catalogue unavailable — falling back to naive slugify")

    def _row(idx, total, slug, name, ok):
        mark = "ok " if ok else "-- "
        print(f"  [{idx:>4}/{total}] {mark}{name[:34]:34} {slug}")

    result = sweep_dataset(
        settings.data_dir, args.game, args.dataset, key=key,
        throttle=args.throttle, timeout=args.timeout, limit=args.limit,
        name_field=args.name_field, resolve=resolve, on_item=_row,
    )
    print(f"Swept {result['fetched']}/{result['total']} items "
          f"({result['failed']} failed) -> {result['slugs']} slugs stored")
    return 0
