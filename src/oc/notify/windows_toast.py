"""Windows OS toast notifier — queues toasts and posts each via a persistent CHILD-PROCESS host.

The ``find_spec`` check below is the registration gate: on a host without the ``toasted`` library
(or off-Windows) this module fails to import and ``registry`` silently skips it, so
``build_notifier`` falls back to the ``null`` no-op — exactly how the win32/wgc capture backends
behave. The gate only *checks* the library is installed; the actual toast build + WinRT post live
entirely in :mod:`oc.notify._toast_child`, which this process spawns and never imports. So the
server process never loads ``toasted``/``winsdk`` (nor the WinRT runtime DLLs they pull in) — that
matters because if those DLLs load ahead of onnxruntime's native extension, onnxruntime's pybind
init fails ("DLL initialization routine failed") and every OCR read 500s.

**Why a child process.** Posting a toast is a synchronous WinRT/COM call into the Windows
notification service (WpnUserService). That call occasionally stalls indefinitely, and ``winsdk``
(pywinrt 1.0.0b10) does NOT release the GIL around it — a stuck post therefore freezes the *entire*
interpreter (FastAPI, the asyncio loop, everything), and it never recovers: the process must be
killed. Earlier revisions posted on a throwaway *thread* joined with a timeout, but that is no real
defence — a Python thread can't be force-killed, and while the stuck thread holds the GIL the
``join(timeout)`` can't even run to time out. A child *process* can be OS-killed regardless of what
its GIL is doing.

**Why ONE persistent host, not one child per toast.** The per-toast design paid a fresh
interpreter spawn + the toasted/winsdk import (~0.3s warm, seconds under game+OCR CPU load) for
EVERY toast, and its 20s stall backstop parked the whole queue behind one wedged post. The host
(``_toast_child.py --serve``) pays the import once, acks each post over a pipe, and the worker
watches every ack with a short watchdog: a wedged post gets the host killed, respawned, and the
toast retried once — a hang now costs seconds and is *logged*, never silent. Queued toasts that
share a replace-by-tag identity are coalesced while draining a backlog (only the newest survives —
the older ones would have been replaced on screen anyway).
"""

from __future__ import annotations

import atexit
import dataclasses
import json
import queue
import subprocess
import sys
import threading
import time
from importlib.util import find_spec
from pathlib import Path

if find_spec("toasted") is None:   # registration gate: absent -> module skipped
    raise ImportError("toasted is not installed")

from .. import eventlog
from ..interfaces import Notifier, ToastSpec
from ..registry import register_notifier
from ._killjob import KillJob

# Watchdog per post: write spec -> host acks. Posting is normally well under a second on a warm
# host; this is the backstop for a WpnUserService stall (the host is killed + respawned and the
# toast retried once). Kept short so a wedge stalls later toasts for seconds, not tens of seconds.
_ACK_TIMEOUT = 8.0
# Host spawn -> "ready": a fresh interpreter + the toasted/winsdk imports, which can stretch well
# past the warm ~0.3s when the game + OCR have the CPU pinned or the DLLs are cold on disk.
_READY_TIMEOUT = 15.0
# An ack slower than this is worth a log line even though it succeeded — the breadcrumb that
# shows WpnUserService (or machine load) degrading before a full stall ever happens.
_SLOW_ACK_S = 2.0

_CHILD = Path(__file__).with_name("_toast_child.py")

# Suppress the console window Windows would otherwise flash for the host (pythonw isn't assumed).
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


@register_notifier("windows")
class WindowsToastNotifier(Notifier):
    def __init__(self) -> None:
        # Toasts are queued and drained by _run, never posted on the caller's (FastAPI request /
        # collector) thread — notify() always returns instantly, and a slow/stuck post only ever
        # delays OTHER queued toasts, never a request or the collector loop.
        self._queue: queue.Queue = queue.Queue()
        # OS backstop against orphans: the host is assigned to this kill-on-close Job Object, so
        # if THIS process dies mid-post (crash, taskkill) the OS closes the job handle and
        # terminates the host too. atexit.terminate covers the graceful path (don't leave a
        # wedged host running when the server exits cleanly).
        self._job = KillJob()
        # Host state — touched ONLY by the _run worker thread, so no lock is needed.
        self._host: subprocess.Popen | None = None
        self._lines: queue.Queue | None = None   # host stdout lines; None sentinel = host died
        atexit.register(self._job.terminate)
        threading.Thread(target=self._run, daemon=True).start()

    def notify(self, spec: ToastSpec) -> None:
        # Hand off to the worker thread and return immediately — see __init__.
        self._queue.put(spec)

    def _run(self) -> None:
        self._ensure_host()   # pre-warm at boot so the first real toast doesn't pay the spawn
        while True:
            batch = [self._queue.get()]
            try:   # drain whatever else queued up while the previous post was in flight
                while True:
                    batch.append(self._queue.get_nowait())
            except queue.Empty:
                pass
            for spec in self._coalesce(batch):
                self._post(spec)

    @staticmethod
    def _coalesce(batch: list) -> list:
        """Collapse a drained backlog: among specs sharing the same non-empty replace-by-tag
        identity ``(tag, group)`` only the NEWEST survives (in its original position) — the
        older ones would have been replaced on screen anyway, so posting them is pure stale
        re-pop churn after a stall. Tagless specs always post. A normal one-at-a-time fire is a
        batch of one and passes through untouched."""
        out: list = []
        seen: set = set()
        for spec in reversed(batch):
            tag = getattr(spec, "tag", "") or ""
            if tag:
                key = (tag, getattr(spec, "group", "") or "")
                if key in seen:
                    continue
                seen.add(key)
            out.append(spec)
        out.reverse()
        if len(out) < len(batch):
            eventlog.publish(f"toast backlog: {len(batch)} coalesced to {len(out)}", "info")
        return out

    # ---- host lifecycle (all on the _run thread) --------------------------------------

    def _ensure_host(self) -> bool:
        """A live, ready host — reusing the current one, else spawning fresh."""
        if self._host is not None and self._host.poll() is None:
            return True
        return self._spawn_host()

    def _spawn_host(self) -> bool:
        self._kill_host()
        try:
            proc = subprocess.Popen(
                [sys.executable, str(_CHILD), "--serve"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                creationflags=_NO_WINDOW, text=True, encoding="utf-8", bufsize=1,
            )
        except Exception:  # noqa: BLE001 - a toast must never break a fire
            return False
        # Enrol the host in the kill-on-close job the instant it exists, so a parent crash from
        # here on takes it down with it (tiny race: a crash in the microseconds between spawn and
        # assign could leak this one host — it just idles on stdin EOF and exits).
        self._host = proc
        self._job.assign(proc)
        lines: queue.Queue = queue.Queue()
        self._lines = lines
        # Reader thread per host instance: blocking readline can't be timed out, so the worker
        # never reads the pipe directly — it waits on this queue instead. EOF = host died.
        threading.Thread(target=self._read_lines, args=(proc, lines), daemon=True).start()
        return self._await_line(_READY_TIMEOUT, want=("ready",)) == "ready"

    @staticmethod
    def _read_lines(proc: subprocess.Popen, out: queue.Queue) -> None:
        try:
            for line in proc.stdout:   # type: ignore[union-attr]
                out.put(line.strip())
        except Exception:  # noqa: BLE001 - a torn pipe on kill is normal
            pass
        out.put(None)   # EOF sentinel: the host is gone

    def _await_line(self, timeout: float, want: tuple[str, ...]) -> str | None:
        """Next protocol token in ``want`` from the host's stdout, or None on timeout / host
        death. Any other line is a stray library print — skipped."""
        lines = self._lines
        if lines is None:
            return None
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                return None
            try:
                line = lines.get(timeout=left)
            except queue.Empty:
                return None
            if line is None:
                return None
            if line in want:
                return line

    def _kill_host(self) -> None:
        proc, self._host, self._lines = self._host, None, None
        if proc is None:
            return
        try:
            proc.kill()   # OS-kill; a wedged WinRT call can't block this
            proc.wait(timeout=5.0)
        except Exception:  # noqa: BLE001 - already dead / torn down is fine
            pass

    # ---- posting ----------------------------------------------------------------------

    def _post(self, spec: ToastSpec) -> None:
        # One spec -> one JSON line down the host's stdin -> one ack. A stall (no ack within the
        # watchdog) means the host is wedged inside WinRT: kill it, respawn, retry ONCE — the old
        # per-toast design silently lost that toast. A failed toast must never crash a trigger
        # fire / a request — swallow everything.
        game = getattr(spec, "group", "") or None
        try:
            payload = json.dumps(dataclasses.asdict(spec))
        except Exception:  # noqa: BLE001 - an unserializable spec must never break a fire
            return
        for attempt in (0, 1):
            if not self._ensure_host():
                eventlog.publish("toast poster failed to start", "warn", game=game)
                continue
            t0 = time.monotonic()
            try:
                self._host.stdin.write(payload + "\n")   # type: ignore[union-attr]
                self._host.stdin.flush()                 # type: ignore[union-attr]
            except Exception:  # noqa: BLE001 - host died between poll and write
                self._kill_host()
                continue
            # "err" = the host caught a bad spec / WinRT hiccup and is still healthy — same
            # swallow-and-move-on the one-shot child had, nothing to recover.
            ack = self._await_line(_ACK_TIMEOUT, want=("ok", "err"))
            took = time.monotonic() - t0
            if ack is not None:
                if took > _SLOW_ACK_S:
                    eventlog.publish(f"toast post slow ({took:.1f}s)", "warn", game=game)
                return
            # No ack: the host either crashed (process gone — reader's EOF sentinel) or is
            # wedged inside the WinRT call (alive but silent — the case the watchdog exists for).
            died = self._host is None or self._host.poll() is not None
            eventlog.publish(
                ("toast poster died" if died else
                 f"toast post stalled >{_ACK_TIMEOUT:.0f}s — killed the poster")
                + (", retrying" if attempt == 0 else ""), "warn", game=game)
            self._kill_host()
        eventlog.publish("toast dropped after retry", "warn", game=game)
