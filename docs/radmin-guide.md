# Setup guide: from Radmin VPN to a connected crew

Every step from an empty PC to friends connected in one crew, using [Radmin VPN](https://www.radmin-vpn.com/). Each step ends with **✔ what you should see**, so you know it worked before moving on.

One person is the **host**: their PC runs the relay that connects everyone, so it needs to be on while you work. Everyone else is a **friend**. Steps are marked with who does them.

**You need:**
- Windows (Radmin VPN and parts of crew are Windows-only).
- Claude Code on every PC, each person with their own Claude account. If `claude` doesn't work in a terminal because you only have the desktop app, see the note in step 3.
- **Host only:** Python 3.8 or newer.

Prefer Tailscale or the same Wi-Fi? Then skip steps 1 and 2 and see [Setup](setup.md#2-put-everyone-on-one-network).

---

## Get on one network

### 1. Everyone: install Radmin VPN
Download it from [radmin-vpn.com](https://www.radmin-vpn.com/) (it's free), install it and open it.

✔ The Radmin VPN window is open.

### 2. Make the network
**Host:**
1. Press **Create network**.
2. Choose a network name and a password.
3. Press **Create**.
4. Send your friends the name and password.

**Friends:**
1. Press **Join network**.
2. Enter that name and password.
3. Press **Join**.

✔ Everyone sees the network and each other in the Radmin VPN window. To test a connection, right-click a friend there and choose **ping**.

---

## Install crew

### 3. Everyone: install the plugin
Open a terminal and run these one at a time:

```bash
claude plugin marketplace add Umbyzz/claude-crew
```

```bash
claude plugin install crew@claude-crew
```

Then restart Claude.

*Only have the desktop app?* See [the other ways to install](setup.md#3-everyone-installs-the-plugin).

✔ Typing `/crew` in Claude opens the crew pane.

---

## Host: start the crew

### 4. Install Python
Get it from [python.org](https://www.python.org/downloads/) and, in the installer, tick **Add python.exe to PATH**.

### 5. Start hosting
1. In Claude, type `/crew`.
2. Type your name and press **next**.
3. Press **Host a crew**. If nothing happens, press it again: in the desktop app the first click can just focus the pane.

A window called **Crew relay - keep open while you host** opens. That window *is* the crew: closing it disconnects everyone. Restarting Claude doesn't.

✔ The top of `/crew` says "you host".

### 6. Allow it through the firewall
When Windows Firewall asks about Python, **tick both Private and Public**, then allow it.

Windows often treats the Radmin network as *Public*, so with only Private ticked your friends can't connect, even though everything looks fine on your side. Because this also allows connections on public Wi-Fi, where the crew key is the relay's only lock, close the relay window when you're on a network you don't trust.

If you missed the question, see **"can't reach the relay"** under [If something's wrong](#if-somethings-wrong).

### 7. Send the invite
In `/crew`, open the **Crew** tab and press **Copy invite**. Send that to each friend in a private message, along with the Radmin network name and password if you haven't yet. It contains your address, the crew key and the install steps.

The invite is a key to your crew, so don't post it anywhere public.

---

## Friends: connect

### 8. Join the crew
1. In Claude, type `/crew`.
2. Type your name and press **next**. It must be different from everyone else's.
3. Press **Join a friend's crew**.
4. Paste the **Relay URL** and **Crew key** from the invite, pressing **save** after each. Once both are saved, you're in.

If a message asks you to restart Claude, do that: your Claude Code didn't take the settings, so crew keeps its own copy and connects after the restart.

✔ You show up in everyone's **Crew** tab with a green dot, and a Clawd for you walks into the Clawds window.

Not connecting? **⚙ Settings → Test connection** checks that you can reach the relay.

---

## Host: lock the door (recommended)

### 9. Make them friends
For each person, while they're connected, open the **Crew** tab and press **★ Friend** next to their name. Their personal key reaches them by itself.

### 10. Friends only
Go to **⚙ Settings → Who can join → friends only**.

✔ Your friends stay connected, and a leaked invite now gets nobody in.

---

## You're connected!
The [tutorial](tutorial.md#part-2-start-a-project) takes it from here: start a project, kick off, work together.

**Next time:**
- Everyone opens Radmin VPN and makes sure they're in the network.
- **Host:** if the relay window is closed, open `/crew` and press **▶ Start relay**.
- Everyone opens Claude and types `/crew`. If it asks, press **Rejoin session**.

---

## If something's wrong

| What you see | What to do |
|---|---|
| **Can't reach the relay** | **Host:** is the relay window open? Then check the firewall: Windows Security → **Firewall & network protection** → **Allow an app through firewall**, and tick both **Private** and **Public** for Python. **Everyone:** is Radmin VPN on and showing the same network? |
| **Ping doesn't work either** | It's Radmin, not crew. See [Radmin's help page](https://www.radmin-vpn.com/help/), including its firewall setup for antivirus programs. |
| **"… has a personal key"** | You're on the host's friends list, so the shared key no longer works for you. The host opens the **Crew** tab → **Friends** card → **Copy invite** next to your name. Paste that key in **⚙ Settings → Crew key**, using exactly that name. |
| **"this crew is friends-only"** | The host opens the **Crew** tab → **Friends** card, types your exact crew name in the box and presses Enter. That copies a personal invite to send you. |
| **Everyone suddenly drops** | The host's relay window closed or their PC went to sleep. The host presses **▶ Start relay** in `/crew`, and everyone reconnects by themselves. |
| **"Port 7787 is taken by another program"** | The relay window names the program. Close it, then press **▶ Start relay** again. |

More in [Troubleshooting](troubleshooting.md).

---
[← Back to the README](../README.md)
