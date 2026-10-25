---
name: kickoff
description: Start a crew project the right way before anyone builds - gather the material, ask what's unclear, write the plan doc, split the work by file ownership, set house rules and hand out tasks, so the Claudes never clash. Use when you lead the crew and your user starts a new project or gives the crew a big new goal (e.g. "let's make a horror game").
user-invocable: false
---

# Crew kickoff

You lead the crew. Before anyone builds, put everyone on one plan so no two Claudes work on the same files or guess differently about how the pieces fit. Keep it quick: a kickoff takes minutes, not an hour.

## 1. Gather

- `crew_status`: who's here, their models, usage left and connected tools (🔌).
- Look for material in Crewleader, Crewshared and the shared docs (`crew_read_shared`).
- If the goal is still vague, ask your user 2-3 short questions in one message and wait for the answers: what exactly (genre, the core loop, the one thing that must be great), which engine or platform, how big (a weekend jam or weeks), and what they already have. Don't invent a big plan from nothing.

## 2. Write the plan doc

`crew_share` a doc named `plan`, about one page:

- **Goal**: two lines about what the player (or user) experiences.
- **Scope**: the smallest playable version first, then the nice-to-haves.
- **Layout**: the folder tree, and who owns each folder.
- **How the pieces connect**: the names one part uses from another (scripts, events, functions, scenes), data formats and naming conventions. Decide these now; most clashes are two Claudes guessing differently.
- **Done means**: it runs without errors, its owner tested it, and you checked it.
- **Where the code lives**: one git repo with a branch per person and you merging is best for code. Without git, each owner shares their folder through Crewshared and you assemble. Nobody pushes without their own user's OK.
  In a live engine edited through MCP (like Roblox Studio), everyone opens the same Team Create place, so all edits land in one game; without it, each Claude builds a separate copy that never comes together. Shared folders and Crewshared then carry only raw files (references, sounds, notes).
  In an engine without live sharing (like Unity), use the git repo. Each teammate builds in their own scene (`Scenes/Work/<name>.unity`) and turns finished pieces into prefabs in their own folder; the main scene is yours, and you place their prefabs in it. Scenes and prefabs merge badly in git, so never put two people in one scene or prefab. Everyone uses the same Unity version, commits each asset's `.meta` file with it, and keeps `Library/`, `Temp/`, `Logs/` and `UserSettings/` out of git.

### Studio notes (Roblox Studio projects)

For a Roblox Studio project, also `crew_share` a doc named `studio-notes` with these lessons from earlier crews, and point to it in the plan:

- Requiring a ModuleScript from the command bar (or `execute_luau`) gets a fresh copy of the module, not the one the game is running. To test live game state, go through a DevHook in ServerStorage that the running scripts expose.
- `screen_capture` can time out, and it doesn't draw BillboardGuis: check those another way.
- `script_grep` and `script_read` can miss matches while the game is in Play.
- Edits need Play stopped.
- Studio ids change after a reconnect: list them again instead of reusing old ones.
- Keep each MCP wait under about 25 seconds.
- DataStores and teleports don't work in Studio: publish and test those in a real server.

## 3. Split by ownership

Every task names what it owns, in its title or note: `Enemy AI - owns: Scripts/Enemy/`. In a live engine, use a path in the game tree: `Enemy AI - owns: ServerScriptService/EnemyAI`. In Unity, name the folder and the work scene: `Enemy AI - owns: Assets/Game/Enemy/, Scenes/Work/Cori.unity`.

- Shared files (the main scene, config, project settings, the entry script; in Roblox, shared modules like ReplicatedStorage/Shared and the main server script) are yours; teammates ask you for changes.
- crew's file locks cover files on disk and scripts edited through Roblox Studio's or Unity's MCP, but not changes made by running code in the engine (like execute_luau or Unity's CLI) or through other engines' tools, so in a live engine ownership is the main guard: keep it strict.
- No two open tasks own the same path.
- Your first task is the skeleton: the folders, empty scenes and stub scripts with the agreed names, so everyone builds on the same base. Order the rest so nobody waits.
- Size tasks to the teammate: heavy or tricky work to the most capable models, UI, art and level design to quicker ones, small chores to the lightest. Live engine work goes to whoever has the engine's tool connected; anyone past 80% usage gets small tasks.
- Keep tasks small enough to finish in one sitting.
- Spread your own building across the project instead of front-loading it: after the skeleton, take a share of the work alongside everyone else, so you're free to check finished tasks as they come in.
- Plan a **perf pass** and a **balance pass** as their own tasks before the project counts as done, each reporting numbers (frame time or script time, spawn counts, damage, timings), not just "feels fine".

## 4. House rules

Read `crew-rules` with `crew_read_shared`. Keep every existing line and add any of these it doesn't cover (one `- rule` per line), then `crew_share` it back:

- Only edit what your task owns (its files, or its part of the game tree); ask the owner or the leader for anything else.
- Read the plan doc before claiming a task. If the plan is wrong, say so instead of working around it.
- Mark a task done only after testing it; the leader checks it before others build on it.
- After each finished task, one crew_send line: what changed and which files.
- Every request gets a T-number on the board before work starts, including requests a person relays to another person's Claude while the leader is away.
- The done note is the changelog line: write it so it can be copied into the changelog as is.
- While acting as leader, add a line to the plan doc for each decision you make.

Ask your user before removing or rewriting rules the crew wrote.

## 5. Propose, then hand out

- One `crew_send` to all: the plan doc's name and who takes what, in 2-3 lines. Give teammates a moment to object; their person's wishes win.
- Add the tasks with `crew_task` (assignee set), the skeleton first, and claim your own.
- Tell your user in a few lines what's set up and who's on what.

## 6. Checkpoints

When the first tasks are done, check each against the plan: it touches only its own files, uses the agreed names, and runs. Update the plan doc if reality changed, and re-split if needed. Do the same at each milestone.
