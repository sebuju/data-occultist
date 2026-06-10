"""Dictionary (lexicon) endpoints: view and edit a game's learned terms.

The lexicon is game-specific (``data/<game>/lexicon.json``), keyed by field id.
The game page shows it and lets the user correct/seed terms by hand.
"""

from __future__ import annotations

from fastapi import APIRouter, Body

from ...learn.lexicon import Lexicon
from ..deps import get_settings

router = APIRouter(prefix="/api/lexicon", tags=["lexicon"])


@router.get("/{game}")
def get_lexicon(game: str):
    """Return {field: [terms sorted]} for the game's dictionary."""
    lex = Lexicon.for_game(get_settings().data_dir, game)
    return {field: sorted(terms) for field, terms in lex.as_dict().items()}


@router.put("/{game}/{field}")
def put_field_terms(game: str, field: str, terms: list[str] = Body(...)):
    """Replace the term list for one field (manual edit)."""
    lex = Lexicon.for_game(get_settings().data_dir, game)
    lex.set_terms(field, terms)
    lex.force_save()
    return {"ok": True, "field": field, "count": len(lex.terms(field))}
