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
                "CREW_MCP_GRACE": "0", "CREW_MCP_BUSY": "1", "CREW_RELAY": f"http://127.0.0.1:{relay.port}" if relay else ""}
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

    def ask(self, text, kind="request"):
        return self.r.call("POST", "/send", "umbyz", body={"to": "GPT", "kind": kind, "text": text}, remote=False)[1]

    def test_an_mcp_app_sees_the_crew_tools_and_how_crew_works(self):
        b = self.bridge()
        init = b.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                        "clientInfo": {"name": "test", "version": "0"}})["result"]
        self.assertEqual((init["serverInfo"]["name"], init["protocolVersion"]), ("crew", "2025-06-18"))
        self.assertIn("Your name in the crew is GPT", init["instructions"])
        self.assertIn("Waiting on you", init["instructions"])
        names = {t["name"] for t in b.request("tools/list")["result"]["tools"]}
        self.assertEqual(names, {"crew_status", "crew_send", "crew_task", "crew_wait", "crew_read_shared", "crew_share",
                                 "crew_project"})
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

    def test_without_settings_it_says_how_to_set_it_up(self):
        b = Bridge(None, name="")
        self.bridges.append(b)
        self.assertIn("CREW_RELAY", b.tool("crew_status"))


if __name__ == "__main__":
    unittest.main()
