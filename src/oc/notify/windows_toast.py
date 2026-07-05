"""Windows OS toast notifier — queues toasts and posts each in a throwaway CHILD PROCESS.

The ``find_spec`` check below is the registration gate: on a host without the ``toasted`` library
(or off-Windows) this module fails to import and ``registry`` silently skips it, so
``build_notifier`` falls back to the ``null`` no-op — exactly how the win32/wgc capture backends
behave. The gate only *checks* the library is installed; the actual toast build + WinRT post live
entirely in :mod:`oc.notify._toast_child`, which this process spawns and never imports. So the
server process never loads ``toasted``/``winsdk`` (nor the WinRT runtime DLLs they pull in) — that
matters because if those DLLs load ahead of onnxruntime's native extension, onnxruntime's pybind
init fails ("DLL initialization routine failed") and every OCR read 500s.

**Why a child process per toast.** Posting a toast is a synchronous WinRT/COM call into the Windows
notification service (WpnUserService). That call occasionally stalls indefinitely, and ``winsdk``
(pywinrt 1.0.0b10) does NOT release the GIL around it — a stuck post therefore freezes the *entire*
interpreter (FastAPI, the asyncio loop, everything), and it never recovers: the process must be
killed. Earlier revisions posted on a throwaway *thread* joined with a timeout, but that is no real
defence — a Python thread can't be force-killed, and while the stuck thread holds the GIL the
``join(timeout)`` can't even run to time out. A child *process* can be OS-killed regardless of what
its GIL is doing. So :meth:`_run` spawns ``_toast_child`` per toast, waits on it with a hard
timeout, and ``kill()``s it if it overruns — a hung post costs one abandoned child, never the
server.
"""

from __future__ import annotations

import atexit
import dataclasses
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
from importlib.util import find_spec
from pathlib import Path

if find_spec("toasted") is None:   # registration gate: absent -> module skipped
    raise ImportError("toasted is not installed")

from ..interfaces import Notifier, ToastSpec
from ..registry import register_notifier
from ._killjob import KillJob

# Hard bound on one child's whole life (import toasted/winsdk + build XML + hand to the OS).
# Posting is normally a second or two; this is the backstop for a WpnUserService stall or a remote
# icon download hanging. On overrun the child is killed and _run moves to the next queued toast.
_KILL_TIMEOUT = 20.0

_CHILD = Path(__file__).with_name("_toast_child.py")

# Suppress the console window Windows would otherwise flash for each child (pythonw isn't assumed).
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


@register_notifier("windows")
class WindowsToastNotifier(Notifier):
    def __init__(self) -> None:
        # Toasts are queued and drained by _run, never posted on the caller's (FastAPI request)
        # thread — notify() always returns instantly, and a slow/stuck post only ever delays OTHER
        # queued toasts, never a request or the collector loop.
        self._queue: queue.Queue = queue.Queue()
        # OS backstop against orphans: every child is assigned to this kill-on-close Job Object, so
        # if THIS process dies mid-post (crash, taskkill) without _post's own kill running, the OS
        # closes the job handle and terminates the child too. atexit.terminate covers the graceful
        # path (don't leave a hung child running when the server exits cleanly).
        self._job = KillJob()
        self._current: subprocess.Popen | None = None
        atexit.register(self._job.terminate)
        threading.Thread(target=self._run, daemon=True).start()

    def notify(self, spec: ToastSpec) -> None:
        # Hand off to the worker thread and return immediately — see __init__.
        self._queue.put(spec)

    def _run(self) -> None:
        while True:
            spec = self._queue.get()
            self._post(spec)

    def _post(self, spec: ToastSpec) -> None:
        # Serialize the spec to a temp JSON file and post it in a child process, killed on overrun.
        # A failed toast must never crash a trigger fire / a request — swallow everything.
        path = ""
        try:
            fd, path = tempfile.mkstemp(prefix="oc_toast_", suffix=".json")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(dataclasses.asdict(spec), f)
            proc = subprocess.Popen(
                [sys.executable, str(_CHILD), path],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=_NO_WINDOW,
            )
            # Enrol the child in the kill-on-close job the instant it exists, so a parent crash from
            # here on takes the child down with it (tiny race: a crash in the microseconds between
            # spawn and assign could leak this one child — the child does nothing until it posts, so
            # even then it just exits normally).
            self._current = proc
            self._job.assign(proc)
            try:
                proc.wait(timeout=_KILL_TIMEOUT)
            except subprocess.TimeoutExpired:
                proc.kill()   # OS-kill the stalled post; it can't touch this process
                try:
                    proc.wait(timeout=5.0)
                except subprocess.TimeoutExpired:
                    pass
        except Exception:  # noqa: BLE001 - a toast must never break a fire
            pass
        finally:
            self._current = None
            if path:
                try:
                    os.unlink(path)
                except OSError:
                    pass
