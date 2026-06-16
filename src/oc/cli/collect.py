"""`oc collect <game>` — run the capture/OCR loop and append records."""

from __future__ import annotations

from ..collect.collector import Collector, TickResult, TickStatus
from ..collect.triggers import TriggerRunner
from ..engine import Engine
from ..profile import load_profile
from ..store.changes import OnChangeFirer, subscribe


def register(sub) -> None:
    p = sub.add_parser("collect", help="run the data collection loop")
    p.add_argument("game", help="profile name")
    p.add_argument("--interval", type=float, default=1.0, help="seconds between ticks")
    p.add_argument("--once", action="store_true", help="run a single tick and exit")
    p.set_defaults(func=run)


def _print_tick(result: TickResult) -> None:
    if result.status is TickStatus.saved:
        print(
            f"[{result.window_id}/{result.state_id}] "
            f"read={result.read} kept={result.kept} new={result.new} total={result.total}"
        )
    else:
        print(f"[{result.status.value}]"
              + (f" window={result.window_id}" if result.window_id else "")
              + (f" state={result.state_id}" if result.state_id else ""))


def run(args) -> int:
    engine = Engine.build()
    profile = load_profile(engine.settings.profiles_dir, args.game)
    collector = Collector(engine, profile)
    # on_change triggers fire off the dataset change bus now (not inline in the loop), so any
    # write announces itself. Register the firer for this game.
    if profile.triggers:
        runner = TriggerRunner(profile, engine.settings.data_dir)
        subscribe(OnChangeFirer(lambda _g: runner))
    if args.once:
        _print_tick(collector.tick())
        collector.close()
        return 0
    print(f"Collecting {args.game} every {args.interval}s. Ctrl+C to stop.")
    collector.run(interval=args.interval, on_tick=_print_tick)
    return 0
