import QtQuick
import Quickshell.Io

// The clipboard's current text, for {clipboard} when Clipboard History is
// off. wl-paste prints it on stdout; nothing private reaches an argv.
Item {
  id: reader

  property var waiting: []

  function read(callback) {
    reader.waiting = reader.waiting.concat([callback])
    if (!proc.running) proc.running = true
  }

  Process {
    id: proc
    command: ["wl-paste", "--no-newline", "--type", "text"]
    stdout: StdioCollector { id: out; waitForEnd: true }
    onExited: function(exitCode) {
      var text = exitCode === 0 ? String(out.text || "") : ""
      var callbacks = reader.waiting
      reader.waiting = []
      callbacks.forEach(function(cb) { cb(text) })
    }
  }
}
