// ─── amend.js — adding to an open issue row ──────────────────────────────────
//
// The writer behind `fli register:amend`, and the third of `file.js` and
// `close.js`. A second sighting, a narrower repro or a new link belongs on the
// row that already names the defect, and with no writer that was a Python
// heredoc patching one line of a 2.3 MB file by string match (`FJS-1546`).
//
// ── What it writes ──────────────────────────────────────────────────────────
//
// `--detail` APPENDED to the Detail cell after ` · ` — the register's own
// separator — never a replacement, because what the row already says is how it
// was measured and an amend that can drop it loses the evidence. On an open row
// the Verified cell becomes today: an amend is a fresh sighting of the defect,
// which is what that column dates. A § Needs a decision row has no Verified
// column and takes the append alone.
//
// `drop` is the one removal: a whole ` · ` segment equal to it, backticks
// aside. `register:repro` is its caller — a measurement that finds code strips
// `env: timing` in the same write that records why (`FJS-D1146`).
//
// ── What it refuses ─────────────────────────────────────────────────────────
//
// An id no row holds, and a CLOSED row — a defect that came back is a new row
// citing the old one (`fli file`), since § Closed is the record of what was
// fixed and when. `register:check` grades the result, and a write it finds a new
// error in is put back and refused.
//
// Zero dependencies, plain ESM, node or bun — same rule as its neighbors.

import { readFileSync, writeFileSync } from 'node:fs'
import { join }                        from 'node:path'

import { readRegisters, withRegisterGuard }                 from './registers.js'
import { errorKeys, newErrors }          from './register-check.js'
import { oneCell, isoDate, splitRow }    from './close.js'

/**
 * Amend one open issue row.
 *
 * Answers `{ ok: true, id, file, line, dropped }` or `{ ok: false, reason }`;
 * `dropped` is whether `drop` named a segment the row had.
 */
export function amendIssue(opts) {
  return withRegisterGuard(opts.root, () => amendUnguarded(opts))
}

function amendUnguarded({ root, id, detail, drop = null, today = new Date() }) {
  const doc = readRegisters(root)
  if (!doc.prefix) return refuse('package.json declares no usable registers.prefix, so no row can be read')

  const want   = String(id ?? '').trim().toUpperCase()
  const record = doc.issues.find(r => r.id.toUpperCase() === want || (r.aliases ?? []).some(a => a.toUpperCase() === want))
  if (!record)       return refuse(`no issue row has the id ${want || '(none)'}`)
  if (record.closed) return refuse(`${record.id} is closed (${record.file}:${record.line}) — a defect that came back is a new row citing it: fli file`)

  const added = oneCell(detail)
  if (!added) return refuse('--detail is required: what was found, and where')

  const abs    = join(root, record.file)
  const before = readFileSync(abs, 'utf8')
  const lines  = before.split('\n')
  const at     = record.line - 1
  const cells  = splitRow(lines[at] ?? '')
  if (!lines[at]?.includes(record.id) || cells.length < 4) {
    return refuse(`${record.file}:${record.line} no longer reads as ${record.id}'s row — reread it`)
  }

  const last = cells.length - 1
  const kept = dropSegment(cells[last], drop)
  cells[last] = kept.text && kept.text !== '—' ? `${kept.text} · ${added}` : added
  // The open shape is `Id | Area | Title | Status | Verified | Detail`.
  if (cells.length >= 6) cells[4] = isoDate(today)
  lines[at] = `| ${cells.join(' | ')} |`

  const baseline = errorKeys(root)
  writeFileSync(abs, lines.join('\n'))

  const found = newErrors(baseline, root)
  if (found.length) {
    writeFileSync(abs, before)
    return refuse(`the amend was put back: register:check found ${found.map(f => `${f.rule} — ${f.message}`).join('; ')}`)
  }

  return { ok: true, id: record.id, file: record.file, line: record.line, dropped: kept.dropped }
}

function dropSegment(text, drop) {
  const plain = (s) => s.replace(/`/g, '').trim()
  if (!drop || !text) return { text, dropped: false }
  const segments = text.split(' · ')
  const rest     = segments.filter(s => plain(s) !== plain(drop))
  return { text: rest.join(' · '), dropped: rest.length < segments.length }
}

function refuse(reason) { return { ok: false, reason } }
