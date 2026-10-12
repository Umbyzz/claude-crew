# Troubleshooting, safety and good to know

# Good to know
- **Out-of-tokens detection** works from the errors Claude Code reports: a turn that fails on the usage limit or on missing credit, or a usage window reaching 100%. A brief API rate-limit hiccup can occasionally set off a false alarm. If it does, the next successful reply sends "back" on its own.
- **The pop-out commands are Windows-only** (they use `start`). On other systems, run `python window/clawd_window.py` or `python window/crew_log.py` yourself.
- **The windows need Python** (with its built-in tkinter) on each person's PC. The relay needs Python only on the host's PC.
- **In a brand-new desktop chat, `/crew` may be missing from the slash menu at first.** Type `/crew` in full and press Enter: it works, and from then on the menu lists it. (The app builds a new chat's menu before plugins add their commands.)
- **Buttons in `/crew` sometimes need a double-click** in the desktop app: the first click can just focus the pane. That's the app, not crew; `/crew` shows a one-time tip about it, and a second click always works.

# Safety and privacy
- A teammate's message reaches your Claude marked as coming from a collaborator, not from you, and your instructions win. Auto-run starts turns, but every tool permission prompt still applies. Only allow requests from people you trust.
- The relay keeps the chat, tasks and shared docs in `crew_state.json` on the host's PC (in `~/.claude/crew-relay` when started with `start-relay.bat`). `crew_key.txt` and `crew_state.json` are git-ignored, so they never get committed.
- The Clawds window and the crew log only *read* the relay (`GET /watch`, `GET /log`) and never count as a crew member or move read receipts. The log shows what you'd see in `/crew`; other people's direct messages stay private.

# Troubleshooting

| Symptom | Fix |
|---|---|
| **Test connection** can't reach the relay | Is the relay window open? Is the IP right? Allow Python through Windows Firewall on private networks. |
| `relay 401` | the crew key doesn't match the host's `crew_key.txt` |
| The Clawds window shows a "demo crew" | fill in the relay URL, name and key in `/crew`; the window switches to your crew within a few seconds |
| The Clawds window or crew log doesn't appear | they need Python (and its built-in tkinter). Try double-clicking `window/Clawds.bat` or `window/CrewLog.bat`. |
| "Relay x ≠ plugin y" | the host presses **Restart relay** in that notice |
| Start relay / a button does nothing | click it again (the double-click quirk above) |
| Install update fails | read the reason in the notice, or `%TEMP%\crew-update.log`; reinstall from the GitHub zip once if it keeps failing |

---
[← Back to the README](../README.md)
