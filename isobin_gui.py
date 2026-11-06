#!/usr/bin/env python3
"""isobin_gui.py - a simple window around isobin.py.

Keep this file in the same folder as isobin.py, then run:

    python3 isobin_gui.py

Needs: numpy, tkinter, and ffmpeg for mp3/flac/opus output (WAV works without it).
tkinter ships with the python.org installer; with Homebrew Python run
`brew install python-tk`.
"""

import contextlib
import json
import os
import queue
import re
import shlex
import shutil
import subprocess
import sys
import threading
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import isobin  # noqa: E402

try:
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk
except ImportError:          # reported nicely in main()
    tk = None

SETTINGS_FILE = Path.home() / ".isobin_gui.json"
PROGRESS_RE = re.compile(r"rendering\s*:\s*([0-9.]+)%")

FLAG_LABELS = {
    "--duration": "Length", "--fade-in": "File fade-in", "--fade-out": "File fade-out",
    "--bitrate": "Bitrate", "--mp3-vbr-quality": "MP3 quality",
    "--sample-rate": "Sample rate", "--flac-level": "FLAC compression",
    "--binaural-glide": "Glide", "--binaural-section-duration": "Section length",
    "--binaural-sync-tone": "Follow tone", "--binaural-amplitude": "Binaural volume",
    "--binaural": "Binaural sections", "--iso-tones": "Tones",
    "--iso-beat-freq": "Beat Hz", "--iso-tone-freq": "Tone Hz",
    "--iso-duty": "Duty cycle", "--iso-fade-in-ms": "Pulse fade-in",
    "--iso-fade-out-ms": "Pulse fade-out", "--iso-amplitude": "Isochronic volume",
}


# --------------------------------------------------------------------------
# Settings <-> command line (no GUI code here, so it is easy to test)
# --------------------------------------------------------------------------
def default_state():
    music = Path.home() / "Music"
    folder = music if music.is_dir() else Path.home()
    return {
        "output": str(folder / "isobin_session"),
        "format": "flac" if shutil.which("ffmpeg") else "wav",
        "duration": "20m", "amplitude": 0.8, "fade_in": "5s", "fade_out": "5s",
        "sample_rate": "", "bit_depth": "16", "flac_level": "5",
        "mp3_mode": "CBR", "mp3_bitrate": "192", "mp3_quality": "2",
        "opus_bitrate": "128", "opus_vbr": "on",
        "bin_on": True, "bin_amp": 0.5, "bin_mode": "constant",
        "bin_sync_tone": "1", "bin_glide": "0",
        "sections": [["200", "210", "60s"]],
        "iso_on": True, "iso_amp": 0.5, "iso_fade_in": "10", "iso_fade_out": "10",
        "iso_duty": 0.5, "iso_mode": "mono",
        "tones": [["300", "10"]],
    }


PRESETS = {
    "Choose a preset…": None,
    "10 Hz (alpha range)": {
        "sections": [["200", "210", "60s"]], "tones": [["300", "10"]],
        "bin_mode": "constant", "bin_glide": "0"},
    "6 Hz (theta range)": {
        "sections": [["200", "206", "60s"]], "tones": [["250", "6"]],
        "bin_mode": "constant", "bin_glide": "0"},
    "2 Hz (delta range)": {
        "sections": [["150", "152", "60s"]], "tones": [["200", "2"]],
        "bin_mode": "constant", "bin_glide": "0"},
    "18 Hz (beta range)": {
        "sections": [["200", "218", "60s"]], "tones": [["300", "18"]],
        "bin_mode": "constant", "bin_glide": "0"},
    "10 Hz, binaural pulsed with the isochronic beat": {
        "sections": [["200", "210", "60s"]], "tones": [["300", "10"]],
        "bin_mode": "sync", "bin_sync_tone": "1", "bin_glide": "0"},
    "Descending 90 min (from your command)": {
        "duration": "90m", "fade_in": "1s", "fade_out": "1s",
        "sections": [["55", str(r), "10m"] for r in range(82, 57, -3)],
        "bin_glide": "1", "bin_mode": "constant",
        "tones": [["110", "3"], ["220", "6"], ["330", "9"], ["440", "12"], ["550", "15"]],
        "iso_mode": "mono"},
}


def num(value):
    """Trim, and accept a decimal comma (e.g. Brazilian '0,5')."""
    return str(value).strip().replace(",", ".")


def need(value, label):
    v = num(value)
    if not v:
        raise ValueError(f"Please fill in: {label}")
    return v


def normalized_output(path, fmt):
    path = os.path.expanduser(path.strip())
    base, ext = os.path.splitext(path)
    if ext.lower() in isobin.FORMATS:
        path = base
    return f"{path}.{fmt}"


def build_argv(s):
    """Turn the window's settings into an isobin.py argument list."""
    if not s["output"].strip():
        raise ValueError("Choose where to save the file (Browse…).")
    fmt = s["format"]
    out = normalized_output(s["output"], fmt)
    a = ["-o", out, "--format", fmt,
         "-d", need(s["duration"], "Length"),
         "-a", f"{float(s['amplitude']):.3f}",
         "--fade-in", need(s["fade_in"], "File fade-in"),
         "--fade-out", need(s["fade_out"], "File fade-out")]
    if num(s["sample_rate"]):
        a += ["--sample-rate", num(s["sample_rate"])]
    if fmt in ("wav", "flac"):
        a += ["--bit-depth", str(s["bit_depth"])]
    if fmt == "flac":
        a += ["--flac-level", need(s["flac_level"], "FLAC compression")]
    elif fmt == "mp3":
        if s["mp3_mode"] == "VBR":
            a += ["--mp3-vbr-quality", need(s["mp3_quality"], "MP3 quality")]
        else:
            a += ["--bitrate", need(s["mp3_bitrate"], "MP3 bitrate")]
    elif fmt == "opus":
        a += ["--bitrate", need(s["opus_bitrate"], "Opus bitrate"),
              "--opus-vbr", s["opus_vbr"]]

    sections, tones = s["sections"], s["tones"]
    sync = s["bin_on"] and s["bin_mode"] == "sync"

    if s["bin_on"]:
        if not sections:
            raise ValueError("Add at least one binaural section, or turn binaural off.")
        a += ["--binaural-amplitude", f"{float(s['bin_amp']):.3f}",
              "--binaural-mode", s["bin_mode"],
              "--binaural-glide", num(s["bin_glide"]) or "0"]
        for left, right, _ in sections:
            a += ["--binaural", f"{need(left, 'Left Hz')},{need(right, 'Right Hz')}"]
        a += ["--binaural-section-duration",
              ",".join(need(d, "Section length") for _, _, d in sections)]
        if sync:
            a += ["--binaural-sync-tone", need(s["bin_sync_tone"], "Follow tone")]
    else:
        a += ["--binaural-amplitude", "0"]

    if s["iso_on"] or sync:
        if not tones:
            raise ValueError("Add at least one isochronic tone.")
    if tones:
        a += ["--iso-tones", str(len(tones)),
              "--iso-tone-freq", ",".join(need(f, "Tone Hz") for f, _ in tones),
              "--iso-beat-freq", ",".join(need(b, "Beat Hz") for _, b in tones)]
    a += ["--iso-amplitude", f"{float(s['iso_amp']):.3f}" if s["iso_on"] else "0",
          "--iso-fade-in-ms", need(s["iso_fade_in"], "Pulse fade-in"),
          "--iso-fade-out-ms", need(s["iso_fade_out"], "Pulse fade-out"),
          "--iso-duty", f"{float(s['iso_duty']):.3f}",
          "--iso-mode", s["iso_mode"]]
    return a


def friendly(message):
    message = re.sub(r"^argument ", "", message)
    message = re.sub(r"(?<![\w-])-\w/(?=--)", "", message)   # "-d/--duration" -> "--duration"
    for flag in sorted(FLAG_LABELS, key=len, reverse=True):
        message = message.replace(flag, f"“{FLAG_LABELS[flag]}”")
    return message


def load_settings():
    try:
        data = json.loads(SETTINGS_FILE.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def reveal(path):
    try:
        if sys.platform == "darwin":
            subprocess.run(["open", "-R", path])
        elif sys.platform.startswith("win"):
            subprocess.run(["explorer", f"/select,{path}"])
        else:
            subprocess.run(["xdg-open", os.path.dirname(path)])
    except OSError:
        pass


class QueueWriter:
    """File-like object that forwards isobin's progress/log text to the window."""

    def __init__(self, q):
        self.q = q

    def write(self, text):
        self.q.put(("text", text))
        return len(text)

    def flush(self):
        pass


# --------------------------------------------------------------------------
# Widgets
# --------------------------------------------------------------------------
class EditableTable(ttk.Frame):
    """A small list with Add / Update / Remove / move-up / move-down."""

    def __init__(self, master, columns, defaults, height=6):
        super().__init__(master)
        self.rows = []
        ids = [f"c{i}" for i in range(len(columns))]
        top = ttk.Frame(self)
        top.pack(fill="both", expand=True)
        self.tree = ttk.Treeview(top, columns=ids, show="headings", height=height,
                                 selectmode="browse")
        for cid, (head, width) in zip(ids, columns):
            self.tree.heading(cid, text=head)
            self.tree.column(cid, width=width, anchor="center")
        sb = ttk.Scrollbar(top, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=sb.set)
        self.tree.pack(side="left", fill="both", expand=True)
        sb.pack(side="left", fill="y")
        self.tree.bind("<<TreeviewSelect>>", self._load)

        edit = ttk.Frame(self)
        edit.pack(fill="x", pady=(8, 0))
        self.vars = []
        for (head, _), d in zip(columns, defaults):
            box = ttk.Frame(edit)
            box.pack(side="left", padx=(0, 8))
            ttk.Label(box, text=head).pack(anchor="w")
            var = tk.StringVar(value=d)
            ttk.Entry(box, textvariable=var, width=10).pack()
            self.vars.append(var)
        btns = ttk.Frame(edit)
        btns.pack(side="left", anchor="s")
        for text, cmd in (("Add", self.add), ("Update", self.update_selected),
                          ("Remove", self.remove), ("▲", lambda: self.move(-1)),
                          ("▼", lambda: self.move(1))):
            ttk.Button(btns, text=text, width=7 if len(text) > 1 else 3,
                       command=cmd).pack(side="left", padx=2)

    def set_rows(self, rows):
        self.rows = [[str(c) for c in r] for r in rows]
        self._refresh()

    def _refresh(self, select=None):
        self.tree.delete(*self.tree.get_children())
        for i, r in enumerate(self.rows):
            self.tree.insert("", "end", iid=str(i), values=r)
        if select is not None and 0 <= select < len(self.rows):
            self.tree.selection_set(str(select))

    def _selected(self):
        sel = self.tree.selection()
        return int(sel[0]) if sel else None

    def _values(self):
        vals = [v.get().strip() for v in self.vars]
        if not all(vals):
            self.bell()
            return None
        return vals

    def _load(self, _event=None):
        i = self._selected()
        if i is not None:
            for var, val in zip(self.vars, self.rows[i]):
                var.set(val)

    def add(self):
        vals = self._values()
        if vals:
            self.rows.append(vals)
            self._refresh(len(self.rows) - 1)

    def update_selected(self):
        i, vals = self._selected(), self._values()
        if i is not None and vals:
            self.rows[i] = vals
            self._refresh(i)

    def remove(self):
        i = self._selected()
        if i is not None:
            del self.rows[i]
            self._refresh(min(i, len(self.rows) - 1))

    def move(self, delta):
        i = self._selected()
        if i is None or not 0 <= i + delta < len(self.rows):
            return
        self.rows[i], self.rows[i + delta] = self.rows[i + delta], self.rows[i]
        self._refresh(i + delta)


# --------------------------------------------------------------------------
# The window
# --------------------------------------------------------------------------
class App:
    def __init__(self, root):
        self.root = root
        root.title("Isobin – isochronic & binaural beats")
        root.minsize(780, 700)
        s = default_state()
        s.update({k: v for k, v in load_settings().items() if k in s})
        self.thread = None
        self.cancel = None
        self.out_path = None
        self.pbuf = ""
        self.log_text = ""

        def var(cls, key):
            return cls(value=s[key])

        self.v = {
            "output": var(tk.StringVar, "output"), "format": var(tk.StringVar, "format"),
            "duration": var(tk.StringVar, "duration"),
            "amplitude": var(tk.DoubleVar, "amplitude"),
            "fade_in": var(tk.StringVar, "fade_in"), "fade_out": var(tk.StringVar, "fade_out"),
            "sample_rate": var(tk.StringVar, "sample_rate"),
            "bit_depth": var(tk.StringVar, "bit_depth"),
            "flac_level": var(tk.StringVar, "flac_level"),
            "mp3_mode": var(tk.StringVar, "mp3_mode"),
            "mp3_bitrate": var(tk.StringVar, "mp3_bitrate"),
            "mp3_quality": var(tk.StringVar, "mp3_quality"),
            "opus_bitrate": var(tk.StringVar, "opus_bitrate"),
            "opus_vbr": var(tk.StringVar, "opus_vbr"),
            "bin_on": var(tk.BooleanVar, "bin_on"), "bin_amp": var(tk.DoubleVar, "bin_amp"),
            "bin_mode": var(tk.StringVar, "bin_mode"),
            "bin_sync_tone": var(tk.StringVar, "bin_sync_tone"),
            "bin_glide": var(tk.StringVar, "bin_glide"),
            "iso_on": var(tk.BooleanVar, "iso_on"), "iso_amp": var(tk.DoubleVar, "iso_amp"),
            "iso_fade_in": var(tk.StringVar, "iso_fade_in"),
            "iso_fade_out": var(tk.StringVar, "iso_fade_out"),
            "iso_duty": var(tk.DoubleVar, "iso_duty"),
            "iso_mode": var(tk.StringVar, "iso_mode"),
        }

        outer = ttk.Frame(root, padding=(12, 12, 12, 8))
        outer.pack(fill="both", expand=True)
        nb = ttk.Notebook(outer)
        nb.pack(fill="both", expand=True)
        self._file_tab(nb)
        self._binaural_tab(nb)
        self._iso_tab(nb)
        self.sections.set_rows(s["sections"])
        self.tones.set_rows(s["tones"])
        self._bottom(outer)
        self._format_changed()
        self._update_beat()
        root.protocol("WM_DELETE_WINDOW", self.close)

    # ---- small helpers ----------------------------------------------------
    def _scale(self, parent, row, label, key, lo=0.0, hi=1.0):
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", pady=6)
        box = ttk.Frame(parent)
        box.grid(row=row, column=1, columnspan=3, sticky="w")
        ttk.Scale(box, from_=lo, to=hi, variable=self.v[key], length=260).pack(side="left")
        lab = ttk.Label(box, width=5)
        lab.pack(side="left", padx=8)

        def upd(*_):
            try:
                lab.config(text=f"{self.v[key].get():.2f}")
            except tk.TclError:
                pass
        self.v[key].trace_add("write", upd)
        upd()

    def _hint(self, parent, row, column, text):
        ttk.Label(parent, text=text, foreground="gray").grid(
            row=row, column=column, sticky="w", padx=8)

    # ---- File tab ---------------------------------------------------------
    def _file_tab(self, nb):
        t = ttk.Frame(nb, padding=16)
        nb.add(t, text="  File  ")
        t.columnconfigure(0, minsize=120)
        t.columnconfigure(1, weight=1)
        ttk.Label(t, text="Save as").grid(row=0, column=0, sticky="w", pady=6)
        ttk.Entry(t, textvariable=self.v["output"]).grid(
            row=0, column=1, columnspan=2, sticky="we", padx=(0, 8))
        ttk.Button(t, text="Browse…", command=self.browse).grid(row=0, column=3)

        ttk.Label(t, text="Format").grid(row=1, column=0, sticky="w", pady=6)
        fmt = ttk.Combobox(t, textvariable=self.v["format"], width=8, state="readonly",
                           values=("wav", "flac", "mp3", "opus"))
        fmt.grid(row=1, column=1, sticky="w")
        fmt.bind("<<ComboboxSelected>>", lambda _e: self._format_changed())
        self.ffmpeg_hint = ttk.Label(t, text="", foreground="#c0392b")
        self.ffmpeg_hint.grid(row=1, column=2, columnspan=2, sticky="w", padx=8)

        ttk.Label(t, text="Length").grid(row=2, column=0, sticky="w", pady=6)
        ttk.Entry(t, textvariable=self.v["duration"], width=10).grid(
            row=2, column=1, sticky="w")
        self._hint(t, 2, 2, "e.g. 90s, 20m, 1.5h, 1:30:00")

        self._scale(t, 3, "Volume", "amplitude")

        ttk.Label(t, text="Fade in / out").grid(row=4, column=0, sticky="w", pady=6)
        fades = ttk.Frame(t)
        fades.grid(row=4, column=1, columnspan=2, sticky="w")
        ttk.Entry(fades, textvariable=self.v["fade_in"], width=8).pack(side="left")
        ttk.Label(fades, text="  /  ").pack(side="left")
        ttk.Entry(fades, textvariable=self.v["fade_out"], width=8).pack(side="left")
        ttk.Label(fades, text="  e.g. 5s", foreground="gray").pack(side="left")

        ttk.Label(t, text="Sample rate").grid(row=5, column=0, sticky="w", pady=6)
        ttk.Entry(t, textvariable=self.v["sample_rate"], width=10).grid(
            row=5, column=1, sticky="w")
        self._hint(t, 5, 2, "optional – leave blank for automatic (44100 Hz, 48000 for opus)")

        box = ttk.LabelFrame(t, text="Format options", padding=12)
        box.grid(row=6, column=0, columnspan=4, sticky="we", pady=(14, 0))
        self.fmt_frames = {}
        for name in ("wav", "flac", "mp3", "opus"):
            f = ttk.Frame(box)
            f.grid(row=0, column=0, sticky="w")
            self.fmt_frames[name] = f

        def bit_depth(f):
            ttk.Label(f, text="Bit depth").pack(side="left")
            for d in ("16", "24"):
                ttk.Radiobutton(f, text=d + "-bit", value=d,
                                variable=self.v["bit_depth"]).pack(side="left", padx=8)

        f = self.fmt_frames["wav"]
        bit_depth(f)
        f = self.fmt_frames["flac"]
        bit_depth(f)
        ttk.Label(f, text="    Compression (0–12)").pack(side="left")
        ttk.Spinbox(f, from_=0, to=12, width=4, textvariable=self.v["flac_level"]).pack(
            side="left", padx=6)
        ttk.Label(f, text="lossless at every level", foreground="gray").pack(side="left")
        f = self.fmt_frames["mp3"]
        ttk.Radiobutton(f, text="Constant bitrate", value="CBR",
                        variable=self.v["mp3_mode"]).pack(side="left")
        ttk.Combobox(f, textvariable=self.v["mp3_bitrate"], width=6,
                     values=("128", "160", "192", "224", "256", "320")).pack(
            side="left", padx=(6, 2))
        ttk.Label(f, text="kbps").pack(side="left")
        ttk.Radiobutton(f, text="    Variable, quality", value="VBR",
                        variable=self.v["mp3_mode"]).pack(side="left")
        ttk.Spinbox(f, from_=0, to=9, width=3, textvariable=self.v["mp3_quality"]).pack(
            side="left", padx=6)
        ttk.Label(f, text="0 = best", foreground="gray").pack(side="left")
        f = self.fmt_frames["opus"]
        ttk.Label(f, text="Bitrate").pack(side="left")
        ttk.Combobox(f, textvariable=self.v["opus_bitrate"], width=6,
                     values=("64", "96", "128", "160", "192")).pack(side="left", padx=(6, 2))
        ttk.Label(f, text="kbps     Rate control").pack(side="left")
        ttk.Combobox(f, textvariable=self.v["opus_vbr"], width=12, state="readonly",
                     values=("on", "off", "constrained")).pack(side="left", padx=6)
        ttk.Label(f, text="on = variable, off = constant", foreground="gray").pack(
            side="left")

    def browse(self):
        fmt = self.v["format"].get()
        current = os.path.expanduser(self.v["output"].get().strip() or "~")
        path = filedialog.asksaveasfilename(
            title="Save audio file as", defaultextension="." + fmt,
            initialdir=os.path.dirname(current) or str(Path.home()),
            initialfile=os.path.basename(current) or "isobin_session",
            filetypes=[(fmt.upper(), "*." + fmt)])
        if path:
            self.v["output"].set(path)

    def _format_changed(self):
        fmt = self.v["format"].get()
        for name, frame in self.fmt_frames.items():
            frame.grid() if name == fmt else frame.grid_remove()
        path = self.v["output"].get().strip()
        base, ext = os.path.splitext(path)
        if path and ext.lower() in isobin.FORMATS:
            self.v["output"].set(f"{base}.{fmt}")
        missing = fmt != "wav" and not shutil.which("ffmpeg")
        self.ffmpeg_hint.config(
            text="ffmpeg not found – install it (brew install ffmpeg) or pick wav"
            if missing else "")

    # ---- Binaural tab -----------------------------------------------------
    def _binaural_tab(self, nb):
        t = ttk.Frame(nb, padding=16)
        nb.add(t, text="  Binaural  ")
        t.columnconfigure(0, minsize=170)
        ttk.Checkbutton(t, text="Binaural beats on   (needs stereo headphones)",
                        variable=self.v["bin_on"]).grid(
            row=0, column=0, columnspan=4, sticky="w", pady=(0, 4))
        self._scale(t, 1, "Volume", "bin_amp")

        box = ttk.LabelFrame(
            t, text="Sections – played in order, then repeated to fill the file", padding=10)
        box.grid(row=2, column=0, columnspan=4, sticky="we", pady=(8, 4))
        self.sections = EditableTable(
            box, [("Left Hz", 110), ("Right Hz", 110), ("Length", 110)],
            ["200", "210", "60s"], height=5)
        self.sections.pack(fill="x")
        self.beat_label = ttk.Label(box, text="", foreground="gray")
        self.beat_label.pack(anchor="w", pady=(6, 0))
        for var in self.sections.vars[:2]:
            var.trace_add("write", self._update_beat)

        ttk.Label(t, text="Glide between sections").grid(row=3, column=0, sticky="w", pady=6)
        g = ttk.Frame(t)
        g.grid(row=3, column=1, columnspan=3, sticky="w")
        ttk.Entry(g, textvariable=self.v["bin_glide"], width=8).pack(side="left")
        ttk.Label(g, text="  seconds (0 = instant change)", foreground="gray").pack(
            side="left")

        tm = ttk.LabelFrame(t, text="Timing", padding=10)
        tm.grid(row=4, column=0, columnspan=4, sticky="we", pady=(8, 0))
        ttk.Radiobutton(tm, text="Continuous", value="constant",
                        variable=self.v["bin_mode"]).pack(anchor="w")
        row = ttk.Frame(tm)
        row.pack(anchor="w", pady=(4, 0))
        ttk.Radiobutton(
            row, text="Pulsed with the isochronic beat (fades in and out with each pulse), "
                      "following tone #", value="sync",
            variable=self.v["bin_mode"]).pack(side="left")
        ttk.Spinbox(row, from_=1, to=20, width=3,
                    textvariable=self.v["bin_sync_tone"]).pack(side="left", padx=6)

    def _update_beat(self, *_):
        try:
            l, r = (float(num(v.get())) for v in self.sections.vars[:2])
            self.beat_label.config(text=f"Binaural beat for these values: {abs(r - l):g} Hz")
        except ValueError:
            self.beat_label.config(text="")

    # ---- Isochronic tab ---------------------------------------------------
    def _iso_tab(self, nb):
        t = ttk.Frame(nb, padding=16)
        nb.add(t, text="  Isochronic  ")
        t.columnconfigure(0, minsize=170)
        ttk.Checkbutton(t, text="Isochronic beats on",
                        variable=self.v["iso_on"]).grid(
            row=0, column=0, columnspan=4, sticky="w", pady=(0, 4))
        self._scale(t, 1, "Volume", "iso_amp")

        box = ttk.LabelFrame(t, text="Tones – all play at the same time", padding=10)
        box.grid(row=2, column=0, columnspan=4, sticky="we", pady=(8, 4))
        self.tones = EditableTable(
            box, [("Tone Hz", 120), ("Beat Hz (pulses per second)", 190)],
            ["300", "10"], height=5)
        self.tones.pack(fill="x")

        ttk.Label(t, text="Pulse fade in / out").grid(row=3, column=0, sticky="w", pady=6)
        p = ttk.Frame(t)
        p.grid(row=3, column=1, columnspan=3, sticky="w")
        ttk.Entry(p, textvariable=self.v["iso_fade_in"], width=6).pack(side="left")
        ttk.Label(p, text="  /  ").pack(side="left")
        ttk.Entry(p, textvariable=self.v["iso_fade_out"], width=6).pack(side="left")
        ttk.Label(p, text="  milliseconds", foreground="gray").pack(side="left")

        self._scale(t, 4, "Duty cycle", "iso_duty", 0.1, 1.0)
        ttk.Label(t, text="share of each beat during which the tone is on",
                  foreground="gray").grid(row=5, column=1, columnspan=3, sticky="w")

        ears = ttk.LabelFrame(t, text="Ears", padding=10)
        ears.grid(row=6, column=0, columnspan=4, sticky="we", pady=(8, 0))
        ttk.Radiobutton(ears, text="Same pulses in both ears", value="mono",
                        variable=self.v["iso_mode"]).pack(anchor="w")
        ttk.Radiobutton(ears, text="Alternate pulses left / right", value="stereo",
                        variable=self.v["iso_mode"]).pack(anchor="w")

    # ---- Bottom bar -------------------------------------------------------
    def _bottom(self, outer):
        bar = ttk.Frame(outer)
        bar.pack(fill="x", pady=(10, 0))
        ttk.Label(bar, text="Presets").pack(side="left")
        self.preset = tk.StringVar(value=list(PRESETS)[0])
        cb = ttk.Combobox(bar, textvariable=self.preset, values=list(PRESETS),
                          state="readonly", width=44)
        cb.pack(side="left", padx=8)
        cb.bind("<<ComboboxSelected>>", lambda _e: self.apply_preset())
        ttk.Button(bar, text="Copy command", command=self.copy_command).pack(side="right")

        run = ttk.Frame(outer)
        run.pack(fill="x", pady=(10, 0))
        self.go = ttk.Button(run, text="Generate", command=self.start, width=12)
        self.go.pack(side="left")
        self.progress = ttk.Progressbar(run, maximum=100, mode="determinate")
        self.progress.pack(side="left", fill="x", expand=True, padx=10)
        self.show = ttk.Button(run, text="Show file", state="disabled",
                               command=lambda: self.out_path and reveal(self.out_path))
        self.show.pack(side="left")
        self.status = ttk.Label(outer, text="Ready.")
        self.status.pack(anchor="w", pady=(6, 2))

        lf = ttk.Frame(outer)
        lf.pack(fill="x")
        self.log = tk.Text(lf, height=6, wrap="word", state="disabled")
        sb = ttk.Scrollbar(lf, orient="vertical", command=self.log.yview)
        self.log.configure(yscrollcommand=sb.set)
        self.log.pack(side="left", fill="x", expand=True)
        sb.pack(side="left", fill="y")

    # ---- state ------------------------------------------------------------
    def get_state(self):
        s = {k: v.get() for k, v in self.v.items()}
        s["sections"] = [list(r) for r in self.sections.rows]
        s["tones"] = [list(r) for r in self.tones.rows]
        return s

    def set_state(self, s):
        for k, var in self.v.items():
            if k in s:
                var.set(s[k])
        if "sections" in s:
            self.sections.set_rows(s["sections"])
        if "tones" in s:
            self.tones.set_rows(s["tones"])
        self._format_changed()

    def save_settings(self):
        try:
            SETTINGS_FILE.write_text(json.dumps(self.get_state(), indent=1))
        except (OSError, tk.TclError):
            pass

    def apply_preset(self):
        p = PRESETS.get(self.preset.get())
        if p:
            self.set_state(p)
            self.status.config(text=f"Preset loaded: {self.preset.get()}")

    def copy_command(self):
        try:
            argv = build_argv(self.get_state())
        except (ValueError, tk.TclError) as e:
            messagebox.showerror("Check your settings", friendly(str(e)))
            return
        cmd = "python3 isobin.py " + " ".join(shlex.quote(a) for a in argv)
        self.root.clipboard_clear()
        self.root.clipboard_append(cmd)
        self.status.config(text="Equivalent command copied to the clipboard.")

    # ---- running ----------------------------------------------------------
    def log_add(self, text):
        self.log.config(state="normal")
        self.log.insert("end", text)
        self.log.see("end")
        self.log.config(state="disabled")

    def start(self):
        try:
            argv = build_argv(self.get_state())
        except (ValueError, tk.TclError) as e:
            messagebox.showerror("Check your settings", friendly(str(e)))
            return
        self.out_path = argv[1]
        if os.path.exists(self.out_path) and not messagebox.askyesno(
                "Replace file?", f"{self.out_path}\nalready exists. Replace it?"):
            return
        self.save_settings()
        self.q = queue.Queue()
        self.cancel = threading.Event()
        self.pbuf = self.log_text = ""
        self.log.config(state="normal")
        self.log.delete("1.0", "end")
        self.log.config(state="disabled")
        self.progress["value"] = 0
        self.show.config(state="disabled")
        self.go.config(text="Cancel", command=self.do_cancel)
        self.status.config(text="Rendering…")
        self.thread = threading.Thread(target=self.worker, args=(argv,), daemon=True)
        self.thread.start()
        self.root.after(100, self.poll)

    def worker(self, argv):
        try:
            with contextlib.redirect_stderr(QueueWriter(self.q)):
                try:
                    self.q.put(("done", isobin.main(argv, cancel=self.cancel)))
                except SystemExit as e:
                    self.q.put(("fail", e.code if isinstance(e.code, str) else ""))
        except Exception:
            self.q.put(("crash", traceback.format_exc()))

    def do_cancel(self):
        if self.cancel:
            self.cancel.set()
            self.status.config(text="Cancelling…")

    def poll(self):
        finished = None
        try:
            while True:
                kind, payload = self.q.get_nowait()
                if kind == "text":
                    self.pbuf = (self.pbuf + payload)[-400:]
                    m = PROGRESS_RE.findall(self.pbuf)
                    if m:
                        self.progress["value"] = float(m[-1])
                        self.status.config(text=f"Rendering… {float(m[-1]):.0f}%")
                    clean = PROGRESS_RE.sub("", payload).replace("\r", "")
                    if clean.strip():
                        self.log_text += clean
                        self.log_add(clean)
                else:
                    finished = (kind, payload)
        except queue.Empty:
            pass
        if finished is None:
            self.root.after(100, self.poll)
            return
        self.go.config(text="Generate", command=self.start)
        kind, payload = finished
        if kind == "done" and payload:
            self.progress["value"] = 100
            self.status.config(text=f"Saved: {self.out_path}")
            self.show.config(state="normal")
        elif kind == "done":
            self.status.config(text="Cancelled.")
            self.progress["value"] = 0
        elif kind == "fail":
            m = re.findall(r"isobin\.py: error: (.*)", self.log_text)
            msg = m[-1] if m else (payload or "Something went wrong; see the log below.")
            self.status.config(text="Couldn't create the file.")
            self.progress["value"] = 0
            messagebox.showerror("Couldn't create the file", friendly(msg.strip()))
        else:
            self.log_add(payload)
            self.status.config(text="Unexpected error; see the log below.")

    def close(self):
        if self.thread and self.thread.is_alive():
            self.cancel.set()
            self.thread.join(3)
        self.save_settings()
        self.root.destroy()


def main():
    if tk is None:
        sys.exit("tkinter is not available in this Python.\n"
                 "  python.org installer: it is included.\n"
                 "  Homebrew Python:      brew install python-tk")
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
