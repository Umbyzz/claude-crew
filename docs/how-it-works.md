# How it works

| Part | What it is |
|---|---|
| `server/relay.py` | One Python file using only the standard library. It holds messages, tasks, the leader, shared docs, the latest images (in memory) and each member's live activity. It announces joins and leaves, spots anyone who hasn't checked in, picks an acting leader while the leader is away, reopens stale task claims, and tracks read receipts. Each request names its project in an `X-Crew-Project` header (none means `main`). Endpoints: `/poll`, `/projects`, `/send`, `/tasks`, `/leader`, `/shared`, `/files` and `/file` (images), `/leave`, `/wait` (crew_wait), `/ping` and `/pong` (crew_ping), `/reset` (chat), `/shutdown` (host only), `/watch` (Clawds) and `/log` (crew log), both read-only, and `/health`. |
| `hooks/register.tsx` | The plugin. It's a Claude Code hooks module: the commands, the tools, the panes, the status line, the out-of-tokens detection, and the activity it reports to the relay (thinking, typing, tools, chatting, done, cheer, subagents). |
| `window/clawd_window.py` | The desktop Clawds window, written with tkinter. It holds localhost port 47817 so a second launch brings the open window forward instead of opening another. Try `--demo` for a pretend crew, `--drama 1` to make everything over the top, and `--trip car|teleport|superman|door|bird` to see one way of arriving and leaving. |
| `window/crew_log.py` | The crew log window (tkinter): every crew message live, filtered Everything / Claudes / People. Holds localhost port 47818. |
| `server/start-relay.bat` | Starts the relay with its key and data in `~/.claude/crew-relay`. |
| `scripts/release.ps1` | Bumps the version everywhere and checks the plugin. |

## Development
From the repo root, check and test the plugin with:

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

To see the Clawds window without a relay, run:

```bash
python window/clawd_window.py --demo --drama 0.5
```

The window's options:

| Option | What it does |
|---|---|
| `--relay URL --key KEY --name NAME` | connect without reading the plugin's settings |
| `--demo` | a pretend crew of three, looping through every mood (and a meetup) every 50 seconds |
| `--drama 0…1` | how often things go over the top (default `0.2`) |
| `--trip car\|teleport\|superman\|door\|bird` | always arrive and leave this way |
| `--leave-at SECONDS` | in the demo, when nova disconnects (default 44) |
| `--multi` and `--at X,Y` | testing: allow a second window and place it, to compare two "PCs" side by side |

---
[← Back to the README](../README.md)
