"""Read game files (logs/configs) into datasets — the file-source producer.

A file-source node locates a game file, parses it with a registered format backend
(``oc.source.parsers.*``), and writes parsed rows to a dataset, so file data stores,
dedups, joins and serves exactly like OCR data. Zero game knowledge lives here: the
filename/paths are profile data; the OS roots scanned by the finder are generic.
"""
