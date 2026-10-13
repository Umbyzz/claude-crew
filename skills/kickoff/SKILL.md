---
name: kickoff
description: Start a crew project the right way before anyone builds - gather the material, ask what's unclear, write the plan doc, split the work by file ownership, set house rules and hand out tasks, so the Claudes never clash. Use when you lead the crew and your user starts a new project or gives the crew a big new goal (e.g. "let's make a horror game").
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

## 3. Split by ownership

Every task names what it owns, in its title or note: `Enemy AI - owns: Scripts/Enemy/`. In a live engine, use a path in the game tree: `Enemy AI - owns: ServerScriptService/EnemyAI`.

- Shared files (the main scene, config, project settings, the entry script; in Roblox, shared modules like ReplicatedStorage/Shared and the main server script) are yours; teammates ask you for changes.
- crew's file locks only see files on disk, not edits made through an engine's MCP tools, so in a live engine ownership is the only guard: keep it strict.
- No two open tasks own the same path.
- Your first task is the skeleton: the folders, empty scenes and stub scripts with the agreed names, so everyone builds on the same base. Order the rest so nobody waits.
- Size tasks to the teammate: heavy or tricky work to the most capable models, UI, art and level design to quicker ones, small chores to the lightest. Live engine work goes to whoever has the engine's tool connected; anyone past 80% usage gets small tasks.
- Keep tasks small enough to finish in one sitting.

## 4. House rules

Read `crew-rules` with `crew_read_shared`. Keep every existing line and add any of these it doesn't cover (one `- rule` per line), then `crew_share` it back:

- Only edit what your task owns (its files, or its part of the game tree); ask the owner or the leader for anything else.
- Read the plan doc before claiming a task. If the plan is wrong, say so instead of working around it.
- Mark a task done only after testing it; the leader checks it before others build on it.
- After each finished task, one crew_send line: what changed and which files.

Ask your user before removing or rewriting rules the crew wrote.

## 5. Propose, then hand out

- One `crew_send` to all: the plan doc's name and who takes what, in 2-3 lines. Give teammates a moment to object; their person's wishes win.
- Add the tasks with `crew_task` (assignee set), the skeleton first, and claim your own.
- Tell your user in a few lines what's set up and who's on what.

## 6. Checkpoints

When the first tasks are done, check each against the plan: it touches only its own files, uses the agreed names, and runs. Update the plan doc if reality changed, and re-split if needed. Do the same at each milestone.
