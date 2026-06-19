"""YAML config parser. Whole-document: one record. Path form ``a.b.0.c`` (numeric
segment = list index), resolved by :func:`oc.source.extract.dig`. Uses the bundled pyyaml."""

from __future__ import annotations

import yaml

from ...interfaces import SourceParser
from ...registry import register_parser
from ..extract import dig, doc_record


@register_parser("yaml")
class YamlParser(SourceParser):
    stream = False

    def parse(self, text: str, match, fields) -> list[dict]:
        try:
            data = yaml.safe_load(text or "")
        except yaml.YAMLError:
            return []
        return doc_record(lambda f: dig(data, f.path), fields)
