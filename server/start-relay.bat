@echo off
rem Starts the crew relay. The first run makes a random key in crew_key.txt;
rem give that key and this PC's Radmin (26.x) or Tailscale (100.x) IP to your teammates.
rem
rem The key and the saved chat/tasks live in %USERPROFILE%\.claude\crew-relay, not next to this file:
rem every plugin update installs into a new folder, and the crew must survive that.
cd /d "%~dp0"
set "DATA=%USERPROFILE%\.claude\crew-relay"
if not exist "%DATA%" mkdir "%DATA%"
rem One-time move from older versions, which kept them next to this file: take the newest copy found
rem here or in any other installed version's folder.
for %%F in (crew_key.txt crew_state.json) do (
  if not exist "%DATA%\%%F" powershell -NoProfile -Command "$s = Get-ChildItem -Path '%~dp0..\..\*\server\%%F','%~dp0%%F' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if ($s) { Copy-Item -LiteralPath $s.FullName -Destination '%DATA%\%%F'; Write-Host ('Moved ' + $s.FullName + ' to %DATA%') }"
)
echo Your IPs (use the 26.x Radmin / 100.x Tailscale one):
ipconfig | findstr /c:"IPv4"
echo.
python relay.py --key-file "%DATA%\crew_key.txt" --data "%DATA%\crew_state.json" %*
rem 2: a relay is already running (or the port is taken); the message says which. Close by ourselves.
if errorlevel 2 if not errorlevel 3 (
  echo This window closes in 10 seconds.
  timeout /t 10 >nul
  exit /b 2
)
pause
