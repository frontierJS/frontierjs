/*
 * textbox.js — a text control edited by vim's keys: the state, the reducer,
 * and the two tables that bind it (`IDEAS/keys.md` Phase 4, `FJS-D1387`).
 *
 * The reference is khat's `src/app/input.rs`, cut to L1: the motions and edits
 * a one-line box needs, flat rows with no operator grammar. `dd` and `dw` are
 * rows of their own, as khat's table writes them; `d` followed by a motion is
 * L2 and is not read here.
 *
 * State is `{ text, cursor, anchor, mode, register, undo }`, frozen, and only
 * ever passed back in. `cursor` and `anchor` are UTF-16 offsets, the unit a
 * `<textarea>`'s `selectionStart` counts in, so a host mirrors them as they
 * are; a character `h`, `l` or `x` steps over is a grapheme, so an emoji or a
 * letter with its accent moves and deletes whole.
 *
 * The keys live in `NORMAL` and `INSERT`, plain `{ keys: action }` tables a
 * host hands to `keymap()` from `/keys`. It steps them with `text: false` in
 * both modes, as the box is the editable with its own keymap (`FJS-D1386`);
 * under `text: true` Esc would be the control's and never leave INSERT. A
 * printable no INSERT row takes is the control's to type: a `<textarea>`
 * types it and the host hands back what the control then holds with
 * `edit(state, 'sync', { text, cursor, anchor })`, and a host with no control
 * of its own calls `edit(state, 'type', key)`.
 *
 * Usage:
 *   let s = textbox('hello', { mode: 'normal', cursor: 0 })
 *   s = edit(s, 'deleteWord')   // ''
 *   s = edit(s, 'undo')         // 'hello'
 */

const LIMIT = 200

/** The keys of the box in NORMAL — khat's rows that L1 holds. */
export const NORMAL = Object.freeze({
  h: 'left', l: 'right', '<Left>': 'left', '<Right>': 'right', '<BS>': 'left',
  w: 'wordForward', b: 'wordBack', e: 'wordEnd',
  0: 'lineStart', '^': 'firstNonBlank', $: 'lineEnd', '<Home>': 'lineStart', '<End>': 'lineEnd',
  i: 'insert', a: 'append', I: 'insertLineStart', A: 'appendLineEnd',
  x: 'deleteChar', '<Del>': 'deleteChar', X: 'deleteBack', D: 'deleteToEnd',
  dd: 'deleteLine', dw: 'deleteWord', yy: 'yankLine',
  p: 'putAfter', P: 'putBefore',
  u: 'undo', '<C-r>': 'redo',
})

/** The keys of the box in INSERT; a printable no row binds types. */
export const INSERT = Object.freeze({
  '<Esc>': 'normal',
  '<BS>': 'backspace', '<Del>': 'delete', '<CR>': 'newline',
  '<Left>': 'left', '<Right>': 'right', '<Home>': 'lineStart', '<End>': 'lineEnd',
})

function refuse(fn, input, why) {
  throw new TypeError(`${fn}(${JSON.stringify(input)}): ${why}`)
}

const EMPTY = Object.freeze({ text: '', linewise: false })
const NO_UNDO = Object.freeze({ past: Object.freeze([]), future: Object.freeze([]) })

/**
 * A box holding `text`. It opens in INSERT with the cursor at the end, as a
 * field someone is about to type in does; `{ mode: 'normal' }` opens it in
 * NORMAL, where the cursor rests on a character. `anchor` is the other end of
 * a selection, and is the cursor when left out.
 */
export function textbox(text = '', { cursor, anchor, mode = 'insert' } = {}) {
  if (typeof text !== 'string') refuse('textbox', text, 'the text is a string')
  if (mode !== 'normal' && mode !== 'insert') refuse('textbox', mode, "the mode is 'normal' or 'insert'")
  for (const [name, at] of [['cursor', cursor], ['anchor', anchor]]) {
    if (at !== undefined && !Number.isInteger(at)) refuse('textbox', at, `the ${name} is an offset into the text`)
  }
  text = lf(text)
  const at = clamp(cursor ?? text.length, text)
  const s = { text, cursor: at, anchor: clamp(anchor ?? at, text), mode, register: EMPTY, undo: NO_UNDO }
  return Object.freeze(mode === 'normal' ? rest({ ...s }) : s)
}

/**
 * `action` applied to the box: a name from `NORMAL` or `INSERT`, `type` with
 * the text as `arg`, or `sync` with `{ text, cursor, anchor }`, what a control
 * the person typed or clicked in now holds. A name the box does not know is
 * refused, since the key bound to it would do nothing.
 *
 * In NORMAL a change is one undo step, and so is everything typed between
 * entering INSERT and leaving it. A `sync` that only moves the cursor is no
 * change, so a click keeps what `redo` would bring back.
 */
export function edit(state, action, arg) {
  if (!state || typeof state.text !== 'string' || !state.undo) refuse('edit', state, 'a textbox() state is required')
  const fn = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null
  if (!fn) refuse('edit', action, `the box has no such action; it knows ${Object.keys(ACTIONS).join(', ')}`)
  if (action === 'type' && typeof arg !== 'string') refuse('edit', arg, "'type' takes the text it types")
  if (action === 'sync' && (typeof arg?.text !== 'string' || !Number.isInteger(arg.cursor) || !(arg.anchor === undefined || Number.isInteger(arg.anchor)))) {
    refuse('edit', arg, "'sync' takes { text, cursor, anchor? }, what the control holds")
  }

  let s = state
  const changes = CHANGES.has(action) || (action === 'sync' && lf(arg.text) !== s.text)
  if (s.mode === 'normal' && (changes || ENTERS.has(action))) s = checkpoint(s)
  const out = fn(s, arg)
  // A selection lasts until the cursor moves; whatever moves it collapses it.
  const anchor = 'anchor' in out ? out.anchor : 'cursor' in out ? out.cursor : s.anchor
  const next = { ...s, ...out, anchor }
  if (ENTERS.has(action)) next.mode = 'insert'
  return Object.freeze(next.mode === 'normal' ? rest(next) : next)
}

// ─── Where things are ─────────────────────────────────────────────────────

const lf = (t) => t.replace(/\r\n?/g, '\n')
const clamp = (i, text) => Math.max(0, Math.min(i, text.length))

const lineStart = (t, i) => (i <= 0 ? 0 : t.lastIndexOf('\n', i - 1) + 1)
function lineEnd(t, i) {
  const j = t.indexOf('\n', i)
  return j < 0 ? t.length : j
}

function firstNonBlank(t, i) {
  const le = lineEnd(t, i)
  let j = lineStart(t, i)
  while (j < le && (t[j] === ' ' || t[j] === '\t')) j++
  return j
}

// A character is a grapheme: an emoji with its modifiers, a letter with its
// accent. CRLF is read as LF on the way in, so a newline is one on its own.
const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' })

// The segments of the line are walked rather than asked with `containing()`,
// which in Bun answers the segment before a boundary merged with the one
// after it: `containing(1)` of 'a🇳🇴' is 'a🇳🇴' at 0, where node says '🇳🇴' at 1.
function graphemeAt(t, i) {
  if (t[i] === '\n') return { start: i, end: i + 1 }
  const ls = lineStart(t, i)
  for (const g of GRAPHEMES.segment(t.slice(ls, lineEnd(t, i)))) {
    const end = ls + g.index + g.segment.length
    if (end > i) return { start: ls + g.index, end }
  }
  return { start: i, end: i + 1 }
}
const next = (t, i) => (i >= t.length ? t.length : graphemeAt(t, i).end)
const prev = (t, i) => (i <= 0 ? 0 : graphemeAt(t, i - 1).start)
const snap = (t, i) => (i >= t.length ? i : graphemeAt(t, i).start)

// khat's three classes: space, a word's characters, and punctuation, each run
// of one class a word. Read a code point at a time, so a surrogate pair is
// one character of its class.
const WORD = /[\p{L}\p{N}\p{M}_]/u
function kind(t, i) {
  const c = String.fromCodePoint(t.codePointAt(i))
  return /\s/u.test(c) ? 'space' : WORD.test(c) ? 'word' : 'punct'
}
const step = (t, i) => i + (t.codePointAt(i) > 0xffff ? 2 : 1)
const back = (t, i) => i - (i >= 2 && t.codePointAt(i - 2) > 0xffff ? 2 : 1)

function wordForward(t, i) {
  if (i < t.length && kind(t, i) !== 'space') {
    const k = kind(t, i)
    while (i < t.length && kind(t, i) === k) i = step(t, i)
  }
  while (i < t.length && kind(t, i) === 'space') i = step(t, i)
  return i
}

function wordBack(t, i) {
  while (i > 0 && kind(t, back(t, i)) === 'space') i = back(t, i)
  if (i > 0) {
    const k = kind(t, back(t, i))
    while (i > 0 && kind(t, back(t, i)) === k) i = back(t, i)
  }
  return i
}

// The last character of the next word's end after `i`.
function wordEnd(t, i) {
  if (!t.length) return 0
  const last = prev(t, t.length)
  i = next(t, i)
  while (i < t.length && kind(t, i) === 'space') i = step(t, i)
  if (i >= t.length) return last
  const k = kind(t, i)
  while (step(t, i) < t.length && kind(t, step(t, i)) === k) i = step(t, i)
  return snap(t, i)
}

// In NORMAL the cursor rests on a character, never past a line's last one,
// and a selection is the cursor alone.
function rest(s) {
  const { text } = s
  const cur = clamp(s.cursor, text)
  const ls = lineStart(text, cur)
  const le = lineEnd(text, cur)
  const cursor = cur >= le && le > ls ? prev(text, le) : snap(text, cur)
  return { ...s, cursor, anchor: cursor }
}

// ─── What changes the text ────────────────────────────────────────────────

const splice = (t, from, to, put = '') => t.slice(0, from) + put + t.slice(to)

// The selection a typed key replaces, `[from, to)`.
function selection(s) {
  const a = s.anchor ?? s.cursor
  return [Math.min(a, s.cursor), Math.max(a, s.cursor)]
}

function replace(s, put) {
  const [from, to] = selection(s)
  put = lf(put)
  return { text: splice(s.text, from, to, put), cursor: from + put.length }
}

function remove(s, from, to, linewise = false) {
  if (from >= to) return {}
  return {
    text: splice(s.text, from, to),
    cursor: from,
    register: Object.freeze({ text: s.text.slice(from, to), linewise }),
  }
}

function put(s, after) {
  const { text, linewise } = s.register
  if (!text && !linewise) return {}
  const t = s.text
  const cur = s.cursor
  if (linewise) {
    const at = after ? lineEnd(t, cur) : lineStart(t, cur)
    const ins = after ? '\n' + text : text + '\n'
    return { text: splice(t, at, at, ins), cursor: after ? at + 1 : at }
  }
  const at = after && cur < lineEnd(t, cur) ? next(t, cur) : cur
  const out = splice(t, at, at, text)
  return { text: out, cursor: prev(out, at + text.length) }
}

function deleteLine(s) {
  const t = s.text
  const ls = lineStart(t, s.cursor)
  const le = lineEnd(t, s.cursor)
  const register = Object.freeze({ text: t.slice(ls, le), linewise: true })
  if (le < t.length) return { text: splice(t, ls, le + 1), cursor: ls, register }
  if (ls > 0) return { text: splice(t, ls - 1, le), cursor: lineStart(t, ls - 1), register }
  return { text: '', cursor: 0, register }
}

// ─── Undo ────────────────────────────────────────────────────────────────

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

// ─── The actions ─────────────────────────────────────────────────────────

const ACTIONS = {
  left: (s) => {
    const floor = s.mode === 'normal' ? lineStart(s.text, s.cursor) : 0
    return { cursor: s.cursor > floor ? prev(s.text, s.cursor) : s.cursor }
  },
  right: (s) => {
    const t = s.text
    if (s.mode === 'normal') {
      const le = lineEnd(t, s.cursor)
      return { cursor: next(t, s.cursor) < le ? next(t, s.cursor) : s.cursor }
    }
    return { cursor: next(t, s.cursor) }
  },
  wordForward: (s) => ({ cursor: wordForward(s.text, s.cursor) }),
  wordBack: (s) => ({ cursor: wordBack(s.text, s.cursor) }),
  wordEnd: (s) => ({ cursor: wordEnd(s.text, s.cursor) }),
  lineStart: (s) => ({ cursor: lineStart(s.text, s.cursor) }),
  firstNonBlank: (s) => ({ cursor: firstNonBlank(s.text, s.cursor) }),
  lineEnd: (s) => ({ cursor: lineEnd(s.text, s.cursor) }),

  insert: () => ({}),
  append: (s) => ({ cursor: s.cursor < lineEnd(s.text, s.cursor) ? next(s.text, s.cursor) : s.cursor }),
  insertLineStart: (s) => ({ cursor: firstNonBlank(s.text, s.cursor) }),
  appendLineEnd: (s) => ({ cursor: lineEnd(s.text, s.cursor) }),
  // Esc steps back onto the last character typed, as vim's does, but never
  // off the line it is on.
  normal: (s) => ({
    mode: 'normal',
    cursor: s.mode === 'insert' && s.cursor > lineStart(s.text, s.cursor) ? prev(s.text, s.cursor) : s.cursor,
  }),

  deleteChar: (s) => (s.text[s.cursor] === '\n' ? {} : remove(s, s.cursor, next(s.text, s.cursor))),
  deleteBack: (s) => (s.cursor > lineStart(s.text, s.cursor) ? remove(s, prev(s.text, s.cursor), s.cursor) : {}),
  deleteToEnd: (s) => remove(s, s.cursor, lineEnd(s.text, s.cursor)),
  deleteWord: (s) => remove(s, s.cursor, Math.min(wordForward(s.text, s.cursor), lineEnd(s.text, s.cursor))),
  deleteLine,
  yankLine: (s) => {
    const ls = lineStart(s.text, s.cursor)
    return { register: Object.freeze({ text: s.text.slice(ls, lineEnd(s.text, s.cursor)), linewise: true }) }
  },
  putAfter: (s) => put(s, true),
  putBefore: (s) => put(s, false),

  undo: (s) => travel(s, 'past', 'future'),
  redo: (s) => travel(s, 'future', 'past'),

  type: (s, text) => replace(s, text),
  sync: (s, { text, cursor, anchor = cursor }) => {
    text = lf(text)
    return { text, cursor: clamp(cursor, text), anchor: clamp(anchor, text) }
  },
  newline: (s) => replace(s, '\n'),
  backspace: (s) => {
    const [from, to] = selection(s)
    return from < to ? replace(s, '') : { text: splice(s.text, prev(s.text, from), from), cursor: prev(s.text, from) }
  },
  delete: (s) => {
    const [from, to] = selection(s)
    return from < to ? replace(s, '') : { text: splice(s.text, from, next(s.text, from)), cursor: from }
  },
}

// What starts an undo step from NORMAL: a change, or entering INSERT, which
// makes what is typed there one step.
const CHANGES = new Set(['deleteChar', 'deleteBack', 'deleteToEnd', 'deleteWord', 'deleteLine', 'putAfter', 'putBefore', 'type', 'newline', 'backspace', 'delete'])
const ENTERS = new Set(['insert', 'append', 'insertLineStart', 'appendLineEnd'])

// A row naming an action the box lacks is a key that does nothing, so it
// fails the import rather than the press.
for (const [keys, action] of Object.entries({ ...NORMAL, ...INSERT })) {
  if (!ACTIONS[action]) refuse('textbox', keys, `'${action}' is no action of the box`)
}
