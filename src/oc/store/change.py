"""Change-log event types. Generic: no game- or field-specific knowledge."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import Enum


class ChangeOp(str, Enum):
    add = "add"
    update = "update"
    remove = "remove"


@dataclass
class ChangeEvent:
    ts: str                       # ISO-8601 timestamp
    op: ChangeOp
    key: str                      # the dataset key (e.g. normalised item name)
    values: dict                  # record values at the time of the event
    changed: dict = field(default_factory=dict)  # field -> [old, new] for updates

    def to_json(self) -> str:
        payload = {
            "ts": self.ts,
            "op": self.op.value,
            "key": self.key,
            "values": self.values,
        }
        if self.changed:
            payload["changed"] = self.changed
        return json.dumps(payload, ensure_ascii=False, default=str)
