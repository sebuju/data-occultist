"""OnChangeFirer coalescing — a sweep writes one row per market request (throttled slower than
the quiet window), so without busy-deferral the trigger would fire once PER ROW (the "three
blips" bug). While ``busy`` reports the dataset is still being written, firing is deferred and
records accumulate; it fires exactly once when the dataset goes quiet.

Driven by calling ``_flush`` directly so the test is deterministic (no real timer waits).
"""

from oc.store.changes import OnChangeFirer


class _Runner:
    def __init__(self, sink):
        self.sink = sink

    def on_change(self, dataset, records):
        self.sink.append((dataset, [r["name"] for r in records]))
        return [dataset]


def _firer(sink, busy_flag):
    f = OnChangeFirer(lambda _g: _Runner(sink), busy=lambda _g, _ds: busy_flag["v"])
    return f


def test_defers_while_busy_then_fires_once():
    sink, busy = [], {"v": True}
    f = _firer(sink, busy)

    # first burst arrives mid-sweep -> deferred, runner NOT called, records kept
    f._pending[("g", "prices")] = [{"name": "a"}]
    f._flush()
    assert sink == []
    assert ("g", "prices") in f._pending
    if f._timer:
        f._timer.cancel()   # stop the re-armed real timer so it can't fire during the test

    # more rows land during the same sweep -> still deferred
    f._pending[("g", "prices")].append({"name": "b"})
    f._flush()
    assert sink == []
    if f._timer:
        f._timer.cancel()

    # sweep finishes -> dataset quiet -> ONE fire with every accumulated row
    f._pending[("g", "prices")].append({"name": "c"})
    busy["v"] = False
    f._flush()
    assert sink == [("prices", ["a", "b", "c"])]
    assert f._pending == {}


def test_not_busy_fires_immediately():
    sink = []
    f = OnChangeFirer(lambda _g: _Runner(sink))   # no busy predicate -> never deferred
    f._pending[("g", "prices")] = [{"name": "x"}]
    f._flush()
    assert sink == [("prices", ["x"])]


def test_empty_records_enqueue_only_on_a_real_change():
    # a clear / removal announces empty records with data_changed=True -> still enqueued (the
    # watched data changed); a metadata-only ping (learned scroll positions, data_changed=False)
    # is not a data change -> dropped, never fires a trigger.
    f = OnChangeFirer(lambda _g: _Runner([]))

    f("g", "prices", [], data_changed=False)          # metadata ping
    assert ("g", "prices") not in f._pending
    if f._timer:
        f._timer.cancel()

    f("g", "prices", [], data_changed=True)           # a clear
    assert f._pending.get(("g", "prices")) == []      # enqueued for the flush to fire on_change
    if f._timer:
        f._timer.cancel()
