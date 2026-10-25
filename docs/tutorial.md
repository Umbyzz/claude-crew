# Tutorial: your first crew project

This walks you from nothing to a finished project with friends, one step at a time. Each step ends with **✔ what you should see**, so you know it worked before moving on. The other pages are the reference: [Setup](setup.md) has every setting, and [Using crew](using.md) has every button.

In this tutorial, **Alex** hosts and leads, and **Sam** joins. With more friends, everyone does what Sam does.

---

## Part 1: Get connected (once)

### 1. Get on one network
Crew talks over a private network, never the open internet. Pick one and have everyone join it:
- **Tailscale** (recommended): free, encrypted, nothing to configure. The host's address looks like `100.x.y.z`.
- **Radmin VPN:** everyone joins the same network. The host's address looks like `26.x.y.z`.
- **Same Wi-Fi or LAN:** works too, with the host's local IP.

✔ Everyone shows up in the VPN app's list of devices.

### 2. Everyone installs crew
Open a terminal and run both commands, then restart Claude:

```bash
claude plugin marketplace add Umbyzz/claude-crew
```

```bash
claude plugin install crew@claude-crew
```

Only have the Claude desktop app? See [Setup](setup.md#3-everyone-installs-the-plugin) for the other way.

✔ Typing `/crew` in Claude opens the crew pane, and the Clawds window pops up.

### 3. The host starts the crew
The host needs **Python 3.8+** ([python.org](https://www.python.org)).

**Alex:** type `/crew`, enter your name, press **Host a crew**.
- A window called **Crew relay - keep open while you host** opens. That window *is* the crew: keep it open as long as people are working. You can close and restart Claude freely; the relay keeps running.
- When Windows Firewall asks, allow it on **private** networks.
- Press **Copy invite** and send the message to Sam (Discord, WhatsApp…). It has the address, the key and the install steps.

✔ Alex's `/crew` shows the top bar with "you host", and Alex is online in the **Crew** tab.

### 4. Friends join
**Sam:** type `/crew`, enter your name (unique in the crew), press **Join a friend's crew**, and paste the **Relay URL** and **Crew key** from Alex's invite.

✔ Sam appears in everyone's **Crew** tab with a green dot, and a Clawd for Sam walks into the Clawds window.

### 5. Make it friends-only (recommended)
**Alex**, in the **Crew** tab: press **★ Friend** next to Sam while Sam is connected. Sam's personal key reaches Sam's plugin by itself, tied to Sam's name. Then **⚙ Settings → Who can join → friends only**.

✔ Sam gets a note saying they're on the host's friends list, and still gets in. A leaked invite now gets nobody in.

You only do Part 1 once. From now on, opening Claude reconnects you.

---

## Part 2: Start a project

### 6. Open a fresh chat for it
Every project gets **its own Claude chat**. A chat remembers which project it's in, and its Claude only carries that project's work, which saves tokens and keeps projects from mixing.

**Alex:** in `/crew`, open the **📂 project tab** (named after the project you're in, `main` at first) and press **+ New project**. Type a name and press Enter.
- In a chat that already has other work, crew asks first: press **Open it in a new chat**, then start a new chat (**+ New session** in the sidebar). **Use this chat** moves this chat over instead.
- If this PC already has a chat for that project, crew says so ("Wait!! You already have a chat for …", with when you last used it): open that one from the sidebar instead.
- In an empty chat, it switches right there.

✔ The new chat's `/crew` shows the new project, with Alex as its leader. Whoever makes a project leads it.

### 7. Invite your friends
New projects are **members-only**: nobody else can see them yet. **Alex**, in the project tab: press **+ Add someone** next to "🔒 Members only" and pick Sam (it's the same list as **▸ Members & access**).

**Sam:** an invite appears in `/crew`. If your current chat has other work, press **Open it in a new chat** and start a new chat; otherwise press **Switch**.

✔ Both of you see the project, and the project line says "here: you (this chat), Sam" on Alex's side. Someone with a chat open in another project shows as "you (another chat)"; **↻** next to **Working on** re-reads the list.

### 8. Set up the engine (if it's a game)
- **Roblox:** everyone opens the **same Team Create place**, with the Roblox Studio MCP connected. ✔ The **Crew** tab shows **🔌 1 MCP** next to each of you.
- **Unity:** one git repo with a branch per person, everyone on the **same Unity version**. Unity has no live sharing, so each person builds in their own scene and the leader merges.
- **Plain code:** one git repo with a branch per person is best.

Got raw material (references, sounds, an old project)? **Alex** drops it in **📦 Crewleader** (Project tab → **▸ Shared folders → Crewleader → Open**). It stays on Alex's PC until the leader's Claude picks out what the crew needs.

### 9. Kick off
**Alex**, in the project's chat, tell your Claude the goal and ask for the kickoff:

> New project: a Roblox horror game, small and spooky. We're both in the same Team Create place with the Studio MCP connected. Run the kickoff first.

The leader's Claude runs the **crew:kickoff** skill:
1. It asks 2–3 questions if the goal is vague. Answer them.
2. It writes a one-page **`plan`** doc: the goal, the scope, who owns which folder (or part of the game), how the pieces connect, and what "done" means.
3. It adds **house rules** (only edit what your task owns, test before done, and so on).
4. It proposes **who takes what** in one message. Say if you'd rather swap.
5. It adds tasks to the board, each saying what it owns (`owns: ServerScriptService/EnemyAI`), with the skeleton first.

✔ The **Tasks** tab fills up, the **plan** doc is in **▸ Shared docs**, and Sam's Claude gets its first task.

---

## Part 3: Work together

### 10. What you do, and what the Claudes do
- **The Claudes** claim tasks, work on them, test, mark them done and report back. Sam's Claude starts on the leader's requests by itself (**Auto-run**: *leader*, the default). When it finishes, it tells the leader's Claude, which checks the work and hands out the next task, even while Alex is away.
- **You** talk to your own Claude as usual, answer its questions, and watch. Your own instructions always win.

### 11. Talk without spending tokens
In the **Chat** tab, **To:** decides who reads your message:
- **The people:** a normal group chat between humans. No Claude reads it, so it costs nothing. Type `@sam hi` for a private message.
- **A teammate's Claude:** your message reaches that Claude as a request, and it starts on it if its Auto-run allows.
- **All Claudes:** one ask to every Claude.

### 12. Share files
- **📥 Crewshared:** put a file in `Crewshared\<your name>` (Project tab → **▸ Shared folders**), and every teammate gets it within ~2 minutes in `Crewshared\<your name>` on their PC. **⇅ Sync now** sends it at once. No tokens.
- **Shared folders:** **Share another folder…** syncs a whole folder; teammates press **Get it**. Engine caches (`.git`, Unity's `Library`, Godot's `.godot`…) are left out.
- **Images:** ask your Claude to send a screenshot to a teammate.

### 13. When two Claudes reach for the same thing
If Sam's Claude edits a file (or a Studio or Unity script) that Alex's Claude changed in the last few minutes, it's stopped once and told who, so it checks with Alex's Claude first. Trying again goes through, so nobody is ever stuck. Changes made by running code inside the engine can't be locked; that's what each task's "owns:" is for.

### 14. Keep an eye on it
- **Crew** tab: what each Claude is doing, its model, how much usage it has left (*S* session, *W* week), its tools, and what it's editing.
- **`/clawds`:** the pixel Clawds act it out: typing, thinking, meeting up, cheering, falling asleep when out of tokens…
- **`/crewlog`:** every message live, including what the Claudes say to each other. Handy on a second monitor.

### 15. Stop and come back
Done for the day? Close Claude, or press **Leave…**. Open tasks stay on the board.

Next time, open **the project's chat** from the sidebar (it's still in its project) and type `/crew`. Your Claude gets a short catch-up: the open tasks and what happened while you were gone.

**Host:** keep the relay window open while anyone's working. If it got closed, `/crew` → **▶ Start relay** brings it back with everything saved.

---

## Part 4: Finish

### 16. Run the retro
When the project's done, each person tells **their own** Claude, in the project's chat:

> The project's done, run the retro.

Each Claude runs the **crew:theultimateretroforcrew** skill and shares a `retro-<name>` doc covering what it did, what it had to guess, clashes, waiting, tool trouble and where its tokens went. The leader's Claude merges them into one **`retro`** doc: what worked, what missed, the fixes ranked, and any bugs.

✔ The `retro` doc is in **▸ Shared docs**. Read it, add what *you* noticed, and keep it for the next project.

### 17. Keep crew up to date
When a new version is out, `/crew` shows a banner. Press **Install update**, then restart Claude. The host also presses **Restart relay** in the version notice. Same key, same chat, same projects.

---

## Good to know
- **One chat per project.** Starting something new from an old chat? Use **Open it in a new chat**.
- **The relay window is the crew.** Closing it disconnects everyone; restarting Claude doesn't.
- **Members-only by default.** Can't see a friend's project? Ask them to add you with **+ Add someone** in their project tab.
- **Tokens:** people's chat is free, and so is moving files. What costs is Claudes working, so keep **Auto-run** on *leader* unless you want every request to start work.
- **Something odd?** [Troubleshooting](troubleshooting.md) has the common fixes.

---
[← Back to the README](../README.md)
