"""Unit tests for bin/omacast-expander, ported from the Shorthand plugin.
Run: python3 -I -m unittest discover -s tests -p expander_test.py"""

import sys

sys.dont_write_bytecode = True

import importlib.machinery
import importlib.util
import json
import os
import struct
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


def load():
    path = os.path.join(HERE, "..", "bin", "omacast-expander")
    loader = importlib.machinery.SourceFileLoader("omacast_expander", path)
    spec = importlib.util.spec_from_loader("omacast_expander", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


sh = load()


def table(*pairs, dynamic=()):
    return [{"keyword": k, "text": t, "dynamic": k in dynamic} for k, t in pairs]


class MatcherTest(unittest.TestCase):
    def test_longest_suffix_wins(self):
        m = sh.Matcher(table(("mail", "A"), ("lmail", "B")))
        self.assertEqual(m.match("xx lmail"), ("lmail", "B", False))
        self.assertEqual(m.match("xx mail"), ("mail", "A", False))
        self.assertIsNone(m.match("lmai"))

    def test_matches_inside_words(self):
        m = sh.Matcher(table(("@@mty", "@example.com")))
        self.assertEqual(m.match("lucas@@mty"), ("@@mty", "@example.com", False))

    def test_dynamic_keywords_are_reported(self):
        m = sh.Matcher(table(("tdy", ""), dynamic=("tdy",)))
        self.assertEqual(m.match("tdy"), ("tdy", "", True))

    def test_empty_table(self):
        self.assertEqual(sh.Matcher([]).maxlen, 0)


class TypedTest(unittest.TestCase):
    def test_keeps_only_the_tail(self):
        t = sh.Typed(limit=3)
        t.add("abcdef")
        self.assertEqual(t.text, "def")
        t.backspace()
        self.assertEqual(t.text, "de")
        t.reset()
        self.assertEqual(t.text, "")

    def test_zero_limit_keeps_nothing(self):
        t = sh.Typed(limit=0)
        t.add("abc")
        self.assertEqual(t.text, "")


class KeyPlanTest(unittest.TestCase):
    def test_backspaces_then_text(self):
        self.assertEqual(sh.key_plan(2, "ab"), ["BackSpace", "BackSpace", "a", "b"])

    def test_newlines_and_tabs_are_keys(self):
        self.assertEqual(sh.key_plan(0, "a\r\nb\tc"), ["a", "Return", "b", "Tab", "c"])

    def test_control_characters_are_dropped(self):
        self.assertEqual(sh.key_plan(0, "a\x1b\x07b"), ["a", "b"])

    def test_cursor_moves_left_after_the_text(self):
        self.assertEqual(sh.key_plan(1, "ab", left=1), ["BackSpace", "a", "b", "Left"])
        self.assertEqual(sh.key_plan(0, "a", left=-3), ["a"])


class TableTest(unittest.TestCase):
    def test_normalize_drops_garbage(self):
        out = sh.normalize_table([
            {"keyword": "ok", "text": "fine"},
            {"keyword": "ok", "text": "duplicate"},
            {"keyword": "", "text": "empty keyword"},
            {"keyword": "   ", "text": "blank keyword"},
            {"keyword": "a\nb", "text": "newline in keyword"},
            {"keyword": "x" * 65, "text": "too long"},
            {"keyword": "num", "text": 5},
            "not a snippet",
            {"keyword": "dyn", "dynamic": True},
            {"keyword": "long", "text": "y" * (sh.MAX_TEXT + 10)},
        ])
        self.assertEqual([e["keyword"] for e in out], ["ok", "dyn", "long"])
        self.assertEqual(out[1], {"keyword": "dyn", "text": "", "dynamic": True})
        self.assertEqual(len(out[2]["text"]), sh.MAX_TEXT)

    def test_not_a_list(self):
        self.assertEqual(sh.normalize_table({"keyword": "a"}), [])


@unittest.skipUnless(os.path.exists("/usr/lib/libxkbcommon.so.0") or __import__("ctypes.util").util.find_library("xkbcommon"), "needs libxkbcommon")
class KeyStateTest(unittest.TestCase):
    # evdev codes + 8 = xkb keycodes
    A, Q, SHIFT, CTRL, BACKSPACE, ENTER, APOSTROPHE, TWO = (30 + 8, 16 + 8, 42 + 8, 29 + 8, 14 + 8, 28 + 8, 40 + 8, 3 + 8)

    def setUp(self):
        self.xkb = sh.Xkb()

    def keys(self, layout="us", variant=""):
        return sh.KeyState(self.xkb, self.xkb.keymap(layout=layout, variant=variant))

    def tap(self, ks, code):
        r = ks.press(code)
        ks.update(code, True)
        ks.update(code, False)
        return r

    def test_plain_and_shifted(self):
        ks = self.keys()
        self.assertEqual(self.tap(ks, self.A), ("text", "a"))
        ks.update(self.SHIFT, True)
        self.assertEqual(self.tap(ks, self.TWO), ("text", "@"))
        ks.update(self.SHIFT, False)

    def test_shift_itself_is_ignored(self):
        self.assertEqual(self.keys().press(self.SHIFT), ("ignore",))

    def test_ctrl_shortcut_resets(self):
        ks = self.keys()
        ks.update(self.CTRL, True)
        self.assertEqual(ks.press(self.A), ("reset",))

    def test_backspace_and_enter(self):
        ks = self.keys()
        self.assertEqual(ks.press(self.BACKSPACE), ("backspace",))
        self.assertEqual(ks.press(self.ENTER), ("reset",))

    def test_dead_key_composes(self):
        ks = self.keys("us", "intl")
        if not self.xkb.compose_table:
            self.skipTest("no compose table for this locale")
        self.assertEqual(self.tap(ks, self.APOSTROPHE), ("ignore",))
        self.assertEqual(self.tap(ks, self.A), ("text", "á"))

    def test_second_layout(self):
        ks = sh.KeyState(self.xkb, self.xkb.keymap(layout="us,de"), 1)
        # Q is Q on both, but de's Y/Z swap is the classic tell.
        self.assertEqual(self.tap(ks, 21 + 8), ("text", "z"))

    def test_caps_lock_on_at_start(self):
        km = self.xkb.keymap(layout="us")
        lock = self.xkb.keymap_mod_get_index(km, b"Lock")
        ks = sh.KeyState(self.xkb, km, 0, 1 << lock)
        self.assertEqual(self.tap(ks, self.A), ("text", "A"))

    def test_unknown_option_keeps_layout(self):
        self.assertTrue(self.xkb.keymap(layout="us", options="nonsense:option"))

    def test_keysym_names(self):
        self.assertEqual(self.xkb.keysym_name("a"), "a")
        self.assertEqual(self.xkb.keysym_name("ã"), "atilde")
        self.assertEqual(self.xkb.keysym_name("😀"), "U1F600")


class KeymapTest(unittest.TestCase):
    """What the virtual keyboard types must agree with the physical key it
    claims to be. Apps that read the key position (Chromium's DOM `code`, web
    editors) once saw "." on Backspace's keycode and deleted a character."""

    def setUp(self):
        import ctypes
        self.xkb = sh.Xkb()
        fn = self.xkb.lib.xkb_keymap_new_from_string
        fn.restype, fn.argtypes = ctypes.c_void_p, [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int, ctypes.c_int]
        self.compile = lambda text: fn(self.xkb.ctx, text.encode(), 1, 0)

    def typed(self, state, code, shift):
        self.xkb.state_update_mask(state, 1 if shift else 0, 0, 0, 0, 0, 0)
        return self.xkb.utf8(self.xkb.state_key_get_utf8, state, code + 8)

    def test_every_character_is_on_its_real_us_key(self):
        km = self.compile(sh.keymap_text(["atilde", "U1F600"]))
        self.assertTrue(km)
        state = self.xkb.state_new(km)
        printable = "".join(chr(c) for c in range(32, 127))
        for ch in printable:
            code, shift = sh.US_POSITIONS[ch]
            self.assertEqual(self.typed(state, code, shift), ch, "character %r" % ch)
        self.assertEqual(self.typed(state, sh.EXTRA_CODES[0], False), "ã")
        self.assertEqual(self.typed(state, sh.EXTRA_CODES[1], False), "😀")
        self.assertEqual(self.xkb.state_key_get_one_sym(state, 14 + 8), 0xFF08)  # BackSpace
        self.assertEqual(self.xkb.state_key_get_one_sym(state, 28 + 8), 0xFF0D)  # Return
        self.assertEqual(self.xkb.state_key_get_one_sym(state, 15 + 8), 0xFF09)  # Tab
        self.assertEqual(self.xkb.state_key_get_one_sym(state, 105 + 8), 0xFF51)  # Left, for {cursor}

    def test_no_text_on_editing_keys(self):
        editing = {1, 14, 15, 28, 29, 42, 54, 56, 97, 100, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 125, 126}
        plan = sh.plan_chunks(sh.key_plan(4, "lucas@mechtoyou.com ã é 😀\nok", left=2))
        for extras, events in plan:
            for code, _shift in events:
                if code not in (14, 28, 105):
                    self.assertNotIn(code, editing)
        flat = [e for _x, ev in plan for e in ev]
        self.assertEqual(flat[:4], [(14, False)] * 4)
        self.assertIn((52, False), flat)  # "." on the period key
        self.assertIn((3, True), flat)    # "@" is Shift+2

    def test_held_keys_are_avoided(self):
        # "lmty": the y key is still down when "lucas@mechtoyou.com" is typed.
        y = sh.US_POSITIONS["y"][0]
        chunks = sh.plan_chunks(sh.key_plan(4, "lucas@mechtoyou.com"), avoid={y})
        self.assertEqual(len(chunks), 1)
        extras, events = chunks[0]
        self.assertEqual(extras, ["y"])
        self.assertNotIn(y, [code for code, _ in events])
        self.assertIn((sh.EXTRA_CODES[0], False), events)
        # Shift+held key: "Y" is avoided too, typed as itself from a spare key.
        extras, _ = sh.plan_chunks(["Y"], avoid={y})[0]
        self.assertEqual(extras, ["Y"])

    def test_many_unusual_characters_split_into_keymaps(self):
        chars = [chr(0x4E00 + i) for i in range(len(sh.EXTRA_CODES) + 3)]
        chunks = sh.plan_chunks(chars)
        self.assertEqual([len(x) for x, _ in chunks], [len(sh.EXTRA_CODES), 3])
        self.assertEqual(sum(len(ev) for _x, ev in chunks), len(chars))



class FakeInjector:
    def __init__(self):
        self.typed = []

    def type_keys(self, keys, delay_ms=0, avoid=()):
        self.typed.append(list(keys))


@unittest.skipUnless(os.path.exists("/usr/lib/libxkbcommon.so.0") or __import__("ctypes.util").util.find_library("xkbcommon"), "needs libxkbcommon")
class ProtocolTest(unittest.TestCase):
    """The shell talks to the expander on stdin, one command per line."""

    def setUp(self):
        self.d = sh.Daemon(input_dir="/nonexistent", sysfs="/nonexistent", use_stdin=False)
        self.d.injector, self.d.injector_kind = FakeInjector(), "fake"
        self.out = []
        self.d.emit = lambda **obj: self.out.append(obj)

    def test_table_then_type(self):
        self.d.command(json.dumps({"cmd": "snippets", "list": table(("lmail", "me@x.org"), ("tdy", ""), dynamic=("tdy",))}))
        self.assertEqual(self.d.matcher.match("lmail"), ("lmail", "me@x.org", False))
        self.assertEqual(self.d.typed.limit, 5)
        self.d.command(json.dumps({"cmd": "type", "backspaces": 3, "text": "Hi !", "left": 1}))
        self.assertEqual(self.d.injector.typed, [["BackSpace"] * 3 + ["H", "i", " ", "!", "Left"]])

    def test_type_is_clamped_and_checked(self):
        self.d.command(json.dumps({"cmd": "type", "backspaces": 999, "text": "a", "left": 50}))
        self.assertEqual(self.d.injector.typed[0], ["BackSpace"] * sh.MAX_KEYWORD + ["a", "Left"])
        self.d.command(json.dumps({"cmd": "type", "backspaces": "3", "text": "a"}))
        self.d.command('{"cmd": "type", "backspaces": 1, "text": ["a"]}')
        self.d.command("{not json")
        self.d.command("[1]")
        self.assertEqual(len(self.d.injector.typed), 1)

    def test_pause_and_resume(self):
        self.d.typed.add("abc")
        self.d.command("pause")
        self.assertTrue(self.d.paused)
        self.assertEqual(self.d.typed.text, "")
        self.d.command("resume")
        self.assertFalse(self.d.paused)

    def test_lines_split_across_reads(self):
        r, w = os.pipe()
        try:
            os.set_blocking(r, False)
            saved = sys.stdin
            sys.stdin = os.fdopen(r, "rb", buffering=0, closefd=False)
            line = json.dumps({"cmd": "snippets", "list": table(("k" * 10, "v" * 3000))}).encode() + b"\n"
            os.write(w, line[:100])
            self.d.read_stdin()
            self.assertEqual(self.d.matcher.table, {})
            os.write(w, line[100:] + b"pause\n")
            self.d.read_stdin()
            self.assertIn("k" * 10, self.d.matcher.table)
            self.assertTrue(self.d.paused)
        finally:
            sys.stdin = saved
            os.close(r)
            os.close(w)

    def test_dynamic_keyword_asks_the_shell(self):
        self.d.command(json.dumps({"cmd": "snippets", "list": table(("tdy", ""), dynamic=("tdy",))}))
        self.d.typed.add("td")
        dev = sh.Device("/dev/null", "keyboard", -1)
        dev.keys = type("K", (), {"press": lambda s, c: ("text", "y"), "update": lambda s, c, d: None})()
        self.d.on_key(dev, 21, 1)
        self.assertIn({"event": "expand", "keyword": "tdy"}, self.out)
        self.assertIsNone(self.d.pending)


class WtypeTest(unittest.TestCase):
    """The fallback typist gets text on stdin, never in its argv."""

    def test_text_goes_to_stdin(self):
        calls = []
        real_run, real_which = sh.subprocess.run, sh.shutil.which
        sh.subprocess.run = lambda args, **kw: calls.append((args, kw.get("input")))
        sh.shutil.which = lambda name: "/usr/bin/" + name
        try:
            sh.WtypeKeyboard().type_keys(sh.key_plan(2, "-secret\nline\tx", left=3))
        finally:
            sh.subprocess.run, sh.shutil.which = real_run, real_which
        args, stdin = calls[0]
        self.assertEqual(args, ["wtype", "-k", "BackSpace", "-k", "BackSpace", "-", "-k", "Left", "-k", "Left", "-k", "Left"])
        self.assertEqual(stdin, "-secret\nline\tx".encode())
        self.assertFalse(any("secret" in a for a in args))


class WireTest(unittest.TestCase):
    def test_string_padding(self):
        self.assertEqual(sh.wire_string("abc"), struct.pack("=I", 4) + b"abc\0")
        self.assertEqual(sh.wire_string("abcd"), struct.pack("=I", 5) + b"abcd\0\0\0\0")

    def test_message_header(self):
        msg = sh.wire_message(7, 2, b"\0" * 4)
        self.assertEqual(struct.unpack("=II", msg[:8]), (7, (12 << 16) | 2))


class ClassifyTest(unittest.TestCase):
    def write_caps(self, root, name, ev, keys):
        caps = os.path.join(root, name, "device", "capabilities")
        os.makedirs(caps)
        with open(os.path.join(caps, "ev"), "w") as f:
            f.write("%x\n" % ev)
        bits = 0
        for k in keys:
            bits |= 1 << k
        words = []
        while bits:
            words.append("%x" % (bits & (2 ** 64 - 1)))
            bits >>= 64
        with open(os.path.join(caps, "key"), "w") as f:
            f.write(" ".join(reversed(words or ["0"])) + "\n")

    def test_kinds(self):
        with tempfile.TemporaryDirectory() as d:
            self.write_caps(d, "event0", 0x3, range(1, 100))
            self.write_caps(d, "event1", 0x7, [0x110, 0x111])
            self.write_caps(d, "event2", 0x3, [116])  # power button
            self.write_caps(d, "event3", 0x1, [])
            self.assertEqual(sh.classify("event0", d), "keyboard")
            self.assertEqual(sh.classify("event1", d), "pointer")
            self.assertIsNone(sh.classify("event2", d))
            self.assertIsNone(sh.classify("event3", d))
            self.assertIsNone(sh.classify("event9", d))


if __name__ == "__main__":
    unittest.main()
