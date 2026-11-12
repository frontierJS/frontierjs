/*
 * textbox.js — text edited by vim's keys: the reducer over a document, the
 * string host a text control uses, and the tables that bind them
 * (`IDEAS/keys.md` Phases 4–5, `FJS-D1387`, `FJS-D2085`, `FJS-D2086`).
 *
 * Two levels of tables. `NORMAL` and `INSERT` are L1, the one-line box ui's
 * `<Textbox>` mounts: flat rows such as `dd` and `dw`, no operator grammar.
 * `VIM` is L2, keyed by mode: operators that wait for a motion or a text
 * object (`d`, `c`, `y`, `>`, `<`, `gu`, `gU`, `g~`), visual by character and
 * by line, finds, brackets, paragraphs and named registers. A host steps
 * `VIM[state.mode]` through `keymap()` from `/keys`, so after `d` the next
 * key is read from `VIM.operator`, where `w` is a range and `iw` an object;
 * the grammar is this reducer's, and `/keys` stays countless (`FJS-D2086`).
 *
 * `editDoc(state, action, arg, doc)` is the reducer. It reads the text only
 * through `doc`'s `{ length, lineCount, slice, lineStart, positionAt }` and
 * answers the edits to make, so an editor over a piece table keeps its own
 * buffer and its own undo. `textbox()` and `edit()` are the string host: they
 * hold `{ text, undo }` beside the state, apply the edits to the string, and
 * keep undo as snapshots of it.
 *
 * The state is `{ cursor, anchor, mode, registers }`, plus while they apply:
 * `operator` (in mode `'operator'`), `named` (the register a `"x` named for
 * the next command), `column` (the column `j` and `k` keep), `find` (what `;`
 * repeats) and `indent` (what `>` adds, two spaces when absent). `cursor` and
 * `anchor` are UTF-16 offsets, the unit a `<textarea>`'s `selectionStart`
 * counts in; a character `h`, `l` or `x` steps over is a grapheme. In visual
 * the anchor is the selection's other end and both ends are included.
 *
 * Registers follow vim: a yank fills `"0`, a delete of a line or more shifts
 * `"1`–`"9`, a smaller one fills `"-`, `"A` appends to `"a`, `"_` keeps
 * nothing, and `""` is whatever was written last. Only `"+` (and `"*`, the
 * same register) reaches the system clipboard: a write to it answers
 * `request: 'copy'`, and a host that wants `"+p` to read the clipboard writes
 * `registers['+']` while `named` is `'+'`.
 *
 * Usage:
 *   let s = textbox('hello', { mode: 'normal', cursor: 0 })
 *   s = edit(s, 'deleteWord')   // ''
 *   s = edit(s, 'undo')         // 'hello'
 *
 *   let out = editDoc({ cursor: 0, mode: 'normal' }, 'delete', undefined, buffer)
 *   out = editDoc(out.state, 'innerWord', undefined, buffer)
 *   // out.edits = [{ from: 0, to: 5, insert: '' }], applied by the editor
 */

import {
  reader, overlay, charAt, firstNonBlank, next, prev, snap, mapGraphemes,
  wordForward, wordBack, wordEnd, wordEndBack, runEnd, isSpaceAt,
  vertical, find, matchPair, paragraph,
  wordObject, bracketObject, quoteObject, paragraphObject,
} from './read.js'

const LIMIT = 200

// ─── The tables ───────────────────────────────────────────────────────────

/** L1: the keys of the box in NORMAL — khat's rows. */
export const NORMAL = Object.freeze({
  h: 'left', l: 'right', '<Left>': 'left', '<Right>': 'right', '<BS>': 'left',
  w: 'wordForward', b: 'wordBack', e: 'wordEnd',
  0: 'lineStart', '^': 'firstNonBlank', $: 'lineEnd', '<Home>': 'lineStart', '<End>': 'lineEnd',
  i: 'insert', a: 'append', I: 'insertLineStart', A: 'appendLineEnd',
  x: 'deleteChar', '<Del>': 'deleteChar', X: 'deleteBack', D: 'deleteToEnd',
  dd: 'deleteLine', dw: 'deleteWord', yy: 'yankLines',
  p: 'putAfter', P: 'putBefore',
  u: 'undo', '<C-r>': 'redo',
})

/** L1: the keys of the box in INSERT; a printable no row binds types. */
export const INSERT = Object.freeze({
  '<Esc>': 'normal',
  '<BS>': 'backspace', '<Del>': 'deleteForward', '<CR>': 'newline',
  '<Left>': 'left', '<Right>': 'right', '<Home>': 'lineStart', '<End>': 'lineEnd',
})

const MOTION_KEYS = {
  h: 'left', l: 'right', '<Left>': 'left', '<Right>': 'right', '<BS>': 'left', '<Space>': 'right',
  j: 'down', k: 'up', '<Down>': 'down', '<Up>': 'up',
  w: 'wordForward', b: 'wordBack', e: 'wordEnd', ge: 'wordEndBack',
  W: 'bigWordForward', B: 'bigWordBack', E: 'bigWordEnd', gE: 'bigWordEndBack',
  0: 'lineStart', '^': 'firstNonBlank', $: 'lineEnd', '<Home>': 'lineStart', '<End>': 'lineEnd',
  gg: 'top', G: 'bottom',
  f: { await: 'findForward' }, F: { await: 'findBack' }, t: { await: 'tillForward' }, T: { await: 'tillBack' },
  ';': 'repeatFind', ',': 'repeatFindBack',
  '%': 'matchPair', '}': 'paragraphForward', '{': 'paragraphBack',
}

const OPERATOR_KEYS = {
  d: 'delete', c: 'change', y: 'yank', '>': 'indent', '<lt>': 'outdent',
  gu: 'lowercase', gU: 'uppercase', 'g~': 'swapCase',
}

// `iw` and the rest; `b` and `B` are vim's names for `(` and `{`.
const OBJECT_KEYS = {}
for (const [keys, name] of [
  ['w', 'Word'], ['W', 'BigWord'], ['p', 'Paragraph'],
  ['(', 'Paren'], [')', 'Paren'], ['b', 'Paren'], ['[', 'Bracket'], [']', 'Bracket'],
  ['{', 'Brace'], ['}', 'Brace'], ['B', 'Brace'], ['<lt>', 'Angle'], ['>', 'Angle'],
  ['"', 'DoubleQuote'], ["'", 'SingleQuote'], ['`', 'BackQuote'],
]) {
  OBJECT_KEYS[`i${keys}`] = `inner${name}`
  OBJECT_KEYS[`a${keys}`] = `around${name}`
}

/**
 * L2, keyed by mode: `VIM[state.mode]` is the table to step. `visualLine`
 * shares `visual`'s table. Q15's Ctrl keys that scroll a view are the host's.
 */
export const VIM = (() => {
  const normal = Object.freeze({
    ...MOTION_KEYS, ...OPERATOR_KEYS,
    i: 'insert', a: 'append', I: 'insertLineStart', A: 'appendLineEnd', o: 'openBelow', O: 'openAbove',
    x: 'deleteChar', '<Del>': 'deleteChar', X: 'deleteBack', D: 'deleteToEnd', C: 'changeToEnd',
    s: 'substitute', S: 'changeLines', Y: 'yankLines',
    p: 'putAfter', P: 'putBefore', J: 'join', r: { await: 'replaceChar' }, '~': 'swapCaseChar',
    u: 'undo', '<C-r>': 'redo', v: 'visual', V: 'visualLine', '"': { await: 'register' }, '<Esc>': 'normal',
  })
  const operator = Object.freeze({
    ...MOTION_KEYS, ...OPERATOR_KEYS, ...OBJECT_KEYS,
    // `guu`, `gUU`, `g~~`: the operator's last key doubled is its line.
    u: 'lowercase', U: 'uppercase', '~': 'swapCase',
    '<Esc>': 'normal',
  })
  const visual = Object.freeze({
    ...MOTION_KEYS, ...OPERATOR_KEYS, ...OBJECT_KEYS,
    x: 'delete', '<Del>': 'delete', s: 'change', u: 'lowercase', U: 'uppercase', '~': 'swapCase',
    D: 'deleteLines', X: 'deleteLines', C: 'changeLines', S: 'changeLines', R: 'changeLines', Y: 'yankLines',
    p: 'putAfter', P: 'putBefore', J: 'join', r: { await: 'replaceChar' },
    o: 'swapEnds', v: 'visual', V: 'visualLine', '"': { await: 'register' }, '<Esc>': 'normal',
  })
  const insert = Object.freeze({ ...INSERT, '<Up>': 'up', '<Down>': 'down' })
  return Object.freeze({ normal, insert, operator, visual, visualLine: visual })
})()

const MODES = new Set(Object.keys(VIM))
const isVisual = (mode) => mode === 'visual' || mode === 'visualLine'

function refuse(fn, input, why) {
  throw new TypeError(`${fn}(${JSON.stringify(input)}): ${why}`)
}

const EMPTY = Object.freeze({ text: '', linewise: false })
const NO_REGISTERS = Object.freeze({})
const NO_UNDO = Object.freeze({ past: Object.freeze([]), future: Object.freeze([]) })

// ─── The string host ──────────────────────────────────────────────────────

/**
 * A box holding `text`. It opens in INSERT with the cursor at the end, as a
 * field someone is about to type in does; `{ mode: 'normal' }` opens it in
 * NORMAL, where the cursor rests on a character. `anchor` is the other end of
 * a selection, and is the cursor when left out.
 */
export function textbox(text = '', { cursor, anchor, mode = 'insert' } = {}) {
  if (typeof text !== 'string') refuse('textbox', text, 'the text is a string')
  checkPlace('textbox', { cursor, anchor, mode })
  text = lf(text)
  const at = clamp(cursor ?? text.length, text.length)
  const s = { text, cursor: at, anchor: clamp(anchor ?? at, text.length), mode, registers: NO_REGISTERS, undo: NO_UNDO }
  return Object.freeze(mode === 'normal' ? { ...s, ...rest(s, reader(stringDoc(text))) } : s)
}

/**
 * `action` applied to the box: a name from the tables, `type` with the text
 * as `arg`, or `sync` with `{ text, cursor, anchor }`, what a control the
 * person typed or clicked in now holds. A name the box does not know is
 * refused, since the key bound to it would do nothing.
 *
 * In NORMAL a change is one undo step, and so is everything typed between
 * entering INSERT and leaving it. A `sync` that only moves the cursor is no
 * change, so a click keeps what `redo` would bring back.
 */
export function edit(state, action, arg) {
  if (!state || typeof state.text !== 'string' || !state.undo) refuse('edit', state, 'a textbox() state is required')
  if (action === 'sync') return sync(state, arg)
  const out = editDoc(state, action, arg, stringDoc(state.text))

  const kept = out.step ? checkpoint(state) : state
  let text = kept.text
  for (const e of out.edits) text = text.slice(0, e.from) + e.insert + text.slice(e.to)
  let s = { ...out.state, text, undo: kept.undo }
  if (out.request === 'undo' || out.request === 'redo') {
    const back = travel(s, out.request === 'undo' ? 'past' : 'future', out.request === 'undo' ? 'future' : 'past')
    s = { ...s, ...back, anchor: back.cursor ?? s.anchor }
    if (s.mode === 'normal') s = { ...s, ...rest(s, reader(stringDoc(s.text))) }
  }
  return Object.freeze(s)
}

function sync(s, arg) {
  if (typeof arg?.text !== 'string' || !Number.isInteger(arg.cursor) || !(arg.anchor === undefined || Number.isInteger(arg.anchor))) {
    refuse('edit', arg, "'sync' takes { text, cursor, anchor? }, what the control holds")
  }
  const text = lf(arg.text)
  if (s.mode === 'normal' && text !== s.text) s = checkpoint(s)
  const next = { ...s, text, cursor: clamp(arg.cursor, text.length), anchor: clamp(arg.anchor ?? arg.cursor, text.length) }
  return Object.freeze(next.mode === 'normal' ? { ...next, ...rest(next, reader(stringDoc(text))) } : next)
}

/**
 * A string as the document `editDoc` reads. Lines are indexed once per
 * string, which suits a box's few lines; an editor hands its own buffer.
 */
export function stringDoc(text) {
  if (typeof text !== 'string') refuse('stringDoc', text, 'the text is a string')
  const starts = [0]
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return Object.freeze({
    length: text.length,
    lineCount: starts.length,
    slice: (from, to) => text.slice(from, to),
    lineStart: (n) => starts[n],
    positionAt(offset) {
      let lo = 0
      let hi = starts.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (starts[mid] <= offset) lo = mid
        else hi = mid - 1
      }
      return { line: lo, column: offset - starts[lo] }
    },
  })
}

// The box as it was before a change, kept unless the text is what the last
// one kept; a change drops what `redo` would have brought back.
function checkpoint(s) {
  const { past } = s.undo
  const same = past.length && past[past.length - 1].text === s.text
  const kept = same ? past : [...past, Object.freeze({ text: s.text, cursor: s.cursor })].slice(-LIMIT)
  return { ...s, undo: Object.freeze({ past: Object.freeze(kept), future: NO_UNDO.future }) }
}

// One step from `from` to `to`, skipping a snapshot the text already equals.
function travel(s, from, to) {
  const src = [...s.undo[from]]
  while (src.length) {
    const kept = src.pop()
    if (kept.text === s.text) continue
    const dst = [...s.undo[to], Object.freeze({ text: s.text, cursor: s.cursor })]
    return {
      text: kept.text,
      cursor: kept.cursor,
      undo: Object.freeze({ [from]: Object.freeze(src), [to]: Object.freeze(dst) }),
    }
  }
  return {}
}

const lf = (t) => t.replace(/\r\n?/g, '\n')

// ─── The reducer over a document ──────────────────────────────────────────

/**
 * `action` applied at `state` over `doc`. Answers `{ state, edits, request,
 * step }`: the next state with offsets in the text after `edits`; `edits` as
 * `[{ from, to, insert }]` in the text before them; `request` as `'undo'` or
 * `'redo'` when the key asks the host to travel its own history, or `'copy'`
 * when `registers['+']` was written; and `step` true when an undo step begins
 * before these edits — a change outside INSERT, or entering INSERT, which
 * makes what is typed there one step.
 *
 * `doc` is read and never written. `sync` is the string host's and is
 * refused here: an editor applies its own typing.
 */
export function editDoc(state, action, arg, doc) {
  if (!state || !Number.isInteger(state.cursor)) refuse('editDoc', state, 'a state with a cursor is required')
  checkPlace('editDoc', { cursor: state.cursor, anchor: state.anchor, mode: state.mode })
  checkDoc(doc)
  if (!KNOWN.has(action)) refuse('edit', action, 'the box has no such action; the tables NORMAL, INSERT and VIM name every one it knows, and sync')
  if (action === 'type' && typeof arg !== 'string') refuse('edit', arg, "'type' takes the text it types")
  if (AWAITS.has(action) && typeof arg !== 'string') refuse('edit', arg, `'${action}' takes the character the key after it gave`)

  const r = reader(doc)
  const s = {
    ...state,
    cursor: clamp(state.cursor, r.length),
    anchor: clamp(state.anchor ?? state.cursor, r.length),
    mode: state.mode ?? 'insert',
    registers: state.registers ?? NO_REGISTERS,
  }
  const out = dispatch(s, r, action, arg)
  const after = out.edit ? overlay(r, out.edit) : r
  const mode = out.mode ?? s.mode
  const cursor = out.cursor ?? s.cursor
  // Outside visual a selection lasts until the cursor moves.
  const anchor = 'anchor' in out ? out.anchor
    : isVisual(mode) && isVisual(s.mode) ? s.anchor
      : 'cursor' in out ? cursor : s.anchor
  let next = { cursor, anchor, mode, registers: out.registers ?? s.registers }
  if (mode === 'operator') next.operator = out.operator ?? s.operator
  if (out.named ?? (mode === 'operator' && s.named)) next.named = out.named ?? s.named
  const column = 'column' in out ? out.column : undefined
  if (column !== undefined) next.column = column
  if (out.find ?? s.find) next.find = out.find ?? s.find
  if (s.indent !== undefined) next.indent = s.indent
  if (mode === 'normal' || mode === 'operator') next = { ...next, ...rest(next, after) }
  else if (isVisual(mode)) next.cursor = onChar(after, next.cursor)
  return Object.freeze({
    state: Object.freeze(next),
    edits: Object.freeze(out.edit ? [Object.freeze(out.edit)] : []),
    request: out.request ?? (out.registers?.['+'] && out.registers['+'] !== s.registers['+'] ? 'copy' : undefined),
    step: s.mode !== 'insert' && (Boolean(out.edit) || (mode === 'insert' && s.mode !== 'insert')),
  })
}

function checkPlace(fn, { cursor, anchor, mode = 'insert' }) {
  if (!MODES.has(mode)) refuse(fn, mode, `the mode is one of ${[...MODES].join(', ')}`)
  for (const [name, at] of [['cursor', cursor], ['anchor', anchor]]) {
    if (at !== undefined && !Number.isInteger(at)) refuse(fn, at, `the ${name} is an offset into the text`)
  }
}

function checkDoc(doc) {
  const ok = doc && Number.isInteger(doc.length) && Number.isInteger(doc.lineCount)
    && typeof doc.slice === 'function' && typeof doc.lineStart === 'function' && typeof doc.positionAt === 'function'
  if (!ok) refuse('editDoc', typeof doc, 'the document has length, lineCount, slice, lineStart and positionAt')
}

const clamp = (i, length) => Math.max(0, Math.min(i, length))

// The grapheme a NORMAL or visual cursor rests on, never past a line's last.
function onChar(r, i) {
  const cur = clamp(i, r.length)
  const ls = r.lineStartAt(cur)
  const le = r.lineEndAt(cur)
  return cur >= le && le > ls ? prev(r, le) : snap(r, cur)
}

// In NORMAL the cursor rests on a character and a selection is the cursor alone.
function rest(s, r) {
  const cursor = onChar(r, s.cursor)
  return { cursor, anchor: cursor }
}

function dispatch(s, r, action, arg) {
  if (s.mode === 'operator') {
    if (OPERATORS.has(action)) {
      if (action !== s.operator) return { mode: 'normal' }
      return operate(s, r, action, { ...lines(r, s.cursor, s.cursor), lo: s.cursor })
    }
    if (Object.hasOwn(MOTIONS, action)) return { ...operate(s, r, s.operator, motionRange(s, r, action, arg)), find: findMemory(s, action, arg) }
    if (Object.hasOwn(OBJECTS, action)) return operate(s, r, s.operator, OBJECTS[action](r, s.cursor))
    return { mode: 'normal' }
  }
  if (isVisual(s.mode)) {
    if (Object.hasOwn(VISUAL, action)) return VISUAL[action](s, r, arg)
    if (OPERATORS.has(action)) return operate(s, r, action, selection(s, r))
    if (Object.hasOwn(OBJECTS, action)) return selectObject(s, r, OBJECTS[action](r, s.cursor))
  }
  if (Object.hasOwn(MOTIONS, action)) return runMotion(s, r, action, arg)
  if (OPERATORS.has(action)) return s.mode === 'normal' ? { mode: 'operator', operator: action, named: s.named } : {}
  if (Object.hasOwn(ACTIONS, action)) return ACTIONS[action](s, r, arg)
  return {}
}

// ─── Motions ──────────────────────────────────────────────────────────────
//
// Each `to` answers where the motion lands from `s`, or null where it fails;
// `kind` is vim's: exclusive, inclusive or linewise, what an operator takes.

const column = (s, r) => s.column ?? s.cursor - r.lineStartAt(s.cursor)

function finder(how) {
  return { kind: how === 'f' || how === 't' ? 'inclusive' : 'exclusive', to: (s, r, ch) => find(r, s.cursor, how, ch) }
}
const REVERSE = { f: 'F', F: 'f', t: 'T', T: 't' }
function repeat(reversed) {
  const how = (s) => (s.find ? (reversed ? REVERSE[s.find.how] : s.find.how) : null)
  return {
    kind: (s) => (how(s) === 'f' || how(s) === 't' ? 'inclusive' : 'exclusive'),
    to: (s, r) => (s.find ? find(r, s.cursor, how(s), s.find.char, true) : null),
  }
}

const MOTIONS = {
  left: {
    kind: 'exclusive',
    to: (s, r) => {
      const floor = s.mode === 'insert' ? 0 : r.lineStartAt(s.cursor)
      return s.cursor > floor ? prev(r, s.cursor) : s.cursor
    },
  },
  right: {
    kind: 'exclusive',
    to: (s, r) => {
      if (s.mode === 'insert') return next(r, s.cursor)
      const le = r.lineEndAt(s.cursor)
      if (s.mode === 'operator') return Math.min(next(r, s.cursor), le)
      return next(r, s.cursor) < le ? next(r, s.cursor) : s.cursor
    },
  },
  up: { kind: 'linewise', to: (s, r) => vertical(r, s.cursor, -1, column(s, r)) },
  down: { kind: 'linewise', to: (s, r) => vertical(r, s.cursor, 1, column(s, r)) },
  wordForward: { kind: 'exclusive', to: (s, r) => wordForward(r, s.cursor) },
  bigWordForward: { kind: 'exclusive', to: (s, r) => wordForward(r, s.cursor, true) },
  wordBack: { kind: 'exclusive', to: (s, r) => wordBack(r, s.cursor) },
  bigWordBack: { kind: 'exclusive', to: (s, r) => wordBack(r, s.cursor, true) },
  wordEnd: { kind: 'inclusive', to: (s, r) => wordEnd(r, s.cursor) },
  bigWordEnd: { kind: 'inclusive', to: (s, r) => wordEnd(r, s.cursor, true) },
  wordEndBack: { kind: 'inclusive', to: (s, r) => wordEndBack(r, s.cursor) },
  bigWordEndBack: { kind: 'inclusive', to: (s, r) => wordEndBack(r, s.cursor, true) },
  lineStart: { kind: 'exclusive', to: (s, r) => r.lineStartAt(s.cursor) },
  firstNonBlank: { kind: 'exclusive', to: (s, r) => firstNonBlank(r, s.cursor) },
  lineEnd: { kind: 'exclusive', to: (s, r) => r.lineEndAt(s.cursor) },
  top: { kind: 'linewise', to: (s, r) => firstNonBlank(r, 0) },
  bottom: { kind: 'linewise', to: (s, r) => firstNonBlank(r, r.lineStart(r.lineCount - 1)) },
  findForward: finder('f'),
  findBack: finder('F'),
  tillForward: finder('t'),
  tillBack: finder('T'),
  repeatFind: repeat(false),
  repeatFindBack: repeat(true),
  matchPair: { kind: 'inclusive', to: (s, r) => matchPair(r, s.cursor) },
  paragraphForward: { kind: 'exclusive', to: (s, r) => paragraph(r, s.cursor, true) },
  paragraphBack: { kind: 'exclusive', to: (s, r) => paragraph(r, s.cursor, false) },
}

const FINDS = { findForward: 'f', findBack: 'F', tillForward: 't', tillBack: 'T' }
const findMemory = (s, action, ch) => (FINDS[action] ? Object.freeze({ how: FINDS[action], char: ch }) : s.find)

function runMotion(s, r, action, arg) {
  const at = MOTIONS[action].to(s, r, arg)
  const out = { find: findMemory(s, action, arg) }
  if (at === null) return out
  out.cursor = at
  if (action === 'up' || action === 'down') out.column = column(s, r)
  else if (action === 'lineEnd' && s.mode !== 'insert') out.column = Infinity
  return out
}

// What a motion covers for an operator: `{ from, to, linewise, lo }`, `to`
// exclusive, `lo` where a yank leaves the cursor; null where it fails.
function motionRange(s, r, action, arg) {
  const m = MOTIONS[action]
  const at = m.to(s, r, arg)
  if (at === null) return null
  const kind = typeof m.kind === 'function' ? m.kind(s) : m.kind
  const from = Math.min(s.cursor, at)
  let to = Math.max(s.cursor, at)
  if (kind === 'linewise') return { ...lines(r, from, to), lo: from }
  if (kind === 'inclusive') return { from, to: next(r, to), linewise: false, lo: from }

  if (action === 'wordForward' || action === 'bigWordForward') {
    // `cw` on a word changes to its end, the space after it kept.
    if (s.operator === 'change' && !isSpaceAt(r, s.cursor)) return { from, to: runEnd(r, s.cursor, action === 'bigWordForward'), linewise: false, lo: from }
    // The last word on a line ends the range there, not at the next line's first word.
    to = Math.min(to, Math.max(from, r.lineEndAt(from)))
  }
  // An exclusive range ending at a line's start ends on the line before it,
  // and covers whole lines when it also began at or before its first non-blank
  // (`:help exclusive-linewise`), so `d}` from a paragraph's start takes its lines.
  if (to > from && r.lineStartAt(to) === to && r.lineStartAt(from) < to) {
    if (from <= firstNonBlank(r, from)) return { ...lines(r, from, to - 1), lo: from }
    to -= 1
  }
  return { from, to, linewise: false, lo: from }
}

const lines = (r, a, b) => ({ from: r.lineStartAt(a), to: r.lineEndAt(b), linewise: true })

// ─── Text objects ─────────────────────────────────────────────────────────

const QUOTES = { DoubleQuote: '"', SingleQuote: "'", BackQuote: '`' }
const PAIRS = { Paren: '(', Bracket: '[', Brace: '{', Angle: '<' }
const OBJECTS = {}
for (const around of [false, true]) {
  const p = around ? 'around' : 'inner'
  OBJECTS[`${p}Word`] = (r, i) => wordObject(r, i, around, false)
  OBJECTS[`${p}BigWord`] = (r, i) => wordObject(r, i, around, true)
  OBJECTS[`${p}Paragraph`] = (r, i) => paragraphObject(r, i, around)
  for (const [name, open] of Object.entries(PAIRS)) OBJECTS[`${p}${name}`] = (r, i) => bracketObject(r, i, open, around)
  for (const [name, q] of Object.entries(QUOTES)) OBJECTS[`${p}${name}`] = (r, i) => quoteObject(r, i, q, around)
}

// In visual an object becomes the selection; a paragraph turns it linewise.
function selectObject(s, r, range) {
  if (!range || range.from === range.to) return {}
  if (range.linewise) return { mode: 'visualLine', anchor: range.from, cursor: range.to }
  return { anchor: range.from, cursor: prev(r, range.to) }
}

// ─── Registers ────────────────────────────────────────────────────────────

const NAMES = /^[a-zA-Z0-9"\-+*_]$/

// Vim's writes: see the header. `how` is 'yank' or 'delete'.
function store(s, text, linewise, how) {
  const named = s.named
  if (named === '_') return s.registers
  const entry = Object.freeze({ text, linewise })
  const out = { ...s.registers }
  if (named && named !== '"') {
    const name = named === '*' ? '+' : named.toLowerCase()
    const old = out[name]
    out[name] = /[A-Z]/.test(named) && old
      ? Object.freeze({ text: old.linewise || linewise ? `${old.text}\n${text}` : old.text + text, linewise: old.linewise || linewise })
      : entry
    out['"'] = out[name]
  } else if (how === 'yank') {
    out['0'] = out['"'] = entry
  } else {
    if (linewise || text.includes('\n')) {
      for (let n = 9; n > 1; n--) if (out[n - 1]) out[n] = out[n - 1]
      out['1'] = entry
    } else out['-'] = entry
    out['"'] = entry
  }
  return Object.freeze(out)
}

function read(s) {
  const named = s.named && s.named !== '"' ? (s.named === '*' ? '+' : s.named.toLowerCase()) : '"'
  return s.registers[named] ?? EMPTY
}

// ─── Operators ────────────────────────────────────────────────────────────

const OPERATORS = new Set(['delete', 'change', 'yank', 'indent', 'outdent', 'lowercase', 'uppercase', 'swapCase'])
const CASES = {
  lowercase: (g) => g.toLowerCase(),
  uppercase: (g) => g.toUpperCase(),
  swapCase: (g) => (g === g.toUpperCase() ? g.toLowerCase() : g.toUpperCase()),
}

// `op` over `range`; a range that failed cancels the operator.
function operate(s, r, op, range) {
  if (!range) return { mode: 'normal' }
  const { from, to, linewise } = range
  const lo = range.lo ?? from
  const text = r.slice(from, to)
  switch (op) {
    case 'yank':
      return { mode: 'normal', cursor: lo, registers: store(s, text, linewise, 'yank') }
    case 'delete':
      if (linewise) return { ...removeLines(r, from, to), mode: 'normal', registers: store(s, text, true, 'delete') }
      if (from === to) return { mode: 'normal' }
      return { edit: { from, to, insert: '' }, cursor: from, mode: 'normal', registers: store(s, text, false, 'delete') }
    case 'change': {
      const out = { cursor: from, mode: 'insert' }
      if (from === to) return out
      return { ...out, edit: { from, to, insert: '' }, registers: store(s, text, linewise, 'delete') }
    }
    case 'indent':
    case 'outdent': {
      const ls = r.lineStartAt(from)
      const le = r.lineEndAt(to)
      const unit = s.indent ?? '  '
      const shifted = r.slice(ls, le).split('\n').map((line) => (op === 'indent' ? (line ? unit + line : line) : outdent(line, unit))).join('\n')
      const edit = { from: ls, to: le, insert: shifted }
      return { edit, cursor: firstNonBlank(overlay(r, edit), ls), mode: 'normal' }
    }
    default: {
      const mapped = mapGraphemes(text, CASES[op])
      if (mapped === text) return { mode: 'normal', cursor: lo }
      return { edit: { from, to, insert: mapped }, cursor: lo, mode: 'normal' }
    }
  }
}

function outdent(line, unit) {
  if (line.startsWith('\t')) return line.slice(1)
  let k = 0
  while (k < unit.length && line[k] === ' ') k++
  return line.slice(k)
}

// Whole lines out: the newline after them, or before them on the last line.
function removeLines(r, ls, le) {
  let edit
  let at
  if (le < r.length) [edit, at] = [{ from: ls, to: le + 1, insert: '' }, ls]
  else if (ls > 0) [edit, at] = [{ from: ls - 1, to: le, insert: '' }, r.lineStartAt(ls - 1)]
  else [edit, at] = [le > 0 ? { from: 0, to: le, insert: '' } : undefined, 0]
  return { edit, cursor: edit ? firstNonBlank(overlay(r, edit), at) : 0 }
}

function put(s, r, after) {
  const { text, linewise } = read(s)
  if (!text && !linewise) return {}
  const cur = s.cursor
  if (linewise) {
    const at = after ? r.lineEndAt(cur) : r.lineStartAt(cur)
    const edit = { from: at, to: at, insert: after ? '\n' + text : text + '\n' }
    return { edit, cursor: firstNonBlank(overlay(r, edit), after ? at + 1 : at) }
  }
  const at = after && cur < r.lineEndAt(cur) ? next(r, cur) : cur
  const edit = { from: at, to: at, insert: text }
  // A put of more than a line leaves the cursor at its start, of less at its end.
  return { edit, cursor: text.includes('\n') ? at : prev(overlay(r, edit), at + text.length) }
}

// `J` from `a`'s line through `b`'s: each break and the next line's indent
// become one space, none after a space already there, before an empty line
// or before a `)`. The cursor lands where the last two lines met.
function join(r, a, b) {
  const ls = r.lineStartAt(a)
  const end = r.lineEndAt(b)
  const parts = r.slice(ls, end).split('\n')
  let out = parts[0]
  let cursor = ls
  for (const part of parts.slice(1)) {
    const body = part.replace(/^[ \t]+/, '')
    const space = body && !/[ \t]$/.test(out) && !body.startsWith(')') ? ' ' : ''
    cursor = ls + out.length
    out += space + body
  }
  return { edit: { from: ls, to: end, insert: out }, cursor, mode: 'normal' }
}

// ─── Visual ───────────────────────────────────────────────────────────────

// The selection, both ends included: whole lines in `visualLine`.
function selection(s, r) {
  const lo = Math.min(s.anchor, s.cursor)
  const hi = Math.max(s.anchor, s.cursor)
  if (s.mode === 'visualLine') return { ...lines(r, lo, hi), lo: r.lineStartAt(lo) }
  return { from: lo, to: Math.min(r.length, next(r, hi)), linewise: false, lo }
}

/** The span a visual state selects, for a host to paint: `{ from, to, linewise }`, or null outside visual. */
export function visualRange(state, doc) {
  checkDoc(doc)
  if (!isVisual(state?.mode)) return null
  const { from, to, linewise } = selection(state, reader(doc))
  return Object.freeze({ from, to, linewise })
}

function visualPut(s, r, keep) {
  const reg = read(s)
  if (!reg.text && !reg.linewise) return { mode: 'normal' }
  const range = selection(s, r)
  const { from, to, linewise } = range
  let insert = reg.text
  if (reg.linewise && !linewise) insert = '\n' + reg.text + (to < r.lineEndAt(to) ? '\n' : '')
  const edit = { from, to, insert }
  const after = overlay(r, edit)
  const cursor = reg.linewise ? firstNonBlank(after, reg.linewise && !linewise ? from + 1 : from) : prev(after, from + insert.length)
  const registers = keep ? s.registers : store({ ...s, named: undefined }, r.slice(from, to), linewise, 'delete')
  return { edit, cursor, mode: 'normal', registers }
}

function replaceEach(r, range, ch) {
  const text = r.slice(range.from, range.to)
  const insert = mapGraphemes(text, () => ch)
  return { edit: insert === text ? undefined : { from: range.from, to: range.to, insert }, cursor: range.from, mode: 'normal' }
}

const VISUAL = {
  visual: (s) => ({ mode: s.mode === 'visual' ? 'normal' : 'visual' }),
  visualLine: (s) => ({ mode: s.mode === 'visualLine' ? 'normal' : 'visualLine' }),
  normal: () => ({ mode: 'normal' }),
  swapEnds: (s) => ({ cursor: s.anchor, anchor: s.cursor }),
  deleteLines: (s, r) => operate(s, r, 'delete', { ...lines(r, Math.min(s.anchor, s.cursor), Math.max(s.anchor, s.cursor)) }),
  changeLines: (s, r) => operate(s, r, 'change', { ...lines(r, Math.min(s.anchor, s.cursor), Math.max(s.anchor, s.cursor)) }),
  yankLines: (s, r) => {
    const lo = Math.min(s.anchor, s.cursor)
    return operate(s, r, 'yank', { ...lines(r, lo, Math.max(s.anchor, s.cursor)), lo: r.lineStartAt(lo) })
  },
  putAfter: (s, r) => visualPut(s, r, false),
  putBefore: (s, r) => visualPut(s, r, true),
  // One line selected joins it with the next, as vim's does.
  join: (s, r) => {
    const lo = Math.min(s.anchor, s.cursor)
    const hi = Math.max(s.anchor, s.cursor)
    const b = r.lineStartAt(hi) > r.lineStartAt(lo) ? hi : r.lineEndAt(lo) + 1
    return b > r.length ? { mode: 'normal' } : { mode: 'normal', ...join(r, lo, b) }
  },
  replaceChar: (s, r, ch) => replaceEach(r, selection(s, r), ch),
  register: (s, r, ch) => (NAMES.test(ch) ? { named: ch } : {}),
}

// ─── The actions ──────────────────────────────────────────────────────────

const op = (name, rangeOf) => (s, r) => operate(s, r, name, rangeOf(s, r))
const charRange = (s, r) => ({ from: s.cursor, to: Math.min(next(r, s.cursor), r.lineEndAt(s.cursor)), linewise: false })
const backRange = (s, r) => ({ from: s.cursor > r.lineStartAt(s.cursor) ? prev(r, s.cursor) : s.cursor, to: s.cursor, linewise: false })
const toEnd = (s, r) => ({ from: s.cursor, to: r.lineEndAt(s.cursor), linewise: false })
const lineRange = (s, r) => ({ ...lines(r, s.cursor, s.cursor), lo: s.cursor })

const ACTIONS = {
  insert: () => ({ mode: 'insert' }),
  append: (s, r) => ({ mode: 'insert', cursor: s.cursor < r.lineEndAt(s.cursor) ? next(r, s.cursor) : s.cursor }),
  insertLineStart: (s, r) => ({ mode: 'insert', cursor: firstNonBlank(r, s.cursor) }),
  appendLineEnd: (s, r) => ({ mode: 'insert', cursor: r.lineEndAt(s.cursor) }),
  openBelow: (s, r) => {
    const le = r.lineEndAt(s.cursor)
    return { edit: { from: le, to: le, insert: '\n' }, cursor: le + 1, mode: 'insert' }
  },
  openAbove: (s, r) => {
    const ls = r.lineStartAt(s.cursor)
    return { edit: { from: ls, to: ls, insert: '\n' }, cursor: ls, mode: 'insert' }
  },
  // Esc steps back onto the last character typed, as vim's does, but never
  // off the line it is on; from a pending operator it cancels it.
  normal: (s, r) => ({
    mode: 'normal',
    cursor: s.mode === 'insert' && s.cursor > r.lineStartAt(s.cursor) ? prev(r, s.cursor) : s.cursor,
  }),
  visual: () => ({ mode: 'visual' }),
  visualLine: () => ({ mode: 'visualLine' }),
  register: (s, r, ch) => (NAMES.test(ch) ? { named: ch } : {}),

  deleteChar: op('delete', charRange),
  deleteBack: op('delete', backRange),
  deleteToEnd: op('delete', toEnd),
  changeToEnd: op('change', toEnd),
  substitute: op('change', charRange),
  deleteLine: op('delete', lineRange),
  changeLines: op('change', lineRange),
  yankLines: op('yank', lineRange),
  deleteWord: (s, r) => operate(s, r, 'delete', motionRange(s, r, 'wordForward')),
  putAfter: (s, r) => put(s, r, true),
  putBefore: (s, r) => put(s, r, false),
  join: (s, r) => {
    const le = r.lineEndAt(s.cursor)
    return le < r.length ? join(r, s.cursor, le + 1) : {}
  },
  replaceChar: (s, r, ch) => {
    const range = charRange(s, r)
    return range.from < range.to ? replaceEach(r, range, ch) : {}
  },
  // `~` swaps one character's case and steps on, never off the line.
  swapCaseChar: (s, r) => {
    const range = charRange(s, r)
    if (range.from === range.to) return {}
    const out = operate(s, r, 'swapCase', range)
    const after = out.edit ? overlay(r, out.edit) : r
    const end = range.from + (out.edit ? out.edit.insert.length : range.to - range.from)
    return { ...out, cursor: end < after.lineEndAt(range.from) ? end : range.from }
  },

  undo: () => ({ request: 'undo' }),
  redo: () => ({ request: 'redo' }),

  type: (s, r, text) => replaceSelection(s, text),
  newline: (s) => replaceSelection(s, '\n'),
  backspace: (s, r) => {
    const [from, to] = span(s)
    if (from < to) return replaceSelection(s, '')
    const at = prev(r, from)
    return at < from ? { edit: { from: at, to: from, insert: '' }, cursor: at } : {}
  },
  deleteForward: (s, r) => {
    const [from, to] = span(s)
    if (from < to) return replaceSelection(s, '')
    const end = next(r, from)
    return end > from ? { edit: { from, to: end, insert: '' }, cursor: from } : {}
  },
}

// The selection a typed key replaces in INSERT, `[from, to)`.
const span = (s) => [Math.min(s.anchor, s.cursor), Math.max(s.anchor, s.cursor)]

function replaceSelection(s, put) {
  const [from, to] = span(s)
  put = lf(put)
  return { edit: { from, to, insert: put }, cursor: from + put.length }
}

const KNOWN = new Set([...Object.keys(MOTIONS), ...OPERATORS, ...Object.keys(OBJECTS), ...Object.keys(VISUAL), ...Object.keys(ACTIONS)])
const AWAITS = new Set(['findForward', 'findBack', 'tillForward', 'tillBack', 'replaceChar', 'register'])

// A row naming an action the box lacks is a key that does nothing, so it
// fails the import rather than the press.
for (const table of [NORMAL, INSERT, ...Object.values(VIM)]) {
  for (const [keys, value] of Object.entries(table)) {
    const action = typeof value === 'string' ? value : value.await
    if (!KNOWN.has(action)) refuse('textbox', keys, `'${action}' is no action of the box`)
  }
}
