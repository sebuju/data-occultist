"""Overlay host lifecycle — owns the one child process that draws the overlay.

One child per server, not one per overlay node: every window node is a screen of the *same* OS
window, so all overlays share one client rect, and N windows would mean N Chromium instances. The
child hosts a single transparent window; which overlays are *in* it is decided in the page, off the
:mod:`oc.overlay.events` bus. This module only answers "is the window up, and where".

Shaped after :mod:`oc.notify.windows_toast`, for the same reasons: a persistent child that acks
commands over a pipe, a short watchdog per command, and a kill-on-close Job Object so a parent
crash can never leave an orphan behind. An orphaned overlay matters more than an orphaned toast
poster — it is click-through and ``WS_EX_TOOLWINDOW``, so it is not in alt-tab and the user cannot
click it away.

No-ops (rather than failing) when ``pywebview`` is absent, off Windows, or under pytest — same
degrade-quietly contract the capture/notify backends follow, so the suite and non-Windows hosts
never spawn a window.
"""

from __future__ import annotations

import atexit
import json
import os
import queue
import subprocess
import sys
import threading
import time
from importlib.util import find_spec
from pathlib import Path

from .. import eventlog
from ..notify._killjob import KillJob

# Child spawn -> "ready": a fresh interpreter plus the pythonnet/WinForms/WebView2 stack, which is
# heavier than the toast host's imports and stretches further when the game has the CPU.
_READY_TIMEOUT = 30.0
# Per-command ack. Commands are win32 calls on an already-running window — sub-millisecond in the
# normal case; this only catches a wedged host.
_ACK_TIMEOUT = 5.0

_CHILD = Path(__file__).with_name("_overlay_child.py")
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def available() -> tuple[bool, str]:
    """Can an overlay run here? ``(False, reason)`` when it cannot — the reason is surfaced in the
    UI so a missing dependency reads as a clear message instead of a window that never appears."""
    if os.name != "nt":
        return False, "overlay needs Windows"
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return False, "disabled under pytest"
    if find_spec("webview") is None:
        return False, "pywebview is not installed (pip install -e .[desktop])"
    return True, ""


class OverlayHost:
    """The child process, its watchdog, and the last state we pushed to it."""

    def __init__(self) -> None:
        self._lock = threading.Lock()          # serialises command writes across caller threads
        self._proc: subprocess.Popen | None = None
        self._lines: queue.Queue | None = None  # child stdout; None sentinel = child died
        self._job = KillJob()
        self._url = ""
        self._target = 0
        self._visible = False
        atexit.register(self.stop)

    # ---- lifecycle --------------------------------------------------------

    def start(self, url: str) -> bool:
        """Ensure a live child hosting ``url``. A URL change means a respawn: the child navigates
        exactly ONCE, because a transparent pywebview window steals the foreground on every
        navigation (see ``_overlay_child`` quirk 3)."""
        ok, why = available()
        if not ok:
            return False
        with self._lock:
            if self._alive() and url == self._url:
                return True
            self._url = url
            return self._spawn()

    def _alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def _spawn(self) -> bool:
        self._kill()
        try:
            proc = subprocess.Popen(
                [sys.executable, str(_CHILD), "--serve", "--url", self._url],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                creationflags=_NO_WINDOW, text=True, encoding="utf-8", bufsize=1,
            )
        except Exception:  # noqa: BLE001 - the overlay must never break the server
            eventlog.publish("overlay host failed to spawn", "warn")
            return False
        # Enrol in the kill-on-close job immediately: from here on a parent crash takes the
        # overlay down with it. Leaving a click-through, alt-tab-invisible window behind would be
        # genuinely hard for the user to get rid of.
        self._proc = proc
        self._job.assign(proc)
        lines: queue.Queue = queue.Queue()
        self._lines = lines
        threading.Thread(target=self._read_lines, args=(proc, lines), daemon=True).start()
        if self._await(_READY_TIMEOUT, ("ready",)) != "ready":
            eventlog.publish("overlay host never became ready", "warn")
            self._kill()
            return False
        # Re-assert whatever state we had; a respawned child starts blank.
        if self._target:
            self._send({"cmd": "attach", "hwnd": self._target})
        self._send({"cmd": "show" if self._visible else "hide"})
        return True

    @staticmethod
    def _read_lines(proc: subprocess.Popen, out: queue.Queue) -> None:
        try:
            for line in proc.stdout:   # type: ignore[union-attr]
                out.put(line.strip())
        except Exception:  # noqa: BLE001 - a torn pipe on kill is normal
            pass
        out.put(None)   # EOF sentinel: the child is gone

    def _await(self, timeout: float, want: tuple[str, ...]) -> str | None:
        """Next protocol token in ``want``, or None on timeout / child death. Any other line is a
        stray library print and is skipped."""
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

    def _kill(self) -> None:
        proc, self._proc, self._lines = self._proc, None, None
        if proc is None:
            return
        try:
            proc.kill()
            proc.wait(timeout=5.0)
        except Exception:  # noqa: BLE001 - already dead is fine
            pass

    def stop(self) -> None:
        """Take the overlay down. Safe to call repeatedly and from atexit."""
        with self._lock:
            if self._proc is not None:
                try:
                    self._write({"cmd": "quit"})       # graceful: lets the window close itself
                except Exception:  # noqa: BLE001
                    pass
            self._kill()
            self._visible = False
        self._job.terminate()

    # ---- commands ---------------------------------------------------------

    def _write(self, msg: dict) -> None:
        self._proc.stdin.write(json.dumps(msg) + "\n")   # type: ignore[union-attr]
        self._proc.stdin.flush()                         # type: ignore[union-attr]

    def _send(self, msg: dict) -> bool:
        """One command -> one ack, watchdogged. A stall means the host is wedged: kill it, respawn
        once, and replay. Callers never block on more than the watchdog."""
        for attempt in (0, 1):
            if not self._alive() and not self._spawn():
                return False
            try:
                self._write(msg)
            except Exception:  # noqa: BLE001 - child died between poll and write
                self._kill()
                continue
            if self._await(_ACK_TIMEOUT, ("ok", "err")) is not None:
                return True
            eventlog.publish(
                f"overlay host stalled on {msg.get('cmd')!r}"
                + (", restarting" if attempt == 0 else ""), "warn")
            self._kill()
        return False

    def attach(self, hwnd: int) -> None:
        """Follow ``hwnd``'s client rect (0 = stop following)."""
        with self._lock:
            hwnd = int(hwnd or 0)
            if hwnd == self._target:
                return
            self._target = hwnd
            if self._alive():
                self._send({"cmd": "attach", "hwnd": hwnd})

    def set_capturable(self, on: bool) -> None:
        """Allow the overlay into screen captures (default: excluded).

        Normally left off — while on, the overlay lands in the ``mss`` grab that feeds OCR and the
        readouts start reading themselves. Routed through the child because
        ``SetWindowDisplayAffinity`` only works from the thread owning the window.
        """
        with self._lock:
            if self._alive():
                self._send({"cmd": "capturable", "on": bool(on)})

    def set_visible(self, visible: bool) -> None:
        with self._lock:
            visible = bool(visible)
            if visible == self._visible:
                return          # steady state costs nothing — this is called off the gate tick
            self._visible = visible
            if self._alive():
                self._send({"cmd": "show" if visible else "hide"})


# Module-level singleton: one overlay window per server.
_host = OverlayHost()

start = _host.start
attach = _host.attach
set_visible = _host.set_visible
set_capturable = _host.set_capturable
stop = _host.stop
