@echo off
rem Opens the Clawds window. It reads your crew settings from the Claude crew plugin.
start "" pythonw "%~dp0clawd_window.py" %*
