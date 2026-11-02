"""Quack? Three of them, spread over the screen."""
import os
import tkinter as tk

SPOTS = ((0.0, 0.0), (0.5, 1.0), (1.0, 0.25))  # how far across and down the free space each one sits

root = tk.Tk()
root.withdraw()  # only holds the three windows together
duck = tk.PhotoImage(file=os.path.join(os.path.dirname(os.path.abspath(__file__)), "quack.png"))
room_x = max(0, root.winfo_screenwidth() - duck.width())
room_y = max(0, root.winfo_screenheight() - duck.height() - 80)  # stays clear of the taskbar
ducks = []


def close(win):
    win.destroy()
    ducks.remove(win)
    if not ducks:
        root.destroy()


for across, down in SPOTS:
    win = tk.Toplevel(root)
    win.title("Quack?")
    win.resizable(False, False)
    tk.Label(win, image=duck, bd=0).pack()
    win.geometry(f"+{int(room_x * across)}+{int(room_y * down)}")
    win.protocol("WM_DELETE_WINDOW", lambda w=win: close(w))
    win.attributes("-topmost", True)  # opened from the background, Windows would leave them behind everything else
    ducks.append(win)

root.after(3000, lambda: [w.attributes("-topmost", False) for w in ducks])  # seen: now they're normal windows
root.mainloop()
