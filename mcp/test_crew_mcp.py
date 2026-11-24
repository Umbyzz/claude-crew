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
                "CREW_RELAY": f"http://127.0.0.1:{relay.port}" if relay else ""}
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
            self.proc.stdin.close()  # the app closing this session
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

    def online(self, name="GPT"):
        return any(p["name"] == name and p["online"] for p in self.poll().get("peers", []))

    def test_an_mcp_app_sees_the_crew_tools_and_how_crew_works(self):
        b = self.bridge()
        init = b.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                        "clientInfo": {"name": "test", "version": "0"}})["result"]
        self.assertEqual((init["serverInfo"]["name"], init["protocolVersion"]), ("crew", "2025-06-18"))
        self.assertIn("crew_status", init["instructions"])
        self.assertIn("Your name in the crew is GPT", init["instructions"])
        names = {t["name"] for t in b.request("tools/list")["result"]["tools"]}
        self.assertEqual(names, {"crew_status", "crew_send", "crew_task", "crew_wait", "crew_read_shared", "crew_share",
                                 "crew_project"})
        self.assertEqual(b.request("ping")["result"], {})
        self.assertIn("error", b.request("nope/nothing"))

    def test_it_joins_as_another_ai_and_chats_both_ways(self):
        b = self.bridge()
        until(self.online)
        row = next(p for p in self.poll()["peers"] if p["name"] == "GPT")
        self.assertEqual(row["client"], "codex")
        self.assertIn("Sent #", b.tool("crew_send", text="hi from GPT", to="umbyz"))
        self.assertTrue(any(m["text"] == "hi from GPT" and m["from"] == "GPT" for m in self.poll()["messages"]))
        sent = self.r.call("POST", "/send", "umbyz", body={"to": "GPT", "kind": "request", "text": "review the gate"})[1]
        until(lambda: "1 new crew message waiting" in b.tool("crew_read_shared"))  # every crew tool says so
        self.assertLess(self.poll()["reads"].get("GPT", 0), sent["id"])  # its AI hasn't seen it yet: not read
        status = b.tool("crew_status")
        self.assertIn("New for you (1)", status)
        self.assertIn("umbyz → GPT (request): review the gate", status)
        self.assertEqual(self.poll()["reads"]["GPT"], sent["id"])  # now it has
        self.assertNotIn("New for you", b.tool("crew_status"))  # shown once

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
        threading.Timer(0.8, lambda: self.r.call("POST", "/send", "umbyz", body={"to": "GPT", "text": "yes, go"})).start()
        start = time.time()
        self.assertIn("yes, go", b.tool("crew_wait", timeout_s=20))
        self.assertLess(time.time() - start, 10)
        self.assertIn("No message", b.tool("crew_wait", timeout_s=1))

    def test_it_knocks_gets_let_in_and_keeps_its_key(self):
        self.r.call("POST", "/friends/mode", "umbyz", body={"door": "friends"}, remote=False)
        home = tempfile.mkdtemp(prefix="crew-mcp-test-")
        b = self.bridge(home=home)
        knocks = lambda: self.r.call("POST", "/friends/list", "umbyz", body={}, remote=False)[1].get("knocks", [])
        until(lambda: "GPT" in [k["name"] for k in knocks()])  # on the host's own PC, and still not the host
        self.assertIn("Knocking", b.tool("crew_status"))
        self.r.call("POST", "/friends/letin", "umbyz", body={"name": "GPT"}, remote=False)
        until(self.online)
        until(lambda: os.path.exists(os.path.join(home, "keys.json")))
        b.close(keep_home=True)
        again = self.bridge(home=home, CREW_KEY="no-longer-needed")  # its own key from now on
        until(self.online)
        self.assertNotIn("Knocking", again.tool("crew_status"))

    def test_messages_from_while_the_app_was_closed_are_new_next_time(self):
        home = tempfile.mkdtemp(prefix="crew-mcp-test-")
        b = self.bridge(home=home)
        until(self.online)
        self.r.call("POST", "/send", "umbyz", body={"to": "GPT", "text": "first"})
        until(lambda: "first" in b.tool("crew_status"))
        b.close(keep_home=True)
        until(lambda: not self.online())
        self.r.call("POST", "/send", "umbyz", body={"to": "GPT", "kind": "request", "text": "while you were away"})
        again = self.bridge(home=home)
        until(self.online)
        status = again.tool("crew_status")
        self.assertIn("New for you (1)", status)
        self.assertIn("while you were away", status)

    def test_it_says_goodbye_when_the_app_closes(self):
        b = self.bridge()
        until(self.online)
        b.close()
        self.assertFalse(self.online())  # at once, not a minute later
        self.assertTrue(any(m["kind"] == "leave" and m["from"] == "GPT" for m in self.poll()["messages"]))

    def test_without_settings_it_says_how_to_set_it_up(self):
        b = Bridge(None, name="")
        self.bridges.append(b)
        self.assertIn("CREW_RELAY", b.tool("crew_status"))


if __name__ == "__main__":
    unittest.main()
