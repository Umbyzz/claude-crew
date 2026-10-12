# Changelog

What changed in each version of crew, newest first. The [README](README.md) has what crew does and how to set it up.

## 1.9.6
- **Open buttons bring the folder to the front.** Windows opened them behind Claude, so every press quietly stacked up another hidden Explorer window. Now a window already showing that folder comes forward, and a new one does too.

## 1.9.5
- **See what everyone's Claude is connected to.** The Crew tab shows each teammate's MCP servers (🔌 Roblox Studio, Unity…), and the leader's Claude gives work that needs one to whoever has it connected. (Asked for by CoriZori.)
- **⇅ Sync now** in the Project tab sends your Crewshared changes and pulls teammates' at once. **Settings → Crewshared check every** sets how often it checks by itself: 30s, 1, 2 or 5 minutes.

## 1.9.4
- **Usage per window.** The Crew tab shows each limit on its own, like *26% session · 35% week*, instead of only the fullest one.
- Checked live with a scripted teammate: model and usage on the board, Crewshared sending and receiving, file locks and the acting leader.

## 1.9.3
- **New Clawd moments.** The over-the-top idle taps a foot at you, hands on hips: *"Are you gonna prompt yet?"* When someone runs out of tokens, the crew frets for half a minute, then sighs *"they'll be back"* and pats the sleeper (or high-fives or hugs the ghost after a funeral) before getting back to work. Clawds walking past each other now leapfrog instead of bumping and moonwalking. (Ideas by Umbyz.)
- **A shorter README**, with the details moved to pages in `docs/`.

## 1.9
- **Crewshared drop folders.** Every project folder gets `Crewshared\<your name>`. Drop files in yours (assets, references, exports, notes) and within about 2 minutes every teammate has them in `Crewshared\<your name>` on their PC. No buttons and no tokens. Teammates' drops arrive in their own subfolders by themselves. Everyone can share, not just the leader: you can't change someone else's folder, but yours is all yours. The Project tab has **📥 Open my Crewshared** and **Open Crewshared**.

- **The blacksmith Clawd.** The over-the-top version of tinkering: a hard hat, a hammer and a mini gear, with sparks on every *CLANG*. (Idea by Umbyz.)

## 1.8
- **Shared folders.** Share a folder of your project (source, assets, references) from the Project tab (**Share a folder…**) or by asking your Claude (`crew_share_folder`). Teammates press **Get it** and their crew copies it into the same place in their own project folder, then keeps it in sync when you press **Update**. The plugin does the copying, so it costs **no tokens**, and each Claude reads its own local copy with Read/Grep, the cheapest way to read code. Only changed files move, and identical files are stored once. If a teammate changed a file themselves, theirs stays and yours lands next to it as `.new`. The leader's Claude also maps a big shared folder once in a doc, so nobody re-explores the whole thing.

## 1.7
- **File locks.** When a teammate's Claude edited a file in the project folder in the last 5 minutes, your Claude is stopped once before editing it and told who. It checks with them first, so nobody overwrites anyone. Trying the same edit again goes through. The Crew tab shows who's editing what (✎). It costs no tokens unless an edit actually gets stopped.
- **Everything you add can be undone:** a house rule has ✕, and a folder you just made has **↶ Undo** (to the Recycle Bin, while it's still empty).
- **Usage on the board.** The Crew tab shows how much of their usage limit each teammate has used (⚠ past 80%). The leader's Claude gives big tasks to whoever has room, and a Claude past 85% finishes up, tells the leader and hands over instead of starting big work.

## 1.6
- **A team that plays to its models.** Each Claude tells the crew which model it runs (shown in the Crew tab). The leader's Claude proposes who takes what before splitting a bigger goal: the most capable models (like Opus) take the heavy coding, architecture and reviews; quicker ones (like Sonnet) take ideas, design, UI and straightforward building; the lightest (like Haiku) take small chores, tests and docs. Teammates can push back, and people's wishes always win.
- **House rules.** Each project can have its own rules ("Pluh does the art", "ask before touching main"), which every Claude in that project follows. Add them in the Project tab's **House rules** box (✕ removes one), or ask your Claude. They live in a shared doc named `crew-rules`.
- **Loop brake.** Claudes can't wake each other forever while nobody's around: after 8 Claude-sent requests in 10 minutes with nobody typing, that Claude stops auto-running, tells the sender, and pins a notice. Type anything in that chat to resume.

## 1.5
- **Projects list.** Every project sits in a **Projects** box under main, with who's in it, open tasks and an **unread count**. The ⋯ menu deletes one after a double warning (*You sure?* then *VERY sure??*), and moves its folder to the Recycle Bin when it's inside your projects home.
- **Invites and a folder picker.** Invite the crew into a project, and press **Set** to pick a folder in Explorer instead of pasting a path.
- **Delete shared docs** from the Project tab (their author, the project's leader or the host; one confirm), so old plans and patches don't pile up.
- **Up to ten Clawds**, and the Clawds window works across multiple monitors.
- **Who's on which version** shows in the Crew tab, so you know who still needs to update.
- The chat, Ask and Add task fields now **empty after you press Enter**.
- A one-time **double-click tip**: in the desktop app a button's first click can just focus the pane. That's the app, not crew, so /crew says so once, and **Got it** hides it.

## 1.3
- **Remove (kick)** a teammate from the Crew tab, as leader or host.
- The Clawds and crew log windows can no longer open twice.

## 1.1
- **Projects.** Each project has its own chat, task board, shared docs and leader, so a new game doesn't land in the old one's chat. Each Claude Code chat stays in its own project, and a new chat in the same folder starts in that folder's project. Pick or create one in `/crew`'s **Project** tab (it used to be Docs), or ask your Claude (`crew_project`). Everything from before lives in **main**.
- **Project folders.** The Project tab also shows the project's folder on your PC: open it in Explorer, make subfolders, or point it somewhere else, without leaving Claude.

## 1.0
- **`/crew` in tabs:** Chat, Tasks, Project, Crew and ⚙ Settings, one card at a time, with notices pinned above them.
- **Messenger-style chat** with a **People / Everything** switch and a **To:** picker that talks to the people or straight to a teammate's Claude.
- **Read receipts** ("✓ read by bob") and **`crew_ping`** to measure latency.
- **Acting leader:** when the leader is away, someone stands in, and hands back with a summary.
- **Crew log window** (`/crewlog`) to watch the Claudes talk to each other on a second monitor.
- **One-click updates that actually work** on every kind of install, with a step log if they don't.
- **Hosting from the top bar:** Host, ▶ Start relay, and **Restart relay** after an update.
- Tasks numbered **T1, T2 …**, stale claims reopened, people's chat kept out of the Claudes' tokens.
