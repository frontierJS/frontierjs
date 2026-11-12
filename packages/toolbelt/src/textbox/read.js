/*
 * read.js — where things are in a document the vim reducer reads: the
 * reader over `{ length, lineCount, slice, lineStart, positionAt }`, the text
 * after one edit read without making it, graphemes, words, finds, brackets,
 * paragraphs and the text objects (`FJS-D2085`).
 *
 * Every read goes through `slice` in a window or a chunk, so a motion on a
 * megabyte line or across a million-line file holds no more than the piece it
 * is looking at. A quote object is the exception: it reads its whole line,
 * as vim pairs quotes from the line's start.
 */

// ─── The reader ───────────────────────────────────────────────────────────

export function reader(doc) {
  const lineEnd = (n) => (n + 1 < doc.lineCount ? doc.lineStart(n + 1) - 1 : doc.length)
  return {
    get length() { return doc.length },
    get lineCount() { return doc.lineCount },
    slice: (from, to) => doc.slice(from, to),
    lineOf: (i) => doc.positionAt(i).line,
    lineStart: (n) => doc.lineStart(n),
    lineEnd,
    lineStartAt: (i) => doc.lineStart(doc.positionAt(i).line),
    lineEndAt: (i) => lineEnd(doc.positionAt(i).line),
  }
}

// The text after one edit, for placing the cursor where the edit leaves it.
// It answers offsets only, not line numbers, which nothing after an edit asks.
export function overlay(r, { from, to, insert }) {
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

export const charAt = (r, i) => r.slice(i, i + 1)
const codePointAt = (r, i) => r.slice(i, i + 2).codePointAt(0)
const blankLine = (r, n) => r.lineStart(n) === r.lineEnd(n)

export function firstNonBlank(r, i) {
  const le = r.lineEndAt(i)
  let j = r.lineStartAt(i)
  while (j < le && (charAt(r, j) === ' ' || charAt(r, j) === '\t')) j++
  return j
}

// ─── Chunked scans ────────────────────────────────────────────────────────

const CHUNK = 4096

// The first start of `s` in `[from, to)`, or -1.
function indexIn(r, s, from, to) {
  for (let a = from; a < to; a += CHUNK) {
    const k = r.slice(a, Math.min(to, a + CHUNK + s.length - 1)).indexOf(s)
    if (k >= 0) return a + k
  }
  return -1
}

// The last start of `s` in `[from, to)`, or -1.
function lastIndexIn(r, s, from, to) {
  for (let b = to; b > from; b -= CHUNK) {
    const a = Math.max(from, b - CHUNK)
    const k = r.slice(a, Math.min(to, b + s.length - 1)).lastIndexOf(s)
    if (k >= 0) return a + k
  }
  return -1
}

// The first offset at or after `from` (or at or before it, walking back)
// whose character `fn` takes, or -1; a forward scan stops before `stop`.
function scan(r, from, forward, fn, stop = r.length) {
  if (forward) {
    for (let a = from; a < stop; a += CHUNK) {
      const t = r.slice(a, Math.min(stop, a + CHUNK))
      for (let k = 0; k < t.length; k++) if (fn(t[k])) return a + k
    }
  } else {
    for (let b = from + 1; b > 0; b -= CHUNK) {
      const a = Math.max(0, b - CHUNK)
      const t = r.slice(a, b)
      for (let k = t.length - 1; k >= 0; k--) if (fn(t[k])) return a + k
    }
  }
  return -1
}

// ─── Graphemes ────────────────────────────────────────────────────────────

// A character is a grapheme: an emoji with its modifiers, a letter with its
// accent. A newline is one on its own.
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
export const next = (r, i) => (i >= r.length ? r.length : graphemeAt(r, i).end)
export const prev = (r, i) => (i <= 0 ? 0 : graphemeAt(r, i - 1).start)
export const snap = (r, i) => (i >= r.length ? i : graphemeAt(r, i).start)

/** Each grapheme of `text` passed through `fn`, newlines kept. */
export function mapGraphemes(text, fn) {
  let out = ''
  for (const { segment } of GRAPHEMES.segment(text)) out += segment === '\n' ? segment : fn(segment)
  return out
}

// ─── Words ────────────────────────────────────────────────────────────────

// khat's three classes: space, a word's characters, and punctuation, each run
// of one class a word; a WORD (`big`) is any run of non-space. Read a code
// point at a time, so a surrogate pair is one character of its class.
const WORD = /[\p{L}\p{N}\p{M}_]/u
function kind(r, i, big) {
  const c = String.fromCodePoint(codePointAt(r, i))
  return /\s/u.test(c) ? 'space' : big || WORD.test(c) ? 'word' : 'punct'
}
const step = (r, i) => i + (codePointAt(r, i) > 0xffff ? 2 : 1)
const back = (r, i) => i - (i >= 2 && codePointAt(r, i - 2) > 0xffff ? 2 : 1)

export function wordForward(r, i, big = false) {
  const len = r.length
  if (i < len && kind(r, i, big) !== 'space') {
    const k = kind(r, i, big)
    while (i < len && kind(r, i, big) === k) i = step(r, i)
  }
  while (i < len && kind(r, i, big) === 'space') i = step(r, i)
  return i
}

export function wordBack(r, i, big = false) {
  while (i > 0 && kind(r, back(r, i), big) === 'space') i = back(r, i)
  if (i > 0) {
    const k = kind(r, back(r, i), big)
    while (i > 0 && kind(r, back(r, i), big) === k) i = back(r, i)
  }
  return i
}

// The last character of the next word's end after `i`.
export function wordEnd(r, i, big = false) {
  const len = r.length
  if (!len) return 0
  const last = prev(r, len)
  i = next(r, i)
  while (i < len && kind(r, i, big) === 'space') i = step(r, i)
  if (i >= len) return last
  const k = kind(r, i, big)
  while (step(r, i) < len && kind(r, step(r, i), big) === k) i = step(r, i)
  return snap(r, i)
}

// `ge`: the last character of the word before the one `i` is in.
export function wordEndBack(r, i, big = false) {
  if (i <= 0) return 0
  if (i >= r.length) i = prev(r, r.length)
  const k = kind(r, i, big)
  while (i > 0 && kind(r, i, big) === k && k !== 'space') i = back(r, i)
  while (i > 0 && kind(r, i, big) === 'space') i = back(r, i)
  return snap(r, i)
}

// The end of the run of `i`'s class on its line: what `cw` changes, since
// vim's `cw` on a word stops where the word does and takes no space after it.
export function runEnd(r, i, big = false) {
  const le = r.lineEndAt(i)
  if (i >= le) return i
  const k = kind(r, i, big)
  let j = step(r, i)
  while (j < le && kind(r, j, big) === k) j = step(r, j)
  return j
}

export const isSpaceAt = (r, i) => i < r.length && kind(r, i, false) === 'space'

// ─── Lines, finds, brackets, paragraphs ───────────────────────────────────

// A vertical move keeps `column`, in UTF-16 units from the line's start, and
// lands on the grapheme there or on the line's end.
export function vertical(r, i, delta, column) {
  const n = r.lineOf(i) + delta
  if (n < 0 || n >= r.lineCount) return null
  const ls = r.lineStart(n)
  const le = r.lineEnd(n)
  const at = Math.min(ls + column, le)
  return at < le ? snap(r, at) : at
}

/** `f`, `F`, `t`, `T` on `i`'s line; a repeat of a till skips the match beside it. */
export function find(r, i, how, ch, repeat = false) {
  const forward = how === 'f' || how === 't'
  const till = how === 't' || how === 'T'
  if (forward) {
    let from = next(r, i)
    if (till && repeat) from = next(r, from)
    const k = indexIn(r, ch, from, r.lineEndAt(i))
    return k < 0 ? null : till ? prev(r, k) : k
  }
  const to = till && repeat ? prev(r, i) : i
  const k = lastIndexIn(r, ch, r.lineStartAt(i), to)
  return k < 0 ? null : till ? next(r, k) : k
}

const OPENS = { '(': ')', '[': ']', '{': '}', '<': '>' }
const CLOSES = { ')': '(', ']': '[', '}': '{', '>': '<' }

// The bracket matching the one at `at`, or -1, across the whole document.
function partner(r, at, c) {
  const forward = c in OPENS
  const mine = c
  const theirs = forward ? OPENS[c] : CLOSES[c]
  let depth = 0
  return scan(r, forward ? at + 1 : at - 1, forward, (ch) => {
    if (ch === mine) depth++
    else if (ch === theirs) {
      if (depth === 0) return true
      depth--
    }
    return false
  })
}

/** `%`: the first of `( ) [ ] { }` at or after `i` on its line, matched. */
export function matchPair(r, i) {
  const at = scan(r, i, true, (ch) => '()[]{}'.includes(ch), r.lineEndAt(i))
  if (at < 0) return null
  const k = partner(r, at, charAt(r, at))
  return k < 0 ? null : k
}

/** `}` and `{`: the next empty line past the paragraph, or the document's end. */
export function paragraph(r, i, forward) {
  const last = r.lineCount - 1
  let n = r.lineOf(i)
  if (forward) {
    while (n < last && blankLine(r, n)) n++
    while (n < last && !blankLine(r, n)) n++
    return blankLine(r, n) ? r.lineStart(n) : r.length
  }
  while (n > 0 && blankLine(r, n)) n--
  while (n > 0 && !blankLine(r, n)) n--
  return r.lineStart(n)
}

// ─── Text objects ─────────────────────────────────────────────────────────
//
// Each answers `{ from, to, linewise }` with `to` exclusive, or null. A
// linewise range is a whole line's text from the first line's start to the
// last line's end, the newline after it not included.

/** `iw` `aw` `iW` `aW`, on the cursor's line, as khat's: `aw` takes the space after, else before. */
export function wordObject(r, i, around, big) {
  const ls = r.lineStartAt(i)
  const le = r.lineEndAt(i)
  if (ls === le) return null
  if (i >= le) i = prev(r, le)
  const k = kind(r, i, big)
  let a = i
  while (a > ls && kind(r, back(r, a), big) === k) a = back(r, a)
  let b = step(r, i)
  while (b < le && kind(r, b, big) === k) b = step(r, b)
  if (!around) return { from: a, to: b, linewise: false }
  if (k === 'space') {
    if (b < le) {
      const k2 = kind(r, b, big)
      while (b < le && kind(r, b, big) === k2) b = step(r, b)
    }
    return { from: a, to: b, linewise: false }
  }
  let e = b
  while (e < le && kind(r, e, big) === 'space') e = step(r, e)
  if (e > b) return { from: a, to: e, linewise: false }
  while (a > ls && kind(r, back(r, a), big) === 'space') a = back(r, a)
  return { from: a, to: b, linewise: false }
}

/**
 * `i(` `a(` and the other pairs: the innermost pair around `i`, or the pair
 * `i` sits on. An inner block that opens a line and closes on its own line
 * drops those two line breaks, so `di{` leaves `{` and `}` on their lines.
 */
export function bracketObject(r, i, open, around) {
  const close = OPENS[open]
  const here = charAt(r, i)
  let o
  let c
  if (here === open) o = i
  else if (here === close) c = i
  else {
    let depth = 0
    o = scan(r, i - 1, false, (ch) => {
      if (ch === close) depth++
      else if (ch === open) {
        if (depth === 0) return true
        depth--
      }
      return false
    })
    if (o < 0) return null
  }
  if (c === undefined) c = partner(r, o, open)
  else o = partner(r, c, close)
  if (o < 0 || c < 0) return null
  if (around) return { from: o, to: c + 1, linewise: false }
  let from = o + 1
  let to = c
  if (charAt(r, from) === '\n') from++
  const cls = r.lineStartAt(c)
  if (cls > o && cls >= from && /^[ \t]*$/.test(r.slice(cls, c))) to = cls
  return { from, to: Math.max(from, to), linewise: false }
}

/**
 * `i"` `a"` and the other quotes, on the cursor's line: quotes pair in order
 * from the line's start, a backslash escapes one, and a cursor outside every
 * pair takes the first pair after it. `a"` takes the space after, else before.
 */
export function quoteObject(r, i, q, around) {
  const ls = r.lineStartAt(i)
  const line = r.slice(ls, r.lineEndAt(i))
  const at = []
  for (let k = 0; k < line.length; k++) {
    if (line[k] === '\\') k++
    else if (line[k] === q) at.push(k)
  }
  // On a quote, vim pairs the line's quotes from its start; off one, it takes
  // the nearest quote each side, else the first two after.
  const col = i - ls
  let pair = null
  const on = at.indexOf(col)
  if (on >= 0) {
    const k = on - (on % 2)
    if (k + 1 < at.length) pair = [at[k], at[k + 1]]
  } else {
    const after = at.findIndex((k) => k > col)
    if (after > 0) pair = [at[after - 1], at[after]]
    else if (after === 0 && at.length > 1) pair = [at[0], at[1]]
  }
  if (!pair) return null
  let [a, b] = pair
  if (!around) return { from: ls + a + 1, to: ls + b, linewise: false }
  b++
  if (/[ \t]/.test(line[b] ?? '')) while (/[ \t]/.test(line[b] ?? '')) b++
  else while (a > 0 && /[ \t]/.test(line[a - 1])) a--
  return { from: ls + a, to: ls + b, linewise: false }
}

/** `ip` `ap`: the run of lines blank or not that `i`'s line is in; `ap` adds the run after, else before. */
export function paragraphObject(r, i, around) {
  const last = r.lineCount - 1
  const n = r.lineOf(i)
  const blank = blankLine(r, n)
  let a = n
  let b = n
  while (a > 0 && blankLine(r, a - 1) === blank) a--
  while (b < last && blankLine(r, b + 1) === blank) b++
  if (around) {
    if (b < last) {
      const after = blankLine(r, ++b)
      while (b < last && blankLine(r, b + 1) === after) b++
    } else if (a > 0) {
      const before = blankLine(r, --a)
      while (a > 0 && blankLine(r, a - 1) === before) a--
    }
  }
  return { from: r.lineStart(a), to: r.lineEnd(b), linewise: true }
}
