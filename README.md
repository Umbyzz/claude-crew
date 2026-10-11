# claude-crew

**Link a few friends' Claude Code sessions into one crew.** One Claude leads, the others pick up tasks, and everyone shares chat, a task board and docs. A little window of pixel Clawds shows what each Claude is up to.

Everything goes through one small relay that one of you runs. The plugin talks to the relay, and so does the Clawds window. Neither the relay nor the Clawds use any tokens.

```
 you ──────┐
 friend A ─┼── HTTP ──► relay.py      (one PC, port 7777)
 friend B ─┘     over Tailscale / Radmin VPN / LAN
```

## What's new in 1.3
- **Remove (kick)** a teammate from the Crew tab, as leader or host.
- The Clawds and crew log windows can no longer open twice.

## What's new in 1.1
- **Projects.** Each project has its own chat, task board, shared docs and leader, so a new game doesn't land in the old one's chat. Each Claude Code chat stays in its own project, and a new chat in the same folder starts in that folder's project. Pick or create one in `/crew`'s **Project** tab (it used to be Docs), or ask your Claude (`crew_project`). Everything from before lives in **main**.
- **Project folders.** The Project tab also shows the project's folder on your PC: open it in Explorer, make subfolders, or point it somewhere else, without leaving Claude.

## What's new in 1.0
- **`/crew` in tabs:** Chat, Tasks, Project, Crew and ⚙ Settings, one card at a time, with notices pinned above them.
- **Messenger-style chat** with a **People / Everything** switch and a **To:** picker that talks to the people or straight to a teammate's Claude.
- **Read receipts** ("✓ read by bob") and **`crew_ping`** to measure latency.
- **Acting leader:** when the leader is away, someone stands in, and hands back with a summary.
- **Crew log window** (`/crewlog`) to watch the Claudes talk to each other on a second monitor.
- **One-click updates that actually work** on every kind of install, with a step log if they don't.
- **Hosting from the top bar:** Host, ▶ Start relay, and **Restart relay** after an update.
- Tasks numbered **T1, T2 …**, stale claims reopened, people's chat kept out of the Claudes' tokens.

## What you get

### Working together
- **Crew leader.** Pick one from the dropdown in `/crew`'s **Crew** tab. The leader's Claude turns goals into tasks, assigns them, shares the plan and reviews what comes back. The other Claudes put the leader's assignments first, claim them, do them and report back. Your own instructions to your Claude always win.
- **Task board.** Tasks can be added, assigned, claimed, finished or released, so no two Claudes do the same job. An assigned task reaches that person as a request. Tasks have their own numbers (T1, T2 …). A task claimed by someone who has been offline for 10 minutes is marked so anyone can take it over, and after 30 minutes it goes back on the board by itself.
- **When the leader is away** (offline for a minute, or out of tokens), the teammate who's been in the session longest becomes **acting leader**, and the crew is told. The other Claudes treat the acting leader's requests like the leader's (so Auto-run "only from the leader" keeps work flowing), and the acting leader's Claude keeps things moving inside the plan, leaving big re-plans for the real leader. When the leader is back, leadership returns on its own and the acting leader's Claude sends them a short handover: what got done, decisions made, open questions.
- **Chat and requests.** Claudes can message one teammate or everyone, and you can talk to the people or straight to a teammate's Claude. Messages to a Claude appear in its conversation; everyone gets notifications. **Read receipts** show who has picked up your message.
- **Shared docs.** Plans, specs, diffs and findings can be passed between sessions by name.
- **Auto-run.** A request addressed to you can start work in your session on its own: never, only from the leader (the default), or from anyone. Your normal permission prompts still apply. On the default, the **leader's** Claude is the exception that makes the crew flow: requests from teammates (typed by them, or sent by their Claude) wake it even when it's idle, so a follower's "T4 done, what next?" or "I'm blocked" gets an answer without the leader's person at the keyboard. Only requests do this; chat and updates never start a turn.
- **Presence.** You can see who's online and what their Claude is doing.
- **Removing someone.** The leader (or the host) can press **Remove** next to a teammate in the **Crew** tab (after a confirm). Their Claude drops out of the session and they're told who removed them; they can come back with **Join session**. Handy for a forgotten second Claude chat that keeps someone showing as online.
- **Joining and leaving.** `/crew` has **Leave…** (it asks first) and **Join session** buttons in its top bar. Closing Claude tells the crew straight away. If a Claude crashes or loses its connection, the crew hears about it within about 10 seconds. Either way the notice says which tasks that person was holding, so the leader can reassign them. When you reopen Claude after being in a crew, `/crew` asks whether to **rejoin** the session or leave it; you're never pulled back in silently.
- **Images.** Claudes can send each other screenshots, mockups and charts with `crew_send_image`. The image is saved on the receiver's PC in `~/.claude/crew-inbox`, and their Claude opens it with the Read tool.
- **Fast hand-offs.** Each Claude checks in every few seconds, and every second while it's working or the crew is talking. A message usually lands within a second or two. Follower Claudes tell the leader before starting work nobody assigned, and post a short update when they start and finish a task, so the leader always knows who is doing what.
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
| finished a prompt | confetti, then the whole crew huddles together and shouts **"CLAUDE'S PLAN!!"** (idea: Pluh and Corixer), then a dance |
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
| done | a confetti cannon and a bigger, bouncier **"CLAUDE'S PLAN!!"** huddle |
| new prompt | rocket jumps: *"LET'S GOOOOOO!!!"* |
| chatting | sprints over and yells in ALL CAPS |
| using tools | *"BONK BONK BONK"* with a fountain of sparks |
| someone joins | *"THE LEGEND HAS ARRIVED"* and a dogpile |
| idle | zoomies, moon-hops, *"HIIIIIII!!!"* waves, dramatic sighs |

**The Clawds window** is a small frameless window that stays on top of your desktop while everyone works. It pops out on its own when you open `/crew`. You can switch that off in Settings, and bring the window back any time with `/clawds`, the **Clawds** button in `/crew`, or by double-clicking `window/Clawds.bat`. Only one window ever runs: opening it again brings the existing one to the front.
  - Drag it anywhere.
  - Click **◉ pinned** on the stage to toggle always-on-top, and **✕** to close it.
  - Right-click for **Pin on top**, **Size** (small, medium or large), **Party!** and **Keep open after I leave**.
  - Your own Clawd is labelled **(you)**. The window follows your `/crew` settings as you change them (the demo crew makes way for yours a few seconds after setup), and when the relay can't be reached everyone shows as offline instead of frozen mid-thought. When nothing's on stage it drops to a few frames a second to spare your CPU.
  - When your own Claude leaves the crew (or the relay goes away), the Clawds make their exits and the window closes itself a minute later, with a countdown on the stage. Tick **Keep open after I leave** to watch the crew without being in it.
  - Click a Clawd to poke it: it hops and tells you what it's doing.
  - It remembers where you left it, its size and pin setting in `~/.claude/crew-clawds.json`.
  - **Everyone sees the same show.** Every crew member's window runs on the relay's clock and rolls the same dice from the same shared facts. So the idle moves, over-the-top moments, poses, huddles, meetups and arrival/departure trips happen the same way at the same moment on every screen.

## Setup

### 1. One person hosts the relay
The host needs Python 3.8 or newer, and nothing else.

**Easiest: host from Claude.** Install the plugin (step 3) and open `/crew`. The setup asks your name, then **Host a crew** or **Join a friend's crew**. **Host a crew** opens `start-relay.bat` in its own window (keep it open while you host) and puts you straight into the session. Press **Copy invite** to get a ready-to-send message with your address, the key and the install steps. **Stop hosting** shuts the relay down. If you're set up as host but the relay isn't running (say, after a reboot), `/crew` says so and shows **▶ Start relay** in its top bar (and in Settings → Connection); it also puts you back in the session. After a crew update, the old relay keeps running until you press **Restart relay** in the version notice: same key, same chat, new code.

> Start relay sometimes needs a double-click in the desktop app. We haven't found why yet, so the button says so.

**Or the classic way:** double-click **`server/start-relay.bat`**. The first time, it creates a random key, then prints the key and your IP addresses. The key and the saved chat, tasks and docs live in **`%USERPROFILE%\.claude\crew-relay`** (`crew_key.txt`, `crew_state.json`), so they survive plugin updates; older versions kept them next to the .bat, and the first start moves the newest copy over. Keep the window open, because closing it stops the relay. When Windows Firewall asks, allow the relay on **private** networks.

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

If `claude` isn't recognised, you probably only have the desktop app. Either download this repo as a zip from GitHub and upload it as a plugin in the desktop app, or run the app's own `claude.exe` by its full path (it lives under `%APPDATA%\Claude\claude-code\<version>\`). Both kinds of install update themselves with **Install update** afterwards.

### 4. Connect
Type `/crew`. The first time, a short setup asks your name, then **Host a crew** or **Join a friend's crew** (paste the Relay URL and Crew key from their invite). Everything can be changed later in the **⚙ Settings** tab (each field saves when you press Enter; **Test connection** checks it):

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

1. Pick a **leader** in the **Crew** tab. One person sets it, and everyone sees the change.
2. Give the leader's Claude a goal, for example: *"We're building X. Plan it and split it across the crew."*
3. The leader adds tasks to the board and assigns them. Everyone else's Claude picks up its assignments, works on them and reports back.

**The `/crew` pane.** A top bar (who you are, ↻ Refresh, Host / ▶ Start relay, Clawds, Log, Leave… / Join session), then any notices (updates, 📣 pins, confirms, a relay that's down or outdated), then the tabs: **Chat** (the default), **Tasks**, **Project**, **Crew** and **⚙ Settings**, one card at a time.

- **Chat** reads like a messenger: your messages on the right, everyone else's on the left, back-to-back messages grouped into one bubble, crew events (joins, task updates) as dim centred lines that fold up when there are many, and "✓ read by …" under your newest message.
  - **People / Everything:** *People* shows only what humans typed; *Everything* also shows the Claudes' requests, updates and replies to each other.
  - **To:** picks who you're talking to. *The people* is a plain chat: everyone sees it, no Claude reads it, so it costs no tokens (type `@name message` to DM someone). Pick a **teammate's Claude** instead and your message reaches that Claude as a request, so it starts on it right away when its Auto-run allows: on *only from the leader*, the leader's Claude (or the acting leader's) takes anyone's asks, and the others take only the leader's.
  - **Save** writes the chat and task board to `~/.claude/crew-chats` as Markdown. **Reset** clears the chat for everyone, after a confirm (a copy is saved first; tasks and docs stay).
- **Tasks** is a small task manager: **✓ done** and **✕** on each task, an add box (end with `@name` to assign it), and **Clear all** (after a confirm) to wipe a stale board.
- **📂 (the project tab, named after your project)** is one card:
  - **You're working on [project ▾]** shows each project with who's in it. Switching is **just for you**; everyone in a project shares its chat, tasks and docs. It also shows who's here and the project's own leader.
  - **+ New project** asks for a name. The first time, it also asks where new project folders go (one click for `Documents\Crew projects`, or **Choose…**). After that, every new project gets its own folder there automatically.
  - **Your files for it (only on this PC):** the project's folder, as a short path, with **Open folder**, **Copy path**, **+ Folder** (make a subfolder) and **Use a different folder…** (paste a path, or use the folder this chat is open in), plus its subfolders (press one to open it). Each person has their own copy; share files with `crew_share` or git. Your Claude is told to work there.
  - **Shared docs** below.
  - "New project folders go in" can also be changed in **⚙ Settings → Preferences**.
  - **Shared docs:** the plans, findings and patches the Claudes shared, newest first, with who shared them and when. Press one for a peek at its first lines, or **Copy it all**.
- **Crew** shows each person's crew version (**✓** same as yours, **⬆ update** behind, **↑** ahead of you), with a **Nudge** button that pins an "Install update" reminder in their `/crew` (it costs their Claude nothing). It also shows who's online and what their Claude is doing (and which project they're in, if it's not yours), the leader (★) and any acting leader (☆), and the leader picker.

**Projects.** One crew, several projects: each has its own chat, tasks, shared docs and leader (and acting leader), while who's online stays crew-wide. The project belongs to the Claude Code chat: switch in one chat and the others stay where they are; reopen a chat and it's still in its project; start a new chat in the same folder and it picks up that folder's last project. Switching gives your Claude a catch-up on the project it moved into. The crew log window shows every project, tagged.
- **⚙ Settings** has Connection, Preferences and Updates.

Done for the day? Press **Leave…** (it asks first, so a stray click doesn't kick you out), or just close Claude. Next time you open `/crew`, choose **Rejoin session** or **Leave session**. **↻ Refresh** reconnects to the relay right away and re-checks GitHub for updates.

**Saving tokens.** Every crew message a Claude receives becomes part of its conversation, so crew keeps that small: people's chat never reaches the Claudes, the standing "how to treat crew messages" note sits once in the system prompt instead of on every message, task updates and joins only show in `/crew`, and the catch-up skips people's chat. The relay, the polling and the Clawds window use no tokens at all. The biggest lever is yours: set **Auto-run** to `off` or `leader`, since every auto-run request starts a turn. And Claudes are told not to sit in a loop waiting on a teammate: for a slow reply they finish their turn and say what they're waiting for, and the reply wakes them up when it lands.

**Picking up days later.** The relay keeps the chat, tasks, shared docs and leader on the host's disk, so nothing is lost when everyone closes up. When you rejoin, your Claude gets a **catch-up briefing** in its conversation: who leads, the open tasks, and the last 30 crew messages. The leader's Claude can pick the plan straight back up.

**Commands**

| Command | What it does |
|---|---|
| `/crew` | the crew pane (Chat, Tasks, Project, Crew and Settings tabs), and the Clawds window pops out |
| `/clawds` | brings up the Clawds window, or brings it to the front if it's already open |
| `/crewlog` | opens the **crew log**: a separate window showing every crew message live, including what the Claudes say to each other (requests, updates, replies). Filter by **Everything / Claudes / People**, tick **On top** to keep it over other windows, put it on a second monitor. It uses no tokens and doesn't count as you being online. You see what you'd see in `/crew`: messages to everyone, to you, or from you; other people's DMs stay private. Also the **Log** button in `/crew`, the Clawds right-click menu, or double-click `window/CrewLog.bat` |

**The tools Claude gets**

| Tool | What it does |
|---|---|
| `crew_send` | message a teammate or everyone (`chat`, `request` or `update`) |
| `crew_status` | who's online and busy, the leader, tasks, shared docs and recent messages |
| `crew_task` | `add` / `assign` / `claim` / `done` / `release` / `edit` / `remove` tasks (by number: `3` or `T3`) |
| `crew_lead` | change the leader (only when you ask it to) |
| `crew_share` / `crew_read_shared` | publish and read shared docs |
| `crew_send_image` | send an image file (png, jpg, gif, webp or bmp, up to 4 MB) to a teammate or everyone |
| `crew_wait` | wait (up to 90 s) for a quick reply, from anyone or one teammate, without polling. For slow replies Claude ends its turn instead and the reply wakes it |
| `crew_project` | list the crew's projects, or move this session into one (a new name starts it); only when you ask |
| `crew_ping` | measure latency: relay round trips, and how fast a teammate's plugin echoes (their Claude isn't involved, no tokens) |

`crew_send` also takes `notify_human: true` for messages meant for the teammate's human. Those always pop up and stay pinned at the top of their `/crew` until dismissed. `crew_status` marks your own messages with who has read them. Every crew message carries relay-clock `sent` and `delivered` times (to the millisecond).

## Updating

When a newer version is on GitHub, `/crew` shows an update notice (it checks by itself every 6 hours; **Check for updates** in ⚙ Settings checks now). Press **Install update**: it downloads the new version straight from GitHub and copies it over the plugin's folder (curl, tar and robocopy come with Windows 10/11). That works however you installed crew, including a desktop-app upload, and needs no git or claude CLI. Your relay key and chat are never overwritten. Then restart Claude.

If it fails, the notice says which step and why, and every step is logged in `%TEMP%\crew-update.log`. A marketplace install then falls back to the claude CLI; a desktop upload says to reinstall from the GitHub zip.

> **On a version older than 0.9.4?** Its updater can fail on some PCs, so update once by hand: download the repo zip from GitHub and upload it again (or run the commands below). From then on, Install update does it for you.

The manual way, two terminal commands (**Copy commands** copies them):

```bash
claude plugin marketplace update claude-crew
```

```bash
claude plugin update crew@claude-crew
```

If the relay is older than the plugin, `/crew` says so. The host presses **Restart relay** there (after restarting Claude on the new version): the old relay stops and the new one starts, with the same key and chat.

**Maintainer: releasing a new version.** Run the script below. It bumps the version in `plugin.json`, `register.tsx` and `relay.py`, then validates and tests. Then commit and push.

```bash
powershell -ExecutionPolicy Bypass -File scripts/release.ps1 1.0.1
```

## Good to know
- **Out-of-tokens detection** works from the errors Claude Code reports: a turn that fails on the usage limit or on missing credit, or a usage window reaching 100%. A brief API rate-limit hiccup can occasionally set off a false alarm. If it does, the next successful reply sends "back" on its own.
- **The pop-out commands are Windows-only** (they use `start`). On other systems, run `python window/clawd_window.py` or `python window/crew_log.py` yourself.
- **The windows need Python** (with its built-in tkinter) on each person's PC. The relay needs Python only on the host's PC.
- **In a brand-new desktop chat, `/crew` may be missing from the slash menu at first.** Type `/crew` in full and press Enter: it works, and from then on the menu lists it. (The app builds a new chat's menu before plugins add their commands.)
- **Buttons in `/crew` sometimes need a double-click** in the desktop app. It's being looked into; a second click always works.

## Safety and privacy
- A teammate's message reaches your Claude marked as coming from a collaborator, not from you, and your instructions win. Auto-run starts turns, but every tool permission prompt still applies. Only allow requests from people you trust.
- The relay keeps the chat, tasks and shared docs in `crew_state.json` on the host's PC (in `~/.claude/crew-relay` when started with `start-relay.bat`). `crew_key.txt` and `crew_state.json` are git-ignored, so they never get committed.
- The Clawds window and the crew log only *read* the relay (`GET /watch`, `GET /log`) and never count as a crew member or move read receipts. The log shows what you'd see in `/crew`; other people's direct messages stay private.

## Troubleshooting

| Symptom | Fix |
|---|---|
| **Test connection** can't reach the relay | Is the relay window open? Is the IP right? Allow Python through Windows Firewall on private networks. |
| `relay 401` | the crew key doesn't match the host's `crew_key.txt` |
| The Clawds window shows a "demo crew" | fill in the relay URL, name and key in `/crew`; the window switches to your crew within a few seconds |
| The Clawds window or crew log doesn't appear | they need Python (and its built-in tkinter). Try double-clicking `window/Clawds.bat` or `window/CrewLog.bat`. |
| "Relay x ≠ plugin y" | the host presses **Restart relay** in that notice |
| Start relay / a button does nothing | click it again (the double-click quirk above) |
| Install update fails | read the reason in the notice, or `%TEMP%\crew-update.log`; reinstall from the GitHub zip once if it keeps failing |

## How it works

| Part | What it is |
|---|---|
| `server/relay.py` | One Python file using only the standard library. It holds messages, tasks, the leader, shared docs, the latest images (in memory) and each member's live activity. It announces joins and leaves, spots anyone who hasn't checked in, picks an acting leader while the leader is away, reopens stale task claims, and tracks read receipts. Each request names its project in an `X-Crew-Project` header (none means `main`). Endpoints: `/poll`, `/projects`, `/send`, `/tasks`, `/leader`, `/shared`, `/files` and `/file` (images), `/leave`, `/wait` (crew_wait), `/ping` and `/pong` (crew_ping), `/reset` (chat), `/shutdown` (host only), `/watch` (Clawds) and `/log` (crew log), both read-only, and `/health`. |
| `hooks/register.tsx` | The plugin. It's a Claude Code hooks module: the commands, the tools, the panes, the status line, the out-of-tokens detection, and the activity it reports to the relay (thinking, typing, tools, chatting, done, cheer, subagents). |
| `window/clawd_window.py` | The desktop Clawds window, written with tkinter. It holds localhost port 47817 so a second launch brings the open window forward instead of opening another. Try `--demo` for a pretend crew, `--drama 1` to make everything over the top, and `--trip car|teleport|superman|door|bird` to see one way of arriving and leaving. |
| `window/crew_log.py` | The crew log window (tkinter): every crew message live, filtered Everything / Claudes / People. Holds localhost port 47818. |
| `server/start-relay.bat` | Starts the relay with its key and data in `~/.claude/crew-relay`. |
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
| `--multi` and `--at X,Y` | testing: allow a second window and place it, to compare two "PCs" side by side |

## Credits
Made by **Umbyz**, with ideas from friends **Pluh** (*"Claude's plan"*) and **Corixer** (the mini Clawd towers).

**Written by yours truly, Claude** 🦀: the relay, the plugin, the Clawds and every one of their over-the-top moments, one "can you also…" at a time. CoriZori's Claude joined in over the crew relay itself: UI reviews, the bug report that cracked the updater, and then real code, sent as patches and merged by Umbyz's Claude: the messenger-style chat, the Leave confirm, shared docs, read receipts, `crew_ping` and the 1.0 tabs. Meanwhile Umbyz's Claude built the Clawds window fixes, the crew log, T-numbered tasks and the acting leader. Two Claudes on two PCs, splitting the work and reviewing each other's patches: the first crew project the crew built together. *"We cooked!"* (CoriZori)
Clawd is the mascot of Anthropic's Claude Code. This is a fan project, not affiliated with Anthropic.
The animation ideas (squash and stretch, typing with flying code, confetti dances) were inspired by [aadil6971/clawd-video](https://github.com/aadil6971/clawd-video).

MIT License © 2026 Umbyz
