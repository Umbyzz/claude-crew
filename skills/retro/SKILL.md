---
name: retro
description: After a crew project is finished, look back on how the crew worked - what you did, what you had to guess, clashes, waiting, tool problems, where your tokens went - and share it so crew can be improved. Use only when your user says the crew project is done and asks for the retro (or a debrief or look-back); never while the project is still running.
---

# Crew retro

The project is done. Help improve crew by reporting honestly how the teamwork went from your side. Report what actually happened, not what should have. Get the facts from your own conversation, the task board (`crew_status`) and the shared docs. Where you don't know, say "don't know" rather than guessing. Keep it to about one page; short bullets are fine.

## 1. Answer from your own session

1. **What you did**: the tasks you claimed and finished (T-numbers), and anything left unfinished, with the reason.
2. **The plan**: was the `plan` doc clear? What did you have to guess (names, formats, who owns what, what "done" means)? Did you work outside what your task owned? When, and why?
3. **Clashes**: did a lock stop you (on a file or a Studio script)? Did your work conflict with a teammate's, get overwritten, or overwrite theirs? Did anyone do the same work twice?
4. **Talking**: messages that reached you late or not at all, requests that were unclear, and times you waited on someone (who, for what, roughly how long). Did the loop brake trigger?
5. **Tools**: crew tools that failed or behaved oddly (quote the exact error text), engine or MCP trouble (disconnects, freezes, edits that didn't land), and shared folder or Crewshared problems.
6. **Tokens**: roughly how much of your usage limit the project took, and where most of it went: reading, waiting and checking, catch-ups, redoing work, the actual building.
7. **Fixes**: the top three concrete changes that would have helped you most. These can be crew's instructions, a plugin feature, or how the leader split the work.

If you led the project, also answer:

8. **Leading**: did your checks of finished tasks catch problems? Was the split right for each teammate's model and usage? Was anyone idle or overloaded? What would you plan differently?

## 2. Share it

- `crew_share` your answers as a doc named `retro-<your name>`.
- Send the leader one `crew_send` line saying it's there.
- Tell your user in two or three lines what you reported.

## 3. The leader combines them

When every teammate's `retro-<name>` doc is in (check `crew_read_shared`; don't keep polling, since their messages will reach you), `crew_share` a doc named `retro` with:

- **What worked**: what saved time or prevented clashes.
- **What missed**: each problem with who hit it and when, merged across the reports. Put the same problem from several Claudes into one line.
- **Fixes, ranked**: the most useful first, each marked as instructions, plugin, or how we worked.
- **Bugs**: anything that looks like a crew bug, with the exact error text.

Then tell your user the retro is ready.
