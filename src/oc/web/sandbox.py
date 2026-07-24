"""Request-scoped profile sandboxing for debug browsing and e2e runs.

Debug mode (``?debug=1``) and Playwright e2e both hit the user's already-running shared
server, so a launch-time override can't tell a debug/test tab apart from real work on the
same process — isolation has to be per-request. A client that wants isolation sends
``X-OC-Sandbox: 1``; ``ensure_sandbox`` then resolves ``profiles_dir`` to an ephemeral
per-boot copy of ``config/games`` instead of the real one, so nothing a debug tab or an
e2e run does to a profile (edits, layout saves, backups) ever touches the real YAML.

Scope is the profile YAML + its sidecars only (pretty doc, ``.local`` graph-state, dict-term
externalize, new backup snapshots) — the live collector and dataset store are untouched and
keep reading/writing the real ``data_dir``.

This module deliberately does NOT call :func:`oc.web.deps.get_settings` itself — route
tests monkeypatch ``get_settings`` as a name *inside each route module* (e.g.
``monkeypatch.setattr("oc.web.routes.profiles.get_settings", ...)``), which only rebinds
that module's own import, not this one. A route resolves its OWN (possibly patched)
``settings.profiles_dir`` and passes it in here; this module only decides real-vs-sandbox
and does the copy.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import threading
from pathlib import Path

from fastapi import Header

_lock = threading.Lock()
_sandboxed: Path | None = None   # memoized for this process — one sandbox per boot


def _sandbox_root() -> Path:
    # OCC_BOOT_ID is one random id per real `serve` invocation (see cli/serve.py), inherited
    # unchanged by every --reload worker respawn of THIS run — so all workers of one real
    # launch share the same sandbox, and a fresh launch gets a fresh one.
    boot = os.environ.get("OCC_BOOT_ID", "noboot")
    return Path(tempfile.gettempdir()) / f"oc-sandbox-{boot}"


def ensure_sandbox(real: Path) -> Path:
    """The sandboxed copy of ``real``, seeding it once (per process) on first use."""
    global _sandboxed
    if _sandboxed is not None:
        return _sandboxed
    with _lock:
        if _sandboxed is not None:
            return _sandboxed
        root = _sandbox_root()
        if not root.exists() or not any(root.iterdir()):
            # Seed once from the real profiles dir, excluding .backups (can be tens of MB of
            # snapshot history — the sandbox starts with none, new saves snapshot into its own
            # empty .backups) and any lock file (a fresh sandbox is never mid-write).
            root.mkdir(parents=True, exist_ok=True)
            shutil.copytree(
                real, root,
                ignore=shutil.ignore_patterns(".backups", "*.lock"),
                dirs_exist_ok=True,
            )
        _sandboxed = root
        return root


def sandbox_flag(x_oc_sandbox: str | None = Header(None, alias="X-OC-Sandbox")) -> str | None:
    """FastAPI dependency: just extracts the header, so a route can resolve its own
    (possibly test-patched) settings before deciding real-vs-sandbox."""
    return x_oc_sandbox


def wants_sandbox(flag: str | None) -> bool:
    return bool(flag) and flag not in ("0", "false")
