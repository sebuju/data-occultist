"""`data-rig rig` — launch the web UI (FastAPI via uvicorn)."""

from __future__ import annotations


def register(sub) -> None:
    p = sub.add_parser("rig", help="launch the web UI")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--reload", action="store_true", help="auto-reload on code change")
    p.set_defaults(func=run)


def run(args) -> int:
    import uvicorn

    print(f"data-rig UI -> http://{args.host}:{args.port}")
    uvicorn.run(
        "oc.web.app:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        # don't let a long-lived SSE stream block shutdown/reload forever — force-close after 5s
        timeout_graceful_shutdown=5,
    )
    return 0
