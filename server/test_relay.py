"""The relay's own tests: run `python server/test_relay.py` (the release script runs them too).

Each test starts a real relay on a free port with its own data folder. Requests marked remote=True play a
teammate on another PC; the rest come from "the host's PC".
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

RELAY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "relay.py")
KEY = "crew-test-key"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Relay:
    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix="crew-relay-test-")
        self.port = free_port()
        self.proc = subprocess.Popen([sys.executable, RELAY, "--host", "127.0.0.1", "--port", str(self.port), "--key", KEY,
                                      "--data", os.path.join(self.dir, "state.json"), "--test-remote"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{self.port}/health", timeout=0.5)
                return
            except OSError:
                time.sleep(0.1)
        raise RuntimeError("relay didn't start")

    def call(self, method, path, name="", key=KEY, project="", body=None, remote=True):
        headers = {"X-Crew-Key": key, "X-Crew-Name": name, "Content-Type": "application/json"}
        if project:
            headers["X-Crew-Project"] = project
        if remote:
            headers["X-Crew-Test-Remote"] = "1"
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method, headers=headers,
                                     data=None if body is None else json.dumps(body).encode())
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def close(self):
        self.proc.kill()
        self.proc.wait()
        shutil.rmtree(self.dir, ignore_errors=True)


class RelayTest(unittest.TestCase):
    def setUp(self):
        self.r = Relay()

    def tearDown(self):
        self.r.close()

    def poll(self, name, project="", key=KEY):
        return self.r.call("GET", "/poll?since=0", name, key=key, project=project)

    def test_shared_key_and_a_wrong_key(self):
        self.assertEqual(self.poll("cori")[0], 200)
        self.assertEqual(self.poll("cori", key="nope")[0], 401)

    def test_a_friend_key_is_bound_to_its_name(self):
        code, r = self.r.call("POST", "/friends/add", "host", body={"name": "cori"}, remote=False)
        self.assertEqual(code, 200)
        cori_key = next(f["key"] for f in r["friends"] if f["name"] == "cori")
        self.assertEqual(self.poll("cori", key=cori_key)[0], 200)
        self.assertEqual(self.poll("pluh", key=cori_key)[0], 401)  # someone else can't use cori's key
        self.assertEqual(self.poll("cori")[0], 401)  # nor can anyone be "cori" with the shared key
        self.assertEqual(self.r.call("POST", "/friends/add", "cori", key=cori_key, body={"name": "x"})[0], 403)  # host only

    def test_friends_only_turns_the_shared_key_off(self):
        self.r.call("POST", "/friends/mode", "host", body={"friendsOnly": True}, remote=False)
        self.assertEqual(self.poll("stranger")[0], 401)
        self.assertEqual(self.r.call("GET", "/poll?since=0", "host", remote=False)[0], 200)  # the host's PC still gets in

    def test_removing_a_friend_stops_their_key(self):
        _, r = self.r.call("POST", "/friends/add", "host", body={"name": "pluh"}, remote=False)
        key = r["friends"][0]["key"]
        self.r.call("POST", "/friends/remove", "host", body={"name": "pluh"}, remote=False)
        self.assertEqual(self.poll("pluh", key=key)[0], 401)

    def test_a_new_project_is_private_to_its_maker(self):
        self.assertEqual(self.r.call("POST", "/leader", "umbyz", project="secret", body={"name": "umbyz"})[0], 200)
        self.assertEqual(self.poll("stranger", project="secret")[0], 403)
        names = [p["name"] for p in self.poll("stranger")[1]["projects"]]
        self.assertNotIn("secret", names)
        mine = next(p for p in self.poll("umbyz")[1]["projects"] if p["name"] == "secret")
        self.assertTrue(mine["private"])
        self.assertEqual(mine["members"], ["umbyz"])

    def test_adding_a_member_lets_them_in_and_invites_them(self):
        self.r.call("POST", "/leader", "umbyz", project="game", body={"name": "umbyz"})
        self.r.call("POST", "/project/members", "umbyz", project="game", body={"add": ["cori"]})
        code, r = self.poll("cori", project="game")
        self.assertEqual(code, 200)
        self.assertTrue(any(m["kind"] == "invite" and m.get("invite") == "game" for m in self.poll("cori")[1]["messages"]))
        self.assertEqual(self.poll("stranger", project="game")[0], 403)

    def test_an_invite_to_one_person_lets_only_them_in(self):
        self.r.call("POST", "/leader", "umbyz", project="game", body={"name": "umbyz"})
        self.assertEqual(self.r.call("POST", "/send", "umbyz", project="game", body={"text": "join!", "kind": "invite", "to": "all"})[0], 400)
        self.r.call("POST", "/send", "umbyz", project="game", body={"text": "join!", "kind": "invite", "to": "pluh"})
        self.assertEqual(self.poll("pluh", project="game")[0], 200)
        self.assertEqual(self.poll("stranger", project="game")[0], 403)

    def test_only_the_leader_removes_other_members(self):
        self.r.call("POST", "/leader", "umbyz", project="game", body={"name": "umbyz"})
        self.r.call("POST", "/project/members", "umbyz", project="game", body={"add": ["cori", "pluh"]})
        self.assertEqual(self.r.call("POST", "/project/members", "cori", project="game", body={"remove": ["pluh"]})[0], 403)
        self.assertEqual(self.r.call("POST", "/project/members", "umbyz", project="game", body={"remove": ["pluh"]})[0], 200)
        self.assertEqual(self.poll("pluh", project="game")[0], 403)

    def test_private_messages_stay_out_of_the_log_and_the_clawds(self):
        self.r.call("POST", "/leader", "umbyz", project="secret", body={"name": "umbyz"})
        self.r.call("POST", "/send", "umbyz", project="secret", body={"text": "the secret plan"})
        log = self.r.call("GET", "/log?since=0", "stranger")[1]
        self.assertFalse(any("secret plan" in m["text"] for m in log["messages"]))
        watch = self.r.call("GET", "/watch", "stranger")[1]
        self.assertFalse(any("secret plan" in m["text"] for m in watch["recent"]))
        mine = self.r.call("GET", "/log?since=0", "umbyz")[1]
        self.assertTrue(any("secret plan" in m["text"] for m in mine["messages"]))
        peers = {p["name"]: p["project"] for p in self.poll("stranger")[1]["peers"]}
        self.assertEqual(peers.get("umbyz"), "(private)")

    def test_an_older_project_stays_open_until_its_leader_locks_it(self):
        # made before members-only projects existed: no member list in the saved state
        self.r.close()
        os.makedirs(self.r.dir, exist_ok=True)
        with open(os.path.join(self.r.dir, "state.json"), "w") as f:
            json.dump({"leaders": {"old": "umbyz"}}, f)
        data_dir = self.r.dir
        self.r = Relay.__new__(Relay)
        self.r.dir, self.r.port = data_dir, free_port()
        self.r.proc = subprocess.Popen([sys.executable, RELAY, "--host", "127.0.0.1", "--port", str(self.r.port), "--key", KEY,
                                        "--data", os.path.join(data_dir, "state.json"), "--test-remote"],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1.5)
        self.assertEqual(self.poll("anyone", project="old")[0], 200)
        self.assertEqual(self.r.call("POST", "/project/private", "anyone", project="old", body={"private": True})[0], 403)
        self.assertEqual(self.r.call("POST", "/project/private", "umbyz", project="old", body={"private": True})[0], 200)
        self.assertEqual(self.poll("stranger", project="old")[0], 403)

    def test_a_new_crew_key_locks_out_the_old_one(self):
        code, r = self.r.call("POST", "/key/rotate", "host", body={}, remote=False)
        self.assertEqual(code, 200)
        self.assertEqual(self.poll("cori")[0], 401)
        self.assertEqual(self.poll("cori", key=r["key"])[0], 200)
        self.assertEqual(self.r.call("POST", "/key/rotate", "cori", key=r["key"], body={})[0], 403)  # host only

    def test_saves_leave_no_half_written_file(self):
        self.r.call("POST", "/send", "cori", body={"text": "hi"})
        files = os.listdir(self.r.dir)
        self.assertIn("state.json", files)
        self.assertNotIn("state.json.tmp", files)
        with open(os.path.join(self.r.dir, "state.json")) as f:
            self.assertTrue(json.load(f)["messages"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
