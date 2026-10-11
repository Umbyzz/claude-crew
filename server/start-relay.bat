@echo off
rem Starts the crew relay. The first run makes a random key in crew_key.txt;
rem give that key and this PC's Radmin (26.x) or Tailscale (100.x) IP to your teammates.
cd /d "%~dp0"
echo Your IPs (use the 26.x Radmin / 100.x Tailscale one):
ipconfig | findstr /c:"IPv4"
echo.
python relay.py --key-file crew_key.txt %*
pause
