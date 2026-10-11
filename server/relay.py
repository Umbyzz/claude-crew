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

VERSION = "0.7.6"
MAX_MESSAGES = 2000
MAX_TEXT = 50_000
MAX_SHARED = 200_000
MAX_FILE = 8_000_000  # bytes per shared image
MAX_FILES = 40  # images kept in memory, oldest dropped first
ONLINE_SECONDS = 10  # no poll for this long: they're gone (a clean exit says so straight away)
ACTIVITIES = ("idle", "thinking", "typing", "working", "chatting", "done", "cheer", "away", "out")
KINDS = ("chat", "request", "update", "out", "back", "join", "leave", "image")

lock = threading.Lock()
state = {"next_id": 1, "messages": [], "tasks": [], "shared": {}, "leader": None}
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
         "subagents": p["subagents"], "chatTo": p["chatTo"], "joinedAt": p["joinedAt"]}
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
        if not p.get("gone") and not p.get("left") and now - p["seen"] >= ONLINE_SECONDS:
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


def post_message(sender, to, text, kind, **extra):
    msg = {"id": new_id(), "from": sender, "to": to or "all", "kind": kind,
           "text": text[:MAX_TEXT], "at": int(time.time()), **extra}
    state["messages"].append(msg)
    del state["messages"][:-MAX_MESSAGES]
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
            if url.path == "/file":  # an image's raw bytes, for curl to save
                f = files.get(q.get("id", [""])[0])
                if not f:
                    return self.reply(404, {"error": "no such image (the relay keeps the latest few)"})
                return self.reply_bytes(f["data"], f["mime"])
            if url.path == "/watch":
                recent = [{"id": m["id"], "from": m["from"], "to": m["to"], "kind": m["kind"],
                           "text": m["text"][:80], "at": m["at"]}
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
                                 "cursor": state["next_id"] - 1, "version": VERSION})
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
        # leaving must not count as a check-in, or it would announce a re-join
        if not self.authed(presence=path != "/leave"):
            return
        try:
            b = self.body(limit=MAX_FILE * 2 if path == "/files" else MAX_SHARED * 2)
        except (ValueError, json.JSONDecodeError) as err:
            return self.reply(400, {"error": str(err)})
        with lock:
            if path == "/leave":  # a clean goodbye: everyone hears it at once
                p = peers.get(self.name)
                if p and not p.get("left"):
                    p["left"] = True
                    announce_leave(self.name, str(b.get("why") or "left the crew session")[:80])
                    save()
                return self.reply(200, {"ok": True})
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
                msg = post_message(self.name, str(b.get("to") or "all")[:40], text, kind)
                save()
                return self.reply(200, msg)
            if path == "/tasks":
                return self.tasks(b)
            if path == "/leader":
                leader = str(b.get("name") or "").strip()[:40] or None
                state["leader"] = leader
                post_message(self.name, "all",
                             f"made {leader} the crew leader" if leader else "cleared the crew leader",
                             "update")
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
        if assignee:
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
        else:
            return self.reply(400, {"error": "action must be add|claim|done|release|assign|remove"})
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
