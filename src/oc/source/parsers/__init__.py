"""Registered :class:`oc.interfaces.SourceParser` backends, one per file format.

Each module decorates its class with ``@register_parser(name)`` and is listed in
``registry._IMPL_MODULES`` so the name resolves. Adding a format = drop a module here;
no edits to any caller (the runner builds a parser purely by name).
"""
