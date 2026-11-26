const test = require("node:test")
const assert = require("node:assert/strict")
const S = require("../core/Snippets.js")

const now = new Date(2026, 10, 25, 12, 0).getTime()
let n = 0
const nextId = () => "s" + (++n)

function make(list) {
  let out = []
  for (const f of list) out = S.create(out, f, nextId(), now)
  return out
}

test("validates keywords like the expander", () => {
  assert.ok(S.validKeyword(""))
  assert.ok(S.validKeyword(";sig"))
  assert.ok(S.validKeyword("a b"))
  assert.ok(!S.validKeyword("   "))
  assert.ok(!S.validKeyword("a\nb"))
  assert.ok(!S.validKeyword("a\tb"))
  assert.ok(!S.validKeyword("x".repeat(65)))
  assert.ok(S.validKeyword("x".repeat(64)))
})

test("problem() explains what can't be saved", () => {
  const list = make([{ name: "Mail", text: "me@x.org", keyword: "lmail" }])
  assert.equal(S.problem(list, { name: "", text: "t" }), "Give the snippet a name")
  assert.equal(S.problem(list, { name: "n", text: "" }), "The snippet has no text")
  assert.match(S.problem(list, { name: "n", text: "t", keyword: "lmail" }), /already in use by “Mail”/)
  // Editing the snippet that owns the keyword is fine.
  assert.equal(S.problem(list, { name: "Mail", text: "new", keyword: "lmail" }, list[0].id), "")
  assert.match(S.problem(list, { name: "n", text: "t", keyword: "a\u0001" }), /control characters/)
  // The keyword is trimmed before checking.
  assert.match(S.problem(list, { name: "n", text: "t", keyword: " lmail " }), /already in use/)
})

test("create, update, remove, pin and use", () => {
  let list = make([{ name: "A", text: "a", keyword: "aa" }, { name: "B", text: "b" }])
  assert.equal(list.length, 2)
  assert.equal(list[0].keyword, "aa")
  assert.equal(list[1].keyword, "")
  list = S.update(list, list[1].id, { name: "B2", text: "bb", keyword: " bk " }, now + 1)
  assert.equal(list[1].name, "B2")
  assert.equal(list[1].keyword, "bk")
  assert.equal(list[1].updatedAt, now + 1)
  list = S.setPinned(list, list[1].id, true)
  list = S.setPinned(list, list[0].id, true)
  assert.equal(list[1].pinned, 0)
  assert.equal(list[0].pinned, 1)
  list = S.markUsed(list, list[0].id, now + 5)
  assert.equal(list[0].useCount, 1)
  assert.equal(list[0].usedAt, now + 5)
  list = S.remove(list, list[0].id)
  assert.equal(list.length, 1)
  assert.equal(S.find(list, "snippet:" + list[0].id).name, "B2")
})

test("a keyword hidden inside another never fires", () => {
  const list = make([{ name: "lm", text: "x", keyword: "lm" }, { name: "lmail", text: "y", keyword: "lmail" }, { name: "il", text: "z", keyword: "il" }])
  assert.equal(S.shadowedBy(list, "lmail", list[1].id), "lm")
  // At the very end the longer one wins: "ail" doesn't hide "il".
  assert.equal(S.shadowedBy(list, "ail", ""), "")
  assert.equal(S.shadowedBy(list, "lm", list[0].id), "")
})

test("sections: pinned first, then by last use, exact keyword on top", () => {
  let list = make([
    { name: "Zed", text: "z", keyword: "zz" },
    { name: "Alpha", text: "a", keyword: "al" },
    { name: "Beta", text: "talk", keyword: "be" }
  ])
  list = S.markUsed(list, list[0].id, now + 10)
  let sec = S.sections(list, "")
  assert.equal(sec.length, 1)
  assert.equal(sec[0].title, "")
  assert.deepEqual(sec[0].rows.map((r) => r.candidate.title), ["Zed", "Alpha", "Beta"])
  list = S.setPinned(list, list[2].id, true)
  sec = S.sections(list, "")
  assert.deepEqual(sec.map((s) => s.title), ["Pinned", "Snippets"])
  assert.equal(sec[0].rows[0].candidate.title, "Beta")
  // "al" matches Alpha by keyword and Beta by text ("talk"); the keyword wins.
  sec = S.sections(S.setPinned(list, list[2].id, false), "al")
  assert.deepEqual(sec[0].rows.map((r) => r.candidate.title), ["Alpha", "Beta"])
  const c = sec[0].rows[0].candidate
  assert.equal(c.id, "snippet:" + list[1].id)
  assert.equal(c.typeLabel, "al")
})

test("the expansion table has keyworded snippets; dynamic ones carry no text", () => {
  const list = make([
    { name: "a", text: "plain", keyword: "k1" },
    { name: "b", text: "today is {date}", keyword: "k2" },
    { name: "c", text: "no keyword" }
  ])
  assert.deepEqual(S.expansionTable(list), [
    { keyword: "k1", text: "plain", dynamic: false },
    { keyword: "k2", text: "", dynamic: true }
  ])
  assert.deepEqual(S.expansionTable(list, () => false)[1], { keyword: "k2", text: "today is {date}", dynamic: false })
})

test("imports Shorthand and Raycast files", () => {
  const shorthand = JSON.stringify({ version: 1, snippets: [
    { trigger: "lmail", text: "me@x.org", enabled: true },
    { trigger: "nao", text: "não", enabled: false },
    { trigger: 3, text: "bad" }
  ] })
  assert.deepEqual(S.parseImport(shorthand), [
    { name: "lmail", text: "me@x.org", keyword: "lmail" },
    { name: "nao", text: "não", keyword: "" }
  ])
  const raycast = JSON.stringify([{ name: "Sig", text: "Best,\nMe", keyword: ";sig" }, { text: "untitled text" }])
  assert.deepEqual(S.parseImport(raycast), [
    { name: "Sig", text: "Best,\nMe", keyword: ";sig" },
    { name: "untitled text", text: "untitled text", keyword: "" }
  ])
  assert.throws(() => S.parseImport("{}"), /Not a Shorthand/)
  assert.throws(() => S.parseImport("nope"))
})

test("import skips duplicates and drops taken keywords", () => {
  const list = make([{ name: "Mail", text: "me@x.org", keyword: "lmail" }])
  const r = S.importInto(list, [
    { name: "Mail", text: "me@x.org", keyword: "lmail" },
    { name: "Other mail", text: "other@x.org", keyword: "lmail" },
    { name: "", text: "x" },
    { name: "New", text: "new", keyword: "nw" }
  ], now, nextId)
  assert.equal(r.added, 2)
  assert.equal(r.skipped, 2)
  assert.equal(r.keywordsDropped, 1)
  assert.equal(r.snippets.length, 3)
  assert.equal(r.snippets[1].keyword, "")
  assert.equal(r.snippets[2].keyword, "nw")
  // Importing the same file twice adds nothing.
  assert.equal(S.importInto(r.snippets, [{ name: "New", text: "new", keyword: "nw" }], now, nextId).added, 0)
})

test("detail, actions and duplicate names", () => {
  const list = make([{ name: "lm", text: "x", keyword: "lm" }, { name: "Mail", text: "hello", keyword: "lmail" }])
  const d = S.detail(list[1], list, now)
  assert.equal(d.text, "hello")
  const info = Object.fromEntries(d.info.map((r) => [r.label, r.value]))
  assert.equal(info.Keyword, "lmail")
  assert.equal(info["Never expands"], "“lm” fires first")
  assert.equal(info["Last used"], "Never")
  const ids = S.actionsFor(list[0], "Firefox", { id: "x", title: "X" }).map((a) => a.id)
  assert.deepEqual(ids, ["paste", "copy", "edit", "duplicate", "create", "pin", "x", "delete-entry"])
  assert.equal(S.actionsFor(list[0], "Firefox")[0].title, "Paste to Firefox")
  assert.equal(S.duplicateName(list, "Mail"), "Mail copy")
  assert.equal(S.duplicateName(make([{ name: "Mail copy", text: "a" }]), "Mail"), "Mail copy 2")
})

test("normalizeSnippet repairs a hand-edited record", () => {
  const s = S.normalizeSnippet({ id: 7, name: 3, text: "t", keyword: "a\nb", pinned: "x" })
  assert.deepEqual(s, { id: "7", name: "", text: "t", keyword: "", pinned: null, createdAt: 0, updatedAt: 0, usedAt: 0, useCount: 0 })
})
