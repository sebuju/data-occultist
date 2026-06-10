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
    id: int = 0                   # stable per-dataset event id
    batch: int = 0                # which collection/save run produced this event (revert target)

    def to_dict(self) -> dict:
        payload = {"id": self.id, "batch": self.batch, "ts": self.ts,
                   "op": self.op.value, "key": self.key, "values": self.values}
        if self.changed:
            payload["changed"] = self.changed
        return payload

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, default=str)

    @staticmethod
    def from_dict(d: dict) -> "ChangeEvent":
        return ChangeEvent(
            ts=d.get("ts", ""),
            op=ChangeOp(d["op"]),
            key=d["key"],
            values=d.get("values", {}),
            changed=d.get("changed", {}),
            id=int(d.get("id", 0)),
            batch=int(d.get("batch", 0)),
        )
