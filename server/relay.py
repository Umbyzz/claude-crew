"""Crew relay: the tiny hub that links several Claude Code sessions.

One person runs this; everyone else's `crew` mod polls it over HTTP.
Stdlib only (Python 3.8+). Reach it over a VPN (Tailscale, Radmin VPN, ZeroTier)
or your LAN -- do not expose it to the open internet.

    python relay.py --key <shared-secret> [--port 7777] [--data crew_state.json]
"""
import argparse
import hmac
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

VERSION = "0.3.0"
MAX_MESSAGES = 2000
MAX_TEXT = 50_000
MAX_SHARED = 200_000
ONLINE_SECONDS = 20
ACTIVITIES = ("idle", "working", "away")

lock = threading.Lock()
state = {"next_id": 1, "messages": [], "tasks": [], "shared": {}, "leader": None}
peers = {}  # name -> {"seen": epoch seconds, "activity": str}, memory only
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


def peer_list():
    now = time.time()
    return [
        {"name": n, "online": now - p["seen"] < ONLINE_SECONDS, "lastSeen": int(p["seen"]),
         "activity": p["activity"], "leader": n == state["leader"]}
        for n, p in sorted(peers.items())
    ]


def post_message(sender, to, text, kind):
    msg = {"id": new_id(), "from": sender, "to": to or "all", "kind": kind,
           "text": text[:MAX_TEXT], "at": int(time.time())}
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

    def authed(self):
        if not hmac.compare_digest(self.headers.get("X-Crew-Key") or "", args.key):
            self.reply(401, {"error": "bad or missing crew key"})
            return False
        name = (self.headers.get("X-Crew-Name") or "").strip()[:40]
        if not name:
            self.reply(400, {"error": "missing X-Crew-Name"})
            return False
        activity = self.headers.get("X-Crew-Activity")
        self.name = name
        with lock:
            p = peers.setdefault(name, {"seen": 0, "activity": "idle"})
            p["seen"] = time.time()
            if activity in ACTIVITIES:
                p["activity"] = activity
        return True

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_SHARED * 2:
            raise ValueError("body too large")
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/health":
            return self.reply(200, {"ok": True, "version": VERSION})
        if not self.authed():
            return
        q = parse_qs(url.query)
        with lock:
            if url.path == "/poll":
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
        if not self.authed():
            return
        try:
            b = self.body()
        except (ValueError, json.JSONDecodeError) as err:
            return self.reply(400, {"error": str(err)})
        path = urlparse(self.path).path
        with lock:
            if path == "/send":
                text = str(b.get("text", "")).strip()
                if not text:
                    return self.reply(400, {"error": "empty text"})
                kind = b.get("kind") if b.get("kind") in ("chat", "request", "update") else "chat"
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
    p.add_argument("--key", required=True, help="shared secret every member puts in their settings")
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=7777)
    p.add_argument("--data", default="crew_state.json")
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args()
    load()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Crew relay {VERSION} listening on http://{args.host}:{args.port}  (Ctrl+C to stop)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
