"""The relay's own tests: run `python server/test_relay.py` (the release script runs them too).

Each test starts a real relay on a free port with its own data folder. Requests marked remote=True play a
teammate on another PC; the rest come from "the host's PC".
"""
import hashlib
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

    def call(self, method, path, name="", key=KEY, project="", body=None, remote=True, extra=None):
        headers = {"X-Crew-Key": key, "X-Crew-Name": name, "Content-Type": "application/json", **(extra or {})}
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

    def upload(self, name, data, project="", remote=True):
        """One file of a shared folder, as raw bytes (what the plugin's PowerShell uploader sends)."""
        h = hashlib.sha256(data).hexdigest()
        headers = {"X-Crew-Key": KEY, "X-Crew-Name": name, "X-Crew-Project": project}
        if remote:
            headers["X-Crew-Test-Remote"] = "1"
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/folder/blob?hash={h}", method="POST", headers=headers, data=data)
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status
        except urllib.error.HTTPError as e:
            return e.code

    def download(self, name, h):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/folder/blob?hash={h}",
                                     headers={"X-Crew-Key": KEY, "X-Crew-Name": name, "X-Crew-Test-Remote": "1"})
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.read()

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

    def test_one_person_with_chats_in_two_projects(self):
        # cori's old chat stays in main (idle) while a new chat works in "RTS"
        self.r.call("GET", "/poll?since=0", "cori", project="RTS", extra={"X-Crew-Activity": "working"})
        self.r.call("GET", "/poll?since=0", "cori", extra={"X-Crew-Activity": "idle"})
        self.r.call("GET", "/poll?since=0", "umbyz")
        projects = {p["name"]: p for p in self.r.call("GET", "/projects", "cori")[1]["projects"]}
        self.assertIn("cori", projects["RTS"]["here"])  # in both, no flipping between them
        self.assertIn("cori", projects["main"]["here"])
        cori = next(p for p in self.poll("umbyz")[1]["peers"] if p["name"] == "cori")
        self.assertEqual(cori["activity"], "working")  # the busiest chat shows, whichever checked in last
        # closing the old chat isn't leaving: the other chat is still open
        self.r.call("POST", "/leave", "cori", body={})
        cori = next(p for p in self.poll("umbyz")[1]["peers"] if p["name"] == "cori")
        self.assertTrue(cori["online"])
        self.assertFalse(any(m["kind"] == "leave" and m["from"] == "cori" for m in self.poll("umbyz")[1]["messages"]))
        self.r.call("POST", "/leave", "cori", project="RTS", body={})  # now the last one: gone
        cori = next(p for p in self.poll("umbyz")[1]["peers"] if p["name"] == "cori")
        self.assertFalse(cori["online"])

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

    def test_a_connected_teammate_gets_their_friend_key_by_itself(self):
        self.assertEqual(self.poll("timmy123")[0], 200)  # connected with the shared key
        self.r.call("POST", "/friends/add", "host", body={"name": "timmy123"}, remote=False)
        code, r = self.poll("timmy123")
        self.assertEqual(code, 200)
        key = r["yourKey"]  # handed over on the next check-in
        self.assertEqual(self.poll("timmy123", key=key)[0], 200)
        self.assertNotIn("yourKey", self.poll("timmy123", key=key)[1])
        self.assertEqual(self.poll("timmy123")[0], 401)  # once used, the shared key can't be timmy123 any more

    def test_a_second_friend_with_the_same_name_is_refused(self):
        _, r = self.r.call("POST", "/friends/add", "host", body={"name": "timmy123"}, remote=False)
        first = r["friends"][0]["key"]
        self.assertEqual(self.r.call("POST", "/friends/add", "host", body={"name": "timmy123"}, remote=False)[0], 409)
        self.assertEqual(self.poll("timmy123", key=first)[0], 200)  # the first timmy keeps working

    def test_only_the_host_sees_where_people_connect_from(self):
        self.poll("cori")
        self.assertNotIn("ip", next(p for p in self.poll("pluh")[1]["peers"] if p["name"] == "cori"))
        host_view = self.r.call("GET", "/poll?since=0", "host", remote=False)[1]
        self.assertEqual(next(p for p in host_view["peers"] if p["name"] == "cori")["ip"], "127.0.0.1")

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

    # -- shared folders and Crewshared

    def share(self, name, folder, files, project=""):
        manifest = [{"path": p, "size": len(b), "hash": hashlib.sha256(b).hexdigest()} for p, b in files.items()]
        code, r = self.r.call("POST", "/folder/manifest", name, project=project, body={"name": folder, "files": manifest})
        self.assertEqual(code, 200, r)
        for b in files.values():
            if hashlib.sha256(b).hexdigest() in r["missing"]:
                self.assertEqual(self.r.upload(name, b, project), 200)
        return self.r.call("POST", "/folder/commit", name, project=project, body={"name": folder})

    def test_a_shared_folder_reaches_teammates_and_stores_each_file_once(self):
        files = {"a.txt": b"hello", "sub/b.txt": b"hello", "c.bin": b"\x00\x01" * 1000}
        code, _ = self.share("pluh", "Crewshared/pluh", files)
        self.assertEqual(code, 200)
        f = next(x for x in self.poll("cori")[1]["folders"] if x["name"] == "Crewshared/pluh")
        self.assertEqual((f["by"], f["files"]), ("pluh", 3))
        m = self.r.call("GET", "/folder?name=Crewshared%2Fpluh", "cori")[1]
        got = {x["path"]: self.r.download("cori", x["hash"]) for x in m["files"]}
        self.assertEqual(got, files)
        stored = [n for _, _, fs in os.walk(os.path.join(self.r.dir, "crew-files")) for n in fs]
        self.assertEqual(len(stored), 2)  # "hello" twice is one stored file

    def test_an_update_uploads_only_what_changed(self):
        self.share("pluh", "src", {"a.txt": b"v1", "b.txt": b"same"})
        manifest = [{"path": "a.txt", "size": 2, "hash": hashlib.sha256(b"v2").hexdigest()},
                    {"path": "b.txt", "size": 4, "hash": hashlib.sha256(b"same").hexdigest()}]
        missing = self.r.call("POST", "/folder/manifest", "pluh", body={"name": "src", "files": manifest})[1]["missing"]
        self.assertEqual(missing, [hashlib.sha256(b"v2").hexdigest()])
        # teammates keep seeing the old version until the new one is complete
        self.assertEqual(self.r.call("POST", "/folder/commit", "pluh", body={"name": "src"})[0], 409)

    def test_only_the_sharer_changes_a_folder(self):
        self.share("pluh", "src", {"a.txt": b"mine"})
        manifest = [{"path": "a.txt", "size": 4, "hash": hashlib.sha256(b"evil").hexdigest()}]
        self.assertEqual(self.r.call("POST", "/folder/manifest", "cori", body={"name": "src", "files": manifest})[0], 403)
        self.assertEqual(self.r.call("POST", "/folder/delete", "cori", body={"name": "src"})[0], 403)
        self.assertEqual(self.r.upload("cori", b"not part of any folder"), 400)  # random uploads are refused

    def test_paths_cannot_climb_out_of_the_project_folder(self):
        manifest = [{"path": "../../evil.txt", "size": 1, "hash": hashlib.sha256(b"x").hexdigest()}]
        self.assertEqual(self.r.call("POST", "/folder/manifest", "pluh", body={"name": "src", "files": manifest})[0], 400)
        self.assertEqual(self.r.call("POST", "/folder/manifest", "pluh", body={"name": "../up", "files": manifest})[0], 400)

    def test_stopping_sharing_cleans_up_the_stored_files(self):
        self.share("pluh", "src", {"a.txt": b"bye"})
        self.assertEqual(self.r.call("POST", "/folder/delete", "pluh", body={"name": "src"})[0], 200)
        stored = [n for _, _, fs in os.walk(os.path.join(self.r.dir, "crew-files")) for n in fs]
        self.assertEqual(stored, [])
        self.assertEqual(self.poll("cori")[1]["folders"], [])

    def test_a_private_projects_folders_stay_private(self):
        self.r.call("POST", "/leader", "umbyz", project="secret", body={"name": "umbyz"})
        self.assertEqual(self.share("umbyz", "Crewshared/umbyz", {"plan.txt": b"secret"}, project="secret")[0], 200)
        self.assertEqual(self.r.call("GET", "/folder?name=Crewshared%2Fumbyz", "stranger", project="secret")[0], 403)
        self.assertEqual(self.poll("stranger")[1]["folders"], [])  # and main doesn't show it

    # -- file locks

    def test_an_edit_shows_to_teammates_in_the_same_project_only(self):
        self.r.call("POST", "/touch", "pluh", body={"path": "src/Player.lua"})
        cori = self.poll("cori")[1]["editing"]
        self.assertEqual([(e["path"], e["name"]) for e in cori], [("src/Player.lua", "pluh")])
        self.assertEqual(self.poll("pluh")[1]["editing"], [])  # not your own edits
        self.assertEqual(self.poll("cori", project="other")[1]["editing"], [])  # nor another project's

    # -- keep awake

    def test_keep_awake_is_on_by_default_and_only_the_host_switches_it(self):
        self.assertTrue(self.poll("cori")[1]["keepAwake"])
        self.assertEqual(self.r.call("POST", "/keepawake", "cori", body={"on": False})[0], 403)
        self.assertEqual(self.r.call("POST", "/keepawake", "host", body={"on": False}, remote=False)[0], 200)
        self.assertFalse(self.poll("cori")[1]["keepAwake"])

    # -- renaming a project

    def test_a_rename_moves_everything_and_the_old_name_still_finds_it(self):
        self.r.call("POST", "/leader", "umbyz", project="lava", body={"name": "umbyz"})
        self.r.call("POST", "/project/members", "umbyz", project="lava", body={"add": ["cori"]})
        self.r.call("POST", "/send", "umbyz", project="lava", body={"text": "the plan"})
        self.r.call("POST", "/tasks", "umbyz", project="lava", body={"action": "add", "title": "jump"})
        self.r.call("POST", "/shared", "umbyz", project="lava", body={"name": "map", "content": "x"})
        self.assertEqual(self.r.call("POST", "/project/rename", "cori", project="lava", body={"from": "lava", "to": "magma"})[0], 403)
        code, r = self.r.call("POST", "/project/rename", "umbyz", project="lava", body={"from": "lava", "to": "magma"})
        self.assertEqual((code, r.get("name")), (200, "magma"))
        code, r = self.poll("cori", project="magma")
        self.assertEqual(code, 200)
        self.assertTrue(any(m["text"] == "the plan" for m in r["messages"]))
        self.assertEqual([t["title"] for t in r["tasks"]], ["jump"])
        self.assertEqual(r["shared"], ["map"])
        self.assertEqual(r["leader"], "umbyz")
        code, r = self.poll("cori", project="lava")  # a plugin still on the old name lands in the new one, and is told
        self.assertEqual((code, r["project"], r.get("renamedFrom")), (200, "magma", "lava"))
        self.assertEqual(self.poll("stranger", project="magma")[0], 403)  # still members-only
        names = [p["name"] for p in self.poll("umbyz")[1]["projects"]]
        self.assertIn("magma", names)
        self.assertNotIn("lava", names)

    def test_a_rename_never_takes_an_existing_name_or_main(self):
        self.r.call("POST", "/leader", "umbyz", project="a", body={"name": "umbyz"})
        self.r.call("POST", "/leader", "umbyz", project="b", body={"name": "umbyz"})
        self.assertEqual(self.r.call("POST", "/project/rename", "umbyz", project="a", body={"from": "a", "to": "b"})[0], 409)
        self.assertEqual(self.r.call("POST", "/project/rename", "umbyz", project="a", body={"from": "a", "to": "main"})[0], 400)

    def test_a_direct_message_reaches_you_in_another_project(self):
        self.r.call("POST", "/leader", "cori", project="side", body={"name": "cori"})
        self.r.call("POST", "/send", "cori", project="side", body={"text": "T1 done, what next?", "kind": "request", "to": "umbyz"})
        self.r.call("POST", "/send", "cori", project="side", body={"text": "for everyone in side"})
        got = self.poll("umbyz", project="main")[1]["messages"]
        dm = [m for m in got if m["text"] == "T1 done, what next?"]
        self.assertEqual(len(dm), 1)
        self.assertEqual(dm[0]["project"], "(private)")  # side is cori's private project: its name stays private
        self.assertFalse(any(m["text"] == "for everyone in side" for m in got))  # messages to everyone stay put

    def test_a_message_to_you_waits_for_your_chat_in_its_own_project(self):
        # umbyz has a chat in main and one in "RTS"; pluh asks for something in main
        self.r.call("GET", "/poll?since=0", "umbyz", project="RTS")
        self.r.call("GET", "/poll?since=0", "umbyz")
        self.r.call("POST", "/send", "pluh", body={"to": "umbyz", "kind": "request", "text": "build the gate"})
        texts = lambda project: [m["text"] for m in self.poll("umbyz", project=project)[1]["messages"]]
        self.assertIn("build the gate", texts(""))
        self.assertNotIn("build the gate", texts("RTS"))  # not in the RTS chat as well
        # with no chat in main any more, it reaches whichever chat they have (labelled with its project)
        self.r.call("POST", "/leave", "umbyz", body={})
        self.assertIn("build the gate", texts("RTS"))

    def test_a_message_sent_late_from_an_outbox_says_when_it_was_written(self):
        before = time.time()
        code, r = self.r.call("POST", "/send", "pluh", body={"to": "umbyz", "kind": "request", "text": "late one", "waited": 7200})
        self.assertEqual(code, 200)
        self.assertAlmostEqual(r["written"], before - 7200, delta=5)
        got = [m for m in self.poll("umbyz")[1]["messages"] if m["text"] == "late one"]
        self.assertAlmostEqual(got[0]["written"], before - 7200, delta=5)
        ancient = self.r.call("POST", "/send", "pluh", body={"to": "umbyz", "text": "ancient", "waited": 10 ** 12})[1]
        self.assertGreater(ancient["written"], before - 31 * 86400)  # capped at 30 days
        for waited in (0, 0.5, -5, "7200", True, None):  # nothing to say, or nonsense: no "written"
            r = self.r.call("POST", "/send", "pluh", body={"to": "umbyz", "text": "fresh", "waited": waited})[1]
            self.assertNotIn("written", r)

    def test_whoever_sent_the_uwu_hears_once_whose_claudes_it_reached(self):
        self.poll("bob")
        got = self.r.call("POST", "/uwu", "alice", body={})[1]
        self.r.call("POST", "/uwu/used", "bob", body={"id": got["id"]})
        self.r.call("POST", "/uwu/used", "bob", body={"id": got["id"]})  # once is enough
        self.r.call("POST", "/uwu/used", "alice", body={"id": got["id"]})  # their own Claude doesn't count
        self.r.call("POST", "/uwu/used", "carol", body={"id": "nope"})  # an old or made-up one doesn't either
        self.assertNotIn("uwuUsed", self.poll("bob")[1])  # nobody else hears
        self.assertEqual(self.poll("alice")[1]["uwuUsed"], ["bob"])
        self.assertNotIn("uwuUsed", self.poll("alice")[1])  # told once

    def test_another_ai_on_the_host_pc_is_a_teammate_not_the_host(self):
        ai = {"X-Crew-Client": "codex", "X-Crew-Version": "1.25.0"}
        self.r.call("POST", "/friends/mode", "umbyz", body={"door": "friends"}, remote=False)
        code, got = self.r.call("GET", "/poll?since=0", "GPT", remote=False, extra=ai)
        self.assertEqual((code, got.get("knocking")), (401, True))  # from the host's own PC, and it knocks like anyone
        self.r.call("POST", "/friends/letin", "umbyz", body={"name": "GPT"}, remote=False)
        code, got = self.r.call("GET", "/poll?since=0", "GPT", remote=False, extra=ai)
        self.assertEqual(code, 200)
        self.assertTrue(got.get("yourKey"))
        self.assertEqual(next(p for p in got["peers"] if p["name"] == "GPT")["client"], "codex")
        code, _ = self.r.call("POST", "/friends/list", "GPT", key=got["yourKey"], body={}, remote=False, extra=ai)
        self.assertEqual(code, 403)  # no host powers

    def test_another_ais_read_receipt_is_what_its_ai_has_seen(self):
        ai = {"X-Crew-Client": "codex"}
        self.r.call("GET", "/poll?since=0", "GPT", extra=ai)
        sent = self.r.call("POST", "/send", "umbyz", body={"to": "GPT", "text": "hi GPT"})[1]
        self.r.call("GET", "/poll?since=0", "GPT", extra=ai)  # its bridge has it; its AI hasn't seen it yet
        self.assertLess(self.poll("umbyz")[1]["reads"].get("GPT", 0), sent["id"])
        self.r.call("POST", "/read", "GPT", body={"id": sent["id"]}, extra=ai)
        self.assertEqual(self.poll("umbyz")[1]["reads"]["GPT"], sent["id"])
        self.assertEqual(self.r.call("POST", "/read", "GPT", body={"id": "x"}, extra=ai)[0], 400)

    def test_images_outlive_the_in_memory_cache(self):
        import base64
        ids = []
        for i in range(42):  # more than the 40 kept in memory
            data = base64.b64encode(bytes([i]) * 100).decode()
            code, r = self.r.call("POST", "/files", "cori", body={"to": "all", "name": f"s{i}.png", "mime": "image/png", "data": data})
            self.assertEqual(code, 200, r)
            ids.append(r["file"])
        req = urllib.request.Request(f"http://127.0.0.1:{self.r.port}/file?id={ids[0]}",
                                     headers={"X-Crew-Key": KEY, "X-Crew-Name": "umbyz", "X-Crew-Test-Remote": "1"})
        with urllib.request.urlopen(req, timeout=5) as r:
            self.assertEqual(r.read(), bytes([0]) * 100)

    def test_task_order_blocked_and_checked(self):
        self.r.call("POST", "/leader", "cori", body={"name": "cori"})
        _, a = self.r.call("POST", "/tasks", "cori", body={"action": "add", "title": "skeleton"})
        _, b = self.r.call("POST", "/tasks", "cori", body={"action": "add", "title": "enemies", "assignee": "pluh",
                                                           "after": f"T{a['id']}, T999"})  # T999 doesn't exist: ignored
        self.assertEqual(b["after"], [a["id"]])
        self.assertEqual(b["waiting"], [a["id"]])
        _, r = self.r.call("POST", "/tasks", "pluh", body={"action": "block", "id": b["id"], "reason": "needs the art"})
        self.assertEqual(r["blocked"], "needs the art")
        self.assertEqual(self.r.call("POST", "/tasks", "pluh", body={"action": "block", "id": b["id"]})[0], 400)  # no reason
        self.r.call("POST", "/tasks", "pluh", body={"action": "unblock", "id": b["id"]})
        self.r.call("POST", "/tasks", "cori", body={"action": "done", "id": a["id"]})
        msgs = self.poll("pluh")[1]["messages"]
        self.assertTrue(any(m["to"] == "pluh" and m["kind"] == "request" and f"T{b['id']} can start" in m["text"] for m in msgs))
        tasks = {t["id"]: t for t in self.poll("pluh")[1]["tasks"]}
        self.assertNotIn("waiting", tasks[b["id"]])
        self.assertNotIn("blocked", tasks[b["id"]])
        self.assertEqual(self.r.call("POST", "/tasks", "pluh", body={"action": "check", "id": a["id"]})[0], 403)  # not the leader
        _, r = self.r.call("POST", "/tasks", "cori", body={"action": "check", "id": a["id"]})
        self.assertEqual(r["checkedBy"], "cori")
        self.assertEqual(self.r.call("POST", "/tasks", "cori", body={"action": "check", "id": b["id"]})[0], 400)  # not done

    def test_each_project_counts_its_own_tasks(self):
        add = lambda project, title: self.r.call("POST", "/tasks", "cori", project=project, body={"action": "add", "title": title})[1]
        self.assertEqual(add("", "m1")["id"], 1)
        self.assertEqual(add("", "m2")["id"], 2)
        self.assertEqual(add("RTS", "r1")["id"], 1)  # a new project starts over
        r2 = add("RTS", "r2")
        self.assertEqual(r2["id"], 2)
        # the same number in two projects are two tasks
        self.r.call("POST", "/tasks", "cori", project="RTS", body={"action": "done", "id": 1})
        tasks = {t["title"]: t for t in self.poll("cori")[1]["tasks"]}
        self.assertEqual(tasks["m1"]["status"], "open")
        # removing the newest doesn't reuse its number
        self.r.call("POST", "/tasks", "cori", project="RTS", body={"action": "remove", "id": r2["id"]})
        self.assertEqual(add("RTS", "r3")["id"], 3)
        # a renamed project keeps counting; a deleted one starts over
        self.assertEqual(self.r.call("POST", "/project/rename", "host", body={"from": "RTS", "to": "Game"}, remote=False)[0], 200)
        self.assertEqual(add("Game", "g4")["id"], 4)
        self.assertEqual(self.r.call("POST", "/project/delete", "host", body={"name": "Game"}, remote=False)[0], 200)
        self.assertEqual(add("Game", "again")["id"], 1)

    def test_the_project_watches_its_claudes_talk(self):
        # a members-only project: cori, pluh and umbyz are in it, nova isn't
        self.poll("cori", project="RTS")
        self.r.call("POST", "/project/members", "cori", project="RTS", body={"add": ["pluh", "umbyz"]})
        self.poll("pluh", project="RTS")
        self.poll("umbyz", project="RTS")
        send = lambda **b: self.r.call("POST", "/send", "cori", project="RTS", body={"to": "pluh", **b})[1]
        claude = send(text="does the gate use Config?", kind="request")
        send(text="psst, lunch?", kind="chat", human=True)  # a person's private message
        send(text="for your human", kind="chat", notify=True)
        code, poll = self.poll("umbyz", project="RTS")
        self.assertEqual(code, 200)
        # umbyz watches it, but it isn't among the messages handed to umbyz's Claude
        self.assertEqual([m["id"] for m in poll["team"]], [claude["id"]])
        self.assertNotIn(claude["id"], [m["id"] for m in poll["messages"]])
        # the receiver gets it as always, once
        pluh = self.poll("pluh", project="RTS")[1]
        self.assertIn(claude["id"], [m["id"] for m in pluh["messages"]])
        self.assertEqual(pluh["team"], [])
        # another project's chat doesn't list it, and an outsider can't get in
        self.assertEqual(self.poll("umbyz")[1]["team"], [])
        self.assertEqual(self.poll("nova", project="RTS")[0], 403)

    def test_the_log_shows_one_project_or_all(self):
        self.r.call("POST", "/send", "cori", body={"text": "in main"})
        self.r.call("POST", "/send", "cori", project="RTS", body={"text": "in rts"})
        self.r.call("POST", "/project/members", "cori", project="RTS", body={"add": ["pluh"]})
        self.poll("pluh", project="RTS")
        self.r.call("POST", "/send", "cori", project="RTS", body={"to": "pluh", "text": "claude to claude"})
        self.r.call("POST", "/send", "cori", project="RTS", body={"to": "pluh", "text": "private", "human": True})
        log = lambda who, q="": [m["text"] for m in self.r.call("GET", f"/log?since=0{q}", who)[1]["messages"]]
        self.assertIn("in main", log("cori"))  # no project asked for: all of them, as before
        self.assertIn("in rts", log("cori"))
        rts = log("umbyz2", "&project=RTS")  # not a member: sees none of it
        self.assertEqual([t for t in rts if "rts" in t or "claude" in t], [])
        self.r.call("POST", "/project/members", "cori", project="RTS", body={"add": ["umbyz"]})
        self.poll("umbyz", project="RTS")
        rts = log("umbyz", "&project=RTS")
        self.assertIn("claude to claude", rts)
        self.assertIn("in rts", rts)
        self.assertFalse([t for t in rts if "joined the crew" in t])  # comings and goings don't fill a project's log
        self.assertNotIn("in main", rts)
        self.assertNotIn("private", rts)
        self.assertIn("in main", log("umbyz", "&project=main"))
        self.assertNotIn("in rts", log("umbyz", "&project=main"))
        self.assertIn("RTS", self.r.call("GET", "/log?since=0", "umbyz")[1]["projects"])

    def test_an_image_goes_through(self):
        import base64
        data = base64.b64encode(os.urandom(50_000)).decode()
        code, r = self.r.call("POST", "/files", "cori", body={"to": "all", "name": "shot.png", "mime": "image/png", "data": data})
        self.assertEqual(code, 200, r)
        self.assertEqual(r["kind"], "image")
    def test_moments_reach_the_clawds_windows_and_stay_out_of_the_chat(self):
        self.poll("alice")
        self.poll("bob")
        code, got = self.r.call("POST", "/moment", "alice", body={"kind": "bonk", "to": "@BOB"})
        self.assertEqual((code, got["to"]), (200, "bob"))
        code, _ = self.r.call("POST", "/moment", "alice", body={"kind": "bonk", "to": "bob"})
        self.assertEqual(code, 429)  # one at a time
        code, got = self.r.call("POST", "/moment", "bob", body={"kind": "pookie"})
        self.assertEqual((code, got["to"]), (200, "alice"))  # no name: a random teammate
        code, watch = self.r.call("GET", "/watch", "carol")
        self.assertEqual([(m["kind"], m["from"], m["to"]) for m in watch["moments"]],
                         [("bonk", "alice", "bob"), ("pookie", "bob", "alice")])
        code, polled = self.poll("alice")
        self.assertFalse([m for m in polled["messages"] if m["kind"] in ("pookie", "bonk")])

    def test_a_moment_needs_a_teammate_who_is_online(self):
        self.poll("alice")
        code, got = self.r.call("POST", "/moment", "alice", body={"kind": "pookie"})
        self.assertEqual(code, 404)
        self.poll("bob")
        self.assertEqual(self.r.call("POST", "/moment", "alice", body={"kind": "pookie", "to": "alice"})[0], 400)
        self.assertEqual(self.r.call("POST", "/moment", "alice", body={"kind": "nuke", "to": "bob"})[0], 400)
        code, got = self.r.call("POST", "/moment", "alice", body={"kind": "bonk", "to": "dave"})
        self.assertEqual(code, 404)
        self.assertIn("bob", got["error"])

    def test_uwu_reaches_every_project_and_stays_out_of_every_list(self):
        self.poll("alice", project="game")
        self.r.call("GET", "/poll?since=0", "bob", extra={"X-Crew-Version": "1.24.2"})
        self.r.call("GET", "/poll?since=0", "cori", extra={"X-Crew-Version": "1.24.1"})  # gets it, can't say it landed
        self.poll("pluh")  # a crew too old to say its version, let alone get the joke
        self.r.call("GET", "/poll?since=0", "GPT", extra={"X-Crew-Client": "codex", "X-Crew-Version": "1.25.0"})  # not a Claude
        code, got = self.r.call("POST", "/uwu", "alice", project="game", body={})
        self.assertEqual(code, 200)
        # who's online to get it (alice's own Claude gets it too)
        self.assertEqual((got["to"], got["old"], got["quiet"]), (["bob", "cori"], ["pluh"], ["cori"]))
        self.assertEqual(self.poll("alice", project="game")[1]["uwu"], got["id"])
        self.assertEqual(self.poll("bob")[1]["uwu"], got["id"])  # another project: the whole crew gets it
        self.assertEqual(self.r.call("POST", "/uwu", "bob", body={})[0], 429)
        code, polled = self.poll("alice", project="game")
        self.assertFalse([m for m in polled["messages"] if "uwu" in m["text"].lower()])
        code, log = self.r.call("GET", "/log", "alice")
        self.assertNotIn(got["id"], json.dumps(log))


    def test_written_updates_are_marked_and_the_relays_own_lines_are_not(self):
        self.r.call("POST", "/send", "alice", body={"text": "T11 split approved", "kind": "update"})
        self.r.call("POST", "/tasks", "alice", body={"action": "add", "title": "Raft"})
        said = {m["text"]: m.get("said", False) for m in self.poll("bob")[1]["messages"] if m["kind"] == "update"}
        self.assertTrue(said["T11 split approved"])
        self.assertFalse(said["added task T1: Raft"])

    def test_assigning_a_claimed_task_moves_the_claim_and_tells_the_old_owner(self):
        tid = self.r.call("POST", "/tasks", "alice", body={"action": "add", "title": "Polish"})[1]["id"]
        self.r.call("POST", "/tasks", "bob", body={"action": "claim", "id": tid})
        code, t = self.r.call("POST", "/tasks", "alice", body={"action": "assign", "id": tid, "assignee": "carol"})
        self.assertEqual((code, t["status"], t["owner"], t["assignee"]), (200, "open", None, "carol"))
        self.assertTrue(any(m["to"] == "bob" and "off your list" in m["text"] for m in self.poll("bob")[1]["messages"]))
        self.assertTrue(any(m["to"] == "carol" and m["kind"] == "request" for m in self.poll("carol")[1]["messages"]))

    def test_can_start_is_never_sent_to_yourself_and_is_a_heads_up_for_someone_already_on_it(self):
        def add(title, **kw):
            return self.r.call("POST", "/tasks", "alice", body={"action": "add", "title": title, **kw})[1]["id"]
        base = add("Skeleton")
        add("Mine", after=f"T{base}", assignee="alice")
        early = add("Early", after=f"T{base}", assignee="bob")
        add("Later", after=f"T{base}", assignee="carol")
        self.r.call("POST", "/tasks", "bob", body={"action": "claim", "id": early})
        self.r.call("POST", "/tasks", "alice", body={"action": "done", "id": base})
        can = {(m["to"], m["kind"]) for m in self.poll("alice")[1]["messages"] if "can start" in m["text"]}
        self.assertEqual(can, {("bob", "chat"), ("carol", "request")})

    def test_a_shared_doc_can_be_appended_to(self):
        self.r.call("POST", "/shared", "alice", body={"name": "plan", "content": "# Plan\n- one\n"})
        code, got = self.r.call("POST", "/shared", "bob", body={"name": "plan", "content": "- two", "append": True})
        self.assertTrue(got["appended"])
        self.assertEqual(self.r.call("GET", "/shared?name=plan", "carol")[1]["content"], "# Plan\n- one\n- two")
        code, got = self.r.call("POST", "/shared", "bob", body={"name": "notes", "content": "- first", "append": True})
        self.assertFalse(got["appended"])  # nothing to add to yet: it starts the doc
        self.assertEqual(self.r.call("GET", "/shared?name=notes", "carol")[1]["content"], "- first")


    def test_the_leader_picks_a_stage_and_each_window_shows_its_own_project(self):
        self.poll("alice", project="game")
        self.poll("bob")
        self.r.call("POST", "/leader", "alice", project="game", body={"name": "alice"})
        self.assertEqual(self.r.call("POST", "/stage", "bob", project="game", body={"theme": "ocean"})[0], 403)
        self.assertEqual(self.r.call("POST", "/stage", "alice", project="game", body={"theme": "lava"})[0], 400)
        self.assertEqual(self.r.call("POST", "/stage", "alice", project="game", body={"theme": "Ocean"}), (200, {"stage": "ocean"}))
        self.assertEqual(self.poll("alice", project="game")[1]["stage"], "ocean")
        self.assertEqual(self.r.call("GET", "/watch", "alice")[1]["stage"], "ocean")  # alice's chat is in game
        self.assertEqual(self.r.call("GET", "/watch", "bob")[1]["stage"], "plain")  # bob's is in main
        self.r.call("POST", "/project/rename", "alice", project="game", body={"from": "game", "to": "sea game"})
        self.assertEqual(self.poll("alice", project="sea game")[1]["stage"], "ocean")  # it follows a rename


    def host(self, method, path, body=None):
        """A call from the host's own PC."""
        return self.r.call(method, path, "umbyz", body=body, remote=False)

    def knocks(self):
        return {k["name"]: k["friend"] for k in self.host("GET", "/poll?since=0")[1]["knocks"]}

    def test_parties_decide_who_gets_in_and_everyone_else_knocks(self):
        self.host("POST", "/friends/parties", {"add": "school"})
        self.host("POST", "/friends/parties", {"add": "crew"})
        key = {}
        for name, party in (("cori", "crew"), ("sam", "school")):
            key[name] = next(f["key"] for f in self.host("POST", "/friends/add", {"name": name})[1]["friends"] if f["name"] == name)
            self.host("POST", "/friends/party", {"name": name, "party": party, "on": True})
        code, r = self.host("POST", "/friends/mode", {"door": "party", "party": "school"})
        self.assertEqual((r["party"], r["friendsOnly"]), ("school", True))
        self.assertEqual(self.poll("sam", key=key["sam"])[0], 200)  # in the open party
        code, r = self.poll("cori", key=key["cori"])  # a friend from another party knocks
        self.assertEqual(code, 401)
        self.assertIn("you're knocking", r["error"])
        self.assertTrue(r["error"].startswith("this crew is friends-only"))  # what an older plugin shows as is
        self.assertEqual(self.poll("newkid")[0], 401)  # the shared key: knocks too
        self.assertEqual(self.knocks(), {"cori": True, "newkid": False})
        # let the new kid in: a personal key on their next check-in, in the school party
        self.host("POST", "/friends/letin", {"name": "newkid"})
        code, r = self.poll("newkid")
        self.assertEqual(code, 200)
        self.assertTrue(r["yourKey"])
        # turn cori away: off the list, and told so
        self.host("POST", "/friends/turnaway", {"name": "cori"})
        code, r = self.poll("cori", key=key["cori"])
        self.assertIn("turned you away", r["error"])
        self.assertNotIn("cori", self.knocks())
        # let in after all: now in both parties
        self.host("POST", "/friends/letin", {"name": "cori"})
        self.assertEqual(self.poll("cori", key=key["cori"])[0], 200)
        # dropping the open party leaves the door at friends only
        code, r = self.host("POST", "/friends/parties", {"remove": "school"})
        self.assertEqual((r["party"], r["friendsOnly"], r["parties"]), (None, True, ["crew"]))
        self.assertEqual(self.poll("stranger")[0], 401)
        self.host("POST", "/friends/mode", {"door": "open"})
        self.assertEqual(self.poll("stranger")[0], 200)

    def test_only_the_leader_or_host_changes_the_leader_and_anyone_else_asks_for_a_vote(self):
        for n in ("alice", "bob", "carol"):
            self.poll(n)
        self.assertEqual(self.r.call("POST", "/leader", "alice", body={"name": "alice"})[0], 200)  # no leader yet: anyone
        code, r = self.r.call("POST", "/leader", "bob", body={"name": "bob"})
        self.assertEqual(code, 403)
        self.assertIn("ask the crew to vote", r["error"])
        code, v = self.r.call("POST", "/vote", "bob", body={"for": "bob"})
        self.assertEqual((code, v["yes"], v["voters"]), (200, ["bob"], ["alice", "bob", "carol"]))
        self.assertEqual(self.r.call("POST", "/vote", "carol", body={"for": "carol"})[0], 409)  # one at a time
        self.assertEqual(self.poll("alice")[1]["vote"]["for"], "bob")
        self.assertEqual(self.r.call("POST", "/vote/cast", "bob", body={"id": v["id"], "yes": True})[0], 409)  # once each
        code, r = self.r.call("POST", "/vote/cast", "carol", body={"id": v["id"], "yes": True})
        self.assertEqual((r["ended"], r["leader"]), (True, "bob"))  # 2 of 3 said yes
        self.assertNotIn("vote", self.poll("alice")[1])
        self.assertTrue(any("was voted in" in m["text"] for m in self.poll("alice")[1]["messages"]))
        # the leader hands it over directly, and the host always can
        self.assertEqual(self.r.call("POST", "/leader", "bob", body={"name": "carol"})[0], 200)
        self.assertEqual(self.host("POST", "/leader", {"name": "alice"})[0], 200)

    def test_a_vote_fails_on_no_and_nobody_votes_themselves_in_alone(self):
        self.poll("alice")
        self.poll("bob")
        self.r.call("POST", "/leader", "alice", body={"name": "alice"})
        v = self.r.call("POST", "/vote", "bob", body={"for": "bob"})[1]
        code, r = self.r.call("POST", "/vote/cast", "alice", body={"id": v["id"], "yes": False})
        self.assertEqual((r["ended"], r["leader"]), (True, "alice"))
        self.poll("dave", project="solo")  # alone in a project someone else leads
        self.r.call("POST", "/leader", "dave", project="solo", body={"name": "erin"})
        code, r = self.r.call("POST", "/vote", "dave", project="solo", body={"for": "dave"})
        self.assertEqual(code, 400)
        self.assertIn("nobody else", r["error"])

    def test_the_host_cant_be_removed_and_only_the_leader_or_host_clear_a_chat_or_remove_tasks(self):
        self.host("GET", "/poll?since=0")
        self.poll("alice")
        self.poll("bob")
        self.r.call("POST", "/leader", "alice", body={"name": "alice"})
        code, r = self.r.call("POST", "/kick", "alice", body={"name": "umbyz"})
        self.assertEqual(code, 403)
        self.assertIn("hosts this relay", r["error"])
        self.assertEqual(self.r.call("POST", "/reset", "bob", body={})[0], 403)
        self.assertEqual(self.r.call("POST", "/reset", "alice", body={})[0], 200)
        theirs = self.r.call("POST", "/tasks", "alice", body={"action": "add", "title": "Raft"})[1]["id"]
        self.assertEqual(self.r.call("POST", "/tasks", "bob", body={"action": "remove", "id": theirs})[0], 403)
        mine = self.r.call("POST", "/tasks", "bob", body={"action": "add", "title": "Mine"})[1]["id"]
        self.assertEqual(self.r.call("POST", "/tasks", "bob", body={"action": "remove", "id": mine})[0], 200)
        self.assertEqual(self.r.call("POST", "/tasks", "alice", body={"action": "remove", "id": theirs})[0], 200)


    def people(self):
        return {p["name"]: p["kind"] for p in self.host("POST", "/friends/list", {})[1]["people"]}

    def test_letting_someone_in_makes_a_member_and_a_star_makes_a_friend(self):
        self.host("POST", "/friends/mode", {"door": "friends"})
        self.assertEqual(self.poll("newkid")[0], 401)  # knocks
        self.host("POST", "/friends/letin", {"name": "newkid"})
        self.assertEqual(self.poll("newkid")[0], 200)
        self.assertEqual(self.people()["newkid"], "member")
        row = next(p for p in self.host("GET", "/poll?since=0")[1]["peers"] if p["name"] == "newkid")
        self.assertEqual((row["friend"], row["member"]), (False, True))
        self.host("POST", "/friends/add", {"name": "newkid"})  # ★ Friend: the same key, now a friend
        self.assertEqual(self.people()["newkid"], "friend")
        self.host("POST", "/friends/kind", {"name": "newkid", "kind": "member"})
        self.assertEqual(self.people()["newkid"], "member")

    def test_a_locked_person_is_turned_away_whatever_the_door_and_never_knocks(self):
        self.poll("sam")  # came in with the crew key while the door was open
        self.assertEqual(self.people()["sam"], "visitor")
        self.host("POST", "/friends/lock", {"name": "sam", "on": True})
        code, r = self.poll("sam")
        self.assertEqual((code, r.get("locked")), (403, True))
        self.assertEqual(self.people()["sam"], "locked")
        self.host("POST", "/friends/mode", {"door": "friends"})
        self.poll("sam")
        self.assertNotIn("sam", self.knocks())
        self.host("POST", "/friends/lock", {"name": "sam", "on": False})
        self.assertEqual(self.poll("sam")[0], 401)  # unlocked: the door is locked, so now they knock
        self.assertIn("sam", self.knocks())

    def test_friends_cant_be_locked_until_they_are_members(self):
        self.host("POST", "/friends/add", {"name": "cori"})
        code, r = self.host("POST", "/friends/lock", {"name": "cori", "on": True})
        self.assertEqual(code, 400)
        self.assertIn("make them a member first", r["error"])
        self.host("POST", "/friends/kind", {"name": "cori", "kind": "member"})
        self.assertEqual(self.host("POST", "/friends/lock", {"name": "cori", "on": True})[0], 200)
        self.assertEqual(self.host("POST", "/friends/lock", {"name": "umbyz", "on": True})[1].get("error"), "that's you, the host")


class SweepTest(unittest.TestCase):
    """The sweeper, run in this process with a made-up state (nothing is saved)."""

    def test_a_task_released_for_an_absent_owner_is_a_notice_the_claudes_receive(self):
        import relay
        kept = (relay.state, relay.save, relay.STARTED)
        relay.state = {"next_id": 1, "messages": [], "shared": {}, "leader": None,
                       "tasks": [{"id": 4, "title": "Raft", "status": "claimed", "owner": "bob", "project": "game"}]}
        relay.save = lambda: None
        relay.STARTED = time.time() - relay.RELEASE_MINUTES * 60 - 5  # bob hasn't been seen since the relay started
        try:
            with relay.lock:
                relay.sweep()
            t = relay.state["tasks"][0]
            self.assertEqual((t["status"], t["owner"]), ("open", None))
            [m] = relay.state["messages"]
            self.assertTrue(m["text"].startswith("released task T4: bob"))
            self.assertEqual((m["kind"], m["to"], m["project"], m.get("notice")), ("update", "all", "game", True))
        finally:
            relay.state, relay.save, relay.STARTED = kept

    def test_a_vote_whose_time_is_up_ends_without_passing(self):
        import relay
        kept = (relay.state, relay.save)
        relay.state = {"next_id": 1, "messages": [], "shared": {}, "leader": "alice", "tasks": []}
        relay.save = lambda: None
        relay.votes[relay.MAIN] = {"id": "v", "for": "bob", "by": "bob", "until": time.time() - 1,
                                   "voters": ["alice", "bob", "carol"], "yes": ["bob"], "no": []}
        try:
            with relay.lock:
                relay.sweep()
            self.assertNotIn(relay.MAIN, relay.votes)
            self.assertEqual(relay.state["leader"], "alice")
            self.assertTrue(any("time ran out" in m["text"] for m in relay.state["messages"]))
        finally:
            relay.state, relay.save = kept
            relay.votes.clear()


if __name__ == "__main__":
    unittest.main(verbosity=1)
