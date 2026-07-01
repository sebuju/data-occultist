"""Run a CLI subcommand as a supervised child process — the generic "get heavy work off
the event loop / out of the GIL" primitive.

A :class:`SubprocessJob` spawns ``python -m oc <args...>`` (the same venv-independent entry
point the console script uses), streams the child's stdout through a small daemon reader
thread, and fires ``on_exit`` the instant the child ends. The reader thread is what makes
supervision reliable: it drains the pipe (so a chatty child never blocks on a full buffer)
AND detects EOF, so the parent learns the child finished even when nobody is polling —
closing the "closed the browser mid-job → nothing ever reaps it" hole a poll-driven design
would leave open.

Nothing here is price-specific. It speaks only in argv, stdout lines, and lifecycle
callbacks, so any future long/heavy endpoint can run out-of-process the same way.
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
from collections.abc import Callable

# On Windows this stops a console window flashing up for each child; harmless 0 elsewhere.
_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class SubprocessJob:
    """Supervise one ``python -m oc <args>`` child process.

    ``on_line(line)`` — optional, called on the reader thread for each stdout line (already
    stripped of its trailing newline). ``on_exit()`` — optional, called EXACTLY ONCE on the
    reader thread when the child's stdout closes (i.e. the child exited). Both run on a
    daemon thread, so they may touch thread-safe buses (``changes``/``flow_events``) but must
    not assume they run on the event loop.
    """

    def __init__(self, args: list[str], *, name: str,
                 on_exit: Callable[[], None] | None = None,
                 on_line: Callable[[str], None] | None = None) -> None:
        self.name = name
        self._args = list(args)
        self._on_exit = on_exit
        self._on_line = on_line
        self._proc: subprocess.Popen | None = None
        self._reader: threading.Thread | None = None
        self._lines: list[str] = []
        self._lock = threading.Lock()
        self._exited = threading.Event()

    # ---- lifecycle ----------------------------------------------------------

    def start(self) -> None:
        """Spawn the child and begin draining its stdout. Raises if the spawn fails (the
        caller undoes any gate/lock it took)."""
        self._proc = subprocess.Popen(
            [sys.executable, "-m", "oc", *self._args],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace",
            env=os.environ.copy(), creationflags=_CREATE_NO_WINDOW,
        )
        self._reader = threading.Thread(target=self._read_loop, name=f"job:{self.name}",
                                        daemon=True)
        self._reader.start()

    def _read_loop(self) -> None:
        proc = self._proc
        try:
            if proc is not None and proc.stdout is not None:
                for raw in proc.stdout:
                    line = raw.rstrip("\n")
                    with self._lock:
                        self._lines.append(line)
                    if self._on_line is not None:
                        try:
                            self._on_line(line)
                        except Exception:  # noqa: BLE001 - a bad line handler must not kill the reader
                            pass
        finally:
            # stdout closed -> the child has exited (or is about to). Reap the handle so we
            # don't leak a zombie, then fire on_exit exactly once.
            try:
                if proc is not None:
                    proc.wait(timeout=5.0)
            except Exception:  # noqa: BLE001
                pass
            if not self._exited.is_set():
                self._exited.set()
                if self._on_exit is not None:
                    try:
                        self._on_exit()
                    except Exception:  # noqa: BLE001 - reap side effects are best-effort
                        pass

    # ---- inspection ---------------------------------------------------------

    def alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    @property
    def returncode(self) -> int | None:
        return self._proc.poll() if self._proc is not None else None

    def drain_stdout(self) -> list[str]:
        """Return every stdout line buffered since the last drain, clearing the buffer."""
        with self._lock:
            out, self._lines = self._lines, []
        return out

    def join(self, timeout: float | None = None) -> None:
        """Wait for the reader thread to finish. Because the reader fires ``on_exit`` from its
        own ``finally``, joining it guarantees the child has been reaped (its ``on_exit``
        side effects have run) before this returns. Safe to call from any thread EXCEPT the
        reader thread itself (that would be a self-join no-op)."""
        r = self._reader
        if r is not None and r is not threading.current_thread():
            r.join(timeout)

    # ---- teardown -----------------------------------------------------------

    def stop(self, grace: float = 5.0) -> None:
        """Hard backstop for shutdown: ask the child to terminate, wait ``grace`` seconds,
        then kill it. Prefer a graceful cross-process signal (e.g. a cancel file the child
        polls) BEFORE this — ``terminate()`` is abrupt on Windows (``TerminateProcess``)."""
        proc = self._proc
        if proc is None or proc.poll() is not None:
            return
        try:
            proc.terminate()
            proc.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass
        except Exception:  # noqa: BLE001
            pass
