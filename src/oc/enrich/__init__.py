"""Post-capture enrichment: producers that fetch external data into datasets.

Kept strictly out of the capture loop so external latency/outages never affect
collection robustness. The generic ``http`` producer (:mod:`oc.enrich.http_producer`)
is the one backend: it fetches a taught URL and maps the JSON response to columns —
per source item (pricing), or one fetch expanded into many rows (list mode, e.g. the
WFCD relic table). Every URL, header, and mapping is authored in the teach UI.
"""
