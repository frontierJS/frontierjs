/*
 * textbox.js — text edited by vim's keys: the reducer over a document, the
 * string host a text control uses, and the two tables that bind them
 * (`IDEAS/keys.md` Phase 4, `FJS-D1387`, `FJS-D2085`).
 *
 * The reference is khat's `src/app/input.rs`, cut to L1: the motions and edits
 * a one-line box needs, flat rows with no operator grammar. `dd` and `dw` are
 * rows of their own, as khat's table writes them; `d` followed by a motion is
 * L2 and is not read here.
 *
 * Two layers. `editDoc(state, action, arg, doc)` is the reducer: its state is
 * `{ cursor, anchor, mode, register }`, it reads the text only through `doc`'s
 * `{ length, lineCount, slice, lineStart, positionAt }`, and it answers the
 * edits to make rather than a new text, so an editor over a piece table keeps
 * its own buffer and its own undo. `textbox()` and `edit()` are the string
 * host: they hold `{ text, undo }` beside that state, apply the edits to the
 * string, and keep undo as snapshots of it.
 *
 * `cursor` and `anchor` are UTF-16 offsets, the unit a `<textarea>`'s
 * `selectionStart` counts in, so a host mirrors them as they are; a character
 * `h`, `l` or `x` steps over is a grapheme, so an emoji or a letter with its
 * accent moves and deletes whole.
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
 *
 *   const out = editDoc({ cursor: 0, mode: 'normal' }, 'deleteWord', undefined, buffer)
 *   // out.edits = [{ from: 0, to: 5, insert: '' }], applied by the editor
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
  const s = { text, cursor: at, anchor: clamp(anchor ?? at, text.length), mode, register: EMPTY, undo: NO_UNDO }
  return Object.freeze(mode === 'normal' ? { ...s, ...rest(s, reader(stringDoc(text))) } : s)
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
  if (action === 'sync') return sync(state, arg)
  const out = editDoc(state, action, arg, stringDoc(state.text))

  let s = out.step ? checkpoint(state) : state
  let text = s.text
  for (const e of out.edits) text = text.slice(0, e.from) + e.insert + text.slice(e.to)
  s = { ...s, ...out.state, text }
  if (out.request) {
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
 * step }`: the next `{ cursor, anchor, mode, register }` with offsets in the
 * text after `edits`; `edits` as `[{ from, to, insert }]` in the text before
 * them; `request` as `'undo'` or `'redo'` when the key asks the host to
 * travel its own history; and `step` true when an undo step begins before
 * these edits — a change in NORMAL, or entering INSERT, which makes what is
 * typed there one step.
 *
 * `doc` is read and never written. `sync` is the string host's and is
 * refused here: an editor applies its own typing.
 */
export function editDoc(state, action, arg, doc) {
  if (!state || !Number.isInteger(state.cursor)) refuse('editDoc', state, 'a state with a cursor is required')
  checkPlace('editDoc', { cursor: state.cursor, anchor: state.anchor, mode: state.mode })
  checkDoc(doc)
  const fn = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null
  if (!fn) refuse('edit', action, `the box has no such action; it knows ${[...Object.keys(ACTIONS), 'sync'].join(', ')}`)
  if (action === 'type' && typeof arg !== 'string') refuse('edit', arg, "'type' takes the text it types")

  const r = reader(doc)
  const s = {
    cursor: clamp(state.cursor, r.length),
    anchor: clamp(state.anchor ?? state.cursor, r.length),
    mode: state.mode ?? 'insert',
    register: state.register ?? EMPTY,
  }
  const out = fn(s, r, arg)
  const after = out.edit ? overlay(r, out.edit) : r
  // A selection lasts until the cursor moves; whatever moves it collapses it.
  const anchor = 'anchor' in out ? out.anchor : 'cursor' in out ? out.cursor : s.anchor
  let next = { ...s, cursor: out.cursor ?? s.cursor, anchor, mode: out.mode ?? s.mode, register: out.register ?? s.register }
  if (ENTERS.has(action)) next.mode = 'insert'
  if (next.mode === 'normal') next = { ...next, ...rest(next, after) }
  return Object.freeze({
    state: Object.freeze(next),
    edits: Object.freeze(out.edit ? [Object.freeze(out.edit)] : []),
    request: out.request,
    step: s.mode === 'normal' && (CHANGES.has(action) || ENTERS.has(action)),
  })
}

function checkPlace(fn, { cursor, anchor, mode = 'insert' }) {
  if (mode !== 'normal' && mode !== 'insert') refuse(fn, mode, "the mode is 'normal' or 'insert'")
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

// ─── Where things are ─────────────────────────────────────────────────────

// Every read below goes through one of these, so the reducer never holds more
// of the text than the line or window it is looking at.
function reader(doc) {
  return {
    get length() { return doc.length },
    slice: (from, to) => doc.slice(from, to),
    lineStartAt: (i) => doc.lineStart(doc.positionAt(i).line),
    lineEndAt(i) {
      const { line } = doc.positionAt(i)
      return line + 1 < doc.lineCount ? doc.lineStart(line + 1) - 1 : doc.length
    },
  }
}

// The text after one edit, read without making it, so the cursor can be
// placed where the edit leaves it.
function overlay(r, { from, to, insert }) {
  const delta = insert.length - (to - from)
  const insEnd = from + insert.length
  return {
    get length() { return r.length + delta },
    slice(a, b) {
      let out = ''
      if (a < from) out += r.slice(a, Math.min(b, from))
      if (b > from && a < insEnd) out += insert.slice(Math.max(a, from) - from, Math.min(b, insEnd) - from)
      if (b > insEnd) out += r.slice(Math.max(a, insEnd) - delta, b - delta)
      return out
    },
    lineStartAt(i) {
      if (i <= from) return r.lineStartAt(i)
      if (i > insEnd) {
        const ls = r.lineStartAt(i - delta)
        if (ls > to) return ls + delta
      }
      const k = insert.lastIndexOf('\n', Math.min(i, insEnd) - from - 1)
      return k >= 0 ? from + k + 1 : r.lineStartAt(from)
    },
    lineEndAt(i) {
      if (i >= insEnd) return r.lineEndAt(i - delta) + delta
      if (i < from) {
        const le = r.lineEndAt(i)
        if (le < from) return le
      }
      const k = insert.indexOf('\n', Math.max(i, from) - from)
      return k >= 0 ? from + k : r.lineEndAt(to) + delta
    },
  }
}

const charAt = (r, i) => r.slice(i, i + 1)
const codePointAt = (r, i) => r.slice(i, i + 2).codePointAt(0)

function firstNonBlank(r, i) {
  const le = r.lineEndAt(i)
  let j = r.lineStartAt(i)
  while (j < le && (charAt(r, j) === ' ' || charAt(r, j) === '\t')) j++
  return j
}

// A character is a grapheme: an emoji with its modifiers, a letter with its
// accent. A newline is one on its own, since the string host reads CRLF as LF.
const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' })
const WINDOW = 64

// A line can be megabytes, so a window around `i` is segmented and widened
// only when the answer touched a cut edge, where a boundary is the cut's and
// not the text's. The segments are walked rather than asked with
// `containing()`, which in Bun answers the segment before a boundary merged
// with the one after it: `containing(1)` of 'a🇳🇴' is 'a🇳🇴' at 0, where node
// says '🇳🇴' at 1. A run of flags longer than the window can still pair
// differently from the whole line, since a flag's partner depends on the
// count of flags before it.
function graphemeAt(r, i) {
  if (charAt(r, i) === '\n') return { start: i, end: i + 1 }
  const ls = r.lineStartAt(i)
  const le = r.lineEndAt(i)
  for (let w = WINDOW; ; w *= 4) {
    const a = Math.max(ls, i - w)
    const b = Math.min(le, i + w)
    for (const g of GRAPHEMES.segment(r.slice(a, b))) {
      const start = a + g.index
      const end = start + g.segment.length
      if (end <= i) continue
      if ((start > a || a === ls) && (end < b || b === le)) return { start, end }
      break
    }
    if (a === ls && b === le) return { start: i, end: i + 1 }
  }
}
const next = (r, i) => (i >= r.length ? r.length : graphemeAt(r, i).end)
const prev = (r, i) => (i <= 0 ? 0 : graphemeAt(r, i - 1).start)
const snap = (r, i) => (i >= r.length ? i : graphemeAt(r, i).start)

// khat's three classes: space, a word's characters, and punctuation, each run
// of one class a word. Read a code point at a time, so a surrogate pair is
// one character of its class.
const WORD = /[\p{L}\p{N}\p{M}_]/u
function kind(r, i) {
  const c = String.fromCodePoint(codePointAt(r, i))
  return /\s/u.test(c) ? 'space' : WORD.test(c) ? 'word' : 'punct'
}
const step = (r, i) => i + (codePointAt(r, i) > 0xffff ? 2 : 1)
const back = (r, i) => i - (i >= 2 && codePointAt(r, i - 2) > 0xffff ? 2 : 1)

function wordForward(r, i) {
  const len = r.length
  if (i < len && kind(r, i) !== 'space') {
    const k = kind(r, i)
    while (i < len && kind(r, i) === k) i = step(r, i)
  }
  while (i < len && kind(r, i) === 'space') i = step(r, i)
  return i
}

function wordBack(r, i) {
  while (i > 0 && kind(r, back(r, i)) === 'space') i = back(r, i)
  if (i > 0) {
    const k = kind(r, back(r, i))
    while (i > 0 && kind(r, back(r, i)) === k) i = back(r, i)
  }
  return i
}

// The last character of the next word's end after `i`.
function wordEnd(r, i) {
  const len = r.length
  if (!len) return 0
  const last = prev(r, len)
  i = next(r, i)
  while (i < len && kind(r, i) === 'space') i = step(r, i)
  if (i >= len) return last
  const k = kind(r, i)
  while (step(r, i) < len && kind(r, step(r, i)) === k) i = step(r, i)
  return snap(r, i)
}

// In NORMAL the cursor rests on a character, never past a line's last one,
// and a selection is the cursor alone.
function rest(s, r) {
  const cur = clamp(s.cursor, r.length)
  const ls = r.lineStartAt(cur)
  const le = r.lineEndAt(cur)
  const cursor = cur >= le && le > ls ? prev(r, le) : snap(r, cur)
  return { cursor, anchor: cursor }
}

// ─── What changes the text ────────────────────────────────────────────────

// The selection a typed key replaces, `[from, to)`.
function selection(s) {
  return [Math.min(s.anchor, s.cursor), Math.max(s.anchor, s.cursor)]
}

function replace(s, put) {
  const [from, to] = selection(s)
  put = lf(put)
  return { edit: { from, to, insert: put }, cursor: from + put.length }
}

function remove(s, r, from, to, linewise = false) {
  if (from >= to) return {}
  return {
    edit: { from, to, insert: '' },
    cursor: from,
    register: Object.freeze({ text: r.slice(from, to), linewise }),
  }
}

function put(s, r, after) {
  const { text, linewise } = s.register
  if (!text && !linewise) return {}
  const cur = s.cursor
  if (linewise) {
    const at = after ? r.lineEndAt(cur) : r.lineStartAt(cur)
    const insert = after ? '\n' + text : text + '\n'
    return { edit: { from: at, to: at, insert }, cursor: after ? at + 1 : at }
  }
  const at = after && cur < r.lineEndAt(cur) ? next(r, cur) : cur
  const edit = { from: at, to: at, insert: text }
  return { edit, cursor: prev(overlay(r, edit), at + text.length) }
}

function deleteLine(s, r) {
  const ls = r.lineStartAt(s.cursor)
  const le = r.lineEndAt(s.cursor)
  const register = Object.freeze({ text: r.slice(ls, le), linewise: true })
  if (le < r.length) return { edit: { from: ls, to: le + 1, insert: '' }, cursor: ls, register }
  if (ls > 0) return { edit: { from: ls - 1, to: le, insert: '' }, cursor: r.lineStartAt(ls - 1), register }
  return { edit: le > 0 ? { from: 0, to: le, insert: '' } : undefined, cursor: 0, register }
}

// ─── The actions ─────────────────────────────────────────────────────────

const ACTIONS = {
  left: (s, r) => {
    const floor = s.mode === 'normal' ? r.lineStartAt(s.cursor) : 0
    return { cursor: s.cursor > floor ? prev(r, s.cursor) : s.cursor }
  },
  right: (s, r) => {
    if (s.mode === 'normal') {
      const le = r.lineEndAt(s.cursor)
      return { cursor: next(r, s.cursor) < le ? next(r, s.cursor) : s.cursor }
    }
    return { cursor: next(r, s.cursor) }
  },
  wordForward: (s, r) => ({ cursor: wordForward(r, s.cursor) }),
  wordBack: (s, r) => ({ cursor: wordBack(r, s.cursor) }),
  wordEnd: (s, r) => ({ cursor: wordEnd(r, s.cursor) }),
  lineStart: (s, r) => ({ cursor: r.lineStartAt(s.cursor) }),
  firstNonBlank: (s, r) => ({ cursor: firstNonBlank(r, s.cursor) }),
  lineEnd: (s, r) => ({ cursor: r.lineEndAt(s.cursor) }),

  insert: () => ({}),
  append: (s, r) => ({ cursor: s.cursor < r.lineEndAt(s.cursor) ? next(r, s.cursor) : s.cursor }),
  insertLineStart: (s, r) => ({ cursor: firstNonBlank(r, s.cursor) }),
  appendLineEnd: (s, r) => ({ cursor: r.lineEndAt(s.cursor) }),
  // Esc steps back onto the last character typed, as vim's does, but never
  // off the line it is on.
  normal: (s, r) => ({
    mode: 'normal',
    cursor: s.mode === 'insert' && s.cursor > r.lineStartAt(s.cursor) ? prev(r, s.cursor) : s.cursor,
  }),

  deleteChar: (s, r) => (charAt(r, s.cursor) === '\n' ? {} : remove(s, r, s.cursor, next(r, s.cursor))),
  deleteBack: (s, r) => (s.cursor > r.lineStartAt(s.cursor) ? remove(s, r, prev(r, s.cursor), s.cursor) : {}),
  deleteToEnd: (s, r) => remove(s, r, s.cursor, r.lineEndAt(s.cursor)),
  deleteWord: (s, r) => remove(s, r, s.cursor, Math.min(wordForward(r, s.cursor), r.lineEndAt(s.cursor))),
  deleteLine,
  yankLine: (s, r) => ({ register: Object.freeze({ text: r.slice(r.lineStartAt(s.cursor), r.lineEndAt(s.cursor)), linewise: true }) }),
  putAfter: (s, r) => put(s, r, true),
  putBefore: (s, r) => put(s, r, false),

  undo: () => ({ request: 'undo' }),
  redo: () => ({ request: 'redo' }),

  type: (s, r, text) => replace(s, text),
  newline: (s) => replace(s, '\n'),
  backspace: (s, r) => {
    const [from, to] = selection(s)
    if (from < to) return replace(s, '')
    const at = prev(r, from)
    return at < from ? { edit: { from: at, to: from, insert: '' }, cursor: at } : {}
  },
  delete: (s, r) => {
    const [from, to] = selection(s)
    if (from < to) return replace(s, '')
    const end = next(r, from)
    return end > from ? { edit: { from, to: end, insert: '' }, cursor: from } : {}
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
