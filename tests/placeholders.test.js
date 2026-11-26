const test = require("node:test")
const assert = require("node:assert/strict")
const P = require("../core/Placeholders.js")

// Wednesday 25 November 2026, 09:05:07.
const now = new Date(2026, 10, 25, 9, 5, 7, 123)
const ctx = (extra) => Object.assign({ now, hour12: false, clipboard: (n) => ["current", "previous", "older"][n] || "" }, extra)
const r = (text, extra) => P.resolve(text, ctx(extra))

test("plain text and unknown placeholders stay as typed", () => {
  assert.deepEqual(r("hello {world} {argument name=\"x\"} {"), { text: "hello {world} {argument name=\"x\"} {", cursor: -1 })
  assert.equal(r("{ date}").text, "25 Nov 2026") // spaces before the keyword are fine
  assert.equal(r("{Date}").text, "{Date}")
  assert.equal(r("{date\n}").text, "{date\n}")   // a newline aborts
  assert.equal(r("{date format=\"yyyy}").text, "{date format=\"yyyy}") // unterminated quote
})

test("dates, times and days with formats", () => {
  assert.equal(r("{date}").text, "25 Nov 2026")
  assert.equal(r("{time}").text, "09:05")
  assert.equal(r("{time}", { hour12: true }).text, "9:05 AM")
  assert.equal(r("{datetime}").text, "25 Nov 2026 at 09:05")
  assert.equal(r("{day}").text, "Wednesday")
  assert.equal(r('{date format="yyyy-MM-dd"}').text, "2026-11-25")
  assert.equal(r("{date format='EEEE, d MMMM yy'}").text, "Wednesday, 25 November 26")
  assert.equal(r("{date format=“HH:mm:ss.SSS”}").text, "09:05:07.123")
  assert.equal(r("{date format=\"h 'o''clock' a\"}").text, "9 o'clock AM")
  assert.equal(r('{date format="D"}').text, "329")
  assert.equal(r('{date format=`EEE dd/MM`}').text, "Wed 25/11")
})

test("offsets", () => {
  assert.equal(r('{date format="yyyy-MM-dd" offset="+1d"}').text, "2026-11-26")
  assert.equal(r('{date format="yyyy-MM-dd HH:mm" offset="+1d -2h"}').text, "2026-11-26 07:05")
  assert.equal(r('{date format="yyyy-MM" offset="+2M"}').text, "2027-01")
  assert.equal(r('{date format="yyyy" offset="-1y"}').text, "2025")
  assert.equal(r('{time offset="+30m"}').text, "09:35")
  assert.equal(r('{date format="d MMM" offset="+1w"}').text, "2 Dec")
  // A bad offset leaves the placeholder alone.
  assert.equal(r('{date offset="soon"}').text, '{date offset="soon"}')
  // The legacy positional form.
  assert.equal(r('{date "yyyy-MM-dd" +1d}').text, "2026-11-26")
})

test("cursor: characters after it, only the first counts", () => {
  assert.deepEqual(r("Hi {cursor}!"), { text: "Hi !", cursor: 1 })
  assert.deepEqual(r("{cursor}ab{cursor}c"), { text: "abc", cursor: 3 })
  assert.deepEqual(r("a{cursor}\r\nb😀"), { text: "a\r\nb😀", cursor: 3 })
  assert.equal(r("no cursor").cursor, -1)
})

test("clipboard offsets, uuid and modifiers", () => {
  assert.equal(r("[{clipboard}]").text, "[current]")
  assert.equal(r("{clipboard offset=1}").text, "previous")
  assert.equal(r('{clipboard offset="2"}').text, "older")
  assert.equal(r("{clipboard offset=9}").text, "")
  assert.equal(r("{clipboard | uppercase}").text, "CURRENT")
  assert.equal(r("{clipboard offset=1|uppercase|lowercase}").text, "previous")
  assert.equal(r("{clipboard | percent-encode}", { clipboard: () => "a b&c" }).text, "a%20b%26c")
  assert.equal(r("{clipboard | json-stringify}", { clipboard: () => 'say "hi"' }).text, '"say \\"hi\\""')
  assert.equal(r("{clipboard | trim}", { clipboard: () => "  x  " }).text, "x")
  assert.equal(r("{date format=\"MMM\" | uppercase}").text, "NOV")
  let i = 0
  const seq = [0.1, 0.5, 0.99, 0.0]
  const id = r("{uuid}", { random: () => seq[i++ % seq.length] }).text
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.match(P.resolve("{uuid}").text, /^[0-9a-f-]{36}$/)
})

test("escapes inside quoted options", () => {
  assert.equal(r('{date format="\'\\"\'yyyy"}').text, '"2026')
})

test("needs() reports dynamic text and clipboard offsets", () => {
  assert.deepEqual(P.needs("plain {thing}"), { clipboard: [], dynamic: false })
  assert.deepEqual(P.needs("{clipboard} {clipboard offset=2} {date}"), { clipboard: [0, 2], dynamic: true })
  assert.equal(P.needs("{cursor}").dynamic, true)
})
