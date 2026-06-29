"""Append-only text log parser: one record per kept line.

``str.splitlines`` splits on CRLF / LF / CR (and other unicode breaks) so line endings are
detected automatically — no configuration. Each line is filtered by the node's ``match``
clauses, then every ``SourceField`` extracts one column (after / between / column / whole).
"""

from __future__ import annotations

from ...interfaces import SourceParser
from ...registry import register_parser
from ..extract import line_matches, line_record


@register_parser("log_lines")
class LogLineParser(SourceParser):
    stream = True

    def parse(self, text: str, match, fields) -> list[dict]:
        return [rec for _, rec in self.parse_indexed(text, match, fields)]

    def parse_indexed(self, text: str, match, fields) -> list[tuple[int, dict]]:
        # Enumerate ALL lines so a kept line carries its TRUE source line number (1-based) —
        # filtered/blank lines still advance the count, so the position is the file position.
        out: list[tuple[int, dict]] = []
        for i, line in enumerate((text or "").splitlines(), start=1):
            if not line.strip() or not line_matches(line, match):
                continue
            rec = line_record(line, fields)
            if rec:
                out.append((i, rec))
        return out
