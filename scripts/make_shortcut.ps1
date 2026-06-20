# make_shortcut.ps1 - (re)create the data-occultist app shortcut (.lnk) without a full reinstall.
#
# Drops data-occultist.lnk in the repo root, on the Desktop, and in the Start menu
# (target: .venv\Scripts\pythonw.exe -m oc.desktop_main, icon: assets\data-occultist.ico).
# This is the bat-free replacement for #app.bat - double-click the .lnk to launch the app.
#
#     powershell -ExecutionPolicy Bypass -File scripts\make_shortcut.ps1

$env:OC_INSTALL_TEST = '1'                   # load install.ps1's functions only (early return on the hook)
. (Join-Path $PSScriptRoot 'install.ps1')
Remove-Item Env:\OC_INSTALL_TEST
New-AppShortcut
