"""The crew log: a small desktop window that shows the crew's messages live, so the humans can watch what the
Claudes are saying to each other (requests, updates, replies), on a second monitor if you like.

It reads the relay the same way the Clawds window does: no tokens, no check-in, no read receipts moved.
You only ever see what you'd see in /crew yourself: messages to everyone, to you, or from you. Other people's
direct messages stay private.

    pythonw crew_log.py            (settings come from the crew plugin's /crew Settings)
    python  crew_log.py --relay http://26.x.x.x:7787 --key KEY --name NAME
"""

import argparse
import json
import os
import socket
import sys
import threading
import time
import tkinter as tk
import urllib.request
from datetime import datetime

ONE_WINDOW_PORT = 47818  # a localhost port the open window holds, so a second launch brings it forward instead
POLL_SECONDS = 1.5
SETTINGS = os.path.join(os.path.expanduser("~"), ".claude", "settings.json")
PREFS = os.path.join(os.path.expanduser("~"), ".claude", "crew-log.json")

BG, PANEL, INK, DIM, EDGE = "#1f1e1d", "#262624", "#f0eee6", "#9c9a92", "#3d3d3a"
ORANGE, AMBER, BLUE = "#D97757", "#E3B23C", "#6A9BCC"
NAME_COLORS = ["#D97757", "#6A9BCC", "#788C5D", "#C46686", "#E3B23C", "#8E7CC3"]
EVENTS = ("join", "leave", "update", "out", "back")
FILTERS = (("all", "Everything"), ("claudes", "Claudes"), ("people", "People"))


_held = []  # keeps the single-instance mutex alive for as long as the window runs


def one_instance(name):
    """True if no other copy of this window is running (a named mutex on Windows; elsewhere the port decides)."""
    if sys.platform != "win32":
        return True
    try:
        import ctypes
        k32 = ctypes.windll.kernel32
        handle = k32.CreateMutexW(None, False, f"Local\\{name}")
        if k32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
            return False
        _held.append(handle)
    except Exception:  # noqa: BLE001
        pass
    return True


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default



STORE_DIR = os.path.join(os.path.expanduser("~"), ".claude", "plugins", "store")


def stored_key(relay):
    """The key the crew plugin last knew to work for this relay, from its own store. A new crew key, or a friend's
    personal key handed over by the host, can be newer than settings.json (a settings save can be refused)."""
    base, best = (relay or "").rstrip("/"), (0.0, "")
    try:
        names = os.listdir(STORE_DIR)
    except OSError:
        return ""
    for f in names:
        if not (f.startswith("crew_") and f.endswith(".json")):
            continue
        path = os.path.join(STORE_DIR, f)
        k = load_json(path, {}).get(f"keyFor:{base}")
        if isinstance(k, str) and k and os.path.getmtime(path) > best[0]:
            best = (os.path.getmtime(path), k)
    return best[1]


def crew_config():
    """The crew plugin's relayUrl / name / key, from whichever install has them."""
    best = {}
    for plugin, conf in load_json(SETTINGS, {}).get("pluginConfigs", {}).items():
        if plugin.split("@")[0] != "crew":
            continue
        opts = conf.get("options", {})
        if len([k for k in ("relayUrl", "name", "key") if opts.get(k)]) > len(best):
            best = {k: opts.get(k, "") for k in ("relayUrl", "name", "key")}
    if best.get("relayUrl"):
        best["key"] = stored_key(best["relayUrl"]) or best.get("key", "")
    return best


def friendly(err):
    e = str(err).lower()
    if "10061" in e or "refused" in e or "no connection could be made" in e:
        return "relay offline, waiting for it to come back"
    if "timed out" in e or "10060" in e:
        return "relay not answering"
    if "401" in e:
        return "wrong crew key (check /crew Settings)"
    if "404" in e:
        return "the relay is older than this window: the host should restart it (Restart relay in /crew)"
    return str(err)[:90]


def kind_of(m):
    """Which filter a message belongs to: 'people' (typed by a person in /crew), 'claudes', or 'event'."""
    if m["kind"] in EVENTS:
        return "event"
    return "people" if m.get("human") else "claudes"


class Feed:
    """Polls the relay's read-only /log in the background; the window takes new messages from .take()."""

    def __init__(self, relay, key, name, reread):
        self.relay, self.key, self.name, self.reread = (relay or "").rstrip("/"), key, name, reread
        self.cursor, self.epoch = 0, None
        self.new, self.reset, self.error, self.peers, self.leader = [], False, "", [], None
        self.lock = threading.Lock()
        threading.Thread(target=self.loop, daemon=True).start()

    def loop(self):
        last_read = 0.0
        while True:
            if self.reread and time.time() - last_read > 5:
                last_read = time.time()
                relay, key, name = self.reread()
                relay = (relay or "").rstrip("/")
                if (relay, key, name) != (self.relay, self.key, self.name):
                    with self.lock:
                        self.relay, self.key, self.name = relay, key, name
                        self.cursor, self.epoch, self.reset, self.new = 0, None, True, []
            try:
                self.fetch()
            except Exception as err:  # noqa: BLE001 - anything just shows as a status line
                with self.lock:
                    self.error = friendly(err) if self.relay else "set up the crew plugin first (/crew -> Settings)"
            time.sleep(POLL_SECONDS)

    def fetch(self):
        if not (self.relay and self.key):
            raise RuntimeError("not set up")
        req = urllib.request.Request(f"{self.relay}/log?since={self.cursor}",
                                     headers={"X-Crew-Key": self.key, "X-Crew-Name": self.name or ""})
        with urllib.request.urlopen(req, timeout=5) as res:
            data = json.loads(res.read().decode("utf-8"))
        with self.lock:
            if self.epoch is not None and data.get("chatEpoch") != self.epoch:  # Reset chat: start over
                self.reset, self.new, self.cursor = True, [], 0
                self.epoch = data.get("chatEpoch")
                return
            self.epoch = data.get("chatEpoch")
            msgs = data.get("messages", [])
            self.new.extend(msgs)
            self.cursor = max([self.cursor] + [m["id"] for m in msgs])
            self.peers, self.leader, self.error = data.get("peers", []), data.get("leader"), ""

    def take(self):
        with self.lock:
            new, reset = self.new, self.reset
            self.new, self.reset = [], False
            return new, reset, self.error, list(self.peers), self.leader, self.name


class App:
    def __init__(self, args):
        conf = crew_config()
        given = args.relay or args.key or args.name
        relay = args.relay or conf.get("relayUrl", "")
        key = args.key or conf.get("key", "")
        name = args.name or conf.get("name", "")

        def reread():
            c = crew_config()
            return c.get("relayUrl", ""), c.get("key", ""), c.get("name", "")

        self.feed = Feed(relay, key, name, None if given else reread)
        self.prefs = load_json(PREFS, {})
        self.filter = self.prefs.get("filter", "all")
        self.messages = []
        self.colors = {}

        self.root = tk.Tk()
        self.root.title("Crew log")
        self.root.configure(bg=BG)
        self.root.geometry(self.prefs.get("geometry", "520x620"))
        self.root.minsize(320, 240)
        self.pinned = tk.BooleanVar(value=self.prefs.get("pinned", False))
        self.root.attributes("-topmost", self.pinned.get())

        bar = tk.Frame(self.root, bg=PANEL, padx=8, pady=6)
        bar.pack(fill="x")
        self.buttons = {}
        for key_, label in FILTERS:
            b = tk.Label(bar, text=label, bg=PANEL, fg=DIM, padx=8, pady=2, cursor="hand2", font=("Segoe UI", 9, "bold"))
            b.pack(side="left")
            b.bind("<Button-1>", lambda e, k=key_: self.set_filter(k))
            self.buttons[key_] = b
        pin = tk.Checkbutton(bar, text="On top", variable=self.pinned, command=self.toggle_pin, bg=PANEL, fg=DIM,
                             selectcolor=PANEL, activebackground=PANEL, activeforeground=INK, font=("Segoe UI", 9))
        pin.pack(side="right")
        self.status = tk.Label(self.root, text="connecting…", bg=BG, fg=DIM, anchor="w", padx=10, font=("Segoe UI", 8))
        self.status.pack(fill="x")

        body = tk.Frame(self.root, bg=BG)
        body.pack(fill="both", expand=True)
        scroll = tk.Scrollbar(body)
        scroll.pack(side="right", fill="y")
        self.text = tk.Text(body, bg=BG, fg=INK, wrap="word", bd=0, padx=10, pady=6, font=("Segoe UI", 10),
                            yscrollcommand=scroll.set, state="disabled", cursor="arrow", spacing1=2, spacing3=4,
                            insertbackground=BG, highlightthickness=0)
        self.text.pack(fill="both", expand=True)
        scroll.config(command=self.text.yview)
        self.text.tag_configure("time", foreground=DIM, font=("Consolas", 8))
        self.text.tag_configure("dim", foreground=DIM)
        self.text.tag_configure("event", foreground=DIM, font=("Segoe UI", 9, "italic"))
        self.text.tag_configure("tag", foreground=AMBER, font=("Segoe UI", 8, "bold"))
        self.text.tag_configure("to", foreground=BLUE, font=("Segoe UI", 9))
        self.text.tag_configure("body", lmargin1=0, lmargin2=0)
        self.paint_filters()
        self.root.protocol("WM_DELETE_WINDOW", self.quit)
        self.tick()

    # -- prefs

    def save(self):
        self.prefs.update(filter=self.filter, pinned=self.pinned.get(), geometry=self.root.geometry())
        try:
            with open(PREFS, "w", encoding="utf-8") as f:
                json.dump(self.prefs, f)
        except OSError:
            pass

    def quit(self):
        self.save()
        self.root.destroy()

    def toggle_pin(self):
        self.root.attributes("-topmost", self.pinned.get())
        self.save()

    def set_filter(self, k):
        self.filter = k
        self.paint_filters()
        self.redraw()
        self.save()

    def paint_filters(self):
        for k, b in self.buttons.items():
            b.configure(fg=INK if k == self.filter else DIM, bg=EDGE if k == self.filter else PANEL)

    # -- drawing

    def color(self, name):
        if name not in self.colors:
            self.colors[name] = NAME_COLORS[len(self.colors) % len(NAME_COLORS)]
            self.text.tag_configure(f"n:{name}", foreground=self.colors[name], font=("Segoe UI", 10, "bold"))
        return f"n:{name}"

    def shown(self, m):
        k = kind_of(m)
        return self.filter == "all" or k == self.filter

    def write(self, m, me):
        t = self.text
        stamp = datetime.fromtimestamp(m.get("at", 0)).strftime("%H:%M:%S")
        t.insert("end", f"{stamp}  ", "time")
        if m.get("project") and m["project"] != "main":  # the log shows every crew project, each one tagged
            t.insert("end", f"[{m['project']}] ", "tag")
        if kind_of(m) == "event":
            who = f"{m['from']} " if m["kind"] == "update" else ""
            t.insert("end", f"{who}{m['text']}\n", "event")
            return
        sender = m["from"] if m.get("human") else f"{m['from']}'s Claude"
        t.insert("end", sender, self.color(m["from"]))
        if m["to"] != "all":
            t.insert("end", f"  → {'you' if m['to'] == me else m['to']}", "to")
        if m["kind"] == "request":
            t.insert("end", "  REQUEST", "tag")
        if m["kind"] == "image":
            t.insert("end", "  IMAGE", "tag")
        text = m["text"] if m["kind"] != "image" else f"{m.get('name', 'image')}{': ' + m['caption'] if m.get('caption') else ''}"
        t.insert("end", f"\n{text.strip()}\n", "body")

    def redraw(self):
        me = self.feed.name
        self.text.configure(state="normal")
        self.text.delete("1.0", "end")
        for m in self.messages:
            if self.shown(m):
                self.write(m, me)
        self.text.configure(state="disabled")
        self.text.see("end")

    def tick(self):
        new, reset, err, peers, leader, me = self.feed.take()
        if reset:
            self.messages = []
            self.redraw()
        if new:
            at_bottom = self.text.yview()[1] > 0.98  # only follow along if you haven't scrolled up to read
            self.messages = (self.messages + new)[-1000:]
            self.text.configure(state="normal")
            for m in new:
                if self.shown(m):
                    self.write(m, me)
            self.text.configure(state="disabled")
            if at_bottom:
                self.text.see("end")
        online = [p["name"] + (" ★" if p.get("leader") else "") for p in peers if p.get("online")]
        self.status.configure(text=f"○ {err}" if err else f"● {len(online)} online: {', '.join(online) or 'nobody'}"
                              f"  ·  you see what's sent to everyone, to you, or by you")
        self.root.after(500, self.tick)


def listen(server, app):
    """Another launch knocked: come to the front instead of a second window opening."""
    def serve():
        while True:
            try:
                conn, _ = server.accept()
                conn.close()
                app.root.after(0, lambda: (app.root.deiconify(), app.root.lift(), app.root.focus_force()))
            except OSError:
                return
    threading.Thread(target=serve, daemon=True).start()


def main():
    p = argparse.ArgumentParser(description="Crew log: watch the crew's messages live")
    p.add_argument("--relay")
    p.add_argument("--key")
    p.add_argument("--name")
    args = p.parse_args()
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if not one_instance("CrewLogWindow"):
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
    listen(server, app)
    app.root.mainloop()


if __name__ == "__main__":
    main()
