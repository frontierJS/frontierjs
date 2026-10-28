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

import { readFileSync } from 'node:fs'
import { join }         from 'node:path'

import { readRegisters, withRegisterGuard, requirePrefix, findIssue, splitRow } from './registers.js'
import { checkedEdit, oneCell, isoDate } from './register-edit.js'

/**
 * Close one open issue.
 *
 * Answers `{ ok: true, id, file, line }` or `{ ok: false, reason }` — a refusal
 * is an answer rather than a throw, because the caller shows it to a person.
 */
export function closeIssue(opts) {
  return withRegisterGuard(opts.root, () => closeUnguarded(opts))
}

function closeUnguarded({ root, id, how, dry = false, today = new Date() }) {
  const noPrefix = requirePrefix(root)
  if (noPrefix) return refuse(noPrefix)

  const record = findIssue(readRegisters(root), id)
  if (!record)       return refuse(`no issue row has the id ${String(id ?? '').trim().toUpperCase() || '(none)'}`)
  if (record.closed) return refuse(`${record.id} is already closed (${record.file}:${record.line})`)

  const reason = oneCell(how)
  if (!reason) return refuse('--how is required: what changed, and how it was proven')

  const abs    = join(root, record.file)
  const before = readFileSync(abs, 'utf8')
  const moved  = moveToClosed(before, record, reason, today)
  if (moved.reason) return refuse(moved.reason)

  // register:check grades the file on disk, so a preview skips it, as `fli file` does.
  if (dry) return { ok: true, dry: true, id: record.id, file: record.file, line: moved.line }

  const done = checkedEdit(root, 'close', write => write(abs, moved.text))
  if (!done.ok) return done

  return { ok: true, id: record.id, file: record.file, line: moved.line }
}

/**
 * The move itself, on the text of the row's file: `{ text, line }`, or
 * `{ reason }` when the row or § Closed is not where the record says. Checked
 * and written by the caller, so `decide` can close a question's row in the same
 * act as the ruling that answers it.
 */
export function moveToClosed(src, record, how, today = new Date()) {
  const lines = src.split('\n')
  const at    = record.line - 1
  const cells = splitRow(lines[at] ?? '')
  if (cells.length < 4) return { reason: `${record.file}:${record.line} no longer reads as ${record.id}'s row — reread it` }

  const links = [...linksIn(cells[cells.length - 1])]
  const row   = [
    cells[0],
    cells[1] ? `${cells[1]} — ${cells[2]}` : cells[2],
    isoDate(today),
    [oneCell(how), ...links].join(' · '),
  ]

  lines.splice(at, 1)
  const insertAt = closedTableBody(lines)
  if (insertAt === -1) return { reason: `${record.file} has no § Closed table to move the row into` }
  lines.splice(insertAt, 0, `| ${row.join(' | ')} |`)
  return { text: lines.join('\n'), line: insertAt + 1 }
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

function* linksIn(cell = '') {
  for (const m of cell.matchAll(/\[[^\]]*\]\([^)]+\)/g)) yield m[0]
}
