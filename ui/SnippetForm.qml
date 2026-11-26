import QtQuick
import qs.Commons

// Create / Edit Snippet (Raycast's snippet form, ref 04 App. A): Name,
// Snippet and Keyword. The first form in omacast with real text fields: the
// search field elsewhere is drawn from key events, but here the fields own
// the keyboard, so the caret, selection, Ctrl+V and input methods all work.
// Tab / Shift+Tab move between fields, Ctrl+↵ saves, Esc goes back.
Item {
  id: form

  required property var backend
  property var look: null
  property real zoom: 1
  // "" creates a new snippet; otherwise the id being edited.
  property string snippetId: ""

  signal saved(string message)
  signal cancelled()
  signal failed(string message)

  function px(v) { return Math.round(Style.space(v) * form.zoom) }

  readonly property color danger: "#e06c75"
  readonly property int labelWidth: form.px(90)
  readonly property int bodyPixelSize: Math.round(Style.font.body * form.zoom)
  readonly property real lineHeight: nameField.implicitHeight + form.px(14)

  // Live check of the keyword: a problem (it's taken) or a warning (it can
  // never fire because a shorter keyword hides inside it).
  readonly property var check: {
    nameField.text; textField.text; keywordField.text
    var r = form.backend.callSync("snippets.validate", { id: form.snippetId, name: nameField.text, text: textField.text, keyword: keywordField.text })
    return r.ok ? r.data : { problem: "", shadowedBy: "" }
  }
  readonly property string keywordNote: {
    var p = form.check.problem
    if (p.indexOf("keyword") >= 0) return p
    if (form.check.shadowedBy) return "Never expands: “" + form.check.shadowedBy + "” fires first."
    return "Type it anywhere and it turns into this snippet."
  }
  readonly property bool keywordBad: form.check.problem.indexOf("keyword") >= 0

  function load() {
    if (!form.snippetId) return
    var r = form.backend.callSync("snippets.get", { id: form.snippetId })
    if (!r.ok) { form.failed(r.error); return }
    nameField.text = r.data.name
    textField.text = r.data.text
    keywordField.text = r.data.keyword
  }

  function save() {
    var data = { name: nameField.text, text: textField.text, keyword: keywordField.text }
    if (form.snippetId) data.id = form.snippetId
    var r = form.backend.callSync(form.snippetId ? "snippets.update" : "snippets.create", data)
    if (!r.ok) { form.failed(r.error); return }
    form.saved(form.snippetId ? "Snippet saved" : "Snippet created")
  }

  function focusFirst() { nameField.forceActiveFocus() }

  readonly property var fields: [nameField, textField, keywordField]
  function cycle(from, step) {
    var i = form.fields.indexOf(from)
    form.fields[(i + step + form.fields.length) % form.fields.length].forceActiveFocus()
  }

  // Keys every field shares. Returns true when handled.
  function handleKey(event, field) {
    var ctrl = (event.modifiers & Qt.ControlModifier) !== 0
    var enter = event.key === Qt.Key_Return || event.key === Qt.Key_Enter
    if (event.key === Qt.Key_Escape) { form.cancelled(); return true }
    if (enter && ctrl) { form.save(); return true }
    if (event.key === Qt.Key_Backtab || (event.key === Qt.Key_Tab && (event.modifiers & Qt.ShiftModifier))) { form.cycle(field, -1); return true }
    if (event.key === Qt.Key_Tab && !ctrl) { form.cycle(field, 1); return true }
    // ↵ in a one-line field moves on; in the last one it saves.
    if (enter && field !== textField) {
      if (field === keywordField) form.save()
      else form.cycle(field, 1)
      return true
    }
    return false
  }

  Component.onCompleted: {
    form.load()
    form.backend.callSync("snippets.setEditing", { editing: true })
    Qt.callLater(form.focusFirst)
  }
  Component.onDestruction: form.backend.callSync("snippets.setEditing", { editing: false })

  component FieldFrame: Rectangle {
    property bool active: false
    property bool bad: false
    radius: Style.cornerRadius
    color: Util.alpha(form.look.foreground, 0.05)
    border.width: 1
    border.color: bad ? form.danger : active ? form.look.accent : Util.alpha(form.look.foreground, 0.15)
  }

  component Label: Text {
    width: form.labelWidth
    horizontalAlignment: Text.AlignRight
    textFormat: Text.PlainText
    color: form.look.foreground
    opacity: 0.7
    font.family: form.look.fontFamily
    font.pixelSize: Math.round(Style.font.bodySmall * form.zoom)
  }

  component Note: Text {
    textFormat: Text.PlainText
    color: form.look.foreground
    opacity: 0.55
    wrapMode: Text.Wrap
    font.family: form.look.fontFamily
    font.pixelSize: Math.round(Style.font.caption * form.zoom)
  }

  Column {
    id: column
    anchors.fill: parent
    anchors.margins: form.px(18)
    spacing: form.px(12)

    // ---------------------------------------------------------------- Name
    Row {
      width: parent.width
      spacing: form.px(12)
      Label { text: "Name"; anchors.verticalCenter: parent.verticalCenter }
      FieldFrame {
        width: parent.width - form.labelWidth - form.px(12)
        height: form.lineHeight
        active: nameField.activeFocus
        TextInput {
          id: nameField
          anchors.fill: parent
          anchors.leftMargin: form.px(10)
          anchors.rightMargin: form.px(10)
          verticalAlignment: TextInput.AlignVCenter
          clip: true
          maximumLength: 200
          color: form.look.foreground
          selectionColor: form.look.selectedBackground
          selectedTextColor: form.look.accent
          font.family: form.look.fontFamily
          font.pixelSize: form.bodyPixelSize
          Keys.onPressed: function(event) { if (form.handleKey(event, nameField)) event.accepted = true }
          Text {
            anchors.fill: parent
            verticalAlignment: Text.AlignVCenter
            visible: !parent.text && !parent.preeditText
            textFormat: Text.PlainText
            text: "Email signature"
            color: form.look.foreground
            opacity: 0.35
            font: parent.font
          }
        }
      }
    }

    // ------------------------------------------------------------- Snippet
    Row {
      width: parent.width
      spacing: form.px(12)
      Label { text: "Snippet"; topPadding: form.px(8) }
      Column {
        width: parent.width - form.labelWidth - form.px(12)
        spacing: form.px(4)
        FieldFrame {
          width: parent.width
          // What the other rows leave: two one-line fields, the notes and the gaps.
          height: Math.max(form.px(60), column.height - form.lineHeight * 2 - column.spacing * 3
            - form.px(4) - snippetNote.height - keywordNoteText.height)
          active: textField.activeFocus
          Flickable {
            id: flick
            anchors.fill: parent
            anchors.margins: form.px(8)
            contentWidth: width
            contentHeight: textField.contentHeight
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            function ensureVisible(r) {
              if (contentY >= r.y) contentY = r.y
              else if (contentY + height <= r.y + r.height) contentY = r.y + r.height - height
            }
            TextEdit {
              id: textField
              width: flick.width
              height: Math.max(flick.height, contentHeight)
              wrapMode: TextEdit.Wrap
              textFormat: TextEdit.PlainText
              color: form.look.foreground
              selectionColor: form.look.selectedBackground
              selectedTextColor: form.look.accent
              font.family: Style.fontFamily
              font.pixelSize: form.bodyPixelSize
              onCursorRectangleChanged: flick.ensureVisible(cursorRectangle)
              Keys.onPressed: function(event) { if (form.handleKey(event, textField)) event.accepted = true }
              Text {
                visible: !parent.text && !parent.preeditText
                textFormat: Text.PlainText
                text: "Best,\nYour Name"
                color: form.look.foreground
                opacity: 0.35
                font: parent.font
              }
            }
          }
        }
        Note {
          id: snippetNote
          width: parent.width
          text: "Placeholders: {cursor} {clipboard} {date} {time} {datetime} {day} {uuid}. Options: {date format=\"yyyy-MM-dd\" offset=\"+1d\"}, {clipboard | uppercase}"
        }
      }
    }

    // ------------------------------------------------------------- Keyword
    Row {
      width: parent.width
      spacing: form.px(12)
      Label { text: "Keyword"; anchors.verticalCenter: keywordFrame.verticalCenter }
      FieldFrame {
        id: keywordFrame
        width: parent.width - form.labelWidth - form.px(12)
        height: form.lineHeight
        active: keywordField.activeFocus
        bad: form.keywordBad
        TextInput {
          id: keywordField
          anchors.fill: parent
          anchors.leftMargin: form.px(10)
          anchors.rightMargin: form.px(10)
          verticalAlignment: TextInput.AlignVCenter
          clip: true
          maximumLength: 64
          color: form.look.foreground
          selectionColor: form.look.selectedBackground
          selectedTextColor: form.look.accent
          font.family: form.look.fontFamily
          font.pixelSize: form.bodyPixelSize
          Keys.onPressed: function(event) { if (form.handleKey(event, keywordField)) event.accepted = true }
          Text {
            anchors.fill: parent
            verticalAlignment: Text.AlignVCenter
            visible: !parent.text && !parent.preeditText
            textFormat: Text.PlainText
            text: ";sig (optional)"
            color: form.look.foreground
            opacity: 0.35
            font: parent.font
          }
        }
      }
    }
    Note {
      id: keywordNoteText
      x: form.labelWidth + form.px(12)
      width: parent.width - x
      text: form.keywordNote
      color: form.keywordBad || form.check.shadowedBy ? form.danger : form.look.foreground
      opacity: form.keywordBad || form.check.shadowedBy ? 0.9 : 0.55
    }
  }
}
