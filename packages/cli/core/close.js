// ─── close.js — closing an issue the registers hold ──────────────────────────
//
// The one writer behind `fli register:close`. Closing is a MOVE, not a status:
// the row leaves its open table and is prepended to § Closed in that table's
// shape — `Id | Title | Closed | How` — so a stale document naming the id still
// resolves, now with what fixed it beside it. `register:check` grades the
// result, and a write it finds a new error in is put back and refused.
//
// ── What the closed row keeps ────────────────────────────────────────────────
//
// The id cell verbatim (its anchor is what every link to the row resolves to).
// The title with the area folded in front of it, which is how § Closed carries
// the column it does not have. The How is the caller's sentence, followed by
// every link the Detail cell held — the Detail was the one place the row said
// where the defect lived, and a closed row with no path in it cannot be traced.
//
// ── What it refuses ─────────────────────────────────────────────────────────
//
// An id no open row holds, an id already closed, an empty `how`, a register
// with no § Closed table, and a project with no declared prefix. Aging rows out
// to `ISSUES_ARCHIVE.md` is not done here; that is a trim, not a close.
//
// Zero dependencies, plain ESM, node or bun — same rule as its neighbors.

import { readFileSync, writeFileSync } from 'node:fs'
import { join }                        from 'node:path'

import { readRegisters }          from './registers.js'
import { errorKeys, newErrors }   from './register-check.js'

/**
 * Close one open issue.
 *
 * Answers `{ ok: true, id, file, line }` or `{ ok: false, reason }` — a refusal
 * is an answer rather than a throw, because the caller shows it to a person.
 */
export function closeIssue({ root, id, how, today = new Date() }) {
  const doc = readRegisters(root)
  if (!doc.prefix) return refuse('package.json declares no usable registers.prefix, so no row can be read')

  const want   = String(id ?? '').trim().toUpperCase()
  const record = doc.issues.find(r => r.id.toUpperCase() === want || (r.aliases ?? []).some(a => a.toUpperCase() === want))
  if (!record)       return refuse(`no issue row has the id ${want || '(none)'}`)
  if (record.closed) return refuse(`${record.id} is already closed (${record.file}:${record.line})`)

  const reason = oneCell(how)
  if (!reason) return refuse('--how is required: what changed, and how it was proven')

  const abs    = join(root, record.file)
  const before = readFileSync(abs, 'utf8')
  const lines  = before.split('\n')
  const at     = record.line - 1
  const cells  = splitRow(lines[at] ?? '')
  if (cells.length < 4) return refuse(`${record.file}:${record.line} no longer reads as ${record.id}'s row — reread it`)

  const links = [...linksIn(cells[cells.length - 1])]
  const row   = [
    cells[0],
    cells[1] ? `${cells[1]} — ${cells[2]}` : cells[2],
    isoDate(today),
    [reason, ...links].join(' · '),
  ]

  lines.splice(at, 1)
  const insertAt = closedTableBody(lines)
  if (insertAt === -1) return refuse(`${record.file} has no § Closed table to move the row into`)
  lines.splice(insertAt, 0, `| ${row.join(' | ')} |`)

  const baseline = errorKeys(root)
  writeFileSync(abs, lines.join('\n'))

  const added = newErrors(baseline, root)
  if (added.length) {
    writeFileSync(abs, before)
    return refuse(`the close was put back: register:check found ${added.map(f => `${f.rule} — ${f.message}`).join('; ')}`)
  }

  return { ok: true, id: record.id, file: record.file, line: insertAt + 1 }
}

// ─── where the row goes ───────────────────────────────────────────────────────

// The first line under § Closed's table separator: the section runs newest
// first, so a new closure is its top row.
function closedTableBody(lines) {
  let inClosed = false
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^##\s+(.+?)\s*$/)
    if (heading) { inClosed = /^Closed/i.test(heading[1]); continue }
    if (!inClosed) continue
    if (/^\|\s*Id\s*\|/i.test(lines[i]) && /^\|\s*:?-{3,}/.test(lines[i + 1] ?? '')) return i + 2
  }
  return -1
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function refuse(reason) { return { ok: false, reason } }

// Unescaped pipes only, the same split `registers.js` reads the row with.
function splitRow(line) {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split(/(?<!\\)\|/)
    .map(c => c.trim())
}

// A cell is one line, and a bare `|` would end it.
function oneCell(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().replace(/(?<!\\)\|/g, '\\|')
}

function* linksIn(cell = '') {
  for (const m of cell.matchAll(/\[[^\]]*\]\([^)]+\)/g)) yield m[0]
}

// UTC, for the reason `decide.js` gives: the date is written into a register
// and read by everybody afterwards.
function isoDate(d) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}
