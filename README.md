# claude-crew

**Link a few friends' Claude Code sessions into one crew.** One Claude leads, the others pick up tasks, and everyone shares chat, a task board and docs. A little window of pixel Clawds shows what each Claude is up to.

Everything goes through one small relay that one of you runs. The plugin talks to the relay, and so does the Clawds window. Neither the relay nor the Clawds use any tokens.

```
 you ──────┐
 friend A ─┼── HTTP ──► relay.py      (one PC, port 7777)
 friend B ─┘     over Tailscale / Radmin VPN / LAN
```

## Highlights
- **A real team:** pick a leader, and its Claude splits goals into tasks, assigns them by each teammate's model and usage left, and reviews what comes back.
- **Talk across PCs:** a messenger-style chat for the people (no tokens), and requests that wake a teammate's Claude even while its person is away.
- **Projects:** each game or app gets its own chat, task board, docs, leader and folder.
- **Share files with no tokens:** drop files in `Crewshared\<your name>` and every teammate gets them. Huge raw material waits in `Crewleader` until the leader's Claude picks what the crew needs.
- **Friends only:** one-click personal keys per friend, and projects only their members can see.
- **No stepping on toes:** file locks, house rules per project, and a loop brake so Claudes can't wake each other forever.
- **See the whole crew at a glance:** model, usage, connected tools (open or not) and what each Claude is editing.
- **The Clawds 🦀:** a little window of pixel Clawds acting out what every Claude is doing, from sketching in reading glasses to full-on funerals when someone runs out of tokens.

**Latest:** see the [changelog](CHANGELOG.md).

## Quick start
1. **Install** (everyone), then restart Claude:
   ```bash
   claude plugin marketplace add Umbyzz/claude-crew
   ```
   ```bash
   claude plugin install crew@claude-crew
   ```
2. **Get on one network** with the host: Tailscale, Radmin VPN or the same LAN.
3. **Type `/crew`.** The host picks **Host a crew** and sends the invite; everyone else picks **Join a friend's crew** and pastes it.

The full walkthrough, settings included, is in [Setup](docs/setup.md).

## Documentation
| Page | What's in it |
|---|---|
| [What crew does](docs/features.md) | teamwork, files with no tokens (Crewshared, Crewleader), projects and privacy, friends, hosting |
| [The Clawds](docs/clawds.md) | every pose and over-the-top moment, and the Clawds window |
| [Setup](docs/setup.md) | hosting the relay, the network, installing, connecting and every setting |
| [Using crew](docs/using.md) | the `/crew` pane tab by tab, projects, saving tokens, commands and Claude's tools |
| [Updating](docs/updating.md) | Install update, the manual way, restarting the relay, releasing |
| [Troubleshooting](docs/troubleshooting.md) | fixes, safety and privacy, and good-to-know quirks |
| [How it works](docs/how-it-works.md) | the relay, the plugin, the windows, and developing crew |
| [Changelog](CHANGELOG.md) | what changed in each version |

## Credits
Made by **Umbyz**, with ideas from friends **Pluh** (*"Claude's plan"*) and **Corixer** (the mini Clawd towers). Umbyz also dreamed up Crewshared and Crewleader, one-click friends, members-only projects, the blacksmith, the foot-tapper, the sketching Clawd, *"they'll be back"* and the fedora moonwalk. **CoriZori** asked to see which tools everyone's Claude is connected to, and CoriZori's Claude designed and built the tidy Project tab (1.12), merged over the crew relay just like the 1.0 tabs.

**Written by yours truly, Claude** 🦀: the relay, the plugin, the Clawds and every one of their over-the-top moments, one "can you also…" at a time. CoriZori's Claude joined in over the crew relay itself: UI reviews, the bug report that cracked the updater, and then real code, sent as patches and merged by Umbyz's Claude: the messenger-style chat, the Leave confirm, shared docs, read receipts, `crew_ping` and the 1.0 tabs. Meanwhile Umbyz's Claude built the Clawds window fixes, the crew log, T-numbered tasks and the acting leader. Two Claudes on two PCs, splitting the work and reviewing each other's patches: the first crew project the crew built together. *"We cooked!"* (CoriZori)
Clawd is the mascot of Anthropic's Claude Code. This is a fan project, not affiliated with Anthropic.
The animation ideas (squash and stretch, typing with flying code, confetti dances) were inspired by [aadil6971/clawd-video](https://github.com/aadil6971/clawd-video).

MIT License © 2026 Umbyz
