"""Post-capture enrichment: augment saved records from external sources.

Kept strictly out of the capture loop so external latency/outages never affect
collection robustness. First enricher: warframe.market price lookup.
"""

from .runner import enrich_file

__all__ = ["enrich_file"]
