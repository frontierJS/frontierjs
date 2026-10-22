/*
 * textbox.spec.js
 *
 * The case list is khat's `input.rs` tests that L1 holds (`IDEAS/keys.md`
 * Phase 4); each row names the one it ports. Rows for an operator grammar,
 * visual mode, `j`/`k` and find are L2's and are not here. The last rows step
 * the tables through `/keys`, as a host does, so a row that parses to nothing
 * or an action the reducer lacks shows here and not in a component.
 */

import { textbox, edit, NORMAL, INSERT } from '../../src/textbox/textbox.js'
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
  s = edit(s, 'delete')
  assert.equal(s.text, 'hélX')
  assert.equal(run(textbox('a', { cursor: 0 }), 'backspace').text, 'a')
  assert.equal(run(textbox('a'), 'delete').text, 'a')
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
  assert.deepEqual(s.register, { text: 'a', linewise: false })
  assert.equal(run(s, 'putAfter').text, 'bac')
  s = run(nm('one two', 0), 'deleteWord')
  assert.equal(s.register.text, 'one ')
  s = run(s, 'putAfter')
  assert.deepEqual([s.text, s.cursor], ['tone wo', 4])
  assert.equal(run(nm('one two', 0), 'deleteWord', 'putBefore').text, 'one two')
  assert.equal(run(nm('a', 0), 'putAfter').text, 'a')
})

test('textbox: linewise_yank_delete_put — yy and dd hold a line, p puts it below and P above', function () {
  let s = run(nm('one\ntwo\nthree', 5), 'yankLine')
  assert.deepEqual(s.register, { text: 'two', linewise: true })
  assert.equal(s.cursor, 5)
  s = run(s, 'putAfter')
  assert.deepEqual([s.text, s.cursor], ['one\ntwo\ntwo\nthree', 8])
  s = run(s, 'putBefore')
  assert.deepEqual([s.text, s.cursor], ['one\ntwo\ntwo\ntwo\nthree', 8])
  assert.equal(run(nm('one\ntwo\nthree', 0), 'deleteLine', 'putAfter').text, 'two\none\nthree')
  assert.equal(run(nm('a\nb', 2), 'yankLine', 'putAfter').text, 'a\nb\nb')
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
  assert.equal(run(nm('a b', 0), 'yankLine', 'undo').text, 'a b')
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
  assert.throws(() => edit(s, 'deleteWordd'), /no such action; it knows left, right/)
  assert.throws(() => edit(s, 'toString'), /no such action/)
  assert.throws(() => edit(s, 'type'), /'type' takes the text/)
  assert.throws(() => edit({}, 'left'), /a textbox\(\) state is required/)
  assert.throws(() => textbox('a', { mode: 'visual' }), /'normal' or 'insert'/)
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
  assert.deepEqual(s.register, { text: ' ', linewise: false })
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
