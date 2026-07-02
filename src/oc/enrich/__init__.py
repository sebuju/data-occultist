"""Post-capture enrichment: producers that fetch external data into datasets.

Kept strictly out of the capture loop so external latency/outages never affect
collection robustness. The generic ``http`` producer (:mod:`oc.enrich.http_producer`)
fetches a taught URL per source item and maps the JSON response to columns; ``relic``
is a second, self-contained producer backend.
"""
