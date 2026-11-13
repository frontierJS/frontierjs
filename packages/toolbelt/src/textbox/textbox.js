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
 * Counts, `.`, macros and marks are the vim layer's own (`FJS-D2086`,
 * `FJS-D2101`, `FJS-D2102`). A digit key is the action `digit0`–`digit9`:
 * `count` holds the digits typed, `opCount` the ones before an operator, and
 * `0` with none pending is `lineStart`. `.` and `@a` answer `request:
 * 'replay'` with `actions`, `[[action, arg?], ...]` ending in `['replayEnd']`:
 * the host calls `editDoc` for each in order, applies each edit to its own
 * document, stops after one that answers `failed`, and makes the loop one undo
 * step. `replaying` counts the replays under way and clears itself, so a host
 * sets nothing, and a replay never records. `marks` are offsets that `editDoc`
 * moves with its own edits; a host calls `shiftMarks` for every other edit.
 * While `recording` is set a host steps `RECORDING` in place of `VIM.normal`.
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
  reader, overlay, firstNonBlank, next, prev, snap, mapGraphemes,
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
  '^': 'firstNonBlank', $: 'lineEnd', '<Home>': 'lineStart', '<End>': 'lineEnd',
  gg: 'top', G: 'bottom',
  f: { await: 'findForward' }, F: { await: 'findBack' }, t: { await: 'tillForward' }, T: { await: 'tillBack' },
  ';': 'repeatFind', ',': 'repeatFindBack',
  '%': 'matchPair', '}': 'paragraphForward', '{': 'paragraphBack',
  '`': { await: 'markJump' }, "'": { await: 'markLine' },
}

// A digit is a count while one is pending and `0` is the line-start motion
// when none is (`FJS-D2086`); `/keys` hands the vim layer each as a chord.
const DIGIT_KEYS = Object.fromEntries(Array.from({ length: 10 }, (_, d) => [String(d), `digit${d}`]))

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
    ...MOTION_KEYS, ...DIGIT_KEYS, ...OPERATOR_KEYS,
    m: { await: 'markSet' }, q: { await: 'record' }, '@': { await: 'play' }, '.': 'repeatChange',
    '<C-a>': 'increment', '<C-x>': 'decrement',
    i: 'insert', a: 'append', I: 'insertLineStart', A: 'appendLineEnd', o: 'openBelow', O: 'openAbove',
    x: 'deleteChar', '<Del>': 'deleteChar', X: 'deleteBack', D: 'deleteToEnd', C: 'changeToEnd',
    s: 'substitute', S: 'changeLines', Y: 'yankLines',
    p: 'putAfter', P: 'putBefore', J: 'join', r: { await: 'replaceChar' }, '~': 'swapCaseChar',
    u: 'undo', '<C-r>': 'redo', v: 'visual', V: 'visualLine', '"': { await: 'register' }, '<Esc>': 'normal',
  })
  const operator = Object.freeze({
    ...MOTION_KEYS, ...DIGIT_KEYS, ...OPERATOR_KEYS, ...OBJECT_KEYS,
    // `guu`, `gUU`, `g~~`: the operator's last key doubled is its line.
    u: 'lowercase', U: 'uppercase', '~': 'swapCase',
    '<Esc>': 'normal',
  })
  const visual = Object.freeze({
    ...MOTION_KEYS, ...DIGIT_KEYS, ...OPERATOR_KEYS, ...OBJECT_KEYS,
    x: 'delete', '<Del>': 'delete', s: 'change', u: 'lowercase', U: 'uppercase', '~': 'swapCase',
    D: 'deleteLines', X: 'deleteLines', C: 'changeLines', S: 'changeLines', R: 'changeLines', Y: 'yankLines',
    p: 'putAfter', P: 'putBefore', J: 'join', r: { await: 'replaceChar' },
    o: 'swapEnds', v: 'visual', V: 'visualLine', '"': { await: 'register' }, '<Esc>': 'normal',
  })
  const insert = Object.freeze({ ...INSERT, '<Up>': 'up', '<Down>': 'down' })
  return Object.freeze({ normal, insert, operator, visual, visualLine: visual })
})()

/**
 * Host rule: step this table in place of `VIM.normal` while `state.recording`
 * is set. It is `VIM.normal` with `q` as the stop. `q` in `VIM.normal` waits for a register
 * name, so a host stepping it while recording would swallow the key after the
 * stop.
 */
export const RECORDING = Object.freeze({ ...VIM.normal, q: 'recordStop' })

const MODES = new Set(['normal', 'insert', 'operator', 'visual', 'visualLine'])
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
  return Object.freeze(apply(state, action, arg, null).state)
}

// One action over the string. `group` is set while a replay runs, so the
// whole loop is one undo step: only its first change keeps a snapshot. The
// loop is this host's answer to `request: 'replay'`; every host writes it.
function apply(state, action, arg, group) {
  const out = editDoc(state, action, arg, stringDoc(state.text))

  const keep = out.step && !group?.began
  if (out.step && group) group.began = true
  const kept = keep ? checkpoint(state) : state
  let text = kept.text
  for (const e of out.edits) text = text.slice(0, e.from) + e.insert + text.slice(e.to)
  let s = { ...out.state, text, undo: kept.undo }
  if (out.request === 'undo' || out.request === 'redo') {
    const back = travel(s, out.request === 'undo' ? 'past' : 'future', out.request === 'undo' ? 'future' : 'past')
    s = { ...s, ...back, anchor: back.cursor ?? s.anchor }
    if (s.mode === 'normal') s = { ...s, ...rest(s, reader(stringDoc(s.text))) }
  }
  if (out.request !== 'replay') return { state: s, failed: out.failed }
  const shared = group ?? { began: false }
  for (const [name, input] of out.actions) {
    const step = apply(s, name, input, shared)
    s = step.state
    if (step.failed) return { state: s, failed: true }
  }
  return { state: s, failed: false }
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
  s.n = s.opCount || s.count ? Math.min((s.opCount ?? 1) * (s.count ?? 1), MAX_COUNT) : undefined
  // `0` with no count pending is the motion; recorded as the motion, so a
  // replay with a new count cannot mistake it for a digit.
  const act = action === 'digit0' && !s.count && s.mode !== 'insert' ? 'lineStart' : action
  const out = action === 'replayEnd' ? {} : dispatch(s, r, act, arg)
  const after = out.edit ? overlay(r, out.edit) : r
  const mode = out.mode ?? s.mode
  const cursor = out.cursor ?? s.cursor
  // Outside visual a selection lasts until the cursor moves.
  const anchor = 'anchor' in out ? out.anchor
    : isVisual(mode) && isVisual(s.mode) ? s.anchor
      : 'cursor' in out ? cursor : s.anchor
  let next = { cursor, anchor, mode, registers: out.registers ?? s.registers }
  if (mode === 'operator') {
    next.operator = out.operator ?? s.operator
    const opCount = 'opCount' in out ? out.opCount : s.opCount
    if (opCount) next.opCount = opCount
  }
  if (out.count) next.count = out.count
  if (out.named ?? (mode === 'operator' && s.named)) next.named = out.named ?? s.named
  const column = 'column' in out ? out.column : undefined
  if (column !== undefined) next.column = column
  if (out.find ?? s.find) next.find = out.find ?? s.find
  if (s.indent !== undefined) next.indent = s.indent
  if (mode === 'normal' || mode === 'operator') next = { ...next, ...rest(next, after) }
  else if (isVisual(mode)) next.cursor = onChar(after, next.cursor)

  let request = out.request ?? (out.registers?.['+'] && out.registers['+'] !== s.registers['+'] ? 'copy' : undefined)
  let actions
  let failed = out.failed === true
  if (request === 'replay') {
    if ((s.replaying ?? 0) >= MAX_DEPTH) [request, failed] = [undefined, true]
    else actions = Object.freeze([...out.actions, Object.freeze(['replayEnd'])])
  }
  remember(s, next, { action: act, arg, out, edited: Boolean(out.edit), depth: request === 'replay' ? (s.replaying ?? 0) + 1 : undefined, failed, end: action === 'replayEnd', r })
  return Object.freeze({
    state: Object.freeze(next),
    edits: Object.freeze(out.edit ? [Object.freeze(out.edit)] : []),
    request,
    actions,
    failed,
    step: s.mode !== 'insert' && (Boolean(out.edit) || (mode === 'insert' && s.mode !== 'insert')),
  })
}

// ─── What the state remembers beside the cursor ──────────────────────────
//
// `marks`, `macros`, `lastMacro`, `recording`, `last` (the last change as an
// action list), `cmd` (the command under way) and `replaying` (how many
// replays deep the host's loop is) ride in the state and are copied forward
// here. A replay never records: the host feeds its actions back through
// editDoc, and `replaying` is what tells them from keys a person pressed.

const MAX_COUNT = 9999
const MAX_DEPTH = 100
const COUNT_DIGIT = /^digit\d$/
const REGISTER_NAME = /^[a-z]$/

const entry = (action, arg) => Object.freeze(arg === undefined ? [action] : [action, arg])
function push(list, action, arg) {
  const last = list[list.length - 1]
  const merged = action === 'type' && last?.[0] === 'type' ? [...list.slice(0, -1), entry('type', last[1] + arg)] : [...list, entry(action, arg)]
  return Object.freeze(merged)
}

function remember(s, next, { action, arg, out, edited, depth, failed, end, r }) {
  for (const k of ['macros', 'lastMacro', 'recording', 'last', 'indent']) if (s[k] !== undefined) next[k] = s[k]
  if (s.marks) next.marks = edited && out.marks === undefined ? shift(s.marks, out.edit, r, out.lineSpan) : s.marks
  if (out.marks) next.marks = out.marks
  if (out.lastMacro) next.lastMacro = out.lastMacro

  if (end) {
    if (s.replaying > 1) next.replaying = s.replaying - 1
    if (s.cmd) next.cmd = s.cmd
    return
  }
  if (depth) next.replaying = depth
  else if (s.replaying && !failed) next.replaying = s.replaying

  // A replay's changes set `last` and are not recorded into a register, which
  // took the keys a person pressed.
  if (!s.replaying) {
    if (action === 'recordStop' && s.recording) {
      next.macros = Object.freeze({ ...s.macros, [s.recording.name]: s.recording.actions })
      delete next.recording
    } else if (s.recording) {
      next.recording = Object.freeze({ name: s.recording.name, actions: push(s.recording.actions, action, arg) })
    }
    if (out.recording) next.recording = out.recording
  }

  // A command is every action from the first key out of NORMAL until the mode
  // is NORMAL again with no count or register pending; one that edited, or
  // entered INSERT, is what `.` repeats. A visual one repeats as the operator
  // over a region the size of the one it had (`:help visual-repeat`), so its
  // actions from the first operator on follow a `reselect` of that size.
  if (!s.cmd && s.mode === 'insert') return
  const actions = push(s.cmd?.actions ?? [], action, arg)
  const dirty = s.cmd?.dirty || edited || (next.mode === 'insert' && s.mode !== 'insert')
  const visual = s.cmd?.visual || isVisual(s.mode) || isVisual(next.mode)
  const operating = isVisual(s.mode) && (!isVisual(next.mode) || action === 'register')
  const region = s.cmd?.region ?? (operating ? regionOf(s, r) : undefined)
  const from = s.cmd?.from ?? (operating ? actions.length - 1 : undefined)
  if (next.mode === 'normal' && !next.count && action !== 'register') {
    if (dirty && !failed) {
      if (!visual) next.last = Object.freeze({ actions })
      else if (region) next.last = Object.freeze({ actions: Object.freeze([entry('reselect', region), ...actions.slice(from)]) })
    }
  } else next.cmd = Object.freeze({ actions, dirty, visual, region, from })
}

// The size of the selection `s` holds: whole lines, the characters of one
// line, or several lines ending at the same column.
function regionOf(s, r) {
  const lo = Math.min(s.anchor, s.cursor)
  const hi = Math.max(s.anchor, s.cursor)
  const lines = r.lineOf(hi) - r.lineOf(lo) + 1
  if (s.mode === 'visualLine') return Object.freeze({ mode: 'visualLine', lines })
  if (lines > 1) return Object.freeze({ mode: 'visual', lines, col: hi - r.lineStartAt(hi) })
  let width = 0
  for (let i = lo; i <= hi && i < r.length; i = next(r, i)) width++
  return Object.freeze({ mode: 'visual', lines, width: Math.max(width, 1) })
}

// Visual mode over a region the size `regionOf` measured, from the cursor.
function reselect(s, r, spec) {
  if (!spec || typeof spec !== 'object') return { failed: true }
  const end = Math.min(r.lineOf(s.cursor) + spec.lines - 1, r.lineCount - 1)
  if (spec.mode === 'visualLine') return { mode: 'visualLine', anchor: s.cursor, cursor: r.lineStart(end) }
  if (spec.lines > 1) return { mode: 'visual', anchor: s.cursor, cursor: Math.min(r.lineStart(end) + spec.col, r.lineEnd(end)) }
  let at = s.cursor
  for (let i = 1; i < spec.width && next(r, at) < r.lineEndAt(at); i++) at = next(r, at)
  return { mode: 'visual', anchor: s.cursor, cursor: at }
}

// ─── Marks ────────────────────────────────────────────────────────────────

const newlines = (text) => text.split('\n').length - 1

// Where a mark at `rel` inside `removed` lands in `insert` when both hold the
// same number of lines: the same line and column, clamped to the new line.
function within(removed, insert, rel) {
  const k = newlines(removed.slice(0, rel))
  const old = removed.split('\n')
  const fresh = insert.split('\n')
  const before = (parts, n) => parts.slice(0, n).reduce((at, line) => at + line.length + 1, 0)
  return before(fresh, k) + Math.min(rel - before(old, k), fresh[k].length)
}

// `span` is the lines an operator deleted, `{ from, to }`, when the caller
// knows them; a host that has only the edit and the document guesses from the
// edit, and cannot tell a deleted empty line from a joined one.
function shift(marks, { from, to, insert }, r, span) {
  const removed = from < to ? r.slice(from, to) : ''
  const sameLines = insert !== '' && newlines(removed) === newlines(insert)
  const out = {}
  for (const [name, at] of Object.entries(marks)) {
    if (goneWith(at, { from, to, insert }, r, span)) continue
    if (at < from) out[name] = at
    else if (at < to) out[name] = sameLines ? from + within(removed, insert, at - from) : from
    else out[name] = at + insert.length - (to - from)
  }
  return Object.freeze(out)
}

// With no `span`, only a non-empty line can be known deleted: removing an
// empty line's newline is also what joining it to the next line removes.
function goneWith(at, { from, to, insert }, r, span) {
  if (insert !== '') return false
  if (span) return r.lineCount > 1 && at >= span.from && at <= span.to
  const ls = r.lineStartAt(at)
  const le = r.lineEndAt(at)
  return le > ls && ls >= from && le <= to && (to > le || from < ls)
}

/**
 * `state` after `edit` (`{ from, to, insert }`, offsets in `doc`, the document
 * BEFORE the edit): every mark moved as vim moves it. A host calls this for
 * each edit it applies that did not come from `editDoc`, which shifts its own.
 * An insert at a mark pushes it right; a delete over it leaves it at the
 * deletion's start; a delete of a non-empty mark's whole line deletes the mark;
 * a replacement with as many lines as it removed keeps a mark inside it on its
 * line and column. An empty line is not known deleted from the edit alone, so
 * its mark stays and lands where the line was.
 */
export function shiftMarks(state, edit, doc) {
  if (!edit || !Number.isInteger(edit.from) || !Number.isInteger(edit.to) || typeof edit.insert !== 'string') {
    refuse('shiftMarks', edit, 'an edit is { from, to, insert }')
  }
  checkDoc(doc, 'shiftMarks')
  if (!state?.marks) return state
  return Object.freeze({ ...state, marks: shift(state.marks, edit, reader(doc)) })
}

function checkPlace(fn, { cursor, anchor, mode = 'insert' }) {
  if (!MODES.has(mode)) refuse(fn, mode, `the mode is one of ${[...MODES].join(', ')}`)
  for (const [name, at] of [['cursor', cursor], ['anchor', anchor]]) {
    if (at !== undefined && !Number.isInteger(at)) refuse(fn, at, `the ${name} is an offset into the text`)
  }
}

function checkDoc(doc, fn = 'editDoc') {
  const ok = doc && Number.isInteger(doc.length) && Number.isInteger(doc.lineCount)
    && typeof doc.slice === 'function' && typeof doc.lineStart === 'function' && typeof doc.positionAt === 'function'
  if (!ok) refuse(fn, typeof doc, 'the document has length, lineCount, slice, lineStart and positionAt')
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
  if (COUNT_DIGIT.test(action)) {
    if (s.mode === 'insert') return {}
    return { count: Math.min((s.count ?? 0) * 10 + Number(action.slice(5)), MAX_COUNT) }
  }
  if (s.mode === 'operator') {
    if (OPERATORS.has(action)) {
      if (action !== s.operator) return { mode: 'normal' }
      return operate(s, r, action, { ...lines(r, s.cursor, lastLine(r, s)), lo: s.cursor })
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
  if (OPERATORS.has(action)) return s.mode === 'normal' ? { mode: 'operator', operator: action, named: s.named, opCount: s.count } : {}
  if (Object.hasOwn(ACTIONS, action)) return ACTIONS[action](s, r, arg)
  return {}
}

// ─── Motions ──────────────────────────────────────────────────────────────
//
// Each `to` answers where the motion lands from `s`, or null where it fails;
// `kind` is vim's: exclusive, inclusive or linewise, what an operator takes.

const columnOf = (s, r) => s.column ?? s.cursor - r.lineStartAt(s.cursor)

// `3fx` is the third `x`; a till steps off it, so repeating `t` from the
// character before a match would find the same one again.
function finder(how) {
  const base = how === 'f' || how === 't' ? 'f' : 'F'
  return {
    kind: how === 'f' || how === 't' ? 'inclusive' : 'exclusive',
    to: (s, r, ch) => find(r, s.cursor, how, ch),
    count(s, r, ch, n) {
      let at = s.cursor
      for (let i = 0; i < (n ?? 1) && at !== null; i++) at = find(r, at, base, ch)
      return at === null || how === 'f' || how === 'F' ? at : how === 't' ? prev(r, at) : next(r, at)
    },
  }
}

const MARK_NAME = /^[a-z]$/
const markAt = (s, r, ch) => (MARK_NAME.test(ch) && s.marks?.[ch] !== undefined ? Math.min(s.marks[ch], r.length) : null)
const lineNumber = (r, n) => r.lineStart(Math.min(n, r.lineCount) - 1)
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
  up: { kind: 'linewise', to: (s, r) => vertical(r, s.cursor, -1, columnOf(s, r)) },
  down: { kind: 'linewise', to: (s, r) => vertical(r, s.cursor, 1, columnOf(s, r)) },
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
  top: { kind: 'linewise', to: (s, r) => firstNonBlank(r, 0), count: (s, r, ch, n) => firstNonBlank(r, n === undefined ? 0 : lineNumber(r, n)) },
  bottom: {
    kind: 'linewise',
    to: (s, r) => firstNonBlank(r, r.lineStart(r.lineCount - 1)),
    count: (s, r, ch, n) => firstNonBlank(r, n === undefined ? r.lineStart(r.lineCount - 1) : lineNumber(r, n)),
  },
  markJump: { kind: 'exclusive', to: (s, r, ch) => markAt(s, r, ch) },
  markLine: { kind: 'linewise', to: (s, r, ch) => (markAt(s, r, ch) === null ? null : firstNonBlank(r, markAt(s, r, ch))) },
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

// Where `action` lands after `s.n` repetitions, or null where the first fails.
// A repetition that fails after the first stops there, as `5j` on the third
// line from the end does; one that stands still ends the loop.
function reach(s, r, action, arg) {
  const m = MOTIONS[action]
  if (m.count) return m.count(s, r, arg, s.n)
  const column = action === 'up' || action === 'down' ? columnOf(s, r) : s.column
  let at = s.cursor
  for (let i = 0; i < (s.n ?? 1); i++) {
    const to = m.to({ ...s, cursor: at, column }, r, arg)
    if (to === null) return i === 0 ? null : at
    if (to === at) break
    at = to
  }
  return at
}

function runMotion(s, r, action, arg) {
  const at = reach(s, r, action, arg)
  const out = { find: findMemory(s, action, arg) }
  if (at === null) return { ...out, failed: true }
  out.cursor = at
  if (action === 'up' || action === 'down') out.column = columnOf(s, r)
  else if (action === 'lineEnd' && s.mode !== 'insert') out.column = Infinity
  return out
}

// What a motion covers for an operator: `{ from, to, linewise, lo }`, `to`
// exclusive, `lo` where a yank leaves the cursor; null where it fails.
function motionRange(s, r, action, arg) {
  const m = MOTIONS[action]
  const at = reach(s, r, action, arg)
  if (at === null) return null
  const kind = typeof m.kind === 'function' ? m.kind(s) : m.kind
  const from = Math.min(s.cursor, at)
  let to = Math.max(s.cursor, at)
  if (kind === 'linewise') return { ...lines(r, from, to), lo: from }
  if (kind === 'inclusive') return { from, to: next(r, to), linewise: false, lo: from }

  if (action === 'wordForward' || action === 'bigWordForward') {
    // The last word moved over starts at `last`: `cw` on a word changes to
    // its end, the space after it kept, and a last word at a line's end ends
    // the range there, not at the next line's first word.
    const last = s.n > 1 ? reach({ ...s, n: s.n - 1 }, r, action) : s.cursor
    if (s.operator === 'change' && !isSpaceAt(r, s.cursor)) return { from, to: runEnd(r, last, action === 'bigWordForward'), linewise: false, lo: from }
    to = Math.min(to, Math.max(from, r.lineEndAt(last)))
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

// The start of the line `s.n - 1` below the cursor's, or the last line.
const lastLine = (r, s) => r.lineStart(Math.min(r.lineOf(s.cursor) + (s.n ?? 1) - 1, r.lineCount - 1))

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
  if (!range) return { mode: 'normal', failed: true }
  const { from, to, linewise } = range
  const lo = range.lo ?? from
  const text = r.slice(from, to)
  switch (op) {
    case 'yank':
      return { mode: 'normal', cursor: lo, registers: store(s, text, linewise, 'yank') }
    case 'delete':
      if (linewise) return { ...removeLines(r, from, to), mode: 'normal', registers: store(s, text, true, 'delete'), lineSpan: { from, to } }
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
  const { text: held, linewise } = read(s)
  if (!held && !linewise) return { failed: true }
  const n = s.n ?? 1
  const text = linewise ? Array(n).fill(held).join('\n') : held.repeat(n)
  const cur = s.cursor
  if (linewise) {
    // Below goes in at the next line's start, so the edit begins on the new line:
    // a host that redoes to the edit's start lands there. The last line has no
    // next line to start at.
    const end = r.lineEndAt(cur)
    const below = after && end < r.length
    const at = below ? end + 1 : after ? end : r.lineStartAt(cur)
    const edit = { from: at, to: at, insert: after && !below ? '\n' + text : text + '\n' }
    return { edit, cursor: firstNonBlank(overlay(r, edit), after && !below ? at + 1 : at) }
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
  register: (s, r, ch) => (NAMES.test(ch) ? { named: ch, count: s.count } : {}),
}

// ─── The actions ──────────────────────────────────────────────────────────

const op = (name, rangeOf) => (s, r) => operate(s, r, name, rangeOf(s, r))
// `s.n` graphemes on the cursor's line, forward or back; fewer where the line ends.
function charRange(s, r) {
  const le = r.lineEndAt(s.cursor)
  let to = s.cursor
  for (let i = 0; i < (s.n ?? 1) && to < le; i++) to = next(r, to)
  return { from: s.cursor, to: Math.min(to, le), linewise: false }
}
function backRange(s, r) {
  const ls = r.lineStartAt(s.cursor)
  let from = s.cursor
  for (let i = 0; i < (s.n ?? 1) && from > ls; i++) from = prev(r, from)
  return { from, to: s.cursor, linewise: false }
}
const toEnd = (s, r) => ({ from: s.cursor, to: r.lineEndAt(lastLine(r, s)), linewise: false })
const lineRange = (s, r) => ({ ...lines(r, s.cursor, lastLine(r, s)), lo: s.cursor })

// `<C-a>` and `<C-x>`: the number at or after the cursor on its line, in
// decimal, hex or binary; a decimal's `-` is its sign, and zeros that led it stay.
const NUMBER = /0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9]+/g
const WRAP = 1n << 64n
function bump(s, r, sign) {
  const ls = r.lineStartAt(s.cursor)
  const line = r.slice(ls, r.lineEndAt(s.cursor))
  const col = s.cursor - ls
  for (const m of line.matchAll(NUMBER)) {
    const [text] = m
    if (m.index + text.length <= col) continue
    const delta = BigInt(sign * (s.n ?? 1))
    const radix = /^0[xX]/.test(text) ? 16 : /^0[bB]/.test(text) ? 2 : 10
    let [start, insert] = [m.index, '']
    if (radix === 10) {
      const negative = m.index > 0 && line[m.index - 1] === '-'
      if (negative) start -= 1
      const v = (negative ? -BigInt(text) : BigInt(text)) + delta
      const digits = (v < 0n ? -v : v).toString().padStart(text.length > 1 && text[0] === '0' ? text.length : 0, '0')
      insert = (v < 0n ? '-' : '') + digits
    } else {
      const body = text.slice(2)
      const v = (((BigInt(text) + delta) % WRAP) + WRAP) % WRAP
      const digits = v.toString(radix).padStart(body.length, '0')
      insert = text.slice(0, 2) + (/[A-F]/.test(body) && !/[a-f]/.test(body) ? digits.toUpperCase() : digits)
    }
    const edit = { from: ls + start, to: ls + m.index + text.length, insert }
    return { edit, cursor: edit.from + insert.length - 1 }
  }
  return { failed: true }
}

// `q` and `@` take a register name; `@@` is the macro played last.
function play(s, name) {
  const which = name === '@' ? s.lastMacro : name
  const actions = which && REGISTER_NAME.test(which) ? s.macros?.[which] : undefined
  if (!actions?.length) return { failed: true }
  return { request: 'replay', actions: Array.from({ length: s.n ?? 1 }, () => actions).flat(), lastMacro: which }
}

// `3.` replaces the count the change had; none given repeats it as it was.
function repeatLast(s) {
  if (!s.last) return { failed: true }
  const kept = s.n === undefined ? s.last.actions : s.last.actions.filter(([a]) => !COUNT_DIGIT.test(a))
  const count = s.n === undefined ? [] : Array.from(String(s.n), (d) => entry(`digit${d}`))
  return { request: 'replay', actions: [...count, ...kept] }
}

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
  register: (s, r, ch) => (NAMES.test(ch) ? { named: ch, count: s.count } : {}),
  markSet: (s, r, ch) => (MARK_NAME.test(ch) ? { marks: Object.freeze({ ...s.marks, [ch]: s.cursor }) } : { failed: true }),
  record: (s, r, ch) => {
    if (!/^[a-zA-Z]$/.test(ch) || s.recording) return { failed: true }
    const name = ch.toLowerCase()
    return { recording: Object.freeze({ name, actions: ch === name ? Object.freeze([]) : (s.macros?.[name] ?? Object.freeze([])) }) }
  },
  recordStop: () => ({}),
  play: (s, r, ch) => play(s, ch),
  repeatChange: (s) => repeatLast(s),
  increment: (s, r) => bump(s, r, 1),
  decrement: (s, r) => bump(s, r, -1),
  replayEnd: () => ({}),
  reselect: (s, r, spec) => reselect(s, r, spec),

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
  // `3J` joins three lines, and a count past the last line joins to it.
  join: (s, r) => {
    const le = r.lineEndAt(s.cursor)
    if (le >= r.length) return { failed: true }
    const line = Math.min(r.lineOf(s.cursor) + Math.max(s.n ?? 1, 2) - 1, r.lineCount - 1)
    return join(r, s.cursor, r.lineStart(line))
  },
  // `3rx` replaces three characters or none.
  replaceChar: (s, r, ch) => {
    const range = charRange(s, r)
    const have = mapGraphemes(r.slice(range.from, r.lineEndAt(s.cursor)), () => '.').length
    return range.from >= range.to || (s.n ?? 1) > have ? { failed: true } : replaceEach(r, range, ch)
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

const KNOWN = new Set([...Object.keys(DIGIT_KEYS).map((d) => `digit${d}`), ...Object.keys(MOTIONS), ...OPERATORS, ...Object.keys(OBJECTS), ...Object.keys(VISUAL), ...Object.keys(ACTIONS)])
const AWAITS = new Set(['findForward', 'findBack', 'tillForward', 'tillBack', 'replaceChar', 'register', 'markSet', 'markJump', 'markLine', 'record', 'play'])

// A row naming an action the box lacks is a key that does nothing, so it
// fails the import rather than the press.
for (const table of [NORMAL, INSERT, RECORDING, ...Object.values(VIM)]) {
  for (const [keys, value] of Object.entries(table)) {
    const action = typeof value === 'string' ? value : value.await
    if (!KNOWN.has(action)) refuse('textbox', keys, `'${action}' is no action of the box`)
  }
}
