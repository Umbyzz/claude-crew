# Troubleshooting, safety and good to know

## Troubleshooting

| Symptom | Fix |
|---|---|
| **Test connection** can't reach the relay | Is the relay window open? Is the IP right? Allow Python through Windows Firewall on private networks. |
| *"The relay refused the crew key"* | The host may have made a new key: paste the one from their new invite in ⚙ Settings → Crew key. If **you** are the host, crew picks the right key up from `crew_key.txt` by itself. |
| *"… has a personal key"* | You're on the host's friends list: use the key the host sent you (or that crew saved for you) with exactly that name. |
| *"this crew is friends-only"* | Ask the host to press **★ Friend** next to your name while you're connected. |
| *"the project … is private"* | You were taken off a members-only project, or it's not yours to see. Crew puts you back in main; ask a member to add you. |
| A second relay window says one is already running | Only one relay can run at a time. Use the running one, or stop it first. |
| A teammate's tool shows **off** | The MCP server is set up, but its app (Roblox Studio, Unity…) isn't open. Open it and it flips to **on** within a minute. |
| Crewshared files don't arrive | Press **⇅ Sync now** on both PCs. The project needs a folder on each PC (📂 Project tab). |
| Open folder seems to do nothing | Update to 1.9.6 or newer. Older versions opened folders behind the Claude window. |
| The Clawds window shows a "demo crew" | Fill in the relay URL, name and key in `/crew`; the window switches to your crew within a few seconds. |
| The Clawds window or crew log doesn't appear | They need Python (with its built-in tkinter). Try double-clicking `window/Clawds.bat` or `window/CrewLog.bat`. |
| "Relay x ≠ plugin y" | The host presses **Restart relay** in that notice. |
| A button does nothing | Click it again: see the double-click quirk below. |
| Install update fails | Read the reason in the notice, or `%TEMP%\crew-update.log`; reinstall from the GitHub zip once if it keeps failing. |

## Good to know
- **Buttons in `/crew` sometimes need a double-click** in the desktop app: the first click can just focus the pane. That's the app, not crew; `/crew` shows a one-time tip about it.
- **In a brand-new desktop chat, `/crew` may be missing from the slash menu at first.** Type `/crew` in full and press Enter: it works, and from then on the menu lists it.
- **Out-of-tokens detection** works from the errors Claude Code reports. A brief API rate-limit hiccup can occasionally set off a false alarm; the next successful reply sends "back" on its own.
- **Windows only, for now:** Crewshared, shared folders, Crewleader, the Open buttons and the app checks use PowerShell. A teammate on another system still gets chat, tasks, docs and the Clawds. The pop-out commands use `start`; elsewhere, run `python window/clawd_window.py` or `python window/crew_log.py` yourself.
- **The windows need Python** (with tkinter) on each person's PC. The relay needs Python only on the host's PC.
- **The host's PC is the crew's server.** If it sleeps or the relay window closes, the crew pauses; messages and state survive. **Keep this PC awake** (Crew tab, on by default) prevents the sleep part.

## Safety and privacy
- **Getting in takes the relay's address and a key.** The address is reachable only inside your VPN or LAN. With **friends only** on, everyone needs their own personal key, which works only with their name.
- **Private projects stay private** on the relay itself: non-members can't list, read or switch into them. They're also left out of their crew log, Clawds window, Crew tab ("(private)") and file locks.
- **Crewleader never leaves your PC.** Not even its file names reach the relay.
- **A teammate's message** reaches your Claude marked as coming from a collaborator, not from you, and your instructions win. Auto-run starts turns, but every permission prompt still applies. Only allow requests from people you trust.
- **What's stored where:** the relay keeps the chat, tasks, docs, friends and project members in `crew_state.json`, and shared files in `crew-files\`, on the host's PC (in `~/.claude/crew-relay` when started with `start-relay.bat`). Saves are crash-safe. `crew_key.txt` and `crew_state.json` are git-ignored.
- **The Clawds window and the crew log only *read*** the relay (`GET /watch`, `GET /log`) and never count as a crew member or move read receipts.

---
[← Back to the README](../README.md)
