// src/editable.js — what a site's owner may change, as opposed to its
// developer (FJS-D1226). Basecamp's save refuses by it, and so does the grade
// of a model's diff (FJS-D1242), so the two cannot disagree about a file.
//
// The markdown under `content/` is the owner's: prose, and every front-matter
// key but the ones that make a block what it is. Code, styles and the files the
// host reads are the developer's.

import { frontmatterValue, parseFrontmatter, parseFrontmatterBlock, splitFrontmatter } from '@frontierjs/toolbelt/frontmatter'
import { AXES } from './block-look.js'

// `name` keys a block's own stylesheet rules, and the look keys are Block's six;
// a change to any of them is a layout change a developer ends up repairing.
export const LOCKED_KEYS = Object.freeze(['layout', 'name', ...Object.keys(AXES), 'background'])

// An SVG can carry script and is served from the site's own origin, so it is
// the developer's even though it is an image.
const IMAGE = /\.(jpe?g|png|webp|gif|avif)$/i

/**
 * Null when an owner may write `path`, otherwise why not. `path` is relative to
 * the site root (the directory holding `content/`), with `/` separators.
 */
export function pathRefusal(path) {
  const segments = String(path).split('/')
  if (!path || path.startsWith('/') || segments.some((s) => s === '' || s === '.' || s === '..')) {
    return `${path || 'an empty path'} is not a path inside the site`
  }
  if (segments[0] !== 'content' || segments.length < 2) return `${path} is outside content/, so it is the developer's`
  const file = segments[segments.length - 1]
  if (file.endsWith('.md') || IMAGE.test(file)) return null
  return `${path} is not markdown or a photo, so it is the developer's`
}

/**
 * The locked keys whose value differs between two front-matter objects, in
 * LOCKED_KEYS order. Only the top level is read: a menu entry's `name` is the
 * link's label, not a block's.
 */
export function lockedKeysChanged(before = {}, after = {}) {
  return LOCKED_KEYS.filter((key) => (key in before) !== (key in after) || !same(before[key], after[key]))
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ─── the form ─────────────────────────────────────────────────────────────

/**
 * A markdown file as an owner's form: its body, and each top-level front-matter
 * key with whether the form may write it. A field is an unlocked text, number
 * or yes/no value written on one line; a list, a map or a value over several
 * lines is shown and not written, because rewriting one would reformat lines
 * the owner never touched.
 */
export function formOf(source) {
  const { frontmatter, body } = parseFrontmatter(source)
  const block = splitFrontmatter(source).block
  const lines = block === null ? new Map() : keyLines(block, frontmatter)
  return {
    body,
    keys: Object.entries(frontmatter).map(([key, value]) => ({
      key,
      value,
      locked: LOCKED_KEYS.includes(key),
      field: !LOCKED_KEYS.includes(key) && lines.has(key) && isScalar(value),
    })),
  }
}

/**
 * `source` with a new body and new values for some of its front-matter keys,
 * as `{ text }`, or `{ refused }` naming why not. Only the lines of the keys in
 * `values` change, a trailing comment on one included. The result is read back
 * and refused unless it holds exactly the values asked for, so a write that
 * would reach another key, or a body that opens a front-matter block of its
 * own, never lands.
 *
 * @param {string} source
 * @param {{ body?: string, values?: Record<string, unknown> }} [edit]
 * @returns {{ text: string } | { refused: string }}
 */
export function applyEdit(source, { body, values = {} } = {}) {
  const { block, body: oldBody } = splitFrontmatter(source)
  let before
  try {
    before = block === null ? {} : parseFrontmatterBlock(block)
  } catch (err) {
    return { refused: `the front matter does not read, so a developer fixes it first: ${err.message}` }
  }
  let head = source.slice(0, source.length - oldBody.length)

  const keys = Object.keys(values)
  if (keys.length) {
    if (block === null) return { refused: 'this file has no front matter to write a key into' }
    const at = keyLines(block, before)
    const lines = block.split('\n')
    for (const key of keys) {
      const value = values[key]
      if (LOCKED_KEYS.includes(key)) return { refused: `${key} decides what the block is, so it is the developer's` }
      if (!Object.hasOwn(before, key)) return { refused: `${key} is not in this file` }
      if (!at.has(key) || !isScalar(before[key])) return { refused: `${key} is a list or spans several lines, so the form does not write it` }
      if (!isScalar(value) || (before[key] !== null && typeof value !== typeof before[key])) {
        return { refused: `${key} is ${kindOf(before[key])}, not ${kindOf(value)}` }
      }
      const { line, comment } = at.get(key)
      const text = written(value)
      lines[line] = `${key}:${text === '' ? '' : ' ' + text}${comment}${lines[line].endsWith('\r') ? '\r' : ''}`
    }
    const start = head.indexOf('\n') + 1
    head = head.slice(0, start) + lines.join('\n') + head.slice(start + block.length)
  }

  const text = head + (body === undefined ? oldBody : body)
  let after
  try {
    after = parseFrontmatter(text).frontmatter
  } catch (err) {
    return { refused: `the front matter would no longer read: ${err.message}` }
  }
  const expected = { ...before, ...values }
  const moved = [...new Set([...Object.keys(expected), ...Object.keys(after)])].filter((k) => !same(expected[k], after[k]))
  if (moved.length) return { refused: `the edit would also change ${moved.join(', ')}` }
  return { text }
}

const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)

const kindOf = (v) => (v === null ? 'empty' : typeof v === 'boolean' ? 'yes or no' : typeof v === 'object' ? 'a list or a map' : `a ${typeof v}`)

// Plain where the reader reads it back as itself: frontmatterValue would quote
// a number, and a quoted 12 reads back as text.
const written = (v) => (v === null ? '' : typeof v === 'string' ? frontmatterValue(v) : String(v))

/**
 * Each top-level key written on one line of `block` with a plain name, mapped
 * to that line and the comment trailing its value. A key whose value goes on
 * to an indented line is left out.
 */
function keyLines(block, parsed) {
  const out = new Map()
  const lines = block.split('\n').map((l) => l.replace(/\r$/, ''))
  const blank = (l) => /^\s*(?:#.*)?$/.test(l)
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*)[ \t]*:(?=[ \t]|$)(.*)$/.exec(lines[i])
    if (!m || !Object.hasOwn(parsed, m[1])) continue
    let j = i + 1
    while (j < lines.length && blank(lines[j])) j++
    if (j < lines.length && /^\s/.test(lines[j])) continue
    out.set(m[1], { line: i, comment: commentOf(m[2], parsed[m[1]]) })
  }
  return out
}

// The comment after a value, found as the first ` #` the value reads the same
// without — a `#` inside quotes is part of the value.
function commentOf(rest, value) {
  for (const m of rest.matchAll(/[ \t]+#/g)) {
    try {
      if (same(parseFrontmatterBlock('k:' + rest.slice(0, m.index)).k, value)) return rest.slice(m.index)
    } catch {}
  }
  return ''
}
