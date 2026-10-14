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

    def test_an_image_goes_through(self):
        import base64
        data = base64.b64encode(os.urandom(50_000)).decode()
        code, r = self.r.call("POST", "/files", "cori", body={"to": "all", "name": "shot.png", "mime": "image/png", "data": data})
        self.assertEqual(code, 200, r)
        self.assertEqual(r["kind"], "image")


if __name__ == "__main__":
    unittest.main(verbosity=1)
