# oc — on-screen reader

Collect structured data from games by reading the screen. Detect the game by
process, recognise which in-game window/state is showing, OCR the data regions,
and write clean records — with a self-learning per-game dictionary and fuzzy
correction to survive noisy OCR, plus robustness against pop-ups and occlusion.

First target: catalogue the **Warframe** equipment window, then price it against
[warframe.market](https://warframe.market).

## Install

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .[dev]
```

## Use

```powershell
oc detect                 # which known games are running right now
oc teach                  # web UI: draw region boxes on a live capture, save a profile
oc capture warframe       # save one screenshot of the game window
oc collect warframe       # run the capture -> OCR -> record loop
oc price warframe          # enrich collected records with warframe.market prices
```

Teaching UI runs at http://127.0.0.1:8000 — capture the live window, drag boxes,
label each as a region / anchor / state anchor / scrollbar, and save.

## How it fits together

See [CLAUDE.md](CLAUDE.md) for the architecture: a registry of swappable backends
(capture, OCR, window, process, classifier, corrector, enricher) selected by name
in `config/settings.yaml`, and per-game profiles in `config/games/`.
