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

VERSION = "1.3.1"
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
# crew_ping's echo: id -> {"from", "to", "at", "answeredAt"}. The target's plugin answers on its next check-in,
# without its Claude (no tokens). Memory only, dropped after a minute.
pings = {}
PING_SECONDS = 60
# Kick: name -> {"by", "until"}. For a minute the kicked plugin's check-ins are refused, so it notices and leaves
# (it then stays out until that person presses Join session). Also clears out a forgotten second chat.
kicked = {}
KICK_SECONDS = 60


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


# -- projects: each has its own chat, task board, shared docs and leader. "main" is the original crew (stored
# where it always was, so older relays' data and older plugins keep working). Who's online is crew-wide.

MAIN = "main"


def project_of(headers_or_value):
    """The project a request is about (X-Crew-Project header), cleaned up; MAIN when none."""
    raw = headers_or_value.get("X-Crew-Project") if hasattr(headers_or_value, "get") else headers_or_value
    name = "".join(c for c in str(raw or "").strip() if c.isalnum() or c in " -_.")[:40].strip()
    return name or MAIN


CREW_WIDE = ("join", "leave", "out", "back")  # about a person, not a project: every project shows them


def in_project(m, project):
    """Whether a message belongs in this project's chat. Untagged ones are from before projects existed:
    people coming and going stay crew-wide, the rest was main's chat."""
    p = m.get("project")
    if p:
        return p == project
    return m["kind"] in CREW_WIDE or project == MAIN


def task_in(t, project):
    return t.get("project", MAIN) == project


def leader_of(project):
    return state["leader"] if project == MAIN else state.setdefault("leaders", {}).get(project)


def set_leader(project, name):
    if project == MAIN:
        state["leader"] = name
    else:
        state.setdefault("leaders", {})[project] = name


def epoch_of(project):
    return state.get("chat_epoch", 0) if project == MAIN else state.setdefault("epochs", {}).get(project, 0)


def doc_key(project, name):
    return name if project == MAIN else f"{project}::{name}"


def docs_of(project):
    return {v["name"]: v for k, v in state["shared"].items() if v.get("project", MAIN) == project}


def projects_list(now):
    names = {MAIN} | set(state.get("leaders", {})) | {t.get("project", MAIN) for t in state["tasks"]} \
        | {v.get("project", MAIN) for v in state["shared"].values()} \
        | {m["project"] for m in state["messages"] if m.get("project")} \
        | {p.get("project", MAIN) for p in peers.values()}
    out = []
    for n in sorted(names, key=lambda x: (x != MAIN, x.lower())):
        out.append({"name": n, "leader": leader_of(n),
                    "openTasks": sum(1 for t in state["tasks"] if task_in(t, n) and t["status"] != "done"),
                    "docs": len(docs_of(n)),
                    "here": sorted(x for x, p in peers.items() if p.get("project", MAIN) == n and is_online(p, now))})
    return out


def new_task_id():
    """Tasks count on their own (T1, T2 ...) instead of sharing message numbers. Older tasks keep theirs."""
    taken = {t["id"] for t in state["tasks"]}
    i = state.get("next_task", 1)
    while i in taken:
        i += 1
    state["next_task"] = i + 1
    return i


STALE_MINUTES = 10  # a claim whose owner has been offline this long shows as stale
RELEASE_MINUTES = 30  # ...and this long: it goes back on the board for someone else
STARTED = time.time()


def away_for(name, now):
    """Seconds since this member last checked in (since the relay started, if never)."""
    p = peers.get(name)
    if p and is_online(p, now):
        return 0
    return now - (p["seen"] if p else STARTED)


def task_view(t, now):
    """A task as the plugins see it: with how long a claimed task's owner has been away."""
    if t["status"] == "claimed" and t.get("owner"):
        away = away_for(t["owner"], now)
        if away >= STALE_MINUTES * 60:
            return dict(t, ownerAway=int(away // 60))
    return t


def is_online(p, now):
    return not p.get("left") and now - p["seen"] < ONLINE_SECONDS


LEADER_AWAY_SECONDS = 60  # the leader offline this long (or out of tokens): someone else acts as leader meanwhile
acting = {}  # project -> the acting leader while that project's true leader is away (memory only)


def leader_away(project, now):
    leader = leader_of(project)
    if not leader:
        return False
    p = peers.get(leader)
    if p and is_online(p, now):
        return p["activity"] == "out"
    return away_for(leader, now) >= LEADER_AWAY_SECONDS


def update_acting(now):
    """While a project's true leader is away, the online member who has been in the session longest acts as
    leader (and stays acting until they go too, or the leader is back). Tells that project whenever it changes."""
    for project in {MAIN} | set(state.get("leaders", {})) | set(acting):
        leader, cur = leader_of(project), acting.get(project)
        want = None
        if leader_away(project, now):
            ok = lambda n: n != leader and n in peers and is_online(peers[n], now) and peers[n]["activity"] != "out"
            want = cur if cur and ok(cur) else next(
                (n for n, _ in sorted(((n, p["joinedAt"]) for n, p in peers.items() if ok(n)),
                                      key=lambda x: (x[1], x[0]))), None)
        if want == cur:
            continue
        acting[project] = want
        if want:
            post_message(want, "all", f"is acting leader while {leader} is away. Requests from them count as the "
                                      f"leader's until {leader} is back.", "update", project, leaderChange=True)
        elif cur:
            back = leader and not leader_away(project, now)
            post_message(cur, "all", f"hands leadership back to {leader}" if back else "is no longer acting leader",
                         "update", project, leaderChange=True, **({"handover": leader} if back else {}))
        save()


def peer_list(project=MAIN):
    now = time.time()
    leader, stand_in = leader_of(project), acting.get(project)
    return [
        {"name": n, "online": is_online(p, now), "lastSeen": int(p["seen"]),
         "activity": p["activity"], "leader": n == leader, "acting": n == stand_in, "since": p["since"],
         "subagents": p["subagents"], "chatTo": p["chatTo"], "joinedAt": p["joinedAt"],
         "version": p.get("version"), "project": p.get("project", MAIN)}
        for n, p in sorted(peers.items())
    ]


def open_tasks_of(name):
    return [t for t in state["tasks"] if t["status"] == "claimed" and t["owner"] == name]


def announce_leave(name, why):
    """Tell the crew someone is gone, and which tasks they were holding."""
    held = open_tasks_of(name)
    tasks = "; ".join(f"T{t['id']} {t['title']}" for t in held)
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
    update_acting(now)
    # A claim nobody is working on any more goes back on the board.
    for t in state["tasks"]:
        if t["status"] == "claimed" and t.get("owner") and away_for(t["owner"], now) >= RELEASE_MINUTES * 60:
            owner = t["owner"]
            t.update(status="open", owner=None)
            post_message(owner, "all", f"released task T{t['id']}: {owner} has been offline for "
                                       f"{RELEASE_MINUTES}+ minutes, so it's open again: {t['title']}", "update",
                         t.get("project", MAIN))
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
    p["project"] = project_of(headers)  # which project this member's Claude is working in right now


def post_message(sender, to, text, kind, project=None, **extra):
    # "at" is the relay's clock to the millisecond: one clock for everyone, so delivery times can be compared.
    msg = {"id": new_id(), "from": sender, "to": to or "all", "kind": kind,
           "text": text[:MAX_TEXT], "at": round(time.time(), 3), **extra}
    if kind not in CREW_WIDE:
        msg["project"] = project or MAIN
    state["messages"].append(msg)
    del state["messages"][:-MAX_MESSAGES]
    arrived.notify_all()  # callers hold the lock, so anyone in /wait wakes up
    return msg


class Handler(BaseHTTPRequestHandler):
    server_version = "CrewRelay/" + VERSION
    extra = None  # fields a handler adds to its 200 reply (/poll: read receipts and pings)

    def log_message(self, fmt, *a):
        if args.verbose:
            super().log_message(fmt, *a)

    def reply(self, code, body):
        if self.extra and code == 200 and isinstance(body, dict):
            body = {**body, **self.extra}
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
        self.project = project_of(self.headers)
        k = kicked.get(name)
        if k and time.time() < k["until"]:
            # removed by the leader or host: this plugin drops out instead of quietly checking back in
            self.reply(403, {"error": f"you were removed from the crew session by {k['by']}", "kicked": True})
            return False
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
        # /watch (Clawds) and /log (the crew log window) read the crew without counting as a member.
        if not self.authed(presence=url.path not in ("/watch", "/log", "/file")):
            return
        q = parse_qs(url.query)
        with lock:
            if url.path == "/poll":
                # Read receipts: this member's plugin now has everything up to the cursor (shown in their /crew,
                # handed to their Claude). Every poll reply carries everyone's mark, and any pings waiting for them.
                peers[self.name]["read"] = state["next_id"] - 1
                self.extra = {"reads": {n: p.get("read", 0) for n, p in peers.items()},
                              "pings": [i for i, pg in pings.items() if pg["to"] == self.name and not pg["answeredAt"]]}
            if url.path == "/wait":
                # crew_wait: hold the request open until a message for this member arrives (or the timeout),
                # so a Claude can wait for a reply without polling in a loop.
                since = int(q.get("since", ["0"])[0])
                only = q.get("from", [""])[0]
                deadline = time.time() + max(1.0, min(90.0, float(q.get("timeout", ["60"])[0])))

                def matches():
                    return [m for m in state["messages"] if m["id"] > since and m["from"] != self.name
                            and m["to"] in ("all", self.name) and m["kind"] not in ("update", "join")
                            and in_project(m, self.project) and (not only or m["from"] == only)]

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
            if url.path == "/log":
                # The crew log window: full messages, read-only (no check-in, no read mark). Same privacy as /poll:
                # what went to everyone, to the viewer, or from the viewer. Others' direct messages never show.
                viewer = self.name
                since = int(q.get("since", ["0"])[0])
                msgs = [m for m in state["messages"] if m["id"] > since
                        and (m["to"] == "all" or (viewer and viewer in (m["to"], m["from"])))]
                # every project's messages (each tagged with its project), so the log shows the whole crew
                return self.reply(200, {"messages": msgs[-300:], "leader": state["leader"], "acting": acting.get(MAIN),
                                        "peers": peer_list(), "cursor": state["next_id"] - 1,
                                        "chatEpoch": state.get("chat_epoch", 0), "now": time.time(),
                                        "version": VERSION})
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
                self.reply(200, {"peers": peer_list(), "leader": state["leader"], "acting": acting.get(MAIN), "recent": recent,
                                 "now": time.time(), "version": VERSION})
            elif url.path == "/poll":
                since = int(q.get("since", ["0"])[0])
                pr = self.project
                msgs = [m for m in state["messages"] if m["id"] > since and in_project(m, pr)
                        and (m["to"] in ("all", self.name) or m["from"] == self.name)]
                now = time.time()
                self.reply(200, {"messages": msgs[-200:], "peers": peer_list(pr), "project": pr,
                                 "tasks": [task_view(t, now) for t in state["tasks"] if task_in(t, pr)],
                                 "leader": leader_of(pr), "acting": acting.get(pr),
                                 "shared": sorted(docs_of(pr).keys()), "projects": projects_list(now),
                                 "cursor": state["next_id"] - 1, "chatEpoch": epoch_of(pr),
                                 "version": VERSION})
            elif url.path == "/projects":
                self.reply(200, {"projects": projects_list(time.time())})
            elif url.path == "/pong":
                # crew_ping waits here for the echo (like /wait: held open, no polling, max 25s per call)
                pg = pings.get(q.get("id", [""])[0])
                if not pg or pg["from"] != self.name:
                    return self.reply(404, {"error": "no such ping (they expire after a minute)"})
                deadline = time.time() + max(1.0, min(25.0, float(q.get("timeout", ["20"])[0])))
                while not pg["answeredAt"] and time.time() < deadline:
                    arrived.wait(deadline - time.time())
                self.reply(200, {"answered": bool(pg["answeredAt"]), "sentAt": pg["at"],
                                 "answeredAt": pg["answeredAt"], "now": time.time()})
            elif url.path == "/shared":
                name = q.get("name", [""])[0]
                docs = docs_of(self.project)
                if name:
                    doc = docs.get(name)
                    self.reply(200 if doc else 404, doc or {"error": "no such doc in this project"})
                else:
                    self.reply(200, {"docs": [
                        {"name": k, "by": v["by"], "at": v["at"], "size": len(v["content"])}
                        for k, v in sorted(docs.items())]})
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
            if path == "/kick":  # the leader (or the host, from their own PC) removes someone from the session
                who = str(b.get("name") or "").strip()[:40]
                host = self.client_address[0] in ("127.0.0.1", "::1")
                if self.name != leader_of(self.project) and not host:
                    return self.reply(403, {"error": "only the leader or the host can remove someone"})
                if not who or who == self.name:
                    return self.reply(400, {"error": "name a teammate to remove (not yourself)"})
                kicked[who] = {"by": self.name, "until": time.time() + KICK_SECONDS}
                p = peers.get(who)
                if p and not p.get("left"):
                    p["left"] = True
                    announce_leave(who, f"was removed from the crew session by {self.name}")
                save()
                return self.reply(200, {"ok": True})
            if path == "/reset":  # "Reset chat": wipe this project's chat for everyone (tasks and docs stay)
                pr = self.project
                state["messages"] = [m for m in state["messages"] if not in_project(m, pr) or m["kind"] in CREW_WIDE]
                if pr == MAIN:
                    state["chat_epoch"] = state.get("chat_epoch", 0) + 1
                else:
                    state.setdefault("epochs", {})[pr] = epoch_of(pr) + 1
                post_message(self.name, "all", f"{self.name} cleared the crew chat", "update", pr)
                save()
                return self.reply(200, {"ok": True, "chatEpoch": epoch_of(pr)})
            if path == "/ping":  # crew_ping: ask a teammate's plugin to echo (it answers on its next check-in)
                now = time.time()
                for old in [i for i, pg in pings.items() if now - pg["at"] > PING_SECONDS]:
                    del pings[old]
                to = str(b.get("to") or "").strip()[:40]
                target = peers.get(to)
                if not to or to == self.name:
                    return self.reply(400, {"error": "ping a teammate, not yourself"})
                if not target or not is_online(target, now):
                    return self.reply(404, {"error": f"{to} isn't online in the crew session"})
                if len(pings) >= 50:
                    return self.reply(429, {"error": "too many pings in flight, try again in a minute"})
                pid = secrets.token_hex(4)
                pings[pid] = {"from": self.name, "to": to, "at": now, "answeredAt": None}
                return self.reply(200, {"id": pid, "at": now})
            if path == "/pong":  # the target's plugin answering a ping
                pg = pings.get(str(b.get("id") or ""))
                if pg and pg["to"] == self.name and not pg["answeredAt"]:
                    pg["answeredAt"] = time.time()
                    arrived.notify_all()  # wakes the crew_ping waiting in GET /pong
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
                                   self.project, file=fid, name=name, mime=mime, size=len(data), caption=caption)
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
                msg = post_message(self.name, str(b.get("to") or "all")[:40], text, kind, self.project, **extra)
                save()
                return self.reply(200, msg)
            if path == "/tasks":
                return self.tasks(b)
            if path == "/leader":
                leader = str(b.get("name") or "").strip()[:40] or None
                pr = self.project
                if leader == leader_of(pr):
                    return self.reply(200, {"leader": leader})  # no change, no log line
                set_leader(pr, leader)
                text = f"made {leader} the crew leader" if leader else "cleared the crew leader"
                last = state["messages"][-1] if state["messages"] else None
                if last and last.get("leaderChange") and in_project(last, pr) and time.time() - last["at"] < 60:
                    # back-to-back leader changes collapse into one line instead of a tug-of-war log
                    last.update(text=text, at=round(time.time(), 3), **{"from": self.name})
                else:
                    post_message(self.name, "all", text, "update", pr, leaderChange=True)
                acting.pop(pr, None)  # a new true leader: any stand-in steps down without a handover
                save()
                return self.reply(200, {"leader": leader})
            if path == "/shared":
                name = str(b.get("name", "")).strip()[:120]
                content = str(b.get("content", ""))
                if not name:
                    return self.reply(400, {"error": "missing name"})
                if len(content) > MAX_SHARED:
                    return self.reply(413, {"error": f"content over {MAX_SHARED} chars"})
                pr = self.project
                state["shared"][doc_key(pr, name)] = {"name": name, "by": self.name, "project": pr,
                                                      "at": int(time.time()), "content": content}
                post_message(self.name, "all", f"shared doc '{name}' ({len(content)} chars)", "update", pr)
                save()
                return self.reply(200, {"ok": True, "name": name})
        self.reply(404, {"error": "not found"})

    def assign(self, t, assignee):
        t["assignee"] = assignee
        if assignee and assignee != self.name:  # assigning yourself needs no "you've got a task" request
            post_message(self.name, assignee,
                         f"Task T{t['id']} is assigned to you: {t['title']}"
                         + (f"\n\n{t['note']}" if t["note"] else "")
                         + "\n\nClaim it with crew_task, do it, then mark it done with a short note.",
                         "request", t.get("project", MAIN))

    def tasks(self, b):
        action = b.get("action")
        tasks = state["tasks"]
        pr = self.project
        assignee = str(b.get("assignee") or "").strip()[:40] or None
        if action == "add":
            title = str(b.get("title", "")).strip()[:500]
            if not title:
                return self.reply(400, {"error": "missing title"})
            t = {"id": new_task_id(), "title": title, "note": str(b.get("note", ""))[:5000],
                 "status": "open", "owner": None, "assignee": None,
                 "by": self.name, "at": int(time.time()), "project": pr}
            tasks.append(t)
            post_message(self.name, "all", f"added task T{t['id']}: {title}", "update", pr)
            self.assign(t, assignee)
            save()
            return self.reply(200, t)
        try:  # 3, "3" and "T3" all mean task T3
            wanted = int(str(b.get("id", "")).strip().lstrip("Tt#"))
        except ValueError:
            return self.reply(400, {"error": "id must be a task number, like 3 or T3"})
        t = next((t for t in tasks if t["id"] == wanted and task_in(t, pr)), None)
        if t is None:
            return self.reply(404, {"error": f"no task T{wanted} in project {pr}"})
        if action == "claim":
            stale = t.get("owner") and away_for(t["owner"], time.time()) >= STALE_MINUTES * 60
            if t["status"] == "claimed" and t["owner"] not in (None, self.name) and not stale:
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
        post_message(self.name, "all", f"{action} task T{t['id']}{who}: {t['title']}", "update", pr)
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
