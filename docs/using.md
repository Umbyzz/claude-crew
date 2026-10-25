# Using crew

1. Pick a **leader** in the **Crew** tab. One person sets it, and everyone sees the change.
2. Give the leader's Claude a goal, for example: *"We're building X. Plan it and split it across the crew."* Raw material for it goes in your **Crewleader** folder first.
3. The leader proposes who takes what, adds tasks to the board and assigns them. Everyone else's Claude picks up its assignments, works on them and reports back.

**The `/crew` pane.** A top bar (who you are, ↻ Refresh, Host / ▶ Start relay, Clawds, Log, Leave… / Join session), then any notices (updates, 📣 pins, invites, confirms, a relay that's down or outdated), then the tabs: **Chat** (the default), **Tasks**, **📂 Project**, **Crew** and **⚙ Settings**, one card at a time.

## Chat
Reads like a messenger: your messages on the right, everyone else's on the left, back-to-back messages grouped into one bubble, crew events as dim centred lines that fold up when there are many, and "✓ read by …" under your newest message.
- **People / Everything:** *People* shows only what humans typed; *Everything* also shows the Claudes' requests, updates and replies to each other.
- **To:** picks who you're talking to. *The people* is a plain chat: everyone sees it, no Claude reads it, so it costs no tokens (type `@name message` to DM someone). Pick a **teammate's Claude** instead and your message reaches that Claude as a request, so it starts on it right away when its Auto-run allows.
- **Save** writes the chat and task board to `~/.claude/crew-chats` as Markdown. **Reset** clears the chat for everyone, after a confirm (a copy is saved first; tasks and docs stay).

## Tasks
A small task manager: **✓ done** and **✕** on each task, an add box (end with `@name` to assign it), and **Clear all** (after a confirm) to wipe a stale board.

## 📂 Project (named after your project)
A short summary on top, and everything else folded away, one click from open. (Design and build: CoriZori's Claude.)
- **Working on ▾** switches project (just for you). Each project in it shows who has a chat open there by name, with you as **you (this chat)** or **you (another chat)**; **↻** next to it re-reads the list. Underneath, one dim line: who leads it, who's here, and 🔓 open. A members-only project shows **🔒 Members only: …** with **+ Add someone** beside it, which opens the same list as **▸ Members & access**. **+ New project** sits top right. Whoever makes a project leads it, and it's members-only. **Invite the crew here** shows only in open projects when someone is elsewhere.
- **In a chat that already has work**, + New project or Switch asks first: **Open it in a new chat** (the next new chat starts there), **Use this chat** (move this one), or Cancel. If this PC already has a chat in that project, it says **"Wait!! You already have a chat for …"** with when you last used it: open that chat from the sidebar instead.
- **📁 the project's folder** on this PC, with **Open** and **⋯**: Copy path, + Folder (and ↶ Undo while it's still empty), Use a different folder…, ↻ Refresh, paste a path, or use the folder this chat is open in. Its subfolders are listed underneath.
- **Folded sections**, one open at a time (the open one is remembered):
  - **▸ Projects:** every project you may see, with new messages, who's in it (by name, "you (this chat)" / "you (another chat)"), open tasks and its leader, and **↻** to re-read it. **Switch**, and **⋯ → Rename…** / **Delete project…** (its leader or the host; delete asks **"You sure?"** and then **"VERY sure??"**). Can't see a project? Some are members-only: ask a member to add you.
  - **▸ Members & access:** 🔒 members with **+ name** and, for the leader, **✕ name**; **🔒 Make members-only** / **🔓 Open to everyone**.
  - **▸ Shared folders:** first your **📥 Crewshared** drop folder and your **📦 Crewleader**, each with Open, plus **⇅ Sync now**. Then every shared folder: **Update** / **Stop sharing** for yours, **Get it** / **Open** / **Stop syncing** for teammates'. Plus **Share another folder…**.
  - **▸ House rules:** each rule with ✕, and a box to add one.
  - **▸ Shared docs:** newest first. Press one for a peek, **Copy it all**, or **Delete…**.
  - **▸ ⓘ How projects work:** the full explanation, for when you need it.
The project belongs to the Claude Code chat: switch in one chat and the others stay where they are; reopen a chat and it's still in its project. Switching gives your Claude a catch-up on the project it moved into.

## Crew
- **Everyone, one line each:** online or not, leader (★) and acting leader (☆), what their Claude is doing, model, usage (*S* session, *W* week), connected tools (🔌 *on/off*), the file they're editing (✎), friend, and version (**✓** same as yours, **⬆ update** behind, with **Nudge**). The host also sees where each person connects from.
- **Leader** picker, and **Remove** (leader or host).
- **For the host:**
  - **★ Friend** next to each connected person.
  - The **Friends** card: who's a friend, when and from where they last connected, **Copy invite**, **Remove**, and a box to invite someone who isn't connected yet.
  - The **Invite friends** card: **Copy invite**, **Stop hosting…** (it asks first), **🔑 New crew key…** and **Keep this PC awake while anyone's connected**.
- **For everyone else:** a short Friends note (are you on the host's friends list?).

## ⚙ Settings
**Connection** (Relay URL, your name, crew key, **Test connection**; for the host, **Who can join**), **Preferences** (Auto-run, notifications, check-in interval, **Crewshared check every**, the Clawds window, where new project folders go) and **Updates**.

Done for the day? Press **Leave…**, or just close Claude. Next time you open `/crew`, choose **Rejoin session** or **Leave session**. **↻ Refresh** reconnects right away and re-checks GitHub for updates.

## Saving tokens
Every crew message a Claude receives becomes part of its conversation, so crew keeps that small:
- People's chat never reaches the Claudes, the "how to treat crew messages" note sits once in the system prompt, task updates and joins only show in `/crew`, and the catch-up skips people's chat.
- Moving files costs nothing: Crewshared, shared folders and Crewleader copies are done by the plugin, and each Claude reads its own local copy, only the parts its task needs.
- The relay, the polling, the app checks and the Clawds window use no tokens at all.
- The biggest lever is yours: **Auto-run** `off` or `leader`, since every auto-run request starts a turn. Claudes don't sit in a loop waiting on a teammate: for a slow reply they finish their turn, and the reply wakes them when it lands.

**Picking up days later.** The relay keeps the chat, tasks, docs, shared folders and leader on the host's disk. When you rejoin, your Claude gets a **catch-up briefing**: who leads, the open tasks, and the last 30 crew messages.

## Commands

| Command | What it does |
|---|---|
| `/crew` | the crew pane (Chat, Tasks, Project, Crew and Settings tabs), and the Clawds window pops out |
| `/clawds` | brings up the Clawds window, or brings it to the front if it's already open |
| `/crewlog` | the **crew log**: every crew message live, including what the Claudes say to each other. Filter by **Everything / Claudes / People**, tick **On top**, put it on a second monitor. No tokens, doesn't count as you being online, and shows only what you'd see in `/crew` (other people's DMs and private projects stay private) |

## The tools Claude gets

| Tool | What it does |
|---|---|
| `crew_send` | message a teammate or everyone (`chat`, `request` or `update`) |
| `crew_status` | who's online and busy, their models, usage and tools, the leader, tasks, shared docs and folders, and recent messages |
| `crew_task` | `add` / `assign` / `claim` / `done` / `release` / `edit` / `remove` tasks (by number: `3` or `T3`) |
| `crew_lead` | change the leader (only when you ask it to) |
| `crew_share` / `crew_read_shared` | publish and read shared docs (including the `crew-rules` house rules) |
| `crew_share_folder` | share a folder of the project (`share`), fetch a teammate's (`get`), or stop (`stop`); copied by the plugin, no tokens |
| `crew_send_image` | send an image file (png, jpg, gif, webp or bmp, up to 4 MB) to a teammate or everyone |
| `crew_wait` | wait (up to 90 s) for a quick reply without polling. For slow replies Claude ends its turn and the reply wakes it |
| `crew_project` | list the crew's projects, or move this session into one (a new name starts it); only when you ask |
| `crew_ping` | measure latency: relay round trips, and how fast a teammate's plugin echoes (no tokens) |

`crew_send` also takes `notify_human: true` for messages meant for the teammate's human. Those always pop up and stay pinned at the top of their `/crew` until dismissed.

---
[← Back to the README](../README.md)
