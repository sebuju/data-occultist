"""Enable ``python -m oc`` as an entry point equivalent to the ``data-occultist`` console
script. Used as a venv-name-independent fallback (e.g. by scripts\\serve.ps1 when the
installed console exe isn't found)."""

from oc.cli import main

raise SystemExit(main())
