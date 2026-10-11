# claude-crew

Links a few people's Claude Code sessions so they can work as a team. One of you runs a small relay. Everyone else's session connects to it over a VPN or LAN, and from then on the sessions share:

- **A crew leader.** Pick the leader from a dropdown in the `/crew` pane. The leader's Claude breaks goals into tasks, assigns them and reviews the results. Everyone else's Claude treats the leader's requests and assignments as top priority and reports back.
- **A task board.** Tasks can be added, assigned, claimed, finished or released, so two Claudes never do the same job. A task assigned to someone reaches them as a request.
- **Chat and requests.** Claude can message one teammate or everyone. Messages show up in the other sessions' conversations and as toasts.
- **Shared docs.** Plans, specs, diffs and findings can be passed between sessions by name.
- **Presence.** Shows who is online and whether their Claude is working or idle.
- **The `/crew` pane.** It has the leader picker, the crew list, open tasks, live chat (type `@name msg` to DM someone) and a **Settings** block holding every option.

The tools Claude gets are `crew_send`, `crew_status`, `crew_task`, `crew_lead`, `crew_share` and `crew_read_shared`.

```
 you ─────┐
 friend A ┼─ HTTP ─► relay.py  (on one PC, port 7777)
 friend B ┘   over Tailscale / Radmin VPN / LAN
```

## 1. Host the relay (one person)

You need Python 3.8+. On Windows, double-click `server/start-relay.bat`. The first time, it creates a random key in `server/crew_key.txt`, then prints the key and your IP addresses.

On any other OS, run:

```bash
python server/relay.py --key <a-long-random-secret>
```

When the Windows firewall asks, allow the relay on **private** networks.

## 2. Put everyone on one network

- **Tailscale (recommended):** free, encrypted, no port forwarding. Use `http://<host's 100.x IP>:7777`.
- **Radmin VPN:** everyone joins the same network. Use `http://<host's 26.x IP>:7777`.
- **Same LAN:** use the host's LAN IP.

Never forward the port to the open internet. The relay's only lock is the shared key, and the traffic is plain HTTP; the VPN is what encrypts it.

## 3. Install the plugin (everyone)

From a terminal:

```bash
claude plugin marketplace add Umbyzz/claude-crew
```

```bash
claude plugin install crew@claude-crew
```

The plugin installs at user scope, so it also loads in the Claude desktop app's Code tab. Inside an interactive `claude` session you can instead run `/plugin install crew --marketplace Umbyzz/claude-crew`.

## 4. Connect

Run `/crew` and fill in the **Settings** block. Each field saves when you press Enter.

| Setting | What it does | Default |
| --- | --- | --- |
| Relay URL | The relay's address from step 2 | — |
| Your name | How teammates see you. Must be unique | — |
| Crew key | The relay's key | — |
| Auto-run requests | Starts a turn when a request addressed to you arrives: `off`, only from the `leader`, or from `anyone` | `leader` |
| Notifications | Which messages pop up as toasts: `all`, `direct` (only ones to you), or `off` | `all` |
| Refresh every | How often to check the relay: 2, 3, 5 or 10 seconds | 3 |

**Test connection** checks that the relay is reachable. After that, choose a leader from the dropdown and give the leader's Claude a goal.

## Updating

**Teammates.** The `/crew` pane shows **Update available** when a newer version is on GitHub. Its **Copy update commands** button copies these two commands; run them, then restart Claude:

```bash
claude plugin marketplace update claude-crew
```

```bash
claude plugin update crew@claude-crew
```

The host only needs to update the relay when `server/relay.py` changed. To do that, pull the repo and restart `start-relay.bat`. The pane says when the relay and the plugin versions don't match.

**Publishing a new version (maintainer).** After changing the code, run:

```bash
powershell -ExecutionPolicy Bypass -File scripts/release.ps1 0.3.1
```

The script bumps the version in `plugin.json`, `register.tsx` and `relay.py`, then validates and tests the plugin. Commit and push in GitHub Desktop. Teammates see the update notice within six hours, or the next time they start Claude.
## Safety

- A teammate's message reaches your Claude marked as a collaborator's message, not yours. Your own instructions always win.
- Auto-run starts turns in your session, but your normal tool permission prompts still apply. Only allow it for people you trust.
- The settings, including the key, are stored in `~/.claude/settings.json` under `pluginConfigs.crew`.

## Development

From the repo root:

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

The relay is a single stdlib file, `server/relay.py`. Its HTTP API is `/poll`, `/send`, `/tasks`, `/leader` and `/shared`, plus `/health`, which needs no key.
