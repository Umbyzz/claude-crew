"""Tests for crew's bridge for other AIs (crew_mcp.py): MCP over stdio, the way Codex runs it, against a real relay.

    python mcp/test_crew_mcp.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "server"))
from test_relay import KEY, Relay  # noqa: E402  (a real relay on a free port, from the relay's own tests)

BRIDGE = os.path.join(HERE, "crew_mcp.py")

# A stand-in for Codex's command line: notes how it was run, and acts out a turn in the session it was given.
FAKE_CODEX = r"""
import json, os, sys, time
args = sys.argv[1:]
with open(os.environ["FAKE_CODEX_LOG"], "a", encoding="utf-8") as f:
    f.write(json.dumps({"args": args, "prompt": sys.stdin.read(), "cwd": os.getcwd()}) + "\n")
if args[0] == "queue":  # `codex queue`: the app runs it in that chat (acted out straight into the chat's file)
    if os.environ.get("FAKE_QUEUE_FAIL"):
        sys.exit(2)
    message, rollout = args[args.index("--message") + 1], os.environ.get("FAKE_ROLLOUT")
    if rollout:
        turn = [{"type": "task_started", "turn_id": "t-q"},
                {"type": "item_completed", "turn_id": "t-q", "item": {"type": "UserMessage", "content": [{"type": "Text", "text": message}]}},
                {"type": "item_completed", "turn_id": "t-q", "item": {"type": "McpToolCall", "server": "crew", "tool": "crew_status", "status": "completed"}},
                {"type": "item_completed", "turn_id": "t-q", "item": {"type": "AgentMessage", "content": [{"type": "Text", "text": "On it, from your chat."}]}}]
        if os.environ.get("FAKE_ABORT"):  # its person stops it partway, after it claimed T2
            turn += [{"type": "item_completed", "turn_id": "t-q", "item": {"type": "McpToolCall", "server": "crew", "tool": "crew_task",
                                                                          "status": "completed", "arguments": {"action": "claim", "id": "T2"}}},
                     {"type": "turn_aborted", "turn_id": "t-q", "reason": "interrupted"}]
        else:
            turn.append({"type": "task_complete", "turn_id": "t-q", "last_agent_message": "Done, I replied to umbyz."})
        moved = os.environ.get("FAKE_ROTATE")  # Codex goes on in a new file for this chat once the turn started
        with open(rollout, "a", encoding="utf-8") as f:
            for p in turn[:2] if moved else turn:
                f.write(json.dumps({"type": "event_msg", "payload": p}) + "\n")
        if moved:
            import sqlite3
            con = sqlite3.connect(os.environ["FAKE_DB"])
            con.execute("update threads set rollout_path = ? where id = ?", (moved, args[args.index("--thread") + 1]))
            con.commit()
            con.close()
            with open(moved, "a", encoding="utf-8") as f:
                for p in turn[2:]:
                    f.write(json.dumps({"type": "event_msg", "payload": p}) + "\n")
    print("Queued message q-1 for thread " + args[args.index("--thread") + 1] + ".")
    sys.exit(0)
thread = args[args.index("resume") + 1] if "resume" in args else "thread-1"
for e in ({"type": "thread.started", "thread_id": thread}, {"type": "turn.started"},
          {"type": "item.completed", "item": {"type": "mcp_tool_call", "server": "crew", "tool": "crew_status", "status": "completed"}},
          {"type": "item.completed", "item": {"type": "mcp_tool_call", "server": "crew", "tool": "crew_task", "status": "failed",
                                              "error": {"message": "MCP tool call requires approval, but approval policy is never"}}},
          {"type": "item.completed", "item": {"type": "mcp_tool_call", "server": "codex_apps", "tool": "update_running_summary",
                                              "status": "failed", "error": {"message": "summary store unavailable"}}},
          {"type": "item.completed", "item": {"type": "file_change", "changes": [{"path": "C:/work/gate.lua", "kind": "update"}]}},
          {"type": "item.completed", "item": {"type": "agent_message", "text": "Checked the gate, it's fine."}},
          {"type": "turn.completed"}):
    if e["type"] == "turn.completed":
        time.sleep(float(os.environ.get("FAKE_SLEEP") or 0))  # a long turn
    print(json.dumps(e), flush=True)
"""


def codex_home_with_a_chat(folder, crew=True, quiet=True):
    """A stand-in for Codex's own list of chats: one chat of its person's in the app (that used the crew tools)."""
    import sqlite3
    rollout = os.path.join(folder, "rollout-chat.jsonl")
    with open(rollout, "w", encoding="utf-8") as f:
        used = {"type": "event_msg", "payload": {"type": "item_completed", "item": {"type": "McpToolCall", "server": "crew",
                                                                                    "tool": "crew_status", "status": "completed"}}}
        said = {"type": "event_msg", "payload": {"type": "item_completed", "item": {"type": "UserMessage",
                                                                                    "content": "what does crew_status do?"}}}
        f.write(json.dumps({"payload": {"source": "vscode"}}) + "\n" + json.dumps(used if crew else said) + "\n")
    if quiet:
        os.utime(rollout, (time.time() - 600, time.time() - 600))
    con = sqlite3.connect(os.path.join(folder, "state_5.sqlite"))
    con.execute("create table threads (id text, rollout_path text, updated_at integer, source text, originator text, archived integer)")
    con.execute("insert into threads values ('chat-7', ?, 1, 'vscode', 'Codex Desktop', 0)", (rollout,))
    con.execute("insert into threads values ('exec-1', 'none', 2, 'exec', 'codex_exec', 0)")
    con.commit()
    con.close()
    return rollout


def token_count(*windows, ago=0, plan="plus"):
    """The record Codex notes in a chat's file after each turn, with its rate limits: (% used, window in minutes,
    seconds until it resets) for each window. Made-up numbers."""
    def window(w):
        return {"used_percent": float(w[0]), "window_minutes": w[1], "resets_at": int(time.time() + w[2])}
    limits = {"limit_id": "codex", "limit_name": None, "primary": window(windows[0]),
              "secondary": window(windows[1]) if len(windows) > 1 else None, "credits": None, "plan_type": plan}
    return {"timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() - ago)), "type": "event_msg",
            "payload": {"type": "token_count", "info": {"total_token_usage": {"total_tokens": 1234}},
                        "rate_limits": limits}}


def codex_home_with_usage(folder, *records):
    """A stand-in for Codex's session files: one chat in its day folder, whose turns noted these records."""
    day = os.path.join(folder, "sessions", "2026", "11", "24")
    os.makedirs(day)
    with open(os.path.join(day, "rollout-2026-11-24T09-30-00-made-up-thread.jsonl"), "w", encoding="utf-8") as f:
        f.write(json.dumps({"type": "session_meta", "payload": {"id": "made-up-thread"}}) + "\n")
        f.writelines(json.dumps(r) + "\n" for r in records)


def codex_home_with_chats(folder, chats):
    """A stand-in for Codex's list of chats as it is today (its own note of when each changed, each chat's folder).
    Each chat: dict(id, folder, noted (Codex's note), file (the file's own time), said (the project its crew tools last
    said, or None), typed (when its person last typed, or None)). Each used the crew tools."""
    import sqlite3
    con = sqlite3.connect(os.path.join(folder, "state_5.sqlite"))
    con.execute("create table threads (id text, rollout_path text, updated_at integer, updated_at_ms integer, source text, "
                "originator text, archived integer, cwd text)")
    for c in chats:
        path = os.path.join(folder, f"rollout-{c['id']}.jsonl")
        said = f"crew · you're GPT in the project '{c['said']}' · connection: connected" if c.get("said") else "ok"
        lines = [{"type": "event_msg", "payload": {"type": "item_completed", "item": {
            "type": "McpToolCall", "server": "crew", "tool": "crew_status", "status": "completed",
            "result": {"content": [{"type": "text", "text": said}]}}}}] if c.get("used", True) else []
        if c.get("typed"):
            lines.append({"type": "event_msg", "payload": {"type": "item_completed", "completed_at_ms": int(c["typed"] * 1000),
                                                           "item": {"type": "UserMessage", "content": [{"type": "text", "text": "/prompts:crew"}]}}})
        with open(path, "w", encoding="utf-8") as f:
            f.write("".join(json.dumps(x) + "\n" for x in lines))
        os.utime(path, (c["file"], c["file"]))
        con.execute("insert into threads values (?, ?, ?, ?, 'vscode', 'Codex Desktop', 0, ?)",
                    (c["id"], path, int(c["noted"]), int(c["noted"] * 1000), os.path.join(folder, c["folder"])))
    con.commit()
    con.close()


def until(check, timeout=8.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if check():
            return
        time.sleep(0.1)
    raise AssertionError("timed out waiting")


class Bridge:
    """crew_mcp.py the way an MCP app runs it: JSON-RPC, one message per line, over its stdin and stdout."""

    def __init__(self, relay, name="GPT", key=KEY, home=None, **env):
        self.home = home or tempfile.mkdtemp(prefix="crew-mcp-test-")
        full = {**os.environ, "CREW_NAME": name, "CREW_KEY": key, "CREW_MCP_HOME": self.home, "CREW_MCP_POLL": "0.2",
                "CREW_MCP_GRACE": "0", "CREW_MCP_BUSY": "1", "CREW_RELAY": f"http://127.0.0.1:{relay.port}" if relay else "",
                "CREW_CODEX_HOME": os.path.join(self.home, "no-codex")}  # not this PC's real Codex chats
        full.update(env)
        self.proc = subprocess.Popen([sys.executable, "-I", BRIDGE], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, env=full)
        self.got, self.cond, self.n = {}, threading.Condition(), 0
        threading.Thread(target=self.read, daemon=True).start()

    def read(self):
        for raw in self.proc.stdout:
            msg = json.loads(raw)
            with self.cond:
                self.got[msg.get("id")] = msg
                self.cond.notify_all()

    def request(self, method, params=None, timeout=30):
        with self.cond:
            self.n += 1
            mid = self.n
        self.proc.stdin.write((json.dumps({"jsonrpc": "2.0", "id": mid, "method": method, "params": params or {}}) + "\n").encode())
        self.proc.stdin.flush()
        with self.cond:
            if not self.cond.wait_for(lambda: mid in self.got, timeout):
                raise TimeoutError(method)
            return self.got.pop(mid)

    def tool(self, tool_name, /, **args):
        return self.request("tools/call", {"name": tool_name, "arguments": args})["result"]["content"][0]["text"]

    def close(self, keep_home=False):
        if self.proc.poll() is None:
            self.proc.stdin.close()  # the app closing this copy
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self.proc.stdout.close()
        if not keep_home:
            shutil.rmtree(self.home, ignore_errors=True)


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.r = Relay()
        self.bridges = []

    def tearDown(self):
        for b in self.bridges:
            b.close()
        self.r.close()

    def bridge(self, **kw):
        b = Bridge(self.r, **kw)
        self.bridges.append(b)
        return b

    def poll(self, name="umbyz"):
        return self.r.call("GET", "/poll?since=0", name, remote=False)[1]  # the host, on this PC

    def gpt(self):
        return next((p for p in self.poll().get("peers", []) if p["name"] == "GPT"), {})

    def online(self):
        return bool(self.gpt().get("online"))

    def said(self, kind):
        return [m for m in self.poll()["messages"] if m["from"] == "GPT" and m["kind"] == kind]

    def moon(self):
        """The 🌙 note the bridge posts after a wake (the relay's own "shared doc" lines aside)."""
        return next((m["text"] for m in self.said("update") if m["text"].startswith("🌙")), "")

    def ask(self, text, kind="request"):
        return self.r.call("POST", "/send", "umbyz", body={"to": "GPT", "kind": kind, "text": text}, remote=False)[1]

    def test_an_mcp_app_sees_the_crew_tools_and_how_crew_works(self):
        b = self.bridge()
        init = b.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                        "clientInfo": {"name": "test", "version": "0"}})["result"]
        self.assertEqual((init["serverInfo"]["name"], init["protocolVersion"]), ("crew", "2025-06-18"))
        self.assertIn("Your name in the crew is GPT", init["instructions"])
        self.assertIn("Waiting on you", init["instructions"])
        tools = b.request("tools/list")["result"]["tools"]
        names = {t["name"] for t in tools}
        hints = {t["name"]: t["annotations"] for t in tools}
        self.assertTrue(hints["crew_status"]["readOnlyHint"])  # so an app can run it without asking its person
        self.assertFalse(hints["crew_send"]["destructiveHint"])  # a message only adds
        self.assertTrue(hints["crew_share"]["destructiveHint"])  # a doc can be overwritten
        self.assertFalse(any(h["openWorldHint"] for h in hints.values()))  # all of it stays inside the crew
        self.assertEqual(names, {"crew_status", "crew_send", "crew_task", "crew_task_unattended", "crew_wait",
                                 "crew_read_shared", "crew_share", "crew_project", "crew_join"})
        self.assertFalse(hints["crew_task_unattended"]["destructiveHint"])  # 🌙 tasks only: Codex runs it without asking
        self.assertEqual(b.request("ping")["result"], {})
        self.assertEqual(b.request("resources/list")["result"], {"resources": []})  # Codex asks anyway
        self.assertEqual(b.request("resources/templates/list")["result"], {"resourceTemplates": []})
        self.assertIn("error", b.request("nope/nothing"))

    def test_a_request_waits_on_it_until_it_replies(self):
        b = self.bridge()
        until(self.online)
        self.assertEqual(self.gpt()["client"], "codex")
        sent = self.ask("review the gate")
        until(lambda: "1 request waiting on you" in b.tool("crew_read_shared"))  # every crew tool says so
        self.assertLess(self.poll()["reads"].get("GPT", 0), sent["id"])  # its AI hasn't seen it yet: not read
        status = b.tool("crew_status")
        self.assertIn("Waiting on you (1)", status)
        self.assertIn("umbyz → you (request): review the gate", status)
        self.assertEqual(self.poll()["reads"]["GPT"], sent["id"])  # now it has
        self.assertIn("Waiting on you (1)", b.tool("crew_status"))  # still: a turn cut short loses nothing
        self.assertIn("Sent #", b.tool("crew_send", text="done, the gate's fine", to="umbyz"))
        self.assertTrue(self.said("chat"))
        self.assertNotIn("Waiting on you", b.tool("crew_status"))  # answered

    def test_a_request_sent_before_its_first_connection_waits_on_it(self):
        self.ask("welcome! take T1 when you're in")
        b = self.bridge()
        self.assertIn("welcome! take T1", b.tool("crew_status"))

    def test_a_request_that_needs_no_reply_can_be_set_aside(self):
        b = self.bridge()
        sent = self.ask("fyi: the build is green")
        until(lambda: "Waiting on you (1)" in b.tool("crew_status"))
        self.assertNotIn("Waiting on you", b.tool("crew_status", answered=[sent["id"]]))

    def test_an_assigned_task_stops_waiting_once_claimed(self):
        b = self.bridge()
        until(self.online)
        self.r.call("POST", "/tasks", "umbyz", body={"action": "add", "title": "Polish the boat panel", "assignee": "GPT"},
                    remote=False)
        until(lambda: "is assigned to you" in b.tool("crew_status"))
        self.assertIn("claimed by GPT", b.tool("crew_task", action="claim", id="1"))
        self.assertNotIn("Waiting on you", b.tool("crew_status"))

    def test_marked_tasks_can_be_done_unattended_and_its_claim_is_kept_alive(self):
        b = self.bridge(CREW_MCP_RENEW="0.5", CREW_MCP_BUSY="5")
        until(self.online)
        add = lambda title, **kw: self.r.call("POST", "/tasks", "umbyz", body={"action": "add", "title": title, **kw},
                                              remote=False)[1]["id"]
        plain, marked = add("Plain"), add("Marked", unattended=True)
        self.assertIn("isn't marked 🌙", b.tool("crew_task_unattended", action="claim", id=str(plain)))
        self.assertIn("anything else is crew_task", b.tool("crew_task_unattended", action="remove", id=str(marked)))
        self.assertIn("claimed by GPT", b.tool("crew_task_unattended", action="claim", id=str(marked)))
        lease = lambda: next(t for t in self.poll()["tasks"] if t["id"] == marked).get("leaseUntil", 0)
        first = lease()
        until(lambda: lease() > first, timeout=6)  # it's working (busy), so the bridge renews its claim
        status = b.tool("crew_status")
        self.assertIn("🌙 OK unattended", status)
        self.assertIn("claim runs out", status)
        self.assertIn("done by GPT", b.tool("crew_task_unattended", action="done", id=str(marked), note="polished"))

    def test_wake_from_a_list_the_leader_and_people_by_name(self):
        self.r.call("POST", "/leader", "umbyz", body={"name": "umbyz"}, remote=False)
        self.waker(mode="leader, Carol")
        until(self.online)
        self.r.call("POST", "/send", "bob", body={"to": "GPT", "kind": "request", "text": "from bob"})
        time.sleep(1.5)
        self.assertEqual(self.wakes(), [])  # not on the list
        self.r.call("POST", "/send", "carol", body={"to": "GPT", "kind": "request", "text": "from carol"})
        until(lambda: len(self.wakes()) == 1)  # by name (any case)
        self.ask("from the leader")
        until(lambda: len(self.wakes()) == 2)

    def test_the_task_board_and_shared_docs(self):
        b = self.bridge()
        until(self.online)
        added = b.tool("crew_task", action="add", title="Build the shop UI")
        self.assertIn("add: Build the shop UI", added)
        tid = added.split()[0]
        self.assertIn("claimed by GPT", b.tool("crew_task", action="claim", id=tid))
        self.assertIn("done by GPT", b.tool("crew_task", action="done", id=tid, note="shop works, tested in play mode"))
        self.assertIn("Shared the doc 'plan'", b.tool("crew_share", name="plan", content="1. shop"))
        self.assertIn("Added to the doc 'plan'", b.tool("crew_share", name="plan", content="2. boats", append=True))
        self.assertIn("1. shop\n2. boats", b.tool("crew_read_shared", name="plan"))
        status = b.tool("crew_status")
        self.assertIn("Task board (0 open, 1 done)", status)
        self.assertIn("Shared docs: plan", status)
        self.assertIn("no task T99", b.tool("crew_task", action="claim", id="99"))  # an answer, not a crash

    def test_crew_wait_returns_as_soon_as_a_reply_lands(self):
        b = self.bridge()
        until(self.online)
        threading.Timer(0.8, lambda: self.ask("yes, go", kind="chat")).start()
        start = time.time()
        self.assertIn("yes, go", b.tool("crew_wait", timeout_s=20))
        self.assertLess(time.time() - start, 10)
        self.assertIn("No message", b.tool("crew_wait", timeout_s=1))

    def test_working_after_a_crew_tool_but_not_while_waiting(self):
        b = self.bridge()
        until(self.online)
        b.tool("crew_send", text="on it")
        until(lambda: self.gpt().get("activity") == "working")
        until(lambda: self.gpt().get("activity") == "idle", timeout=6)  # its tail is short (1 s in this test)
        b.tool("crew_wait", timeout_s=1.5)
        self.assertEqual(self.gpt().get("activity"), "idle")  # waiting for a reply isn't working

    def test_it_knocks_gets_let_in_and_keeps_its_key(self):
        self.r.call("POST", "/friends/mode", "umbyz", body={"door": "friends"}, remote=False)
        home = tempfile.mkdtemp(prefix="crew-mcp-test-")
        b = self.bridge(home=home)
        knocks = lambda: self.r.call("POST", "/friends/list", "umbyz", body={}, remote=False)[1].get("knocks", [])
        until(lambda: "GPT" in [k["name"] for k in knocks()])  # on the host's own PC, and still not the host
        status = b.tool("crew_status")
        self.assertTrue(status.startswith("🚪 Waiting for the host to let you in"), status[:80])  # first, not buried
        self.assertIn('presses Let in next to "GPT"', status)
        self.r.call("POST", "/friends/letin", "umbyz", body={"name": "GPT"}, remote=False)
        until(self.online)
        until(lambda: os.path.exists(os.path.join(home, "keys.json")))
        b.close(keep_home=True)
        again = self.bridge(home=home, CREW_KEY="no-longer-needed")  # its own key from now on
        until(self.online)
        self.assertNotIn("Waiting for the host", again.tool("crew_status"))

    def test_messages_from_while_the_app_was_closed_are_new_next_time(self):
        home = tempfile.mkdtemp(prefix="crew-mcp-test-")
        b = self.bridge(home=home)
        until(self.online)
        self.ask("first", kind="chat")
        until(lambda: "first" in b.tool("crew_status"))
        b.close(keep_home=True)
        until(lambda: not self.online())
        self.ask("while you were away", kind="chat")
        again = self.bridge(home=home)
        status = again.tool("crew_status")
        self.assertIn("New messages (1)", status)
        self.assertIn("while you were away", status)

    def test_copies_of_the_bridge_share_one_presence(self):
        home = tempfile.mkdtemp(prefix="crew-mcp-test-")
        main = self.bridge(home=home)
        until(self.online)
        turn = self.bridge(home=home)  # the short-lived copy an app opens around a turn
        turn.tool("crew_status")
        turn.close(keep_home=True)
        time.sleep(1)
        self.assertEqual(self.said("leave"), [])  # the other copy is still there: no goodbye
        self.assertTrue(self.online())
        main.close()
        self.assertEqual(len(self.said("leave")), 1)  # the last copy says it
        self.assertFalse(self.online())

    def test_a_copy_only_opened_to_read_the_tools_never_joins(self):
        b = self.bridge(CREW_MCP_GRACE="30")
        b.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}})
        b.request("tools/list")
        b.close()
        time.sleep(0.5)
        self.assertEqual(self.gpt(), {})  # never showed up, so never left either
        self.assertEqual(self.said("join") + self.said("leave"), [])

    def test_it_says_goodbye_when_the_app_closes(self):
        b = self.bridge()
        until(self.online)
        b.close()
        self.assertFalse(self.online())  # at once, not a minute later
        self.assertEqual(len(self.said("leave")), 1)

    # -- waking it: CREW_WAKE, with the stand-in for Codex's command line

    def waker(self, mode="project", **kw):
        folder = tempfile.mkdtemp(prefix="crew-mcp-wake-")
        self.addCleanup(shutil.rmtree, folder, True)
        fake = os.path.join(folder, "fake_codex.py")
        with open(fake, "w", encoding="utf-8") as f:
            f.write(FAKE_CODEX)
        link = os.path.join(folder, "fake_link.py")
        self.links_log = os.path.join(folder, "links.txt")
        with open(link, "w", encoding="utf-8") as f:
            f.write("import sys\nopen(sys.argv[1], 'a').write(sys.argv[2] + '\\n')\n".replace("sys.argv[1]", repr(self.links_log))
                    .replace("sys.argv[2]", "sys.argv[1]"))
        self.wakes_log = os.path.join(folder, "wakes.jsonl")
        return self.bridge(CREW_WAKE=mode, CREW_CODEX=fake, CREW_WAKE_DIR=folder, FAKE_CODEX_LOG=self.wakes_log,
                           CREW_OPEN_LINK=link, **kw)

    def links(self):
        try:
            with open(self.links_log, encoding="utf-8") as f:
                return [line.strip() for line in f if line.strip()]
        except OSError:
            return []

    def wakes(self):
        try:
            with open(self.wakes_log, encoding="utf-8") as f:
                return [json.loads(line) for line in f if line.strip()]
        except OSError:
            return []

    def test_a_request_wakes_it_once_and_the_next_resumes_the_same_session(self):
        self.waker()
        until(self.online)
        self.ask("please check the gate")
        until(lambda: len(self.wakes()) == 1)
        first = self.wakes()[0]
        self.assertIn("please check the gate", first["prompt"])
        self.assertIn("nobody is watching it", first["prompt"])
        self.assertNotIn("resume", first["args"])  # the first wake makes its crew session
        self.assertIn("workspace-write", first["args"])
        self.assertNotIn("danger-full-access", first["args"])
        self.assertIn('mcp_servers.crew.env.CREW_WAKE="off"', first["args"])  # the woken session can't wake itself
        time.sleep(1.5)
        self.assertEqual(len(self.wakes()), 1)  # once per request
        self.ask("and the boat panel?")
        until(lambda: len(self.wakes()) == 2)
        second = self.wakes()[1]["args"]
        self.assertEqual(second[second.index("resume") + 1], "thread-1")  # the same crew session, resumed

    def test_waking_is_off_unless_its_person_turns_it_on(self):
        self.waker(mode="off")
        until(self.online)
        self.ask("anyone there?")
        time.sleep(1.5)
        self.assertEqual(self.wakes(), [])

    def test_on_leader_only_the_leader_wakes_it(self):
        self.r.call("POST", "/leader", "umbyz", body={"name": "umbyz"}, remote=False)
        self.waker(mode="leader")
        until(self.online)
        self.r.call("POST", "/send", "bob", body={"to": "GPT", "kind": "request", "text": "from bob"})
        time.sleep(1.5)
        self.assertEqual(self.wakes(), [])
        self.ask("from the leader")
        until(lambda: len(self.wakes()) == 1)
        self.assertIn("from the leader", self.wakes()[0]["prompt"])

    def test_not_while_a_session_of_it_is_working(self):
        home = tempfile.mkdtemp(prefix="crew-mcp-test-")
        self.waker(home=home)
        until(self.online)
        mine = self.bridge(home=home, CREW_MCP_BUSY="4")  # its person's own Codex window, busy with something
        mine.tool("crew_read_shared")
        self.ask("quick one")
        time.sleep(2)
        self.assertEqual(self.wakes(), [])  # that session sees the request itself
        until(lambda: len(self.wakes()) == 1, timeout=10)  # idle again, and nobody answered it: now it wakes

    def test_an_old_request_waits_for_its_person(self):
        b = self.waker()
        until(self.online)
        self.r.call("POST", "/send", "umbyz", body={"to": "GPT", "kind": "request", "text": "from long ago", "waited": 1200},
                    remote=False)
        time.sleep(1.5)
        self.assertEqual(self.wakes(), [])
        self.assertIn("from long ago", b.tool("crew_status"))  # still waiting on it

    def test_the_loop_brake_stops_waking_after_six_in_ten_minutes(self):
        self.waker()
        until(self.online)
        for i in range(7):
            self.ask(f"job {i}")
        until(lambda: len(self.wakes()) == 6, timeout=20)
        time.sleep(1.5)
        self.assertEqual(len(self.wakes()), 6)

    def test_after_a_wake_the_crew_hears_what_happened(self):
        self.waker()
        until(self.online)
        sent = self.ask("is the gate ok?")
        until(self.moon)
        note = self.moon()
        self.assertIn(f"woke in its crew session for #{sent['id']} from umbyz", note)
        self.assertIn("used crew_status", note)
        self.assertIn("changed gate.lua", note)  # the file's name, not where it lives
        self.assertIn("blocked: crew_task (needs approval)", note)
        self.assertIn("Last said: Checked the gate, it's fine.", note)
        self.assertIn("The whole turn: the doc 'GPT-wakes'", note)
        doc = self.r.call("GET", "/shared?name=GPT-wakes", "umbyz", remote=False)[1]["content"]
        self.assertIn(f"#{sent['id']} from umbyz · in its crew session", doc)
        self.assertIn("> is the gate ok?", doc)
        self.assertIn("**GPT:** Checked the gate, it's fine.", doc)
        self.assertIn("- `crew_task`: needs approval", doc)
        self.assertIn("- `update_running_summary` (codex_apps): failed — summary store unavailable", doc)  # why, in its words
        self.assertIn("update_running_summary (failed: summary store unavailable)", note)
        self.assertIn("- changed gate.lua", doc)
        self.assertRegex(doc, r"## \d{4}-\d\d-\d\d \d\d:\d\d:\d\d–\d\d:\d\d:\d\d UTC · #\d+ from umbyz · in its crew session · ran")

    def test_a_woken_turn_goes_into_its_persons_own_chat_once_its_quiet(self):
        codex = tempfile.mkdtemp(prefix="crew-mcp-codex-")
        self.addCleanup(shutil.rmtree, codex, True)
        rollout = codex_home_with_a_chat(codex, quiet=False)  # its person was just in that chat
        self.waker(CREW_CODEX_HOME=codex, FAKE_ROLLOUT=rollout, CREW_MCP_QUIET="30")  # the optional wait
        until(self.online)
        sent = self.ask("the boat panel, please")
        time.sleep(1.5)
        self.assertEqual(self.wakes(), [])  # waits: its person may be typing there
        os.utime(rollout, (time.time() - 600, time.time() - 600))
        until(lambda: len(self.wakes()) == 1)
        args = self.wakes()[0]["args"]
        self.assertEqual(args[:3], ["queue", "--thread", "chat-7"])  # queued in the app's own chat…
        self.assertIn(f"Crew request #{sent['id']} from umbyz", args[args.index("--message") + 1])
        until(lambda: self.links() == ["codex://threads/wake/chat-7"])  # …and the app told to run it there
        until(self.moon)
        note = self.moon()
        self.assertIn("woke in its person's Codex chat", note)
        self.assertIn("used crew_status", note)
        self.assertIn("Last said: Done, I replied to umbyz.", note)
        doc = self.r.call("GET", "/shared?name=GPT-wakes", "umbyz", remote=False)[1]["content"]
        self.assertIn("**GPT:** On it, from your chat.", doc)

    def test_after_its_own_woken_turn_the_next_request_needs_no_quiet_wait(self):
        codex = tempfile.mkdtemp(prefix="crew-mcp-codex-")
        self.addCleanup(shutil.rmtree, codex, True)
        rollout = codex_home_with_a_chat(codex)
        self.waker(CREW_CODEX_HOME=codex, FAKE_ROLLOUT=rollout, CREW_MCP_OWN_TAIL="1", CREW_MCP_QUIET="30")
        until(self.online)
        self.ask("ping 1")
        until(lambda: len(self.wakes()) == 1)
        until(self.moon)  # its turn is done, and it just wrote into that chat
        start = time.time()
        self.ask("ping 2")
        until(lambda: len(self.wakes()) == 2, timeout=8)  # no 30 s wait: that change was its own turn
        self.assertLess(time.time() - start, 8)
        until(lambda: len([m for m in self.said("update") if m["text"].startswith("🌙")]) == 2)
        time.sleep(1.5)  # past what Codex still writes after its own turn
        os.utime(rollout, None)  # now its person types in that chat
        self.ask("ping 3")
        time.sleep(2)
        self.assertEqual(len(self.wakes()), 2)  # that one does wait

    def test_prompts_crew_makes_this_chat_the_crew_chat_until_left_or_archived(self):
        import sqlite3
        codex = tempfile.mkdtemp(prefix="crew-mcp-codex-")
        self.addCleanup(shutil.rmtree, codex, True)
        codex_home_with_a_chat(codex)  # chat-7: used the crew a while ago
        fresh = os.path.join(codex, "rollout-new.jsonl")
        with open(fresh, "w", encoding="utf-8") as f:
            f.write("{}\n")  # chat-9: the chat its person is in right now
        con = sqlite3.connect(os.path.join(codex, "state_5.sqlite"))
        con.execute("insert into threads values ('chat-9', ?, 3, 'vscode', 'Codex Desktop', 0)", (fresh,))
        con.commit()
        con.close()
        b = self.waker(CREW_CODEX_HOME=codex, CREW_MCP_APP_START="1")
        until(self.online)
        self.assertTrue(os.path.exists(os.path.join(codex, "prompts", "crew.md")))  # /prompts:crew in Codex's menu
        self.assertIn("this is your crew chat now", b.tool("crew_join"))
        os.utime(fresh, (time.time() - 600, time.time() - 600))
        self.ask("one")
        until(lambda: len(self.wakes()) == 1)
        self.assertEqual(self.wakes()[0]["args"][2], "chat-9")  # the crew chat, not the latest one that used crew
        self.assertIn("isn't your crew chat any more", b.tool("crew_join", leave=True))
        self.ask("two")
        until(lambda: len(self.wakes()) == 2, timeout=12)
        self.assertEqual(self.wakes()[1]["args"][2], "chat-7")
        os.utime(fresh, None)  # its person is in chat-9 again
        self.assertIn("this is your crew chat now", b.tool("crew_join"))  # …until it's archived
        os.utime(fresh, (time.time() - 600, time.time() - 600))
        con = sqlite3.connect(os.path.join(codex, "state_5.sqlite"))
        con.execute("update threads set archived = 1 where id = 'chat-9'")
        con.commit()
        con.close()
        self.ask("three")
        until(lambda: len(self.wakes()) == 3, timeout=12)
        self.assertEqual(self.wakes()[2]["args"][2], "chat-7")

    def test_by_default_it_goes_in_at_once_since_codex_holds_it_behind_a_running_turn(self):
        codex = tempfile.mkdtemp(prefix="crew-mcp-codex-")
        self.addCleanup(shutil.rmtree, codex, True)
        rollout = codex_home_with_a_chat(codex, quiet=False)  # its person was just in that chat
        self.waker(CREW_CODEX_HOME=codex, FAKE_ROLLOUT=rollout)
        until(self.online)
        self.ask("right away, please")
        until(lambda: len(self.wakes()) == 1, timeout=6)
        self.assertEqual(self.wakes()[0]["args"][:3], ["queue", "--thread", "chat-7"])

    def test_a_request_from_another_project_never_wakes_it(self):
        self.waker(mode="leader, umbyz")
        until(self.online)
        self.r.call("POST", "/send", "umbyz", project="side", body={"to": "GPT", "kind": "request", "text": "from side"},
                    remote=False)
        time.sleep(1.5)
        self.assertEqual(self.wakes(), [])  # it waits for its person, like a Claude's Auto-run
        self.ask("from main")
        until(lambda: len(self.wakes()) == 1)
        self.assertIn("from main", self.wakes()[0]["prompt"])

    def test_a_request_that_came_in_during_a_long_wake_still_wakes_it_afterwards(self):
        self.waker(CREW_MCP_FRESH="2", FAKE_SLEEP="3")  # "fresh" is 2 s here, and each woken turn takes 3 s
        until(self.online)
        self.ask("first: the gate")
        until(lambda: len(self.wakes()) == 1)
        self.ask("second: the door")  # comes in while the first turn runs
        until(lambda: len(self.wakes()) == 2, timeout=15)  # 3+ s old by then, but it came in fresh
        self.assertIn("second: the door", self.wakes()[1]["prompt"])

    def test_whoever_asked_hears_at_once_and_it_shows_as_working_meanwhile(self):
        self.waker(FAKE_SLEEP="3")
        until(self.online)
        sent = self.ask("is the gate ok?")
        got = self.r.call("GET", f"/wait?since={sent['id']}&from=GPT&timeout=6", "umbyz", remote=False)[1]  # crew_wait
        self.assertEqual(got["messages"][0]["kind"], "chat")
        self.assertIn(f"🌙 Got #{sent['id']}: on it now", got["messages"][0]["text"])
        until(lambda: self.gpt().get("activity") == "working")  # for the whole woken turn
        until(self.moon, timeout=10)
        until(lambda: self.gpt().get("activity") == "idle", timeout=6)

    def test_without_codexs_command_line_whoever_asked_hears_it_didnt_start(self):
        folder = tempfile.mkdtemp(prefix="crew-mcp-wake-")
        self.addCleanup(shutil.rmtree, folder, True)
        b = self.bridge(CREW_WAKE="project", CREW_CODEX=os.path.join(folder, "no-such-codex.exe"), CREW_WAKE_DIR=folder)
        until(self.online)
        sent = self.ask("is the gate ok?")
        until(lambda: any(f"#{sent['id']} didn't start after all" in m["text"] for m in self.said("chat")))
        self.assertIn("Waiting on you (1)", b.tool("crew_status"))  # still there for its person: 🌙 notes aren't replies

    def test_a_task_request_waits_until_the_task_is_taken_not_for_just_any_reply(self):
        b = self.bridge()
        until(self.online)
        t = self.r.call("POST", "/tasks", "umbyz", body={"action": "add", "title": "the door"}, remote=False)[1]
        self.ask(f"T{t['id']} can start: the door")
        self.ask("and how's the gate?")
        until(lambda: "Waiting on you (2)" in b.tool("crew_status"))
        b.tool("crew_send", text="the gate's fine", to="umbyz")
        status = b.tool("crew_status")
        self.assertIn("Waiting on you (1)", status)  # the reply answered the question, not the task
        self.assertIn("can start: the door", status)
        b.tool("crew_task", action="claim", id=str(t["id"]))
        self.assertNotIn("Waiting on you", b.tool("crew_status"))

    def test_an_invite_from_someone_who_may_wake_it_moves_it_there_and_what_waits_there_wakes_it(self):
        self.waker(mode="leader, umbyz")
        until(self.online)
        self.r.call("POST", "/send", "umbyz", project="side", body={"to": "GPT", "kind": "request", "text": "T9 for you"},
                    remote=False)
        time.sleep(1)
        self.assertEqual(self.wakes(), [])  # from another project: not yet
        self.r.call("POST", "/send", "umbyz", project="side", body={"to": "GPT", "kind": "invite", "text": "come over"},
                    remote=False)
        until(lambda: self.gpt().get("project") == "side")
        until(lambda: len(self.wakes()) == 1)  # now it's in that project: the request there wakes it
        self.assertIn("T9 for you", self.wakes()[0]["prompt"])
        said = self.r.call("GET", "/poll?since=0", "umbyz", project="side", remote=False)[1]["messages"]
        self.assertTrue(any(m["from"] == "GPT" and "followed umbyz's invite" in m["text"] for m in said))

    def test_an_invite_to_everyone_moves_it_only_out_of_main(self):
        self.waker(mode="umbyz")
        until(self.online)
        for p in ("side", "other"):  # open to the whole crew, so everyone can be invited at once
            self.r.call("POST", "/project/private", "umbyz", project=p, body={"private": False}, remote=False)
        self.r.call("POST", "/send", "umbyz", project="side", body={"to": "all", "kind": "invite", "text": "all of you"},
                    remote=False)
        until(lambda: self.gpt().get("project") == "side")  # from main, the lobby: it follows
        self.r.call("POST", "/send", "umbyz", project="other", body={"to": "all", "kind": "invite", "text": "you too"},
                    remote=False)
        time.sleep(1.5)
        self.assertEqual(self.gpt().get("project"), "side")  # in a project: an invite to everyone doesn't pull it away

    def test_an_invite_from_someone_else_waits_for_its_person(self):
        self.waker(mode="leader")
        until(self.online)
        self.r.call("POST", "/send", "bob", project="side", body={"to": "GPT", "kind": "invite", "text": "come over"})
        time.sleep(1.5)
        self.assertEqual(self.gpt().get("project"), "main")

    def test_it_can_switch_projects_again_and_again(self):
        b = self.bridge()
        until(self.online)
        self.assertIn("Now in the crew project 'side'", b.tool("crew_project", name="side"))
        self.assertIn("Now in the crew project 'other'", b.tool("crew_project", name="other"))
        self.assertIn("in the project 'other'", b.tool("crew_status"))
        self.assertIn("Now in the crew project 'main'", b.tool("crew_project", name="main"))

    def test_a_doc_in_another_project_says_where_to_look(self):
        b = self.bridge()
        until(self.online)
        self.r.call("POST", "/shared", "umbyz", project="side", body={"name": "plan", "content": "the plan"}, remote=False)
        self.r.call("POST", "/send", "umbyz", project="side", body={"to": "GPT", "kind": "invite", "text": "come over"},
                    remote=False)
        until(lambda: "umbyz invited you to 'side'" in b.tool("crew_read_shared", name="plan"))
        self.assertIn("No doc 'plan' in the project 'main'", b.tool("crew_read_shared", name="plan"))

    def test_it_hears_when_a_teammate_it_asks_is_in_another_project(self):
        b = self.bridge()
        until(self.online)
        self.r.call("GET", "/poll?since=0", "bob", project="side")  # a new project: members-only, bob's
        until(lambda: "bob (idle, in another project)" in b.tool("crew_status"))
        self.assertIn("bob is in another crew project right now", b.tool("crew_send", text="look?", to="bob", kind="request"))
        self.assertNotIn("Heads-up", b.tool("crew_send", text="hi all"))

    def test_it_warns_while_a_teammate_is_playtesting(self):
        b = self.bridge()
        until(self.online)
        self.r.call("GET", "/poll?since=0", "umbyz", remote=False, extra={"X-Crew-Play": "Roblox Studio"})
        until(lambda: "▶ Playtesting right now: umbyz (Roblox Studio)" in b.tool("crew_status"))
        self.assertIn("umbyz (idle, ▶ playtesting in Roblox Studio)", b.tool("crew_status"))  # by their name, too
        self.assertIn("Playtesting right now", b.tool("crew_read_shared"))  # every crew tool's answer says so
        self.r.call("GET", "/poll?since=0", "umbyz", remote=False)  # Play stopped
        until(lambda: "Playtesting" not in b.tool("crew_status"))

    def codex(self, chats):
        folder = tempfile.mkdtemp(prefix="crew-mcp-codex-")
        self.addCleanup(shutil.rmtree, folder, True)
        codex_home_with_chats(folder, chats)
        return folder

    def test_crew_join_goes_by_codexs_own_note_of_the_active_chat_not_the_files_time(self):
        now = time.time()
        codex = self.codex([dict(id="chat-7", folder="possible-project", noted=now - 60, file=now - 60),
                            dict(id="chat-9", folder="Brace!", noted=now, file=now - 900)])  # Codex keeps it open: an old time
        b = self.waker(CREW_CODEX_HOME=codex, CREW_MCP_APP_START="1")
        until(self.online)
        self.assertIn("this is your crew chat now, for the crew project 'main'", b.tool("crew_join"))
        self.ask("one")
        until(lambda: len(self.wakes()) == 1)
        self.assertEqual(self.wakes()[0]["args"][2], "chat-9")

    def test_crew_join_picks_the_chat_its_person_just_typed_in_while_a_wake_runs_in_another(self):
        now = time.time()
        codex = self.codex([dict(id="chat-7", folder="a", noted=now, file=now),  # a woken turn is writing there
                            dict(id="chat-9", folder="b", noted=now - 5, file=now - 900, typed=now - 5)])
        b = self.waker(CREW_CODEX_HOME=codex, CREW_MCP_APP_START="1")
        until(self.online)
        b.tool("crew_join")
        self.ask("one")
        until(lambda: len(self.wakes()) == 1)
        self.assertEqual(self.wakes()[0]["args"][2], "chat-9")

    def test_a_crew_chat_is_for_its_project_and_a_wake_from_another_finds_that_projects_chat(self):
        now = time.time()
        codex = self.codex([dict(id="chat-7", folder="possible-project", noted=now, file=now, said="main"),
                            dict(id="chat-9", folder="Side!", noted=now - 300, file=now - 300, used=False)])  # side's own folder
        b = self.waker(CREW_CODEX_HOME=codex, CREW_MCP_APP_START="1")
        until(self.online)
        b.tool("crew_join")  # chat-7: the crew chat for main
        b.tool("crew_project", name="side")
        self.r.call("POST", "/send", "umbyz", project="side", body={"to": "GPT", "kind": "request", "text": "from side"},
                    remote=False)
        until(lambda: len(self.wakes()) == 1)
        self.assertEqual(self.wakes()[0]["args"][2], "chat-9")  # the chat in side's folder, not main's crew chat
        b.tool("crew_project", name="main")
        self.ask("from main")
        until(lambda: len(self.wakes()) == 2, timeout=12)
        self.assertEqual(self.wakes()[1]["args"][2], "chat-7")  # main's crew chat is still main's

    def test_with_no_chat_for_its_project_it_wakes_in_its_crew_session_and_says_how_to_pick_one(self):
        now = time.time()
        codex = self.codex([dict(id="chat-7", folder="possible-project", noted=now, file=now, said="main")])
        b = self.waker(CREW_CODEX_HOME=codex)
        until(self.online)
        b.tool("crew_project", name="side")
        self.r.call("POST", "/send", "umbyz", project="side", body={"to": "GPT", "kind": "request", "text": "from side"},
                    remote=False)
        until(lambda: len(self.wakes()) == 1)
        self.assertIn("exec", self.wakes()[0]["args"])  # never main's chat: its folder and talk are main's

        def note():  # the 🌙 line, in side's chat
            got = self.r.call("GET", "/poll?since=0", "umbyz", project="side", remote=False)[1]["messages"]
            return next((m["text"] for m in got if m["from"] == "GPT" and m["text"].startswith("🌙 woke")), "")

        until(note)
        self.assertIn("no Codex chat of its person's works on 'side' yet: /prompts:crew side in one", note())

    def test_a_crew_chat_from_before_chats_were_per_project_stays_the_one_for_where_it_is(self):
        now = time.time()
        codex = self.codex([dict(id="chat-7", folder="a", noted=now, file=now),
                            dict(id="chat-9", folder="b", noted=now - 300, file=now - 300)])
        home = tempfile.mkdtemp(prefix="crew-mcp-test-")
        os.makedirs(home, exist_ok=True)
        with open(os.path.join(home, "wake.json"), "w", encoding="utf-8") as f:
            json.dump({f"http://127.0.0.1:{self.r.port}|GPT": {"pin": {"id": "chat-9", "path": "old"}}}, f)
        self.waker(home=home, CREW_CODEX_HOME=codex, CREW_MCP_APP_START="1")
        until(self.online)
        self.ask("one")
        until(lambda: len(self.wakes()) == 1)
        self.assertEqual(self.wakes()[0]["args"][2], "chat-9")

    def test_a_woken_turn_its_person_stops_ends_the_wake_at_once(self):
        codex = tempfile.mkdtemp(prefix="crew-mcp-codex-")
        self.addCleanup(shutil.rmtree, codex, True)
        rollout = codex_home_with_a_chat(codex)
        self.waker(CREW_CODEX_HOME=codex, FAKE_ROLLOUT=rollout, FAKE_ABORT="1")
        until(self.online)
        self.ask("T2, please")
        until(self.moon, timeout=8)  # at once, not after the 30 minutes a turn may take
        self.assertIn("its person stopped it partway: T2 is still claimed by it", self.moon())
        doc = self.r.call("GET", "/shared?name=GPT-wakes", "umbyz", remote=False)[1]["content"]
        self.assertIn("· in its person's Codex chat · stopped by its person", doc)
        self.ask("the next one")
        until(lambda: len(self.wakes()) == 2)  # the wake is over: the next request wakes it again

    def test_a_woken_turn_is_followed_when_codex_goes_on_in_a_new_file(self):
        codex = tempfile.mkdtemp(prefix="crew-mcp-codex-")
        self.addCleanup(shutil.rmtree, codex, True)
        rollout = codex_home_with_a_chat(codex)
        self.waker(CREW_CODEX_HOME=codex, FAKE_ROLLOUT=rollout, FAKE_ROTATE=os.path.join(codex, "rollout-chat-2.jsonl"),
                   FAKE_DB=os.path.join(codex, "state_5.sqlite"))
        until(self.online)
        self.ask("the boat panel")
        until(self.moon, timeout=8)
        self.assertIn("used crew_status", self.moon())
        self.assertIn("Last said: Done, I replied to umbyz.", self.moon())

    def test_switching_projects_moves_every_copy_of_the_bridge(self):
        home = tempfile.mkdtemp(prefix="crew-mcp-test-")
        main = self.bridge(home=home)
        until(self.online)
        turn = self.bridge(home=home)  # the copy a Codex turn uses
        self.assertIn("Now in the crew project 'side'", turn.tool("crew_project", name="side"))
        until(lambda: "in the project 'side'" in main.tool("crew_status"))  # the other copy (the waker) follows
        self.assertIn("in the project 'side'", self.bridge(home=home).tool("crew_status"))  # and so does a new one

    def test_crew_join_with_a_project_moves_there_too(self):
        b = self.bridge()
        until(self.online)
        out = b.tool("crew_join", project="side")
        self.assertIn("Now in the crew project 'side'", out)
        self.assertIn("in the project 'side'", out)  # the crew_status after it

    def test_an_older_prompts_crew_file_is_brought_up_to_date(self):
        codex = tempfile.mkdtemp(prefix="crew-mcp-codex-")
        self.addCleanup(shutil.rmtree, codex, True)
        os.makedirs(os.path.join(codex, "prompts"))
        old = ("---\ndescription: Make this chat your crew chat (crew requests that wake you land here)\n---\n"
               "Join the crew in this chat: call crew_join, then tell me in two or three lines who's online, what's on "
               "the board and what's waiting on you.\n")
        with open(os.path.join(codex, "prompts", "crew.md"), "w", encoding="utf-8") as f:
            f.write(old)
        self.bridge(CREW_CODEX_HOME=codex)

        def prompt():
            with open(os.path.join(codex, "prompts", "crew.md"), encoding="utf-8") as f:
                return f.read()

        until(lambda: "argument-hint" in prompt())

    def test_if_it_cant_be_queued_it_uses_its_crew_session(self):
        codex = tempfile.mkdtemp(prefix="crew-mcp-codex-")
        self.addCleanup(shutil.rmtree, codex, True)
        codex_home_with_a_chat(codex)
        self.waker(CREW_CODEX_HOME=codex, FAKE_QUEUE_FAIL="1")
        until(self.online)
        self.ask("anything")
        until(lambda: len(self.wakes()) == 2)
        self.assertEqual(self.wakes()[0]["args"][0], "queue")
        self.assertEqual(self.wakes()[1]["args"][0], "exec")  # once, in its crew session instead
        until(self.moon)
        self.assertIn("woke in its crew session", self.moon())

    def test_queued_but_not_run_yet_says_so_and_isnt_run_twice(self):
        codex = tempfile.mkdtemp(prefix="crew-mcp-codex-")
        self.addCleanup(shutil.rmtree, codex, True)
        codex_home_with_a_chat(codex)
        self.waker(CREW_CODEX_HOME=codex, CREW_MCP_APP_START="2")  # no Codex app here to pick it up
        until(self.online)
        self.ask("anything")
        until(self.moon, timeout=12)
        self.assertIn("Codex hasn't run it yet: it's queued in that chat", self.moon())
        self.assertEqual([w["args"][0] for w in self.wakes()], ["queue"])  # not also run somewhere else

    def test_a_chat_that_never_used_the_crew_isnt_woken_into(self):
        codex = tempfile.mkdtemp(prefix="crew-mcp-codex-")
        self.addCleanup(shutil.rmtree, codex, True)
        codex_home_with_a_chat(codex, crew=False)
        self.waker(CREW_CODEX_HOME=codex)
        until(self.online)
        self.ask("anything")
        until(lambda: len(self.wakes()) == 1)
        self.assertNotIn("chat-7", self.wakes()[0]["args"])  # its own crew session instead

    def test_wake_into_session_keeps_it_out_of_the_persons_chat(self):
        codex = tempfile.mkdtemp(prefix="crew-mcp-codex-")
        self.addCleanup(shutil.rmtree, codex, True)
        codex_home_with_a_chat(codex)
        self.waker(CREW_CODEX_HOME=codex, CREW_WAKE_INTO="session")
        until(self.online)
        self.ask("anything")
        until(lambda: len(self.wakes()) == 1)
        self.assertNotIn("chat-7", self.wakes()[0]["args"])

    def test_without_settings_it_says_how_to_set_it_up(self):
        b = Bridge(None, name="")
        self.bridges.append(b)
        self.assertIn("CREW_RELAY", b.tool("crew_status"))

    # -- what the crew sees of it: who may wake it, and how much of Codex's usage limits is used

    def test_the_crew_hears_who_may_wake_it(self):
        folder = tempfile.mkdtemp(prefix="crew-mcp-wake-")
        self.addCleanup(shutil.rmtree, folder, True)
        self.waker(mode="leader, Umbyz")
        self.bridge(name="Off")  # off unless its person turns it on
        self.bridge(name="Lost", CREW_WAKE="project", CREW_CODEX=os.path.join(folder, "no-such-codex.exe"))
        wake = lambda: {p["name"]: p.get("wake") for p in self.poll()["peers"] if p["name"] in ("GPT", "Off", "Lost")}
        until(lambda: len(wake()) == 3)
        self.assertEqual(wake(), {"GPT": "leader, Umbyz", "Off": "off",
                                  "Lost": "off: Codex's command line isn't found"})

    def test_codexs_usage_shows_in_the_crew_like_a_claudes(self):
        codex = tempfile.mkdtemp(prefix="crew-mcp-codex-")
        self.addCleanup(shutil.rmtree, codex, True)
        codex_home_with_usage(codex, token_count((61, 300, 3600), (19, 10080, 86400), ago=600),
                              token_count((35, 300, 3000), (20, 10080, 86000)))  # the newest one counts
        self.bridge(CREW_CODEX_HOME=codex)
        until(lambda: self.gpt().get("usage") is not None)
        self.assertEqual((self.gpt()["usage"], self.gpt()["usageDetail"]), (35, "35% session · 20% week"))

    def test_a_usage_window_past_its_reset_time_counts_0(self):
        codex = tempfile.mkdtemp(prefix="crew-mcp-codex-")
        self.addCleanup(shutil.rmtree, codex, True)
        codex_home_with_usage(codex, token_count((90, 300, -60), (20, 10080, 86400)))  # its session reset a minute ago
        self.bridge(CREW_CODEX_HOME=codex)
        until(lambda: self.gpt().get("usage") is not None)
        self.assertEqual((self.gpt()["usage"], self.gpt()["usageDetail"]), (20, "0% session · 20% week"))

    def test_a_free_plans_month_window_from_codexs_list_of_chats(self):
        codex = tempfile.mkdtemp(prefix="crew-mcp-codex-")
        self.addCleanup(shutil.rmtree, codex, True)
        rollout = codex_home_with_a_chat(codex)  # a chat in Codex's list only, not in a day folder
        with open(rollout, "a", encoding="utf-8") as f:
            f.write(json.dumps(token_count((12, 43200, 20 * 86400), plan="free")) + "\n")  # one window, a month long
        self.bridge(CREW_CODEX_HOME=codex)
        until(lambda: self.gpt().get("usage") is not None)
        self.assertEqual((self.gpt()["usage"], self.gpt()["usageDetail"]), (12, "12% month"))

    def test_no_usage_without_codexs_files_or_for_another_app(self):
        codex = tempfile.mkdtemp(prefix="crew-mcp-codex-")
        self.addCleanup(shutil.rmtree, codex, True)
        codex_home_with_usage(codex, token_count((35, 300, 3000)))
        self.bridge()  # its Codex home has nothing in it
        self.bridge(name="Gem", CREW_CLIENT="gemini", CREW_CODEX_HOME=codex)  # Codex's limits aren't another app's
        usage = lambda: {p["name"]: (p.get("usage"), p.get("usageDetail")) for p in self.poll()["peers"]
                         if p["name"] in ("GPT", "Gem") and p.get("online")}
        until(lambda: len(usage()) == 2)
        time.sleep(1)  # a few check-ins later
        self.assertEqual(usage(), {"GPT": (None, None), "Gem": (None, None)})


if __name__ == "__main__":
    unittest.main()
