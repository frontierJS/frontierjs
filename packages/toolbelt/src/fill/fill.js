/*
 * fill.js -- merge fields into text a user wrote.
 *
 * `Hi {contact.name}` is stored text, typed by someone who is not the
 * developer, filled from data the app holds and often typed by someone else
 * again. The value is the hazard: a client named `<img onerror=…>` filled into
 * an HTML body runs where the mail is read. `mode` is therefore REQUIRED and
 * stated by the caller; a body's format is never sniffed from its tags, because
 * a name holding `<b>` would then turn a plain reply into raw HTML.
 *
 *   fill(source, ctx, { mode: 'html' | 'text' })    the filled text
 *   check(source, names)                             what to refuse at save
 *
 * A hole is `{path}` -- a dotted name of any depth read by own keys, or a
 * `/predicate` values expression (`{c.name ? c.name : 'there'}`). A literal
 * brace is written `\{`. The source is the author's markup and is never escaped;
 * only a filled value is. A value built as markup is passed as `{ html, text }`
 * and read by mode.
 *
 * What is NOT filled stays as written, so the gap shows rather than vanishing:
 * a name the context lacks, an expression reaching past values (`auth()`,
 * `now()`), a value that is not a scalar, and braces that open no hole. `null`
 * fills empty and every other falsy value fills as written (`0`, `false`).
 * `check` is the refusal half, run when a template is saved (`FJS-D980`).
 */

import { parseText, assertValues, evaluateValues } from '../predicate/predicate.js'
import { holeEnd } from '../predicate/tokenize.js'

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ESC[c])

const DOTTED = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/

// ─── scanning ─────────────────────────────────────────────────────────────────

// Yields `{ text }` for literal text (with `\{` already a `{`) and
// `{ hole, raw }` for a brace pair, or `{ open }` for a `{` that never closes.
function* segments(source) {
  let text = ''
  let i = 0
  while (i < source.length) {
    const c = source[i]
    if (c === '\\' && source[i + 1] === '{') { text += '{'; i += 2; continue }
    if (c !== '{') { text += c; i++; continue }
    const end = holeEnd(source, i + 1)
    if (end < 0) {
      if (text) yield { text }
      yield { open: source.slice(i) }
      return
    }
    if (text) yield { text }
    text = ''
    yield { hole: source.slice(i + 1, end).trim(), raw: source.slice(i, end + 1) }
    i = end + 1
  }
  if (text) yield { text }
}

// ─── fill ─────────────────────────────────────────────────────────────────────

const own = (o, k) => o !== null && typeof o === 'object' && Object.hasOwn(o, k)

// Own keys only: `contact.constructor` is a property of nothing the caller listed.
function walk(ctx, path) {
  let v = ctx
  for (const k of path.split('.')) {
    if (!own(v, k)) return { found: false }
    v = v[k]
  }
  return { found: true, value: v }
}

// Only objects can be an owner `evaluateValues` reads from; a top-level scalar
// is reachable by a dotted name and by nothing richer.
const owners = (ctx) => Object.fromEntries(Object.entries(ctx).filter(([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v)))

function valueOf(hole, ctx) {
  if (hole === '') return { found: false }
  if (DOTTED.test(hole)) return walk(ctx, hole)
  try {
    const ast = parseText(hole)
    return { found: true, value: evaluateValues(ast, owners(ctx)) }
  } catch {
    return { found: false }
  }
}

function render(value, mode) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return mode === 'html' ? escapeHtml(value) : value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (value instanceof Date) return mode === 'html' ? escapeHtml(value.toISOString()) : value.toISOString()
  if (own(value, 'html') && own(value, 'text') && typeof value.html === 'string' && typeof value.text === 'string') {
    return mode === 'html' ? value.html : value.text
  }
  return undefined
}

export function fill(source, ctx, { mode } = {}) {
  if (mode !== 'html' && mode !== 'text') {
    throw new Error(`fill: mode must be 'html' or 'text', got ${JSON.stringify(mode)} -- the caller states the format; it is never read off the tags`)
  }
  let out = ''
  for (const seg of segments(String(source))) {
    if ('text' in seg) { out += seg.text; continue }
    if ('open' in seg) { out += seg.open; continue }
    const got = valueOf(seg.hole, ctx ?? {})
    const text = got.found ? render(got.value, mode) : undefined
    out += text === undefined ? seg.raw : text
  }
  return out
}

// ─── check ────────────────────────────────────────────────────────────────────

/**
 * Every hole in `source` that could never fill, as `{ hole, message }`; an empty
 * list is a clean template. `names` is the closed list `{ owner: ['field', …] }`
 * a template may read. A `{` that closes nothing or holds nothing readable is
 * refused too, since a stray brace in a sentence is written `\{`.
 */
export function check(source, names) {
  const problems = []
  for (const seg of segments(String(source))) {
    if ('open' in seg) {
      problems.push({ hole: seg.open, message: `'{' opens a hole that never closes -- write a literal brace as \\{` })
      continue
    }
    if (!('hole' in seg)) continue
    try {
      if (DOTTED.test(seg.hole)) {
        const [rel, name] = seg.hole.split('.')
        if (name === undefined) throw new Error(`${rel} has no field -- write it as ${rel}.field`)
        assertValues({ type: 'path', rel, name }, names)
      } else {
        assertValues(parseText(seg.hole), names)
      }
    } catch (err) {
      problems.push({ hole: seg.hole, message: err.message })
    }
  }
  return problems
}
