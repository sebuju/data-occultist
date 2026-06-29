"""Append-only text log parser: one record per kept line.

``str.splitlines`` splits on CRLF / LF / CR (and other unicode breaks) so line endings are
detected automatically — no configuration. Each line is filtered by the node's ``match``
clauses, then every ``SourceField`` extracts one column (after / between / column / whole).
"""

from __future__ import annotations

from ...interfaces import SourceParser
from ...registry import register_parser
from ..extract import cast, line_matches, line_record


@register_parser("log_lines")
class LogLineParser(SourceParser):
    stream = True

    def parse(self, text: str, match, fields) -> list[dict]:
        return [rec for _, rec in self.parse_indexed(text, match, fields)]

    def suggest(self, text: str, match) -> list[dict]:
        # No inherent structure in a log line, so propose whitespace COLUMNS off a representative
        # matched line (the one with the most tokens among the first kept lines). The user renames
        # the col1/col2/… ids and refines the method; this just seeds every visible column.
        best: list[str] = []
        seen = 0
        for line in (text or "").splitlines():
            if not line.strip() or not line_matches(line, match):
                continue
            toks = line.split()
            if len(toks) > len(best):
                best = toks
            seen += 1
            if seen >= 200:
                break
        out: list[dict] = []
        for i, tok in enumerate(best):
            # number a token that casts cleanly to one (cast returns a str unchanged otherwise)
            is_num = isinstance(cast(tok, "number"), (int, float))
            out.append({"id": f"col{i + 1}", "method": "column", "delim": " ", "index": i,
                        "type": "number" if is_num else "text"})
        return out

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
