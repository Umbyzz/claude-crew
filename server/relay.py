"""Crew relay: the tiny hub that links several Claude Code sessions.

One person runs this; everyone else's `crew` mod polls it over HTTP.
Stdlib only (Python 3.8+). Reach it over a VPN (Tailscale, Radmin VPN, ZeroTier)
or your LAN -- do not expose it to the open internet.

    python relay.py --key <shared-secret> [--port 7777] [--data crew_state.json]
    python relay.py --key-file crew_key.txt     (makes a random key the first time)
"""
import argparse
import base64
import binascii
import hmac
import json
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

VERSION = "0.9.3"
MAX_MESSAGES = 2000
MAX_TEXT = 50_000
MAX_SHARED = 200_000
MAX_FILE = 8_000_000  # bytes per shared image
MAX_FILES = 40  # images kept in memory, oldest dropped first
ONLINE_SECONDS = 12  # no check-in for this long: shown as offline
GONE_SECONDS = 20  # no check-in for this long: the crew is told they lost connection (a clean exit says so at once)
ACTIVITIES = ("idle", "thinking", "typing", "working", "chatting", "done", "cheer", "away", "out")
KINDS = ("chat", "request", "update", "out", "back", "join", "leave", "image")

lock = threading.Lock()
arrived = threading.Condition(lock)  # rung on every new message, for /wait (crew_wait)
state = {"next_id": 1, "messages": [], "tasks": [], "shared": {}, "leader": None,
         "chat_epoch": 0}  # bumped by "Reset chat": every plugin then empties its chat
# name -> {"seen", "activity", "since", "subagents", "chatTo", "joinedAt", "left", "gone"}, memory only
peers = {}
files = {}  # id -> {"id", "name", "mime", "data" (bytes), "by", "at"}, memory only
args = None


def save():
    with open(args.data, "w", encoding="utf-8") as f:
        json.dump(state, f)


def load():
    try:
        with open(args.data, encoding="utf-8") as f:
            state.update(json.load(f))
    except FileNotFoundError:
        pass


def new_id():
    i = state["next_id"]
    state["next_id"] += 1
    return i


def is_online(p, now):
    return not p.get("left") and now - p["seen"] < ONLINE_SECONDS


def peer_list():
    now = time.time()
    return [
        {"name": n, "online": is_online(p, now), "lastSeen": int(p["seen"]),
         "activity": p["activity"], "leader": n == state["leader"], "since": p["since"],
         "subagents": p["subagents"], "chatTo": p["chatTo"], "joinedAt": p["joinedAt"],
         "version": p.get("version")}
        for n, p in sorted(peers.items())
    ]


def open_tasks_of(name):
    return [t for t in state["tasks"] if t["status"] == "claimed" and t["owner"] == name]


def announce_leave(name, why):
    """Tell the crew someone is gone, and which tasks they were holding."""
    held = open_tasks_of(name)
    tasks = "; ".join(f"#{t['id']} {t['title']}" for t in held)
    text = f"{name} {why}." + (f" They were working on: {tasks}." if held else "")
    post_message(name, "all", text, "leave")
    peers[name]["gone"] = True


def sweep():
    """Announce anyone whose plugin stopped checking in (Claude closed without saying bye)."""
    now = time.time()
    for name, p in peers.items():
        if not p.get("gone") and not p.get("left") and now - p["seen"] >= GONE_SECONDS:
            announce_leave(name, "lost connection (their Claude was closed or went offline)")
            save()


def sweeper():
    while True:
        time.sleep(2)
        with lock:
            sweep()


def touch(name, headers):
    """Mark a member present and take the activity their plugin reports."""
    now = time.time()
    fresh = name not in peers
    p = peers.setdefault(name, {"seen": 0, "activity": "idle", "since": now,
                                "subagents": 0, "chatTo": None, "joinedAt": now})
    if fresh or p.get("gone") or p.get("left"):
        p["joinedAt"] = now  # back from offline (or brand new): the Clawds greet them
        p["left"] = p["gone"] = False
        post_message(name, "all", f"{name} joined the crew session", "join")
    p["seen"] = now
    activity = headers.get("X-Crew-Activity")
    if activity in ACTIVITIES and activity != p["activity"]:
        p["activity"], p["since"] = activity, now
    try:
        p["subagents"] = max(0, min(9, int(headers.get("X-Crew-Subagents") or 0)))
    except ValueError:
        pass
    p["chatTo"] = (headers.get("X-Crew-Chat-To") or "").strip()[:40] or None
    p["version"] = (headers.get("X-Crew-Version") or "").strip()[:20] or p.get("version")  # who needs to update


def post_message(sender, to, text, kind, **extra):
    # "at" is the relay's clock to the millisecond: one clock for everyone, so delivery times can be compared.
    msg = {"id": new_id(), "from": sender, "to": to or "all", "kind": kind,
           "text": text[:MAX_TEXT], "at": round(time.time(), 3), **extra}
    state["messages"].append(msg)
    del state["messages"][:-MAX_MESSAGES]
    arrived.notify_all()  # callers hold the lock, so anyone in /wait wakes up
    return msg


class Handler(BaseHTTPRequestHandler):
    server_version = "CrewRelay/" + VERSION

    def log_message(self, fmt, *a):
        if args.verbose:
            super().log_message(fmt, *a)

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def reply_bytes(self, data, mime):
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authed(self, presence=True):
        if not hmac.compare_digest(self.headers.get("X-Crew-Key") or "", args.key):
            self.reply(401, {"error": "bad or missing crew key"})
            return False
        name = (self.headers.get("X-Crew-Name") or "").strip()[:40]
        if not name and presence:
            self.reply(400, {"error": "missing X-Crew-Name"})
            return False
        self.name = name
        if presence:
            with lock:
                touch(name, self.headers)
        return True

    def body(self, limit=MAX_SHARED * 2):
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            raise ValueError("body too large")
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/health":
            return self.reply(200, {"ok": True, "version": VERSION})
        # /watch is for the Clawds window: it reads the crew without counting as a member.
        if not self.authed(presence=url.path not in ("/watch", "/file")):
            return
        q = parse_qs(url.query)
        with lock:
            if url.path == "/wait":
                # crew_wait: hold the request open until a message for this member arrives (or the timeout),
                # so a Claude can wait for a reply without polling in a loop.
                since = int(q.get("since", ["0"])[0])
                only = q.get("from", [""])[0]
                deadline = time.time() + max(1.0, min(90.0, float(q.get("timeout", ["60"])[0])))

                def matches():
                    return [m for m in state["messages"] if m["id"] > since and m["from"] != self.name
                            and m["to"] in ("all", self.name) and m["kind"] not in ("update", "join")
                            and (not only or m["from"] == only)]

                found = matches()
                while not found and time.time() < deadline:
                    arrived.wait(deadline - time.time())
                    found = matches()
                return self.reply(200, {"messages": found, "now": time.time(), "timedOut": not found})
            if url.path == "/file":  # an image's raw bytes, for curl to save
                f = files.get(q.get("id", [""])[0])
                if not f:
                    return self.reply(404, {"error": "no such image (the relay keeps the latest few)"})
                return self.reply_bytes(f["data"], f["mime"])
            if url.path == "/watch":
                # Direct messages between other people stay private: the window learns that they talked
                # (for the animation) but not what was said.
                viewer = self.name

                def visible(m):
                    return m["to"] == "all" or (viewer and viewer in (m["to"], m["from"]))

                recent = [{"id": m["id"], "from": m["from"], "to": m["to"], "kind": m["kind"],
                           "text": m["text"][:80] if visible(m) else "", "at": m["at"]}
                          for m in state["messages"][-30:]
                          if m["kind"] in ("chat", "request", "out", "back", "join", "leave", "image")]
                self.reply(200, {"peers": peer_list(), "leader": state["leader"], "recent": recent,
                                 "now": time.time(), "version": VERSION})
            elif url.path == "/poll":
                since = int(q.get("since", ["0"])[0])
                msgs = [m for m in state["messages"] if m["id"] > since
                        and (m["to"] in ("all", self.name) or m["from"] == self.name)]
                self.reply(200, {"messages": msgs[-200:], "peers": peer_list(),
                                 "tasks": state["tasks"], "leader": state["leader"],
                                 "shared": sorted(state["shared"].keys()),
                                 "cursor": state["next_id"] - 1, "chatEpoch": state.get("chat_epoch", 0),
                                 "version": VERSION})
            elif url.path == "/shared":
                name = q.get("name", [""])[0]
                if name:
                    doc = state["shared"].get(name)
                    self.reply(200 if doc else 404, doc or {"error": "no such doc"})
                else:
                    self.reply(200, {"docs": [
                        {"name": k, "by": v["by"], "at": v["at"], "size": len(v["content"])}
                        for k, v in sorted(state["shared"].items())]})
            else:
                self.reply(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        # leaving (or stopping the relay) must not count as a check-in, or it would announce a re-join
        if not self.authed(presence=path not in ("/leave", "/shutdown")):
            return
        try:
            b = self.body(limit=MAX_FILE * 2 if path == "/files" else MAX_SHARED * 2)
        except (ValueError, json.JSONDecodeError) as err:
            return self.reply(400, {"error": str(err)})
        if path == "/shutdown":  # "Stop hosting" in /crew: only from this PC, with the key
            if self.client_address[0] not in ("127.0.0.1", "::1"):
                return self.reply(403, {"error": "only the host's own PC can stop the relay"})
            self.reply(200, {"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        with lock:
            if path == "/leave":  # a clean goodbye: everyone hears it at once
                p = peers.get(self.name)
                if p and not p.get("left"):
                    p["left"] = True
                    announce_leave(self.name, str(b.get("why") or "left the crew session")[:80])
                    save()
                return self.reply(200, {"ok": True})
            if path == "/reset":  # "Reset chat": wipe the chat for everyone (tasks and docs stay)
                state["messages"] = []
                state["chat_epoch"] = state.get("chat_epoch", 0) + 1
                post_message(self.name, "all", f"{self.name} cleared the crew chat", "update")
                save()
                return self.reply(200, {"ok": True, "chatEpoch": state["chat_epoch"]})
            if path == "/files":
                try:
                    data = base64.b64decode(str(b.get("data", "")), validate=True)
                except (binascii.Error, ValueError):
                    return self.reply(400, {"error": "data must be base64"})
                if not data or len(data) > MAX_FILE:
                    return self.reply(413, {"error": f"images must be 1 byte to {MAX_FILE // 1_000_000} MB"})
                name = str(b.get("name") or "image.png").replace("/", "_").replace("\\", "_")[:80]
                mime = str(b.get("mime") or "image/png")[:40]
                fid = secrets.token_hex(6)
                files[fid] = {"id": fid, "name": name, "mime": mime, "data": data, "by": self.name,
                              "at": int(time.time())}
                for old in list(files)[:-MAX_FILES]:
                    del files[old]
                caption = str(b.get("caption") or "").strip()[:500]
                msg = post_message(self.name, str(b.get("to") or "all")[:40],
                                   f"sent an image: {name}" + (f" ({caption})" if caption else ""), "image",
                                   file=fid, name=name, mime=mime, size=len(data), caption=caption)
                save()
                return self.reply(200, msg)
            if path == "/send":
                text = str(b.get("text", "")).strip()
                if not text:
                    return self.reply(400, {"error": "empty text"})
                kind = b.get("kind") if b.get("kind") in ("chat", "request", "update", "out", "back") else "chat"
                if kind == "out":  # "out of tokens" once per outage, not again on every reconnect
                    last = next((m for m in reversed(state["messages"])
                                 if m["from"] == self.name and m["kind"] in ("out", "back")), None)
                    if last and last["kind"] == "out" and time.time() - last["at"] < 6 * 3600:
                        return self.reply(200, last)
                extra = {"notify": True} if b.get("notify") else {}  # "for your human": shown to them, not just their Claude
                if b.get("human"):
                    extra["human"] = True  # typed by a person in /crew, not sent by their Claude
                msg = post_message(self.name, str(b.get("to") or "all")[:40], text, kind, **extra)
                save()
                return self.reply(200, msg)
            if path == "/tasks":
                return self.tasks(b)
            if path == "/leader":
                leader = str(b.get("name") or "").strip()[:40] or None
                if leader == state["leader"]:
                    return self.reply(200, {"leader": leader})  # no change, no log line
                state["leader"] = leader
                text = f"made {leader} the crew leader" if leader else "cleared the crew leader"
                last = state["messages"][-1] if state["messages"] else None
                if last and last.get("leaderChange") and time.time() - last["at"] < 60:
                    # back-to-back leader changes collapse into one line instead of a tug-of-war log
                    last.update(text=text, at=round(time.time(), 3), **{"from": self.name})
                else:
                    post_message(self.name, "all", text, "update", leaderChange=True)
                save()
                return self.reply(200, {"leader": leader})
            if path == "/shared":
                name = str(b.get("name", "")).strip()[:120]
                content = str(b.get("content", ""))
                if not name:
                    return self.reply(400, {"error": "missing name"})
                if len(content) > MAX_SHARED:
                    return self.reply(413, {"error": f"content over {MAX_SHARED} chars"})
                state["shared"][name] = {"name": name, "by": self.name,
                                         "at": int(time.time()), "content": content}
                post_message(self.name, "all", f"shared doc '{name}' ({len(content)} chars)", "update")
                save()
                return self.reply(200, {"ok": True, "name": name})
        self.reply(404, {"error": "not found"})

    def assign(self, t, assignee):
        t["assignee"] = assignee
        if assignee and assignee != self.name:  # assigning yourself needs no "you've got a task" request
            post_message(self.name, assignee,
                         f"Task #{t['id']} is assigned to you: {t['title']}"
                         + (f"\n\n{t['note']}" if t["note"] else "")
                         + "\n\nClaim it with crew_task, do it, then mark it done with a short note.",
                         "request")

    def tasks(self, b):
        action = b.get("action")
        tasks = state["tasks"]
        assignee = str(b.get("assignee") or "").strip()[:40] or None
        if action == "add":
            title = str(b.get("title", "")).strip()[:500]
            if not title:
                return self.reply(400, {"error": "missing title"})
            t = {"id": new_id(), "title": title, "note": str(b.get("note", ""))[:5000],
                 "status": "open", "owner": None, "assignee": None,
                 "by": self.name, "at": int(time.time())}
            tasks.append(t)
            post_message(self.name, "all", f"added task #{t['id']}: {title}", "update")
            self.assign(t, assignee)
            save()
            return self.reply(200, t)
        t = next((t for t in tasks if t["id"] == b.get("id")), None)
        if t is None:
            return self.reply(404, {"error": "no such task"})
        if action == "claim":
            if t["status"] == "claimed" and t["owner"] not in (None, self.name):
                return self.reply(409, {"error": f"already claimed by {t['owner']}"})
            t.update(owner=self.name, status="claimed")
        elif action == "done":
            t.update(status="done", owner=t["owner"] or self.name)
        elif action == "release":
            t.update(status="open", owner=None)
        elif action == "assign":
            if b.get("note"):
                t["note"] = str(b["note"])[:5000]
            self.assign(t, assignee)
        elif action == "remove":
            tasks.remove(t)
        elif action == "edit":  # fix a stale title or note without removing and re-adding the task
            if str(b.get("title") or "").strip():
                t["title"] = str(b["title"]).strip()[:500]
        else:
            return self.reply(400, {"error": "action must be add|claim|done|release|assign|edit|remove"})
        if b.get("note") and action != "assign":
            t["note"] = str(b["note"])[:5000]
        who = f" to {assignee}" if action == "assign" else ""
        post_message(self.name, "all", f"{action} task #{t['id']}{who}: {t['title']}", "update")
        save()
        self.reply(200, t)


def main():
    global args
    p = argparse.ArgumentParser(description="Crew relay for linked Claude Code sessions")
    p.add_argument("--key", help="shared secret every member puts in their settings")
    p.add_argument("--key-file", help="read the key from this file, creating it with a random key if missing")
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=7777)
    p.add_argument("--data", default="crew_state.json")
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args()
    if not args.key and args.key_file:
        try:
            with open(args.key_file, encoding="utf-8") as f:
                args.key = f.read().strip()
        except FileNotFoundError:
            pass
        if not args.key:
            args.key = secrets.token_urlsafe(18)
            with open(args.key_file, "w", encoding="utf-8") as f:
                f.write(args.key + "\n")
            print(f"Made a new crew key and saved it to {args.key_file}")
    if not args.key:
        p.error("give --key or --key-file")
    print(f"Crew key: {args.key}")
    load()
    threading.Thread(target=sweeper, daemon=True).start()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Crew relay {VERSION} listening on http://{args.host}:{args.port}  (Ctrl+C to stop)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
