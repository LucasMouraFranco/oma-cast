// Snippet placeholders (SPEC §8.3): {keyword opt="v" | modifier | modifier}.
// Pure logic, shared by Paste/Copy in Search Snippets and keyword expansion.
//
// Supported: {cursor}, {clipboard offset=N}, {uuid}, {date}, {time},
// {datetime}, {day} (format=, offset=; locale= is accepted and ignored, since
// QML has no Intl [D]) and the modifiers uppercase, lowercase, trim,
// percent-encode, json-stringify and raw. Not yet: {argument}, {snippet},
// {calculator} and {selection}; those, and anything unknown or malformed,
// stay in the text as typed.

var KEYWORDS = ["cursor", "clipboard", "uuid", "date", "time", "datetime", "day"]
var MODIFIERS = ["uppercase", "lowercase", "trim", "percent-encode", "json-stringify", "raw"]

// Opening quote → closing quote [O].
var QUOTES = { "\"": "\"", "'": "'", "`": "`", "“": "”", "‘": "’" }

function isIdent(c) { return /[A-Za-z0-9_-]/.test(c) }

// Parses the placeholder starting at text[start] === "{". Returns
// {end, keyword, options, positional, modifiers} with end just past "}", or
// null when this isn't a placeholder (then the "{" is literal).
function parseAt(text, start) {
  var i = start + 1
  var n = text.length
  function spaces() { while (i < n && (text[i] === " " || text[i] === "\t")) i++ }
  function ident() {
    var s = i
    while (i < n && isIdent(text[i])) i++
    return text.slice(s, i)
  }
  function quoted() {
    var close = QUOTES[text[i]]
    var out = ""
    i++
    while (i < n) {
      var c = text[i]
      if (c === "\n") return null
      if (c === "\\" && i + 1 < n) { out += text[i + 1]; i += 2; continue }
      if (c === close) { i++; return out }
      out += c
      i++
    }
    return null
  }
  function bare() {
    var s = i
    while (i < n && !/[\s|}]/.test(text[i])) i++
    return text.slice(s, i)
  }

  spaces()
  var keyword = ident()
  if (!keyword || !/^[a-z]/.test(keyword)) return null
  var options = {}, positional = [], modifiers = []
  for (;;) {
    spaces()
    if (i >= n || text[i] === "\n") return null
    var c = text[i]
    if (c === "}") return { end: i + 1, keyword: keyword, options: options, positional: positional, modifiers: modifiers }
    if (c === "|") {
      i++
      spaces()
      var mod = ident()
      if (!mod) return null
      modifiers.push(mod)
      continue
    }
    if (QUOTES[c]) {
      var q = quoted()
      if (q === null) return null
      positional.push(q)
      continue
    }
    var save = i
    var name = ident()
    if (name && text[i] === "=") {
      i++
      var value = QUOTES[text[i]] ? quoted() : bare()
      if (value === null) return null
      options[name] = value
      continue
    }
    i = save
    var token = bare()
    if (!token) return null
    positional.push(token)
  }
}

// Every placeholder in the text, in order, known or not.
function scan(text) {
  var s = String(text || "")
  var out = []
  for (var i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue
    var p = parseAt(s, i)
    if (!p) continue
    p.start = i
    out.push(p)
    i = p.end - 1
  }
  return out
}

function isKnown(p) { return KEYWORDS.indexOf(p.keyword) >= 0 }

// What resolving needs from the outside: the clipboard history offsets used.
function needs(text) {
  var out = { clipboard: [], dynamic: false }
  scan(text).forEach(function(p) {
    if (!isKnown(p)) return
    out.dynamic = true
    if (p.keyword === "clipboard") {
      var off = parseInt(p.options.offset || "0", 10)
      out.clipboard.push(isFinite(off) && off > 0 ? off : 0)
    }
  })
  return out
}

// ------------------------------------------------------------------- dates

var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

function pad(n, width) {
  var s = String(n)
  while (s.length < width) s = "0" + s
  return s
}

// "+1d -2h 30m": m minutes, h hours, d days, w weeks [D], M months, y years.
// Returns a new Date, or null when the offset doesn't parse.
function applyOffset(date, offset) {
  var d = new Date(date.getTime())
  var s = String(offset || "").trim()
  if (!s) return d
  var re = /([+-]?)\s*(\d+)\s*([mhdwMy])/g
  var m, consumed = ""
  while ((m = re.exec(s)) !== null) {
    consumed += m[0]
    var v = parseInt(m[2], 10) * (m[1] === "-" ? -1 : 1)
    switch (m[3]) {
      case "m": d.setMinutes(d.getMinutes() + v); break
      case "h": d.setHours(d.getHours() + v); break
      case "d": d.setDate(d.getDate() + v); break
      case "w": d.setDate(d.getDate() + 7 * v); break
      case "M": d.setMonth(d.getMonth() + v); break
      case "y": d.setFullYear(d.getFullYear() + v); break
    }
  }
  if (consumed.replace(/\s+/g, "") !== s.replace(/\s+/g, "")) return null
  return d
}

// A subset of ICU/Unicode date patterns: y yy yyyy, M MM MMM MMMM, d dd,
// E EEE EEEE (and e/c alike), H HH, h hh, m mm, s ss, S…, a, D, and 'quoted'
// literals ('' is a quote). Other letters are kept as written. [D]
function formatDate(date, pattern) {
  var out = ""
  var p = String(pattern)
  for (var i = 0; i < p.length;) {
    var c = p[i]
    if (c === "'") {
      if (p[i + 1] === "'") { out += "'"; i += 2; continue }
      // A quoted literal; '' inside it is one quote.
      for (i++; i < p.length; i++) {
        if (p[i] !== "'") { out += p[i]; continue }
        if (p[i + 1] === "'") { out += "'"; i++; continue }
        i++
        break
      }
      continue
    }
    if (!/[A-Za-z]/.test(c)) { out += c; i++; continue }
    var k = i
    while (k < p.length && p[k] === c) k++
    var len = k - i
    i = k
    var h = date.getHours()
    switch (c) {
      case "y": out += len === 2 ? pad(date.getFullYear() % 100, 2) : pad(date.getFullYear(), len); break
      case "M": case "L":
        out += len >= 4 ? MONTHS[date.getMonth()] : len === 3 ? MONTHS[date.getMonth()].slice(0, 3) : pad(date.getMonth() + 1, len)
        break
      case "d": out += pad(date.getDate(), len); break
      case "D":
        var startOfYear = new Date(date.getFullYear(), 0, 1)
        out += pad(Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()) - startOfYear) / 86400000) + 1, len)
        break
      case "E": case "e": case "c":
        if ((c !== "E") && len <= 2) out += pad(date.getDay() || 7, len)
        else out += len >= 4 ? DAYS[date.getDay()] : DAYS[date.getDay()].slice(0, 3)
        break
      case "H": out += pad(h, len); break
      case "h": out += pad(h % 12 || 12, len); break
      case "m": out += pad(date.getMinutes(), len); break
      case "s": out += pad(date.getSeconds(), len); break
      case "S": out += pad(Math.floor(date.getMilliseconds() / Math.pow(10, Math.max(0, 3 - len))), len).slice(0, len); break
      case "a": out += h < 12 ? "AM" : "PM"; break
      default: out += c.repeat(len)
    }
  }
  return out
}

// Defaults when no format is given [I]: the en-GB medium style Raycast shows.
function defaultFormat(keyword, hour12) {
  var time = hour12 ? "h:mm a" : "HH:mm"
  if (keyword === "time") return time
  if (keyword === "datetime") return "d MMM yyyy 'at' " + time
  if (keyword === "day") return "EEEE"
  return "d MMM yyyy"
}

// ----------------------------------------------------------------- resolve

function applyModifiers(value, modifiers) {
  var v = String(value)
  for (var i = 0; i < modifiers.length; i++) {
    switch (modifiers[i]) {
      case "uppercase": v = v.toUpperCase(); break
      case "lowercase": v = v.toLowerCase(); break
      case "trim": v = v.trim(); break
      case "percent-encode": v = encodeURIComponent(v); break
      case "json-stringify": v = JSON.stringify(v); break
      case "raw": break
    }
  }
  return v
}

function uuid4(random) {
  var hex = "0123456789abcdef"
  var out = ""
  for (var i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) { out += "-"; continue }
    if (i === 14) { out += "4"; continue }
    var r = Math.floor(random() * 16)
    out += hex[i === 19 ? (r & 3) | 8 : r]
  }
  return out
}

// Resolves every known placeholder.
// ctx: { now: Date, hour12: bool, clipboard(offset) → string, random() → [0,1) }
// Returns { text, cursor } where cursor is how many characters (code points)
// of the result come after {cursor}, or -1 without one. Only the first
// {cursor} counts; later ones are dropped [O: at most one].
function resolve(text, ctx) {
  var s = String(text || "")
  ctx = ctx || {}
  var now = ctx.now || new Date()
  var random = ctx.random || Math.random
  var out = "", cursorAt = -1, last = 0
  var list = scan(s)
  for (var i = 0; i < list.length; i++) {
    var p = list[i]
    if (!isKnown(p)) continue
    var value = null
    switch (p.keyword) {
      case "cursor":
        out += s.slice(last, p.start)
        if (cursorAt < 0) cursorAt = out.length
        last = p.end
        continue
      case "clipboard":
        var off = parseInt(p.options.offset || "0", 10)
        value = ctx.clipboard ? ctx.clipboard(isFinite(off) && off > 0 ? off : 0) : ""
        break
      case "uuid":
        value = uuid4(random)
        break
      default:
        // date, time, datetime, day; {date "yyyy" +1d} is the legacy form [O].
        var format = p.options.format, offset = p.options.offset
        p.positional.forEach(function(v) {
          if (offset === undefined && /^[+-]\s*\d/.test(v)) offset = v
          else if (format === undefined) format = v
        })
        var when = applyOffset(now, offset)
        if (!when) continue
        value = formatDate(when, format || defaultFormat(p.keyword, !!ctx.hour12))
    }
    out += s.slice(last, p.start) + applyModifiers(value === null || value === undefined ? "" : value, p.modifiers)
    last = p.end
  }
  out += s.slice(last)
  var cursor = -1
  if (cursorAt >= 0) cursor = codePoints(out.slice(cursorAt).replace(/\r/g, ""))
  return { text: out, cursor: cursor }
}

function codePoints(s) {
  var n = 0
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i)
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) i++
    n++
  }
  return n
}

if (typeof module !== "undefined") {
  module.exports = {
    KEYWORDS: KEYWORDS, MODIFIERS: MODIFIERS, parseAt: parseAt, scan: scan, needs: needs,
    applyOffset: applyOffset, formatDate: formatDate, defaultFormat: defaultFormat,
    applyModifiers: applyModifiers, uuid4: uuid4, resolve: resolve, codePoints: codePoints
  }
}
