"""Stage backdrops for the Clawds window: one per kind of project, picked at the crew's kickoff.

    import stages
    stages.still(painter, theme, cols, ground)         # once: what never changes, to keep on the canvas
    stages.live(painter, theme, cols, ground, now)     # every drawing: only what moves, painted over it
    stages.draw(painter, theme, cols, ground, now)     # both at once, for a window that redraws everything

All of it goes after the stage panel and before the Clawds. What live() draws always sits on top of the still
part, so nothing that moves is meant to pass behind something still (the waves stop short at the pier's
pilings rather than slide under them).

A backdrop is the stage's surface plus set dressing on and around it. Above the stage the window stays
see-through (the Clawds stand on your desktop), so nothing here paints a sky. It is all in the fine cells
Clawds 2.0 draws on: the stage is 220 wide, its line is at row 66, and a Clawd's body is 20 x 14. It draws
only with painter.cells(x0, y0, rows, color, alpha) and, for solid blocks, painter.rect(x0, y0, w, h, color,
alpha). "plain", or a theme this file doesn't know, draws nothing: the bare stage.

Every window has to show the same backdrop at the same instant. So time only ever comes in as `now` (the
relay's clock) and chance only from roll(), the window's own formula: no random, no time.time().

Cost: the still part of a backdrop is worked out once per stage width and kept, as a list of rectangles;
the moving part is kept small (under about 40 rectangles a drawing). To count both for every theme:

    python stages.py
"""
import hashlib
import math
from itertools import groupby

__all__ = ["THEMES", "still", "live", "draw"]

THEMES = ("plain", "baseplate", "ocean", "forest", "city", "spooky", "space", "workshop")


def roll(*parts):
    """A dice roll from 0 to 1 that every window rolls the same way for the same facts (the window's formula)."""
    return int(hashlib.md5("|".join(str(p) for p in parts).encode()).hexdigest()[:12], 16) / float(16 ** 12)


def mix(a, b, k):
    """The colour k of the way from a to b."""
    k = max(0.0, min(1.0, k))
    return "#" + "".join("%02x" % int(round(int(a[i:i + 2], 16) + (int(b[i:i + 2], 16) - int(a[i:i + 2], 16)) * k))
                         for i in (1, 3, 5))


def blob(cx, w, h, rows=None):
    """An ellipse w wide and h tall centred on column cx, as rows for painter.cells; rows=n keeps its top n."""
    out = []
    for r in range(h if rows is None else rows):
        k = (r + 0.5) / h * 2 - 1
        half = max(1, int(round(w / 2.0 * math.sqrt(max(0.0, 1 - k * k)))))
        out.append((r, cx - half, cx + half - 1))
    return out


class Sprite:
    """Text art, worked out once into as few rectangles as it takes. Each letter is a colour in pal, '.' is
    empty. Where one colour runs through a stretch of a row with others set into it, the stretch is painted
    whole and the others go on top; and equal runs in neighbouring rows are stacked into one block."""

    def __init__(self, art, pal, flip=False):
        self.w, self.h = max(len(line) for line in art), len(art)
        layers = ({}, {})  # (colour, first column, last column) -> its rows: painted first, and painted on top
        for r, line in enumerate(art):
            line = line.ljust(self.w, ".")
            if flip:
                line = line[::-1]
            c = 0
            for empty, seg in groupby(line, key=lambda ch: ch == "."):
                seg = "".join(seg)
                if not empty:
                    runs, k = [], c
                    for ch, same in groupby(seg):
                        n = len(list(same))
                        runs.append((ch, k, k + n - 1))
                        k += n
                    count = {}
                    for ch, _, _ in runs:
                        count[ch] = count.get(ch, 0) + 1
                    base = max(count, key=count.get)
                    if count[base] > 1:
                        layers[0].setdefault((pal[base], c, c + len(seg) - 1), []).append(r)
                        for ch, a, b in runs:
                            if ch != base:
                                layers[1].setdefault((pal[ch], a, b), []).append(r)
                    else:
                        for ch, a, b in runs:
                            layers[0].setdefault((pal[ch], a, b), []).append(r)
                c += len(seg)
        self.parts = []  # (colour, column, row, w, h), in painting order
        for layer in layers:
            for (colour, a, b), rows in layer.items():
                start = prev = rows[0]
                for r in rows[1:] + [None]:
                    if r is None or r != prev + 1:
                        self.parts.append((colour, a, start, b - a + 1, prev - start + 1))
                        start = r
                    prev = r


class Ops(list):
    """The still part of a backdrop, kept as what to hand the painter each frame. Rows count from the stage
    line: 0 is the first row of the panel, -1 the row a Clawd's feet stand in."""

    def cells(self, x, dy, rows, colour, alpha=1.0):
        self.append(("c", x, dy, rows, colour, alpha))

    def rect(self, x, dy, w, h, colour, alpha=1.0):
        self.append(("r", x, dy, w, h, colour, alpha))

    def stand(self, spr, x, dy=0, alpha=1.0):
        """A sprite with its left edge at x, standing on the stage line (dy lifts it when negative)."""
        for colour, c, r, w, h in spr.parts:
            self.append(("r", x + c, dy - spr.h + r, w, h, colour, alpha))

    def surface(self, cols, colours):
        """The top rows of the stage panel, repainted as the ground: one colour per row, tucked in where the
        panel's corners are round."""
        i = 0
        while i < len(colours):
            n = 1
            while i >= 2 and i + n < len(colours) and colours[i + n] == colours[i]:
                n += 1
            inset = (2, 1)[i] if i < 2 else 0
            self.append(("r", inset, i, cols - 2 * inset, n, colours[i], 1.0))
            i += n


def _rect(p, x, y, w, h, colour, alpha=1.0):
    """One solid block, as a single canvas item where the painter can."""
    rect = getattr(p, "rect", None)
    if rect:
        rect(x, y, w, h, colour, alpha)
    else:
        p.cells(x, y, [(r, 0, w - 1) for r in range(h)], colour, alpha)


def _put(p, spr, x, bottom, alpha=1.0):
    """A sprite drawn now (for the parts that move), its last row just above `bottom`."""
    for colour, c, r, w, h in spr.parts:
        _rect(p, x + c, bottom - spr.h + r, w, h, colour, alpha)


def _paint(p, ops, ground):
    rect = getattr(p, "rect", None)
    for op in ops:
        if op[0] == "c":
            p.cells(op[1], ground + op[2], op[3], op[4], op[5])
        elif rect:
            rect(op[1], ground + op[2], op[3], op[4], op[5], op[6])
        else:
            p.cells(op[1], ground + op[2], [(r, 0, op[3] - 1) for r in range(op[4])], op[5], op[6])


def _tufts(o, key, cols, n, colour, tall=0.4):
    """Little tufts poking up along the stage line, where every window puts them."""
    low, high = [], []
    for i in range(n):
        x = 6 + int(roll(key, i, "x") * (cols - 14))
        w = 1 + int(roll(key, i, "w") * 3)
        low.append((0, x, x + w - 1))
        if roll(key, i, "h") < tall:
            high.append((0, x + w // 2, x + w // 2))
    o.cells(0, -1, low, colour)
    o.cells(0, -2, high, colour)


# ------------------------------------------------------------------ baseplate
# A Roblox place before anyone has built on it: the studded grey plate, a spawn pad, a few bricks, a tree.

PAD = Sprite([
    "..tttttttttttttttttttttttttt..",
    ".ttttttttooooooooooootttttttt.",
    "ssssssssssssssssssssssssssssss",
    "dddddddddddddddddddddddddddddd",
], {"t": "#6c6f77", "o": "#aeb2ba", "s": "#4e5158", "d": "#3c3e43"})


def _brick(o, x, up, w, light, main, dark):
    """A toy brick w wide and 6 tall, its underside `up` rows above the stage, with studs on top."""
    o.cells(x, -up - 7, [(0, c, c + 3) for c in range(2, w - 4, 8)], light)
    o.rect(x, -up - 6, w, 6, main)
    o.rect(x, -up - 6, w, 1, light)
    o.rect(x, -up - 1, w, 1, dark)


def _baseplate(cols):
    back = Ops()
    back.surface(cols, ["#7f8289", "#5b5e65", "#5b5e65", "#5b5e65", "#46484e"])
    back.cells(0, -1, [(0, x, x + 2) for x in range(6, cols - 8, 8)], "#8e9198")  # the studs
    # a blocky tree: two green blocks on a brown one
    tx = 6
    leaf, lit, shade = "#4d7a4c", "#5f9060", "#3c6140"
    back.rect(tx + 9, -14, 6, 14, "#6a4f38")
    back.rect(tx + 13, -14, 2, 14, "#573f2d")
    back.rect(tx, -30, 24, 16, leaf)
    back.rect(tx, -30, 24, 1, lit)
    back.rect(tx, -16, 24, 2, shade)
    back.cells(tx, -31, [(0, 2, 5), (0, 18, 21)], lit)
    back.rect(tx + 6, -38, 12, 8, leaf)
    back.rect(tx + 6, -38, 12, 1, lit)
    back.cells(tx + 6, -39, [(0, 1, 4), (0, 7, 10)], lit)
    back.stand(PAD, int(cols * 0.22))
    # bricks someone left stacked
    bx = cols - 66
    red, blue = ("#b85c52", "#a04a41", "#843b34"), ("#5a82b0", "#46699a", "#38557e")
    yellow, green = ("#c9a84e", "#b08f3a", "#8f732c"), ("#6a9a62", "#55824f", "#44693f")
    _brick(back, bx, 0, 16, *red)
    _brick(back, bx + 16, 0, 16, *blue)
    _brick(back, bx + 8, 6, 16, *yellow)
    _brick(back, bx + 12, 12, 8, *green)
    _brick(back, bx + 40, 0, 8, *green)
    _brick(back, bx - 18, 0, 8, *blue)
    return back


def _baseplate_live(p, cols, ground, now):
    x = int(cols * 0.22) + 9
    k = 0.5 + 0.5 * math.sin(now * 1.3)  # the light over the spawn pad, breathing
    for i, a in enumerate((0.5, 0.3, 0.14)):
        _rect(p, x + i, ground - 8 - i * 4, 12 - 2 * i, 4, "#cfe6f2", a * (0.7 + 0.5 * k))
    for i in range(3):  # and three sparkles rising through it, fading as they go
        t = (now * 0.28 + i / 3.0) % 1.0
        _rect(p, x + 1 + (i * 4 + 2) % 10 + math.sin(now * 0.9 + i * 2.1), ground - 5 - t * 15, 1, 1, "#eef6fa", 1 - t)


# ---------------------------------------------------------------------- ocean
# A wooden pier: planks to stand on, water moving under them, a lighthouse on its rock, the harbour's clutter.

CRATE = Sprite([
    "ffffffffffffff",
    "fwwwwwwwwwwwwf",
    "fwwwwwwwwwwwwf",
    "fddddddddddddf",
    "fwwwwwwwwwwwwf",
    "fwwwwwwwwwwwwf",
    "fddddddddddddf",
    "fwwwwwwwwwwwwf",
    "fwwwwwwwwwwwwf",
    "fddddddddddddf",
    "fwwwwwwwwwwwwf",
    "ffffffffffffff",
], {"f": "#6b5238", "w": "#8f7450", "d": "#7a6244"})

SMALL_CRATE = Sprite([
    "ffffffffff",
    "fwwwwwwwwf",
    "fwwwwwwwwf",
    "fddddddddf",
    "fwwwwwwwwf",
    "fwwwwwwwwf",
    "ffffffffff",
], {"f": "#6b5238", "w": "#9a7d56", "d": "#7a6244"})

BARREL = Sprite([
    "..bbbbbb..",
    ".bllbbbbb.",
    "hhhhhhhhhh",
    "bbllbbbbbb",
    "bbllbbbbbb",
    "bbllbbbbbb",
    "bbllbbbbbb",
    "bbllbbbbbb",
    "bbllbbbbbb",
    "hhhhhhhhhh",
    ".bllbbbbb.",
    "..bbbbbb..",
], {"b": "#7a5c3c", "l": "#8f6e49", "h": "#4a4d52"})

LIFEBUOY = Sprite([
    "..rrrr..",
    ".rr..rr.",
    "ww....ww",
    "ww....ww",
    "ww....ww",
    "ww....ww",
    ".rr..rr.",
    "..rrrr..",
], {"r": "#a8483f", "w": "#d6d2c6"})

GULL = Sprite([  # its eye and beak are drawn each frame, on whichever side it's looking
    ".....w..",
    ".wwwwww.",
    "wwwwwww.",
    ".ggwww..",
    "...o.o..",
], {"w": "#dedbd0", "g": "#b9b6ab", "o": "#d08a4a"})


def _lighthouse():
    """Top to bottom: finial, roof, lamp room, gallery, a tower in five bands that widens to its foot, the rock."""
    w, cx, lines = 32, 16, []

    def row(*spans):
        line = ["."] * w
        for a, b, ch in spans:
            line[a:b + 1] = ch * (b + 1 - a)
        lines.append("".join(line))

    row((cx - 1, cx - 1, "i"))
    row((cx - 1, cx - 1, "i"))
    for half in (1, 3, 5, 6):
        row((cx - half, cx + half - 1, "R"))
    for _ in range(4):
        row((cx - 5, cx + 4, "i"), (cx - 4, cx + 3, "g"))  # the glass: lit up each frame
    row((cx - 5, cx + 4, "i"))
    row((cx - 8, cx + 7, "i"))
    row((cx - 7, cx + 6, "i"))
    for i in range(30):
        half = 5 + (i * 3 + 14) // 30
        body, shade = ("r", "R") if (i // 6) % 2 else ("w", "s")
        spans = [(cx - half, cx + half - 3, body), (cx + half - 2, cx + half - 1, shade)]
        if i in (13, 14, 15):
            spans.append((cx - 1, cx, "i"))  # a window
        if i >= 24:
            spans.append((cx - 2, cx + 1, "i"))  # the door
        row(*spans)
    for i, half in enumerate((8, 11, 13, 14, 15, 15)):
        spans = [(cx - half, cx + half - 1, "k")]
        if i in (0, 2):
            spans.append((cx - half + 1, cx - half + 4 + i, "l"))  # ledges that catch the light
        row(*spans)
    return Sprite(lines, {"i": "#3b3d42", "R": "#843b34", "r": "#a04a41", "w": "#c2beb2", "s": "#a19d91",
                          "g": "#7d6f45", "k": "#5b5853", "l": "#716d66"})


LIGHTHOUSE = _lighthouse()  # 32 x 49; its glass is the 8 x 4 block 43 rows up, at column 12


def _posts(cols):
    """Where the pier's pilings stand, each 4 wide."""
    return range(22, cols - 10, 44)


def _crests(p, cols, y, shift, gap, wide, colour):
    """A row of wave crests `gap` apart, slid along by `shift`. The pilings are part of the still picture
    underneath, so a crest is cut short where one stands: it reads as passing behind it."""
    posts = _posts(cols)
    x = shift % gap - gap
    while x < cols:
        a, b = max(0.0, x), min(float(cols), x + wide)
        for q in posts:
            if a < q + 4 and b > q:
                if a < q:
                    b = q
                else:
                    a = q + 4
        if b - a >= 0.34:
            _rect(p, a, y, b - a, 1, colour)
        x += gap


def _ocean(cols):
    back = Ops()
    deck, edge, sea = "#8a7050", "#5e4a34", "#2c4b63"
    back.surface(cols, [deck, edge, sea, sea, sea, sea])
    back.cells(0, 0, [(0, x, x) for x in range(9, cols - 6, 14)], edge)  # the gaps between the planks
    for x in _posts(cols):  # the pilings it stands on, in the water
        back.rect(x, 2, 4, 4, "#4c3c2c")
        back.rect(x, 2, 1, 4, "#5e4a34")
    back.rect(6, -9, 4, 9, edge)  # a mooring post, a turn of rope round it, a gull on top
    back.rect(6, -9, 4, 1, deck)
    back.rect(5, -5, 6, 2, "#b3a88e")
    back.stand(GULL, 4, -9)
    back.stand(CRATE, 16)
    back.stand(SMALL_CRATE, 18, -12)
    back.stand(BARREL, 32)
    back.stand(LIFEBUOY, 44)
    back.stand(LIGHTHOUSE, cols - 46)
    return back


def _ocean_live(p, cols, ground, now):
    # wave crests sliding along under the pier, the two rows going opposite ways
    _crests(p, cols, ground + 2, now * 2.0, 20, 5, "#4a7591")
    _crests(p, cols, ground + 4, -now * 1.3, 26, 4, "#3d6480")
    bob = 0.5 + 0.5 * math.sin(now * 1.4)  # a buoy riding them
    bx = int(cols * 0.43)
    _rect(p, bx, ground + 3 + bob, 4, 2, "#a8483f")
    _rect(p, bx + 1, ground + 2 + bob, 2, 1, "#d6d2c6")
    # the gull on the mooring post looks the other way now and then: its eye, and its beak beyond it
    look = 1 if roll("gull", int(now / 6.0)) < 0.55 else -1
    _rect(p, 9 + look, ground - 14, 1, 1, "#2a2a28")
    _rect(p, 9 + 2 * look, ground - 14, 1, 1, "#d08a4a")
    # the lamp turns: bright when it swings this way, a faint beam across the stage, then away again
    t = (now / 9.0) % 1.0
    k = max(0.0, math.cos((t - 0.5) * 2 * math.pi)) ** 2
    lx = cols - 46 + 12
    if k > 0.02:
        _rect(p, lx, ground - 43, 8, 4, mix("#7d6f45", "#f6e293", k))
    if k > 0.45:
        for dy, far, near, al in ((-43, 40, 26, 0.12), (-42, 40, 10, 0.24), (-41, 40, 1, 0.3), (-40, 40, 10, 0.24),
                                  (-39, 40, 26, 0.12)):
            _rect(p, lx - far, ground + dy, far - near, 1, "#f6e293", al if k > 0.75 else al * 0.6)


# --------------------------------------------------------------------- forest
# A clearing: grass and earth underfoot, pines and an oak at the edges, a log, mushrooms, fireflies.

STUMP = Sprite([
    "..tttttttt..",
    "..bbbbbbbd..",
    "..bbbbbbbd..",
    "..bbbbbbbd..",
    ".bbbbbbbbdd.",
    "bbb.bbbb.ddd",
], {"t": "#a38a63", "b": "#5a4634", "d": "#46362a"})

MUSHROOM = Sprite([
    "..rrrr..",
    ".rwrrwr.",
    "rrrrwrrr",
    "rrrrrrrr",
    "...ss...",
    "...ss...",
], {"r": "#a8483f", "w": "#e0dccf", "s": "#cfc8b4"})

SMALL_MUSHROOM = Sprite([
    ".rrr.",
    "rwrrr",
    "..s..",
    "..s..",
], {"r": "#a8483f", "w": "#e0dccf", "s": "#cfc8b4"})

LOG = Sprite([
    ".eeebbbbmmmmmmbbbbbbbbbb..",
    "eeoeebbbbmmbbbbbbbbbbbbbb.",
    "eoooebbbbbbbbbbbbbbbbbbbbb",
    "eoooebbbbbbbbbbbbkkbbbbbbb",
    "eoooebbbbbbbbbbbbbbbbbbbbb",
    "eeoeedddddddddddddddddddd.",
    ".eeeddddddddddddddddddd...",
], {"e": "#9a8562", "o": "#b89f74", "b": "#5a4634", "d": "#463627", "m": "#55744a", "k": "#3a2c20"})


def _pine(o, cx, h, spread, tiers, main, dark, light):
    """A pine h tall with its trunk on column cx: tiers that each widen, then tuck back in under the next."""
    crown = h - 6
    per = crown // tiers
    rows = {main: [], dark: [], light: []}
    r = 0
    for _ in range(crown - per * tiers):  # rows left over make a taller tip
        rows[main].append((r, -1, 0))
        r += 1
    wide = 1.0
    for t in range(tiers):
        end = spread * (t + 1.0) / tiers
        start = max(1.0, wide * 0.5)
        for k in range(per):
            half = max(1, int(round(start + (end - start) * k / max(1, per - 1))))
            rows[dark if k == per - 1 else main].append((r, -half, half - 1))
            if 0 < k < per - 1 and half > 3 and k % 2:
                rows[light].append((r, -half, -half + 1 + k // 3))  # its lit side
            r += 1
        wide = end
    o.rect(cx - 2, -6, 4, 6, "#57442f")
    o.rect(cx + 1, -6, 1, 6, "#46362a")
    for colour in (main, dark, light):
        o.cells(cx, -h, rows[colour], colour)


def _forest(cols):
    back = Ops()
    back.surface(cols, ["#4c7645", "#3a5c37", "#4a3b2c", "#4a3b2c", "#3d3126"])
    back.cells(0, 2, [(0, x, x + 1 + int(roll("pebble", i) * 3)) for i, x in
                      enumerate(range(13, cols - 8, 29))], "#6b5b47")  # pebbles in the earth
    back.cells(0, 3, [(0, x, x + 1) for x in range(27, cols - 8, 37)], "#5c4c3a")
    _pine(back, 20, 50, 14, 4, "#2f5a3c", "#254830", "#3f7049")
    _pine(back, 46, 32, 10, 3, "#2c5544", "#234437", "#3b6a55")
    # an oak on the other side: trunk, a branch, and a canopy lit from the left
    ox = cols - 26
    back.rect(ox - 3, -17, 6, 17, "#5a4634")
    back.rect(ox + 1, -17, 2, 17, "#46362a")
    back.cells(ox, -1, [(0, -5, -4), (0, 3, 4)], "#5a4634")
    back.cells(0, -39, blob(ox, 36, 24), "#3f6b3f")
    back.cells(0, -31, blob(ox + 5, 24, 15), "#335733")
    back.cells(0, -37, blob(ox - 6, 16, 8), "#4f8050")
    back.cells(0, -9, blob(cols - 56, 18, 16, rows=8), "#3a6238")  # a bush beside it
    back.cells(0, -8, blob(cols - 59, 8, 8, rows=3), "#4f8050")
    back.stand(STUMP, 66)
    back.stand(MUSHROOM, 80)
    back.stand(SMALL_MUSHROOM, 90)
    back.stand(LOG, cols - 100)
    back.stand(SMALL_MUSHROOM, cols - 70)
    _tufts(back, "grass", cols, cols // 8, "#5a8850")
    flowers = [(6 + int(roll("flower", i) * (cols - 14)), c) for i, c in
               enumerate(("#C46686", "#E3B23C", "#d8d3c4", "#C46686", "#d8d3c4", "#E3B23C"))]
    back.cells(0, -1, [(0, x, x) for x, _ in flowers], "#5a8850")
    for x, colour in flowers:
        back.rect(x, -2, 1, 1, colour)
    return back


_FLIES = [(0.7 + 0.5 * roll("fly", i, "rate"), 0.1 + 0.8 * roll("fly", i, "x"), 9 + 26 * roll("fly", i, "y"))
          for i in range(6)]  # each firefly's pace and its own patch: the same in every window


def _forest_live(p, cols, ground, now):
    for i, (rate, fx, fy) in enumerate(_FLIES):  # fireflies: each wanders its own patch and glows on and off
        glow = math.sin(now * rate + i * 1.9)
        if glow > 0:
            x = cols * fx + 7 * math.sin(now * 0.31 + i * 2.3)
            y = ground - fy + 3 * math.sin(now * 0.23 + i)
            _rect(p, x, y, 1, 1, "#dfe88a", 0.3 + 0.7 * glow)


# ----------------------------------------------------------------------- city
# A street corner: pavement and a kerb, a lane of tarmac, a street lamp, a bench, a traffic light that works.

BENCH = Sprite([
    "wwwwwwwwwwwwwwwwwwwwwwwwwwww",
    "wwwwwwwwwwwwwwwwwwwwwwwwwwww",
    "...ii..................ii...",
    "wwwwwwwwwwwwwwwwwwwwwwwwwwww",
    "wwwwwwwwwwwwwwwwwwwwwwwwwwww",
    "...ii..................ii...",
    "...ii..................ii...",
    "WWWWWWWWWWWWWWWWWWWWWWWWWWWW",
    "dddddddddddddddddddddddddddd",
    "...ii..................ii...",
    "...ii..................ii...",
    "..iiii................iiii..",
], {"w": "#7d6245", "W": "#8f7250", "d": "#5f4a35", "i": "#3f4247"})

BIN = Sprite([
    "kkkkkkkkkk",
    ".gggggggg.",
    ".gggggggg.",
    ".llllllll.",
    ".gggggggg.",
    ".gggggggg.",
    ".gggggggg.",
    ".llllllll.",
    ".gggggggg.",
    ".gggggggg.",
    "..gggggg..",
], {"k": "#3f4247", "g": "#44604c", "l": "#577861"})

HYDRANT = Sprite([
    "...rrrr...",
    "..rrrrrr..",
    "..dddddd..",
    "...rrrr...",
    ".rrrrrrrr.",
    ".rrllrrrr.",
    "...rrrr...",
    "...rrrr...",
    "...rrrr...",
    "..dddddd..",
    "..rrrrrr..",
    ".rrrrrrrr.",
], {"r": "#a8463c", "d": "#7f342d", "l": "#c4675b"})

MAILBOX = Sprite([
    "..bbbbbb..",
    ".bbbbbbbb.",
    "bbbbbbbbbb",
    "bbkkkkkkbb",
    "bbbbbbbbbb",
    "bbbbbbbbbb",
    "bwwwwwwwwb",
    "bwwwwwwwwb",
    "bbbbbbbbbb",
    "bbbbbbbbbb",
    "bbbbbbbbbb",
    "dddddddddd",
    ".k......k.",
    ".k......k.",
    ".k......k.",
    ".k......k.",
], {"b": "#46699a", "d": "#38557e", "k": "#2f3136", "w": "#c9c6bb"})

_LIGHTS =(("#e0523f", "#57302c"), ("#e8b83a", "#574a26"), ("#4fbf6a", "#284d30"))  # lit and unlit: red, amber, green


def _city(cols):
    back = Ops()
    walk, kerb, road = "#85857f", "#62625c", "#34363b"
    back.surface(cols, [walk, kerb, road, road, road, road])
    back.cells(0, 0, [(0, x, x) for x in range(12, cols - 6, 18)], kerb)  # the joints between paving slabs
    back.cells(0, 4, [(0, x, x + 7) for x in range(8, cols - 12, 22)], "#9a8646")  # the lane's dashes
    iron, steel, warm = "#3f4247", "#55585e", "#f2d98c"
    x = 20  # the street lamp: foot, pole, arm, head, and the light it throws down
    back.rect(x - 2, -3, 6, 3, steel)
    back.rect(x, -41, 2, 38, iron)
    back.rect(x, -42, 14, 1, iron)
    back.rect(x + 6, -41, 10, 2, steel)
    back.rect(x + 7, -39, 8, 1, warm)
    for i, (w, a) in enumerate(((10, 0.4), (12, 0.4), (14, 0.24), (16, 0.24), (18, 0.12), (20, 0.12), (22, 0.12))):
        back.rect(x + 11 - w // 2, -38 + i, w, 1, warm, a)
    back.stand(BENCH, 44)
    back.stand(BIN, 78)
    back.stand(HYDRANT, cols - 88)
    back.stand(MAILBOX, cols - 62)
    x = cols - 26  # the traffic light: pole, box, and its three lamps unlit (the one that's on is drawn each frame)
    back.rect(x - 2, -2, 6, 2, steel)
    back.rect(x, -24, 2, 22, iron)
    back.rect(x - 3, -45, 8, 21, "#2d2f34")
    back.rect(x - 4, -46, 10, 1, steel)
    for i, (_, unlit) in enumerate(_LIGHTS):  # each lamp a 4 x 4 dot with its corners off: two blocks
        back.rect(x, -43 + i * 6, 2, 4, unlit)
        back.rect(x - 1, -42 + i * 6, 4, 2, unlit)
    return back


def _city_live(p, cols, ground, now):
    t = now % 18.0  # red, then green, then a short amber
    on = 0 if t < 8 else 2 if t < 16 else 1
    x, y, lit = cols - 26, ground - 43 + on * 6, _LIGHTS[on][0]
    _rect(p, x, y, 2, 4, lit)
    _rect(p, x - 1, y + 1, 4, 2, lit)


# --------------------------------------------------------------------- spooky
# A graveyard at night: bare earth, a dead tree with something in it, old stones, a lit pumpkin, low fog.

DEAD_TREE = Sprite([
    "..........................b...",
    "....b....................bb...",
    "....bb..........b........b....",
    ".....bb.........bb......bb....",
    "......bb.........b.....bb.....",
    ".......bb........bb...bb......",
    ".......bbb........bb.bb.......",
    "..b.....bbb.......bbbb........",
    "..bb.....bbb......bbb.........",
    "...bbb....bbb....bbbb.....b...",
    ".....bbb...bbb...bbb.....bb...",
    ".......bbb..bbb.bbbb....bb....",
    ".........bbbbbbbbbbbbbbbb.....",
    "...........bbbbbbbbbbb........",
    "............bbbbbbbb..........",
    "............bbbbbbd...........",
    "............bbbbbbd...........",
    "............bbkkkbd...........",
    "............bkkkkkd...........",
    "............bkkkkkd...........",
    "............bbkkkbd...........",
    "............bbbbbbd...........",
    "............bbbbbbd...........",
    "............bbbbbbd...........",
    "...........bbbbbbbd...........",
    "...........bbbbbbbd...........",
    "...........bbbbbbbd...........",
    "...........bbbbbbbdd..........",
    "...........bbbbbbbdd..........",
    "..........bbbbbbbbdd..........",
    "..........bbbbbbbbddd.........",
    ".........bbbbbbbbbbddd........",
    "........bbbbbb.bbbbbddd.......",
    "......bbbbb.....bbb.bbddd.....",
], {"b": "#4d433a", "d": "#3b332d", "k": "#1f1b19"})

STONE = Sprite([
    "....ssssss....",
    "..ssssssssss..",
    ".ssssssssssss.",
    ".ssssssssssss.",
    "ssssssccssssss",
    "ssssssccssssss",
    "ssssccccccssss",
    "ssssccccccssss",
    "ssssssccssssss",
    "ssssssccssssss",
    "ssssssccssssss",
    "ssssssssssssss",
    "ssssssssssssss",
    "dddddddddddddd",
    "dddddddddddddd",
    "mmdddddddddmmm",
], {"s": "#77746d", "d": "#5d5a54", "c": "#4d4a45", "m": "#4f6144"})

CROSS = Sprite([
    "....ssss....",
    "....ssss....",
    "....ssss....",
    "....ssss....",
    "ssssssssssss",
    "ssssssssssss",
    "ssssssssssss",
    "....ssss....",
    "....ssss....",
    "....ssss....",
    "....ssss....",
    "....ssss....",
    "....ssss....",
    "....ssss....",
    "....dddd....",
    "..dddddddd..",
    ".mddddddddm.",
], {"s": "#6f6c66", "d": "#57544f", "m": "#4f6144"})

LEANING_STONE = Sprite([
    "....ssssss..",
    "...ssssssss.",
    "...ssssssss.",
    "..ssssssss..",
    "..ssssssss..",
    "..ssssssss..",
    ".ssssssss...",
    ".ssssssss...",
    ".dddddddd...",
    "mddddddddm..",
], {"s": "#6a6761", "d": "#54514c", "m": "#4f6144"})

_PUMPKIN = [
    "......gg......",
    ".....gg.......",
    "...oooooooo...",
    ".oooooooooooo.",
    "ooofooooooofoo",
    "ooffffooffffoo",
    "oooooooooooooo",
    "ooffoffffoffoo",
    ".ooffffffffoo.",
    "..oooooooooo..",
]
PUMPKIN = Sprite(_PUMPKIN, {"o": "#b5662c", "g": "#55683e", "f": "#3a2412"})
_FACE = ["".join(ch if ch == "f" else "." for ch in line) for line in _PUMPKIN]
FACES = [Sprite(_FACE, {"f": c}) for c in ("#f2c14a", "#e8a838", "#d98f2e")]  # the candle inside, flickering


def _spooky(cols):
    back = Ops()
    back.surface(cols, ["#463e37", "#342e2a", "#342e2a", "#342e2a", "#2b2623"])
    bone = "#b3ad9b"  # what's in the ground: a bone, a skull, another bone
    x = int(cols * 0.3)
    back.cells(x, 2, [(0, 0, 0), (0, 6, 6), (1, 0, 6)], bone)
    x = int(cols * 0.58)
    back.cells(x, 2, [(0, 0, 3), (1, 0, 3), (2, 1, 2)], bone)
    back.cells(x, 3, [(0, 1, 1), (0, 3, 3)], "#342e2a")
    x = int(cols * 0.8)
    back.cells(x, 3, [(0, 0, 4)], bone)
    back.stand(DEAD_TREE, 4)
    back.stand(STONE, 44)
    back.stand(LEANING_STONE, 66)
    back.stand(CROSS, cols - 92)
    back.stand(PUMPKIN, cols - 68)
    fx, iron = cols - 40, "#44444a"  # an iron fence along the far end
    back.rect(fx, -10, 36, 1, iron)
    back.rect(fx, -4, 36, 1, iron)
    for i in range(6):
        back.rect(fx + 2 + i * 6, -14, 1, 14, iron)
        back.rect(fx + 1 + i * 6, -13, 3, 1, iron)
    _tufts(back, "weeds", cols, cols // 11, "#77734f", tall=0.5)
    return back


_FOG = [(34 + int(roll("fog", i, "w") * 30), roll("fog", i, "x"), 1.2 + roll("fog", i, "v") * 1.6)
        for i in range(5)]  # each fog bank's width, where it starts and its pace


def _spooky_live(p, cols, ground, now):
    # two eyes in the tree's hollow: there for a while, blinking, then gone for a while
    watch = now % 23.0
    if watch < 14 and not 6.0 < watch < 6.25 and not 10.4 < watch < 10.6:
        p.cells(4, ground - 34, [(18, 14, 14), (18, 16, 16)], "#e3d24a")
    _put(p, FACES[int(roll("candle", int(now * 6)) * 3)], cols - 68, ground)
    # a will-o'-the-wisp drifting between the stones
    wx = cols * 0.5 + cols * 0.2 * math.sin(now * 0.13)
    wy = ground - 15 - 4 * math.sin(now * 0.6)
    _rect(p, wx - 1, wy - 1, 4, 4, "#8fd9c0", 0.22)
    _rect(p, wx, wy, 2, 2, "#c4f2e0", 0.85)
    for w, start, pace in _FOG:  # low fog sliding over the ground, each bank at its own pace
        x = (start * (cols + w) + now * pace) % (cols + w) - w
        _rect(p, x, ground - 2, w, 2, "#8f98a0", 0.3)
        _rect(p, x + 5, ground - 3, w - 12, 1, "#8f98a0", 0.16)


# ---------------------------------------------------------------------- space
# The surface of a moon: dust and craters, a rocket on its fins, a planted flag, a rover, a dish, a few stars.

ROCKET = Sprite([
    ".......rr.......",
    "......rrrr......",
    "......rrrr......",
    ".....rrrrrR.....",
    ".....rrrrrR.....",
    "....rrrrrrRR....",
    "....wwwwwwss....",
    "....wwwwwwss....",
    "....wwkkkkss....",
    "....wwkbbkss....",
    "....wwkbckss....",
    "....wwkkkkss....",
    "....wwwwwwss....",
    "....rrrrrrRR....",
    "....rrrrrrRR....",
    "....wwwwwwss....",
    "....wwwwwwss....",
    "....wwwwwwss....",
    "....wwwwwwss....",
    "....wwwwwwss....",
    "....wwwwwwss....",
    "....wwwwwwss....",
    "....wwwwwwss....",
    "...rwwwwwwssR...",
    "..rrwwwwwwssRR..",
    "..rrwwwwwwssRR..",
    ".rrrwwwwwwssRRR.",
    ".rrrwwwwwwssRRR.",
    "rrrrwwwwwwssRRRR",
    "rrrr.kkkkkk.RRRR",
    "rrr...kkkk...RRR",
    "rr............RR",
], {"r": "#a8483f", "R": "#863a33", "w": "#c9c6bb", "s": "#a6a398", "k": "#3f4247", "b": "#5a86a8", "c": "#a9cbe0"})

ROVER = Sprite([
    "................kk....",
    "................kk....",
    "................m..m..",
    "..pppppppppppp..m..m..",
    "..pqpppqpppqpp..m..m..",
    "....m......m....m..m..",
    ".gggggggggggggggggggg.",
    ".gggggggggggggggggggg.",
    ".GGGGGGGGGGGGGGGGGGGG.",
    "..kkkk...kkkk...kkkk..",
    ".kkhhkk.kkhhkk.kkhhkk.",
    "..kkkk...kkkk...kkkk..",
], {"k": "#3a3c40", "m": "#8a8a86", "p": "#34506b", "q": "#4f7393", "g": "#a88c4a", "G": "#86703b", "h": "#8a8a86"})

DISH = Sprite([
    "d............d",
    "dd..........dd",
    ".ddd......ddd.",
    "..dddddddddd..",
    "....ssssss....",
    "......kk......",
    "......kk......",
    ".....kkkk.....",
    "....kk..kk....",
    "...kk....kk...",
    "..kk......kk..",
], {"d": "#b0aea4", "s": "#8e8c83", "k": "#55585e"})


def _space(cols):
    back = Ops()
    back.surface(cols, ["#93938e", "#7a7a75", "#6b6b67", "#6b6b67", "#585854"])
    for frac, w in ((0.3, 10), (0.44, 6), (0.55, 14), (0.7, 7), (0.95, 6)):  # craters, their far rims catching light
        x = int(cols * frac)
        back.rect(x, 0, w, 1, "#62625e")
        back.rect(x + 1, 1, w - 2, 1, "#52524f")
        back.cells(x, -1, [(0, -1, 0), (0, w - 1, w)], "#a6a6a0")
    for i, frac in enumerate((0.24, 0.38, 0.5, 0.63, 0.76, 0.86)):  # loose rocks
        x, big = int(cols * frac), i % 2
        back.cells(x, -2, [(0, 1, 1 + big), (1, 0, 2 + big)], "#7d7d78")
    back.cells(0, 3, [(0, x, x + 2) for x in range(17, cols - 8, 31)], "#5e5e5a")
    back.stand(ROCKET, 12)
    fx = 40  # the flag the crew planted: Clawd orange, with its eyes
    back.rect(fx, -17, 1, 17, "#a0a09a")
    back.rect(fx + 1, -17, 12, 7, "#c66a50")
    back.rect(fx + 1, -11, 12, 1, "#a85842")
    back.cells(fx + 1, -15, [(0, 3, 3), (1, 3, 3), (0, 8, 8), (1, 8, 8)], "#2a2a28")
    back.stand(ROVER, cols - 84)
    back.stand(DISH, cols - 28)
    back.rect(cols - 22, -17, 2, 6, "#55585e")  # the dish's feed, a lamp on its tip
    # a ringed planet, small and far off
    px, top = cols - 52, -62
    back.cells(0, top, blob(px, 12, 12), "#6b6280")
    back.cells(0, top + 7, blob(px, 12, 12)[7:10], "#594f6e")
    back.rect(px - 11, top + 5, 22, 1, "#a79cbd", 0.8)
    back.rect(px - 9, top + 6, 18, 1, "#463d58", 0.5)
    return back


_STARS = [(roll("star", i, "x"), roll("star", i, "y"), 0.5 + roll("star", i, "rate"))
          for i in range(14)]  # where each star is and how fast it twinkles: the same in every window


def _space_live(p, cols, ground, now):
    for i, (sx, sy, rate) in enumerate(_STARS):  # stars, each twinkling at its own rate
        x, y = int(4 + sx * (cols - 8)), int(2 + sy * (ground - 30))
        if abs(x - (cols - 52)) < 13 and ground - 63 <= y <= ground - 50:
            continue  # that one would be in front of the planet
        k = 0.5 + 0.5 * math.sin(now * rate + i * 1.7)
        _rect(p, x, y, 1, 1, "#e8e6dc", 0.3 + 0.7 * k)
    if int(now * 0.8) % 2:  # a warning lamp on the rocket's nose
        _rect(p, 12 + 7, ground - 33, 2, 1, "#e0523f")
    if (now % 3.0) < 0.4:  # the dish's feed winks
        _rect(p, cols - 22, ground - 18, 2, 1, "#8fd9c0")
    if (now % 5.0) < 2.5:  # and the rover's mast lamp is on half the time
        _rect(p, cols - 84 + 19, ground - 11, 1, 1, "#e8b83a")


# ------------------------------------------------------------------- workshop
# A maker's corner: floorboards, a bench with its tool board and lamp, a toolbox, a sawhorse, stacked timber.

HAMMER = Sprite([
    "ssssssss",
    "ssssssss",
    "sss..sss",
    "...hh...",
    "...hh...",
    "...hh...",
    "...hh...",
    "...hh...",
    "...hh...",
    "...hh...",
    "...hh...",
], {"s": "#8a8a86", "h": "#9a7a55"})

WRENCH = Sprite([
    "ss..ss",
    "ss..ss",
    "ssssss",
    ".ssss.",
    "..ss..",
    "..ss..",
    "..ss..",
    "..ss..",
    "..ss..",
    ".ssss.",
    ".s..s.",
    ".ssss.",
], {"s": "#8a8a86"})

SAW = Sprite([
    "hhhhh.................",
    "h...hsssssssssssssssss",
    "h...hssssssssssssssss.",
    "hhhhhssssssssssssss...",
    ".hhh.sssssssssssss....",
], {"h": "#9a7a55", "s": "#8a8a86"})

LEVEL = Sprite([
    "yyyyyyyyyyyyyyyyyyyy",
    "yyyyyyyyggyyyyyyyyyy",
    "yyyyyyyyyyyyyyyyyyyy",
], {"y": "#b89a3a", "g": "#cfe6b0"})

SCREWDRIVER = Sprite([
    "rr",
    "rr",
    "rr",
    "rr",
    "s.",
    "s.",
    "s.",
    "s.",
    "s.",
], {"r": "#a8483f", "s": "#8a8a86"})

VISE = Sprite([
    "jj...jj",
    "jj...jj",
    "jjjjjjj",
    ".jjjjj.",
    ".kkkkk.",
], {"j": "#6f7378", "k": "#4a4d52"})

TOOLBOX = Sprite([
    "......hhhhhh......",
    ".....hh....hh.....",
    "rrrrrrrrrrrrrrrrrr",
    "RRRRRRRRRRRRRRRRRR",
    "dddddddddddddddddd",
    "RRRRRRRRyyRRRRRRRR",
    "RRRRRRRRyyRRRRRRRR",
    "RRRRRRRRRRRRRRRRRR",
    "RRRRRRRRRRRRRRRRRR",
    "RRRRRRRRRRRRRRRRRR",
    "dddddddddddddddddd",
], {"r": "#b05a4e", "R": "#9c463c", "d": "#7c372f", "y": "#c9a84e", "h": "#55585e"})

SAWHORSE = Sprite([
    "pppppppppppppppppppppppppppp",
    "PPPPPPPPPPPPPPPPPPPPPPPPPPPP",
    "..bbbbbbbbbbbbbbbbbbbbbbbb..",
    "..bbbbbbbbbbbbbbbbbbbbbbbb..",
    "....ll................ll....",
    "....ll................ll....",
    "...ll..................ll...",
    "...ll..................ll...",
    "...ll..................ll...",
    "..ll....................ll..",
    "..ll....................ll..",
    "..ll....................ll..",
    ".ll......................ll.",
    ".ll......................ll.",
], {"p": "#b89f74", "P": "#a38a63", "b": "#7d6245", "l": "#6a543c"})


def _workshop(cols):
    back = Ops()
    back.surface(cols, ["#84684a", "#6a543c", "#6a543c", "#5a4733", "#48392a"])
    back.cells(0, 0, [(0, x, x) for x in range(15, cols - 6, 24)], "#5a4733")  # the seams between boards
    back.cells(0, 1, [(0, x, x) for x in range(27, cols - 6, 24)], "#5a4733")
    wood, lit, dark, iron, warm = "#8a6a4a", "#a3825f", "#5f4a35", "#3f4247", "#f2d98c"
    bx = 6  # the bench: a board of tools behind it, a top, two legs, a shelf underneath
    back.rect(bx + 3, -45, 46, 27, "#4a4038")
    back.rect(bx + 3, -45, 46, 1, "#5c5046")
    back.stand(HAMMER, bx + 8, -31)
    back.stand(WRENCH, bx + 20, -30)
    back.stand(LEVEL, bx + 28, -38)
    back.stand(SAW, bx + 6, -22)
    back.stand(SCREWDRIVER, bx + 34, -24)
    back.stand(SCREWDRIVER, bx + 39, -24)
    back.rect(bx + 44, -33, 2, 9, "#b3a88e")  # a rule
    back.rect(bx + 3, -15, 4, 15, dark)
    back.rect(bx + 45, -15, 4, 15, dark)
    back.rect(bx + 3, -6, 46, 2, dark)
    back.rect(bx + 10, -11, 7, 5, "#5f86a8")  # paint on the shelf: two tins, a pale label on each
    back.rect(bx + 10, -9, 7, 2, "#c9c6bb")
    back.rect(bx + 19, -11, 7, 5, "#b08f3a")
    back.rect(bx + 19, -9, 7, 2, "#c9c6bb")
    back.rect(bx + 30, -10, 14, 4, "#6b5238")  # and a box of offcuts
    back.rect(bx, -18, 52, 3, wood)
    back.rect(bx, -18, 52, 1, lit)
    back.stand(VISE, bx + 41, -18)
    back.rect(bx + 6, -22, 9, 4, iron)  # a soldering station (its lamp blinks)
    back.rect(bx + 7, -21, 1, 1, "#284d30")
    back.rect(bx + 20, -22, 4, 4, "#c9c6bb")  # somebody's mug
    back.rect(bx + 24, -21, 1, 2, "#c9c6bb")
    back.rect(bx + 49, -44, 12, 1, iron)  # a lamp clamped to the board, and the light it throws
    back.cells(bx + 54, -43, [(0, 3, 6), (1, 2, 7), (2, 1, 8), (3, 0, 9)], "#577861")
    back.rect(bx + 56, -39, 6, 1, warm)
    for i, (w, a) in enumerate(((10, 0.4), (12, 0.4), (14, 0.24), (16, 0.24), (18, 0.12), (20, 0.12))):
        back.rect(bx + 59 - w // 2, -38 + i, w, 1, warm, a)
    back.stand(TOOLBOX, cols - 98)
    back.stand(SAWHORSE, cols - 72)
    tx = cols - 38  # timber, stacked
    for i, (off, w, colour) in enumerate(((0, 32, "#8f7450"), (2, 28, "#a3825f"), (1, 30, "#7d6245"), (4, 24, "#b89f74"))):
        back.rect(tx + off, -2 - i * 2, w, 2, colour)
        back.rect(tx + off, -2 - i * 2, 2, 2, "#c9b48a")
    back.cells(0, -1, [(0, x, x + int(roll("dust", i) * 2)) for i, x in
                       enumerate(range(cols - 84, cols - 44, 5))], "#c9b48a")  # sawdust under the sawhorse
    return back


def _workshop_live(p, cols, ground, now):
    if (now % 2.4) < 1.2:  # the soldering station's ready lamp
        _rect(p, 6 + 7, ground - 21, 1, 1, "#4fbf6a")


STAGES = {
    "baseplate": (_baseplate, _baseplate_live),
    "ocean": (_ocean, _ocean_live),
    "forest": (_forest, _forest_live),
    "city": (_city, _city_live),
    "spooky": (_spooky, _spooky_live),
    "space": (_space, _space_live),
    "workshop": (_workshop, _workshop_live),
}
_built = {}  # (theme, cols) -> its still part, worked out once


def still(painter, theme, cols, ground):
    """Draw the part of `theme`'s backdrop that never changes, on a stage `cols` fine cells wide whose line is
    at row `ground`. A window that keeps a still layer calls this once per theme and size."""
    if theme not in STAGES:
        return
    if (theme, cols) not in _built:
        _built[(theme, cols)] = STAGES[theme][0](cols)
    _paint(painter, _built[(theme, cols)], ground)


def live(painter, theme, cols, ground, now):
    """Draw only what moves in `theme`'s backdrop, as it looks at `now` on the relay's clock: every drawing,
    over the still part and under the Clawds."""
    if theme in STAGES:
        STAGES[theme][1](painter, cols, ground, now)


def draw(painter, theme, cols, ground, now):
    """The whole backdrop in one go, for a window that redraws everything each time: still, then live."""
    still(painter, theme, cols, ground)
    live(painter, theme, cols, ground, now)


if __name__ == "__main__":
    class _Count:
        """A painter that only counts the canvas items it's asked for."""

        def __init__(self):
            self.n = 0

        def cells(self, x0, y0, rows, color, alpha=1.0):
            self.n += len(rows) if alpha > 0.05 else 0

        def rect(self, x0, y0, w, h, color, alpha=1.0):
            self.n += 1 if alpha > 0.05 else 0

    print("canvas items   still (drawn once)   live (every drawing, at most)")
    for name in THEMES:
        count = _Count()
        still(count, name, 220, 66)
        once, worst = count.n, 0
        for step in range(3000):  # several minutes of the show, to catch the busiest frame
            count = _Count()
            live(count, name, 220, 66, 1.7e9 + step * 0.173)
            worst = max(worst, count.n)
        print("%-14s %8d %20d" % (name, once, worst))
