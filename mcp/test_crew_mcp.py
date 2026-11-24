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
import json, os, sys
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
                {"type": "item_completed", "turn_id": "t-q", "item": {"type": "AgentMessage", "content": [{"type": "Text", "text": "On it, from your chat."}]}},
                {"type": "task_complete", "turn_id": "t-q", "last_agent_message": "Done, I replied to umbyz."}]
        with open(rollout, "a", encoding="utf-8") as f:
            for p in turn:
                f.write(json.dumps({"type": "event_msg", "payload": p}) + "\n")
    print("Queued message q-1 for thread " + args[args.index("--thread") + 1] + ".")
    sys.exit(0)
thread = args[args.index("resume") + 1] if "resume" in args else "thread-1"
for e in ({"type": "thread.started", "thread_id": thread}, {"type": "turn.started"},
          {"type": "item.completed", "item": {"type": "mcp_tool_call", "server": "crew", "tool": "crew_status", "status": "completed"}},
          {"type": "item.completed", "item": {"type": "mcp_tool_call", "server": "crew", "tool": "crew_task", "status": "failed",
                                              "error": {"message": "MCP tool call requires approval, but approval policy is never"}}},
          {"type": "item.completed", "item": {"type": "file_change", "changes": [{"path": "C:/work/gate.lua", "kind": "update"}]}},
          {"type": "item.completed", "item": {"type": "agent_message", "text": "Checked the gate, it's fine."}},
          {"type": "turn.completed"}):
    print(json.dumps(e), flush=True)
"""


def codex_home_with_a_chat(folder, crew=True, quiet=True):
    """A stand-in for Codex's own list of chats: one chat of its person's in the app (that used the crew tools)."""
    import sqlite3
    rollout = os.path.join(folder, "rollout-chat.jsonl")
    with open(rollout, "w", encoding="utf-8") as f:
        f.write(json.dumps({"payload": {"source": "vscode"}}) + "\n" + ('{"name": "crew_status"}\n' if crew else "hi\n"))
    if quiet:
        os.utime(rollout, (time.time() - 600, time.time() - 600))
    con = sqlite3.connect(os.path.join(folder, "state_5.sqlite"))
    con.execute("create table threads (id text, rollout_path text, updated_at integer, source text, originator text, archived integer)")
    con.execute("insert into threads values ('chat-7', ?, 1, 'vscode', 'Codex Desktop', 0)", (rollout,))
    con.execute("insert into threads values ('exec-1', 'none', 2, 'exec', 'codex_exec', 0)")
    con.commit()
    con.close()
    return rollout


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
                                 "crew_read_shared", "crew_share", "crew_project"})
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
        self.assertIn("- changed gate.lua", doc)

    def test_a_woken_turn_goes_into_its_persons_own_chat_once_its_quiet(self):
        codex = tempfile.mkdtemp(prefix="crew-mcp-codex-")
        self.addCleanup(shutil.rmtree, codex, True)
        rollout = codex_home_with_a_chat(codex, quiet=False)  # its person was just in that chat
        self.waker(CREW_CODEX_HOME=codex, FAKE_ROLLOUT=rollout)
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


if __name__ == "__main__":
    unittest.main()
