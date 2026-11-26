#!/usr/bin/env python3
"""End-to-end test of bin/omacast-expander in a throwaway nested Hyprland
(ported from the Shorthand plugin).

Starts Hyprland as a window inside your session, a terminal inside that, and
the real expander pointed at a fake keyboard (a FIFO with fake sysfs
capabilities). Each case types its keys twice, the way a real keyboard reaches
two readers: once into the terminal through a virtual keyboard (what Hyprland
would deliver) and once into the fake device (what the daemon reads). The
terminal's line is then compared with what should be there. The test plays
the shell: it sends the keyword table on stdin and answers the expander's
requests to resolve snippets with placeholders.

Nothing is typed into your own session: every Wayland connection here goes to
the nested compositor's socket, and the test refuses to run if it cannot find
one it started itself.

    python3 -I tests/e2e_nested.py

Needs Hyprland and foot.
"""

import sys

sys.dont_write_bytecode = True

import importlib.machinery
import importlib.util
import json
import os
import shutil
import struct
import subprocess
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(HERE, "..", "bin", "omacast-expander")


def load():
    loader = importlib.machinery.SourceFileLoader("omacast_expander", BIN)
    spec = importlib.util.spec_from_loader("omacast_expander", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


sh = load()

# US layout evdev codes.
CODES = {}
for row, start in (("1234567890", 2), ("qwertyuiop", 16), ("asdfghjkl", 30), ("zxcvbnm", 44)):
    for i, ch in enumerate(row):
        CODES[ch] = (start + i, False)
for ch, (code, shift) in {
    " ": (57, False), "@": (3, True), ";": (39, False), ".": (52, False), ",": (51, False),
    "-": (12, False), "/": (53, False), "!": (2, True),
}.items():
    CODES[ch] = (code, shift)
for ch in "abcdefghijklmnopqrstuvwxyz":
    CODES[ch.upper()] = (CODES[ch][0], True)
SHIFT, BACKSPACE, ENTER, CTRL = 42, 14, 28, 29

def entry(keyword, text, dynamic=False):
    return {"keyword": keyword, "text": "" if dynamic else text, "dynamic": dynamic}


SNIPPETS = [
    entry("lmail", "you@example.com"),
    entry("nao", "não"),
    entry("@@mty", "@mechtoyou.example"),
    entry(";sig", "Best,\nAda"),
    entry("mail", "SHORTER-MATCH-SHOULD-LOSE"),
    entry("lmty", "ada@mechtoyou.example"),
    entry("xmil", "adalovelace@gmail.example"),
    entry("tdy", "", dynamic=True),
    entry("brk", "", dynamic=True),
]

# What the shell would answer for each dynamic keyword: (text, characters
# after {cursor}). Placeholders.js has its own unit tests; this checks the
# round trip.
RESOLVED = {"tdy": ("2026-11-26", 0), "brk": ("[]", 1)}


def runtime_sockets():
    rt = os.environ["XDG_RUNTIME_DIR"]
    return {n for n in os.listdir(rt) if n.startswith("wayland-") and not n.endswith(".lock")}


class Rig:
    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix="omacast-expander-e2e-")
        self.procs = []

    def start_compositor(self):
        conf = os.path.join(self.tmp, "hyprland.conf")
        with open(conf, "w") as f:
            f.write("monitor = , 900x500, auto, 1\nmisc {\n  disable_hyprland_logo = true\n  disable_splash_rendering = true\n}\n")
        before = runtime_sockets()
        env = dict(os.environ, HYPRLAND_NO_SD_NOTIFY="1", HYPRLAND_NO_SD_VARS="1", HYPRLAND_NO_CRASHREPORTER="1")
        env.pop("HYPRLAND_INSTANCE_SIGNATURE", None)
        self.procs.append(subprocess.Popen(["Hyprland", "-c", conf], env=env, stdout=subprocess.DEVNULL,
                                           stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, start_new_session=True))
        for _ in range(100):
            new = runtime_sockets() - before
            if new:
                self.display = sorted(new)[0]
                break
            time.sleep(0.1)
        else:
            raise SystemExit("nested Hyprland did not start")
        if self.display == os.environ.get("WAYLAND_DISPLAY"):
            raise SystemExit("refusing: found the session's own display")
        self.env = dict(os.environ, WAYLAND_DISPLAY=self.display)
        self.env.pop("HYPRLAND_INSTANCE_SIGNATURE", None)
        time.sleep(0.5)

    def start_reader(self):
        self.out = os.path.join(self.tmp, "out.txt")
        script = os.path.join(self.tmp, "reader.sh")
        with open(script, "w") as f:
            f.write('#!/bin/bash\nwhile IFS= read -e -r l; do printf "%%s\\n" "$l" >> %s; done\n' % self.out)
        os.chmod(script, 0o755)
        self.procs.append(subprocess.Popen(["foot", script], env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        time.sleep(1.2)

    def start_daemon(self):
        dev = os.path.join(self.tmp, "dev")
        sysfs = os.path.join(self.tmp, "sys")
        caps = os.path.join(sysfs, "event0", "device", "capabilities")
        os.makedirs(dev)
        os.makedirs(caps)
        bits = 0
        for c in range(1, 128):
            bits |= 1 << c
        with open(os.path.join(caps, "ev"), "w") as f:
            f.write("3\n")
        with open(os.path.join(caps, "key"), "w") as f:
            f.write("%x %x\n" % (bits >> 64, bits & (2 ** 64 - 1)))
        self.fifo = os.path.join(dev, "event0")
        os.mkfifo(self.fifo)
        self.fifo_fd = os.open(self.fifo, os.O_RDWR)
        env = dict(self.env, OMACAST_EXPANDER_INPUT_DIR=dev, OMACAST_EXPANDER_SYSFS=sysfs,
                   OMACAST_EXPANDER_DEBUG="1")
        self.log = open(os.path.join(self.tmp, "daemon.log"), "w")
        self.daemon = subprocess.Popen([sys.executable, "-I", BIN, "run"], env=env, stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=self.log, text=True)
        self.procs.append(self.daemon)
        self.statuses = []
        self.send({"cmd": "snippets", "list": SNIPPETS})
        threading.Thread(target=self.shell, daemon=True).start()
        for _ in range(50):
            if any(s["state"] == "running" and s["keywords"] == len(SNIPPETS) for s in self.statuses):
                break
            time.sleep(0.1)
        status = self.statuses[-1] if self.statuses else None
        assert status and status["state"] == "running", status
        assert status["injector"] == "virtual-keyboard", status

    def send(self, obj):
        self.daemon.stdin.write((obj if isinstance(obj, str) else json.dumps(obj)) + "\n")
        self.daemon.stdin.flush()

    def shell(self):
        """Backend.qml's part: status lines, and resolving dynamic snippets."""
        for line in self.daemon.stdout:
            msg = json.loads(line)
            if msg.get("event") == "status":
                self.statuses.append(msg)
            elif msg.get("event") == "expand":
                text, left = RESOLVED[msg["keyword"]]
                self.send({"cmd": "type", "backspaces": len(msg["keyword"]), "text": text, "left": left})

    def start_typist(self):
        os.environ["WAYLAND_DISPLAY"] = self.display
        os.environ.pop("HYPRLAND_INSTANCE_SIGNATURE", None)
        self.vk = sh.VirtualKeyboard(sh.Xkb())

    def evdev(self, code, value):
        os.write(self.fifo_fd, struct.pack("llHHi", 0, 0, 1, code, value) + struct.pack("llHHi", 0, 0, 0, 0, 0))

    def key(self, ch):
        """One keystroke reaching both the terminal and the daemon."""
        if ch == "\b":
            self.vk.type_keys(["BackSpace"])
            self.evdev(BACKSPACE, 1)
            self.evdev(BACKSPACE, 0)
        else:
            code, shift = CODES[ch]
            self.vk.type_keys([ch])
            if shift:
                self.evdev(SHIFT, 1)
            self.evdev(code, 1)
            self.evdev(code, 0)
            if shift:
                self.evdev(SHIFT, 0)
        time.sleep(0.03)  # a fast typist

    def vk_raw(self, code, state):
        self.vk.sock.setblocking(True)
        self.vk.sock.sendall(sh.wire_message(self.vk.keyboard, 1, struct.pack("=III", 0, code, state)))
        self.vk.sock.setblocking(False)

    def type_holding_last(self, text, n=1, hold=0.12):
        """Like type(), but the last n keys stay down while the expansion runs,
        the way fingers still are 8 ms later, and fast typists overlap keys."""
        self.type(text[:-n])
        self.vk.type_keys([])  # make sure the plain keymap is current
        codes = []
        for ch in text[-n:]:
            code, shift = CODES[ch]
            assert not shift
            self.vk_raw(code, 1)
            self.evdev(code, 1)
            codes.append(code)
            time.sleep(0.02)
        time.sleep(hold)
        for code in codes:
            self.vk_raw(code, 0)
            self.evdev(code, 0)
        time.sleep(0.03)

    def type(self, text):
        for ch in text:
            self.key(ch)

    def enter(self):
        time.sleep(0.1)
        self.vk.type_keys(["Return"])
        self.evdev(ENTER, 1)
        self.evdev(ENTER, 0)
        time.sleep(0.25)

    def lines(self):
        try:
            with open(self.out, encoding="utf-8") as f:
                return f.read().split("\n")[:-1]
        except FileNotFoundError:
            return []

    def stop(self):
        for p in reversed(self.procs):
            try:
                p.terminate()
                p.wait(timeout=3)
            except Exception:
                p.kill()
        shutil.rmtree(self.tmp, ignore_errors=True)


def main():
    rig = Rig()
    failures = 0
    try:
        rig.start_compositor()
        rig.start_reader()
        rig.start_daemon()
        rig.start_typist()

        cases = []

        def case(name, keys, expect, before=None):
            cases.append((name, keys, expect, before))

        case("expands at the end of a word", "hi lmail", ["hi you@example.com"])
        case("accented output", "nao sei", ["não sei"])
        case("inside a word, with shift", "lucas@@mty", ["lucas@mechtoyou.example"])
        case("backspace edits the keyword", "lmx\bail", ["you@example.com"])
        case("longest keyword wins", "xmail lmail", ["xSHORTER-MATCH-SHOULD-LOSE you@example.com"])
        case("expansion contains the key still held down", ("lmty", 1), ["ada@mechtoyou.example"])
        case("two keys still down (rollover)", ("xmil", 2), ["adalovelace@gmail.example"])
        case("multi-line expansion", "thanks ;sig", ["thanks Best,", "Ada"])
        case("a placeholder snippet is resolved by the shell", "due tdy", ["due 2026-11-26"])
        case("{cursor} puts the caret inside", "brk" + "ok", ["[ok]"])
        case("paused while the launcher is open", "lmail", ["lmail"],
             before=lambda: (rig.send("pause"), time.sleep(0.1)))
        case("resumed", "lmail", ["you@example.com"],
             before=lambda: (rig.send("resume"), time.sleep(0.1)))

        def add_snippet():
            rig.send({"cmd": "snippets", "list": SNIPPETS + [entry("brb", "be right back")]})
            time.sleep(0.2)

        case("picks up a new snippet without a restart", "brb", ["be right back"], before=add_snippet)

        for name, keys, expect, before in cases:
            if before:
                before()
            start = len(rig.lines())
            if isinstance(keys, tuple):
                rig.type_holding_last(keys[0], keys[1])
            else:
                rig.type(keys)
            rig.enter()
            got = rig.lines()[start:]
            ok = got == expect
            failures += not ok
            print("%s  %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "\n      expected %r\n      got      %r" % (expect, got)))

        rig.log.flush()
        with open(rig.log.name) as f:
            times = [float(l.rsplit(" ms", 1)[0].rsplit(" ", 1)[1]) for l in f if "ms after its last key" in l]
        if times:
            print("expansion finished %.1f-%.1f ms after the keyword's last key (%.0f ms of that is the configured delay)"
                  % (min(times), max(times), sh.DEFAULT_DELAY_MS))
    finally:
        rig.stop()
    print("%d failed" % failures if failures else "all passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
