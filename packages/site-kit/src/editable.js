// src/editable.js — what a site's owner may change, as opposed to its
// developer (FJS-D1226). Basecamp's save refuses by it, and so does the grade
// of a model's diff (FJS-D1242), so the two cannot disagree about a file.
//
// The markdown under `content/` is the owner's: prose, and every front-matter
// key but the ones that make a block what it is. Code, styles and the files the
// host reads are the developer's.

import { frontmatterPositions, frontmatterValue, parseFrontmatter, parseFrontmatterBlock, splitFrontmatter } from '@frontierjs/toolbelt/frontmatter'
import { AXES } from './block-look.js'
import { byOrder } from './collection.js'

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
    // The file's line number for the body's first line, so a preview's stamp
    // (`content/routes/x.md:12:1`) finds its place in the body.
    bodyLine: source.slice(0, source.length - body.length).split('\n').length,
    keys: Object.entries(frontmatter).map(([key, value]) => ({
      key,
      value,
      // The file line the key is written on, which a preview's stamp names.
      line: lines.has(key) ? lines.get(key).line + 2 : null,
      locked: LOCKED_KEYS.includes(key),
      field: !LOCKED_KEYS.includes(key) && lines.has(key) && isScalar(value),
      // A field naming one of the site's photos is swapped with an upload, never typed.
      photo: !LOCKED_KEYS.includes(key) && lines.has(key) ? photoOf(value) : null,
    })),
    // Every entry of a front-matter list, a menu's links and their sub-links,
    // which the owner moves, copies and removes (FJS-D1405) by `line`.
    entries: entriesOf(source).map(({ path, line, end, label, index, count }) => ({
      line, end, label, index, count, depth: path.filter((k) => typeof k === 'number').length - 1,
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
 * `field` is the other edit: the words of one front-matter value, at any depth,
 * found by the file line a preview stamped on the element showing it
 * (`FJS-D1231`) — a menu entry's `name`, a setting. `old` is the words the page
 * showed, so a line another save has moved is refused rather than written.
 *
 * `entry` is a list's: the item of a front-matter list written on that line,
 * the innermost when lists nest, moved `earlier` or `later`, copied below
 * itself or removed (`FJS-D1404`, `FJS-D1405`).
 *
 * @param {string} source
 * @param {{ body?: string, values?: Record<string, unknown>, field?: { line: number, old: string, next: string }, entry?: { line: number, act: string } }} [edit]
 * @returns {{ text: string } | { refused: string }}
 */
export function applyEdit(source, { body, values = {}, field, entry } = {}) {
  if (field !== undefined || entry !== undefined) {
    if (body !== undefined || Object.keys(values).length || (field && entry)) return { refused: 'a field or an entry is changed on its own, not with the form' }
    return field ? applyField(source, field) : applyEntry(source, entry)
  }
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

  if (body !== undefined) {
    const added = codeAdded(oldBody, body)
    if (added) return { refused: `${added} is code or markup, so it is the developer's — an owner edits the words around it` }
    const link = SCRIPT_LINK.exec(body)
    if (link) return { refused: `a link to ${link[1]}… runs script, so it is refused` }
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

// One value's words, swapped where the file writes them and read back.
function applyField(source, { line, old, next }) {
  let before, at
  try {
    before = parseFrontmatter(source).frontmatter
    at = frontmatterPositions(source).find((p) => p.line === line)
  } catch (err) {
    return { refused: `the front matter does not read, so a developer fixes it first: ${err.message}` }
  }
  if (!at) return { refused: 'no value is written on that line any more' }
  const name = at.path.join('.')
  if (LOCKED_KEYS.includes(at.path[0])) return { refused: `${at.path[0]} decides what the block is, so it is the developer's` }
  if (at.start === undefined) return { refused: `${name} spans several lines, so it is not changed in place` }
  let was = before
  for (const k of at.path) was = was[k]
  if (typeof was !== 'string') return { refused: `${name} is ${kindOf(was)}, not words` }
  const words = (t) => String(t ?? '').replace(/\s+/g, ' ').trim()
  if (words(was) !== words(old)) return { refused: `${name} has changed since the page was built` }
  const text = words(next)
  if (!text) return { refused: 'the new text is empty' }

  const out = source.slice(0, at.start) + frontmatterValue(text) + source.slice(at.end)
  let after
  try {
    after = parseFrontmatter(out).frontmatter
  } catch (err) {
    return { refused: `the front matter would no longer read: ${err.message}` }
  }
  const expected = structuredClone(before)
  let box = expected
  for (const k of at.path.slice(0, -1)) box = box[k]
  Object.defineProperty(box, at.path[at.path.length - 1], { value: text, writable: true, enumerable: true, configurable: true })
  if (!same(expected, after) || splitFrontmatter(out).body !== splitFrontmatter(source).body) {
    return { refused: `the edit would also change something beside ${name}` }
  }
  return { text: out }
}

// ─── lists (FJS-D1404, FJS-D1405) ────────────────────────────────────────

/** What an owner does to one item of a list: a menu entry, or a collection's file. */
export const ACTS = Object.freeze(['earlier', 'later', 'copy', 'remove'])

const DASH = /^(\s*)-(?:[ \t]|$)/

/**
 * Each item of every block-style list in the front matter, innermost last: its
 * path, the file lines it spans (the `-` line to its last line, from 1), its
 * place in its list and a label, the first words written directly on it.
 */
function entriesOf(source) {
  const { block } = splitFrontmatter(source)
  if (block === null) return []
  const positions = frontmatterPositions(source)
  const lines = source.split('\n').map((l) => l.replace(/\r$/, ''))
  const fence = block.split('\n').length + 2 // the closing `---`, from 1
  const blank = (l) => /^\s*(?:#.*)?$/.test(l)
  const indent = (l) => /^\s*/.exec(l)[0].length
  const { frontmatter } = parseFrontmatter(source)

  const firsts = new Map()
  for (const p of positions) {
    p.path.forEach((k, i) => {
      if (typeof k !== 'number') return
      const id = JSON.stringify(p.path.slice(0, i + 1))
      const at = firsts.get(id)
      if (!at || p.line < at.line) firsts.set(id, { path: p.path.slice(0, i + 1), line: p.line })
    })
  }
  const out = []
  for (const { path, line: first } of firsts.values()) {
    let dash = first
    while (dash > 1 && !DASH.test(lines[dash - 1])) dash--
    const m = DASH.exec(lines[dash - 1] ?? '')
    if (!m || (dash < first && indent(lines[first - 1]) <= m[1].length)) continue
    let end = dash
    for (let j = dash + 1; j < fence; j++) {
      const l = lines[j - 1]
      if (blank(l)) continue
      if (indent(l) <= m[1].length) break
      end = j
    }
    let list = frontmatter
    for (const k of path.slice(0, -1)) list = list?.[k]
    const item = list[path[path.length - 1]]
    const label = isScalar(item) ? item : Object.values(item ?? {}).find((v) => typeof v === 'string')
    out.push({ path, line: dash, end, index: path[path.length - 1], count: list.length, label: label == null ? '' : String(label) })
  }
  return out.sort((a, b) => a.line - b.line)
}

// One list item moved, copied or removed by its lines, so every line the
// owner did not touch keeps its spelling, then read back: the result must be
// the list with exactly that change, or it is refused.
function applyEntry(source, { line, act } = {}) {
  if (!Number.isInteger(line) || !ACTS.includes(act)) return { refused: `an entry is { line, act } with act one of ${ACTS.join(', ')}` }
  let before, entries
  try {
    before = parseFrontmatter(source).frontmatter
    entries = entriesOf(source)
  } catch (err) {
    return { refused: `the front matter does not read, so a developer fixes it first: ${err.message}` }
  }
  const at = entries.filter((e) => e.line <= line && line <= e.end).pop()
  if (!at) return { refused: 'no list entry is written on that line any more' }
  if (LOCKED_KEYS.includes(at.path[0])) return { refused: `${at.path[0]} decides what the block is, so it is the developer's` }
  const name = at.label ? `'${at.label}'` : 'that entry'
  if (act === 'remove' && at.count === 1) return { refused: `${name} is the list's only entry, and an empty list is a layout change` }
  if (act === 'earlier' && at.index === 0) return { refused: `${name} is already first` }
  if (act === 'later' && at.index === at.count - 1) return { refused: `${name} is already last` }

  const lines = source.split('\n')
  const span = (e) => lines.slice(e.line - 1, e.end)
  const sibling = (i) => entries.find((e) => same(e.path, [...at.path.slice(0, -1), i]))
  let out
  if (act === 'remove') out = [...lines.slice(0, at.line - 1), ...lines.slice(at.end)]
  else if (act === 'copy') out = [...lines.slice(0, at.end), ...span(at), ...lines.slice(at.end)]
  else {
    const [a, b] = act === 'earlier' ? [sibling(at.index - 1), at] : [at, sibling(at.index + 1)]
    if (!a || !b) return { refused: `${name} is not beside another entry it could swap with` }
    out = [...lines.slice(0, a.line - 1), ...span(b), ...lines.slice(a.end, b.line - 1), ...span(a), ...lines.slice(b.end)]
  }
  const text = out.join('\n')

  const expected = structuredClone(before)
  let list = expected
  for (const k of at.path.slice(0, -1)) list = list[k]
  const i = at.index
  if (act === 'remove') list.splice(i, 1)
  else if (act === 'copy') list.splice(i + 1, 0, structuredClone(list[i]))
  else {
    const j = act === 'earlier' ? i - 1 : i + 1
    ;[list[i], list[j]] = [list[j], list[i]]
  }
  let after
  try {
    after = parseFrontmatter(text).frontmatter
  } catch (err) {
    return { refused: `the front matter would no longer read: ${err.message}` }
  }
  if (!same(expected, after) || splitFrontmatter(text).body !== splitFrontmatter(source).body) {
    return { refused: `moving ${name} would also change something beside it, so a developer rewrites this list` }
  }
  return { text }
}

const COLLECTION = /^content\/collections\/[^/]+\/[^/]+\.md$/

/** The folder of the collection `path` is an item of, or null when it is no collection's. */
export function collectionOf(path) {
  return COLLECTION.test(String(path)) ? path.slice(0, path.lastIndexOf('/')) : null
}

/**
 * One item of a collection moved, copied or removed (FJS-D1403, FJS-D1404), as
 * the files to write: `{ writes: [{ path, text }] }`, a null `text` deleting
 * that file, or `{ refused }`. `files` is every `.md` of the collection's
 * folder with its source. A move writes `order:` 1 to n on each item whose
 * number is not already its place; a copy is the item's file whole, named
 * beside it and placed after it; a removal deletes the file and moves nothing.
 *
 * @param {Array<{ path: string, source: string }>} files
 * @param {{ path: string, act: string }} what
 * @returns {{ writes: Array<{ path: string, text: string | null }>, path?: string } | { refused: string }}
 */
export function arrangeCollection(files, { path, act } = {}) {
  if (!ACTS.includes(act)) return { refused: `act is one of ${ACTS.join(', ')}` }
  const dir = collectionOf(path)
  if (!dir) return { refused: `${path} is not an item of a collection` }
  let items
  try {
    items = files.filter((f) => collectionOf(f.path) === dir)
      .map((f) => ({ ...f, frontmatter: parseFrontmatter(f.source).frontmatter }))
      .sort(byOrder)
  } catch (err) {
    return { refused: `an item of ${dir} does not read, so a developer fixes it first: ${err.message}` }
  }
  const i = items.findIndex((f) => f.path === path)
  if (i === -1) return { refused: `${path} is not in ${dir}` }
  const name = path.slice(dir.length + 1)
  if (act === 'remove') {
    if (items.length === 1) return { refused: `${name} is the collection's only item, and an empty list is a layout change` }
    return { writes: [{ path, text: null }] }
  }
  if (act === 'earlier' && i === 0) return { refused: `${name} is already first` }
  if (act === 'later' && i === items.length - 1) return { refused: `${name} is already last` }

  const want = [...items]
  let added
  if (act === 'copy') {
    const stem = path.slice(0, -'.md'.length)
    let n = 1, next = `${stem}-copy.md`
    while (files.some((f) => f.path === next)) next = `${stem}-copy-${++n}.md`
    added = { ...items[i], path: next }
    want.splice(i + 1, 0, added)
  } else {
    const j = act === 'earlier' ? i - 1 : i + 1
    ;[want[i], want[j]] = [want[j], want[i]]
  }

  const writes = added ? [{ path: added.path, text: added.source }] : []
  const sorted = [...want].sort(byOrder)
  if (sorted.some((f, k) => f !== want[k])) {
    for (const [k, f] of want.entries()) {
      if (f.frontmatter.order === k + 1) continue
      const text = withOrder(f.source, k + 1)
      if (typeof text !== 'string') return { refused: `${f.path.slice(dir.length + 1)}: ${text.refused}` }
      const w = writes.find((x) => x.path === f.path)
      if (w) w.text = text
      else writes.push({ path: f.path, text })
    }
  }
  return added ? { writes, path: added.path } : { writes }
}

// `order: n` written into one file's front matter, on the key's own line when
// it has one and as the block's last line when it has none.
function withOrder(source, n) {
  const { block } = splitFrontmatter(source)
  if (block === null) return `---\norder: ${n}\n---\n${source}`
  const before = parseFrontmatterBlock(block)
  if (Object.hasOwn(before, 'order')) {
    const edit = applyEdit(source, { values: { order: n } })
    return 'refused' in edit ? edit : edit.text
  }
  // The block stops short of the newline before the closing fence.
  const close = source.indexOf('\n') + 1 + block.length
  const text = block === '' && source.startsWith('---', close)
    ? source.slice(0, close) + `order: ${n}\n` + source.slice(close)
    : source.slice(0, close) + `\norder: ${n}` + source.slice(close)
  const after = parseFrontmatter(text)
  if (!same({ ...before, order: n }, after.frontmatter) || after.body !== splitFrontmatter(source).body) {
    return { refused: 'order could not be written without changing something else' }
  }
  return text
}

// ─── photos (FJS-D1406, FJS-D1407) ───────────────────────────────────────

// A site's address `/x` is the file `content/public/x`, which Vite serves and copies.
const PUBLIC = 'content/public'

/**
 * A front-matter value naming one of the site's own raster photos, as
 * `{ src, alt, file }`: its address without the query, the words its `?text=`
 * says it shows (FJS-D1406), and the file under `content/public/` holding it.
 * Null for anything else, an SVG or another site's photo included.
 */
export function photoOf(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null
  const q = value.indexOf('?')
  const src = q === -1 ? value : value.slice(0, q)
  if (!IMAGE.test(src)) return null
  let file
  try { file = PUBLIC + decodeURI(src) } catch { return null }
  if (pathRefusal(file)) return null
  return { src, alt: new URLSearchParams(q === -1 ? '' : value.slice(q + 1)).get('text') ?? '', file }
}

/**
 * The file name a new photo is saved under in `folder`: the uploaded name's
 * words as a slug, with `ext`, and `-2`, `-3`… past a name `taken(name)` says
 * is already there.
 * @param {string} uploaded
 * @param {string} ext
 * @param {(name: string) => boolean} [taken]
 */
export function photoName(uploaded, ext, taken = () => false) {
  const stem = String(uploaded ?? '').replace(/\.[^.]*$/, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'photo'
  let n = 1, name = `${stem}.${ext}`
  while (taken(name)) name = `${stem}-${++n}.${ext}`
  return name
}

/**
 * `source` with the photo at front-matter `key` given new words and, with
 * `src`, a new address: `{ text }` or `{ refused }`. The words are required.
 * The value's other query keys stay, the block's sizing, except `height`,
 * which was the old photo's own shape.
 */
export function applyPhoto(source, { key, alt, src } = {}) {
  let form
  try {
    form = formOf(source)
  } catch (err) {
    return { refused: `the front matter does not read, so a developer fixes it first: ${err.message}` }
  }
  const k = form.keys.find((x) => x.key === key)
  if (!k) return { refused: `${key} is not in this file` }
  const was = k.field ? photoOf(k.value) : null
  if (!was) return { refused: `${key} is not one of the site's photos that this form writes` }
  const words = String(alt ?? '').replace(/\s+/g, ' ').trim()
  if (!words) return { refused: 'a photo needs a few words saying what it shows, for anyone who cannot see it' }
  if (src !== undefined && !photoOf(src)) return { refused: `${src} is not one of the site's photos` }
  const q = k.value.indexOf('?')
  const params = new URLSearchParams(q === -1 ? '' : k.value.slice(q + 1))
  if (src !== undefined && src !== was.src) params.delete('height')
  params.set('text', words)
  return applyEdit(source, { values: { [key]: `${src ?? was.src}?${params}` } })
}

// ─── the body's code (FJS-D1250) ──────────────────────────────────────────

// Mesa compiles a `.md` body's leading <script> as the route's script and every
// {…} as an expression, and a build runs both: an owner who could add one would
// run code wherever the draft builds and in every visitor's browser. A tag
// carries attributes (`onclick`, an `href`), so it is code too. The owner's
// body may hold only the code the old one held, as many times or fewer.
const SCRIPT_BLOCK = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi
const TAG          = /<[A-Za-z][\w-]*(?=[\s/>])[^>]*>/g

// A markdown link, a reference definition or an autolink to a script scheme.
const SCRIPT_LINK  = /(?:\]\(\s*<?|^\s*\[[^\]]+\]:\s*<?|<)((?:java|vb)script:)/im

/** Each piece of code in a markdown body, in order. */
function codeOf(body) {
  const out = []
  const rest = String(body).replace(SCRIPT_BLOCK, (m) => { out.push(m); return ' ' })
  for (const m of rest.matchAll(TAG)) out.push(m[0])
  let depth = 0, start = -1
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '{') { if (depth++ === 0) start = i }
    else if (rest[i] === '}' && depth > 0 && --depth === 0) out.push(rest.slice(start, i + 1))
  }
  if (depth > 0) out.push(rest.slice(start))
  return out
}

/** The first piece of code `after` holds more often than `before`, or null. */
function codeAdded(before, after) {
  const held = new Map()
  for (const c of codeOf(before)) held.set(c, (held.get(c) ?? 0) + 1)
  for (const c of codeOf(after)) {
    const n = held.get(c) ?? 0
    if (!n) return c.length > 60 ? `${c.slice(0, 57)}…` : c
    held.set(c, n - 1)
  }
  return null
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
