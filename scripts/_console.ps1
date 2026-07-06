# _console.ps1 - shared console helpers. Dot-source it:  . "$PSScriptRoot\_console.ps1"
#
# Enable-AnsiColors turns on VT (virtual terminal) processing for the current console
# so child processes' ANSI color codes render instead of printing raw escapes like
# "<-[32mINFO<-[0m" in legacy conhost. PowerShell's own Write-Host colors use the
# console color API and work without this; uvicorn (and most CLIs) emit ANSI and need it.

function Resolve-VenvScripts {
    # Return the venv's Scripts dir to launch from, so one launcher can target either
    # the default CUDA venv (.venv) or the DirectML venv (.venv-dml, OCR on an iGPU off
    # the game's card). $Venv is a name (.venv-dml), a relative path, or absolute; blank
    # means the default. The caller Tests-Path the exe/python inside and falls back to
    # PATH python when the venv is absent, so a fresh checkout still runs.
    param([string]$Root, [string]$Venv = ".venv")
    if (-not $Venv) { $Venv = ".venv" }
    $dir = if ([System.IO.Path]::IsPathRooted($Venv)) { $Venv } else { Join-Path $Root $Venv }
    return (Join-Path $dir "Scripts")
}

function Enable-AnsiColors {
    # Persistent fix: tell conhost to enable VT for every NEW console at creation time
    # (HKCU, user scope, reversible). This is what actually survives the
    # Explorer -> cmd (.bat) -> powershell -> python handoff, because the runtime
    # SetConsoleMode below is unreliable once a child process owns stdout. Idempotent.
    try {
        if (-not (Test-Path 'HKCU:\Console')) { New-Item 'HKCU:\Console' -Force | Out-Null }
        $cur = (Get-ItemProperty 'HKCU:\Console' -Name VirtualTerminalLevel -ErrorAction SilentlyContinue).VirtualTerminalLevel
        if ($cur -ne 1) {
            New-ItemProperty 'HKCU:\Console' -Name VirtualTerminalLevel -PropertyType DWord -Value 1 -Force | Out-Null
        }
    } catch { }

    # Also try to flip VT on for the CURRENT console (helps when this very window was
    # opened before the reg key existed; no-op when redirected/headless).
    if (-not ('VtConsole.Native' -as [type])) {
        Add-Type -Namespace VtConsole -Name Native -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GetStdHandle(int n);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleMode(IntPtr h, out uint m);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleMode(IntPtr h, uint m);
'@
    }
    try {
        $h = [VtConsole.Native]::GetStdHandle(-11)   # STD_OUTPUT_HANDLE
        $m = 0
        if ([VtConsole.Native]::GetConsoleMode($h, [ref]$m)) {
            [void][VtConsole.Native]::SetConsoleMode($h, $m -bor 0x4)  # ENABLE_VIRTUAL_TERMINAL_PROCESSING
        }
    } catch { }   # no real console (redirected/headless) -> nothing to enable
}
