# Changelog

What changed in each version of crew, newest first. The [README](README.md) has what crew does and how to set it up.

## 1.12.2
- **The moonwalk.** The over-the-top **"CLAUDE'S PLAN!!"** now ends with the whole crew in fedoras, turned three-quarters (shaded like the original Clawd's side view), moonwalking backwards across the stage, doing the spin, and striking a pose: a hat tip, the point, up on the toes, or the brim pulled low, a different one each and the same on every screen. *Hee-hee!* (Idea by Umbyz, in memory of Michael Jackson.)

## 1.12.1
- **Leaner catch-ups.** Switching projects no longer replays messages this chat was already handed, and long messages read as their first few lines (`crew_status` has them in full). That saves tokens on every switch and rejoin.
- **Clean-up:** removed the last unused code (an old key generator, the pre-count tool labels, an unused relay list) and stale notes about versions from before 1.0. An audit of the plugin, relay and both windows now finds nothing unused.

## 1.12.0
- **A tidy Project tab**, designed and built by CoriZori's Claude and merged over the crew relay, like the 1.0 tabs. A short summary on top (Working on ▾, leader, who's here, members-only or open, the folder with Open and ⋯). Everything else is folded into one-line sections with counts: Projects, Members & access, Shared folders (now with Crewshared, Crewleader and Sync now inside), House rules, Shared docs, and ⓘ How projects work. One section is open at a time, and the open one is remembered. Help text only shows where a section is empty. Nothing was removed; it's all one click away.

## 1.11.3
Ideas from CoriZori and Umbyz:
- **Claudes view in Chat:** Everything | People | **Claudes**. Claudes shows only what the Claudes say to each other.
- **To: all Claudes:** ask every Claude at once. Each one starts on it only if its own Auto-run allows (on the default, that's the leader's Claude); the others read it on their next turn, so it doesn't wake everyone.
- **A preview box while you type** a long message: it wraps and grows above the field like a phone's compose box, and disappears when you send. The field itself still can't wrap in Claude Code.
- **🔌 counts only usable tools:** *🔌 2 MCPs*, counting a tool only when its app is open (or it has no app to check). Nothing shows when none are.
- **Fix:** a project opened in a new chat (from an invite) got the chat's own workspace as its folder. It now gets its folder under your projects home. (Found by CoriZori's Claude.)

## 1.11.2
- **Invites survive restarts.** An unanswered invite is kept until you press something, so updating or restarting Claude no longer makes it vanish.
- **Clear next step after *Open it in a new chat*.** Instead of a toast that's gone in seconds, a notice stays at the top of `/crew`: *📌 Next: start a new chat (+ New session in the sidebar). It opens straight in the project.* It disappears as soon as a new chat picks the project up, or with **Cancel**. (A plugin can't open a chat by itself, so this tells you exactly what to do.)

## 1.11.1
- **Fix: the Clawds window and crew log said *wrong crew key*** after a new crew key or a friend's personal key. They read the key only from `settings.json`, while the plugin uses its own saved copy. Both windows now use the plugin's key and fall back to settings. (Found and diagnosed by CoriZori's Claude.)

## 1.11.0
From the first live test with CoriZori's Claude:
- **Fix: images couldn't be sent** (`crew_send_image` failed with ECONNRESET). A name clash inside the relay, from the shared-folders work, broke the image upload. It works again, and a relay test now sends one.
- **Direct messages reach you whatever project you're in.** A teammate's report or a "done, what next?" no longer goes missing because you switched projects. It's labelled with the project it came from ("(private)" if you can't see it). Messages to everyone still stay in their project.
- **Rename a project** (⋯ → Rename…, its leader or the host). Everything moves with it: chat, tasks, docs, shared folders, members and leader. Anyone still in it follows along by themselves, keeping their place and their folder. (Asked for by CoriZori.)
- **Invites ask where to open the project.** If this chat already has other work, the notice says so and offers **Open it in a new chat**: your next new Claude chat starts straight in that project with a catch-up, and this one keeps its own work. **Switch this chat** and **Not now** are still there.
- **Vague goals get questions, not inventions.** Asked to "just make this game" with no material and no explanation, a Claude asks its user two or three short questions first.
- **Confirms on everything that can't be undone:** Stop hosting (it disconnects everyone) and Remove friend now ask first. A members-only project can be opened up again (**🔓 Open to everyone**).
- **Friends card stays current** (*connected now* / *last seen*), and teammates who aren't the host see a short note on how friends work instead of nothing. `crew_status` shows who's a friend.
- A project made with `crew_project` now has its maker as leader, like **+ New project**. Old "out of tokens" notes no longer show up in catch-ups days later. The Crewshared button row wraps instead of running off the screen.
- **Timmy test:** a new plugin test presses 300 random buttons across every tab and checks `/crew` never breaks and nothing irreversible happens without its confirm. Relay tests: 27, plugin tests: 75.

## 1.10.7- **Fix: a new crew key could lock the host out.** Claude Code can refuse a plugin's settings save, and 🔑 New crew key didn't check, so the relay switched keys while the host's plugin kept the old one. Now crew keeps its own copy of the key that works (a new crew key, or a friend's personal key) and uses it after a restart. A refused save is reported. And if the host's own relay ever refuses their key, the plugin picks the right one up from `crew_key.txt` on that PC by itself.
- **The sketching Clawd.** Tinkering now means sitting down with little reading glasses and sketching on a sheet of paper. The blacksmith stays as the over-the-top version. (Idea by Umbyz.)

## 1.10.6
- **Shorter Crew tab rows:** usage reads *60S%-40W% usage*, tools read *🔌 R-Studio on/off*. Model and version stay in full. Claude's own instructions keep the long wording.

## 1.10.5
- **Is the app actually open?** A connected tool now shows whether its app is running: *🔌 Roblox Studio (open)* or *(closed)*. An MCP server can run while its app is shut, waiting for it. It's checked with a quick task list about once a minute, so no tokens (Roblox Studio, Unity, Blender, Godot, Figma, Photoshop, Unreal). The leader's Claude asks a teammate to open a closed app before giving them live work in it.

## 1.10.4
- **★ Friend a connected teammate.** The host presses ★ Friend next to someone online (their address shows beside it), and their personal key reaches their plugin on its next check-in, saved by itself. No copy-paste, no typos. Typing a name and copying an invite stays for people who aren't connected yet.
- **No duplicate friends.** A second friend with the same name is refused instead of silently replacing the first one's key.
- **Who can join** moved to ⚙ Settings → Connection (host only).
- Relay tests: 23.

## 1.10.3
- **Claudes look before they ask.** Given a goal without saying where its material is, every Claude first checks its Crewleader and Crewshared folders. If the goal needs files and both are empty, it asks its user where they are (and suggests Crewleader) instead of guessing.

## 1.10.2
- **Crewleader: a private raw-material folder** in every project folder (**📦 Open my Crewleader**). Put huge raw material there (a whole source tree, every asset): it stays on your PC and is never synced, and edits inside it aren't even announced to teammates. The leader's Claude sorts it by structure, never by reading everything, copies only what the crew needs into `Crewshared\<name>` (copying costs no tokens), and shares a map doc. Smaller downloads, a smaller relay, and less for every Claude to read. (Idea by Umbyz.)

## 1.10.1
- **Keep this PC awake while anyone's connected.** On by default for the host (Crew tab → Invite friends), so Windows doesn't sleep and pause the crew mid-work; the screen can still turn off. Switch it to *no* to let the PC sleep as usual.
- **More relay tests** (20 now): shared folders and Crewshared (stored once, only changes uploaded, only the sharer can change them, no climbing out of the project folder, cleanup, privacy), file locks and keep-awake.

## 1.10.0
- **Friends: personal keys.** The host adds friends in the Crew tab; each gets their own invite with a key that only works with their name, so nobody can pose as someone else. **Remove** stops just that friend's key. **Who can join → friends only** turns the shared crew key off (the host's own PC always gets in). Each friend shows when and from where they last connected.
- **Members-only projects.** New projects are private to whoever made them: only members see them in the list, their chat, tasks, docs, shared folders and Crewshared, and they're kept out of the crew log and the Clawds for everyone else. Members press **+ name** to add someone (they get an invite); the leader removes people with **✕ name**. Projects from before stay open until their leader presses **🔒 Make members-only**. main is always the whole crew's.
- **Relay tests.** `server/test_relay.py` (12 tests: keys, friends, members-only projects, saves) now runs with every release.

## 1.9.8
- **🔑 New crew key** for the host, in the Crew tab's Invite friends card (one confirm). The old key stops working at once and the new invite is copied, for when someone left the crew or an invite went astray.
- **Crash-safe saves.** The relay writes its state to a temp file and swaps it in, so a crash or power cut mid-save can't wipe the chat, tasks and docs. A damaged state file from before is put aside instead of stopping the relay.

## 1.9.7
- **Only one relay at a time.** The relay now claims its port alone; on Windows a second one could silently share it, and then both answered at random. Starting another while one runs says *"a crew relay (version x) is already running"* and closes itself. Restart relay still hands over cleanly.

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
