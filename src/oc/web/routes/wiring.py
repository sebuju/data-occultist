"""The wiring table, served to the front-end.

``oc.profile.wiring`` is the one declaration of what may connect to what, what a ref of each
kind looks like, and what each kind is called in the graph/pretty grammars. The boot checker and
the trigger runner read it directly; the browser reads it through here, so a picker, a port-drop
target or a rename site can never offer a pairing the checker would then reject (or miss one it
would accept). Static — no game argument, no profile load.
"""

from __future__ import annotations

from fastapi import APIRouter

from ...profile import wiring

router = APIRouter(prefix="/api/wiring", tags=["wiring"])


@router.get("")
def table():
    """Kinds + links + register count facets, verbatim from the table."""
    return wiring.as_dict()
