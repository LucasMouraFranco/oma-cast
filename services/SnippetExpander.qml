import QtQuick
import Quickshell.Io

// Keyword expansion (SPEC §5.4): runs bin/omacast-expander while enabled.
// The expander reads keyboards (evdev), matches the keyword table it gets on
// stdin and types replacements through the Wayland virtual keyboard. Static
// snippets expand inside the expander with no round-trip; one with
// placeholders comes back here as expandRequested(keyword), and the shell
// answers with typeExpansion(). Snippet text only ever travels on stdin.
Item {
  id: expander

  property bool enabled: false
  // A function returning Snippets.expansionTable(); called on each push.
  property var table: null

  signal expandRequested(string keyword)
  signal message(string level, string text, var metadata)

  readonly property string script: decodeURIComponent(Qt.resolvedUrl("../bin/omacast-expander").toString().replace(/^file:\/\//, ""))

  // starting, running, no-access (keyboards exist but can't be read),
  // no-keyboards, no-injector (can't type into this compositor), stopped.
  property string state: "stopped"
  property int keyboards: 0
  property string injector: ""
  readonly property bool needsAccess: expander.enabled && expander.state === "no-access"
  property bool granting: false

  // Each holder (the snippet editor, the open launcher) pauses expansion, so
  // typing a keyword into omacast never expands it there.
  property var pausers: ({})
  readonly property bool paused: Object.keys(expander.pausers).length > 0

  function send(obj) {
    if (proc.running) proc.write((typeof obj === "string" ? obj : JSON.stringify(obj)) + "\n")
  }

  function pushTable() {
    if (proc.running && expander.table) expander.send({ cmd: "snippets", list: expander.table() })
  }

  function setPausedBy(key, on) {
    var next = ({})
    for (var k in expander.pausers) if (k !== key) next[k] = true
    if (on) next[key] = true
    var was = expander.paused
    expander.pausers = next
    if (expander.paused !== was) expander.send(expander.paused ? "pause" : "resume")
  }

  // backspaces: the keyword's length; cursor: characters to move left
  // afterwards for {cursor}, or -1.
  function typeExpansion(backspaces, text, cursor) {
    expander.send({ cmd: "type", backspaces: backspaces, text: String(text), left: cursor > 0 ? cursor : 0 })
  }

  function grantAccess() {
    if (expander.granting) return
    expander.granting = true
    grant.running = true
  }

  function handleLine(line) {
    var msg
    try { msg = JSON.parse(line) } catch (e) { return }
    if (!msg) return
    if (msg.event === "status") {
      var before = expander.state
      expander.state = String(msg.state || "stopped")
      expander.keyboards = Number(msg.keyboards || 0)
      expander.injector = String(msg.injector || "")
      expander.restarts = 0
      if (before !== expander.state) expander.message("info", "expander " + expander.state, { keyboards: expander.keyboards, injector: expander.injector })
    } else if (msg.event === "expand" && typeof msg.keyword === "string") {
      expander.expandRequested(msg.keyword)
    }
  }

  property int restarts: 0
  property bool alive: true

  onEnabledChanged: {
    restartTimer.stop()
    if (expander.enabled) { expander.state = "starting"; proc.running = true }
    else { proc.running = false; expander.state = "stopped" }
  }

  Process {
    id: proc
    command: ["python3", expander.script, "run"]
    stdinEnabled: true
    stdout: SplitParser { onRead: function(line) { expander.handleLine(line) } }
    stderr: SplitParser { onRead: function(line) { expander.message("warning", line, null) } }
    onStarted: {
      expander.pushTable()
      if (expander.paused) expander.send("pause")
    }
    onExited: function(exitCode) {
      expander.state = "stopped"
      if (expander.alive && expander.enabled) restartTimer.restart()
    }
  }

  Timer {
    id: restartTimer
    // 1 s, 2 s, 4 s … capped at a minute; reset by the next status line.
    interval: Math.min(60000, 1000 * Math.pow(2, Math.min(expander.restarts, 6)))
    onTriggered: {
      expander.restarts++
      if (expander.enabled) proc.running = true
    }
  }

  // `omacast-expander setup --gui` installs the uaccess udev rule through
  // the shell's polkit dialog. The expander notices within two seconds; the
  // rescan makes it immediate.
  Process {
    id: grant
    command: ["python3", expander.script, "setup", "--gui"]
    stderr: StdioCollector { id: grantErr; waitForEnd: true }
    onExited: function(exitCode) {
      expander.granting = false
      if (exitCode === 0) expander.send("rescan")
      // 126/127: pkexec dismissed or not authorized.
      else if (exitCode !== 126 && exitCode !== 127)
        expander.message("error", "keyboard access setup failed: " + (String(grantErr.text || "").trim() || "exit " + exitCode), null)
    }
  }

  Component.onDestruction: {
    expander.alive = false
    proc.running = false
  }
}
