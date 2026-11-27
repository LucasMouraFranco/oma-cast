// Snippets (SPEC §8.3, ref 02 §5.2): validation, the list and its sections,
// the detail pane, actions, the keyword table the expander matches against,
// and import from Shorthand and Raycast exports. Pure logic; the store lives
// in Backend.qml and the expander in services/SnippetExpander.qml.

// Same limits as the expander (bin/omacast-expander), so the list never shows
// a keyword that can't fire. [D]
var MAX_KEYWORD = 64
var MAX_TEXT = 20000
var MAX_NAME = 200
var MAX_SNIPPETS = 2000

var GLYPH = ""           // nf-fa-files_o
var DYNAMIC_GLYPH = ""   // nf-fa-bolt: has placeholders

function hasControl(s) {
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i)
    if (c < 32 || c === 127) return true
  }
  return false
}

// A keyword is optional; when set it is 1–64 characters with no line breaks
// or control characters and not only spaces.
function validKeyword(keyword) {
  if (keyword === "") return true
  if (typeof keyword !== "string") return false
  return keyword.length <= MAX_KEYWORD && keyword.trim() !== "" && !hasControl(keyword)
}

function str(v) { return typeof v === "string" ? v : "" }
function num(v) { return typeof v === "number" && isFinite(v) ? v : 0 }

// One stored snippet, with every field present and in range.
function normalizeSnippet(s) {
  return {
    id: String(s.id),
    name: str(s.name).slice(0, MAX_NAME),
    text: str(s.text).slice(0, MAX_TEXT),
    keyword: validKeyword(str(s.keyword)) ? str(s.keyword) : "",
    pinned: typeof s.pinned === "number" && isFinite(s.pinned) ? s.pinned : null,
    createdAt: num(s.createdAt),
    updatedAt: num(s.updatedAt),
    usedAt: num(s.usedAt),
    useCount: num(s.useCount)
  }
}

// What the form sends, cleaned: name and text as typed, keyword without
// surrounding spaces (a trailing space you can't see is never intended). [D]
function fields(input) {
  input = input || {}
  return { name: str(input.name).trim(), text: str(input.text), keyword: str(input.keyword).trim() }
}

function byKeyword(snippets, keyword, exceptId) {
  if (!keyword) return null
  for (var i = 0; i < snippets.length; i++)
    if (snippets[i].keyword === keyword && snippets[i].id !== exceptId) return snippets[i]
  return null
}

// Why these fields can't be saved, or "" when they can. exceptId is the
// snippet being edited.
function problem(snippets, input, exceptId) {
  var f = fields(input)
  if (!f.name) return "Give the snippet a name"
  if (f.name.length > MAX_NAME) return "The name is longer than " + MAX_NAME + " characters"
  if (!f.text) return "The snippet has no text"
  if (f.text.length > MAX_TEXT) return "The snippet is longer than " + MAX_TEXT + " characters"
  if (f.keyword.length > MAX_KEYWORD) return "The keyword is longer than " + MAX_KEYWORD + " characters"
  if (!validKeyword(f.keyword)) return "A keyword can't contain line breaks or control characters"
  var other = byKeyword(snippets, f.keyword, exceptId)
  if (other) return "This keyword is already in use by “" + other.name + "”"
  return ""
}

// Expansion fires on the key that completes a keyword, so another keyword
// inside this one (anywhere but at its very end, where the longer one wins)
// always goes off first. Returns the keyword that does, or "".
function shadowedBy(snippets, keyword, exceptId) {
  var head = String(keyword || "").slice(0, -1)
  if (!head) return ""
  var best = ""
  for (var i = 0; i < snippets.length; i++) {
    var k = snippets[i].keyword
    if (!k || snippets[i].id === exceptId || k === keyword) continue
    if (head.indexOf(k) >= 0 && k.length > best.length) best = k
  }
  return best
}

function find(snippets, id) {
  var key = String(id).replace(/^snippet:/, "")
  for (var i = 0; i < snippets.length; i++) if (snippets[i].id === key) return snippets[i]
  return null
}

// create/update/remove return a new list; callers check problem() first.
function create(snippets, input, id, nowMs) {
  var f = fields(input)
  var s = normalizeSnippet({ id: id, name: f.name, text: f.text, keyword: f.keyword, createdAt: nowMs, updatedAt: nowMs })
  return snippets.concat([s])
}

function update(snippets, id, input, nowMs) {
  var f = fields(input)
  return snippets.map(function(s) {
    if (s.id !== id) return s
    return Object.assign({}, s, { name: f.name, text: f.text, keyword: f.keyword, updatedAt: nowMs })
  })
}

function remove(snippets, id) {
  return snippets.filter(function(s) { return s.id !== id })
}

function markUsed(snippets, id, nowMs) {
  return snippets.map(function(s) {
    return s.id === id ? Object.assign({}, s, { usedAt: nowMs, useCount: (s.useCount || 0) + 1 }) : s
  })
}

function setPinned(snippets, id, pin) {
  var max = -1
  snippets.forEach(function(s) { if (typeof s.pinned === "number" && s.pinned > max) max = s.pinned })
  return snippets.map(function(s) {
    return s.id === id ? Object.assign({}, s, { pinned: pin ? max + 1 : null }) : s
  })
}

// "<name> copy", then "<name> copy 2", … with no keyword (keywords are unique).
function duplicateName(snippets, name) {
  var taken = {}
  snippets.forEach(function(s) { taken[s.name] = true })
  var base = name + " copy"
  if (!taken[base]) return base
  for (var n = 2; ; n++) if (!taken[base + " " + n]) return base + " " + n
}

// A placeholder needs resolving at expansion time: {cursor}, {date}, … .
// Matches Placeholders.KEYWORDS loosely; a false positive only costs a
// round-trip through the shell. [D]
function isDynamic(text) {
  return /\{(cursor|clipboard|uuid|date|time|datetime|day)\b[^}\n]*\}/.test(String(text || ""))
}

// What the expander matches: every snippet with a keyword (longest match is
// the expander's job). Dynamic ones carry no text: the expander asks the
// shell to resolve them. dynamicFn is Placeholders.needs(text).dynamic in
// the shell, so the table agrees exactly with what resolving would change.
function expansionTable(snippets, dynamicFn) {
  var dyn = dynamicFn || isDynamic
  var out = []
  for (var i = 0; i < snippets.length; i++) {
    var s = snippets[i]
    if (!s.keyword) continue
    var d = !!dyn(s.text)
    out.push({ keyword: s.keyword, text: d ? "" : s.text, dynamic: d })
  }
  return out
}

function preview(text) {
  return String(text || "").slice(0, 400).replace(/\s+/g, " ").trim()
}

function relativeTime(ms, nowMs) {
  if (!ms) return "Never"
  var s = Math.max(0, Math.round((nowMs - ms) / 1000))
  if (s < 60) return "Just now"
  if (s < 3600) return Math.floor(s / 60) + " min ago"
  if (s < 86400) return Math.floor(s / 3600) + " h ago"
  var d = Math.floor(s / 86400)
  return d === 1 ? "Yesterday" : d + " days ago"
}

function formatDate(ms) {
  if (!ms) return ""
  var d = new Date(ms)
  return d.toDateString() + " " + d.toTimeString().slice(0, 5)
}

function candidate(s) {
  return {
    id: "snippet:" + s.id, type: "command", kind: "snippet",
    title: s.name || preview(s.text), subtitle: preview(s.text),
    // The keyword sits where other lists show a type, as Raycast's accessory.
    typeLabel: s.keyword,
    glyph: isDynamic(s.text) ? DYNAMIC_GLYPH : GLYPH,
    pinned: typeof s.pinned === "number", rootSearch: { when: "always" }
  }
}

function matches(s, needle) {
  if (!needle) return true
  return (s.name + "\n" + s.keyword + "\n" + s.text.slice(0, 8192)).toLowerCase().indexOf(needle) >= 0
}

// Pinned (in pin order), then the rest by last use, then by name. [I]
// A query that is exactly a keyword puts that snippet first.
function sections(snippets, query) {
  var raw = String(query || "").trim()
  var needle = raw.toLowerCase()
  var list = (Array.isArray(snippets) ? snippets : []).filter(function(s) { return matches(s, needle) })
  var pinned = [], rest = []
  list.forEach(function(s) { (typeof s.pinned === "number" ? pinned : rest).push(s) })
  pinned.sort(function(a, b) { return a.pinned - b.pinned })
  rest.sort(function(a, b) {
    if (raw && (a.keyword === raw) !== (b.keyword === raw)) return a.keyword === raw ? -1 : 1
    if (a.usedAt !== b.usedAt) return b.usedAt - a.usedAt
    return a.name.localeCompare(b.name)
  })
  function rows(l) { return l.map(function(s) { return { candidate: candidate(s) } }) }
  var out = []
  if (pinned.length) out.push({ id: "snippets-pinned", title: "Pinned", rows: rows(pinned) })
  if (rest.length) out.push({ id: "snippets-all", title: pinned.length ? "Snippets" : "", rows: rows(rest) })
  return out
}

// The detail pane: the raw text (placeholders as written), then Information.
function detail(s, snippets, nowMs) {
  var info = []
  function add(label, value) { if (value !== undefined && value !== null && value !== "") info.push({ label: label, value: String(value) }) }
  add("Name", s.name)
  add("Keyword", s.keyword || "None")
  var hidden = s.keyword ? shadowedBy(snippets || [], s.keyword, s.id) : ""
  if (hidden) add("Never expands", "“" + hidden + "” fires first")
  add("Characters", s.text.length)
  add("Times used", s.useCount || 0)
  add("Last used", relativeTime(s.usedAt, nowMs))
  add("Created", formatDate(s.createdAt))
  return { category: "text", text: s.text.slice(0, 8192), image: "", color: "", info: info }
}

// Keys follow Clipboard History: Ctrl+Shift+P pins, Ctrl+D deletes; Ctrl+E
// edits, as in Raycast; Create is Ctrl+Shift+N because emacs bindings move
// down with Ctrl+N. [D]
function actionsFor(s, appName, expansion) {
  var pinned = typeof s.pinned === "number"
  var list = [
    { id: "paste", title: "Paste to " + (appName || "Active App"), shortcut: "↵", section: "primary", icon: "" },
    { id: "copy", title: "Copy to Clipboard", shortcut: "Ctrl ↵", section: "primary", icon: "" },
    { id: "edit", title: "Edit Snippet", shortcut: "Ctrl E", section: "edit", icon: "" },
    { id: "duplicate", title: "Duplicate Snippet", shortcut: "", section: "edit", icon: "" },
    { id: "create", title: "Create Snippet", shortcut: "Ctrl N", section: "edit", icon: "" },
    { id: pinned ? "unpin" : "pin", title: pinned ? "Unpin Snippet" : "Pin Snippet", shortcut: "Ctrl Shift P", section: "pin", icon: "" }
  ]
  if (expansion) list.push(expansion)
  list.push({ id: "delete-entry", title: "Delete Snippet", shortcut: "Ctrl D", section: "delete", icon: "" })
  return list
}

// ------------------------------------------------------------------ import

// Shorthand's ~/.config/shorthand/snippets.json: {snippets: [{trigger, text,
// enabled}]}. The trigger is both name and keyword; a disabled one comes in
// without a keyword, so it doesn't start expanding. [D]
function fromShorthand(text) {
  var data = JSON.parse(String(text))
  var list = data && Array.isArray(data.snippets) ? data.snippets : null
  if (!list) throw new Error("Not a Shorthand snippets file")
  return list.filter(function(s) { return s && typeof s.trigger === "string" && typeof s.text === "string" })
    .map(function(s) { return { name: s.trigger, text: s.text, keyword: s.enabled === false ? "" : s.trigger } })
}

// Raycast's Export Snippets file: [{name, text, keyword?}]. [O]
function fromRaycastExport(text) {
  var data = JSON.parse(String(text))
  if (!Array.isArray(data)) throw new Error("Not a Raycast snippets export")
  return data.filter(function(s) { return s && typeof s.text === "string" })
    .map(function(s) { return { name: str(s.name) || preview(s.text).slice(0, 60), text: s.text, keyword: str(s.keyword) } })
}

// Either format, told apart by shape.
function parseImport(text) {
  var data = JSON.parse(String(text))
  return Array.isArray(data) ? fromRaycastExport(text) : fromShorthand(text)
}

// Adds what isn't already there. A snippet with the same name, text and
// keyword is skipped; one whose keyword is taken comes in without it.
// Returns {snippets, added, skipped, keywordsDropped}.
function importInto(snippets, incoming, nowMs, nextId) {
  var out = snippets.slice(), added = 0, skipped = 0, dropped = 0
  for (var i = 0; i < incoming.length; i++) {
    if (out.length >= MAX_SNIPPETS) { skipped += incoming.length - i; break }
    var f = fields(incoming[i])
    if (!f.name || !f.text || f.text.length > MAX_TEXT) { skipped++; continue }
    var same = out.some(function(s) { return s.name === f.name.slice(0, MAX_NAME) && s.text === f.text && s.keyword === f.keyword })
    if (same) { skipped++; continue }
    if (f.keyword && (!validKeyword(f.keyword) || byKeyword(out, f.keyword, ""))) { f.keyword = ""; dropped++ }
    out = create(out, f, nextId(), nowMs)
    added++
  }
  return { snippets: out, added: added, skipped: skipped, keywordsDropped: dropped }
}

if (typeof module !== "undefined") {
  module.exports = {
    MAX_KEYWORD: MAX_KEYWORD, MAX_TEXT: MAX_TEXT, MAX_NAME: MAX_NAME, MAX_SNIPPETS: MAX_SNIPPETS,
    validKeyword: validKeyword, normalizeSnippet: normalizeSnippet, fields: fields, problem: problem,
    shadowedBy: shadowedBy, find: find, create: create, update: update, remove: remove,
    markUsed: markUsed, setPinned: setPinned, duplicateName: duplicateName, isDynamic: isDynamic,
    expansionTable: expansionTable, candidate: candidate, sections: sections, detail: detail,
    actionsFor: actionsFor, fromShorthand: fromShorthand, fromRaycastExport: fromRaycastExport,
    parseImport: parseImport, importInto: importInto
  }
}
