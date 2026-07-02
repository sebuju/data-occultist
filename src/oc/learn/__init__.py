"""OCR read repair: an authored per-game dictionary plus fuzzy correction.

Reads are snapped to the closest known term via a :class:`~oc.interfaces.Corrector`,
using only the vocabulary the profile's dictionaries declare — there is no
self-learning, so every correction traces back to a term someone taught.
"""

from .resolver import FieldResolver, ResolvedField

__all__ = ["FieldResolver", "ResolvedField"]
