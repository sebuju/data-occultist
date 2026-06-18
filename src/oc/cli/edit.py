"""`data-occultist rig` — launch the web UI (FastAPI via uvicorn)."""

from __future__ import annotations


def register(sub) -> None:
    p = sub.add_parser("rig", help="launch the web UI")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--reload", action="store_true", help="auto-reload on code change")
    p.set_defaults(func=run)


def run(args) -> int:
    import uvicorn

    print(f"data-occultist UI -> http://{args.host}:{args.port}")
    # Shutdown is clean WITHOUT a graceful-shutdown timeout: the app's lifespan chains the
    # SIGINT/SIGTERM handlers to flip a shutdown flag that every long-lived SSE stream watches
    # (see oc.web.shutdown / oc.web.sse), so the streams self-close and uvicorn's connection
    # drain finishes at once. No timeout band-aid needed.
    uvicorn.run(
        "oc.web.app:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )
    return 0
