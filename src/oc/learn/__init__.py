"""Self-learning OCR repair: a per-game dictionary plus fuzzy correction.

High-confidence reads teach the :class:`Lexicon` (a game-specific dictionary of
known terms per field). Low-confidence reads are snapped to the closest known
term via a :class:`~oc.interfaces.Corrector`. Over time the dictionary grows and
corrections get better.
"""

from .lexicon import Lexicon
from .resolver import FieldResolver, ResolvedField

__all__ = ["Lexicon", "FieldResolver", "ResolvedField"]
