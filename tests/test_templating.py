"""`{{token}}` server-side rendering — the `??` nullish-default operator (mirror of
binding.js splitDefault/renderDynamicText). Pure-logic: readout-only contexts need no
data_dir/profile."""

from oc.collect.templating import TokenContext, render, resolve_token, split_default


def _ctx(readouts=None):
    return TokenContext(readouts or {})


# ---- split_default parse -------------------------------------------------------------

def test_split_default_none():
    assert split_default("dataset:x.f|mean") == ("dataset:x.f|mean", None)


def test_split_default_basic():
    assert split_default("name ?? -") == ("name", "-")


def test_split_default_multiword_trimmed():
    assert split_default("name ?? not set") == ("name", "not set")


def test_split_default_first_match_only():
    assert split_default("a ?? b ?? c") == ("a", "b ?? c")


def test_split_default_empty_default():
    assert split_default("name ?? ") == ("name", "")


def test_split_default_needs_padding():
    # no surrounding whitespace -> not an operator (won't collide with join:"??")
    assert split_default("name??-") == ("name??-", None)


# ---- render with `??` ----------------------------------------------------------------

def test_default_fires_on_unresolved():
    assert render("{{ ro ?? - }}", _ctx()) == "-"


def test_default_fires_on_empty_string():
    assert render("{{ ro ?? - }}", _ctx({"ro": ""})) == "-"


def test_default_not_fired_on_zero():
    assert render("{{ ro ?? - }}", _ctx({"ro": 0})) == "0"


def test_default_not_fired_on_value():
    assert render("{{ ro ?? - }}", _ctx({"ro": "hi"})) == "hi"


def test_default_multiword():
    assert render("{{ ro ?? not set }}", _ctx()) == "not set"


def test_default_with_format_intact_on_value():
    assert render("{{ ro|.2f ?? n/a }}", _ctx({"ro": 3.14159})) == "3.14"


def test_default_with_format_fires_when_empty():
    assert render("{{ ro|.2f ?? n/a }}", _ctx()) == "n/a"


def test_default_wins_over_keep_missing():
    # an authored fallback shows even in the preview (keep_missing) path
    assert render("{{ ro ?? - }}", _ctx(), keep_missing=True) == "-"


def test_keep_missing_without_default_unchanged():
    assert render("{{ ro }}", _ctx(), keep_missing=True) == "{{ ro }}"


# ---- regression: no `??` behaves exactly as before -----------------------------------

def test_plain_token_unchanged():
    assert render("{{ ro }}", _ctx({"ro": "v"})) == "v"


def test_plain_missing_empties():
    assert render("{{ ro }}", _ctx()) == ""


# ---- the server /resolve path never sees a default -----------------------------------

def test_resolve_token_is_default_free():
    # resolve_token is fed the already-stripped core (client strips `??` when building the
    # token key); it must NOT try to resolve a source that carries a default.
    left, default = split_default("readout:ro ?? -")
    assert (left, default) == ("readout:ro", "-")
    assert resolve_token(_ctx({"ro": 7}), left) == 7
