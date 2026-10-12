# Setup

## 1. One person hosts the relay
The host needs Python 3.8 or newer, and nothing else.

**Easiest: host from Claude.** Install the plugin (step 3) and open `/crew`. The setup asks your name, then **Host a crew** or **Join a friend's crew**. **Host a crew** opens `start-relay.bat` in its own window (keep it open while you host) and puts you straight into the session. Press **Copy invite** to get a ready-to-send message with your address, the key and the install steps. **Stop hosting** shuts the relay down. If you're set up as host but the relay isn't running (say, after a reboot), `/crew` says so and shows **▶ Start relay** in its top bar (and in Settings → Connection); it also puts you back in the session. After a crew update, the old relay keeps running until you press **Restart relay** in the version notice: same key, same chat, new code.

> Start relay sometimes needs a double-click in the desktop app: the first click can just focus the pane. That's the desktop app's behavior, not crew's.

**Or the classic way:** double-click **`server/start-relay.bat`**. The first time, it creates a random key, then prints the key and your IP addresses. The key and the saved chat, tasks and docs live in **`%USERPROFILE%\.claude\crew-relay`** (`crew_key.txt`, `crew_state.json`), so they survive plugin updates; older versions kept them next to the .bat, and the first start moves the newest copy over. Keep the window open, because closing it stops the relay. When Windows Firewall asks, allow the relay on **private** networks.

On another OS, run:

```bash
python server/relay.py --key-file crew_key.txt
```

## 2. Put everyone on one network
- **Tailscale (recommended):** free and encrypted, with no port forwarding. Use `http://<host's 100.x IP>:7777`.
- **Radmin VPN:** everyone joins the same network. Use `http://<host's 26.x IP>:7777`.
- **Same LAN:** use the host's LAN IP.

Never expose the relay to the open internet. The shared key is its only lock, and the traffic is plain HTTP; the VPN is what encrypts it.

## 3. Everyone installs the plugin
In a terminal, run these two commands:

```bash
claude plugin marketplace add Umbyzz/claude-crew
```

```bash
claude plugin install crew@claude-crew
```

Then restart Claude. The plugin installs at user scope, so it loads in the Claude desktop app's Code tab as well as in the terminal.

If `claude` isn't recognised, you probably only have the desktop app. Either download this repo as a zip from GitHub and upload it as a plugin in the desktop app, or run the app's own `claude.exe` by its full path (it lives under `%APPDATA%\Claude\claude-code\<version>\`). Both kinds of install update themselves with **Install update** afterwards.

## 4. Connect
Type `/crew`. The first time, a short setup asks your name, then **Host a crew** or **Join a friend's crew** (paste the Relay URL and Crew key from their invite). Everything can be changed later in the **⚙ Settings** tab (each field saves when you press Enter; **Test connection** checks it):

| Setting | What it does | Default |
|---|---|---|
| Relay URL | the relay's address from step 2 | — |
| Your name | how teammates see you; must be unique | — |
| Crew key | the relay's key | — |
| Auto-run requests | start a turn when a request addressed to you arrives: `off`, only from the `leader`, or from `anyone` | `leader` |
| Notifications | which messages pop up: `all`, only ones to you (`direct`), or `off` | `all` |
| Check in every | how often to check the relay: 2, 3, 5 or 10 seconds | 3 |
| Crewshared check every | how often your Crewshared drop folder is checked for changes to send (⇅ Sync now sends at once) | 2 min |
| Clawds window with /crew | pop out the Clawds window whenever you open `/crew` | `yes` |
| Who can join *(host only)* | `anyone with the crew key`, or `friends only` (personal keys) | anyone with the key |

Settings are stored in `~/.claude/settings.json` under `pluginConfigs`, and the key is stored there too. The Clawds window reads them from the same place. Crew also keeps its own copy of the key that works (a new crew key, or a personal key from the host), so a settings save that doesn't stick can't lock you out.

## 5. Make your friends friends (optional, recommended)
Once everyone's connected, the host opens the **Crew** tab and presses **★ Friend** next to each person. Their personal key reaches them by itself, tied to their name. Then **⚙ Settings → Who can join → friends only** turns the shared crew key off, so an invite that went astray can't get anyone in.

---
[← Back to the README](../README.md)
