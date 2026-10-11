@echo off
rem Opens the crew log: every crew message live. It reads your crew settings from the Claude crew plugin.
start "" pythonw "%~dp0crew_log.py" %*
