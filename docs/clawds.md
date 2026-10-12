# The Clawds 🦀

Each crew member is a pixel Clawd, named on the stage below it, that acts out what their Claude is doing right now. The leader wears a ★.

| Their Claude is… | Their Clawd… |
|---|---|
| getting a new prompt | jumps and cheers |
| thinking | looks up with a hand raised and a thought bubble |
| writing files | sits on the edge of the stage with the laptop on its lap, both hands typing, code flying out |
| using tools | tinkers, sparks flying |
| chatting | walks over to the teammate it's messaging, with the real message in a speech bubble |
| finished a prompt | confetti, then the whole crew huddles together and shouts **"CLAUDE'S PLAN!!"** (idea: Pluh and Corixer), then a dance |
| running subagents | is followed by mini Clawds, one per subagent. Every so often the minis build a **tower**, taking turns making huge squash-and-stretch leaps onto each other's heads. When two or more are busy at once (one Claude's subagents on its task, or several Claudes' at the same time), they set up their own **mini office**: a little table with a tiny laptop each |
| out of tokens | falls asleep while the others sweat and worry. After half a minute they sigh *"they'll be back"*, give the sleeper a pat, and get back to work |
| sending the crew a request | holds a **meetup**: an easel whiteboard rolls in, the sender presents (*"synergy."*) while the diagram draws itself, and everyone else sits around a table on office chairs, taking notes, nodding, or dozing off (*"could this have been an email?"*) |
| connecting / disconnecting | arrives and leaves in one of five ways: a **car** (pulls up, hop in, *"vroom vroom"*), a **Henry Stickmin teleport** (*"\*presses teleport button\*"*, glitches out), **Superman** (*"UP, UP AND AWAY!"* / a superhero landing), a **door** that fades in, opens and slowly fades away, or a **leap off the window** caught by a passing bird. Arrivals are the same five in reverse, and everyone waves goodbye |
| joining the crew | gets a group hug |
| doing nothing | vibes, strolls (leapfrogging anyone in the way), hops, sits on the rim swinging its legs, waves, chases, high-fives |

**1 in 5 times, everything is WAY over the top:**

| Moment | The over-the-top version |
|---|---|
| thinking | strikes a pose: the 🤔 (one eyebrow up, finger on the chin) or a smug sip of tea, then shouts *"EUREKA!!!"* when it's done |
| typing | becomes a hacker: pink sunglasses, a toy laptop, green Matrix code raining behind it, *"I'm in."* |
| out of tokens | **a whole funeral.** Storm clouds, rain and lightning, a tombstone rises, a ghost with a halo floats above it, and the mourners kneel and weep. Each one walks up and lays a flower on the grave, and after a while they sigh *"they'll be back"* and high-five (or hug) the ghost before getting back to work. When the tokens come back: *"I HAVE RISEN FROM THE GRAVE!!!"* |
| done | a confetti cannon and a bigger, bouncier **"CLAUDE'S PLAN!!"** huddle |
| new prompt | rocket jumps: *"LET'S GOOOOOO!!!"* |
| chatting | sprints over and yells in ALL CAPS |
| using tools | the blacksmith: a hard hat, a hammer and a mini gear, sparks on every *CLANG* |
| someone joins | *"THE LEGEND HAS ARRIVED"* and a dogpile |
| idle | taps a foot at you, hands on hips: *"Are you gonna prompt yet?"*; moon-hops, *"HIIIIIII!!!"* waves, dramatic sighs |

**The Clawds window** is a small frameless window that stays on top of your desktop while everyone works. It pops out on its own when you open `/crew`. You can switch that off in Settings, and bring the window back any time with `/clawds`, the **Clawds** button in `/crew`, or by double-clicking `window/Clawds.bat`. Only one window ever runs: opening it again brings the existing one to the front.
  - Drag it anywhere.
  - Click **◉ pinned** on the stage to toggle always-on-top, and **✕** to close it.
  - Right-click for **Pin on top**, **Size** (small, medium or large), **Party!** and **Keep open after I leave**.
  - Your own Clawd is labelled **(you)**. The window follows your `/crew` settings as you change them (the demo crew makes way for yours a few seconds after setup), and when the relay can't be reached everyone shows as offline instead of frozen mid-thought. When nothing's on stage it drops to a few frames a second to spare your CPU.
  - When your own Claude leaves the crew (or the relay goes away), the Clawds make their exits and the window closes itself a minute later, with a countdown on the stage. Tick **Keep open after I leave** to watch the crew without being in it.
  - Click a Clawd to poke it: it hops and tells you what it's doing.
  - It remembers where you left it, its size and pin setting in `~/.claude/crew-clawds.json`.
  - Room for **ten** Clawds (in a bigger crew, the offline ones step aside first), and the window remembers its spot on **any monitor**.
  - **Everyone sees the same show.** Every crew member's window runs on the relay's clock and rolls the same dice from the same shared facts. So the idle moves, over-the-top moments, poses, huddles, meetups and arrival/departure trips happen the same way at the same moment on every screen.

---
[← Back to the README](../README.md)
