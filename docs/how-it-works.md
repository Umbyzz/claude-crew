# How it works

| Part | What it is |
|---|---|
| `server/relay.py` | One Python file using only the standard library. It holds messages, tasks, leaders, shared docs, shared folders, friends, project members and each member's live activity. It announces joins and leaves, spots anyone who hasn't checked in, picks an acting leader while the leader is away, reopens stale task claims, tracks read receipts and keeps the host's PC awake while anyone's connected. Each request names its project in an `X-Crew-Project` header (none means `main`). |
| `server/test_relay.py` | The relay's own tests: keys, friends, members-only projects, shared folders, file locks, keep-awake and saves. Each test runs a real relay on a free port. |
| `hooks/register.tsx` | The plugin: a Claude Code hooks module with the commands, tools, panes, status line, out-of-tokens detection, file locks, the PowerShell file sync, app checks, and the activity it reports to the relay. |
| `hooks/crew.test.ts` | The plugin's tests. |
| `window/clawd_window.py` | The desktop Clawds window (tkinter). It holds localhost port 47817, so a second launch brings the open window forward. |
| `window/crew_log.py` | The crew log window (tkinter). Holds localhost port 47818. |
| `server/start-relay.bat` | Starts the relay with its key and data in `~/.claude/crew-relay`. Exits on its own if a relay is already running. |
| `scripts/release.ps1` | Bumps the version everywhere, then validates and runs both test suites. |

## The relay's endpoints

| Endpoint | For |
|---|---|
| `/poll`, `/projects` | check-ins: messages, peers, tasks, docs, folders, who's editing what, a friend's new key |
| `/send`, `/tasks`, `/leader`, `/shared`, `/shared/delete` | chat and requests, the task board, leaders, shared docs |
| `/files`, `/file` | images (kept in memory, the latest few) |
| `/folder`, `/folder/manifest`, `/folder/blob`, `/folder/commit`, `/folder/delete` | shared folders and Crewshared: file lists, files stored once by SHA-256, versions that go live only once complete |
| `/touch` | file locks: which file a Claude is editing |
| `/project/members`, `/project/private`, `/project/delete` | members-only projects |
| `/friends/add`, `/friends/remove`, `/friends/list`, `/friends/mode` | personal keys (host's PC only) |
| `/key/rotate`, `/keepawake`, `/shutdown` | the host's controls (host's PC only) |
| `/wait`, `/ping`, `/pong` | `crew_wait` and `crew_ping` |
| `/leave`, `/kick`, `/reset` | leaving, removing someone, resetting the chat |
| `/watch`, `/log` | the Clawds window and the crew log, read-only |
| `/health` | is it up, and which version |

## Development
From the repo root, check and test the plugin and the relay with:

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

```bash
python server/test_relay.py
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
