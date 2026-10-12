# Using crew

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
  - **+ New project** asks for a name. The first time, it also asks where new project folders go (one click for `Documents\Crew projects`, or **Choose…** to pick a folder in Windows' folder picker). After that, every new project gets its own folder there automatically, and **whoever makes a project leads it**.
  - **Invite the crew here** (shown when teammates are in other projects) asks everyone over: they get a notice above their tabs, *"Umbyz invites you to the project …"*, with **Switch** or **Not now**. Projects are per person, so nobody gets moved without saying yes.
  - **Your files for it (only on this PC):** the project's folder, as a short path, with **Open folder**, **Copy path**, **+ Folder** (make a subfolder) and **Use a different folder…** (opens Windows' folder picker; **…** lets you paste a path or use the folder this chat is open in), plus its subfolders (press one to open it). Each person has their own copy; share files with `crew_share` or git. Your Claude is told to work there.
  - **Shared docs** below.
  - **Projects** lists every project (yours marked ▸) with how many messages are **new** there for you, who's in it, open tasks and its leader: **Switch** with one press, and **⋯ → Delete project…** (its leader or the host; never `main`), which asks **"You sure?"** and then **"VERY sure??"**. It wipes the project's chat, tasks, docs and leader on the relay for the whole crew (everyone in it goes back to main), and sends its folder to **your Recycle Bin**, but only a folder crew made for it inside your projects home, never one you pointed somewhere else. Teammates' copies on their own PCs stay.
  - "New project folders go in" can also be changed in **⚙ Settings → Preferences**.
  - **Shared docs:** the plans, findings and patches the Claudes shared, newest first, with who shared them and when. Press one for a peek at its first lines, **Copy it all**, or **Delete…** (its author, the project's leader or the host; one confirm).
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

---
[← Back to the README](../README.md)
