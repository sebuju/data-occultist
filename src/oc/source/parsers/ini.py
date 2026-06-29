"""INI / cfg config parser (e.g. Warframe's EE.cfg). Whole-document: one record.

Path form is ``Section.Key`` (the last dot separates the key). ``optionxform = str`` keeps
key case as written; ``strict=False`` tolerates the duplicate keys real game configs contain.
"""

from __future__ import annotations

import configparser

from ...interfaces import SourceParser
from ...registry import register_parser
from ..extract import doc_record, path_fields


def _parse_ini(text: str):
    cp = configparser.ConfigParser(strict=False, interpolation=None)
    cp.optionxform = str   # preserve key case (default lowercases)
    try:
        cp.read_string(text or "")
    except configparser.Error:
        return None
    return cp


@register_parser("ini")
class IniParser(SourceParser):
    stream = False

    def parse(self, text: str, match, fields) -> list[dict]:
        cp = _parse_ini(text)
        if cp is None:
            return []

        def get(field):
            section, _, key = field.path.rpartition(".")
            if not section:
                return None
            try:
                return cp.get(section, key)
            except (configparser.NoSectionError, configparser.NoOptionError):
                return None

        return doc_record(get, fields)

    def suggest(self, text: str, match) -> list[dict]:
        cp = _parse_ini(text)
        if cp is None:
            return []
        # one path-field per Section.Key (the form parse() reads back); value drives text/number
        pairs = [(f"{section}.{key}", val) for section in cp.sections()
                 for key, val in cp.items(section)]
        return path_fields(pairs)
