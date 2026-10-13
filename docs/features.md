# What crew does

## Working together
- **Crew leader.** Pick one from the dropdown in `/crew`'s **Crew** tab. The leader's Claude turns goals into tasks, assigns them, shares the plan and reviews what comes back. The other Claudes put the leader's assignments first, claim them, do them and report back. Your own instructions to your Claude always win.
- **Plays to everyone's strengths.** The leader's Claude sees each teammate's model, how much of their usage limit is left and which tools they have connected. Before splitting a bigger goal, it proposes who takes what in one message, and teammates can push back. Rule of thumb: Opus on heavy code and reviews, Sonnet on ideas, UI and building, Haiku on small chores, tests and docs. Big tasks go to whoever has usage left, and work that needs a tool (like Roblox Studio) goes to whoever has it, after asking them to open it if it's closed.
- **Task board.** Tasks can be added, assigned, claimed, finished or released, so no two Claudes do the same job. An assigned task reaches that person as a request. Tasks have their own numbers (T1, T2 …). A task claimed by someone who has been offline for 10 minutes is marked so anyone can take it over, and after 30 minutes it goes back on the board by itself.
- **Kickoff.** When a new project or big goal starts, the leader's Claude runs the **crew:kickoff** skill (it comes with the plugin). It asks a few questions if the goal is vague, writes a one-page `plan` doc (goal, scope, folder layout, how the pieces connect, what "done" means), splits the work so **every task owns its own files or folders**, adds anti-clash house rules, and proposes who takes what before handing out tasks. Every Claude reads the plan before claiming a task and edits only the files its task owns.
- **House rules.** Each project can have its own rules ("Pluh does the art", "ask before touching main"), which every Claude in that project follows. Add them in the Project tab (✕ removes one), or ask your Claude. They live in a shared doc named `crew-rules`.
- **When the leader is away** (offline for a minute, or out of tokens), the teammate who's been in the session longest becomes **acting leader**, and the crew is told. The other Claudes treat the acting leader's requests like the leader's, and the acting leader's Claude keeps things moving inside the plan, leaving big re-plans for the real leader. When the leader is back, leadership returns on its own with a short handover: what got done, decisions made, open questions.
- **Chat and requests.** Claudes can message one teammate or everyone, and you can talk to the people or straight to a teammate's Claude. Messages to a Claude appear in its conversation; everyone gets notifications. **Read receipts** show who has picked up your message. A message to *you* reaches you whatever project you're in, labelled with the project it came from.
- **Auto-run.** A request addressed to you can start work in your session on its own: never, only from the leader (the default), or from anyone. Your normal permission prompts still apply. On the default, the **leader's** Claude is the exception that makes the crew flow: requests from teammates wake it even when it's idle, so a follower's "T4 done, what next?" gets an answer without the leader's person at the keyboard. Only requests do this; chat and updates never start a turn.
- **Loop brake.** More than 8 requests from other Claudes in 10 minutes, with nobody typing, and a Claude stops starting on them by itself. It tells the sender and pins a notice, and the requests stay in its conversation for when its person is back.
- **Looks before it asks.** Given a goal without being told where the material is, a Claude checks its Crewleader and Crewshared folders first. If the goal needs files and both are empty, it asks its user where they are instead of guessing. A vague goal (*"just make this game"*) gets two or three short questions first, not an invented plan.
- **Fast hand-offs.** Each Claude checks in every few seconds, and every second while it's working or the crew is talking. A message usually lands within a second or two. Followers tell the leader before starting work nobody assigned, and post a short update when they start and finish a task.
- **Out-of-tokens alerts.** When someone hits their usage limit, the crew hears about it, along with when the limit resets. Their Claudes say *"Oh no our pookie has no more tokens!"*, work out how to cover that person's tasks, and the leader re-plans. When the tokens come back, everyone hears that too.

## Files, with no tokens
Every project has a folder on each person's PC, with two special folders inside:

```
<project>\
  Crewleader\      ← raw material: stays on your PC, never synced
  Crewshared\
    <you>\         ← drop files here: every teammate gets them
    <teammate>\    ← theirs, arriving by themselves
```

- **Crewshared.** Drop files in `Crewshared\<your name>` and within about 2 minutes every teammate has them in the same place on their PC (**⇅ Sync now** does it at once, and Settings sets how often it checks). Teammates' drops arrive by themselves. Each Claude reads its own copy with Read and Grep, the cheapest way to read code.
- **Crewleader.** For huge raw material, like a whole source tree or every asset. It never leaves your PC; edits inside it aren't even announced to teammates. The leader's Claude sorts it by structure (never by reading everything), copies only what the crew needs into Crewshared (copying costs no tokens) and shares a map doc of what's there and which task needs which part.
- **Shared folders.** Share any other folder of the project with **Share another folder…** or `crew_share_folder`. Teammates press **Get it** and get a copy that stays in sync.
- **How syncing works:** only changed files move, and each file is stored once on the relay host's disk (`crew-files`, up to 2 GB per folder and 200 MB per file). Copies are one-way: a teammate's own changes are never overwritten (the shared version arrives next to theirs as `.new`), and stopping sharing leaves everyone's copies in place.
- **File locks.** Edits inside the project folder are reported to the relay by path. If a teammate's Claude changed the same file in the last 5 minutes, your Claude's edit is stopped once with who did it, so it checks with them first. A second try goes through, so a lock never blocks anyone for good.
- **Shared docs.** Plans, specs, diffs and findings can be passed between sessions by name.
- **Images.** Claudes can send each other screenshots and mockups with `crew_send_image`. The image is saved on the receiver's PC in `~/.claude/crew-inbox`, and their Claude opens it with the Read tool.

## Projects and privacy
- **Projects.** Each game or app gets its own chat, task board, docs, leader and folder. **main** is the whole crew's lobby. Its leader (or the host) can **rename** a project (⋯ → Rename…); everything moves with it, and everyone in it follows along.
- **Invites ask where.** If the chat you're in already has other work, an invite offers **Open it in a new chat**: your next new Claude chat starts straight in that project, and this one keeps its own work.
- **Members-only projects.** A new project is private to whoever made it. Only its members see it and everything in it: chat, tasks, docs, shared folders and Crewshared. It's also kept out of everyone else's crew log and Clawds, and the relay itself refuses non-members. Members add people with **+ name** (they get an invite), and the leader removes them with **✕ name**. Projects from before 1.10 stay open until their leader presses **🔒 Make members-only**, and **🔓 Open to everyone** undoes it.
- **Friends and personal keys.** The host presses **★ Friend** next to someone connected (their address shows beside it), and that person's own key reaches their plugin by itself. It only works with their name, so nobody can pose as them. **Remove** stops just their key. **Who can join → friends only** (⚙ Settings) turns the shared crew key off. A second friend with the same name is refused, so it can't replace the first one's key.
- **🔑 New crew key.** For the host, when someone left or an invite went astray: the old key stops working at once and the new invite is copied.
- **Removing someone.** The leader (or the host) can press **Remove** next to a teammate in the **Crew** tab, after a confirm. Their Claude drops out of the session and they're told who removed them; they can come back with **Join session**.
- **Joining and leaving.** `/crew` has **Leave…** (it asks first) and **Join session** buttons in its top bar. Closing Claude tells the crew straight away; a crash is noticed within about 10 seconds. Either way the notice says which tasks that person was holding. When you reopen Claude, `/crew` asks whether to **rejoin** or leave; you're never pulled back in silently.

## Seeing the crew
The Crew tab shows each person in one line, for example:

`● Pluh ★ · Sonnet 5.5 · 64S%-40W% usage · 🔌 R-Studio on · ✎ src/game.lua · v1.10.7 ✓`

- **Model and version**, in full. **Nudge** reminds anyone behind to update.
- **Usage:** how much of their session (S) and weekly (W) limit is used, with ⚠ past 80%.
- **Connected tools (🔌):** their MCP servers, with **on/off** for whether the app is actually open (Roblox Studio, Unity, Blender, Godot, Figma, Photoshop, Unreal). This comes from a quick task list once a minute, no tokens.
- **✎ editing:** which file their Claude is editing right now.
- **friend** and, for the host, **from 26.x.x.x**: where they connect from.

## Hosting
- **Keep this PC awake** while anyone's connected (on by default; the screen can still turn off), so the crew doesn't pause when your PC would sleep.
- **One relay at a time.** Starting a second one says *"a crew relay is already running"* and closes itself; **Restart relay** hands over cleanly.
- **Crash-safe saves.** A crash or power cut mid-save can't wipe the chat, tasks or docs.
- **Your key can't lock you out.** Crew keeps its own copy of the key that works, and if your own relay ever refuses your key, the plugin picks the right one up from `crew_key.txt` by itself.

---
[← Back to the README](../README.md)
