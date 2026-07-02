"""Per-process GPU memory readout (Windows).

On WDDM (every consumer Windows box) NVML/nvidia-smi cannot report per-process
VRAM — it shows ``[N/A]`` — so the number Task Manager displays comes from the
``GPU Process Memory`` performance counter set instead. This module reads that
counter for the CURRENT process via ``pdh.dll`` with ctypes (no pywin32/pynvml
dependency), using the English-name API so localized Windows installs work.

Lives next to :mod:`oc.ocr.cuda` as shared GPU plumbing: the web UI polls it on
the activity heartbeat to show how much VRAM the OCR session is holding.
"""

from __future__ import annotations

import ctypes
import os
from ctypes import wintypes

PDH_FMT_LARGE = 0x00000400
PDH_MORE_DATA = 0x800007D2
PDH_NO_DATA = 0x800007D5
_ERROR_SUCCESS = 0


class _PDH_FMT_COUNTERVALUE(ctypes.Structure):
    class _Value(ctypes.Union):
        _fields_ = [("longValue", ctypes.c_long),
                    ("doubleValue", ctypes.c_double),
                    ("largeValue", ctypes.c_longlong),
                    ("AnsiStringValue", ctypes.c_char_p),
                    ("WideStringValue", ctypes.c_wchar_p)]

    _anonymous_ = ("value",)
    _fields_ = [("CStatus", wintypes.DWORD), ("value", _Value)]


class _PDH_FMT_COUNTERVALUE_ITEM_W(ctypes.Structure):
    _fields_ = [("szName", ctypes.c_wchar_p), ("FmtValue", _PDH_FMT_COUNTERVALUE)]


def process_gpu_mem() -> int | None:
    """Dedicated GPU memory (bytes) held by THIS process — the Task Manager number —
    or ``None`` when it can't be read (non-Windows, counter set absent, any PDH
    failure). Never raises. One open/collect/close per call: PDH cost is trivial
    next to the heartbeat interval this rides on."""
    if os.name != "nt":
        return None
    try:
        pdh = ctypes.WinDLL("pdh")
    except OSError:
        return None
    # PDH status codes are unsigned (0x8000xxxx); ctypes' default c_int restype would
    # hand them back negative and every comparison below would silently fail.
    for fn in ("PdhOpenQueryW", "PdhAddEnglishCounterW", "PdhCollectQueryData",
               "PdhGetFormattedCounterArrayW", "PdhCloseQuery"):
        getattr(pdh, fn).restype = ctypes.c_ulong
    query = wintypes.HANDLE()
    if pdh.PdhOpenQueryW(None, 0, ctypes.byref(query)) != _ERROR_SUCCESS:
        return None
    try:
        # One process gets one instance per adapter LUID; the pid_* wildcard sums them.
        path = f"\\GPU Process Memory(pid_{os.getpid()}_*)\\Dedicated Usage"
        counter = wintypes.HANDLE()
        if pdh.PdhAddEnglishCounterW(query, path, 0, ctypes.byref(counter)) != _ERROR_SUCCESS:
            return None
        status = pdh.PdhCollectQueryData(query)
        if status == PDH_NO_DATA:
            return 0   # no pid_* instance = this process holds no GPU memory
        if status != _ERROR_SUCCESS:
            return None
        buf_len, item_count = wintypes.DWORD(0), wintypes.DWORD(0)
        status = pdh.PdhGetFormattedCounterArrayW(
            counter, PDH_FMT_LARGE, ctypes.byref(buf_len), ctypes.byref(item_count), None)
        if status != PDH_MORE_DATA:
            return 0 if status == _ERROR_SUCCESS else None
        buf = ctypes.create_string_buffer(buf_len.value)
        status = pdh.PdhGetFormattedCounterArrayW(
            counter, PDH_FMT_LARGE, ctypes.byref(buf_len), ctypes.byref(item_count), buf)
        if status != _ERROR_SUCCESS:
            return None
        items = ctypes.cast(buf, ctypes.POINTER(_PDH_FMT_COUNTERVALUE_ITEM_W))
        return sum(items[i].FmtValue.largeValue for i in range(item_count.value)
                   if items[i].FmtValue.CStatus == _ERROR_SUCCESS)
    except Exception:
        return None
    finally:
        pdh.PdhCloseQuery(query)
