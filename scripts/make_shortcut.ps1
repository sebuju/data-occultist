# make_shortcut.ps1 - (re)create the data-occultist app shortcuts (.lnk) without a full reinstall.
#
# Drops "data-occultist (cuda).lnk" and "data-occultist (igpu).lnk" in the repo root, on the
# Desktop, and in the Start menu (target: <venv>\Scripts\pythonw.exe -m oc.desktop_main, icon:
# assets\data-occultist.ico). (cuda) launches from .venv; (igpu) from .venv-dml (DirectML OCR
# on a non-NVIDIA GPU) and is only made when that venv exists. Removes the old un-suffixed
# data-occultist.lnk. Bat-free replacement for #app.bat - double-click a .lnk to launch.
#
#     powershell -ExecutionPolicy Bypass -File scripts\make_shortcut.ps1

$env:OC_INSTALL_TEST = '1'                   # load install.ps1's functions only (early return on the hook)
. (Join-Path $PSScriptRoot 'install.ps1')
Remove-Item Env:\OC_INSTALL_TEST
New-AppShortcut
