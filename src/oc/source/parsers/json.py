"""JSON config parser. Whole-document: one record. Path form ``a.b.0.c`` (numeric
segment = list index), resolved by :func:`oc.source.extract.dig`."""

from __future__ import annotations

import json as _json

from ...interfaces import SourceParser
from ...registry import register_parser
from ..extract import dig, doc_record, leaf_paths, path_fields


@register_parser("json")
class JsonParser(SourceParser):
    stream = False

    def parse(self, text: str, match, fields) -> list[dict]:
        try:
            data = _json.loads(text or "")
        except (ValueError, TypeError):
            return []
        return doc_record(lambda f: dig(data, f.path), fields)

    def suggest(self, text: str, match) -> list[dict]:
        try:
            data = _json.loads(text or "")
        except (ValueError, TypeError):
            return []
        return path_fields(leaf_paths(data))
