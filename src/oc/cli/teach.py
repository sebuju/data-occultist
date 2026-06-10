"""`oc teach` — launch the web teaching UI (FastAPI via uvicorn)."""

from __future__ import annotations


def register(sub) -> None:
    p = sub.add_parser("teach", help="launch the web teaching UI")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--reload", action="store_true", help="auto-reload on code change")
    p.set_defaults(func=run)


def run(args) -> int:
    import uvicorn

    print(f"Teaching UI -> http://{args.host}:{args.port}")
    uvicorn.run(
        "oc.web.app:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )
    return 0
