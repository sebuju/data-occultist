"""XML config parser. Whole-document: one record.

Path form ``root/child/grandchild`` reads that element's text; a trailing ``/@attr`` reads
an attribute instead (``root/child/@id``). A leading segment equal to the document root tag
is optional, so both ``root/child`` and ``child`` work.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET

from ...interfaces import SourceParser
from ...registry import register_parser
from ..extract import doc_record, path_fields


def _xml_get(root, path: str):
    attr = None
    if "/@" in path:
        path, attr = path.split("/@", 1)
    parts = [p for p in path.split("/") if p]
    node = root
    start = 1 if (parts and parts[0] == root.tag) else 0
    for p in parts[start:]:
        node = node.find(p) if node is not None else None
        if node is None:
            return None
    if attr is not None:
        return node.get(attr)
    return (node.text or "").strip()


@register_parser("xml")
class XmlParser(SourceParser):
    stream = False

    def parse(self, text: str, match, fields) -> list[dict]:
        try:
            root = ET.fromstring(text or "")
        except ET.ParseError:
            return []
        return doc_record(lambda f: _xml_get(root, f.path), fields)

    def suggest(self, text: str, match) -> list[dict]:
        try:
            root = ET.fromstring(text or "")
        except ET.ParseError:
            return []
        pairs: list[tuple[str, object]] = []
        seen: set[str] = set()

        def walk(node, path: str) -> None:
            if len(pairs) >= 60:
                return
            for name, val in node.attrib.items():
                p = f"{path}/@{name}"
                if p not in seen:
                    seen.add(p)
                    pairs.append((p, val))
            kids = list(node)
            if not kids and (node.text or "").strip() and path not in seen:
                seen.add(path)
                pairs.append((path, (node.text or "").strip()))
            for k in kids:
                walk(k, f"{path}/{k.tag}")

        walk(root, root.tag)
        return path_fields(pairs, sep="/")
