/*
 * textbox.spec.js
 *
 * The case list is khat's `input.rs` tests that L1 holds (`IDEAS/keys.md`
 * Phase 4) and, for L2's `VIM` tables, the ones it holds of operators, text
 * objects, finds and visual (Phase 5); each row names the one it ports, and
 * rows naming none are vim's own behavior. L2 rows step real keys through
 * `/keys`, as a host does, so a row that parses to nothing or an action the
 * reducer lacks shows here and not in a component.
 */

import { textbox, edit, editDoc, stringDoc, visualRange, shiftMarks, NORMAL, INSERT, VIM, RECORDING } from '../../src/textbox/textbox.js'
import { keymap, step, parseKeys } from '../../src/keys/keys.js'

const nm = (text, cursor) => textbox(text, { mode: 'normal', cursor })
const run = (s, ...actions) => actions.reduce((s, a) => edit(s, a), s)
const typed = (s, text) => Array.from(text).reduce((s, c) => edit(s, c === '\n' ? 'newline' : 'type', c), s)

test('textbox: insert_and_backspace — typing, backspace, delete, and both ends a no-op', function () {
  let s = typed(textbox(), 'héllo')
  assert.equal(s.text, 'héllo')
  assert.equal(s.cursor, 5)
  s = run(s, 'backspace')
  assert.equal(s.text, 'héll')
  s = edit(edit(s, 'left'), 'type', 'X')
  assert.equal(s.text, 'hélXl')
  s = edit(s, 'deleteForward')
  assert.equal(s.text, 'hélX')
  assert.equal(run(textbox('a', { cursor: 0 }), 'backspace').text, 'a')
  assert.equal(run(textbox('a'), 'deleteForward').text, 'a')
})

test('textbox: cursor_clamps — INSERT reaches past the last character, never past the ends', function () {
  let s = run(textbox('ab'), 'right')
  assert.equal(s.cursor, 2)
  s = run(s, 'lineStart', 'left')
  assert.equal(s.cursor, 0)
})

test('textbox: word_motions — punctuation is its own word, and a word crosses a newline', function () {
  let s = nm('foo bar, baz', 0)
  const at = []
  for (let i = 0; i < 4; i++) at.push((s = edit(s, 'wordForward')).cursor)
  // The last `w` ends on the last character, as NORMAL keeps it on one.
  assert.deepEqual(at, [4, 7, 9, 11])
  for (const want of [9, 7, 4, 0]) assert.equal((s = edit(s, 'wordBack')).cursor, want)
  assert.equal(run(nm('a\nb', 0), 'wordForward').cursor, 2)
})

test('textbox: word_end — e lands on a word\'s last character, across a newline', function () {
  assert.equal(run(nm('foo bar baz', 0), 'wordEnd').cursor, 2)
  assert.equal(run(nm('foo bar baz', 2), 'wordEnd').cursor, 6)
  assert.equal(run(nm('foo bar baz', 8), 'wordEnd').cursor, 10)
  assert.equal(run(nm('foo.bar baz', 0), 'wordEnd').cursor, 2)
  assert.equal(run(nm('ab\ncd', 1), 'wordEnd').cursor, 4)
})

test('textbox: vim_deletes — x, dw, D; dw never joins lines and x never eats a newline', function () {
  assert.equal(run(nm('abc', 1), 'deleteChar').text, 'ac')
  assert.equal(run(nm('one two three', 4), 'deleteWord').text, 'one three')
  assert.equal(run(nm('one two', 2), 'deleteToEnd').text, 'on')
  assert.equal(run(nm('a bc\nd', 2), 'deleteWord').text, 'a \nd')
  assert.equal(run(nm('a\n\nb', 2), 'deleteChar').text, 'a\n\nb')
  assert.equal(run(nm('abc', 1), 'deleteBack').text, 'bc')
  assert.equal(run(nm('a\nb', 2), 'deleteBack').text, 'a\nb')
})

test('textbox: delete_line — dd down to empty, the cursor on the line that took its place', function () {
  let s = run(nm('one\ntwo\nthree', 5), 'deleteLine')
  assert.equal(s.text, 'one\nthree')
  assert.equal(s.cursor, 4)
  s = run(s, 'deleteLine')
  assert.equal(s.text, 'one')
  assert.equal(s.cursor, 0)
  assert.equal(run(s, 'deleteLine').text, '')
  assert.equal(run(nm('a\nb', 0), 'deleteLine').text, 'b')
})

test('textbox: newline_paste — CRLF and a lone CR read as LF, typed or given', function () {
  let s = typed(textbox(), 'a')
  s = edit(edit(s, 'newline'), 'type', 'b\r\nc')
  assert.equal(s.text, 'a\nb\nc')
  assert.equal(s.cursor, 5)
  assert.equal(textbox('x\r\ny\rz').text, 'x\ny\nz')
})

test('textbox: normal_cursor_stays_on_chars — NORMAL rests on a character and h, l stay on the line', function () {
  assert.equal(nm('abc', 3).cursor, 2)
  assert.equal(run(nm('ab\ncd', 3), 'left').cursor, 3)
  assert.equal(run(nm('ab\ncd', 1), 'right').cursor, 1)
  assert.equal(run(nm('abc', 0), 'lineEnd').cursor, 2)
  // x on the last character steps back onto the new last one.
  const s = run(nm('abc', 2), 'deleteChar')
  assert.deepEqual([s.text, s.cursor], ['ab', 1])
  // Esc steps back onto the last character typed, never off its line.
  assert.equal(run(textbox('abc'), 'normal').cursor, 2)
  assert.equal(run(textbox('a\nb', { cursor: 2 }), 'normal').cursor, 2)
  assert.equal(run(textbox('abc'), 'normal').mode, 'normal')
})

test('textbox: line_motions — 0, ^ and $', function () {
  assert.equal(run(nm('  foo bar', 6), 'firstNonBlank').cursor, 2)
  assert.equal(run(nm('  foo bar', 6), 'lineStart').cursor, 0)
  assert.equal(run(nm('a\n  b', 0), 'firstNonBlank').cursor, 0)
  assert.equal(run(nm('ab\ncde', 3), 'lineEnd').cursor, 5)
})

test('textbox: insert_entry_ops — i, a, I and A, each entering INSERT where vim does', function () {
  assert.deepEqual(['cursor', 'mode'].map((k) => run(nm('abc', 0), 'append')[k]), [1, 'insert'])
  assert.equal(run(nm('abc', 2), 'append').cursor, 3)
  assert.equal(run(nm('  abc', 4), 'insertLineStart').cursor, 2)
  assert.equal(run(nm('ab\ncd', 0), 'appendLineEnd').cursor, 2)
  assert.equal(run(nm('abc', 1), 'insert').cursor, 1)
  // a moved the cursor and the selection went with it, so a key types beside
  // the character rather than over it.
  assert.equal(edit(run(nm('abc', 0), 'append'), 'type', 'X').text, 'aXbc')
})

test('textbox: yank_and_charwise_put — x and dw fill the register, p and P put it back', function () {
  let s = run(nm('abc', 0), 'deleteChar')
  assert.deepEqual(s.registers['"'], { text: 'a', linewise: false })
  assert.equal(run(s, 'putAfter').text, 'bac')
  s = run(nm('one two', 0), 'deleteWord')
  assert.equal(s.registers['"'].text, 'one ')
  s = run(s, 'putAfter')
  assert.deepEqual([s.text, s.cursor], ['tone wo', 4])
  assert.equal(run(nm('one two', 0), 'deleteWord', 'putBefore').text, 'one two')
  assert.equal(run(nm('a', 0), 'putAfter').text, 'a')
})

test('textbox: linewise_yank_delete_put — yy and dd hold a line, p puts it below and P above', function () {
  let s = run(nm('one\ntwo\nthree', 5), 'yankLines')
  assert.deepEqual(s.registers['"'], { text: 'two', linewise: true })
  assert.equal(s.cursor, 5)
  s = run(s, 'putAfter')
  assert.deepEqual([s.text, s.cursor], ['one\ntwo\ntwo\nthree', 8])
  s = run(s, 'putBefore')
  assert.deepEqual([s.text, s.cursor], ['one\ntwo\ntwo\ntwo\nthree', 8])
  assert.equal(run(nm('one\ntwo\nthree', 0), 'deleteLine', 'putAfter').text, 'two\none\nthree')
  assert.equal(run(nm('a\nb', 2), 'yankLines', 'putAfter').text, 'a\nb\nb')
})

test('textbox: undo_redo_normal_changes — each change a step, a new change drops redo', function () {
  let s = run(nm('one two three', 0), 'deleteWord', 'deleteWord')
  assert.equal(s.text, 'three')
  s = run(s, 'undo')
  assert.equal(s.text, 'two three')
  s = run(s, 'undo')
  assert.equal(s.text, 'one two three')
  assert.equal(run(s, 'undo').text, 'one two three')
  s = run(s, 'redo')
  assert.equal(s.text, 'two three')
  assert.equal(run(s, 'redo', 'redo').text, 'three')
  s = run(s, 'undo', 'deleteChar', 'redo')
  assert.equal(s.text, 'ne two three')
})

test('textbox: undo_groups_an_insert_session — i, typing and Esc are one step; a yank is none', function () {
  let s = typed(run(nm('abc', 0), 'insert'), 'hello ')
  s = run(s, 'normal')
  assert.equal(s.text, 'hello abc')
  s = run(s, 'undo')
  assert.deepEqual([s.text, s.cursor], ['abc', 0])
  assert.equal(run(s, 'redo').text, 'hello abc')
  assert.equal(run(nm('a b', 0), 'yankLines', 'undo').text, 'a b')
  // INSERT's own backspace is part of the session, not a step of its own.
  s = run(typed(run(nm('ab', 1), 'append'), 'xy'), 'backspace', 'normal', 'undo')
  assert.equal(s.text, 'ab')
})

test('textbox: a character is a grapheme — h, l and x step over an emoji and an accent whole', function () {
  const flag = '🇳🇴', thumb = '👍🏽', e = 'é'
  const text = `a${flag}${thumb}${e}b`
  let s = nm(text, 0)
  const at = []
  for (let i = 0; i < 4; i++) at.push((s = edit(s, 'right')).cursor)
  assert.deepEqual(at, [1, 1 + flag.length, 1 + flag.length + thumb.length, 1 + flag.length + thumb.length + e.length])
  assert.equal(run(nm(text, 1), 'deleteChar').text, `a${thumb}${e}b`)
  assert.equal(run(textbox(`x${thumb}`), 'backspace').text, 'x')
  // A cursor handed in between a pair's halves rests on the pair.
  assert.equal(nm(`${thumb}z`, 1).cursor, 0)
  assert.equal(run(nm(`ab ${thumb}`, 0), 'lineEnd').cursor, 3)
})

test('textbox: a selection a host hands in is what a typed key replaces', function () {
  const s = textbox('hello world', { cursor: 11, anchor: 6 })
  assert.equal(edit(s, 'type', 'there').text, 'hello there')
  assert.equal(edit(s, 'backspace').text, 'hello ')
  assert.equal(edit(edit(s, 'left'), 'type', '!').text, 'hello worl!d')
  assert.equal(nm('hello', 4).anchor, 4)
})

test('textbox: refusals — an action the box lacks, an inherited name, and type with no text', function () {
  const s = textbox('a')
  assert.throws(() => edit(s, 'deleteWordd'), /no such action; the tables NORMAL, INSERT and VIM/)
  assert.throws(() => edit(s, 'toString'), /no such action/)
  assert.throws(() => edit(s, 'type'), /'type' takes the text/)
  assert.throws(() => edit({}, 'left'), /a textbox\(\) state is required/)
  assert.throws(() => textbox('a', { mode: 'replace' }), /the mode is one of normal, insert, operator, visual, visualLine/)
  assert.throws(() => textbox('a', { cursor: '1' }), /the cursor is an offset/)
  assert.ok(Object.isFrozen(edit(s, 'left')))
})

test('textbox: the tables are keymaps — i, Esc, w, 0, $, x, dd, u, p stepped as a host steps them', function () {
  const normal = keymap(NORMAL)
  const insert = keymap(INSERT)
  let s = nm('one two\nthree', 0)
  let pending = null
  for (const chord of parseKeys('wxdd0Pu$ihi<Space><Esc>xupu')) {
    const r = step(pending, chord, { active: [s.mode === 'normal' ? normal : insert], mac: false, text: false }, 0)
    pending = r.state
    if (r.outcome?.action) s = edit(s, r.outcome.action)
    else if (!r.outcome && s.mode === 'insert' && Array.from(chord.key).length === 1) s = edit(s, 'type', chord.key)
  }
  // w x: 'one wo'; dd: 'three', holding 'one wo'; 0 P puts it back and u
  // takes it away; $ i 'hi ' Esc: 'threhi e', on the space; x u and p u each
  // undone, with the space x took still held.
  assert.equal(s.text, 'threhi e')
  assert.equal(s.mode, 'normal')
  assert.deepEqual(s.registers['"'], { text: ' ', linewise: false })
})

test('textbox: sync — what the control typed in INSERT is the one undo step entering it began', function () {
  let s = edit(nm('ab', 1), 'append')
  s = edit(s, 'sync', { text: 'abXYc', cursor: 4 })
  s = edit(s, 'sync', { text: 'abXYZc', cursor: 5 })
  assert.equal(s.cursor, 5)
  s = run(s, 'normal', 'undo')
  assert.equal(s.text, 'ab')
})

test('textbox: sync — in NORMAL a changed text is a step of its own, a moved cursor is none', function () {
  let s = run(nm('one two', 0), 'deleteWord', 'undo')
  // A click: no change, so redo still brings `dw` back.
  s = edit(s, 'sync', { text: 'one two', cursor: 6 })
  assert.equal(s.cursor, 6)
  assert.equal(run(s, 'redo').text, 'two')
  // A paste from the menu: one step, undone alone.
  s = edit(s, 'sync', { text: 'one twoXX', cursor: 9 })
  assert.equal(s.cursor, 8)
  assert.equal(run(s, 'undo').text, 'one two')
})

test('textbox: sync — a selection the control holds is kept in INSERT and typed over', function () {
  let s = edit(textbox('hello world'), 'sync', { text: 'hello world', cursor: 11, anchor: 6 })
  assert.deepEqual([s.anchor, s.cursor], [6, 11])
  assert.equal(edit(s, 'type', 'there').text, 'hello there')
  assert.throws(() => edit(s, 'sync', { text: 'x' }), /'sync' takes/)
  assert.throws(() => edit(s, 'sync', { text: 'x', cursor: 0, anchor: '1' }), /'sync' takes/)
})

// ─── The reducer over a document (FJS-D2085) ─────────────────────────────

// A second host: the text as an array of lines, read only through the five
// members, with undo of its own built from the edits `editDoc` answers. A
// row passing over this and the string host alike is a row no host's
// representation decides.
function linesHost(text) {
  let lines = text.split('\n')
  let widest = 0
  const doc = {
    get length() { return lines.reduce((n, l) => n + l.length, 0) + lines.length - 1 },
    get lineCount() { return lines.length },
    lineStart(n) {
      let at = 0
      for (let i = 0; i < n; i++) at += lines[i].length + 1
      return at
    },
    positionAt(offset) {
      let line = 0
      while (line < lines.length - 1 && offset > doc.lineStart(line) + lines[line].length) line++
      return { line, column: offset - doc.lineStart(line) }
    },
    slice(from, to) {
      widest = Math.max(widest, to - from)
      return lines.join('\n').slice(from, to)
    },
  }
  const past = []
  const future = []
  let state = { cursor: 0, mode: 'normal' }
  const whole = () => lines.join('\n')
  const apply = (edits) => {
    for (const e of edits) {
      const t = whole()
      lines = (t.slice(0, e.from) + e.insert + t.slice(e.to)).split('\n')
    }
  }
  return {
    get text() { return whole() },
    get state() { return state },
    get widest() { return widest },
    place(at) { state = { ...state, cursor: at, anchor: at } },
    edit(action, arg) {
      const out = editDoc(state, action, arg, doc)
      if (out.step && whole() !== past.at(-1)?.text) past.push({ text: whole(), cursor: state.cursor }), (future.length = 0)
      apply(out.edits)
      state = out.state
      const [from, to] = out.request === 'undo' ? [past, future] : out.request === 'redo' ? [future, past] : []
      while (from?.length) {
        const kept = from.pop()
        if (kept.text === whole()) continue
        to.push({ text: whole(), cursor: state.cursor })
        lines = kept.text.split('\n')
        state = { ...state, cursor: kept.cursor, anchor: kept.cursor }
        break
      }
    },
  }
}

test('textbox: editDoc — one script over the string host and a lines host gives the same text and cursor at every key', function () {
  const start = 'one two, three\n  four 🇳🇴 five\nsix'
  let s = textbox(start, { mode: 'normal', cursor: 0 })
  const h = linesHost(start)
  const script = [
    'wordForward', 'wordForward', 'deleteWord', 'wordEnd', 'deleteChar', 'undo', 'redo',
    'deleteLine', 'putAfter', 'firstNonBlank', 'wordForward', 'right', 'right', 'deleteChar', 'deleteBack',
    'lineEnd', 'append', ['type', 'XY'], 'newline', ['type', 'é'], 'backspace', 'normal',
    'yankLines', 'putBefore', 'undo', 'undo', 'redo', 'deleteToEnd', 'lineStart', 'insertLineStart',
    ['type', '> '], 'normal', 'putAfter', 'appendLineEnd', 'normal', 'wordBack', 'deleteWord', 'undo',
  ]
  for (const [i, row] of script.entries()) {
    const [action, arg] = Array.isArray(row) ? row : [row]
    s = edit(s, action, arg)
    h.edit(action, arg)
    assert.equal(h.text, s.text, `text after #${i} ${action}`)
    assert.equal(h.state.cursor, s.cursor, `cursor after #${i} ${action}`)
    assert.equal(h.state.mode, s.mode, `mode after #${i} ${action}`)
  }
})

test('textbox: editDoc — answers edits and a request, and leaves the document alone', function () {
  const doc = stringDoc('hello world')
  const del = editDoc({ cursor: 0, mode: 'normal' }, 'deleteWord', undefined, doc)
  assert.deepEqual(del.edits, [{ from: 0, to: 6, insert: '' }])
  assert.equal(del.step, true)
  assert.deepEqual(del.state.registers['"'], { text: 'hello ', linewise: false })
  assert.equal(doc.slice(0, doc.length), 'hello world')
  const undo = editDoc({ cursor: 3, mode: 'normal' }, 'undo', undefined, doc)
  assert.deepEqual([undo.edits.length, undo.request, undo.step], [0, 'undo', false])
  assert.equal(editDoc({ cursor: 3, mode: 'normal' }, 'insert', undefined, doc).step, true)
  assert.equal(editDoc({ cursor: 3, mode: 'insert' }, 'type', 'x', doc).step, false)
  assert.throws(() => editDoc({ cursor: 0 }, 'sync', { text: '', cursor: 0 }, doc), /no such action/)
  assert.throws(() => editDoc({ cursor: 0 }, 'left', undefined, 'text'), /the document has length/)
})

test('textbox: editDoc — on a long line a motion reads a window around the cursor, never the line', function () {
  const line = 'word '.repeat(200_000)
  const h = linesHost(`${line}\n${line}`)
  h.place(500_000)
  for (const action of ['right', 'left', 'wordForward', 'wordBack', 'wordEnd', 'deleteChar', 'append', 'normal']) h.edit(action)
  assert.ok(h.widest < 1024, `widest slice ${h.widest}`)
  assert.equal(h.text.length, 2 * line.length)
})

// ─── L2: the VIM tables (keys.md Phase 5) ────────────────────────────────

const VIM_MAPS = Object.fromEntries(Object.entries(VIM).map(([mode, table]) => [mode, keymap(table)]))
const RECORDING_MAP = keymap(RECORDING)

// `script` stepped through `VIM[mode]` as a host steps it: an await-char's
// key is its argument, and in INSERT a printable no row takes is typed.
function vim(text, cursor, script, { mode = 'normal', registers } = {}) {
  let s = textbox(text, { mode, cursor })
  if (registers) s = { ...s, registers }
  let pending = null
  for (const chord of parseKeys(script)) {
    const map = s.recording && s.mode === 'normal' ? RECORDING_MAP : VIM_MAPS[s.mode]
    const r = step(pending, chord, { active: [map], mac: false, text: false }, 0)
    pending = r.state
    if (r.outcome?.action) s = edit(s, r.outcome.action, r.outcome.arg)
    else if (!r.outcome && s.mode === 'insert' && Array.from(chord.key).length === 1) s = edit(s, 'type', chord.key)
  }
  return s
}
const vt = (text, cursor, script, opts) => vim(text, cursor, script, opts).text
const reg = (text, linewise = false) => ({ text, linewise })

test('textbox: VIM — every mode\'s table builds as a keymap, and visualLine shares visual\'s', function () {
  assert.deepEqual(Object.keys(VIM).sort(), ['insert', 'normal', 'operator', 'visual', 'visualLine'])
  assert.equal(VIM.visualLine, VIM.visual)
  for (const table of Object.values(VIM)) assert.ok(Object.isFrozen(table))
})

test('textbox: multiline_motion — j and k keep the wanted column, $ wants the end, INSERT reaches it', function () {
  let s = vim('hello\nhi\nworld!', 14, 'k')
  assert.equal(s.cursor, 7)
  s = vim('hello\nhi\nworld!', 14, 'kk')
  assert.equal(s.cursor, 4, 'the column 5 comes back on a longer line, clamped to its last character')
  assert.equal(vim('hello\nhi\nworld!', 1, '$jj').cursor, 14)
  assert.equal(vim('hello\nhi\nworld!', 14, 'kk0j').cursor, 6)
  s = vim('hello\nhi\nworld!', 15, '<Up>', { mode: 'insert' })
  assert.equal(s.cursor, 8)
  assert.equal(vim('hello\nhi\nworld!', 15, '<Up><Up>', { mode: 'insert' }).cursor, 5)
  assert.equal(vim('a\nb', 0, 'kkk').cursor, 0)
})

test('textbox: word_end_and_big_word_motions — e, W, B, E, ge, and e skips newlines', function () {
  assert.equal(vim('foo bar baz', 0, 'e').cursor, 2)
  assert.equal(vim('foo bar baz', 2, 'e').cursor, 6)
  assert.equal(vim('foo.bar baz', 0, 'e').cursor, 2)
  assert.equal(vim('foo.bar baz', 0, 'E').cursor, 6)
  assert.equal(vim('foo.bar baz', 0, 'W').cursor, 8)
  assert.equal(vim('foo.bar baz', 10, 'B').cursor, 8)
  assert.equal(vim('foo.bar baz', 8, 'B').cursor, 0)
  assert.equal(vim('ab\ncd', 1, 'e').cursor, 4)
  assert.equal(vim('foo bar', 5, 'ge').cursor, 2)
  assert.equal(vim('foo.bar', 4, 'ge').cursor, 3)
  assert.equal(vim('foo.bar', 4, 'gE').cursor, 0)
})

test('textbox: line_and_text_motions — ^, 0, gg and G land on first non-blanks', function () {
  assert.equal(vim('  foo bar', 6, '^').cursor, 2)
  assert.equal(vim('  foo bar', 6, '0').cursor, 0)
  assert.equal(vim('a\n  b\nc', 0, 'G').cursor, 6)
  assert.equal(vim('  a\nb\nc', 6, 'gg').cursor, 2)
})

test('textbox: find_and_repeat — f t F T, ; repeats, , reverses, a miss stays, the line bounds it', function () {
  const s = 'a,b,c,d'
  assert.equal(vim(s, 0, 'f,').cursor, 1)
  assert.equal(vim(s, 0, 't,').cursor, 0)
  assert.equal(vim(s, 0, 'tc').cursor, 3)
  assert.equal(vim(s, 6, 'F,').cursor, 5)
  assert.equal(vim(s, 6, 'T,').cursor, 6)
  assert.equal(vim(s, 6, 'Tb').cursor, 3)
  assert.equal(vim(s, 0, 'f,;').cursor, 3)
  assert.equal(vim(s, 0, 'f,;;,').cursor, 3)
  assert.equal(vim(s, 0, 't,;').cursor, 2, '; after t skips the match beside it')
  assert.equal(vim(s, 0, 'fz').cursor, 0)
  assert.equal(vim('ab\ncd', 0, 'fc').cursor, 0)
  assert.equal(vim('if (x) {', 0, '%').cursor, 5)
})

test('textbox: delete_operators — d with a motion, a find, a miss, and lines', function () {
  assert.equal(vt('foo bar baz', 4, 'de'), 'foo  baz')
  assert.equal(vt('foo bar baz', 8, 'db'), 'foo baz')
  assert.equal(vt('foo bar baz', 4, 'd0'), 'bar baz')
  assert.equal(vt('foo bar baz', 4, 'd$'), 'foo ')
  assert.equal(vim('foo bar baz', 4, 'D').cursor, 3, 'the cursor steps back after D')
  assert.equal(vt('foo bar baz', 4, 'dW'), 'foo baz')
  assert.equal(vt('one\ntwo', 1, 'd$'), 'o\ntwo')
  assert.equal(vt('abc', 1, 'X'), 'bc')
  assert.equal(vt('abc', 0, 'X'), 'abc')
  assert.equal(vt('foo bar', 0, 'dtr'), 'r')
  assert.equal(vt('foo,bar', 0, 'df,'), 'bar')
  const miss = vim('foo,bar', 3, 'dfz')
  assert.deepEqual([miss.text, miss.mode], ['foo,bar', 'normal'])
  assert.equal(vt('foo\n  bar', 0, 'dw'), '\n  bar', 'dw on a line\'s last word stops at the line\'s end')
  assert.equal(vt('a\nb\nc', 2, 'dj'), 'a')
  assert.equal(vt('a\nb\nc', 2, 'dk'), 'c')
  assert.equal(vt('a\nb', 2, 'dj'), 'a\nb', 'dj on the last line fails')
  assert.equal(vt('f(a(b)c)d', 0, 'd%'), 'd')
  assert.equal(vt('abc', 0, 'd<Esc>x'), 'bc', 'Esc cancels a pending operator')
  assert.equal(vt('abc', 0, 'dcx'), 'bc', 'another operator cancels it')
})

test('textbox: change_operators_request_insert — c leaves INSERT where the text was; a miss does not', function () {
  let s = vim('foo bar baz', 4, 'ce')
  assert.deepEqual([s.text, s.cursor, s.mode], ['foo  baz', 4, 'insert'])
  s = vim('foo bar baz', 8, 'cb')
  assert.deepEqual([s.text, s.cursor], ['foo baz', 4])
  s = vim('foo bar', 4, 'cw')
  assert.deepEqual([s.text, s.cursor], ['foo ', 4])
  assert.equal(vt('foo bar', 0, 'cw'), ' bar', 'cw on a word keeps the space after it')
  assert.equal(vt('a b', 0, 'cwX<Esc>'), 'X b')
  s = vim('foo bar', 4, 'C')
  assert.deepEqual([s.text, s.cursor, s.mode], ['foo ', 4, 'insert'])
  s = vim('one\ntwo\nthree', 5, 'cc')
  assert.deepEqual([s.text, s.cursor, s.mode], ['one\n\nthree', 4, 'insert'])
  assert.deepEqual(s.registers['"'], reg('two', true))
  assert.equal(vim('foo', 0, 'cfz').mode, 'normal')
  assert.deepEqual([vt('abc', 1, 'sX<Esc>'), vt('ab\ncd', 0, 'SX<Esc>')], ['aXc', 'X\ncd'])
})

test('textbox: text_objects — words as khat\'s, then brackets, quotes and paragraphs', function () {
  assert.equal(vt('foo bar baz', 5, 'diw'), 'foo  baz')
  assert.equal(vt('foo bar baz', 5, 'daw'), 'foo baz')
  assert.equal(vt('foo bar baz', 9, 'daw'), 'foo bar', 'aw at the end takes the space before')
  assert.equal(vt('foo bar baz', 0, 'daw'), 'bar baz')
  assert.equal(vt('foo.bar', 1, 'diw'), '.bar')
  assert.equal(vt('foo.bar', 3, 'diw'), 'foobar')
  assert.equal(vt('a   b c', 2, 'diw'), 'ab c')
  assert.equal(vt('a   b c', 2, 'daw'), 'a c')
  assert.equal(vt('ab\ncd', 0, 'diw'), '\ncd')
  assert.equal(vt('\ncd', 0, 'diw'), '\ncd')
  assert.equal(vt('a.b c', 0, 'diW'), ' c')
  const s = vim('foo bar', 5, 'ciw')
  assert.deepEqual([s.text, s.cursor, s.mode], ['foo ', 4, 'insert'])

  assert.equal(vt('f(a, (b), c)', 6, 'di('), 'f(a, (), c)')
  assert.equal(vt('f(a, (b), c)', 6, 'da('), 'f(a, , c)')
  assert.equal(vt('f(a, (b), c)', 2, 'dib'), 'f()')
  assert.equal(vt('f(a, (b), c)', 1, 'di)'), 'f()', 'on the bracket itself')
  assert.equal(vt('{\n  a\n}', 4, 'di{'), '{\n}', 'a block keeps its braces on their lines')
  assert.equal(vt('x {\n  a\n}', 6, 'da{'), 'x ')
  assert.equal(vt('a[1][2]', 5, 'ci]9<Esc>'), 'a[1][9]')
  assert.equal(vt('<div>', 2, 'di<lt>'), '<>')
  assert.equal(vt('f(a)', 0, 'di['), 'f(a)', 'no pair: nothing')

  assert.equal(vt('x = "a b" + c', 5, 'di"'), 'x = "" + c')
  assert.equal(vt('x = "a b" + c', 5, 'da"'), 'x = + c')
  assert.equal(vt('x = "a b"', 5, 'da"'), 'x =', 'no space after: the space before')
  assert.equal(vt('x = "a b"', 8, 'di"'), 'x = ""', 'on the closing quote')
  const before = vim('x = "a b" + c', 0, 'ci"')
  assert.deepEqual([before.text, before.cursor, before.mode], ['x = "" + c', 5, 'insert'])
  assert.equal(vt('"a\\"b"', 1, 'di"'), '""', 'a backslash escapes a quote')
  assert.equal(vt("it's 'x'", 6, "di'"), "it's ''")
  assert.equal(vt("it's 'x'", 7, "di'"), "it's 'x'", 'on a quote they pair from the line\'s start, so the last one is unpaired')
  assert.equal(vt('"a" b "c"', 4, 'di"'), '"a""c"', 'off a quote: the nearest each side')

  assert.equal(vt('a\nb\n\nc', 0, 'dip'), '\nc')
  assert.equal(vt('a\nb\n\nc', 0, 'dap'), 'c')
  assert.equal(vt('a\n\nb\nc', 3, 'dap'), 'a', 'the last paragraph takes the blank run before it')
})

test('textbox: paragraph motions — } and { stop at blank lines, d} from a paragraph\'s start takes its lines', function () {
  assert.equal(vim('a\nb\n\nc\nd', 0, '}').cursor, 4)
  assert.equal(vim('a\nb\n\nc\nd', 0, '}}').cursor, 7, 'past the last paragraph: its last character')
  assert.equal(vim('a\nb\n\nc\nd', 7, '{').cursor, 4)
  assert.equal(vim('a\nb\n\nc\nd', 7, '{{').cursor, 0)
  assert.equal(vt('a\nb\n\nc\nd', 0, 'd}'), '\nc\nd')
  assert.equal(vt('xa\nb\n\nc', 1, 'd}'), 'x\n\nc', 'from inside a line: up to the line before')
})

test('textbox: replace_toggle_join — r, ~ and J', function () {
  const r = vim('abc', 1, 'rX')
  assert.deepEqual([r.text, r.cursor], ['aXc', 1])
  assert.equal(vt('\nb', 0, 'rX'), '\nb')
  assert.equal(vt('abC', 0, '~~~'), 'ABc')
  const t = vim('abc', 2, '~')
  assert.deepEqual([t.text, t.cursor], ['abC', 2])
  const j = vim('one\n  two', 0, 'J')
  assert.deepEqual([j.text, j.cursor], ['one two', 3])
  assert.equal(vt('one \ntwo', 0, 'J'), 'one two')
  assert.equal(vt('one\n\ntwo', 0, 'J'), 'one\ntwo')
  assert.equal(vt('f(\n)', 0, 'J'), 'f()')
  assert.equal(vt('last', 0, 'J'), 'last')
})

test('textbox: insert_entry_ops — o and O open a line and enter INSERT on it', function () {
  let s = vim('ab\ncd', 0, 'o')
  assert.deepEqual([s.text, s.cursor, s.mode], ['ab\n\ncd', 3, 'insert'])
  s = vim('ab\ncd', 4, 'O')
  assert.deepEqual([s.text, s.cursor, s.mode], ['ab\n\ncd', 3, 'insert'])
  assert.equal(vt('ab', 0, 'oxy<Esc>u'), 'ab', 'the opened line and its typing are one step')
})

test('textbox: yank_and_charwise_put — y with a motion or an object, the cursor at its start', function () {
  let s = vim('foo bar', 0, 'yw')
  assert.deepEqual(s.registers['"'], reg('foo '))
  assert.equal(s.text, 'foo bar')
  s = vim('foo bar', 0, 'yw$p')
  assert.deepEqual([s.text, s.cursor], ['foo barfoo ', 10])
  assert.equal(vt('foo bar', 0, 'yw$pP'), 'foo barfoofoo  ')
  s = vim('foo bar', 5, 'yiw')
  assert.deepEqual([s.registers['"'].text, s.cursor], ['bar', 4])
  assert.equal(vt('abc', 0, 'xp'), 'bac')
  assert.equal(vt('one two', 0, 'dwp'), 'tone wo')
  assert.equal(vt('ab', 0, 'yl$pp'), 'abaa')
  s = vim('a\nb', 0, 'yjjp')
  assert.deepEqual([s.text, s.cursor], ['a\nb\na\nb', 4], 'a multi-line put lands on its first line')
})

test('textbox: linewise_yank_delete_put — yy leaves the cursor, p below and P above, gg and G take lines', function () {
  let s = vim('one\ntwo\nthree', 5, 'yy')
  assert.deepEqual([s.registers['"'], s.cursor], [reg('two', true), 5])
  s = vim('one\ntwo\nthree', 5, 'yyp')
  assert.deepEqual([s.text, s.cursor], ['one\ntwo\ntwo\nthree', 8])
  s = vim('one\ntwo\nthree', 5, 'yypP')
  assert.deepEqual([s.text, s.cursor], ['one\ntwo\ntwo\ntwo\nthree', 8])
  assert.equal(vt('one\ntwo\nthree', 0, 'ddp'), 'two\none\nthree')
  assert.equal(vt('a\nb', 2, 'yyp'), 'a\nb\nb')
  assert.equal(vt('a\nb\nc', 2, 'dgg'), 'c')
  assert.equal(vt('a\nb\nc', 2, 'dG'), 'a')
  assert.equal(vt('a', 0, 'p'), 'a')
  assert.equal(vim('x\n  y\nz', 0, 'dd').cursor, 2, 'dd lands on the next line\'s first non-blank')
  assert.equal(vim('a\n  b', 0, 'jyykp').cursor, 4)
})

test('textbox: registers — named, appended, the black hole, the numbered ring, "- and "0', function () {
  let s = vim('one two', 0, '"ayiww"byiw')
  assert.deepEqual([s.registers.a, s.registers.b, s.registers['0']], [reg('one'), reg('two'), undefined])
  assert.equal(vt('one two', 0, '"ayiww"byiw"aP'), 'one onetwo')
  assert.deepEqual(vim('one two', 0, '"ayiww"Ayiw').registers.a, reg('onetwo'))
  assert.deepEqual(vim('a\nb', 0, '"ayyj"Ayy').registers.a, reg('a\nb', true))
  assert.equal(vt('a\nb', 0, 'yy"_ddp'), 'b\na', '"_ keeps nothing and leaves "" alone')
  s = vim('a\nb\nc', 0, 'dddd')
  assert.deepEqual([s.registers['1'], s.registers['2']], [reg('b', true), reg('a', true)])
  assert.equal(vt('a\nb\nc', 0, 'dddd"2p'), 'c\na')
  s = vim('ab\ncd', 0, 'yyjx')
  assert.deepEqual([s.registers['0'], s.registers['-'], s.registers['1'], s.registers['"']], [reg('ab', true), reg('c'), undefined, reg('c')])
  assert.equal(vt('ab\ncd', 0, 'yyjx"0P'), 'ab\nab\nd', 'a delete leaves the yank in "0')
  assert.equal(vim('ab', 0, '"zx').named, undefined, 'the name lasts one command')
})

test('textbox: registers — "+ asks the host to copy, and a "+ the host filled is put', function () {
  const doc = stringDoc('one two')
  let out = editDoc({ cursor: 0, mode: 'normal' }, 'register', '+', doc)
  assert.equal(out.state.named, '+')
  out = editDoc(out.state, 'yank', undefined, doc)
  out = editDoc(out.state, 'innerWord', undefined, doc)
  assert.deepEqual([out.request, out.state.registers['+'], out.state.named], ['copy', reg('one'), undefined])
  assert.equal(editDoc({ cursor: 0, mode: 'normal' }, 'yankLines', undefined, doc).request, undefined)
  const again = ['register', ['register', '+'], 'yank', 'innerWord'].reduce((o, row) => {
    const [action, arg] = Array.isArray(row) ? row : [row]
    return action === 'register' && arg === undefined ? o : editDoc(o.state, action, arg, doc)
  }, out)
  assert.equal(again.request, 'copy', 'the same text yanked again still asks, since the clipboard may have moved')
  const filled = { cursor: 2, mode: 'normal', named: '*', registers: { '+': reg('X') } }
  assert.deepEqual(editDoc(filled, 'putAfter', undefined, doc).edits, [{ from: 3, to: 3, insert: 'X' }])
  const lines = { cursor: 0, mode: 'normal', registers: { '"': { text: 'L', linewise: true } } }
  const two = stringDoc('ab\ncd')
  assert.deepEqual(editDoc(lines, 'putAfter', undefined, two).edits, [{ from: 3, to: 3, insert: 'L\n' }],
    'p begins its edit on the new line, so a host redoing to the edit start lands there')
  assert.deepEqual(editDoc({ ...lines, cursor: 3 }, 'putAfter', undefined, two).edits, [{ from: 5, to: 5, insert: '\nL' }])
})

test('textbox: case and indent operators — gU gu g~ doubled for the line, > and < by the indent unit', function () {
  const s = vim('foo bar', 4, 'gUiw')
  assert.deepEqual([s.text, s.cursor], ['foo BAR', 4])
  assert.equal(vt('Foo Bar', 4, 'guu'), 'foo bar')
  assert.equal(vt('Foo Bar', 4, 'gUU'), 'FOO BAR')
  assert.equal(vt('Foo Bar', 4, 'g~~'), 'fOO bAR')
  assert.equal(vt('Foo Bar', 4, 'g~g~'), 'fOO bAR')
  assert.equal(vt('straße', 0, 'gUiw'), 'STRASSE')
  assert.equal(vt('ab', 0, 'du'), 'ab', 'u after d is no motion')
  const i = vim('a\nb', 0, '>>')
  assert.deepEqual([i.text, i.cursor], ['  a\nb', 2])
  assert.equal(vt('a\nb', 0, '>j'), '  a\n  b')
  assert.equal(vt('    a\n\tb', 0, '<lt>j'), '  a\nb')
  assert.equal(edit(edit({ ...nm('a', 0), indent: '\t' }, 'indent'), 'indent').text, '\ta')
  assert.equal(edit(edit({ ...nm('a', 0), indent: '\t' }, 'sync', { text: 'b', cursor: 0 }), 'indent').indent, '\t', 'a sync keeps the unit')
})

test('textbox: visual_enter_and_motions — v anchors, motions move the cursor, both ends included', function () {
  const doc = (t) => stringDoc(t)
  let s = vim('hello world', 3, 'v')
  assert.deepEqual([s.mode, s.anchor, s.cursor], ['visual', 3, 3])
  assert.deepEqual(visualRange(s, doc(s.text)), { from: 3, to: 4, linewise: false })
  assert.equal(visualRange(nm('abc', 0), doc('abc')), null)
  s = vim('hello world foo', 0, 'vw')
  assert.deepEqual([s.cursor, visualRange(s, doc(s.text))], [6, { from: 0, to: 7, linewise: false }])
  assert.equal(vim('hello world foo', 0, 'vwe').cursor, 10)
  assert.equal(vim('hello world foo', 0, 'vweW').cursor, 12)
  s = vim('hello world foo', 0, 'v$')
  assert.deepEqual([s.cursor, visualRange(s, doc(s.text)).to], [14, 15], '$ stays on the last character')
  assert.equal(vim('hello world foo', 0, 'vfo;').cursor, 7)
  assert.equal(vim('hello world foo', 0, 'vfo;,').cursor, 4)
  s = vim('ab\ncd\nef', 1, 'vj')
  assert.deepEqual([s.cursor, visualRange(s, doc(s.text))], [4, { from: 1, to: 5, linewise: false }])
  s = vim('ab\ncd\nef', 1, 'vGgg')
  assert.deepEqual([s.cursor, s.anchor, visualRange(s, doc(s.text))], [0, 1, { from: 0, to: 2, linewise: false }])
  s = vim('ab\ncd\nef', 1, 'Vj')
  assert.deepEqual(visualRange(s, doc(s.text)), { from: 0, to: 5, linewise: true })
})

test('textbox: visual_swap_toggle_and_exit — o, v and V switch or leave, Esc leaves in place', function () {
  let s = vim('abcdef', 2, 'vll')
  assert.deepEqual([s.anchor, s.cursor], [2, 4])
  s = vim('abcdef', 2, 'vllo')
  assert.deepEqual([s.anchor, s.cursor], [4, 2])
  s = vim('abcdef', 2, 'vlloV')
  assert.deepEqual([s.mode, s.anchor, s.cursor], ['visualLine', 4, 2])
  assert.equal(vim('abcdef', 2, 'vlloVv').mode, 'visual')
  assert.equal(vim('abcdef', 2, 'vlloVvv').mode, 'normal')
  assert.equal(vim('abc', 1, 'VV').mode, 'normal')
  s = vim('abc', 1, 'vl<Esc>')
  assert.deepEqual([s.mode, s.cursor, s.anchor], ['normal', 2, 2])
})

test('textbox: visual_objects — iw and aw select, ip turns the selection linewise', function () {
  let s = vim('foo bar baz', 5, 'viw')
  assert.deepEqual(visualRange(s, stringDoc(s.text)), { from: 4, to: 7, linewise: false })
  s = vim('foo bar', 1, 'vaw')
  assert.deepEqual(visualRange(s, stringDoc(s.text)), { from: 0, to: 4, linewise: false })
  s = vim('a\nb\n\nc', 0, 'vip')
  assert.equal(s.mode, 'visualLine')
  assert.deepEqual(visualRange(s, stringDoc(s.text)), { from: 0, to: 3, linewise: true })
  assert.equal(vt('f(a, b)', 3, 'vi(d'), 'f()')
})

test('textbox: visual_delete_yank_change — d y c over characters and lines, one undo step each', function () {
  let s = vim('one two three', 4, 'ved')
  assert.deepEqual([s.text, s.cursor, s.mode, s.registers['"']], ['one  three', 4, 'normal', reg('two')])
  assert.equal(vt('one two three', 4, 'vedu'), 'one two three')
  assert.equal(vt('one two three', 4, 'vedu<C-r>'), 'one  three')
  s = vim('ab\ncd\nef', 1, 'vjd')
  assert.deepEqual([s.text, s.cursor, s.registers['"'].text], ['a\nef', 0, 'b\ncd'])
  assert.equal(vt('one two', 6, 'vbd'), 'one ')
  s = vim('ab\ncd\nef', 0, 'Vjd')
  assert.deepEqual([s.text, s.cursor, s.registers['"']], ['ef', 0, reg('ab\ncd', true)])
  assert.equal(vt('ab\ncd\nef', 3, 'Vjd'), 'ab')
  s = vim('one\ntwo\nthree', 0, 'Vjy')
  assert.deepEqual([s.cursor, s.mode, s.registers['"']], [0, 'normal', reg('one\ntwo', true)])
  assert.equal(vt('one\ntwo\nthree', 0, 'VjyGp'), 'one\ntwo\nthree\none\ntwo')
  s = vim('hello world', 6, 'vey')
  assert.deepEqual([s.text, s.cursor, s.registers['"']], ['hello world', 6, reg('world')])
  assert.equal(vt('hello world', 6, 'veyP'), 'hello worldworld')
  assert.equal(vim('hello world', 8, 'vby').cursor, 6)
  assert.deepEqual(vim('ab cd\nef', 1, 'vY').registers['"'], reg('ab cd', true))
  s = vim('foo bar', 0, 'vec')
  assert.deepEqual([s.text, s.cursor, s.mode, s.registers['"'].text], [' bar', 0, 'insert', 'foo'])
  s = vim('ab cd\nef', 1, 'vC')
  assert.deepEqual([s.text, s.mode, s.registers['"'].linewise], ['\nef', 'insert', true])
  s = vim('a\nb\nc', 2, 'Vkc')
  assert.deepEqual([s.text, s.cursor], ['\nc', 0])
  assert.deepEqual([vt('ab cd\nef\ngh', 1, 'vjD'), vim('ab cd\nef\ngh', 1, 'vjD').registers['"']], ['gh', reg('ab cd\nef', true)])
  assert.deepEqual([vt('abc def', 0, 'xved'), vt('abc def', 0, 'xvedu'), vt('abc def', 0, 'xveduu')], [' def', 'bc def', 'abc def'])
})

test('textbox: visual_put_replaces_selection — p swaps the selection into the register, P keeps it', function () {
  let s = vim('foo bar', 4, 'vep', { registers: { '"': reg('X') } })
  assert.deepEqual([s.text, s.registers['"']], ['foo X', reg('bar')])
  s = vim('foo bar', 4, 'veP', { registers: { '"': reg('X') } })
  assert.deepEqual([s.text, s.registers['"']], ['foo X', reg('X')])
  assert.equal(vt('ab cd', 3, 'vlp', { registers: { '"': reg('L1\nL2', true) } }), 'ab \nL1\nL2')
  s = vim('a\nb\nc', 2, 'Vp', { registers: { '"': reg('L', true) } })
  assert.deepEqual([s.text, s.registers['"']], ['a\nL\nc', reg('b', true)])
  assert.equal(vt('a\nb\nc', 2, 'Vp', { registers: { '"': reg('ZZ') } }), 'a\nZZ\nc')
  s = vim('abc', 0, 'vp')
  assert.deepEqual([s.text, s.mode], ['abc', 'normal'])
})

test('textbox: visual_join_case_replace_indent — J, ~ u U, r and > < over a selection', function () {
  assert.equal(vt('a\nb\nc\nd', 0, 'VjjJ'), 'a b c\nd')
  assert.equal(vt('a\nb\nc', 0, 'vJ'), 'a b\nc', 'one line joins with the next')
  let s = vim('Hello World', 0, 've~')
  assert.deepEqual([s.text, s.cursor], ['hELLO World', 0])
  assert.equal(vt('Hello World', 0, 'v$U'), 'HELLO WORLD')
  assert.equal(vt('Hello World', 6, 'v$u'), 'Hello world')
  assert.equal(vt('ab\ncd', 0, 'vjU'), 'AB\nCd', 'case leaves line breaks alone')
  assert.equal(vt('abcd', 0, 'vllrx'), 'xxxd')
  assert.equal(vt('a🇳🇴b', 0, 'vllr-'), '---', 'r replaces graphemes')
  s = vim('a\n\nb', 0, 'VG>')
  assert.deepEqual([s.text, s.cursor], ['  a\n\n  b', 2], 'empty lines stay empty')
  assert.equal(vt('    a\n b\nc', 0, 'Vjj<lt>'), '  a\nb\nc')
})

const AWAITING = new Set(['findForward', 'tillBack', 'register'])

test('textbox: editDoc — an L2 script over the string host and the lines host agrees at every key', function () {
  const start = 'function f(a, b) {\n  return "x y"\n}\n\nconst z = [1, 2]'
  let s = textbox(start, { mode: 'normal', cursor: 0 })
  const h = linesHost(start)
  const script = [
    'wordForward', 'wordForward', 'delete', 'innerParen', ['type', 'q'], 'normal',
    'down', 'change', 'innerDoubleQuote', ['type', 'hi'], 'normal', 'undo', 'redo',
    'yankLines', 'down', 'putAfter', 'visualLine', 'up', 'indent',
    'bottom', 'findForward', ['findForward', '['], 'delete', 'aroundBracket', 'putBefore',
    'top', 'visual', 'paragraphForward', 'uppercase', 'undo',
    'register', ['register', 'a'], 'delete', 'down', 'join', 'tillBack', ['tillBack', 'f'], 'swapCaseChar',
    'paragraphForward', 'openAbove', ['type', 'new'], 'normal', 'matchPair',
  ]
  for (const [i, row] of script.entries()) {
    const [action, arg] = Array.isArray(row) ? row : [row]
    if (!Array.isArray(row) && AWAITING.has(action)) continue
    s = edit(s, action, arg)
    h.edit(action, arg)
    assert.equal(h.text, s.text, `text after #${i} ${action}`)
    assert.equal(h.state.cursor, s.cursor, `cursor after #${i} ${action}`)
    assert.equal(h.state.mode, s.mode, `mode after #${i} ${action}`)
  }
  assert.ok(s.text !== start)
})

test('textbox: editDoc — a bracket or % across a long document reads it a chunk at a time', function () {
  const h = linesHost(`f(${'x'.repeat(300_000)}\n${'y'.repeat(300_000)})`)
  h.edit('matchPair')
  assert.equal(h.state.cursor, 600_003)
  h.place(150_000)
  h.edit('paragraphForward')
  assert.ok(h.widest <= 8192, `widest slice ${h.widest}`)
  h.edit('yank')
  h.edit('innerParen')
  assert.equal(h.state.registers['"'].text.length, 600_001)
})

// ─── L3: counts, repeat, macros, marks (keys.md Phase 5.3) ───────────────

test('textbox: counts — [count] operator [count] motion, doubled operators, x, p and j', function () {
  assert.equal(vt('a b c d e f', 0, '3dw'), 'd e f')
  assert.equal(vt('a b c d e f', 0, 'd3w'), 'd e f')
  assert.equal(vt('a b c d e f', 0, '2d2w'), 'e f')
  assert.equal(vt('a\nb\nc\nd', 0, '2dd'), 'c\nd')
  assert.equal(vt('a\nb\nc\nd', 0, 'd2d'), 'c\nd')
  assert.equal(vt('a\nb', 0, '5dd'), '', 'a count past the end takes what is there')
  assert.equal(vim('a\nb\nc\nd', 0, '2j').cursor, 4)
  assert.equal(vim('a\nb\nc\nd', 0, '5j').cursor, 6, 'a count past the end stops on the last line')
  assert.equal(vt('abcdef', 0, '3x'), 'def')
  assert.equal(vt('ab', 0, '9x'), '')
  assert.equal(vt('a b c d e f', 0, 'c2wX<Esc>'), 'X c d e f')
  assert.equal(vt('a\nb\nc\nd', 0, 'd2j'), 'd')
  assert.equal(vt('ab', 0, 'x3p'), 'baaa', '3p puts the register three times')
  assert.equal(vt('a\nb', 0, 'yy3p'), 'a\na\na\na\nb')
  assert.equal(vt('a\nb\nc\nd', 0, '3J'), 'a b c\nd')
  assert.equal(vim('abcdef', 0, '3l').cursor, 3)
  assert.equal(vim('a b c d', 0, '2w').cursor, 4)
  assert.equal(vt('a1b1c1d', 0, 'd2f1'), 'c1d', 'd2f1 deletes through the second 1')
  assert.equal(vim('a\nb\nc\nd', 0, '3G').cursor, 4)
  assert.equal(vt('abcd', 0, '2rx'), 'xxcd')
  assert.equal(vt('abcd', 3, '2rx'), 'abcd', 'r with more than the line holds does nothing')
  assert.equal(vt('abcd', 0, '2~'), 'ABcd')
})

test('textbox: counts — 0 with no count pending is still the line-start motion, and a digit is an await-char\'s argument', function () {
  assert.equal(vim('abc def', 5, '0').cursor, 0)
  assert.equal(vt('abc def', 5, 'd0'), 'ef')
  assert.equal(vim('0123456789012', 0, '10l').cursor, 10, 'a 0 after a digit extends the count')
  assert.equal(vt('a1b2', 0, 'f2x'), 'a1b', 'the digit after f is its character, not a count')
  assert.equal(vt('abc', 0, 'r5'), '5bc')
  const s = vim('abcdef', 0, '3')
  assert.equal(s.count, 3)
  assert.equal(vim('abcdef', 0, '3<Esc>l').cursor, 1, 'Esc drops a pending count')
  assert.equal(vim('abcdef', 0, '3"ax').text, 'def', 'a register name keeps the count pending')
})

test('textbox: dot — repeats cw and its text, dd, and a new count replaces the old', function () {
  assert.equal(vt('foo bar baz', 0, 'cwxx<Esc>w.'), 'xx xx baz')
  assert.equal(vt('foo bar baz', 0, 'cwxx<Esc>w.w.'), 'xx xx xx')
  assert.equal(vt('a\nb\nc\nd\ne', 0, 'dd.'), 'c\nd\ne')
  assert.equal(vt('a b c d e f g h', 0, 'dw3.'), 'e f g h', '3. repeats dw as d3w')
  assert.equal(vt('a b c d e f g h', 0, '2dw.'), 'e f g h', 'with no count the old one stands')
  assert.equal(vt('a b c d e f g h', 0, '2dw3.'), 'f g h')
  assert.equal(vt('abc', 0, 'x.x'), '', 'x . x')
  assert.equal(vt('a\nb', 0, 'Ax<Esc>j.'), 'ax\nbx')
  assert.equal(vt('a b', 0, 'yw.'), 'a b', 'a yank is no change, and with none yet . does nothing')
  assert.equal(vt('abc abc', 0, 'xw.'), 'bc bc')
  // `.` answers a request and leaves the text to the host.
  const doc = stringDoc('abc')
  let st = editDoc({ cursor: 0, mode: 'normal' }, 'deleteChar', undefined, doc).state
  const out = editDoc(st, 'repeatChange', undefined, doc)
  assert.equal(out.request, 'replay')
  assert.deepEqual(out.actions, [['deleteChar'], ['replayEnd']])
  assert.deepEqual(out.edits, [])
  assert.equal(out.state.replaying, 1)
})

test('textbox: dot — a replay does not record itself, and one undo step takes the whole thing back', function () {
  let s = vim('a b c d e f', 0, 'dw')
  s = vim('a b c d e f', 0, 'dw..')
  assert.equal(s.text, 'd e f')
  assert.equal(s.replaying, undefined)
  assert.deepEqual(s.last.actions, [['delete'], ['wordForward']])
  const back = edit(vim('a b c d e f', 0, 'dw'), 'undo')
  assert.equal(back.text, 'a b c d e f')
  let c = vim('a b c d e f g', 0, '3dw')
  c = edit(c, 'repeatChange')
  assert.equal(c.text, 'g')
  assert.equal(edit(c, 'undo').text, 'd e f g', 'a replay is one undo step')
})

test('textbox: macros — q records, @a plays with the host loop, 5@a and @@, an insert is one typed action', function () {
  const rec = vim('x1\nx2\nx3\nx4', 0, 'qaAy<Esc>jq')
  assert.equal(rec.recording, undefined)
  assert.deepEqual(rec.macros.a, [['appendLineEnd'], ['type', 'y'], ['normal'], ['down']])
  assert.equal(rec.text, 'x1y\nx2\nx3\nx4')
  assert.equal(vt('x1\nx2\nx3\nx4', 0, 'qaAy<Esc>jq@a'), 'x1y\nx2y\nx3\nx4')
  assert.equal(vt('x1\nx2\nx3\nx4', 0, 'qaAy<Esc>jq2@a'), 'x1y\nx2y\nx3y\nx4')
  assert.equal(vt('x1\nx2\nx3\nx4', 0, 'qaAy<Esc>jq@a@@'), 'x1y\nx2y\nx3y\nx4')
  assert.equal(vt('x1\nx2\nx3\nx4', 0, 'qaAy<Esc>jq5@a'), 'x1y\nx2y\nx3y\nx4y', 'the failed j on the last line stops the rest')
  assert.equal(vt('ab', 0, '@a'), 'ab', 'an empty register is a failed play, not a throw')
  assert.equal(vt('a\nb', 0, 'qaxqjqAxq@a'), '\n', 'qA appends to the register')
  // A replay never records: a macro played while recording is `@a`, not what it did.
  const nested = vim('a\nb\nc', 0, 'qaxjqqb@aq')
  assert.deepEqual(nested.macros.b, [['play', 'a']])
})

test('textbox: macros — a failed motion stops the macro; so does @a calling @a, at the cap', function () {
  // f; finds no `;` on the second line, so the delete after it never runs there.
  const fs = vt('a;b\nab\nc;d', 0, 'qaf;xjq@a@a')
  assert.equal(fs, 'ab\nab\nc;d', 'the miss on line two stopped the macro before its x')
  // A macro that plays itself: the recursion idiom ends at the first failed j.
  const loop = vim('a\nb\nc', 0, 'qaqqaA!<Esc>j@aq@a')
  assert.equal(loop.text, 'a!\nb!\nc!')
  assert.equal(loop.replaying, undefined)
  // With nothing to fail, the cap does.
  const forever = vim('abc', 0, 'qaqqaix<Esc>@aq@a')
  assert.ok(forever.text.length < 300, `the cap held at ${forever.text.length}`)
  assert.equal(forever.replaying, undefined)
})

test('textbox: macros — u inside a macro reaches the host as a request', function () {
  const doc = stringDoc('abc')
  const p = editDoc({ cursor: 0, mode: 'normal', macros: { a: [['deleteChar'], ['undo']] } }, 'play', 'a', doc)
  assert.equal(p.request, 'replay')
  assert.deepEqual(p.actions, [['deleteChar'], ['undo'], ['replayEnd']])
  const u = editDoc(p.state, 'undo', undefined, doc)
  assert.equal(u.request, 'undo')
  assert.equal(u.state.replaying, 1, 'the replay is still running when the host travels')
  // The string host travels its own history: x then u is what the text began as.
  const s = textbox('abc', { mode: 'normal', cursor: 0 })
  const ran = edit({ ...s, macros: { a: [['deleteChar'], ['undo']] } }, 'play', 'a')
  assert.equal(ran.text, 'abc')
  assert.equal(edit({ ...s, macros: { a: [['deleteChar'], ['deleteChar']] } }, 'play', 'a').text, 'c')
})

test('textbox: marks — m sets, backtick is exact, apostrophe is linewise to the first non-blank, both after an operator', function () {
  assert.equal(vim('abc def', 0, 'wmb0`b').cursor, 4)
  assert.equal(vim('a\n  bcd\ne', 4, 'mak\'a').cursor, 4)
  assert.equal(vim('a\n  bcd\ne', 0, 'jllmagg\'a').cursor, 4, "'a is the first non-blank of the line")
  assert.equal(vt('abc def', 0, 'wmb0d`b'), 'def')
  assert.equal(vt('abc def', 0, 'wmb0y`bP'), 'abc abc def', 'y`b yanks the exclusive range and leaves the cursor at its start')
  assert.equal(vt('a\nb\nc\nd', 0, 'majjd\'a'), 'd')
  assert.equal(vt('a\nb\nc\nd', 4, 'maggd\'a'), 'd')
  assert.equal(vim('abc', 0, '\'z').cursor, 0, "an unset mark is a failed motion, not a throw")
  assert.equal(editDoc({ cursor: 0, mode: 'normal' }, 'markLine', 'z', stringDoc('abc')).failed, true)
  assert.equal(vt('a\nb', 0, "d'z"), 'a\nb', 'an operator over a failed motion changes nothing')
})

test('textbox: marks — D2103: a mark moves with the text, an insert at it pushes it right, a delete over it lands at the start', function () {
  // Typing above the mark.
  let s = vim('one\ntwo', 4, 'ma')
  s = vim('one\ntwo', 4, 'maggOnew<Esc>')
  assert.equal(s.text, 'new\none\ntwo')
  assert.equal(s.marks.a, 8, "the mark stayed on its character")
  // An insert exactly at the mark pushes it right.
  assert.equal(vim('abc', 1, 'maiX<Esc>').marks.a, 2)
  assert.equal(vim('abc', 1, 'ma0iX<Esc>').marks.a, 2)
  // A charwise delete over it moves it to the deletion's start.
  assert.equal(vim('abcdef', 3, 'ma0d4l').marks.a, 0)
  assert.equal(vim('abcdef', 3, 'ma0d3l').marks.a, 0, 'a delete ending at the mark leaves it on its character, now at the start')
  assert.equal(vim('abcdef', 3, 'mallx').marks.a, 3)
  // A delete of its whole line deletes the mark.
  const gone = vim('a\nb\nc', 2, 'madd')
  assert.equal(gone.text, 'a\nc')
  assert.equal('a' in gone.marks, false)
  assert.equal(vim('a\nb\nc', 4, 'madd').text, 'a\nb')
  assert.equal('a' in vim('a\nb\nc', 4, 'madd').marks, false, 'the last line goes with the newline before it')
  assert.equal(vim('a\nb\nc', 0, 'jmakdd').marks.a, 0, 'a mark below the deleted line moved up with its text')
  assert.equal(vt('a\nb\nc', 4, "madd'a"), 'a\nb', "'a after the line went does nothing")
  assert.equal(vim('a\nb\nc', 4, "mak'a").cursor, 4, 'sanity: a set mark jumps')
  // d$ keeps the line and so keeps the mark.
  assert.equal(vim('abc\nd', 1, 'mad$').marks.a, 1)
  // A host applies its own edits with shiftMarks, over the document before.
  const doc = stringDoc('abcdefgh')
  const st = shiftMarks({ cursor: 0, mode: 'normal', marks: { a: 5, b: 1 } }, { from: 2, to: 2, insert: 'xyz' }, doc)
  assert.deepEqual(st.marks, { a: 8, b: 1 })
  assert.deepEqual(shiftMarks({ marks: { a: 3 } }, { from: 3, to: 3, insert: 'q' }, doc).marks, { a: 4 })
  assert.deepEqual(shiftMarks({ marks: { a: 3 } }, { from: 1, to: 5, insert: '' }, doc).marks, { a: 1 })
  assert.deepEqual(shiftMarks({ marks: { a: 3 } }, { from: 1, to: 3, insert: '' }, doc).marks, { a: 1 })
  assert.deepEqual(shiftMarks({ marks: { a: 3 } }, { from: 3, to: 5, insert: 'Z' }, doc).marks, { a: 3 })
  const frozen = Object.freeze({ marks: Object.freeze({ a: 3 }) })
  assert.ok(shiftMarks(frozen, { from: 0, to: 0, insert: 'x' }, doc) !== frozen)
  assert.deepEqual(frozen.marks, { a: 3 })
  assert.throws(() => shiftMarks(frozen, { from: 0, to: 0, insert: 'x' }), /shiftMarks\(.*the document has length/)
  assert.throws(() => shiftMarks(frozen, { from: 0, to: 0, insert: 'x' }, 'abc'), /shiftMarks\(.*the document has length/)
  assert.throws(() => shiftMarks(frozen, { from: 0 }, doc), /an edit is/)
})

// A small seeded generator, so a failing case replays.
function seeded(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('textbox: shiftMarks — PROPERTY: a mark lands where a sentinel character put in its place does', function () {
  const rand = seeded(2103)
  const pick = (n) => Math.floor(rand() * n)
  const SENTINEL = '\u0001'
  for (let i = 0; i < 4000; i++) {
    const text = Array.from({ length: pick(9) }, () => 'ab\n'[pick(3)]).join('')
    const mark = pick(text.length + 1)
    // Inserts and deletes: a replacement is graded by its own row.
    const from = pick(text.length + 1)
    const insertion = pick(2) === 0
    const to = insertion ? from : from + pick(text.length - from + 1)
    const insert = insertion ? Array.from({ length: 1 + pick(3) }, () => 'ab\n'[pick(3)]).join('') : ''
    // The sentinel sits before the character the mark is on; an edit's offsets
    // move past it when they are beyond the mark.
    const marked = text.slice(0, mark) + SENTINEL + text.slice(mark)
    const [f, t] = [from <= mark ? from : from + 1, to <= mark ? to : to + 1]
    const after = marked.slice(0, f) + insert + marked.slice(t)
    // A delete that takes a non-empty line's text and a newline beside it
    // takes the mark with it.
    const ls = mark === 0 ? 0 : text.lastIndexOf('\n', mark - 1) + 1
    const le = text.indexOf('\n', mark) < 0 ? text.length : text.indexOf('\n', mark)
    const wholeLine = !insertion && le > ls && from <= ls && to >= le && (to > le || from < ls)
    const got = shiftMarks({ marks: { a: mark } }, { from, to, insert }, stringDoc(text)).marks
    const label = `${JSON.stringify(text)} mark ${mark} edit ${from}-${to} ${JSON.stringify(insert)}`
    if (wholeLine) assert.equal('a' in got, false, label)
    else assert.equal(got.a, after.includes(SENTINEL) ? after.indexOf(SENTINEL) : f, label)
  }
})

test('textbox: shiftMarks — PROPERTY: deleting a whole line deletes a mark on it, empty lines aside, and moves the rest as the lines do', function () {
  const rand = seeded(2086)
  const pick = (n) => Math.floor(rand() * n)
  for (let i = 0; i < 1500; i++) {
    const lines = Array.from({ length: 1 + pick(5) }, () => 'abab'.slice(0, pick(4)))
    const text = lines.join('\n')
    const start = (n, ls = lines) => ls.slice(0, n).reduce((at, l) => at + l.length + 1, 0)
    const gone = pick(lines.length)
    const marks = {}
    for (let k = 0; k < 3; k++) {
      const line = pick(lines.length)
      marks['abc'[k]] = start(line) + pick(lines[line].length + 1)
    }
    // The three ways a line leaves: with the newline after it, before it, or alone.
    let edit
    if (lines.length === 1) edit = { from: 0, to: text.length, insert: '' }
    else if (gone < lines.length - 1) edit = { from: start(gone), to: start(gone + 1), insert: '' }
    else edit = { from: start(gone) - 1, to: text.length, insert: '' }
    const after = lines.filter((_, n) => n !== gone)
    const got = shiftMarks({ marks }, edit, stringDoc(text)).marks
    for (const [name, at] of Object.entries(marks)) {
      const line = text.slice(0, at).split('\n').length - 1
      const col = at - start(line)
      if (lines.length === 1) {
        assert.equal(got[name], 0, `${JSON.stringify(lines)} the only line stays, empty, with its mark at the start`)
      } else if (line === gone && lines[gone] === '') {
        // Removing an empty line's newline is also a join, so the mark stays
        // where the line was: at the end of the line before when it was last.
        const into = gone < lines.length - 1 ? start(gone, after) : start(gone - 1, after) + after[gone - 1].length
        assert.equal(got[name], into, `${JSON.stringify(lines)} mark ${name} on the empty line ${gone} stays where it was`)
      } else if (line === gone) assert.equal(name in got, false, `${JSON.stringify(lines)} mark ${name} on line ${line} goes with it`)
      else {
        const into = line > gone ? line - 1 : line
        assert.equal(got[name], start(into, after) + col, `${JSON.stringify(lines)} mark ${name} line ${line} col ${col}, line ${gone} deleted`)
      }
    }
  }
})

test('textbox: <C-a> and <C-x> — the number at or after the cursor, counted, signed, zero-padded, hex', function () {
  assert.equal(vt('x 9 y', 0, '<C-a>'), 'x 10 y')
  assert.equal(vim('x 9 y', 0, '<C-a>').cursor, 3, 'the cursor rests on the last digit')
  assert.equal(vt('x 9 y', 2, '<C-a>'), 'x 10 y')
  assert.equal(vt('x 19 y', 3, '<C-a>'), 'x 20 y', 'the cursor in the middle of a number takes the whole')
  assert.equal(vt('a 5 7', 0, '5<C-a>'), 'a 10 7')
  assert.equal(vt('a 5', 0, '7<C-x>'), 'a -2')
  assert.equal(vt('a -1', 0, '<C-a>'), 'a 0')
  assert.equal(vt('a -1', 3, '3<C-a>'), 'a 2')
  assert.equal(vt('a 007', 0, '<C-a>'), 'a 008')
  assert.equal(vt('a 099', 0, '<C-a>'), 'a 100')
  assert.equal(vt('a 0x0f', 0, '<C-a>'), 'a 0x10')
  assert.equal(vt('a 0xFF', 0, '<C-a>'), 'a 0x100')
  assert.equal(vt('a 0xff', 0, '<C-x>'), 'a 0xfe')
  assert.equal(vt('1 2', 2, '<C-a>'), '1 3', 'past the first number it takes the next')
  assert.equal(vt('1 2', 1, '<C-a>'), '1 3')
  assert.equal(vt('ab', 0, '<C-a>'), 'ab', 'no number is a failed command')
  assert.equal(vt('99999999999999999999', 0, '<C-a>'), '100000000000000000000')
  assert.equal(vt('x 9', 0, '<C-a>.'), 'x 11', '. repeats it')
  assert.equal(edit(textbox('x 9', { mode: 'normal', cursor: 0 }), 'increment').text, 'x 10')
})

test('textbox: editDoc — a failed motion says so, and nothing else does', function () {
  const doc = stringDoc('ab\ncd')
  const at = { cursor: 0, mode: 'normal' }
  assert.equal(editDoc(at, 'findForward', 'z', doc).failed, true)
  assert.equal(editDoc(at, 'findForward', 'b', doc).failed, false)
  assert.equal(editDoc({ cursor: 3, mode: 'normal' }, 'down', undefined, doc).failed, true)
  assert.equal(editDoc(at, 'down', undefined, doc).failed, false)
  assert.equal(editDoc(at, 'repeatFind', undefined, doc).failed, true)
  assert.equal(editDoc(at, 'putAfter', undefined, doc).failed, true, 'an empty register')
})

test('textbox: marks — a replacement with as many lines as it removed keeps a mark on its line and column; another lands at the start', function () {
  // gUiw over the word the mark is inside.
  const up = vim('foo bar baz', 4, 'ma')
  const upped = edit(edit({ ...up, cursor: 5 }, 'uppercase'), 'innerWord')
  assert.equal(upped.text, 'foo BAR baz')
  assert.equal(upped.marks.a, 4, 'gUiw keeps the mark where it was')
  assert.equal(vim('foo bar baz', 6, 'ma0gUiw').marks.a, 6, 'a mark inside the replaced word stays on its column')
  assert.equal(vim('foo bar baz', 5, 'ma0wgUiw').marks.a, 5)
  // >> rewrites the line; its mark stays on the line, at the same column.
  const ind = vim('a\nbcd\ne', 4, 'ma>>')
  assert.equal(ind.text, 'a\n  bcd\ne')
  assert.equal(ind.marks.a, 4)
  assert.equal(vim('a\n  bcd\ne', 4, 'ma<lt><lt>').marks.a, 4, 'clamped to the shorter line')
  // A replacement that changes the line count takes the mark to the start.
  assert.deepEqual(shiftMarks({ marks: { a: 4 } }, { from: 2, to: 6, insert: 'x\ny' }, stringDoc('abcdefgh')).marks, { a: 2 })
  assert.deepEqual(shiftMarks({ marks: { a: 4 } }, { from: 2, to: 6, insert: 'xy' }, stringDoc('abcdefgh')).marks, { a: 4 })
  assert.deepEqual(shiftMarks({ marks: { a: 5 } }, { from: 2, to: 8, insert: 'xy' }, stringDoc('abcdefgh')).marks, { a: 4 }, 'clamped to the new line')
  assert.deepEqual(shiftMarks({ marks: { a: 5 } }, { from: 2, to: 6, insert: 'x\ny' }, stringDoc('ab\ncd\nefgh')).marks, { a: 2 }, 'lines 2 removed, 1 inserted')
  // And a delete of an empty line through the operator is exact.
  assert.equal('a' in vim('a\n\nb', 2, 'madd').marks, false)
})

test('textbox: dot — a visual change repeats on a region of the same size from the cursor', function () {
  assert.equal(vt('abcdefghij', 0, 'vlld.'), 'ghij', 'characters on one line')
  assert.equal(vt('abcdefghij', 0, 'vllld.'), 'ij')
  assert.equal(vt('abc\ndef\nghi\njkl\nmno', 0, 'vjld.'), 'i\njkl\nmno', 'several lines, ending at the same column')
  assert.equal(vt('a\nb\nc\nd\ne', 0, 'Vjd.'), 'e', 'whole lines')
  assert.equal(vt('a\nb\nc\nd\ne', 0, 'Vd.'), 'c\nd\ne')
  assert.equal(vt('ab cd ef gh', 0, 'vlcX<Esc>w.'), 'X X ef gh', 'a change repeats its typed text')
  assert.equal(vt('abcde', 0, 'vlldl$.'), 'd', 'a region past the line end is clamped to it')
  assert.equal(vt('ab\ncd', 0, 'vly.'), 'ab\ncd', 'a yank is no change')
  assert.deepEqual(vim('abcd', 0, 'vld').last.actions, [['reselect', { mode: 'visual', lines: 1, width: 2 }], ['delete']])
})

test('textbox: dot — changes made inside a replayed macro set what . repeats, and . does not loop', function () {
  assert.equal(vt('a b c d e f g h', 0, 'qadwqx@a.'), 'd e f g h', '. after @a repeats the macro\'s last change, not the x before it')
  const s = vim('a b c d e f g h', 0, 'qadwq@a')
  assert.deepEqual(s.macros.a, [['delete'], ['wordForward']], 'the replay recorded nothing into the register')
  assert.deepEqual(s.last.actions, [['delete'], ['wordForward']])
  assert.equal(s.replaying, undefined)
  assert.equal(vt('a b c d e', 0, 'qa.q'), 'a b c d e', 'a . with nothing to repeat fails')
  assert.equal(vt('a b c d e f', 0, 'dwqa.q@a'), 'd e f', '. inside a macro repeats the change and the replay ends')
})
