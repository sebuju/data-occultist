"""Command-line entry point. Subcommands live in sibling modules."""

from __future__ import annotations

import argparse

from . import app as app_cmd
from . import bench as bench_cmd
from . import capture as capture_cmd
from . import collect as collect_cmd
from . import detect as detect_cmd
from . import price as price_cmd
from . import prices as prices_cmd
from . import profiles as profiles_cmd
from . import serve as serve_cmd
from . import sweep_job as sweep_job_cmd
from . import view as view_cmd


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="data-occultist", description="data-occultist: on-screen game data reader")
    sub = parser.add_subparsers(dest="command", required=True)

    detect_cmd.register(sub)
    capture_cmd.register(sub)
    bench_cmd.register(sub)
    collect_cmd.register(sub)
    price_cmd.register(sub)
    prices_cmd.register(sub)
    profiles_cmd.register(sub)
    serve_cmd.register(sub)
    sweep_job_cmd.register(sub)
    view_cmd.register(sub)
    app_cmd.register(sub)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args) or 0
