"""System-wide keyboard/mouse observation via Win32 low-level hooks. Windows-only.

``WH_KEYBOARD_LL``/``WH_MOUSE_LL`` receive every key/mouse event system-wide REGARDLESS of which
window has focus — including a fullscreen exclusive game — because they're installed in the OS
input pipeline itself, not on a window's message queue. This is passive observation only (we never
synthesize input), so it's the same mechanism a benign overlay/streaming tool uses and doesn't trip
anti-cheat.

The catch: an LL hook callback runs INSIDE the OS's global input dispatch — Windows blocks ALL
system-wide keyboard/mouse input for every process until the callback returns, and ``WH_MOUSE_LL``
fires it on EVERY mouse move (a high-polling-rate mouse = ~1000/sec). A Python callback must
reacquire the GIL to run at all; while this process's OCR/capture loop holds the GIL, that reacquire
is delayed on every move, so the callback returns late and the OS stalls global input — lag that
scales with how much the mouse moves. Thread priority does NOT fix this (CPython's GIL handoff isn't
OS-priority-aware).

So the hook does not run in this process at all. :class:`Win32InputHook` spawns a dedicated child
process (:mod:`oc.input._hook_child`) that owns the hooks + message pump and has an UNCONTENDED GIL,
so its callback returns in microseconds no matter what this process is doing. The child streams
button/key EDGES (mouse moves stay inside it, never crossing the wire) as one JSON line each on its
stdout. A reader thread here drains that stdout onto a bounded drop-newest queue, and a consumer
thread calls the subscriber (``TriggerRunner.on_input`` — gates, dataset joins, a toast render). A
backlogged reader only buffers bytes in the OS pipe; it can never stall the child's hook proc, so it
can never stall system input. This mirrors the out-of-process toast poster (:mod:`oc.notify`),
which isolates a GIL-hazardous WinRT call the same way.

Caveat: UIPI blocks a hook from seeing input delivered to a MORE privileged process — if the game
runs elevated and this app doesn't, the hook installs but never sees its events (the child reports
the install failure on its stderr, logged here). Warframe normally isn't elevated, so this is a
corner case, not the default.
"""

from __future__ import annotations

import atexit
import json
import logging
import queue
import subprocess
import sys
import threading
from collections.abc import Callable
from pathlib import Path

from ..interfaces import InputSource
from ..registry import register_input

_QUIT = object()   # sentinel: tell the consumer thread to stop
_CHILD = Path(__file__).with_name("_hook_child.py")
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)   # no console flash for the child


@register_input("win32")
class Win32InputHook(InputSource):
    """Low-level global keyboard+mouse hook, isolated in a child process. See
    :class:`oc.interfaces.InputSource` and the module docstring."""

    def __init__(self) -> None:
        self._proc: subprocess.Popen | None = None
        self._callback: Callable[[dict], None] | None = None
        self._queue: queue.Queue | None = None
        self._reader: threading.Thread | None = None
        self._errpump: threading.Thread | None = None
        self._consumer: threading.Thread | None = None
        self._stopping = False
        self._job = None   # KillJob: OS backstop so a parent crash can't orphan the child
        self._atexit_registered = False

    def start(self, callback: Callable[[dict], None]) -> None:
        if self._proc is not None and self._proc.poll() is None:
            self.stop()
        log = logging.getLogger(__name__)
        self._callback = callback
        self._stopping = False
        # bounded + drop-newest-on-full (see _reader): a stalled subscriber must never make the
        # reader block or the queue grow unbounded, only lose the least useful (oldest) backlog.
        self._queue = queue.Queue(maxsize=256)
        self._consumer = threading.Thread(target=self._consume, name="oc-input-consumer", daemon=True)
        self._consumer.start()

        # OS backstop against orphans: assign the child to a kill-on-close Job Object, so if THIS
        # process dies (crash, taskkill) the OS closes the job handle and terminates the child too.
        # Best-effort — a failed job just means stop()'s own kill is the only cleanup path.
        try:
            from ..notify._killjob import KillJob
            self._job = KillJob()
        except Exception:  # noqa: BLE001 - job setup must never stop the hook
            self._job = None

        # stdin=PIPE, held open for this process's life and never written: it is the child's
        # parent-death sensor. If THIS process dies any way that skips stop() (crash, taskkill,
        # os._exit), the OS closes our end and the child's stdin hits EOF -> the child self-exits.
        # Belt to the KillJob's suspenders, and it covers the case KillJob setup failed.
        self._proc = subprocess.Popen(
            [sys.executable, str(_CHILD)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", bufsize=1,
            creationflags=_NO_WINDOW,
        )
        if self._job is not None:
            self._job.assign(self._proc)
        if not self._atexit_registered:
            # Prompt cleanup on a graceful interpreter exit that never calls stop(). (KillJob's
            # kill-on-close and the child's stdin watchdog also cover this at the OS level; this
            # just kills it immediately instead of waiting on those.)
            atexit.register(self._atexit_kill)
            self._atexit_registered = True

        self._reader = threading.Thread(target=self._read, name="oc-input-reader", daemon=True)
        self._reader.start()
        self._errpump = threading.Thread(target=self._drain_stderr, name="oc-input-stderr", daemon=True)
        self._errpump.start()
        log.info("input hook child started (pid=%s)", self._proc.pid)

    def stop(self) -> None:
        self._stopping = True
        proc, job = self._proc, self._job
        self._proc = None
        self._job = None
        if job is not None:
            job.terminate()   # kill the child now (graceful path; kill-on-close covers a crash)
        if proc is not None:
            try:
                proc.kill()   # closes the child's stdout -> the reader's line loop ends on EOF
            except Exception:  # noqa: BLE001 - already-dead child
                pass
            try:
                proc.wait(timeout=2.0)
            except Exception:  # noqa: BLE001
                pass
        for t in (self._reader, self._errpump):
            if t is not None and t.is_alive():
                t.join(timeout=2.0)
        self._reader = self._errpump = None
        if self._queue is not None:
            self._queue.put(_QUIT)
        if self._consumer is not None and self._consumer.is_alive():
            self._consumer.join(timeout=2.0)
        self._consumer = None
        self._queue = None

    def _atexit_kill(self) -> None:
        """Last-ditch child kill on interpreter shutdown. Minimal and swallow-everything -- runs in
        the atexit context where the world is half torn down."""
        job, proc = self._job, self._proc
        try:
            if job is not None:
                job.terminate()
        except Exception:  # noqa: BLE001
            pass
        try:
            if proc is not None:
                proc.kill()
        except Exception:  # noqa: BLE001
            pass

    # ---- reader thread: drain the child's stdout onto the queue (never calls the subscriber) ----

    def _read(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        # readline(), NOT ``for line in stdout`` -- file iteration read-aheads and would buffer
        # events until a big chunk arrives; readline yields each edge the instant the child flushes.
        while True:
            line = proc.stdout.readline()   # blocks in the OS read (GIL released) until a line/EOF
            if line == "":
                break   # EOF: the child closed stdout (killed on stop, or died)
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except ValueError:
                continue   # a malformed line is not worth killing the stream over
            q = self._queue
            if q is None:
                break
            try:
                q.put_nowait(ev)   # drop-newest-on-full: a full queue means the consumer is behind
            except queue.Full:
                pass
        if not self._stopping:
            logging.getLogger(__name__).warning(
                "input hook child exited unexpectedly -- on_input triggers won't fire")

    def _drain_stderr(self) -> None:
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        while True:
            line = proc.stderr.readline()
            if line == "":
                break
            line = line.strip()
            if line:
                logging.getLogger(__name__).warning("input hook child: %s", line)

    # ---- consumer thread: the ONLY thread that ever calls the subscriber callback -----------
    # Kept off the reader on purpose -- a slow subscriber only backs up this queue, never the
    # reader (which would in turn back up the OS pipe and, at the child, the hook proc).

    def _consume(self) -> None:
        emit_failed = False   # log a broken subscriber ONCE (this can run once per keystroke/click)
        while True:
            q = self._queue
            if q is None:
                return
            ev = q.get()
            if ev is _QUIT:
                return
            cb = self._callback
            if cb is None:
                continue
            try:
                cb(ev)
            except Exception:
                if not emit_failed:
                    emit_failed = True
                    logging.getLogger(__name__).exception(
                        "on_input subscriber raised -- on_input triggers won't fire (further errors suppressed)")
