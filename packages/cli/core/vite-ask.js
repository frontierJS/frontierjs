// ─── vite-ask.js — ask Claude to change picked elements, see it hot-reload ───
//
// Three halves. Mesa's inspector picks an element (shift+alt-click) and knows
// nothing about what a pick is for; the client served here registers as its
// picker and draws the panel; the middleware below runs `claude -p` with Edit
// scoped to the Vite root. Nothing here reloads anything: the edit is a file
// write, and the dev server's own watcher is what the page sees.
//
// The middleware is on the DEV SERVER, so it is same-origin with the page —
// and it is also a localhost port any other tab can POST at. A cross-site form
// or a no-cors fetch carries a foreign Origin (or none) and cannot set a JSON
// content type without a preflight Vite never answers yes to, so both are
// refused before anything is spawned. On a dev server other people can reach,
// same-origin says nothing about WHO, so `ASK_ADMIT_URL` turns on a second
// rule: the page's Bearer token, graded by the app's own API (`admitCaller`).
//
// Submit commits what the panel's runs changed, pushes, and opens a pull
// request — on a Workbench branch only, and never over a file the panel did not
// write, because a commit of the whole tree would carry another writer's work
// into a review nobody asked them for. In a preview worktree it is also refused
// while the branch holds anything outside the Vite root (`core/preview.js`).
//
// A text edit is a run with no model: the picked element's old text, found
// exactly once where the element was written, swapped for the new. Anything
// else — the text interpolated, split by markup, or there twice — is not
// guessed at; the panel asks Claude instead. It goes through the same ledger,
// so its diff and its undo are a run's.
//
// An undo puts back each file's whole original when the file is still exactly
// what the run left; anything else means another writer has been in it, and a
// whole-file restore would take their work with ours. Then it reverses the
// run's own hunks, newest first, only where the new text occurs exactly once.
//
// An ask may carry images pasted into the panel. The panel shrinks them first;
// the limits here are the API's own, so a request it would refuse stops here,
// before a run starts that can only fail.

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitFrontmatter } from '@frontierjs/toolbelt/frontmatter'
import { LEVELS } from '@frontierjs/toolbelt/gate'

import { EDIT_KINDS, EDIT_SCOPES, IMAGE_TYPES, editPrompt, resumeCommand, runAsk } from './ask-claude.js'
import { askContext } from './ask-context.js'
import { previewScope } from './preview.js'

const CLIENT_ID   = '/@frontierjs/cli/ask-client'
const RESOLVED_ID = '\0@frontierjs/cli/ask-client'
const CLIENT_FILE = fileURLToPath(new URL('./vite-ask-client.js', import.meta.url))
const MAX_BODY    = 256 * 1024
const LOC         = /^[\w./-]+\.(mesa|md):\d+:\d+$/
const MAX_PICKS   = 10
const MAX_INNER   = 60
const MAX_TEXT    = 2000
const MAX_IMAGES  = 5
const MAX_IMAGE   = 5 * 1024 * 1024
const ASK_BODY    = MAX_BODY + MAX_IMAGES * MAX_IMAGE
const BASE64      = /^[A-Za-z0-9+/]+={0,2}$/

/** True when the request came from a page this dev server served. */
export function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin || !req.headers.host) return false
  let host
  try { host = new URL(origin).host } catch { return false }
  if (host !== req.headers.host) return false
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin') return false
  return /^application\/json\b/i.test(req.headers['content-type'] ?? '')
}

/**
 * Who may ask, read from the environment the dev server started with. Unset is
 * a localhost dev server, and same-origin is the whole rule. `ASK_ADMIT_URL` is
 * the address that answers who a token is — auth's `account/me` on the app's
 * API — and `ASK_ADMIT_LEVEL` names the level from the gate's LEVELS that the
 * answer's `level` must reach.
 */
export function readAdmit(env = process.env) {
  const url = String(env.ASK_ADMIT_URL ?? '').trim()
  if (!url) return null
  const name = String(env.ASK_ADMIT_LEVEL ?? '').trim().toUpperCase()
  return { url, name, level: Object.hasOwn(LEVELS, name) ? LEVELS[name] : null }
}

/**
 * Null when the caller may ask, else `{ status, error }`. The level is the
 * API's own grading — `account/me` carries it when the app passes `services: {
 * level }` to its auth plugin — so the dev server holds no second role→level
 * mapping, and an answer without one is refused rather than guessed at.
 */
export async function admitCaller(req, admit) {
  if (!admit) return null
  if (admit.level == null) {
    return { status: 500, error: `ASK_ADMIT_LEVEL is ${admit.name ? `'${admit.name}', not a level` : 'unset'} — one of ${Object.keys(LEVELS).join(', ')}` }
  }
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1]
  if (!token) return { status: 401, error: 'sign in to the app first — this dev server asks the API who you are' }
  let r
  try {
    r = await fetch(admit.url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(5000) })
  } catch (e) {
    return { status: 502, error: `the API at ${admit.url} did not answer (${e.message})` }
  }
  if (r.status === 401 || r.status === 403) return { status: 401, error: 'the API does not know this session — sign in again' }
  if (!r.ok) return { status: 502, error: `the API at ${admit.url} answered ${r.status}` }
  const me = await r.json().catch(() => null)
  if (!Number.isFinite(me?.level)) {
    return { status: 502, error: 'the API answered with no level — its auth plugin needs services: { level }' }
  }
  if (me.level < admit.level) return { status: 403, error: `asking here takes ${admit.name}` }
  return null
}

const outside = (root, file) => { const rel = relative(root, file); return rel.startsWith('..') || isAbsolute(rel) }
const look = file => { try { return readFileSync(file, 'utf8') } catch { return null } }

/**
 * Reverse a run's edits in `root` hunk by hunk. Each is `{ file, old, new, all }`
 * in the order they landed; the result names what was undone and why the rest
 * was not. The fallback for a file another writer has touched since.
 */
export function undoEdits(root, edits) {
  const undone = [], skipped = []
  for (const e of [...edits].reverse()) {
    const rel = relative(root, e.file)
    if (outside(root, e.file)) { skipped.push({ file: e.file, why: 'outside the app' }); continue }
    if (e.type === 'write') { skipped.push({ file: rel, why: 'it was written whole, and has changed since' }); continue }
    if (e.all) { skipped.push({ file: rel, why: 'a replace-all edit has no single hunk to reverse' }); continue }
    if (!e.new) { skipped.push({ file: rel, why: 'a deletion leaves nothing to find it by' }); continue }
    let src
    try { src = readFileSync(e.file, 'utf8') } catch { skipped.push({ file: rel, why: 'the file is gone' }); continue }
    const at = src.indexOf(e.new)
    if (at === -1) { skipped.push({ file: rel, why: 'the change is no longer in the file' }); continue }
    if (src.indexOf(e.new, at + 1) !== -1) { skipped.push({ file: rel, why: 'the changed text now occurs more than once' }); continue }
    writeFileSync(e.file, src.slice(0, at) + e.old + src.slice(at + e.new.length))
    undone.push(rel)
  }
  return { undone, skipped }
}

// Does `after` follow from `before` by this one change? The check that the
// copy taken of a file is the one the change was made to: a copy taken late,
// or before another writer got in, fails it, and the file falls back to hunks.
function follows(before, change, after) {
  if (before == null || before === after) return false
  if (change.type === 'write') return after === change.content
  const { old, new: next } = change
  if (!old) return false
  if (change.all) return before.split(old).join(next) === after
  const swap = (from) => { const at = before.indexOf(from); return at !== -1 && before.slice(0, at) + next + before.slice(at + from.length) === after }
  // Deleting a line takes its newline with it.
  return swap(old) || (next === '' && swap(old + '\n'))
}

/**
 * What one run did to the files under `root`, fed the events `runAsk` reports.
 * Each file's original is copied at the run's first Read of it — the CLI will
 * not edit a file it has not read, and refuses one that changed since, so the
 * copy precedes the change and matches what was changed — or, without a Read,
 * at the call, where `follows` catches a copy taken after the write.
 */
export function createLedger(root) {
  const files = new Map()      // abs path → { before, after, changes, trusted }
  const calls = new Map()      // tool_use id → change, until its result lands or is refused

  const entry = file => {
    if (!files.has(file)) files.set(file, { before: undefined, after: null, changes: [], trusted: false })
    return files.get(file)
  }

  return {
    see(e) {
      // A call outside the app is denied by the argv; nothing to put back.
      if (!e.file || outside(root, e.file)) return
      if (e.type === 'read') {
        const f = entry(e.file)
        if (!f.changes.length) f.before = look(e.file)
      } else if (e.type === 'edit' || e.type === 'write') {
        calls.set(e.id, e)
        const f = entry(e.file)
        if (f.before === undefined) f.before = look(e.file)
      }
    },

    result(e) {
      const change = calls.get(e.id)
      if (!change) return
      calls.delete(e.id)
      if (e.type !== 'landed') return
      const f = files.get(change.file)
      const after = look(change.file)
      if (!f.changes.length && change.type === 'write' && e.created) f.before = null
      if (!f.changes.length) f.trusted = f.before === null ? change.type === 'write' && after === change.content
                                                           : follows(f.before, change, after)
      f.changes.push(change)
      f.after = after
    },

    get count() { let n = 0; for (const f of files.values()) n += f.changes.length; return n },

    /** The absolute path of each file a change landed in. */
    touched() { return [...files].filter(([, f]) => f.changes.length).map(([file]) => file) },

    /** Each changed file, with its lines removed and added. */
    diff() {
      const out = []
      for (const [file, f] of files) {
        if (!f.changes.length) continue
        const lines = f.trusted
          ? lineDiff(f.before, f.after ?? '')
          : f.changes.flatMap((c, i) => [
              ...(i ? [['…', '']] : []),
              ...(c.type === 'write' ? [] : textLines(c.old).map(t => ['-', t])),
              ...textLines(c.type === 'write' ? c.content : c.new).map(t => ['+', t]),
            ])
        out.push({ file: relative(root, file), created: f.before === null, lines: cap(lines) })
      }
      return out
    },

    /** Put the run's files back, newest first; the hunks where another writer has been since. */
    undo() {
      const undone = [], skipped = []
      for (const [file, f] of [...files].reverse()) {
        if (!f.changes.length) continue
        const rel = relative(root, file)
        const now = look(file)
        if (f.trusted && now === f.after) {
          if (f.before === null) {
            unlinkSync(file)
            // The folders the Write made, by the only mark they leave: empty
            // now. Git holds no empty folder, so none of these was anybody's.
            for (let dir = dirname(file); dir !== root && !outside(root, dir); dir = dirname(dir)) {
              try { rmdirSync(dir) } catch { break }
            }
            undone.push(`${rel} (new, removed)`)
          } else {
            writeFileSync(file, f.before)
            undone.push(rel)
          }
          continue
        }
        if (f.before === null) {
          skipped.push({ file: rel, why: now === null ? 'the file is gone' : 'it is new from this run, and has changed since' })
          continue
        }
        const r = undoEdits(root, f.changes)
        undone.push(...r.undone)
        skipped.push(...r.skipped)
      }
      return { undone, skipped }
    },
  }
}

const textLines = (text) => { const l = String(text).split('\n'); if (l.at(-1) === '') l.pop(); return l }

const MAX_DIFF_LINES = 300
const cap = (lines) => lines.length <= MAX_DIFF_LINES ? lines
  : [...lines.slice(0, MAX_DIFF_LINES), ['…', `${lines.length - MAX_DIFF_LINES} more line(s)`]]

/**
 * A line diff of `before` → `after` as `[op, text]` pairs: `-` removed, `+`
 * added, ` ` context, `…` a run of unchanged lines left out. `before` null is a
 * new file.
 */
export function lineDiff(before, after, context = 3) {
  const a = before == null ? [] : textLines(before), b = textLines(after)
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const x = a.slice(pre, a.length - suf), y = b.slice(pre, b.length - suf)

  const mid = []
  if (x.length * y.length > 4_000_000) {
    mid.push(...x.map(t => ['-', t]), ...y.map(t => ['+', t]))
  } else {
    // Longest common subsequence, walked from the front.
    const w = y.length + 1
    const L = new Uint32Array((x.length + 1) * w)
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--)
        L[i * w + j] = x[i] === y[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1])
    let i = 0, j = 0
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) { mid.push([' ', x[i]]); i++; j++ }
      else if (i < x.length && (j === y.length || L[(i + 1) * w + j] >= L[i * w + j + 1])) mid.push(['-', x[i++]])
      else mid.push(['+', y[j++]])
    }
  }
  const all = [...a.slice(0, pre).map(t => [' ', t]), ...mid, ...a.slice(a.length - suf).map(t => [' ', t])]

  // Keep `context` unchanged lines either side of a change; fold the rest.
  const near = all.map(() => false)
  all.forEach(([op], k) => {
    if (op === ' ') return
    for (let d = Math.max(0, k - context); d <= Math.min(all.length - 1, k + context); d++) near[d] = true
  })
  const out = []
  for (let k = 0; k < all.length; k++) {
    if (near[k]) { out.push(all[k]); continue }
    let n = 0
    while (k < all.length && !near[k]) { n++; k++ }
    k--
    out.push(['…', `${n} unchanged line(s)`])
  }
  return out
}

// ─── text edits ──────────────────────────────────────────────────────────────

// The index just past the `>` closing the tag that opens at `at`. A `>` inside
// a quoted attribute or a `{…}` expression does not close it.
function tagEnd(src, at) {
  let quote = null, depth = 0
  for (let i = at + 1; i < src.length; i++) {
    const c = src[i]
    if (quote) { if (c === quote) quote = null }
    else if (c === '"' || c === "'") quote = c
    else if (c === '{') depth++
    else if (c === '}') depth = Math.max(0, depth - 1)
    else if (c === '>' && !depth) return i + 1
  }
  return src.length
}

// The index just past the `}` closing the expression that opens at `at`.
function braceEnd(src, at) {
  let quote = null, depth = 0
  for (let i = at; i < src.length; i++) {
    const c = src[i]
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null }
    else if (c === '"' || c === "'" || c === '`') quote = c
    else if (c === '{') depth++
    else if (c === '}' && !--depth) return i + 1
  }
  return src.length
}

// What `walk` steps over: a comment, a tag, a script or style block whole, an
// expression. The text between them is what a person reads on the page.
function step(src, i) {
  if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i); return { kind: 'skip', end: e === -1 ? src.length : e + 3 } }
  if (src[i] === '<' && /[A-Za-z/]/.test(src[i + 1] ?? '')) {
    const m = /^<(\/?)([A-Za-z][\w.:-]*)/.exec(src.slice(i, i + 80))
    const end = tagEnd(src, i)
    if (!m) return { kind: 'skip', end }
    if (!m[1] && /^(script|style)$/i.test(m[2])) {
      const close = src.indexOf(`</${m[2]}`, end)
      return { kind: 'skip', end: close === -1 ? src.length : tagEnd(src, close) }
    }
    return { kind: m[1] ? 'close' : src[end - 2] === '/' ? 'empty' : 'open', name: m[2], end }
  }
  if (src[i] === '{') return { kind: 'skip', end: braceEnd(src, i) }
  return null
}

const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i

// The source span of the element whose open tag starts at `at`, or null.
function elementSpan(src, at, name) {
  const first = step(src, at)
  if (!first || first.kind !== 'open' || VOID.test(name)) return null
  let depth = 1
  for (let i = first.end; i < src.length;) {
    const s = step(src, i)
    if (!s) { i++; continue }
    if (s.name === name && s.kind === 'open') depth++
    if (s.name === name && s.kind === 'close' && !--depth) return { start: at, end: s.end }
    i = s.end
  }
  return null
}

// The plain-text runs of src between from and to.
function textRuns(src, from, to) {
  const out = []
  let start = from
  for (let i = from; i < to;) {
    const s = step(src, i)
    if (!s) { i++; continue }
    if (i > start) out.push([start, i])
    i = start = s.end
  }
  if (to > start) out.push([start, to])
  return out
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// The page shows a character the source may have written as an entity:
// `Before &amp; after` reads `Before & after`.
const ENTITIES = {
  '&': ['&amp;', '&#38;'], '<': ['&lt;', '&#60;'], '>': ['&gt;', '&#62;'], '"': ['&quot;', '&#34;'], "'": ['&apos;', '&#39;'],
  '\u00a0': ['&nbsp;', '&#160;'], '—': ['&mdash;'], '–': ['&ndash;'], '…': ['&hellip;'], '©': ['&copy;'],
  '’': ['&rsquo;'], '‘': ['&lsquo;'], '“': ['&ldquo;'], '”': ['&rdquo;'],
}
const charRe = ch => ENTITIES[ch] ? `(?:${[ch, ...ENTITIES[ch]].map(escapeRe).join('|')})` : escapeRe(ch)
// Characters that would turn the new text into an expression or (in Markdown)
// emphasis, a link or HTML. A text edit carrying one is a change to the
// source's structure, which is the model's job. In a `.mesa` template the
// three HTML has entities for are written as entities instead.
const MARKUP = { mesa: /[{}]/, md: /[<>{}*_`[\]\\]/ }
const encode = { mesa: t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'), md: t => t }

/**
 * Where to swap `old` for `next` in a source file, and `text`, the new text as
 * the source writes it — or `{ why }` when it cannot
 * be done without guessing. `line`/`col` is the element's `data-fjs-loc` and
 * `tag` its name; a `.mesa` element is searched between its own open and close
 * tags. A `.md` loc names the Markdown's generated template rather than the file,
 * so there the whole body is searched. Whitespace in `old` matches any run of
 * it, since the page collapsed what the source wrapped.
 */
export function locateText(src, { ext, line, col, tag, old, next }) {
  const words = String(old ?? '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return { why: 'the element has no text of its own' }
  if (MARKUP[ext]?.test(next)) return { why: 'the new text holds markup characters' }

  let from = 0, to = src.length
  if (ext === 'mesa') {
    const lines = src.split('\n')
    if (line < 1 || line > lines.length) return { why: 'the source has changed since the page was built' }
    const lineStart = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0)
    const lineText = lines[line - 1]
    const open = new RegExp(`<${escapeRe(tag)}(?![\\w.:-])`, 'g')
    let at = lineText.slice(col - 1).match(new RegExp(`^<${escapeRe(tag)}(?![\\w.:-])`)) ? col - 1 : lineText.search(open)
    if (at === -1) return { why: 'the element is not where the page says it was written' }
    const span = elementSpan(src, lineStart + at, tag)
    if (!span) return { why: 'the element has no closing tag to search up to' }
    from = span.start
    to = span.end
  } else {
    from = src.length - splitFrontmatter(src).body.length
  }

  // A word boundary at each end where the text has one, so `Item` is not found
  // inside `Items`.
  const edge = (w, side) => /\w/.test(side === 'start' ? w[0] : w.at(-1)) ? (side === 'start' ? '(?<!\\w)' : '(?!\\w)') : ''
  const re = new RegExp(edge(words[0], 'start') + words.map(w => [...w].map(charRe).join('')).join('\\s+') + edge(words.at(-1), 'end'), 'g')
  const hits = []
  for (const [a, b] of textRuns(src, from, to))
    for (const m of src.slice(a, b).matchAll(re)) hits.push({ start: a + m.index, end: a + m.index + m[0].length })
  if (!hits.length) return { why: 'the text is not written in the source — it is interpolated, or split by markup' }
  if (hits.length > 1) return { why: `the text occurs ${hits.length} times where the element was written` }
  return { start: hits[0].start, end: hits[0].end, from, to, text: encode[ext](next) }
}

// A loc ends up in the prompt as a path to open, and `ask-context.js` reads
// the file it names; one that is not a relative path to a compiled source is
// dropped, and its HTML still goes as context.
const readLoc = loc => typeof loc === 'string' && LOC.test(loc) && !loc.includes('..') ? loc : null

function readPicks(list = []) {
  return (list ?? []).map(p => ({
    loc:     readLoc(p?.loc),
    html:    typeof p?.html === 'string' ? p.html : '',
    size:    Number(p?.size) || 0,
    repeats: Math.max(0, Math.floor(Number(p?.repeats) || 0)),
    inner:   Array.isArray(p?.inner) ? p.inner.slice(0, MAX_INNER).map(readLoc).filter(Boolean) : [],
  }))
}

// A chip is a key into `EDIT_KINDS`/`EDIT_SCOPES`; anything else is refused by
// name rather than dropped, so a panel and a server out of step say so.
function readChips(body) {
  const { kind = null, scope = null } = body
  if (kind != null && !Object.hasOwn(EDIT_KINDS, kind)) return { error: `no such kind of change: ${String(kind).slice(0, 40)}` }
  if (scope != null && !Object.hasOwn(EDIT_SCOPES, scope)) return { error: `no such scope: ${String(scope).slice(0, 40)}` }
  return { kind, scope }
}

/** `[{ type, data }]`, data base64 with no `data:` prefix, or `{ error }`. */
export function readImages(list) {
  if (list == null) return []
  if (!Array.isArray(list)) return { error: 'images is a list' }
  if (list.length > MAX_IMAGES) return { error: `at most ${MAX_IMAGES} images in one ask` }
  const out = []
  for (const [i, img] of list.entries()) {
    const type = String(img?.type ?? ''), data = img?.data
    if (!IMAGE_TYPES.includes(type)) return { error: `image ${i + 1} is ${type.slice(0, 40) || 'of no type'} — paste a PNG, JPEG, GIF or WebP` }
    if (typeof data !== 'string' || !BASE64.test(data)) return { error: `image ${i + 1} is not base64` }
    if (data.length > MAX_IMAGE) return { error: `image ${i + 1} is over ${MAX_IMAGE >> 20}MB` }
    out.push({ type, data })
  }
  return out
}

function readJson(req, limit = MAX_BODY) {
  return new Promise((ok, no) => {
    let size = 0, body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) { no(new Error('request too large')); req.destroy() }
      else body += chunk
    })
    req.on('end', () => { try { ok(JSON.parse(body || '{}')) } catch { no(new Error('not JSON')) } })
    req.on('error', no)
  })
}

function reply(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

// ─── submit ──────────────────────────────────────────────────────────────────

const sh = (cmd, args, cwd) => new Promise(ok => execFile(cmd, args, { cwd, maxBuffer: 8 << 20 }, (err, stdout, stderr) =>
  ok({ ok: !err, out: String(stdout ?? ''), err: String(stderr || err?.message || '').trim() })))

const tail = text => text.split('\n').slice(-5).join('\n')

/** Each path `git status --porcelain=v1 -z` names, relative to the checkout's top. */
export function dirtyPaths(status) {
  const parts = status.split('\0').filter(Boolean)
  const out = []
  for (let i = 0; i < parts.length; i++) {
    out.push(parts[i].slice(3))
    // A rename or copy names its source next, and a rename's source is a deletion.
    if (parts[i][0] === 'R' || parts[i][0] === 'C') out.push(parts[++i])
  }
  return out
}

/** The pull request's title and body, from the asks that made its changes. */
export function submission({ preview, asks }) {
  const first = String(asks[0]?.instruction ?? 'Changes').replace(/\s+/g, ' ').trim()
  const title = (first.length > 64 ? first.slice(0, 63) + '…' : first) + (asks.length > 1 ? ` (+${asks.length - 1} more)` : '')
  const body = [
    `Asked for on the preview at ${preview}, through the ask panel.`,
    '',
    ...asks.map(a => `- ${a.instruction}${a.session ? ` (session \`${a.session}\`)` : ''}`),
  ].join('\n')
  return { title, body }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.bin]       the claude executable — a test hands a fake one
 * @param {string} [opts.gh]        the gh executable, likewise
 * @param {string} [opts.tokenKey]  the localStorage key the app's client keeps its token under
 * @param {object|null} [opts.admit]  who may ask; `readAdmit()` of the environment by default
 */
export function askPlugin({ bin = 'claude', gh = 'gh', tokenKey = 'junction_token', admit = readAdmit() } = {}) {
  let root = process.cwd()
  let current = null           // { child, run } — one question at a time
  const runs = new Map()       // run id → the edits that landed, for an undo
  // What Submit commits and describes, kept past the undo window: a file is the
  // panel's while a run not undone changed it, and each such run is a PR line.
  const touched = new Map()    // abs path → how many of those runs changed it
  const asks = new Map()       // run id → { instruction, session }
  let waiting = []             // asks committed, and not yet in a pull request
  let submitting = false
  let seq = 0
  // A run id outlives this process in the page's saved log; after a restart the
  // count starts again, and a bare number would undo some other run.
  const boot = randomUUID().slice(0, 8)

  async function ask(req, res) {
    if (current) return reply(res, 409, { error: 'Claude is already working on a change — stop it first' })
    let body
    try { body = await readJson(req, ASK_BODY) } catch (e) { return reply(res, 400, { error: e.message }) }
    const instruction = String(body.instruction ?? '').trim()
    if (!instruction) return reply(res, 400, { error: 'say what to change' })
    const images = readImages(body.images)
    if (images.error) return reply(res, 400, { error: images.error })
    if (body.picks != null && !Array.isArray(body.picks)) return reply(res, 400, { error: 'picks is a list' })
    if ((body.picks ?? []).length > MAX_PICKS) return reply(res, 400, { error: `at most ${MAX_PICKS} elements in one ask` })
    const chips = readChips(body)
    if (chips.error) return reply(res, 400, { error: chips.error })
    const { picks, data } = askContext(root, readPicks(body.picks))

    const run = `${boot}.${++seq}`
    const ledger = createLedger(root)
    let session = null
    res.statusCode = 200
    res.setHeader('content-type', 'application/x-ndjson')
    res.setHeader('cache-control', 'no-store')
    const send = e => { if (!res.writableEnded) res.write(JSON.stringify(e) + '\n') }
    send({ type: 'run', id: run })

    const out = runAsk({
      root, bin,
      edit:    root,
      session: body.session || null,
      images,
      prompt:  editPrompt({ instruction, picks, data, ...chips, page: body.page, followUp: !!body.session, images: images.length }),
      onEvent: e => {
        if (e.type === 'read' || e.type === 'edit' || e.type === 'write') return ledger.see(e)
        if (e.type === 'session') session = e.id
        if (e.type === 'landed' || e.type === 'refused') return ledger.result(e)
        if (e.type === 'result') {
          e.edits = ledger.count
          if (e.edits) send({ type: 'diff', files: ledger.diff() })
        }
        send(e)
      },
    })
    if (out.error) { send({ type: 'error', text: out.error }); return res.end() }
    current = { child: out.child, run }
    // A closed tab is a stop: nobody is left to read the answer or undo it.
    res.on('close', () => { if (current?.run === run) stop() })
    await out.done
    if (current?.run === run) current = null
    hold(run, ledger, { instruction, session })
    res.end()
  }

  function hold(run, ledger, ask) {
    runs.set(run, ledger)
    if (runs.size > 20) runs.delete(runs.keys().next().value)
    if (!ledger.count) return
    for (const f of ledger.touched()) touched.set(f, (touched.get(f) ?? 0) + 1)
    asks.set(run, ask)
  }

  function release(run, ledger) {
    for (const f of ledger.touched()) {
      const n = (touched.get(f) ?? 1) - 1
      if (n > 0) touched.set(f, n)
      else touched.delete(f)
    }
    asks.delete(run)
  }

  // The edit a person typed, made without a model when it can be made without
  // guessing. `{ fallback }` hands it back to the panel to ask Claude instead.
  async function text(req, res) {
    if (current) return reply(res, 409, { error: 'Claude is already working on a change — stop it first' })
    let body
    try { body = await readJson(req) } catch (e) { return reply(res, 400, { error: e.message }) }
    const { loc, tag, old } = body
    const next = String(body.new ?? '').replace(/\s*\n\s*/g, ' ').trim()
    if (typeof loc !== 'string' || !LOC.test(loc) || loc.includes('..')) return reply(res, 400, { error: 'no source location to edit' })
    if (typeof tag !== 'string' || !/^[A-Za-z][\w.:-]*$/.test(tag)) return reply(res, 400, { error: 'no element name' })
    if (typeof old !== 'string' || old.length > MAX_TEXT || next.length > MAX_TEXT) return reply(res, 400, { error: `text is at most ${MAX_TEXT} characters` })
    if (!next) return reply(res, 200, { fallback: 'the new text is empty' })
    const [, path, ext, line, col] = /^(.+\.(mesa|md)):(\d+):(\d+)$/.exec(loc)
    const file = resolve(root, path)
    if (outside(root, file) || !existsSync(file)) return reply(res, 404, { error: `no ${path} under the app` })

    const src = readFileSync(file, 'utf8')
    const at = locateText(src, { ext, line: Number(line), col: Number(col), tag, old, next })
    if (at.why) return reply(res, 200, { fallback: at.why })

    // The hunk is the whole region searched, not the words: it is what an undo
    // finds the change by after another writer has been in the file, and the
    // words alone may occur elsewhere in it.
    const after = src.slice(0, at.start) + at.text + src.slice(at.end)
    const hunk = { old: src.slice(at.from, at.to), new: after.slice(at.from, at.to + at.text.length - (at.end - at.start)) }
    const run = `${boot}.${++seq}`
    const ledger = createLedger(root)
    ledger.see({ type: 'read', file })
    ledger.see({ type: 'edit', id: 'text', file, ...hunk, all: false })
    writeFileSync(file, after)
    ledger.result({ type: 'landed', id: 'text' })
    hold(run, ledger, { instruction: `Text: “${old.replace(/\s+/g, ' ').trim()}” → “${next}”`, session: null })
    return reply(res, 200, { run, files: ledger.diff() })
  }

  // The conversation, moved to a terminal: the command that resumes it, or,
  // before there is one to resume, what a first ask would have said, with each
  // source made absolute so it reads the same from any directory.
  async function handoff(req, res) {
    let body
    try { body = await readJson(req) } catch (e) { return reply(res, 400, { error: e.message }) }
    if (body.session) {
      const command = resumeCommand(root, body.session)
      return command ? reply(res, 200, { command }) : reply(res, 400, { error: 'not a session id' })
    }
    if (body.picks != null && !Array.isArray(body.picks)) return reply(res, 400, { error: 'picks is a list' })
    if ((body.picks ?? []).length > MAX_PICKS) return reply(res, 400, { error: `at most ${MAX_PICKS} elements in one ask` })
    const chips = readChips(body)
    if (chips.error) return reply(res, 400, { error: chips.error })
    const { picks, data } = askContext(root, readPicks(body.picks), { absolute: true })
    const instruction = String(body.instruction ?? '').trim()
    if (!instruction && !picks.length) return reply(res, 400, { error: 'pick an element or say what to change' })
    return reply(res, 200, { text: editPrompt({ instruction, picks, data, ...chips, page: body.page, followUp: true }) })
  }

  async function branch() {
    const r = await sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root)
    if (!r.ok) return { name: null, why: 'the app is not in a git checkout' }
    const name = r.out.trim()
    return name.startsWith('wb/') ? { name } : { name, why: `${name} is not a Workbench branch (wb/…)` }
  }

  // Commit what the panel changed, push, and open the pull request — or answer
  // the one already open for the branch, which the push has just updated.
  async function submit(req, res) {
    const b = await branch()
    if (b.why) return reply(res, 409, { error: `nothing to submit to — ${b.why}` })
    const scope = previewScope(root, root)
    if (scope.preview && scope.why) return reply(res, 409, { error: `cannot grade this preview — ${scope.why}` })
    if (scope.preview && scope.outside.length) {
      return reply(res, 409, { error: `a preview changes ${relative(scope.top, root) || '.'}/ and nothing else — this branch changes more against ${scope.into}`, files: scope.outside.slice(0, 20) })
    }
    const top = (await sh('git', ['rev-parse', '--show-toplevel'], root)).out.trim()
    const st = await sh('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], top)
    if (!st.ok) return reply(res, 500, { error: tail(st.err) })
    const dirty = dirtyPaths(st.out)
    const others = dirty.filter(p => !touched.has(resolve(top, p)))
    if (others.length) {
      return reply(res, 409, { error: 'files this panel did not change are changed too — commit them or put them back first', files: others.slice(0, 20) })
    }
    if (!dirty.length && !waiting.length) return reply(res, 400, { error: 'nothing to submit — no change from this panel is waiting' })

    const preview = req.headers.origin
    if (dirty.length) {
      const list = [...asks.values()]
      const { title, body } = submission({ preview, asks: list })
      const add = await sh('git', ['add', '--', ...dirty], top)
      if (!add.ok) return reply(res, 500, { error: tail(add.err) })
      const commit = await sh('git', ['commit', '-m', title, '-m', body], top)
      if (!commit.ok) return reply(res, 500, { error: tail(commit.err) })
      touched.clear()
      asks.clear()
      waiting.push(...list)
    }
    const push = await sh('git', ['push', '-u', 'origin', 'HEAD'], top)
    if (!push.ok) return reply(res, 502, { error: `committed, and the push failed — Submit again to retry:\n${tail(push.err)}` })

    const open = await sh(gh, ['pr', 'view', b.name, '--json', 'url', '--jq', '.url'], top)
    if (open.ok && open.out.trim()) {
      waiting = []
      return reply(res, 200, { pr: open.out.trim(), created: false, files: dirty })
    }
    const { title, body } = submission({ preview, asks: waiting })
    // The branch it was graded against, so the review is of the diff that passed.
    const into = scope.preview ? ['--base', scope.into.replace(/^origin\//, '')] : []
    const made = await sh(gh, ['pr', 'create', '--head', b.name, ...into, '--title', title, '--body', body], top)
    if (!made.ok) return reply(res, 502, { error: `pushed, and gh pr create failed — Submit again to retry:\n${tail(made.err)}` })
    waiting = []
    return reply(res, 200, { pr: made.out.trim().split('\n').pop(), created: true, files: dirty })
  }

  function stop() {
    if (!current) return false
    try { process.kill(-current.child.pid, 'SIGTERM') } catch {}
    current = null
    return true
  }

  return {
    name:  'fli:ask',
    apply: 'serve',

    configResolved(config) { root = resolve(config.root ?? process.cwd()) },

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? '').split('?')[0]
        if (!path.startsWith('/__fjs/ask')) return next()
        if (req.method !== 'POST') return reply(res, 405, { error: 'POST only' })
        if (!sameOrigin(req)) return reply(res, 403, { error: 'only a page this dev server served may ask' })
        const refused = await admitCaller(req, admit)
        if (refused) return reply(res, refused.status, { error: refused.error })
        if (path === '/__fjs/ask') return ask(req, res)
        if (path === '/__fjs/ask/text') return text(req, res)
        if (path === '/__fjs/ask/handoff') return handoff(req, res)
        if (path === '/__fjs/ask/stop') return reply(res, 200, { stopped: stop() })
        if (path === '/__fjs/ask/status') {
          const b = await branch()
          return reply(res, 200, { branch: b.name, submit: !b.why })
        }
        if (path === '/__fjs/ask/submit') {
          if (current) return reply(res, 409, { error: 'Claude is still working on a change — let it finish or stop it first' })
          if (submitting) return reply(res, 409, { error: 'a submit is already running' })
          submitting = true
          try { return await submit(req, res) } finally { submitting = false }
        }
        if (path === '/__fjs/ask/undo') {
          let body
          try { body = await readJson(req) } catch (e) { return reply(res, 400, { error: e.message }) }
          const ledger = runs.get(String(body.run))
          if (!ledger) return reply(res, 404, { error: 'no such run — the dev server restarted, or it was too long ago' })
          runs.delete(String(body.run))
          release(String(body.run), ledger)
          return reply(res, 200, ledger.undo())
        }
        return next()
      })
    },

    resolveId(id) { return id === CLIENT_ID ? RESOLVED_ID : null },
    load(id) {
      if (id !== RESOLVED_ID) return null
      return `const ASK = ${JSON.stringify({ tokenKey })}\n` + readFileSync(CLIENT_FILE, 'utf8')
    },

    transformIndexHtml() {
      return [{ tag: 'script', attrs: { type: 'module', src: CLIENT_ID }, injectTo: 'body' }]
    },
  }
}
