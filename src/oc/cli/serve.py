"""`data-occultist serve` — launch the web UI (FastAPI via uvicorn)."""

from __future__ import annotations


def register(sub) -> None:
    p = sub.add_parser("serve", help="launch the web UI")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--reload", dest="reload", action="store_true", default=True,
                   help="auto-reload on code change (default on)")
    p.add_argument("--no-reload", dest="reload", action="store_false",
                   help="disable auto-reload")
    p.add_argument("--verbose-access", action="store_true",
                   help="log every request, including static-asset GETs (default hides them)")
    p.set_defaults(func=run)


def run(args) -> int:
    import os

    import uvicorn

    print(f"data-occultist UI -> http://{args.host}:{args.port}")
    # The static-asset GET flood is filtered out of the access log by the app's lifespan
    # (oc.web.logfilter), which applies on every launch path including the --reload worker. This
    # env var is how the opt-out reaches that worker subprocess (it inherits the parent env).
    if getattr(args, "verbose_access", False):
        os.environ["OCC_VERBOSE_ACCESS"] = "1"
    # One random id per real `serve` invocation, inherited unchanged by every `--reload`
    # worker respawn of THIS run (they're child processes of this one, not fresh launches).
    # oc.web.routes.logbar reads it to tell "a real new server start" apart from "the
    # --reload worker restarted again" so it can rotate the logbar file only on the former.
    import uuid
    os.environ["OCC_BOOT_ID"] = uuid.uuid4().hex
    # Where this server is reachable, for anything that must hand out a URL — the overlay child is
    # a browser and loads its page from here. Env-stored so a --reload worker inherits it.
    from ..web import server_url
    server_url.set_base_url(args.host, args.port)
    # Shutdown is clean WITHOUT a graceful-shutdown timeout: the app's lifespan chains the
    # SIGINT/SIGTERM handlers to flip a shutdown flag that every long-lived SSE stream watches
    # (see oc.web.shutdown / oc.web.sse), so the streams self-close and uvicorn's connection
    # drain finishes at once. No timeout band-aid needed.
    # Watch the `oc` package source itself, not the process cwd. An installed/editable
    # launch (e.g. .venv-dml\Scripts\data-occultist.exe) usually runs from a cwd that
    # isn't the repo, so uvicorn's default (watch cwd) sees no code changes and never
    # reloads. Pin the watch dir to where `oc` actually lives.
    reload_kwargs = {}
    if args.reload:
        import oc
        reload_kwargs["reload_dirs"] = [os.path.dirname(os.path.dirname(oc.__file__))]

    uvicorn.run(
        "oc.web.app:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        **reload_kwargs,
    )
    return 0
