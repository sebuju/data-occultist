"""A Windows Job Object that force-kills every child assigned to it the instant its handle closes.

The toast poster (:mod:`oc.notify.windows_toast`) spawns a child process per toast and kills it on
timeout — but that only covers the case where the PARENT is alive to run the kill. If the server
process itself dies mid-post (crash, taskkill, power event), the daemon worker thread never runs,
``proc.kill()`` never fires, and a hung child orphans (lingers till reboot / manual kill).

A Job Object with ``JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`` closes that hole at the OS level: the job
handle is held open for the parent's whole life, and when the parent process exits FOR ANY REASON
the OS closes every handle it owned — closing the job handle, which terminates every process still
in the job. No orphan can outlive the parent.

Implemented with raw ``ctypes``/``kernel32`` on purpose: this module must not import ``winsdk`` (the
whole point of the out-of-process design is that the SERVER process never loads the WinRT DLLs, so
they can't load ahead of onnxruntime's native extension and break OCR). ``ctypes`` is stdlib and
pulls in nothing.

Everything here is best-effort: on any failure (older Windows, already in a job that forbids
assignment, off-Windows) it degrades to a no-op and the caller falls back to its own timeout-kill.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes

# SetInformationJobObject class + limit flag (winnt.h).
_JobObjectExtendedLimitInformation = 9
_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000


class _BASIC_LIMIT(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", wintypes.LARGE_INTEGER),
        ("PerJobUserTimeLimit", wintypes.LARGE_INTEGER),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),       # ULONG_PTR
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class _IO_COUNTERS(ctypes.Structure):
    _fields_ = [(n, ctypes.c_ulonglong) for n in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount",
    )]


class _EXTENDED_LIMIT(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _BASIC_LIMIT),
        ("IoInfo", _IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def _kernel32():
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    # HANDLE is a pointer: without explicit restypes ctypes truncates it to a 32-bit int on 64-bit
    # Python, corrupting the handle.
    k.CreateJobObjectW.restype = wintypes.HANDLE
    k.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
    k.SetInformationJobObject.restype = wintypes.BOOL
    k.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
    k.AssignProcessToJobObject.restype = wintypes.BOOL
    k.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    k.TerminateJobObject.restype = wintypes.BOOL
    k.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    return k


class KillJob:
    """Owns a kill-on-close Job Object. Assign children to it; they die when this handle closes
    (parent exit) or on an explicit :meth:`terminate`. A failed setup leaves ``ok`` False and every
    method a no-op, so callers never need to branch on platform."""

    def __init__(self) -> None:
        self.ok = False
        self._k = None
        self._handle = None
        try:
            self._k = _kernel32()
            handle = self._k.CreateJobObjectW(None, None)
            if not handle:
                return
            info = _EXTENDED_LIMIT()
            info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if not self._k.SetInformationJobObject(
                handle, _JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info)
            ):
                return
            self._handle = handle
            self.ok = True
        except Exception:   # noqa: BLE001 - any failure degrades to no-op
            self.ok = False

    def assign(self, proc) -> None:
        """Put a ``subprocess.Popen`` into the job. Best-effort — a failure just means this child
        relies on the caller's own timeout-kill instead of the OS backstop."""
        if not self.ok or proc is None:
            return
        try:
            self._k.AssignProcessToJobObject(self._handle, int(proc._handle))
        except Exception:   # noqa: BLE001
            pass

    def terminate(self) -> None:
        """Kill every process still in the job NOW (prompt clean-shutdown path). The kill-on-close
        limit already covers a hard parent death; this is just so a graceful exit doesn't wait on
        an in-flight child."""
        if not self.ok:
            return
        try:
            self._k.TerminateJobObject(self._handle, 1)
        except Exception:   # noqa: BLE001
            pass
