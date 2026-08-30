// ─── declared backfills ──────────────────────────────────────────────────────
// Which columns this app has a backfill for, read off its own source.
//
// `litestone release` refuses a contract on a required column and hands back
// *expand → backfill → contract*. It grades the two deploys and says the middle
// step is owed, naming the column — and it stops there on purpose: which
// mechanism fills a column is a question about the running application, not
// about the schema, and litestone sits below the package that answers it.
//
// This is that answer. It reads the app the way `fli check`'s thirteen
// source-reading rules do — a line of the app's own code — rather than by
// inventing a directory convention, because the declaration is
// `defineBackfill({ model, field })` wherever the author put it and a rule keyed
// on a path would report a correct app as missing one.
//
// What it cannot see is whether the backfill has RUN. That is a row in the
// deployed database and this command has no target; `app.backfills.status()` and
// `/metrics` are where that is asked.

import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join, relative }                                  from 'path'

const SKIP = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.output', '.vite'])
const CODE = /\.(ts|tsx|js|mjs|cjs|jsx)$/

/** Every `defineBackfill({...})` under `dir`, with where it was found. */
export function declaredBackfills(root, dirs = ['api', 'src', 'app']) {
  const out = []
  for (const d of dirs) walk(join(root, d), 8, (file) => {
    const text = safeText(file)
    if (!text.includes('defineBackfill')) return
    for (const call of callsIn(text)) {
      const found = { ...fieldsOf(call.body), file: relative(root, file) || file, line: lineOf(text, call.at) }
      if (found.model && found.field) out.push(found)
    }
  })
  return out
}

/**
 * Grade a classifier's findings against what the app declares.
 *
 * One row per column that needs filling: `declared` where a `defineBackfill`
 * names that model and field, `missing` where none does. A missing one is not a
 * failure here — the split is a plan and the author may be on step one of it —
 * but it is the difference between advice and a checked sequence, which is the
 * whole reason the fact travels on the finding.
 */
export function backfillReport(findings = [], declared = []) {
  const rows = []
  for (const f of findings) {
    const need = f?.needsBackfill
    if (!need?.model || !need?.field) continue
    if (rows.some(r => r.model === need.model && r.field === need.field)) continue

    const match = declared.find(d => d.model === need.model && d.field === need.field)
    rows.push({
      model: need.model, field: need.field, subject: f.subject ?? `${need.model}.${need.field}`,
      status: match ? 'declared' : 'missing',
      ...(match ? { name: match.name ?? null, file: match.file, line: match.line } : {}),
    })
  }
  return rows
}

/** The report as lines a terminal can print. Empty when nothing needs filling. */
export function formatBackfillReport(rows, { stub = true } = {}) {
  if (!rows.length) return []

  const out = ['The middle step — every column that needs a value before its contract can pass:', '']
  for (const r of rows) {
    out.push(r.status === 'declared'
      ? `  ✓  ${r.subject} — ${r.name ? `'${r.name}' ` : ''}declared in ${r.file}:${r.line}`
      : `  ✗  ${r.subject} — no defineBackfill names this column`)
  }

  const missing = rows.filter(r => r.status === 'missing')
  if (missing.length && stub) {
    const r = missing[0]
    out.push('', '  Declare one, and hand it to the app:', '')
    for (const line of stubFor(r)) out.push(`    ${line}`)
  }

  out.push('', '  Whether it has finished is a row in the deployed database — app.backfills.status().')
  return out
}

/** The smallest thing an author can paste. */
export function stubFor({ model, field }) {
  const name = kebab(`${model}-${field}`)
  return [
    `import { defineBackfill } from '@frontierjs/junction'`,
    ``,
    `export default defineBackfill({`,
    `  name:  '${name}',`,
    `  model: '${model}',`,
    `  field: '${field}',`,
    `  fill:  (row) => /* the value for this row */ null,`,
    `})`,
    ``,
    `// app.configure(backfills([${camel(name)}]))`,
  ]
}

// ─── reading a call ──────────────────────────────────────────────────────────

/**
 * The `{ … }` of every `defineBackfill(` in one file.
 *
 * Braces are counted rather than matched with a regex: a `fill` is a function
 * body and holds braces of its own, so `defineBackfill\({([^}]*)}` stops at the
 * first one inside it and the `field` after it is never seen. Strings are
 * skipped for the same reason in the other direction — a `}` inside a message
 * would close the object early.
 */
function callsIn(text) {
  const out = []
  const re  = /\bdefineBackfill\s*\(\s*\{/g
  let m
  while ((m = re.exec(text))) {
    const open = m.index + m[0].length - 1
    const end  = matchBrace(text, open)
    if (end < 0) continue
    out.push({ at: m.index, body: text.slice(open + 1, end) })
  }
  return out
}

function matchBrace(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === '"' || c === "'" || c === '`') { i = skipString(text, i); continue }
    if (c === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); if (i < 0) return -1; continue }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i); if (i < 0) return -1; i++; continue }
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return -1
}

function skipString(text, at) {
  const quote = text[at]
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue }
    if (text[i] === quote) return i
  }
  return text.length
}

/** `name`, `model` and `field` — the three the classifier can be matched on. */
function fieldsOf(body) {
  const read = (key) => {
    const m = new RegExp(`(^|[\\s,{])${key}\\s*:\\s*(['"\`])(.*?)\\2`).exec(body)
    return m ? m[3] : null
  }
  return { name: read('name'), model: read('model'), field: read('field') }
}

// ─── walking ─────────────────────────────────────────────────────────────────

function walk(dir, depth, fn) {
  if (depth < 0 || !existsSync(dir)) return
  for (const name of safeRead(dir)) {
    if (SKIP.has(name) || name.startsWith('.')) continue
    const child = join(dir, name)
    let st
    try { st = statSync(child) } catch { continue }
    if (st.isDirectory()) walk(child, depth - 1, fn)
    else if (CODE.test(name)) fn(child)
  }
}

const safeRead = (dir) => { try { return readdirSync(dir) } catch { return [] } }
const safeText = (f)   => { try { return readFileSync(f, 'utf8') } catch { return '' } }
const lineOf   = (text, index) => text.slice(0, index).split('\n').length

const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase().replace(/^-|-$/g, '')
const camel = (s) => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
