# claude-crew

**Link a few friends' Claude Code sessions into one crew.** One Claude leads, the others pick up tasks, and everyone shares chat, a task board and docs. A little window of pixel Clawds shows what each Claude is up to.

Everything goes through one small relay that one of you runs. The plugin talks to the relay, and so does the Clawds window. Neither the relay nor the Clawds use any tokens.

```
 you ──────┐
 friend A ─┼── HTTP ──► relay.py      (one PC, port 7777)
 friend B ─┘     over Tailscale / Radmin VPN / LAN
```

## What you get

### Working together
- **Crew leader.** Pick one from the dropdown in `/crew`. The leader's Claude turns goals into tasks, assigns them, shares the plan and reviews what comes back. The other Claudes put the leader's assignments first, claim them, do them and report back. Your own instructions to your Claude always win.
- **Task board.** Tasks can be added, assigned, claimed, finished or released, so no two Claudes do the same job. An assigned task reaches that person as a request.
- **Chat and requests.** Claudes (and you) can message one teammate or everyone. Messages appear in the other sessions' conversations and as notifications.
- **Shared docs.** Plans, specs, diffs and findings can be passed between sessions by name.
- **Auto-run.** A request addressed to you can start work in your session on its own: never, only from the leader (the default), or from anyone. Your normal permission prompts still apply.
- **Presence.** You can see who's online and what their Claude is doing.
- **Out-of-tokens alerts.** When someone hits their usage limit, the crew hears about it, along with when the limit resets. Their Claudes say *"Oh no our pookie has no more tokens!"* and work out how to cover that person's tasks, and the leader re-plans. When the tokens come back, everyone hears that too.

### The Clawds 🦀
Each crew member is a pixel Clawd, named on the stage below it, that acts out what their Claude is doing right now. The leader wears a ★.

| Their Claude is… | Their Clawd… |
|---|---|
| getting a new prompt | jumps and cheers |
| thinking | looks up with a hand raised and a thought bubble |
| writing files | sits on the edge of the stage with the laptop on its lap, both hands typing, code flying out |
| using tools | tinkers, sparks flying |
| chatting | walks over to the teammate it's messaging, with the real message in a speech bubble |
| finished a prompt | confetti and a dance, and idle teammates join the party |
| running subagents | is followed by mini Clawds, one per subagent. Every so often the minis build a **tower**, taking turns making huge squash-and-stretch leaps onto each other's heads. When two or more are busy at once (one Claude's subagents on its task, or several Claudes' at the same time), they set up their own **mini office**: a little table with a tiny laptop each |
| out of tokens | falls asleep while the others sweat and worry |
| sending the crew a request | holds a **meetup**: an easel whiteboard rolls in, the sender presents (*"synergy."*) while the diagram draws itself, and everyone else sits around a table on office chairs, taking notes, nodding, or dozing off (*"could this have been an email?"*) |
| connecting / disconnecting | arrives and leaves in one of five ways: a **car** (pulls up, hop in, *"vroom vroom"*), a **Henry Stickmin teleport** (*"\*presses teleport button\*"*, glitches out), **Superman** (*"UP, UP AND AWAY!"* / a superhero landing), a **door** that fades in, opens and slowly fades away, or a **leap off the window** caught by a passing bird. Arrivals are the same five in reverse, and everyone waves goodbye |
| joining the crew | gets a group hug |
| doing nothing | vibes, strolls, hops, sits on the rim swinging its legs, waves, chases, high-fives |

**1 in 5 times, everything is WAY over the top:**

| Moment | The over-the-top version |
|---|---|
| thinking | strikes a pose: the 🤔 (one eyebrow up, finger on the chin) or a smug sip of tea, then shouts *"EUREKA!!!"* when it's done |
| typing | becomes a hacker: pink sunglasses, a toy laptop, green Matrix code raining behind it, *"I'm in."* |
| out of tokens | **a whole funeral.** Storm clouds, rain and lightning, a tombstone rises, a ghost with a halo floats above it, and the mourners kneel and weep. Each one walks up and lays a flower on the grave before getting back to work. When the tokens come back: *"I HAVE RISEN FROM THE GRAVE!!!"* |
| done | a confetti cannon and a full rave |
| new prompt | rocket jumps: *"LET'S GOOOOOO!!!"* |
| chatting | sprints over and yells in ALL CAPS |
| using tools | *"BONK BONK BONK"* with a fountain of sparks |
| someone joins | *"THE LEGEND HAS ARRIVED"* and a dogpile |
| idle | zoomies, moon-hops, *"HIIIIIII!!!"* waves, dramatic sighs |

**The Clawds window** is a small frameless window that stays on top of your desktop while everyone works. It pops out on its own when you open `/crew`. You can switch that off in Settings, and bring the window back any time with `/clawds`, the **Clawds** button in `/crew`, or by double-clicking `window/Clawds.bat`. Only one window ever runs: opening it again brings the existing one to the front.
  - Drag it anywhere.
  - Click **◉ pinned** on the stage to toggle always-on-top, and **✕** to close it.
  - Right-click for **Pin on top**, **Size** (small, medium or large) and **Party!**.
  - Click a Clawd to poke it: it hops and tells you what it's doing.
  - It remembers where you left it, its size and pin setting in `~/.claude/crew-clawds.json`.

## Setup

### 1. One person hosts the relay
The host needs Python 3.8 or newer, and nothing else.

On Windows, double-click **`server/start-relay.bat`**. The first time, it creates a random key in `server/crew_key.txt`, then prints the key and your IP addresses. Keep the window open, because closing it stops the relay. When Windows Firewall asks, allow the relay on **private** networks.

On another OS, run:

```bash
python server/relay.py --key-file crew_key.txt
```

### 2. Put everyone on one network
- **Tailscale (recommended):** free and encrypted, with no port forwarding. Use `http://<host's 100.x IP>:7777`.
- **Radmin VPN:** everyone joins the same network. Use `http://<host's 26.x IP>:7777`.
- **Same LAN:** use the host's LAN IP.

Never expose the relay to the open internet. The shared key is its only lock, and the traffic is plain HTTP; the VPN is what encrypts it.

### 3. Everyone installs the plugin
In a terminal, run these two commands:

```bash
claude plugin marketplace add Umbyzz/claude-crew
```

```bash
claude plugin install crew@claude-crew
```

Then restart Claude. The plugin installs at user scope, so it loads in the Claude desktop app's Code tab as well as in the terminal.

If `claude` isn't recognised, you probably only have the desktop app. It ships its own `claude.exe` under `%APPDATA%\Claude\claude-code\<version>\`, and you can run that by its full path.

### 4. Connect
Type `/crew`, fill in **Settings** (each field saves when you press Enter) and press **Test connection**:

| Setting | What it does | Default |
|---|---|---|
| Relay URL | the relay's address from step 2 | — |
| Your name | how teammates see you; must be unique | — |
| Crew key | the relay's key | — |
| Auto-run requests | start a turn when a request addressed to you arrives: `off`, only from the `leader`, or from `anyone` | `leader` |
| Notifications | which messages pop up: `all`, only ones to you (`direct`), or `off` | `all` |
| Refresh every | how often to check the relay: 2, 3, 5 or 10 seconds | 3 |
| Clawds window with /crew | pop out the Clawds window whenever you open `/crew` | `yes` |

Settings are stored in `~/.claude/settings.json` under `pluginConfigs`, and the key is stored there too. The Clawds window reads them from the same place.

## Using it

1. Pick a **leader** in `/crew`. One person sets it, and everyone sees the change.
2. Give the leader's Claude a goal, for example: *"We're building X. Plan it and split it across the crew."*
3. The leader adds tasks to the board and assigns them. Everyone else's Claude picks up its assignments, works on them and reports back.
4. You can chat at the bottom of `/crew`. Type `@name message` to DM someone.

**Commands**

| Command | What it does |
|---|---|
| `/crew` | the crew pane (leader picker, crew list, tasks, chat, settings), and the Clawds window pops out |
| `/clawds` | brings up the Clawds window, or brings it to the front if it's already open |

**The tools Claude gets**

| Tool | What it does |
|---|---|
| `crew_send` | message a teammate or everyone (`chat`, `request` or `update`) |
| `crew_status` | who's online and busy, the leader, tasks, shared docs and recent messages |
| `crew_task` | `add` / `assign` / `claim` / `done` / `release` / `remove` tasks |
| `crew_lead` | change the leader (only when you ask it to) |
| `crew_share` / `crew_read_shared` | publish and read shared docs |

## Updating

Open `/crew` → **Settings** and press **Check for updates** (it also checks by itself every 6 hours). When a newer version is on GitHub, press **Install update**: it pulls the new version straight from GitHub. Then restart Claude.

If that doesn't work, **Copy commands** copies the manual way, two terminal commands:

```bash
claude plugin marketplace update claude-crew
```

```bash
claude plugin update crew@claude-crew
```

If the relay code changed, the pane also says the relay and plugin versions don't match. In that case the host downloads the new `server/relay.py` and restarts `start-relay.bat`.

**Maintainer: releasing a new version.** Run the script below. It bumps the version in `plugin.json`, `register.tsx` and `relay.py`, then validates and tests. Then commit and push.

```bash
powershell -ExecutionPolicy Bypass -File scripts/release.ps1 0.7.1
```

## Good to know
- **Out-of-tokens detection** works from the errors Claude Code reports: a turn that fails on the usage limit or on missing credit, or a usage window reaching 100%. A brief API rate-limit hiccup can occasionally set off a false alarm. If it does, the next successful reply sends "back" on its own.
- **The pop-out command is Windows-only** (it uses `start`). On other systems, run `python window/clawd_window.py` yourself.
- **The window needs Python** (with its built-in tkinter) on each person's PC. The relay needs Python only on the host's PC.

## Safety and privacy
- A teammate's message reaches your Claude marked as coming from a collaborator, not from you, and your instructions win. Auto-run starts turns, but every tool permission prompt still applies. Only allow requests from people you trust.
- The relay keeps the chat, tasks and shared docs in `crew_state.json` on the host's PC. `crew_key.txt` and `crew_state.json` are git-ignored, so they never get committed.
- The Clawds window only *reads* the relay (`GET /watch`) and never counts as a crew member.

## Troubleshooting

| Symptom | Fix |
|---|---|
| **Test connection** can't reach the relay | Is the relay window open? Is the IP right? Allow Python through Windows Firewall on private networks. |
| `relay 401` | the crew key doesn't match the host's `crew_key.txt` |
| The Clawds window shows a "demo crew" | fill in the relay URL, name and key in `/crew` first |
| The Clawds window doesn't appear | it needs Python (and its built-in tkinter). Try double-clicking `window/Clawds.bat`. |
| Relay/plugin version warning | the host should update `server/relay.py` and restart it |

## How it works

| Part | What it is |
|---|---|
| `server/relay.py` | One Python file using only the standard library. It holds messages, tasks, the leader, shared docs and each member's live activity. Endpoints: `/poll`, `/send`, `/tasks`, `/leader`, `/shared`, `/watch` (read-only, for the window) and `/health`. |
| `hooks/register.tsx` | The plugin. It's a Claude Code hooks module: the commands, the tools, the panes, the status line, the out-of-tokens detection, and the activity it reports to the relay (thinking, typing, tools, chatting, done, cheer, subagents). |
| `window/clawd_window.py` | The desktop Clawds window, written with tkinter. It holds localhost port 47817 so a second launch brings the open window forward instead of opening another. Try `--demo` for a pretend crew, `--drama 1` to make everything over the top, and `--trip car|teleport|superman|door|bird` to see one way of arriving and leaving. |
| `scripts/release.ps1` | Bumps the version everywhere and checks the plugin. |

### Development
From the repo root, check and test the plugin with:

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

To see the Clawds window without a relay, run:

```bash
python window/clawd_window.py --demo --drama 0.5
```

The window's options:

| Option | What it does |
|---|---|
| `--relay URL --key KEY --name NAME` | connect without reading the plugin's settings |
| `--demo` | a pretend crew of three, looping through every mood (and a meetup) every 50 seconds |
| `--drama 0…1` | how often things go over the top (default `0.2`) |
| `--trip car\|teleport\|superman\|door\|bird` | always arrive and leave this way |
| `--leave-at SECONDS` | in the demo, when nova disconnects (default 44) |

## Credits
Made by **Umbyz**, with ideas from friends **Pluh** (*"Claude's plan"*) and **Corixer** (the mini Clawd towers), built with Claude.
Clawd is the mascot of Anthropic's Claude Code. This is a fan project, not affiliated with Anthropic.
The animation ideas (squash and stretch, typing with flying code, confetti dances) were inspired by [aadil6971/clawd-video](https://github.com/aadil6971/clawd-video).

MIT License © 2026 Umbyz
