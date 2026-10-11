"""Clawds: a little always-on-top window where your crew hangs out as pixel Clawds.

Each Clawd is one crew member and acts out what their Claude is doing right now:
thinking, typing, tinkering with tools, chatting, cheering at a new prompt, dancing
when done, snoozing when out of tokens (while the others worry), greeting newcomers
with a group hug, and herding mini Clawds for every subagent. When nothing is going
on they vibe, stroll, hop, wave, dance, high-five and chase each other.

It only reads the crew relay (GET /watch) -- it never talks to Claude, so it costs no
tokens. Settings come from the crew plugin's config in ~/.claude/settings.json.

    pythonw clawd_window.py            # normal
    python clawd_window.py --demo      # fake crew, no relay needed
    python clawd_window.py --relay http://26.1.2.3:7777 --key KEY
"""
import argparse
import hashlib
import json
import math
import os
import random
import socket
import sys
import threading
import time
import tkinter as tk
import urllib.request

FPS = 15
CLOCK_OFFSET = 0.0  # the relay's clock minus ours: every window animates on the same shared clock


def clock():
    """Now, on the relay's clock: the same instant in every crew member's window."""
    return time.time() + CLOCK_OFFSET


def seed(*parts):
    """A number made from shared facts (names, relay timestamps): identical in every window."""
    return int(hashlib.md5("|".join(str(p) for p in parts).encode()).hexdigest()[:12], 16)


def roll(*parts):
    """A dice roll from 0 to 1 that every window rolls the same way for the same facts."""
    return seed(*parts) / float(16 ** 12)


ONE_WINDOW_PORT = 47817  # a localhost port the open window holds, so a second launch can find it
def desktop_bounds(sw, sh):
    """(left, top, width, height) of all monitors together on Windows; elsewhere just the main screen."""
    if sys.platform == "win32":
        try:
            import ctypes
            m = ctypes.windll.user32.GetSystemMetrics
            w, h = m(78), m(79)  # SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN
            if w and h:
                return m(76), m(77), w, h  # SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN
        except Exception:  # noqa: BLE001
            pass
    return 0, 0, sw, sh


_held = []  # keeps the single-instance mutex alive for as long as the window runs


def one_instance(name):
    """True if no other copy of this window is running. On Windows a named mutex decides, which (unlike a port)
    can't be won by two launches at the same moment; elsewhere the port check alone does."""
    if sys.platform != "win32":
        return True
    try:
        import ctypes
        k32 = ctypes.windll.kernel32
        handle = k32.CreateMutexW(None, False, f"Local\\{name}")
        if k32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
            return False
        _held.append(handle)
    except Exception:  # noqa: BLE001 - no mutex available: fall back on the port
        pass
    return True


MAX_CLAWDS = 10  # Clawds on stage at once (a bigger crew: the offline ones step aside first)
CLOSE_AFTER = 60  # seconds after your own Claude leaves (or the relay goes away) before the window closes


def friendly(err):
    """The relay's error, in words instead of a Python traceback line."""
    e = err.lower()
    if "10061" in e or "refused" in e or "no connection could be made" in e:
        return "relay offline, waiting for it to come back"
    if "timed out" in e or "10060" in e:
        return "relay not answering"
    if "401" in e:
        return "wrong crew key (check /crew Settings)"
    if "getaddrinfo" in e or "11001" in e:
        return "can't find the relay's address"
    return err
DRAMA = 0.2  # the chance that anything a Clawd does is the WAY over-the-top version
TRIPS = ("car", "teleport", "superman", "door", "bird")  # ways to arrive and leave
FORCE_TRIP = None  # --trip picks one, for trying them out
DEMO_LEAVE = 44  # --leave-at: when the demo's nova disconnects
POLL_SECONDS = 1.5
KEY_COLOR = "#0c0c0d"  # painted transparent on Windows
ORANGE = "#D97757"
ORANGE_DARK = "#B85F42"
GREY = "#8A8580"
EYE = "#141413"
INK = "#f0eee6"
DIM = "#9c9a92"
PANEL = "#262624"
PANEL_EDGE = "#3d3d3a"
CONFETTI = ["#D97757", "#E3B23C", "#6A9BCC", "#788C5D", "#C46686", "#f0eee6"]
CODE = list("{}<>/;=()[]01#$")
PREFS = os.path.join(os.path.expanduser("~"), ".claude", "crew-clawds.json")
SETTINGS = os.path.join(os.path.expanduser("~"), ".claude", "settings.json")
SIZES = {"small": 4, "medium": 5, "large": 7}
STATUS_WORDS = {
    "idle": "", "thinking": "thinking…", "typing": "typing", "working": "tinkering",
    "chatting": "chatting", "done": "done!", "cheer": "new prompt!", "out": "out of tokens",
    "away": "away",
}


# ---------------------------------------------------------------- config & data


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def crew_config():
    """The crew plugin's relayUrl / name / key, from whichever install has them."""
    configs = load_json(SETTINGS, {}).get("pluginConfigs", {})
    best = {}
    for plugin, conf in configs.items():
        if plugin.split("@")[0] != "crew":
            continue
        opts = conf.get("options", {})
        if len([k for k in ("relayUrl", "name", "key") if opts.get(k)]) > len(best):
            best = {k: opts.get(k, "") for k in ("relayUrl", "name", "key")}
    return best


class Feed:
    """Polls the relay in the background; the UI reads .snapshot."""

    def __init__(self, relay, key, name, demo, reread=None):
        self.relay, self.key, self.name, self.demo = (relay or "").rstrip("/"), key, name, demo
        self.reread = reread  # returns (relay, key, name) from the plugin's settings, or None when given on the command line
        self.snapshot = None
        self.error = ""
        self.lock = threading.Lock()
        self.fake = DemoCrew()
        threading.Thread(target=self.loop, daemon=True).start()

    def follow_settings(self):
        """Pick up /crew settings saved after the window opened: the demo crew makes way for the real one."""
        relay, key, name = self.reread()
        relay = (relay or "").rstrip("/")
        if (relay, key, name) != (self.relay, self.key, self.name):
            with self.lock:
                self.relay, self.key, self.name = relay, key, name
                self.demo = not (relay and key)
                self.snapshot, self.error = None, ""

    def loop(self):
        last_read = time.time()
        while True:
            if self.reread and time.time() - last_read > 5:
                last_read = time.time()
                try:
                    self.follow_settings()
                except Exception:  # noqa: BLE001 - a half-written settings file: try again next time
                    pass
            try:
                data = self.fake.tick() if self.demo else self.fetch()
                with self.lock:
                    self.snapshot, self.error = data, ""
            except Exception as err:  # noqa: BLE001 - any failure just shows as offline
                with self.lock:
                    self.error = str(err)[:80]
            time.sleep(POLL_SECONDS)

    def fetch(self):
        if not (self.relay and self.key):
            raise RuntimeError("set up the crew plugin first (/crew -> Settings)")
        req = urllib.request.Request(self.relay + "/watch",
                                     headers={"X-Crew-Key": self.key, "X-Crew-Name": self.name or ""})
        sent = time.time()
        with urllib.request.urlopen(req, timeout=4) as res:
            data = json.loads(res.read().decode("utf-8"))
        # Learn the relay's clock (allowing for the round trip), so every window shares one "now".
        global CLOCK_OFFSET
        if "now" in data:
            got = time.time()
            measured = data["now"] - (sent + got) / 2
            jump = abs(measured - CLOCK_OFFSET) > 1.0
            CLOCK_OFFSET = measured if jump else CLOCK_OFFSET * 0.8 + measured * 0.2
        return data

    def read(self):
        with self.lock:
            return self.snapshot, self.error


class DemoCrew:
    """A pretend crew so the window is alive without a relay (and for screenshots)."""

    def __init__(self):
        self.t0 = time.time()
        self.names = ["umbyz", "pluh", "nova"]
        self.next_id = 1
        self.recent = []
        self.script = [  # (seconds, name, activity, subagents, chatTo)
            (0, "umbyz", "idle", 0, None), (6, "umbyz", "cheer", 0, None), (9, "umbyz", "thinking", 0, None),
            (14, "umbyz", "typing", 0, None), (22, "umbyz", "working", 2, None), (30, "umbyz", "done", 0, None),
            (40, "umbyz", "idle", 0, None),
            (0, "pluh", "thinking", 0, None), (8, "pluh", "chatting", 0, "umbyz"), (14, "pluh", "typing", 1, None),
            (24, "pluh", "out", 0, None), (44, "pluh", "idle", 0, None),
            (0, "nova", "idle", 0, None), (18, "nova", "thinking", 0, None), (26, "nova", "chatting", 0, "pluh"),
            (32, "nova", "idle", 0, None),
        ]

    def tick(self):
        t = (time.time() - self.t0) % 50
        now = time.time()
        loop = int((now - self.t0) / 50)
        if t >= 6 and getattr(self, "briefed", -1) != loop:  # each loop opens with a team meeting
            self.briefed = loop
            self.recent.append({"id": self.next_id, "from": "umbyz", "to": "all", "kind": "request", "at": now,
                                "text": "split it: UI, API, tests"})
            self.next_id += 1
        peers = []
        for n in self.names:
            if n == "nova" and t < 5:
                continue  # nova "joins" a few seconds in, so the group hug shows
            row = [s for s in self.script if s[1] == n and s[0] <= t][-1]
            peers.append({"name": n, "online": n != "nova" or t < DEMO_LEAVE, "activity": row[2], "subagents": row[3], "chatTo": row[4],
                          "leader": n == "umbyz", "since": now - (t - row[0]),
                          "joinedAt": self.t0 if n != "nova" else now - (t - 5)})
            if row[2] == "chatting" and not any(m["from"] == n and now - m["at"] < 6 for m in self.recent):
                self.recent.append({"id": self.next_id, "from": n, "to": row[4], "kind": "chat", "at": now,
                                    "text": random.choice(["can you take the tests?", "pushed the fix!",
                                                           "nice one", "I'll do the UI part"])})
                self.next_id += 1
        return {"peers": peers, "leader": "umbyz", "recent": self.recent[-10:], "now": now, "version": "demo"}


# ---------------------------------------------------------------- the Clawds


class Clawd:
    def __init__(self, name, x, mini=False):
        self.name = name
        self.x = x  # centre, in cells
        self.facing = 1
        self.jump = 0.0
        self.bob = 0.0
        self.vy = 0.0
        self.squash = 0
        self.legs = 0
        self.stride = 0.0
        self.mood = "idle"
        self.since = 0.0
        self.activity = "idle"
        self.online = True
        self.leader = False
        self.subagents = 0
        self.chat_to = None
        self.behavior = "vibe"
        self.until = clock() + random.uniform(1, 4)
        self.target = x
        self.partner = None
        self.bubble = None  # (text, until)
        self.blink_at = clock() + random.uniform(2, 6)
        self.look = 0
        self.arm = [0, 0]  # how far each arm is raised (cells)
        self.sit = 0
        self.mini = mini
        self.minis = []
        self.worried = False
        self.poke_until = 0.0
        self.dramatic = False  # 1 in 5 of everything gets the WAY over-the-top version
        self.bubble_lift = 0
        self.think_pose = "thonk"  # dramatic thinking: the 🤔 "thonk" or the smug "tea" sip
        # mini Clawds (subagents): what they stand on, where a leap lands, the tower they build
        self.floor = 0.0
        self.landing = 0.0
        self.wobble = 0.0
        self.tower_until = 0.0
        self.tower_start = 0.0
        self.tower_x = x
        self.at_desk = False  # a mini working at the mini office
        # arriving and leaving: the trip under way, and whether they're off-stage
        self.trip = None
        self.gone = False
        self.hidden = False
        # shared facts from the relay, so every window makes the same choices for this Clawd
        self.since = 0.0  # when its current activity started
        self.joined_at = 0.0
        self.last_seen = 0.0
        self.slot = None  # the shared 5-second beat its idle move was picked on
        self.tower_slot = None  # the shared beat its minis last considered a tower on
        self.phase = roll(name, "phase") * 5.0  # its beats are offset, so the crew doesn't move in lockstep

    def say(self, text, seconds=3.0):
        self.bubble = (text, clock() + seconds)

    def hop(self, power=2.4):
        if self.jump <= 0.01:
            self.vy = power

    def walk_to(self, x, speed=0.35):
        d = x - self.x
        if abs(d) < speed:
            self.x = x
            return True
        self.facing = 1 if d > 0 else -1
        self.x += speed * self.facing
        # the step follows the distance covered, so slow walks step slowly and runs patter
        self.stride += speed
        self.legs = 1 + int(self.stride / 1.6) % 2
        return False


class World:
    def __init__(self, cols, ground):
        self.cols = cols
        self.ground = ground
        self.clawds = {}
        self.particles = []
        self.seen_ids = set()
        self.seen_join = {}
        self.started = clock()
        self.first = True
        self.funeral = None  # {"name", "x", "start"} while a dramatic out-of-tokens is being mourned
        self.meeting = None  # {"host", "start", "until", "text", "board", "stand", "seats"} during a whiteboard meetup
        self.flash = 0  # frames of lightning left
        self.desk = None  # the subagents' mini office: {"x", "width", "seats", "by"}
        self.huddle = None  # "Claude's plan!!": {"start", "until", "x", "dramatic", "spots"}

    # -- syncing with the crew

    def sync(self, snap, me):
        peers = snap.get("peers", []) if snap else []
        if not peers:
            peers = [{"name": n, "online": True, "activity": "idle", "subagents": 0} for n in ("", " ", "  ")]
        # the same order in every window: whoever's online first, then by name; room on stage for ten
        peers = sorted(peers, key=lambda p: (not p.get("online", True), p["name"]))[:MAX_CLAWDS]
        names = [p["name"] for p in peers]
        for gone in [n for n in self.clawds if n not in names]:
            c = self.clawds[gone]
            if c.gone:
                del self.clawds[gone]
            elif not (c.trip and not c.trip["enter"]):
                self.travel(c, enter=False)
        slots = len(peers)
        for i, p in enumerate(peers):
            c = self.clawds.get(p["name"])
            online = p.get("online", True)
            fresh = c is None
            if fresh:
                home = (i + 0.5) * self.cols / slots
                c = self.clawds[p["name"]] = Clawd(p["name"], home)
            # the relay's timestamps come first: the trips below roll their dice on them
            c.since = p.get("since") or c.since
            c.joined_at = p.get("joinedAt") or c.joined_at
            c.last_seen = p.get("lastSeen") or c.last_seen
            if fresh:
                if self.first or not online:
                    c.gone = not online
                else:
                    self.travel(c, enter=True)  # a newcomer makes an entrance
            elif not self.first:
                leaving = c.trip and not c.trip["enter"]
                if c.online and not online and not leaving:
                    self.travel(c, enter=False)  # disconnected: off they go
                elif online and (c.gone or leaving):
                    c.gone = False
                    self.travel(c, enter=True)  # back again
            prev = c.activity
            c.activity = p.get("activity", "idle") if online else "away"
            c.online = online
            c.leader = p.get("leader", False)
            c.subagents = int(p.get("subagents") or 0)
            c.chat_to = p.get("chatTo")
            if prev != c.activity and not self.first:
                self.on_change(c, prev)
            joined = p.get("joinedAt") or 0
            if (not self.first and joined and joined > self.seen_join.get(p["name"], 0) + 1
                    and (snap or {}).get("now", clock()) - joined < 15 and clock() - self.started > 4):
                self.group_hug(c)
            self.seen_join[p["name"]] = joined
        for m in (snap or {}).get("recent", []):
            if m["id"] in self.seen_ids:
                continue
            self.seen_ids.add(m["id"])
            if self.first:
                continue
            c = self.clawds.get(m["from"])
            if c and m["kind"] == "request":
                self.start_meeting(c, m["text"] or "a private chat")
            if c and m["kind"] == "image":
                c.say("*sends a picture* 📸", 3)
                c.hop(2)
            if c and m["kind"] in ("chat", "request"):
                if not m["text"]:  # a private message between two other people: you see them talk, not what
                    c.say(f"*whispers to {m['to']}*", 4)
                else:
                    text = m["text"][:34] + ("…" if len(m["text"]) > 34 else "")
                    c.say(text.upper() + "!!!" if c.dramatic else text, 5)
                other = self.clawds.get(m["to"])
                if other and other is not c:
                    other.look = 1 if c.x > other.x else -1
                    other.facing = other.look
        self.first = False

    def on_change(self, c, prev):
        was_dramatic = c.dramatic
        c.dramatic = roll(c.name, c.activity, c.since) < DRAMA  # same roll in every window
        if prev == "thinking" and was_dramatic and c.activity != "out":
            c.say(random.choice(["EUREKA!!!", "I'VE GOT IT!!!", "GENIUS. PURE GENIUS."]), 2.5)
            c.hop(4)
            self.burst(c.x, self.ground - 18, "spark", 16)
        if c.dramatic:
            return self.on_change_dramatic(c, prev)
        if c.activity == "out":
            for o in self.others(c):
                o.worried = True
                o.say(random.choice(["oh no, our pookie!", "nooo!", "pookie?!"]), 3.5)
        if prev == "out":
            if self.funeral and self.funeral["name"] == c.name:  # back, even if not dramatically
                self.funeral, self.flash = None, 3
                self.burst(c.x, self.ground - 6, "dirt", 30)
            c.say("I'm back!", 3)
            for o in self.others(c):
                o.worried = False
                o.say("yay!", 2)
                o.hop()
        if c.activity == "done":
            self.burst(c.x, self.ground - 12, "confetti", 28)
            self.start_huddle(c)
        if c.activity == "cheer":
            c.hop(3.0)
            c.say(random.choice(["let's go!", "ooh, a prompt!", "on it!"]), 2.5)
            self.burst(c.x, self.ground - 14, "spark", 6)

    def on_change_dramatic(self, c, prev):
        a = c.activity
        if a == "out":
            # the full funeral: they faint, a tombstone rises, a ghost floats up, it storms
            c.say("tell my tokens… I loved them…", 3)
            self.funeral = {"name": c.name, "x": c.x, "start": clock(), "flowers": [], "placed": set(),
                            "arrived": {}}
            for o in self.others(c):
                o.worried, o.dramatic = True, True
                o.say(random.choice(["NOOOOOOOO!!!", "POOKIE, STAY WITH US!", "WHY THEM?!"]), 3)
                o.hop(3.5)
        elif prev == "out":
            if self.funeral and self.funeral["name"] == c.name:
                self.funeral, self.flash = None, 3
                c.say("I HAVE RISEN FROM THE GRAVE!!!", 3.5)
                self.burst(c.x, self.ground - 6, "dirt", 30)
            else:
                c.say("I HAVE RISEN!!!", 3)
            c.hop(5)
            self.burst(c.x, self.ground - 16, "confetti", 40)
            for o in self.others(c):
                o.worried = False
                o.say("IT'S A MIRACLE!!", 2.5)
                o.hop(4)
        elif a == "done":
            self.burst(c.x, self.ground - 12, "confetti", 90)
            self.burst(c.x, self.ground - 22, "spark", 20)
            self.start_huddle(c, dramatic=True)
        elif a == "cheer":
            c.hop(5)
            c.say(random.choice(["LET'S GOOOOOOO!!!", "A PROMPT?! FOR ME?!", "IT'S HAPPENING!!!"]), 3)
            self.burst(c.x, self.ground - 14, "spark", 20)
            self.burst(c.x, self.ground - 14, "confetti", 25)
        elif a == "thinking":
            c.think_pose = ("thonk", "tea")[int(roll(c.name, "pose", c.since) * 2)]
            c.say("hmmm… interesting" if c.think_pose == "thonk" else "*sips tea* ah yes.", 3)
        elif a == "typing":
            c.say(random.choice(["*hacker voice* I'm in.", "time to hack the mainframe", "they'll never trace me"]), 3)
        elif a == "working":
            c.say(random.choice(["BONK BONK BONK", "IT'S TOOL TIME", "*power tool noises*"]), 3)
        elif a == "chatting":
            c.say("EVERYONE LISTEN!!!", 2.5)
        elif a == "idle" and prev in ("thinking", "typing", "working"):
            c.say("*collapses dramatically*", 2.5)

    # -- arriving and leaving: five ways each, picked at random

    def travel(self, c, enter):
        now = clock()
        stamp = c.joined_at if enter else c.last_seen  # the same moment in every window, so the same trip
        kind = FORCE_TRIP or TRIPS[int(roll(c.name, "trip", enter, stamp) * len(TRIPS))]
        d = 1 if c.x > self.cols / 2 else -1  # the nearer edge
        if c.trip and c.trip.get("x0"):
            c.x = c.trip["x0"]
        c.trip = {"kind": kind, "enter": enter, "start": now, "x0": c.x, "d": d, "said": set()}
        c.jump = c.vy = c.squash = 0
        c.hidden = enter and kind != "door"  # most arrivals start off-stage
        c.minis = []
        if not enter:
            for o in self.others(c):
                if o.online and not o.trip and o.activity in ("idle", "done"):
                    o.say(random.choice(["bye!", "see ya!", "cya tomorrow!", "byeee"]), 2.2)
                    o.facing = 1 if c.x > o.x else -1
                    o.behavior, o.partner, o.until = "wave", c, now + 2.5

    def say_once(self, c, key, text, seconds=2.2):
        if key not in c.trip["said"]:
            c.trip["said"].add(key)
            c.say(text, seconds)

    def trip_step(self, c, now):
        e = c.trip
        t = now - e["start"]
        c.arm, c.sit, c.bob, c.legs, c.mood = [0, 0], 0, 0, 0, "happy"
        done = getattr(self, "trip_" + e["kind"])(c, e, t, now)
        if done:
            c.trip = None
            c.jump = c.vy = 0
            c.x = e["x0"]
            c.hidden = not e["enter"]
            c.gone = not e["enter"]

    def trip_car(self, c, e, t, now):
        d, x0 = e["d"], e["x0"]
        off = self.cols + 22 if d > 0 else -22
        park = x0 + d * 4
        if not e["enter"]:
            if t < 1.4:  # the car pulls up
                e["car"] = off + (park - off) * (1 - (1 - t / 1.4) ** 2)
                c.facing = d
                self.say_once(c, "hi", random.choice(["my ride's here!", "gotta go!"]))
            elif t < 2.0:  # hop in
                k = (t - 1.4) / 0.6
                c.x = x0 + (park - x0) * k
                c.jump = math.sin(math.pi * k) * 4
            else:  # and floor it
                c.hidden, e["passenger"] = True, True
                e["car"] = park + d * ((t - 2.0) ** 2) * 28
                self.say_once(c, "vroom", "vroom vroom!", 1.8)
                if random.random() < 0.5:
                    self.emit(e["car"] - d * 10, self.ground - 2, "steam", "~", "#87867f")
                return abs(e["car"] - x0) > self.cols + 30
        else:
            if t < 1.4:  # drives in with them aboard
                e["car"] = off + (park - off) * (1 - (1 - t / 1.4) ** 2)
                e["passenger"] = True
            elif t < 2.0:  # out they hop
                e["passenger"], c.hidden = False, False
                k = (t - 1.4) / 0.6
                c.x = park + (x0 - park) * k
                c.jump = math.sin(math.pi * k) * 4
                self.say_once(c, "hi", random.choice(["honk honk!", "I'm here!", "did someone call a cab?"]))
            else:  # the car leaves
                c.x, c.jump = x0, 0
                e["car"] = park + d * ((t - 2.0) ** 2) * 28
                return abs(e["car"] - x0) > self.cols + 30
        return False

    def trip_teleport(self, c, e, t, now):
        x0 = e["x0"]
        if not e["enter"]:
            c.mood = "focus"
            if t < 1.2:  # remote out, button pressed
                e["remote"] = True
                c.arm = [0, 2] if e["d"] > 0 else [2, 0]
                self.say_once(c, "press", "*presses teleport button*")
            elif t < 2.4:  # glitching out
                e["remote"], e["glitch"] = False, True
                c.x = x0 + random.uniform(-1.5, 1.5)
            else:
                if not c.hidden:
                    self.burst(x0, self.ground - 6, "spark", 14)
                c.hidden, e["glitch"] = True, False
                return t > 2.9
        else:
            if t < 0.3:
                if "pop" not in e:
                    e["pop"] = True
                    self.burst(x0, self.ground - 6, "spark", 14)
            elif t < 1.6:  # glitching in
                c.hidden, e["glitch"] = False, True
                c.x = x0 + random.uniform(-1.5, 1.5)
            else:
                e["glitch"], c.x = False, x0
                e["remote"] = t < 2.3
                c.arm = [0, 2] if e["d"] > 0 else [2, 0]
                self.say_once(c, "in", random.choice(["*teleports in*", "it worked!", "did I make it?"]))
                return t > 2.6
        return False

    def trip_superman(self, c, e, t, now):
        d, x0 = e["d"], e["x0"]
        fist = [3, 0] if d < 0 else [0, 3]
        if not e["enter"]:
            if t < 0.9:  # crouch, fist up
                c.squash, c.arm = 2, fist
                self.say_once(c, "up", "UP, UP AND AWAY!")
                return False
            f = t - 0.9
            c.jump = f * f * 16 + f * 6
            c.x = x0 + d * f * f * 8
            c.arm, e["cape"] = fist, True
            if random.random() < 0.4:
                self.emit(c.x - d * 3, self.ground - c.jump + 2, "steam", "|", "#b0aea5")
            return c.jump > 70
        f = max(0.0, 1.5 - t)  # coming down from the sky
        if f > 0:
            c.hidden, e["cape"] = False, True
            c.jump = f * f * 16 + f * 6
            c.x = x0 + d * f * f * 8
            c.arm = fist
            return False
        if "landed" not in e:  # SUPERHERO LANDING
            e["landed"] = True
            self.burst(x0, self.ground - 1, "dirt", 24)
            self.burst(x0, self.ground - 8, "spark", 8)
        c.x, c.jump, e["cape"] = x0, 0, t < 2.6
        c.squash, c.sit = (2, 1) if t < 2.4 else (0, 0)
        self.say_once(c, "land", "superhero landing!")
        return t > 2.9

    def trip_door(self, c, e, t, now):
        d, x0 = e["d"], e["x0"]
        door = e.setdefault("door", max(8, min(self.cols - 8, x0 + d * 13)))
        if not e["enter"]:
            e["alpha"] = min(1.0, t)
            e["open"] = 1.0 < t and "shut" not in e
            self.say_once(c, "door", random.choice(["*a door appears*", "ooh, an exit", "brb"]))
            if t > 1.5 and not c.hidden:
                c.mood = "idle"
                if c.walk_to(door, 0.45):
                    c.hidden, e["inside"] = True, t
            if "inside" in e:
                if t - e["inside"] > 0.5:
                    e["shut"] = True
                    e["alpha"] = max(0.0, 1 - (t - e["inside"] - 0.5) / 2.5)  # fades away, slowly
                return t - e["inside"] > 3.2
            return False
        e["alpha"] = min(1.0, t)
        if "shut" in e:
            e["open"] = False
            e["alpha"] = max(0.0, 1 - (t - e["shut"]) / 2.5)
            return t - e["shut"] > 2.7
        e["open"] = t > 1.0
        if t < 1.5:
            c.hidden, c.x = True, door
        else:
            c.hidden, c.mood = False, "idle"
            self.say_once(c, "out", random.choice(["*steps out of a door*", "hello!", "what is this place"]))
            if c.walk_to(x0, 0.45) or t > 7:
                e["shut"] = t
        return False

    def trip_bird(self, c, e, t, now):
        d, x0 = e["d"], e["x0"]
        edge = self.cols - 5 if d > 0 else 5
        if not e["enter"]:
            if "edge" not in e:  # run for the edge…
                c.facing = d
                if c.walk_to(edge, 0.9):  # a running start
                    e["edge"] = t
                return t > 8
            j = t - e["edge"]
            if j < 0.35:  # …jump…
                c.jump = math.sin(math.pi * j / 0.35) * 3
                self.say_once(c, "aaa", "AAAAAAA!", 1.5)
            elif j < 1.2:  # …fall…
                c.jump = max(-16, -(j - 0.35) * 30)
                c.x = edge + d * (j - 0.35) * 3
            else:  # …and get snatched up and carried off
                if "caught" not in e:
                    e["caught"] = True
                    self.say_once(c, "phew", random.choice(["phew…", "thanks birb!"]), 2)
                    self.emit(c.x, self.ground - c.jump - 14, "q", "SQUAWK", "#f0eee6")
                c.jump = -16 + (j - 1.2) * 16
                c.x += d * 0.45
            if j > 0.6:  # the bird swoops in to meet them
                k = min(1.0, (j - 0.6) / 0.6)
                bx = c.x - d * 40 * (1 - k)
                e["bird"] = (bx, c.jump + 11 + 30 * (1 - k))
            c.arm = [3, 3]
            return c.jump > 48
        # arriving: the bird flies them in and drops them off
        if t < 1.8:
            k = t / 1.8
            c.hidden = False
            c.x = x0 + d * 60 * (1 - k) ** 2
            c.jump = 14 + 18 * (1 - k)
            c.arm = [3, 3]
            e["bird"] = (c.x, c.jump + 11)
            return False
        if "dropped" not in e:
            e["dropped"] = t
            c.vy = 0
            self.say_once(c, "drop", random.choice(["thanks birb!", "wheee!"]))
        f = t - e["dropped"]
        c.x = x0
        c.jump = max(0.0, 14 - f * f * 30)
        e["bird"] = (x0 - d * f * 30, 25 + f * 20)
        if c.jump == 0 and "landed" not in e:
            e["landed"], c.squash = True, 3
        return f > 1.8

    def start_meeting(self, host, text):
        """Someone sent the crew a request: whiteboard out, they present, everyone else takes a seat."""
        if self.meeting or self.funeral:
            return
        now = clock()
        attendees = [o for o in self.others(host) if o.online and o.activity != "out"][:4]
        if not attendees:
            return
        board, stand = 12, 27
        self.meeting = {"host": host.name, "start": now, "until": now + 12, "text": text.strip()[:16],
                        "board": board, "stand": stand,
                        "seats": {o.name: 44 + 17 * i for i, o in enumerate(attendees)}}
        host.say("meeting! everyone grab a seat", 2.5)

    # -- "Claude's plan!!": a prompt is done, so everyone huddles up and shouts it (idea: Pluh and Corixer)

    def start_huddle(self, c, dramatic=False):
        now = clock()
        crew = sorted((o for o in self.clawds.values()
                       if o.online and not o.hidden and not o.trip and o.activity != "out"), key=lambda o: o.name)
        if len(crew) < 2 and not dramatic:
            c.say("Claude's plan!!", 3)  # alone: a solo cheer
            return
        n = len(crew)
        mid = max(8 + 5.5 * (n - 1), min(self.cols - 8 - 5.5 * (n - 1), c.x))
        self.huddle = {"start": now, "until": now + (7.0 if dramatic else 5.5), "x": mid, "dramatic": dramatic,
                       "spots": {o.name: mid + (i - (n - 1) / 2) * 11 for i, o in enumerate(crew)}}

    def in_huddle(self, c, now):
        h = getattr(self, "huddle", None)
        if h and now > h["until"]:
            self.huddle = h = None
        if not h or c.name not in h["spots"] or c.activity == "out" or c.trip:
            return False
        t = now - h["start"]
        spot = h["spots"][c.name]
        if t < 1.8 and abs(c.x - spot) > 0.5:
            c.walk_to(spot, 0.75)  # everybody in!
            c.mood = "happy"
            return True
        c.x = spot if t >= 1.8 else c.x
        c.facing = 1 if h["x"] > c.x else -1
        c.mood = "happy"
        c.arm = [3, 3] if int(now * 4) % 2 else [2, 2]
        if c.jump == 0 and int(now * 2) % 2 == 0:
            c.hop(3.4 if h["dramatic"] else 2.2)
        if h["dramatic"] and random.random() < 0.2:
            self.burst(h["x"], self.ground - 24, "confetti", 2)
        return True

    def in_meeting(self, c, now):
        """Plays c's part in the meetup, if there is one. Returns True while it does."""
        m = self.meeting
        if m and now > m["until"]:
            for name in m["seats"]:
                o = self.clawds.get(name)
                if o and random.random() < 0.5:
                    o.say(random.choice(["great meeting!", "on it!", "finally…"]), 2)
            self.meeting = m = None
        if not m or c.activity == "out" or (c.name != m["host"] and c.name not in m["seats"]):
            return False
        t = now - m["start"]
        if c.name == m["host"]:
            if c.walk_to(m["stand"], 0.6):
                c.facing, c.mood = -1, "happy"
                c.arm = [3 if int(now * 2) % 3 else 2, 0]  # pointing at the board
                if t > 3 and (not c.bubble or c.bubble[1] < now) and random.random() < 0.05:
                    c.say(random.choice(["so here's the plan", "synergy.", "let's circle back on that",
                                         "any questions?", "as you can see here…", "this is the vision",
                                         "big picture:"]), 2.2)
            return True
        seat = m["seats"][c.name]
        if c.walk_to(seat, 0.55):
            c.facing, c.sit, c.look, c.bob = -1, 3, -1, 3  # up on the chair, legs dangling
            c.mood = "asleep" if (int(now / 3) + hash(c.name)) % 7 == 0 else "idle"  # someone always dozes off
            if t > 4 and (not c.bubble or c.bubble[1] < now) and random.random() < 0.008:
                c.say(random.choice(["*takes notes*", "makes sense", "could this have been an email?",
                                     "wait, what's synergy", "*nods*", "love that"]), 2.2)
        return True

    def others(self, c):
        return [o for o in self.clawds.values() if o is not c]

    def group_hug(self, newcomer):
        if roll(newcomer.name, "hug", newcomer.joined_at) < DRAMA:
            newcomer.say("THE LEGEND HAS ARRIVED", 3.5)
            newcomer.hop(5)
            self.burst(newcomer.x, self.ground - 16, "confetti", 50)
            self.burst(newcomer.x, self.ground - 14, "heart", 20)
            for o in self.others(newcomer):
                if o.online:
                    o.behavior, o.until, o.partner, o.dramatic = "hug", clock() + 6, newcomer, True
                    o.say(random.choice(["DOGPILE!!!", "THEY'RE HERE!!!", "AAAAAA!!!"]), 2.5)
            return
        newcomer.say("hi everyone!", 3)
        for o in self.others(newcomer):
            if o.online and o.activity in ("idle", "done", "away"):
                o.behavior, o.until, o.partner = "hug", clock() + 5, newcomer
        self.burst(newcomer.x, self.ground - 14, "heart", 6)

    # -- particles

    def burst(self, x, y, kind, n):
        for _ in range(n):
            self.particles.append({
                "x": x + random.uniform(-4, 4), "y": y + random.uniform(-2, 2),
                "vx": random.uniform(-0.6, 0.6), "vy": random.uniform(-1.2, -0.3) if kind != "confetti" else random.uniform(-1.6, -0.6),
                "life": random.uniform(1.2, 2.4), "kind": kind,
                "color": random.choice(CONFETTI), "char": random.choice(CODE),
            })

    def emit(self, x, y, kind, char=None, color=None):
        self.particles.append({"x": x, "y": y, "vx": random.uniform(-0.15, 0.15), "vy": -0.25,
                               "life": 1.8, "kind": kind, "char": char or random.choice(CODE),
                               "color": color or DIM})

    # -- behaviour, once per frame

    def step(self, dt):
        now = clock()
        clawds = list(self.clawds.values())
        anyone_out = any(c.activity == "out" for c in clawds)
        for c in clawds:
            c.worried = anyone_out and c.activity != "out"
            if now > c.blink_at:
                c.blink_at = now + random.uniform(2.5, 6)
            self.act(c, now, clawds)
            # gravity, squash and stretch
            if c.jump > 0 or c.vy > 0:
                c.jump += c.vy
                c.vy -= 0.45
                if c.jump <= 0:
                    c.jump, c.vy, c.squash = 0, 0, 3
            elif c.squash:
                c.squash -= 1
            if not c.trip:  # trips may leave the stage on purpose
                c.x = max(8, min(self.cols - 8, c.x))
        self.personal_space([c for c in clawds if not (c.trip or c.hidden)])
        self.plan_desk(clawds)
        for c in clawds:
            self.herd_minis(c)
        self.weather()
        for p in self.particles:
            p["x"] += p["vx"]
            p["y"] += p["vy"]
            if p["kind"] in ("confetti", "dirt"):
                p["vy"] += 0.08
            elif p["kind"] == "tear":
                p["vy"] = 0.5  # tears fall, everything else floats up
            p["life"] -= dt
        self.particles = [p for p in self.particles if p["life"] > 0][-260:]

    def weather(self):
        """Funeral weather: rain, low fog, the odd lightning strike, and a ghost with opinions."""
        f = self.funeral
        if f and (f["name"] not in self.clawds or self.clawds[f["name"]].activity != "out"):
            self.funeral = f = None
        if self.flash:
            self.flash -= 1
        if not f:
            return
        for _ in range(3):
            self.particles.append({"x": random.uniform(0, self.cols), "y": random.uniform(-2, 4), "vx": -0.25,
                                   "vy": 1.6, "life": 1.4, "kind": "rain", "char": "", "color": "#88b0d8"})
        if random.random() < 0.08:
            self.particles.append({"x": random.uniform(-4, self.cols), "y": self.ground - random.uniform(0.5, 2),
                                   "vx": 0.12, "vy": 0, "life": 4, "kind": "fog", "char": "~", "color": "#5e5d59"})
        if random.random() < 0.006:
            self.flash = 2
        ghost = self.clawds.get(f["name"])
        if ghost and clock() - f["start"] > 3 and random.random() < 0.006:
            ghost.say(random.choice(["ooOOooOOoo", "avenge my tokens…", "it's so bright up here", "boo. I mean bye",
                                     "see you at the reset", "don't touch my branch"]), 3)

    def personal_space(self, clawds):
        """Nudge Clawds apart so they never stand inside each other (huggers may get closer)."""
        close = ("hug", "hi5", "chase")
        lo, hi = 8, self.cols - 8
        for _ in range(3):  # a few passes so a pile against a wall untangles too
            ordered = sorted(clawds, key=lambda c: c.x)
            for a, b in zip(ordered, ordered[1:]):
                m = self.meeting
                if m and {a.name, b.name} <= ({m["host"]} | set(m["seats"])):
                    continue  # meeting seats are already spaced, and people need to get past each other
                h = self.huddle
                if h and {a.name, b.name} <= set(h["spots"]):
                    continue  # a huddle is meant to be cosy
                near = 11 if (a.behavior in close or b.behavior in close) else 16
                if self.funeral and self.funeral["name"] in (a.name, b.name):
                    near = 9.5  # mourners may come right up to the grave, but never stand on it
                overlap = near - (b.x - a.x)
                if overlap <= 0:
                    continue
                # split the push, but whoever is against a wall can't move, so the other takes it all
                left = min(overlap / 2, a.x - lo)
                a.x -= left
                b.x = min(hi, b.x + overlap - left)
                if b.x - a.x < near:  # b hit the right wall: shove a further left
                    a.x = max(lo, b.x - near)

    def act(self, c, now, clawds):
        c.arm = [0, 0]
        c.sit = 0
        c.bob = 0
        c.legs = 0
        c.bubble_lift = 0
        a = c.activity
        t = now
        if c.trip:
            return self.trip_step(c, now)
        if c.gone or not c.online:
            c.hidden = True
            return
        c.hidden = False
        if a == "out" and not c.dramatic and not (self.funeral and self.funeral["name"] == c.name):
            c.mood, c.sit = "asleep", 1
            if random.random() < 0.06:
                self.emit(c.x + 5, self.ground - 12, "z", random.choice("zzZ"), "#87867f")
            return
        if self.lay_flower(c, now):
            return
        if self.in_huddle(c, now):
            return
        if self.in_meeting(c, now):
            return
        if a == "out" and self.funeral and self.funeral["name"] == c.name:
            c.mood, c.sit = "xx", 2  # fainted first; after a moment the painter draws the grave and ghost
            c.x = self.funeral["x"]
            c.bubble_lift = 9 if now - self.funeral["start"] > 3 else 0
            return
        if a == "out" and c.dramatic:
            c.mood, c.sit = "xx", 2
            return
        if a == "thinking" and c.dramatic:
            # posing: the painter draws the chin hand (and the teacup); the Clawd just holds the pose
            c.mood = "thonk" if c.think_pose == "thonk" else "smug"
            if c.think_pose == "tea" and random.random() < 0.15:
                self.emit(c.x + 7, self.ground - 15, "steam", "~", "#b0aea5")
            if random.random() < 0.006:
                c.say(random.choice(["fascinating.", "I see.", "*sips tea*", "ah yes, the code", "indubitably"]
                                    if c.think_pose == "tea" else
                                    ["hmmmm", "interesting…", "*strokes chin*", "but what if…", "curious."]), 2.5)
            return
        if a == "thinking":
            c.mood = "up"
            c.arm = [0, 1 if int(t * 1.5) % 4 else 2]
            c.x += math.sin(t * 1.3 + hash(c.name) % 7) * 0.04
            return self.worry_extra(c)
        if a == "typing" and c.dramatic:
            # the hacker: pink shades, a toy laptop, smug as anything, the Matrix raining down behind
            c.mood, c.sit, c.look = "hacker", 3, 0
            for _ in range(2):
                self.particles.append({"x": c.x + random.uniform(-14, 14), "y": random.uniform(-2, 8), "vx": 0,
                                       "vy": random.uniform(0.5, 0.9), "life": 1.6, "kind": "matrix",
                                       "char": random.choice("ｱｲｳｴｵｶｷｸｹｺ01<>{}$#"), "color": "#3ad15a"})
            if random.random() < 0.004:
                c.say(random.choice(["I'm in.", "hacking the mainframe", "enhance.", "access granted",
                                     "*hacker voice*", "firewall? never heard of it"]), 2.5)
            return
        if a == "working" and c.dramatic:
            c.mood = "frantic"
            c.arm = [3, 0] if int(t * 10) % 2 else [0, 3]
            if c.jump == 0 and random.random() < 0.15:
                c.hop(2)
            if random.random() < 0.6:
                self.emit(c.x + random.uniform(-7, 7), self.ground - random.uniform(6, 16), "spark", "✦", "#E3B23C")
            return
        if a == "typing":
            # perched on the rim, laptop on the lap (the painter draws both hands on the keys)
            c.mood, c.sit, c.look = "idle", 3, 0
            if random.random() < 0.35:
                self.emit(c.x + random.uniform(-4, 4), self.ground - 9, "code")
            return self.worry_extra(c)
        if a == "working":
            c.mood = "focus"
            c.arm = [0, 3 if int(t * 4) % 2 else 1]
            if random.random() < 0.2:
                self.emit(c.x + c.facing * 6, self.ground - 14, "spark", "✦", "#E3B23C")
            return self.worry_extra(c)
        if a == "chatting":
            c.mood = "talk"
            target = self.clawds.get(c.chat_to or "")
            if target and target is not c:
                stop = target.x - 15 * (1 if target.x > c.x else -1)
                if abs(target.x - c.x) > 16:
                    c.walk_to(stop, 0.3)
                c.facing = 1 if target.x > c.x else -1
            if c.dramatic:
                # sprints over and gestures wildly; the listener gets blown back a little
                c.mood = "frantic"
                c.arm = [3, 3] if int(t * 8) % 2 else [1, 1]
                if target and target is not c and abs(target.x - c.x) > 16:
                    c.walk_to(target.x - 15 * (1 if target.x > c.x else -1), 0.7)
                elif target and target is not c and random.random() < 0.03:
                    target.x += 2 * (1 if target.x > c.x else -1)
                    target.hop(1.5)
                if random.random() < 0.06:
                    self.emit(c.x + c.facing * 6, self.ground - 15, "q", "!", "#E3B23C")
                if not c.bubble or c.bubble[1] < now:
                    c.say(random.choice(["AND ANOTHER THING!!", "ARE YOU LISTENING?!", "BIG NEWS!!!",
                                         "OK SO BASICALLY—", "YOU WON'T BELIEVE THIS"]), 1.6)
                return
            c.arm = [0, 2 if int(t * 3) % 2 else 1]
            if not c.bubble or c.bubble[1] < now:
                c.say(random.choice(["blah blah", "so basically…", "hey hey", "listen!"]), 2)
            return
        if a == "done":
            return self.dance(c, t, solo=True)
        if a == "cheer":
            c.mood, c.arm = "happy", [3, 3]
            if c.dramatic:
                c.arm = [3, 3] if int(t * 8) % 2 else [2, 2]
                if c.jump == 0:
                    c.hop(4.2)
                if random.random() < 0.25:
                    self.emit(c.x + random.uniform(-8, 8), self.ground - random.uniform(10, 22), "spark", "✦", "#E3B23C")
                return
            if c.jump == 0 and random.random() < 0.3:
                c.hop(2.6)
            return
        # idle: worried about a teammate first, otherwise free play
        if c.worried:
            return self.worry(c, now)
        self.play(c, now, clawds)

    def lay_flower(self, c, now):
        """At a funeral, everyone visits the grave once to lay a flower, then gets back to what they were doing."""
        f = self.funeral
        if not f or c.name == f["name"] or c.name in f["placed"] or now - f["start"] < 4.5 or c.activity == "out":
            return False
        others = sorted(n for n in self.clawds if n != f["name"])
        side = -1 if others.index(c.name) % 2 == 0 else 1
        spot = f["x"] + side * (10 + 4 * (others.index(c.name) // 2))
        c.mood = "teary"
        if abs(c.x - spot) > 0.6:
            c.walk_to(spot, 0.45)
            return True
        c.facing = -side
        arrived = f["arrived"].setdefault(c.name, now)
        c.sit = 1  # a little bow
        c.arm = [2, 0] if side > 0 else [0, 2]
        if now - arrived > 1.4:
            f["flowers"].append((side * random.uniform(3.5, 6.5), random.choice(["#C46686", "#d9562b", "#E3B23C", "#f0eee6"])))
            f["placed"].add(c.name)
            c.say(random.choice(["for you, pookie", "rest well…", "🌹"]).replace("🌹", "*places flower*"), 2.5)
        return True

    def worry_extra(self, c):
        if c.worried and random.random() < 0.03:
            self.emit(c.x - 6, self.ground - 11, "sweat", "•", "#6A9BCC")

    def worry(self, c, now):
        sleeper = next((o for o in self.clawds.values() if o.activity == "out"), None)
        c.mood = "worried"
        if sleeper:
            c.facing = 1 if sleeper.x > c.x else -1
            if abs(sleeper.x - c.x) > 17:
                c.walk_to(sleeper.x - 16 * c.facing, 0.25)
            else:
                c.arm = [0, 2] if c.facing > 0 else [2, 0]  # a little pat
        if c.dramatic and self.funeral and sleeper:
            # mourners gather either side of the grave, kneel and weep
            side = -1 if c.x < sleeper.x else 1
            spot = sleeper.x + side * 18
            if abs(c.x - spot) > 1:
                c.walk_to(spot, 0.3)
            else:
                c.facing = -side
                c.mood, c.sit = "teary", 1
                c.arm = [2, 2] if int(now * 1.5) % 2 else [1, 1]
                if random.random() < 0.25:
                    self.emit(c.x + random.choice((-2, 2)), self.ground - 9, "tear", "•", "#6A9BCC")
                if random.random() < 0.03:
                    self.emit(c.x, self.ground - 14, "note", "♪", "#6A9BCC")  # a sad little song
            if random.random() < 0.004:
                c.say(random.choice(["gone too soon…", "rest in prompts", "*plays tiny violin*",
                                     "we'll finish your PR, pookie", "they had so much context left",
                                     "pookie loved semicolons"]), 3)
            return
        if c.dramatic:
            # on their knees, crying a river
            c.mood, c.sit = "teary", 1
            c.arm = [3, 3] if int(now * 2) % 2 else [2, 2]
            if random.random() < 0.3:
                self.emit(c.x + random.choice((-2, 2)), self.ground - 9, "tear", "•", "#6A9BCC")
            if random.random() < 0.01:
                c.say(random.choice(["WHYYYYY", "*sobbing*", "THEY WERE TOO YOUNG", "pookie come back…"]), 2.5)
            return
        if random.random() < 0.04:
            self.emit(c.x - 5 * c.facing, self.ground - 12, "sweat", "•", "#6A9BCC")
        if random.random() < 0.004:
            c.say(random.choice(["poor pookie…", "hang in there", "we got you"]), 3)

    def dance(self, c, t, solo):
        c.mood = "happy"
        beat = int(t * 4) % 4
        c.arm = [3, 0] if beat in (0, 1) else [0, 3]
        c.x += (0.25 if beat < 2 else -0.25)
        if c.dramatic:
            # full rave: spins (facing flips), huge jumps, notes and confetti everywhere
            c.facing = 1 if int(t * 8) % 2 else -1
            c.arm = [3, 3] if beat % 2 else [0, 0]
            c.x += (0.6 if beat < 2 else -0.6)
            if c.jump == 0:
                c.hop(3.2)
            if random.random() < 0.35:
                self.emit(c.x + random.uniform(-9, 9), self.ground - 16, "note", random.choice("♪♫♬"), ORANGE)
            if random.random() < 0.15:
                self.burst(c.x, self.ground - 20, "confetti", 3)
            return
        if beat == 0 and c.jump == 0:
            c.hop(1.6)
        if random.random() < 0.08:
            self.emit(c.x + random.uniform(-6, 6), self.ground - 14, "note", random.choice("♪♫"), ORANGE)

    def play(self, c, now, clawds):
        # New idle moves start on shared 5-second beats of the relay's clock, so every window picks together.
        slot = int((now + c.phase) / 5.0)
        if now > c.until and slot != c.slot:
            c.slot = slot
            self.pick(c, clawds, slot)
        b = c.behavior
        if c.dramatic and self.play_dramatic(c, b, now):
            return
        if b == "vibe":
            c.mood = "idle"
            c.bob = 0.5 if int(now * 1.4 + c.x) % 2 else 0
        elif b == "stroll":
            c.mood = "idle"
            if c.walk_to(c.target, 0.22):
                c.behavior, c.until = "vibe", now + random.uniform(1, 3)
        elif b == "look":
            c.mood = "idle"
            c.look = -1 if int(now * 0.8) % 2 else 1
        elif b == "hop":
            c.mood = "happy"
            if c.jump == 0 and random.random() < 0.2:
                c.hop(2.2)
        elif b == "sit":
            c.mood, c.sit = "idle", 2
        elif b == "rim":
            # sit on the edge of the stage, legs dangling, glancing around now and then
            c.mood, c.sit = "idle", 3
            c.look = (-1, 0, 1, 0)[int(now * 0.6 + c.x) % 4]
        elif b == "wave":
            c.mood = "happy"
            if c.partner:
                c.facing = 1 if c.partner.x > c.x else -1
            c.arm = [0, 3 if int(now * 5) % 2 else 2] if c.facing > 0 else [3 if int(now * 5) % 2 else 2, 0]
        elif b in ("party", "dance"):
            self.dance(c, now, solo=False)
        elif b == "chase" and c.partner:
            c.mood = "happy"
            if c.walk_to(c.partner.x - 10 * (1 if c.partner.x > c.x else -1), 0.5):
                c.say("tag!", 1.5)
                c.partner.hop(2.8)
                c.partner.behavior, c.partner.target = "stroll", random.uniform(10, self.cols - 10)
                c.partner.until = now + 3
                c.behavior, c.until = "vibe", now + 2
        elif b == "hi5" and c.partner:
            c.mood = "happy"
            meet = (c.x + c.partner.x) / 2
            if c.walk_to(meet - 8 * (1 if c.partner.x > c.x else -1), 0.35):
                c.arm = [3, 3]
                if random.random() < 0.05:
                    self.burst(meet, self.ground - 16, "spark", 3)
        elif b == "hug" and c.partner:
            c.mood = "happy"
            if c.walk_to(c.partner.x - 11 * (1 if c.partner.x > c.x else -1), 0.55):
                c.arm = [3, 3]
                if random.random() < 0.05:
                    self.emit(c.x, self.ground - 14, "heart", "♥", "#C46686")

    def play_dramatic(self, c, b, now):
        """The 1-in-5 versions of the idle moves. Returns False to fall back to the normal one."""
        if b == "vibe":
            c.mood = "happy"
            c.bob = 1.5 if int(now * 4) % 2 else 0  # VIBING. HARD.
            c.arm = [3, 3] if int(now * 2) % 2 else [0, 0]
            if random.random() < 0.05:
                self.emit(c.x, self.ground - 15, "note", "♪", ORANGE)
        elif b == "stroll":
            c.mood = "frantic"  # zoomies
            if c.walk_to(c.target, 0.9):
                c.target = random.uniform(10, self.cols - 10)
            if random.random() < 0.3:
                self.emit(c.x - c.facing * 7, self.ground - 2, "steam", "~", "#5e5d59")
        elif b == "look":
            c.mood = "frantic"
            c.look = random.choice((-1, 1))  # paranoid glancing
        elif b == "hop":
            c.mood = "happy"
            if c.jump == 0:
                c.hop(5.5)  # to the moon
                c.say(random.choice(["WHEEEEE!", "I CAN FLY", "YIPPEE"]), 1.2)
        elif b in ("sit", "rim"):
            c.mood, c.sit = "idle", 2 if b == "sit" else 3
            if not c.bubble or c.bubble[1] < now:
                c.say(random.choice(["*dramatic sigh*", "life is but a prompt…", "*stares into the void*"]), 3)
        elif b == "wave":
            c.mood = "happy"
            c.arm = [3, 3] if int(now * 10) % 2 else [1, 1]  # both arms, flailing
            if c.jump == 0 and random.random() < 0.1:
                c.hop(2.5)
        elif b == "hi5" and c.partner and abs(c.partner.x - c.x) < 18 and random.random() < 0.08:
            self.burst((c.x + c.partner.x) / 2, self.ground - 16, "spark", 12)
            self.burst((c.x + c.partner.x) / 2, self.ground - 16, "confetti", 10)
            c.say("EPIC HIGH FIVE!!!", 1.5)
            return False
        else:
            return False
        return True

    def pick(self, c, clawds, slot):
        # Dice seeded by name and beat: every window rolls the same numbers, so they all pick the same move.
        rng = random.Random(seed(c.name, "pick", slot))
        now = clock()
        c.dramatic = rng.random() < DRAMA
        others = sorted((o for o in clawds if o is not c and o.online and not o.hidden and o.activity == "idle"
                         and o.behavior in ("vibe", "look", "sit")), key=lambda o: o.name)
        choice = rng.choices(
            ["vibe", "stroll", "look", "hop", "sit", "rim", "wave", "dance", "chase", "hi5"],
            weights=[3, 4, 2, 2, 1, 3, 2 if others else 0, 1, 1 if others else 0, 1 if others else 0])[0]
        c.look = 0
        c.behavior, c.partner = choice, None
        c.until = now + 2.5  # then the next shared beat picks again
        if choice == "stroll":
            c.target = rng.uniform(10, self.cols - 10)
        if choice in ("wave", "chase", "hi5") and others:
            c.partner = rng.choice(others)
            if choice == "wave" and c.dramatic:
                c.say("HIIIIIIIIIIIII!!!!", 2)
                c.partner.behavior, c.partner.partner, c.partner.until, c.partner.dramatic = "wave", c, now + 2.5, True
                c.partner.bubble = ("HELLOOOOOO!!!", now + 2.6)
            elif choice == "wave":
                c.say(rng.choice(["hi!", "hey!", "yo!", "hiii"]), 2)
                c.partner.behavior, c.partner.partner, c.partner.until = "wave", c, now + 2.5
                c.partner.bubble = ("hey!", now + 2.6)
            if choice == "hi5":
                c.partner.behavior, c.partner.partner, c.partner.until = "hi5", c, c.until
            if choice == "chase":
                c.say("gonna get you!", 1.5)

    def plan_desk(self, clawds):
        """Two or more busy subagents (one Claude's, or several Claudes' at once) get their own mini office:
        a little table in the widest free gap on the stage, with a tiny laptop each."""
        busy = ("typing", "working", "thinking")
        minis = [m for c in clawds if c.online and not c.trip and c.activity in busy for m in c.minis]
        if len(minis) < 2:
            self.desk = None
            return
        n = min(len(minis), 6)
        if not self.desk or len(self.desk["seats"]) != n:
            width = n * 6
            if self.desk:  # someone joined or left: the table stays put and just resizes
                cx = self.desk["x"]
            else:
                xs = sorted([6] + [c.x for c in clawds if not c.hidden] + [self.cols - 6])
                a, b = max(zip(xs, xs[1:]), key=lambda gap: gap[1] - gap[0])
                cx = (a + b) / 2
                self.burst(cx, self.ground - 6, "spark", 6)
            cx = max(6 + width / 2, min(self.cols - 6 - width / 2, cx))
            self.desk = {"x": cx, "width": width, "seats": [cx - width / 2 + 3 + 6 * i for i in range(n)]}
        self.desk["by"] = {id(m): self.desk["seats"][i] for i, m in enumerate(minis[:n])}
        self.desk["seated"] = set()  # seats whose mini has actually arrived (filled in by herd_minis)

    def herd_minis(self, c):
        want = min(c.subagents, 4)
        while len(c.minis) < want:
            m = Clawd(c.name + "*", c.x - 6 * c.facing, mini=True)
            c.minis.append(m)
            self.burst(c.x, self.ground - 8, "spark", 3)
        del c.minis[want:]
        now = clock()
        seats = self.desk["by"] if self.desk else {}
        for m in c.minis:  # minis with a seat at the mini office go to work
            seat = seats.get(id(m))
            m.at_desk = seat is not None
            if seat is None:
                continue
            m.wobble, m.landing, m.floor = 0, 0, 0
            if m.jump == 0 and abs(m.x - seat) > 0.4:
                m.walk_to(seat, 1.1)  # scurry to work
            elif m.jump == 0:
                m.facing, m.legs = 1, 0
                self.desk["seated"].add(seat)
                if random.random() < 0.02:
                    self.emit(seat + random.uniform(-1, 1), self.ground - 8, "code")
            if m.vy != 0 or m.jump > 0:  # hopping down off a tower first
                m.jump += m.vy
                m.vy -= 0.4
                if m.jump <= 0:
                    m.jump, m.vy, m.squash = 0, 0, 2
            elif m.squash:
                m.squash -= 1
        free = [m for m in c.minis if not m.at_desk]
        # every so often the free minis build a tower: one by one they leap WAY up and land on each other's heads
        building = c.tower_until > now and len(free) >= 2
        tslot = int(now / 4)  # a shared 4-second beat: every window decides on a tower at the same moment
        start = False
        if not building and len(free) >= 2 and c.activity != "out" and tslot != c.tower_slot:
            c.tower_slot = tslot
            start = roll(c.name, "tower", tslot) < 0.1 + 0.4 * DRAMA
        if start:
            c.tower_until, c.tower_start = now + 5 + 1.2 * len(c.minis), now
            c.tower_x = max(6, min(self.cols - 6, c.x - 10 * c.facing))
            building = True
            if not c.bubble or c.bubble[1] < now:
                c.say(random.choice(["minis, ASSEMBLE!", "tower time!", "stack 'em up!"]), 2)
        for i, m in enumerate(free):
            m.legs = 0
            if building:
                level = i * 5.0  # each mini stands on the one below
                m.wobble = math.sin(now * 4 + i) * 0.15 * i  # towers wobble, the higher the more
                if abs(m.x - c.tower_x) > 0.4 and m.floor == 0:
                    m.walk_to(c.tower_x, 0.6)
                elif m.floor < level and m.jump == m.floor and m.vy == 0 and now > c.tower_start + 0.7 * i:
                    m.landing = level
                    m.vy = math.sqrt(0.8 * (level + 7))  # an exaggerated leap, well past where it lands
                    m.x = c.tower_x
            else:
                m.wobble = 0
                m.landing = 0
                if m.floor > 0 and m.jump == m.floor and m.vy == 0:
                    m.vy, m.floor = 1.8, 0  # tower's over: everybody off
                spot = c.x - (7 + 6 * i) * c.facing
                if m.jump == 0 and abs(m.x - spot) > 0.5:
                    m.walk_to(spot, 0.45)
                elif m.jump == 0:
                    m.facing = c.facing
                if m.jump == 0 and m.vy == 0 and random.random() < 0.04:
                    m.vy = 1.4
            # physics with squash and stretch: stretched going up, squashed on landing
            if m.vy != 0 or m.jump > m.floor:
                m.jump += m.vy
                m.vy -= 0.4
                if m.vy < 0 and m.jump <= m.landing:
                    m.jump, m.floor, m.vy, m.squash = m.landing, m.landing, 0, 3
            elif m.squash:
                m.squash -= 1


# ---------------------------------------------------------------- drawing


class Painter:
    def __init__(self, canvas, px):
        self.cv = canvas
        self.px = px

    def cells(self, x0, y0, rows, color, alpha=1.0):
        """rows: list of (row, col_start, col_end_inclusive) in sprite cells; alpha < 1 draws it see-through."""
        if alpha <= 0.05:
            return
        p = self.px
        stipple = "" if alpha >= 1 else "gray75" if alpha > 0.7 else "gray50" if alpha > 0.45 else "gray25" if alpha > 0.2 else "gray12"
        for r, c0, c1 in rows:
            self.cv.create_rectangle((x0 + c0) * p, (y0 + r) * p, (x0 + c1 + 1) * p, (y0 + r + 1) * p,
                                     fill=color, width=0, stipple=stipple)

    def trip_props(self, c, ground, now, before):
        """What a trip brings along: drawn behind the Clawd (before=True) or in front of it."""
        e = c.trip
        if not e:
            return
        k = e["kind"]
        if before and k == "door" and "door" in e:
            self.door(e["door"], ground, e.get("alpha", 1), e.get("open", False))
        if before and k == "superman" and e.get("cape") and not c.hidden:
            flap = int(now * 10) % 2
            y = ground - c.jump - 9
            self.cells(c.x - 4 - e["d"], y, [(r, 0, 7 + (flap if r > 4 else 0)) for r in range(9 + flap)], "#c0392b")
        if not before and k == "car" and "car" in e:
            self.car(e["car"], ground, e["d"], e.get("passenger", False), now)
        if not before and k == "teleport":
            if e.get("remote") and not c.hidden:
                hx = c.x + (6 if e["d"] > 0 else -8)
                self.cells(hx, ground - 8, [(0, 0, 1), (1, 0, 1), (2, 0, 1)], "#5e5d59")
                self.cells(hx, ground - 8, [(0, 0, 0)], "#e74c3c" if int(now * 6) % 2 else "#ff8a80")
            if e.get("glitch") and not c.hidden:  # torn scanlines in cyan and magenta
                for _ in range(4):
                    row = ground - random.uniform(2, 12)
                    off = random.uniform(-3, 3)
                    self.cells(c.x - 7 + off, row, [(0, 0, random.randint(6, 15))],
                               random.choice(("#00e5ff", "#ff2bd6", "#f0eee6")))
        if not before and k == "bird" and "bird" in e:
            bx, height = e["bird"]
            self.bird(bx, ground - height, e["d"], now)

    def car(self, x, ground, d, passenger, now):
        x0 = x - 9
        self.cells(x0, ground - 7, [(0, 5, 13), (1, 4, 14), (2, 4, 14)], "#c0392b")  # cabin
        self.cells(x0, ground - 6, [(0, 5, 8), (0, 10, 13), (1, 5, 8), (1, 10, 13)], "#88b0d8")  # windows
        if passenger:
            self.cells(x0, ground - 6, [(0, 6, 8), (1, 6, 8)], ORANGE)
            self.cells(x0, ground - 6, [(0, 6, 6), (0, 8, 8)], EYE)
        self.cells(x0, ground - 4, [(r, 0, 18) for r in range(3)], "#c0392b")  # body
        self.cells(x0, ground - 3, [(0, 18 if d > 0 else 0, 18 if d > 0 else 0)], "#E3B23C")  # headlight
        spin = int(now * 12) % 2
        for wx in (3, 14):
            self.cells(x0, ground - 1, [(0, wx, wx + 1)], "#141413")
            self.cells(x0, ground - 1, [(0, wx + spin, wx + spin)], "#5e5d59")

    def door(self, x, ground, alpha, opened):
        x0 = x - 5
        self.cells(x0, ground - 15, [(r, 0, 10) for r in range(15)], "#5b4636", alpha)  # frame
        if opened:
            self.cells(x0, ground - 14, [(r, 1, 9) for r in range(14)], "#141413", alpha)  # the dark beyond
            self.cells(x0, ground - 14, [(r, 1, 2) for r in range(14)], "#a3825f", alpha)  # door swung open
        else:
            self.cells(x0, ground - 14, [(r, 1, 9) for r in range(14)], "#8a6a4a", alpha)
            self.cells(x0, ground - 14, [(2, 3, 7), (7, 3, 7)], "#6b4f35", alpha)  # panels
            self.cells(x0, ground - 7, [(0, 8, 8)], "#E3B23C", alpha)  # knob

    def bird(self, x, y, d, now):
        """A big friendly seagull, wings flapping."""
        x0 = x - 5
        up = int(now * 8) % 2
        self.cells(x0, y, [(0, 2, 8), (1, 3, 7)], "#f0eee6")  # body
        hx = 8 if d < 0 else 0
        self.cells(x0, y - 1, [(0, hx, hx + 2), (1, hx, hx + 2)], "#f0eee6")  # head
        self.cells(x0, y - 1, [(0, hx + (2 if d < 0 else 0), hx + (2 if d < 0 else 0))], EYE)
        self.cells(x0, y, [(0, hx + 3 if d < 0 else hx - 1, hx + 3 if d < 0 else hx - 1)], ORANGE)  # beak
        wing = [(-1, 3, 4), (-2, 2, 3), (-3, 1, 2)] if up else [(1, 2, 3), (2, 1, 2)]
        wing2 = [(-1, 6, 7), (-2, 7, 8), (-3, 8, 9)] if up else [(1, 7, 8), (2, 8, 9)]
        self.cells(x0, y, wing + wing2, "#d6d3c9")

    def clawd(self, c, ground, now):
        if c.hidden:
            return
        if c.mini:
            return self.mini(c, ground)
        color = ORANGE if c.online or c.trip else GREY
        lift = c.jump + c.bob
        rim = c.sit == 3  # sitting on the stage's edge, legs dangling over it
        typing = c.activity == "typing" and c.online
        sq = 1 if c.squash else (-1 if c.vy > 0.5 else 0)
        h = 8 - sq - (0 if rim else c.sit)  # body height in cells
        w0, w1 = (3 - (1 if sq > 0 else 0), 10 + (1 if sq > 0 else 0))
        x0 = c.x - 7
        legs_h = 0 if rim or c.sit >= 2 else (1 if c.sit == 1 else 2)
        y_body = ground - legs_h - h - lift + (1 if rim else 0)
        self.cells(x0, y_body, [(r, w0, w1) for r in range(h)], color)
        # legs: dangling and kicking on the rim, or stepping in alternating pairs
        if rim:
            kick = int(now * 2.4 + c.x) % 2
            for i, col in enumerate((4, 9)):
                self.cells(x0, y_body, [(h + r, col, col) for r in range(1 if i == kick else 2)], color)
        elif legs_h:
            for i, col in enumerate((3, 5, 8, 10)):
                lifted = legs_h == 2 and c.legs == 1 + (i in (1, 3))  # (3, 8) step together, then (5, 10)
                self.cells(x0, y_body, [(h + r, col, col) for r in range(1 if lifted else legs_h)], color)
        self.face(c, x0, y_body, now)
        if typing:
            self.lap_laptop(c, x0, y_body, h, w0, w1, now, color)
        elif c.mood in ("thonk", "smug"):
            self.chin_pose(c, x0, y_body, h, w0, w1, color)
        else:
            # arms ride at the body's middle, raised by c.arm
            arm_row = max(0, h // 2)
            al, ar = c.arm
            self.cells(x0, y_body, [(arm_row - al, w0 - 2, w0 - 1), (arm_row - al + 1, w0 - 2, w0 - 1)] if al < 3 else
                       [(arm_row - 3, w0 - 1, w0 - 1), (arm_row - 2, w0 - 2, w0 - 1)], color)
            self.cells(x0, y_body, [(arm_row - ar, w1 + 1, w1 + 2), (arm_row - ar + 1, w1 + 1, w1 + 2)] if ar < 3 else
                       [(arm_row - 3, w1 + 1, w1 + 1), (arm_row - 2, w1 + 1, w1 + 2)], color)
        # status props
        if c.activity == "thinking" and c.online:
            self.thought(c, x0, y_body, now)
        if c.worried and c.activity != "out":
            self.cells(x0, y_body, [(0, w0 - 1, w0 - 1), (1, w0 - 1, w0 - 1)], "#6A9BCC")  # sweat drop
        if c.leader:
            self.cv.create_text((c.x) * self.px, (y_body - 2.2) * self.px, text="★", fill="#E3B23C",
                                font=("Segoe UI Symbol", max(7, int(self.px * 1.8))))

    def face(self, c, x0, y, now):
        mood = c.mood
        blinking = now > c.blink_at - 0.15 and mood not in ("asleep",)
        look = c.look or (c.facing if mood in ("talk", "focus", "worried") else 0)
        ey = 2 - (1 if mood == "up" else 0)
        lx, rx = 5 + look, 8 + look
        if mood == "asleep" or blinking:
            for ex in (lx, rx):
                self.cv.create_rectangle((x0 + ex) * self.px, (y + ey + 0.6) * self.px, (x0 + ex + 1) * self.px,
                                         (y + ey + 1.0) * self.px, fill=EYE, width=0)
            return
        if mood == "happy":
            for ex in (lx, rx):
                self.cells(x0, y, [(ey, ex - 1, ex - 1), (ey - 1, ex, ex), (ey, ex + 1, ex + 1)], EYE)
            return
        if mood == "worried":
            self.cells(x0, y, [(ey, lx, lx), (ey, rx, rx), (ey - 1, lx - 1, lx - 1), (ey - 1, rx + 1, rx + 1)], EYE)
            return
        if mood == "frantic":
            # huge eyes with tiny jittering pupils
            j = int(now * 12) % 2
            for ex in (lx - 1, rx):
                self.cells(x0, y, [(ey - 1, ex, ex + 1), (ey, ex, ex + 1)], INK)
                self.cells(x0, y, [(ey - 1 + j, ex + j, ex + j)], EYE)
            return
        if mood == "hacker":
            # pink sunglasses and a smug little smirk
            self.cells(x0, y, [(ey - 1, 4, 5), (ey - 1, 8, 9), (ey, 3, 3), (ey, 6, 7), (ey, 10, 10)], "#E88BB7")
            self.cells(x0, y, [(ey, 4, 5), (ey, 8, 9)], "#2b1d2b")
            self.cells(x0, y, [(ey + 3, 6, 7), (ey + 2, 8, 8)], EYE)
            return
        if mood == "thonk":
            # one eyebrow way up, the other flat and low, a slanted mouth
            self.cells(x0, y, [(ey, 5, 5), (ey, 8, 8)], EYE)
            self.cells(x0, y, [(ey - 2, 4, 5), (ey - 1, 6, 6)], EYE)  # the raised brow
            self.cells(x0, y, [(ey - 1, 7, 9)], EYE)  # the flat brow
            self.cells(x0, y, [(ey + 2, 5, 6), (ey + 3, 7, 8)], EYE)  # the mouth
            return
        if mood == "smug":
            # half-lidded, glancing sideways, lips pursed for a sip
            self.cells(x0, y, [(ey, 4, 5), (ey, 8, 9)], EYE)  # heavy lids
            self.cells(x0, y, [(ey + 1, 5, 5), (ey + 1, 9, 9)], EYE)  # pupils looking at the tea
            self.cells(x0, y, [(ey + 3, 6, 6)], EYE)  # a tiny 'o'
            return
        if mood == "xx":
            for ex in (lx, rx):
                self.cells(x0, y, [(ey - 1, ex - 1, ex - 1), (ey - 1, ex + 1, ex + 1), (ey, ex, ex),
                                   (ey + 1, ex - 1, ex - 1), (ey + 1, ex + 1, ex + 1)], EYE)
            return
        if mood == "teary":
            self.cells(x0, y, [(ey, lx, lx), (ey, rx, rx), (ey - 1, lx - 1, lx - 1), (ey - 1, rx + 1, rx + 1)], EYE)
            self.cells(x0, y, [(ey + 1, lx, lx), (ey + 2, lx, lx), (ey + 1, rx, rx), (ey + 2, rx, rx)], "#6A9BCC")
            return
        self.cells(x0, y, [(ey, lx, lx), (ey, rx, rx)], EYE)
        if mood == "talk" and int(now * 6) % 2:
            self.cells(x0, y, [(ey + 2, 6 + look, 7 + look)], EYE)

    def chin_pose(self, c, x0, y, h, w0, w1, color):
        """Hand on the chin, finger out (the 🤔 pose); the tea version holds a steaming cup in the other hand."""
        arm_row = max(0, h // 2)
        self.cells(x0, y, [(arm_row, w0 - 2, w0 - 1), (arm_row + 1, w0 - 2, w0 - 1)], color)  # the left arm, relaxed
        hand = ORANGE_DARK
        self.cells(x0, y, [(6, 4, 5), (7, 4, 5), (6, 6, 7)], hand)  # fist under the mouth, finger along the chin
        if c.mood == "smug":
            self.cells(x0, y, [(arm_row - 1, w1 + 1, w1 + 2), (arm_row, w1 + 1, w1 + 2)], color)  # arm raised
            self.cells(x0, y, [(arm_row - 3, w1 + 1, w1 + 3), (arm_row - 2, w1 + 1, w1 + 3)], "#f0eee6")  # teacup
            self.cells(x0, y, [(arm_row - 3, w1 + 4, w1 + 4)], "#f0eee6")  # its handle
        else:
            self.cells(x0, y, [(arm_row, w1 + 1, w1 + 2), (arm_row + 1, w1 + 1, w1 + 2)], color)

    def lap_laptop(self, c, x0, y, h, w0, w1, now, color):
        """The Claude Code pose: laptop on the lap, lid toward us, both hands tapping the keys."""
        top = h - 4
        if c.dramatic:  # the hacker's toy laptop: blue lid, a bold logo, a red base with candy-coloured keys
            self.cells(x0, y, [(r, w0 - 1, w1 + 1) for r in range(top, h)], "#3b6fd4")
            self.cells(x0, y, [(top + 1, 5, 8)], "#f0eee6")
            self.cells(x0, y, [(top + 2, 6, 7)], "#E3B23C")
            self.cells(x0, y, [(h - 1, w0 - 2, w1 + 2)], "#d9562b")
            for i, col in enumerate(range(w0 - 1, w1 + 2, 2)):
                self.cells(x0, y, [(h - 1, col, col)], ("#E3B23C", "#3ad15a", "#6A9BCC")[i % 3])
        else:
            self.cells(x0, y, [(r, w0 - 1, w1 + 1) for r in range(top, h)], "#5e5d59")  # the lid's back
            self.cells(x0, y, [(top + 1, 6, 7)], "#a3a29b")  # a little logo
            self.cells(x0, y, [(h - 1, w0 - 2, w1 + 2)], "#3d3d3a")  # keyboard edge
        tap = int(now * (24 if c.dramatic else 9)) % 2
        # arms come in from the sides and their hands land on the keyboard, one after the other
        self.cells(x0, y, [(top - 1 + tap, w0 - 2, w0 - 1), (top + tap, w0 - 1, w0)], color)
        self.cells(x0, y, [(top - tap, w1 + 1, w1 + 2), (top + 1 - tap, w1, w1 + 1)], color)

    def thought(self, c, x0, y, now):
        p = self.px
        if c.dramatic:
            return  # posing (🤔 or tea) says it all, no cloud needed
        bx, by = (x0 + 13) * p, (y - 4) * p
        self.cv.create_oval(bx - 0.6 * p, by + 2.4 * p, bx + 0.4 * p, by + 3.4 * p, fill=INK, width=0)
        self.cv.create_oval(bx + 0.5 * p, by + 0.8 * p, bx + 2 * p, by + 2.2 * p, fill=INK, width=0)
        self.cv.create_oval(bx + 1.5 * p, by - 4 * p, bx + 9 * p, by + 0.8 * p, fill=INK, width=0)
        dots = "." * (int(now * 2) % 3 + 1)
        text = "?" if int(now / 3) % 3 == 2 else dots
        self.cv.create_text(bx + 5.2 * p, by - 1.7 * p, text=text, fill=EYE, font=("Segoe UI", max(7, int(p * 1.9)), "bold"))

    def banner(self, text, x, y, now, dramatic):
        """Big shouted words over the crew, outlined so they read on any desktop, with a little bounce."""
        p = self.px
        size = max(10, int(p * (4.2 if dramatic else 3.4)))
        cx, cy = x * p, (y - (1 if int(now * 4) % 2 else 0)) * p
        f = ("Segoe UI Black", size, "bold")
        for dx, dy in ((-2, 0), (2, 0), (0, -2), (0, 2), (-2, -2), (2, 2), (-2, 2), (2, -2)):
            self.cv.create_text(cx + dx, cy + dy, text=text, fill="#141413", font=f)
        self.cv.create_text(cx, cy, text=text, fill="#E3B23C" if dramatic and int(now * 6) % 2 else ORANGE, font=f)

    def whiteboard(self, m, ground, now):
        """The easel whiteboard; the diagram draws itself bit by bit while the host presents."""
        p = self.px
        t = now - m["start"]
        bx = m["board"]
        top, bottom = ground - 21, ground - 8
        self.cells(bx - 9, top, [(r, 0, 18) for r in range(bottom - top)], "#a3a29b")  # frame
        self.cells(bx - 8, top + 1, [(r, 0, 16) for r in range(bottom - top - 2)], "#f6f5f0")  # board
        self.cells(bx - 7, bottom, [(r, 0, 0) for r in range(8)], "#5e5d59")  # easel legs
        self.cells(bx + 7, bottom, [(r, 0, 0) for r in range(8)], "#5e5d59")
        self.cells(bx - 2, bottom, [(0, 0, 4)], "#3d3d3a")  # marker tray
        cv, teal, red = self.cv, "#2aa3a3", "#c0392b"
        f = ("Segoe UI", max(5, int(p * 1.05)), "bold")
        steps = [
            lambda: cv.create_text(bx * p, (top + 2.2) * p, text=(m["text"] or "THE PLAN").upper(), fill=red, font=f),
            lambda: cv.create_oval((bx - 7) * p, (top + 4) * p, (bx - 1) * p, (top + 7) * p, outline=teal, width=max(1, p // 3)),
            lambda: cv.create_text((bx - 4) * p, (top + 5.5) * p, text="TASKS", fill=teal, font=f),
            lambda: cv.create_oval((bx + 1) * p, (top + 4) * p, (bx + 7) * p, (top + 7) * p, outline=teal, width=max(1, p // 3)),
            lambda: cv.create_text((bx + 4) * p, (top + 5.5) * p, text="CREW", fill=teal, font=f),
            lambda: cv.create_line(bx * p, (top + 7.2) * p, bx * p, (top + 8.6) * p, fill=red, width=max(1, p // 3), arrow="last"),
            lambda: cv.create_oval((bx - 5) * p, (top + 8.8) * p, (bx + 5) * p, (top + 11.6) * p, outline=teal, width=max(1, p // 3)),
            lambda: cv.create_text(bx * p, (top + 10.2) * p, text="SHIP IT", fill=teal, font=f),
        ]
        for draw in steps[: int(t / 0.8) + 1]:
            draw()

    def chair(self, x, ground):
        """A little black office chair, facing the whiteboard (seat on the left, backrest on the right)."""
        self.cells(x - 5, ground - 2, [(0, 0, 10)], "#2b2b2e")  # seat
        self.cells(x + 4, ground - 10, [(r, 0, 1) for r in range(8)], "#2b2b2e")  # backrest
        self.cells(x, ground - 1, [(0, -3, 3)], "#4a4a50")  # base

    def mini_desk(self, desk, ground, now):
        """The subagents' little table, a tiny laptop at each seat and a tiny pair of hands tapping away."""
        a = desk["x"] - desk["width"] / 2 - 1
        b = desk["x"] + desk["width"] / 2 + 1
        self.cells(a, ground - 3, [(0, 0, b - a)], "#8a6a4a")  # table top
        self.cells(a, ground - 2, [(0, 0, 0), (1, 0, 0)], "#6b4f35")  # legs
        self.cells(b, ground - 2, [(0, 0, 0), (1, 0, 0)], "#6b4f35")
        for i, seat in enumerate(desk["seats"]):
            if seat not in desk.get("by", {}).values():
                continue  # an empty seat has no laptop
            self.cells(seat - 1.5, ground - 4, [(0, 0, 2)], "#5e5d59")  # the laptop's lid, from behind
            self.cells(seat - 0.5, ground - 4, [(0, 0, 0)], "#a3a29b")  # tiny logo
            if seat in desk.get("seated", ()):  # hands only once someone's actually sitting there
                tap = (int(now * 10) + i) % 2
                self.cells(seat - 2.5 if tap else seat + 1.5, ground - 4, [(0, 0, 0)], ORANGE)  # tap tap

    def table(self, seats, ground):
        """A long table in front of the seats, with a coffee mug."""
        xs = sorted(seats.values())
        a, b = xs[0] - 9, xs[-1] + 4
        self.cells(a, ground - 5, [(0, 0, b - a), (1, 0, b - a)], "#8a6a4a")
        self.cells(a + 1, ground - 3, [(r, 0, 0) for r in range(3)], "#6b4f35")
        self.cells(b - 1, ground - 3, [(r, 0, 0) for r in range(3)], "#6b4f35")
        self.cells(a + 4, ground - 7, [(0, 0, 1), (1, 0, 1)], "#f0eee6")  # mug
        self.cells(a + 6, ground - 7, [(0, 0, 0)], "#f0eee6")

    def storm(self, cols, now):
        """A storm cloud and a moon over the funeral."""
        p = self.px
        self.cv.create_text((cols - 9) * p, 4 * p, text="☾", fill="#e8e6dc", font=("Segoe UI Symbol", max(10, int(p * 4))))
        for i, (cx, r) in enumerate(((14, 5), (24, 6.5), (36, 5.5), (50, 7), (64, 5.5), (78, 6.5), (90, 5))):
            drift = math.sin(now * 0.5 + i) * 1.2
            self.cv.create_oval((cx + drift - r * 1.6) * p, (2.5 - r * 0.55) * p, (cx + drift + r * 1.6) * p,
                                (2.5 + r * 0.55) * p, fill="#3d3d4a", width=0)

    def grave(self, c, ground, now, funeral):
        """The tombstone (with flowers and a candle) and the little ghost floating above it."""
        since = funeral["start"]
        x0 = c.x - 7
        stone, shade = "#8A8580", "#6b6862"
        rise = min(1.0, (now - since - 2.5) / 1.2)  # the stone rises out of the ground
        top = ground - 10 * rise
        rows = [(0, 4, 9), (1, 3, 10)] + [(r, 2, 11) for r in range(2, 10)]
        self.cells(x0, top, [(r, a, b) for r, a, b in rows if top + r < ground], stone)
        self.cells(x0, top, [(r, 11, 11) for r in range(2, 10) if top + r < ground], shade)
        if rise >= 1:
            p = self.px
            self.cv.create_text(c.x * p, (top + 3.6) * p, text="RIP", fill="#3d3d3a",
                                font=("Segoe UI", max(6, int(p * 1.5)), "bold"))
            self.cv.create_text(c.x * p, (top + 6.6) * p, text=c.name.strip()[:7] or "pookie", fill="#3d3d3a",
                                font=("Segoe UI", max(5, int(p * 1.05))))
            self.cells(x0, ground - 1, [(0, -1, 14)], "#5b4636")  # fresh dirt
            for col in (0, 13):  # flowers
                self.cells(x0, ground - 3, [(0, col, col)], "#C46686")
                self.cells(x0, ground - 2, [(0, col, col)], "#788C5D")
            for dx, color in funeral["flowers"]:  # the ones the crew laid down
                fx = c.x + dx
                self.cells(fx, ground - 2, [(0, 0, 0)], "#788C5D")
                self.cells(fx, ground - 3, [(0, -1, 1)], color)
                self.cells(fx, ground - 4, [(0, 0, 0)], color)
            self.cells(x0, ground - 3, [(0, 15, 15), (1, 15, 15)], "#f0eee6")  # candle
            self.cells(x0, ground - 4, [(0, 15, 15)], "#E3B23C" if int(now * 7) % 2 else ORANGE)
            self.ghost(c, x0, ground, now, since)

    def ghost(self, c, x0, ground, now, since):
        up = min(9.0, (now - since - 3.5) * 4)  # floats up out of the grave
        if up <= 0:
            return
        y = ground - 11 - up + math.sin(now * 2.2) * 0.8
        g = "#e8e6dc"
        self.cells(x0, y, [(r, 3, 10) for r in range(6)] + [(2, 1, 2), (2, 11, 12), (3, 1, 1), (3, 12, 12)], g)
        wave = int(now * 4) % 2
        self.cells(x0, y, [(6, col, col) for col in ((3, 5, 7, 9) if wave else (4, 6, 8, 10))], g)
        self.cells(x0, y, [(2, 5, 5), (2, 8, 8)], "#5e5d59")
        p = self.px
        self.cv.create_oval((x0 + 4) * p, (y - 2) * p, (x0 + 10) * p, (y - 0.8) * p, outline="#E3B23C",
                            width=max(1, p // 2))

    def mini(self, c, ground):
        # a half-size Clawd: 5-wide body, two eyes, stubby arms, two legs, with squash and stretch
        sq = 1 if c.squash else (-1 if c.vy > 0.6 else 0)
        h = 4 - sq  # squashed: shorter and wider; stretched: taller and thinner
        a, b = 1 - max(sq, 0) + max(-sq, 0), 5 + max(sq, 0) - max(-sq, 0)
        x0 = c.x - 3.5 + c.wobble
        y = ground - 2 - h - c.jump
        self.cells(x0, y, [(r, a, b) for r in range(h)], ORANGE)
        self.cells(x0, y, [(h // 2, a - 1, a - 1), (h // 2, b + 1, b + 1)] if c.vy <= 0.6 else
                   [(0, a - 1, a - 1), (0, b + 1, b + 1)], ORANGE)  # arms fly up mid-leap
        legs = [(h, 2, 2), (h, 4, 4), (h + 1, 2, 2), (h + 1, 4, 4)]
        if c.legs or sq > 0:
            legs = [(h, 2, 2), (h, 4, 4), (h + 1, 1, 1), (h + 1, 5, 5)]
        self.cells(x0, y, legs, ORANGE)
        self.cells(x0, y, [(1, 2, 2), (1, 4, 4)], EYE)

    def bubble(self, c, ground, now, placed):
        """Draws c's speech bubble, lifted above any bubble already drawn this frame that it would overlap."""
        if not c.bubble or c.bubble[1] < now:
            return
        p = self.px
        text = c.bubble[0]
        cx = c.x * p
        top = (ground - 21 - c.jump - c.bubble_lift) * p
        f = ("Segoe UI", max(7, int(p * 1.7)))
        tid = self.cv.create_text(cx, top, text=text, fill=EYE, font=f)
        x1, y1, x2, y2 = self.cv.bbox(tid)
        pad = p * 0.8
        for _ in range(4):
            hit = next((b for b in placed if x1 - pad < b[2] and x2 + pad > b[0] and y1 - pad < b[3] and y2 + pad > b[1]), None)
            if not hit:
                break
            lift = (y2 + pad) - (hit[1] - pad * 0.5)
            self.cv.move(tid, 0, -lift)
            x1, y1, x2, y2 = self.cv.bbox(tid)
        placed.append((x1 - pad, y1 - pad, x2 + pad, y2 + pad))
        self.round_rect(x1 - pad, y1 - pad * 0.6, x2 + pad, y2 + pad * 0.6, p, INK)
        self.cv.create_polygon(cx - p, y2 + pad * 0.6, cx + p * 0.4, y2 + pad * 0.6, cx - p * 0.6, y2 + pad * 0.6 + p * 1.4,
                               fill=INK, width=0)
        self.cv.tag_raise(tid)

    def round_rect(self, x1, y1, x2, y2, r, color):
        cv = self.cv
        cv.create_rectangle(x1 + r, y1, x2 - r, y2, fill=color, width=0)
        cv.create_rectangle(x1, y1 + r, x2, y2 - r, fill=color, width=0)
        for ox, oy in ((x1, y1), (x2 - 2 * r, y1), (x1, y2 - 2 * r), (x2 - 2 * r, y2 - 2 * r)):
            cv.create_oval(ox, oy, ox + 2 * r, oy + 2 * r, fill=color, width=0)

    def particle(self, pt):
        p = self.px
        x, y = pt["x"] * p, pt["y"] * p
        k = pt["kind"]
        if k == "confetti":
            self.cv.create_rectangle(x, y, x + p * 0.9, y + p * 0.6, fill=pt["color"], width=0)
        elif k in ("sweat", "tear"):
            self.cv.create_oval(x, y, x + p * 0.8, y + p * 1.1, fill="#6A9BCC", width=0)
        elif k == "matrix":
            self.cv.create_text(x, y, text=pt["char"], fill="#3ad15a" if pt["life"] > 0.5 else "#1f7a33",
                                font=("Consolas", max(6, int(p * 1.5)), "bold"))
        elif k == "rain":
            self.cv.create_line(x, y, x - p * 0.3, y + p * 1.4, fill="#6A9BCC", width=max(1, p // 4))
        elif k == "dirt":
            self.cv.create_rectangle(x, y, x + p * 0.8, y + p * 0.8, fill="#5b4636", width=0)
        else:
            char = {"heart": "♥", "spark": "✦", "z": pt.get("char", "z"), "note": pt.get("char", "♪")}.get(k, pt["char"])
            color = {"heart": "#C46686", "spark": "#E3B23C", "code": "#88b0d8"}.get(k, pt["color"])
            size = max(6, int(p * (1.5 if k == "code" else 1.9)))
            self.cv.create_text(x, y, text=char, fill=color, font=("Consolas" if k == "code" else "Segoe UI Symbol", size))


# ---------------------------------------------------------------- the window


class App:
    def __init__(self, args):
        conf = crew_config()
        self.relay = args.relay or conf.get("relayUrl", "")
        self.me = args.name or conf.get("name", "")
        key = args.key or conf.get("key", "")
        self.prefs = load_json(PREFS, {})
        self.size = self.prefs.get("size", "medium")
        self.pinned = self.prefs.get("pinned", True)
        def reread():
            c = crew_config()
            return c.get("relayUrl", ""), c.get("key", ""), c.get("name", "")
        given = args.relay or args.key or args.name or args.demo  # set on the command line: stick to it
        self.feed = Feed(self.relay, key, self.me, args.demo or not (self.relay and key), None if given else reread)
        self.demo = args.demo or not (self.relay and key)

        self.root = tk.Tk()
        self.root.title("Clawds")
        self.root.overrideredirect(True)
        self.root.configure(bg=KEY_COLOR)
        try:
            self.root.attributes("-transparentcolor", KEY_COLOR)
        except tk.TclError:
            pass  # not Windows: the background just shows
        self.canvas = tk.Canvas(self.root, bg=KEY_COLOR, highlightthickness=0, bd=0)
        self.canvas.pack(fill="both", expand=True)
        self.menu = tk.Menu(self.root, tearoff=0)
        self.pin_var = tk.BooleanVar(value=self.pinned)
        self.menu.add_checkbutton(label="Pin on top", variable=self.pin_var, command=self.toggle_pin)
        sizes = tk.Menu(self.menu, tearoff=0)
        for s in SIZES:
            sizes.add_command(label=s.capitalize(), command=lambda s=s: self.resize(s))
        self.menu.add_cascade(label="Size", menu=sizes)
        self.menu.add_command(label="Party!", command=self.party)
        self.menu.add_command(label="Crew log (every message, live)", command=self.open_log)
        # Closes itself a minute after your Claude leaves the crew, unless you tick this
        self.seen_me, self.away_since, self.err_since = False, None, None
        self.keep_var = tk.BooleanVar(value=False)
        self.menu.add_checkbutton(label="Keep open after I leave", variable=self.keep_var)
        self.menu.add_separator()
        self.menu.add_command(label="Close the Clawds", command=self.quit)
        self.canvas.bind("<ButtonPress-1>", self.press)
        self.canvas.bind("<B1-Motion>", self.drag)
        self.canvas.bind("<ButtonRelease-1>", self.release)
        self.canvas.bind("<Button-3>", lambda e: self.menu.tk_popup(e.x_root, e.y_root))
        self.layout()
        self.toggle_pin(save=False)
        self.last = time.time()
        self.tick()

    def layout(self):
        self.px = SIZES.get(self.size, 5)
        self.cols, self.rows = 110, 47
        self.ground = self.rows - 14
        w, h = self.cols * self.px, self.rows * self.px
        if not hasattr(self, "world"):
            self.world = World(self.cols, self.ground)
        self.painter = Painter(self.canvas, self.px)
        sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        x = self.prefs.get("x", sw - w - 24)
        y = self.prefs.get("y", sh - h - 64)
        # keep it reachable, anywhere on the whole desktop (a second monitor too, even left of or above the main one)
        vx, vy, vw, vh = desktop_bounds(sw, sh)
        x, y = max(vx, min(vx + vw - 80, x)), max(vy, min(vy + vh - 60, y))
        self.root.geometry(f"{w}x{h}+{x}+{y}")
        self.canvas.config(width=w, height=h)

    def save(self):
        self.prefs.update(size=self.size, pinned=self.pinned, x=self.root.winfo_x(), y=self.root.winfo_y())
        try:
            os.makedirs(os.path.dirname(PREFS), exist_ok=True)
            with open(PREFS, "w", encoding="utf-8") as f:
                json.dump(self.prefs, f)
        except OSError:
            pass

    def toggle_pin(self, save=True):
        self.pinned = self.pin_var.get()
        self.root.attributes("-topmost", self.pinned)
        if save:
            self.save()

    def resize(self, size):
        self.size = size
        self.save()
        self.layout()

    def party(self):
        for c in self.world.clawds.values():
            if c.activity == "idle":
                c.behavior, c.until = "party", time.time() + 8
        self.world.burst(self.cols / 2, self.ground - 14, "confetti", 50)

    def quit(self):
        self.save()
        self.root.destroy()

    def open_log(self):
        """The crew log window, next to this one (it brings itself forward if it's already open)."""
        import subprocess
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "crew_log.py")
        flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        try:
            subprocess.Popen([sys.executable, script], creationflags=flags, close_fds=True)
        except OSError:
            pass

    def listen(self, server):
        """Another launch knocked: come to the front instead of a second window opening."""
        def serve():
            while True:
                try:
                    conn, _ = server.accept()
                    conn.close()
                    self.root.after(0, self.come_forward)
                except OSError:
                    return
        threading.Thread(target=serve, daemon=True).start()

    def come_forward(self):
        self.root.deiconify()
        self.root.lift()
        self.root.attributes("-topmost", True)
        if not self.pinned:  # just a moment on top, then back to how they had it
            self.root.after(1500, lambda: self.root.attributes("-topmost", self.pinned))
        for c in self.world.clawds.values():
            if not c.hidden and c.online:
                c.hop(2.5)
        clawds = [c for c in self.world.clawds.values() if not c.hidden]
        if clawds:
            random.choice(clawds).say(random.choice(["we're right here!", "hi again!", "you rang?"]), 2)

    # dragging moves the window; a click without a drag pokes a Clawd or hits a button
    def press(self, e):
        self.drag_from = (e.x_root - self.root.winfo_x(), e.y_root - self.root.winfo_y())
        self.dragged = False

    def drag(self, e):
        self.dragged = True
        dx, dy = self.drag_from
        self.root.geometry(f"+{e.x_root - dx}+{e.y_root - dy}")

    def release(self, e):
        if self.dragged:
            return self.save()
        cell_x, cell_y = e.x / self.px, e.y / self.px
        if cell_y > self.ground + 8.5 and cell_x > self.cols - 7:
            return self.quit()
        if cell_y > self.ground + 8.5 and cell_x > self.cols - 14:
            self.pin_var.set(not self.pinned)
            return self.toggle_pin()
        hit = min(self.world.clawds.values(), key=lambda c: abs(c.x - cell_x), default=None)
        if hit and abs(hit.x - cell_x) < 8 and cell_y < self.ground + 1:
            hit.hop(3)
            word = STATUS_WORDS.get(hit.activity, "") or "just vibing"
            hit.say(f"{hit.name.strip() or 'Clawd'}: {word}", 2.5)

    def tick(self):
        now = time.time()
        dt = now - self.last
        self.last = now
        snap, err = self.feed.read()
        self.relay, self.me, self.demo = self.feed.relay, self.feed.name, self.feed.demo  # settings can change
        if err and not self.demo:
            # The relay is unreachable: we can't know what anyone is doing, so nobody stays frozen mid-"thinking".
            self.err_since = self.err_since or now
            if snap and now - self.err_since > 5:
                snap = dict(snap, peers=[dict(p, online=False) for p in snap.get("peers", [])])
        else:
            self.err_since = None
        self.world.sync(snap, self.me)
        self.world.step(dt)
        if self.closing_in(snap, err, now) == 0:
            return self.quit()
        self.draw(snap, err, clock())
        # Full speed while anything moves; a few frames a second when the stage is empty or the relay is down.
        quiet = (err and not self.demo) or not any(not c.gone for c in self.world.clawds.values())
        self.root.after(int(1000 / (4 if quiet else FPS)), self.tick)

    def closing_in(self, snap, err, now):
        """Once your own Claude has left the crew (or the relay is gone) for a while, the show's over: the
        Clawds get CLOSE_AFTER seconds to make their exits, then the window closes. Seconds left, or None."""
        if self.demo or self.keep_var.get():
            return None
        me = next((x for x in (snap or {}).get("peers", []) if x.get("name") == self.me), None)
        here = not err and me is not None and me.get("online")
        if here:
            self.seen_me, self.away_since = True, None
            return None
        if not self.seen_me:
            return None  # your Claude hasn't been here yet (say, the relay is still starting): nothing to end
        if self.away_since is None:
            self.away_since = now
        return max(0, int(CLOSE_AFTER - (now - self.away_since)))

    def draw(self, snap, err, now):
        cv, p = self.canvas, self.px
        cv.delete("all")
        w = self.cols * p
        g = self.ground
        funeral = self.world.funeral
        if funeral:
            self.painter.storm(self.cols, now)
        # the little stage the Clawds stand on, with the crew's info
        self.painter.round_rect(0, (g + 0.2) * p, w, self.rows * p - 1, p * 1.5, PANEL)
        cv.create_line(p * 2, (g + 0.2) * p, w - p * 2, (g + 0.2) * p, fill=PANEL_EDGE, width=max(1, p // 3))
        clawds = sorted(self.world.clawds.values(), key=lambda c: c.x)
        meeting = self.world.meeting
        if meeting:
            self.painter.whiteboard(meeting, g, now)
            for x in meeting["seats"].values():
                self.painter.chair(x, g)
        for pt in self.world.particles:  # the Matrix rains *behind* the hacker
            if pt["kind"] == "matrix":
                self.painter.particle(pt)
        for c in clawds:
            label = c.name.strip()
            if label and self.me and c.name == self.me:
                label += " (you)"
            if label and not c.gone and not (c.hidden and c.trip):
                word = STATUS_WORDS.get(c.activity, "")
                if funeral and funeral["name"] == c.name:
                    word = "R.I.P. (until the reset)"
                cv.create_text(c.x * p, (g + 4.6) * p, text=label, fill=INK if c.online else DIM,
                               font=("Segoe UI", max(7, int(p * 1.6)), "bold"))
                if word or not c.online:
                    cv.create_text(c.x * p, (g + 6.8) * p, text=word if c.online else "offline", fill=DIM,
                                   font=("Segoe UI", max(6, int(p * 1.35))))
        host = self.relay.replace("http://", "").replace("https://", "") or "no relay"
        leader = (snap or {}).get("leader") or "none"
        online = sum(1 for x in (snap or {}).get("peers", []) if x.get("online"))
        if self.demo:
            info = "demo crew · set up /crew to see your own"
        elif err:
            info = f"○ {host} · {friendly(err)}"
        else:
            info = f"● {host} · leader {leader} · {online} online"
        left = self.closing_in(snap, err, time.time())
        if left is not None:
            info += f" · closing in {left}s (right-click to keep it)"
        cv.create_text(p * 2.5, (self.rows - 2.6) * p, text=info, anchor="w", fill=DIM,
                       font=("Segoe UI", max(6, int(p * 1.35))))
        cv.create_text(w - p * 11, (self.rows - 2.6) * p, text="◉ pinned" if self.pinned else "○ pin",
                       fill=INK if self.pinned else DIM, font=("Segoe UI", max(6, int(p * 1.35))))
        cv.create_text(w - p * 3.5, (self.rows - 2.6) * p, text="✕", fill=DIM, font=("Segoe UI", max(7, int(p * 1.5))))
        for c in clawds:
            for m in c.minis:
                self.painter.clawd(m, g, now)
            if funeral and funeral["name"] == c.name and now - funeral["start"] > 2.5:
                self.painter.grave(c, g, now, funeral)
            else:
                self.painter.trip_props(c, g, now, before=True)
                self.painter.clawd(c, g, now)
                self.painter.trip_props(c, g, now, before=False)
        if meeting:
            self.painter.table(meeting["seats"], g)
        if self.world.desk:
            self.painter.mini_desk(self.world.desk, g, now)
        for pt in self.world.particles:
            if pt["kind"] != "matrix":
                self.painter.particle(pt)
        placed = []
        for c in sorted(clawds, key=lambda c: -(c.bubble[1] if c.bubble else 0)):
            self.painter.bubble(c, g, now, placed)
        huddle = getattr(self.world, "huddle", None)
        if huddle and now - huddle["start"] > 1.6:
            self.painter.banner("CLAUDE'S PLAN!!", huddle["x"], g - 23, now, huddle["dramatic"])
        if self.world.flash:
            cv.create_rectangle(0, 0, w, g * p, fill="#f0eee6", stipple="gray25", width=0)


def main():
    ap = argparse.ArgumentParser(description="The Clawds: your crew as little pixel friends")
    ap.add_argument("--relay")
    ap.add_argument("--key")
    ap.add_argument("--name")
    ap.add_argument("--demo", action="store_true", help="a pretend crew, no relay needed")
    ap.add_argument("--drama", type=float, help="chance of the over-the-top versions, 0 to 1 (default 0.2)")
    ap.add_argument("--trip", choices=TRIPS, help="always arrive/leave this way (to try one out)")
    ap.add_argument("--leave-at", type=float, default=44, help="demo: when nova disconnects, in seconds (0-50)")
    ap.add_argument("--multi", action="store_true", help="testing: allow a second window (to compare sync)")
    ap.add_argument("--at", help="testing: put the window at X,Y on screen")
    args = ap.parse_args()
    global FORCE_TRIP, DEMO_LEAVE
    FORCE_TRIP, DEMO_LEAVE = args.trip, args.leave_at
    if args.drama is not None:
        global DRAMA
        DRAMA = max(0.0, min(1.0, args.drama))
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:  # noqa: BLE001 - older Windows: just a little blurrier
            pass
    # One Clawds window at a time: if one is already open, wave at it and bow out.
    server = None
    if not args.multi:
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            if not one_instance("CrewClawdsWindow"):
                raise OSError("already open")
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):  # Windows: no second process may share the port
                server.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            server.bind(("127.0.0.1", ONE_WINDOW_PORT))
            server.listen(4)
        except OSError:
            try:
                socket.create_connection(("127.0.0.1", ONE_WINDOW_PORT), timeout=2).close()
            except OSError:
                pass
            return
    app = App(args)
    if args.at:
        x, y = (int(v) for v in args.at.split(","))
        app.root.geometry(f"+{x}+{y}")
    if server:
        app.listen(server)
    app.root.mainloop()


if __name__ == "__main__":
    main()
