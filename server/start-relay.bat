@echo off
rem Starts the crew relay. The first run makes a random key and saves it in crew_key.txt;
rem give that key (and this PC's VPN/LAN IP) to your teammates.
cd /d "%~dp0"
if not exist crew_key.txt (
  python -c "import secrets; print(secrets.token_urlsafe(18))" > crew_key.txt
)
set /p CREW_KEY=<crew_key.txt
echo Crew key: %CREW_KEY%
echo Your IPs (use the 26.x Radmin / 100.x Tailscale one):
ipconfig | findstr /c:"IPv4"
python relay.py --key %CREW_KEY% %*
pause
