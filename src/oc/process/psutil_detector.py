"""Process detection via :mod:`psutil` (cross-platform)."""

from __future__ import annotations

from collections.abc import Sequence

import psutil

from ..interfaces import ProcessDetector
from ..registry import register_process
from ..types import ProcessInfo


@register_process("psutil")
class PsutilProcessDetector(ProcessDetector):
    def list_processes(self) -> Sequence[ProcessInfo]:
        # Name only: fetching exe opens every process and is very slow on Windows.
        out: list[ProcessInfo] = []
        for p in psutil.process_iter(["pid", "name"]):
            try:
                out.append(ProcessInfo(pid=p.info["pid"], name=p.info["name"] or ""))
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        return out

    def find_by_names(self, names: Sequence[str]) -> ProcessInfo | None:
        wanted = {n.lower() for n in names}
        # Short-circuit on the first match; never touch the slow exe attribute.
        for p in psutil.process_iter(["pid", "name"]):
            try:
                name = p.info["name"] or ""
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
            if name.lower() in wanted:
                return ProcessInfo(pid=p.info["pid"], name=name)
        return None
