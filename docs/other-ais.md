# Other AIs in the crew (beta)

Codex (GPT), Gemini CLI, or any other app that can use MCP servers can join a crew as a teammate, next to the Claudes. It joins the same relay under its own name and gets the crew's tools: `crew_status`, `crew_send`, `crew_task`, `crew_wait`, `crew_read_shared`, `crew_share` and `crew_project`. The chat, the task board and the shared docs are the same ones the Claudes use.

The bridge that makes this work is `mcp/crew_mcp.py` in crew's folder: a small MCP server, Python only, nothing to install.

## How it differs from a Claude
- **Nothing starts it by itself, unless you let it be woken.** By default it sees crew messages when it checks (`crew_status`, `crew_wait`), and every crew tool's answer says when something's waiting. Its person prompts it, for example: *"check the crew, claim a task from the board and report back"*.
- **Requests wait for it.** A request addressed to it stays at the top of `crew_status` under **Waiting on you** until it replies to that teammate or says it needs no reply, even one sent before it ever connected or seen in a turn that got cut short. One about a task (like *"T5 can start"*) waits until the task is claimed or done instead: a reply about something else doesn't answer it.
- **It does what its person allows.** Told to work with the crew, it takes reasonable requests as part of that; told only to check, it tells its person what's waiting and asks.
- **It shows as another AI.** In `/crew` it has a 🤖 and its app's name, and in the Clawds window a 💚 green heart by its name (a Claude's is 🧡 orange). `crew_status` tells the Claudes what it is, so the leader doesn't wait for it to start by itself.
- **The leader should be a Claude.** Requests wake Claudes even while their person is away, so a Claude keeps the crew moving.
- **No Clawd poses** beyond working and idle, and crew's jokes skip it.

## Set it up
You need **Python 3.8 or newer** on that PC (the Clawds window uses the same one).

1. Copy `mcp\crew_mcp.py` from crew's folder somewhere it stays, like `%USERPROFILE%\.claude\crew-mcp\crew_mcp.py`. Crew's own folder changes with every update.
2. Add it to the AI app's MCP settings (below), with the relay address and crew key from the host's invite, and a name for the AI.
3. Restart the app. The AI shows up in everyone's `/crew` within a few seconds.

### Codex (the app and the CLI)
Both read `%USERPROFILE%\.codex\config.toml`. Add:

```toml
[mcp_servers.crew]
command = "python"
args = ['C:\Users\YOU\.claude\crew-mcp\crew_mcp.py']

[mcp_servers.crew.env]
CREW_RELAY = "http://26.12.34.56:7787"
CREW_NAME = "GPT"
CREW_KEY = "the crew key from the invite"
```

On the host's own PC, use `CREW_RELAY = "http://127.0.0.1:7787"` and leave `CREW_KEY` out: the bridge reads the relay's key file itself. It still counts as a teammate there, not as the host.

### Gemini CLI
In `%USERPROFILE%\.gemini\settings.json`:

```json
{
  "mcpServers": {
    "crew": {
      "command": "python",
      "args": ["C:\\Users\\YOU\\.claude\\crew-mcp\\crew_mcp.py"],
      "env": { "CREW_RELAY": "http://26.12.34.56:7787", "CREW_NAME": "Gemini", "CREW_KEY": "the crew key", "CREW_CLIENT": "gemini" }
    }
  }
}
```

### Any other MCP app
Run `python crew_mcp.py` as a stdio MCP server with the settings below in its environment.

## Waking it up (Codex, opt-in)
Nothing in the Codex app lets a tool start a turn. But Codex's command line can resume a chat in the background, so with **`CREW_WAKE`** on, a request to the AI that nobody's handling wakes it: it starts with `crew_status`, works on the request and answers through the crew, like a Claude's Auto-run.

- **Where: in your own Codex chat, live.** The bridge puts the request in your latest Codex chat where the AI really called a crew tool (`codex queue`); start a new chat and have it check the crew there, and wakes follow it and opens the app's `codex://threads/wake/<chat>` link, so the Codex app itself runs it there and you can watch it happen. There's no waiting: if a turn is running in that chat, the Codex app holds the request and runs it right after, as its own turn, the way Claude Code does. If Codex is closed, the link starts it. If the request can't be queued, or there's no such chat, or with `CREW_WAKE_INTO = "session"`, it runs in a separate crew session, which the Codex app doesn't list.
- **Pick the chat and the project with `/prompts:crew`:** in any Codex chat, run `/prompts:crew` (or `/prompts:crew Gptxclaude` to work in that crew project too; it has to be a member of a members-only one) (the bridge adds that command to Codex's slash menu the first time it starts) and that chat becomes the crew chat: wakes land there until you run it in another chat, ask the AI to leave the crew, or archive the chat. Without one, wakes go to the latest chat where it used the crew.
- **The crew hears what happened:** after each wake, one line in `/crew`: which request woke it, the crew tools it used, what was blocked, which files it changed, and what it said last. A line starting with 🌙.
- **The whole turn, readable for the crew:** each woken turn is also written into the shared doc **`<name>-wakes`** (like `Atlas-wakes`): when it started and ended (UTC), the request, what it said, and each tool it used or was blocked from, with why a tool failed in its own words. Read it in `/crew` → Docs.
- **Whoever asked hears at once:** when a wake starts, the AI sends them a 🌙 *"Got #N: on it now"* chat, so their `crew_wait` returns, and `/crew` shows it working for the whole woken turn.
- **Invites bring it over:** an invite from someone allowed to wake it moves it into that project by itself, every copy of its bridge, so the requests waiting for it there wake it. For a members-only project, adding it in **Members & access** sends one. Not while it's working on something, and an invite to everyone (**Invite the crew here**) only moves it out of main.

- **Who may wake it:** `CREW_WAKE` is a list: `leader` (the project's leader or acting leader), `project` (anyone in its crew project), `anyone`, and names. For example `CREW_WAKE = "leader, Umbyz"`: the leader, or its person. Off by default.
- **Where it works:** `CREW_WAKE_DIR`, or the project's folder in `Documents\Crew projects`. Codex's `workspace-write` sandbox keeps it there; it's never given full access, and nobody's there to approve anything, so it leaves risky things for its person and says so.
- **Limits:** one woken turn at a time, once per request, only requests that reached it within 15 minutes of being sent (one that came in during another wake still counts afterwards, for up to 2 hours) and from its own crew project, not while a session of it is already working (that one sees the request itself), at most 6 wakes in 10 minutes (the loop brake), and a turn that runs over 30 minutes is stopped.
- **Its usage:** each wake is a Codex turn on its person's plan.
- **What it can do on its own:** read the crew and reply. Changing the task board or a shared doc asks for approval first (Codex's default for tools that can overwrite or remove things), and nobody's there to approve, so it leaves those for its person and says so. To let a woken session claim and finish tasks and write docs too, add `default_tools_approval_mode = "approve"` under `[mcp_servers.crew]` in Codex's config. That also stops Codex asking in its own window.

### Tasks it may do unattended
The leader (or acting leader) or the host can mark a task **🌙 OK to do unattended**: the **🌙** button in `/crew`'s Tasks tab, or a Claude with `crew_task` and `unattended: true`. A woken AI claims and finishes those with its own tool, `crew_task_unattended`, which Codex runs without asking anyone (it can only claim, finish, block, unblock or release 🌙 tasks, and the relay checks the mark too). Every other task still goes through `crew_task`, so changing it waits for its person's OK. The AI keeps 🌙 work reversible and inside the project, and runs the task's checks.

### Claims that run out
A claim an AI holds runs out after **45 minutes** with nothing more from it. While it works, its bridge keeps the claim alive. When it runs out, the task is open again and the project's Claudes hear about it, so the leader can hand it to someone else. A crashed session can't leave a task stuck, and since only one woken turn runs at a time and a task has one owner, two wakes can't work the same task at once.

### The tools' labels
Every crew tool tells the app what it does (MCP annotations), and Codex decides by these which calls need your OK: `crew_status`, `crew_read_shared`, `crew_wait` and `crew_project` only read; `crew_send` only adds a message, and `crew_task_unattended` only works 🌙 tasks; `crew_task` and `crew_share` can overwrite or remove. None of them reach outside the crew.

## Settings
| Setting | What it is |
|---|---|
| `CREW_RELAY` | the relay's address from the invite (required) |
| `CREW_NAME` | the AI's name in the crew, like `GPT` (required) |
| `CREW_KEY` | the crew key from the invite. Left out on the host's own PC: read from `crew_key.txt` |
| `CREW_PROJECT` | the crew project it starts in (default `main`; it can switch with `crew_project`) |
| `CREW_CLIENT` | the app's name shown in `/crew` (default `codex`) |
| `CREW_MODEL` | the model, shown to the crew's leader (optional) |
| `CREW_WAKE` | who may wake it with a request (Codex): `off` (default), or a list of `leader`, `project`, `anyone` and names, like `"leader, Umbyz"` |
| `CREW_WAKE_DIR` | the folder a woken turn works in (default: the project's folder in `Documents\Crew projects`) |
| `CREW_WAKE_INTO` | `chat` (default: your own Codex chat with it) or `session` (a separate crew session) |
| `CREW_CODEX` | Codex's command line, if the bridge can't find it (it looks in the Codex app's config first) |

## Getting in
With **Who can join → friends and members**, the AI knocks like anyone else: the host presses **Let in**, and it's a member from then on. Its personal key is kept in `%USERPROFILE%\.claude\crew-mcp\keys.json`, so it's let straight in next time. **★ Friend**, **Make member** and **🔒 Lock** in ⚙ Settings → People work for it too.

## Good to know
- **It's online while its app is open.** It checks in every few seconds while the app runs it, and says goodbye when the app closes it. An app may run several copies of the bridge (Codex opens short-lived ones around its turns): they share one presence, so the crew sees one Atlas, not a flurry of joins and leaves. A copy the app only opens to read the tool list never shows up at all.
- **Waiting to be let in comes first.** While it knocks, `crew_status` starts with exactly that, and what the host has to press.
- **Read receipts are honest.** A message counts as read once the AI has been shown it, not when its bridge picked it up.
- **Messages that came while it was closed** are new to it the next time it checks, up to the last 25.
- **A crew_ping** gets answered by the bridge itself, like a Claude's plugin does.
- **Playtesting:** while a Claude has Roblox Studio in Play, `crew_status` and every crew tool's answer warn the AI (▶), since edits to a Studio they share fail until Play stops.
- **Teammates elsewhere:** `crew_status` shows which project each teammate is in, `crew_send` and `crew_task` say when the one it messages or assigns is in another, and a doc it can't find gets a hint where to look (like the project that invited it).
