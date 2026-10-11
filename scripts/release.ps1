# Bumps the crew version everywhere it lives, then checks the plugin.
#   powershell -ExecutionPolicy Bypass -File scripts\release.ps1 0.3.1
# Afterwards: commit + push in GitHub Desktop. Teammates get an update notice in /crew.
param([Parameter(Mandatory = $true)][string]$Version)

$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must look like 1.2.3, got '$Version'" }
$root = Split-Path $PSScriptRoot -Parent
$utf8 = New-Object Text.UTF8Encoding $false

$edits = @(
  @{ File = '.claude-plugin\plugin.json'; Pattern = '"version":\s*"[^"]+"'; With = "`"version`": `"$Version`"" },
  @{ File = 'hooks\register.tsx'; Pattern = "const VERSION = '[^']+'"; With = "const VERSION = '$Version'" },
  @{ File = 'server\relay.py'; Pattern = 'VERSION = "[^"]+"'; With = "VERSION = `"$Version`"" }
)
foreach ($e in $edits) {
  $path = Join-Path $root $e.File
  $text = [IO.File]::ReadAllText($path)
  if ($text -notmatch $e.Pattern) { throw "No version found in $($e.File)" }
  [IO.File]::WriteAllText($path, ([regex]::new($e.Pattern)).Replace($text, $e.With, 1), $utf8)
  Write-Host "  $($e.File) -> $Version"
}

$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
  $claude = Get-ChildItem "$env:APPDATA\Claude\claude-code" -Recurse -Filter claude.exe -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
}
if ($claude) {
  $exe = if ($claude.Source) { $claude.Source } else { $claude.FullName }
  & $exe plugin validate $root
  & $exe plugin test $root
} else {
  Write-Host 'claude not found; skipped validate/test'
}

Write-Host ""
Write-Host "Now commit 'Release $Version' and push in GitHub Desktop."
Write-Host "If server\relay.py changed, the relay host should restart it with the new file."
