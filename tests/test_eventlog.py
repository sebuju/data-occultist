"""Activity-log bus + blocked-sweep surfacing — pure logic, no network.

The bus (:mod:`oc.eventlog`) backs the web log bar; ``recent_blocked`` backs the Activity
panel's "blocked" rows. Both are exercised without sleeping or hitting the market.
"""

from oc import eventlog
from oc.enrich import price_runner


def test_eventlog_publish_subscribe_and_recent():
    seen = []
    off = eventlog.subscribe(lambda ev: seen.append(ev))
    try:
        a = eventlog.publish("alpha", level="run", game="g1")
        eventlog.publish("beta", game="g2")
        eventlog.publish("global")            # no game -> visible to every game's stream
    finally:
        off()
    assert [e["msg"] for e in seen] == ["alpha", "beta", "global"]
    assert seen[0]["level"] == "run" and seen[0]["game"] == "g1"

    # recent() backfills by seq, filtered to a game (+ gameless lines)
    g1 = [e["msg"] for e in eventlog.recent(after_seq=a["seq"] - 1, game="g1")]
    assert "alpha" in g1 and "global" in g1 and "beta" not in g1
    # after_seq excludes already-seen lines
    assert all(e["seq"] > a["seq"] for e in eventlog.recent(after_seq=a["seq"]))

    # unsubscribed callback no longer fires
    n = len(seen)
    eventlog.publish("after-off")
    assert len(seen) == n


def test_recent_blocked_records_and_expires(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(price_runner.time, "monotonic", lambda: clock[0])

    price_runner._recent_blocked.clear()
    st = price_runner._note_blocked("g", "prices_relic", "orders", "another sweep running")
    assert st.blocked and st.blocked_by == "another sweep running"

    rows = price_runner.recent_blocked("g")
    assert len(rows) == 1 and rows[0]["dataset"] == "prices_relic"
    assert rows[0]["blocked"] and rows[0]["blocked_by"] == "another sweep running"
    assert price_runner.recent_blocked("other") == []     # scoped per game

    clock[0] += price_runner._BLOCKED_TTL + 1              # age past the TTL -> pruned on read
    assert price_runner.recent_blocked("g") == []
    assert ("g", "prices_relic") not in price_runner._recent_blocked
