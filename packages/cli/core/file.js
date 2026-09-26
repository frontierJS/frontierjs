// ─── file.js — filing a new issue row ────────────────────────────────────────
//
// The writer behind `fli register:file`, and `close.js`'s other half. With no
// writer, a new row was a hand edit: an agent read `ISSUES.md` to find the
// highest id, the table and its column order, then patched the file with a
// script — three turns per row, and a row pasted from the wrong table reads as
// a status nobody wrote (`row-shape`).
//
// ── What it writes ──────────────────────────────────────────────────────────
//
// One row at the top of the `## S<n>` table its severity names, in the open
// shape — `Id | Area | Title | Status | Verified | Detail` — status `open`,
// verified today. The id is one past the highest the registers hold ANYWHERE,
// § Closed and the archive included, since an id is never reused; its digits
// are padded to the width the project already writes (`ELA-001`).
//
// Severity `decision` is a question instead: a row in § Needs a decision,
// `Id | Area | Question | Detail`, under the next `<PREFIX>-D` id — the id its
// ruling will carry, since `decide` answers a bullet naming the row under the
// row's own id and closes it.
//
// `blocks` names an open row the new one holds up, and writes `blocked by
// <new id>` into that row's Detail in the same act. `fli next` sets it aside
// until the new row closes, and nothing else has to be edited when it does.
//
// `register:check` grades the result, and a write it finds a new error in is
// put back and refused — which is also what catches two sessions filing the
// same next id at once.
//
// Zero dependencies, plain ESM, node or bun — same rule as its neighbors.

import { readFileSync, writeFileSync } from 'node:fs'
import { join }                        from 'node:path'

import { readRegisters }        from './registers.js'
import { errorKeys, newErrors } from './register-check.js'
import { oneCell, isoDate }     from './close.js'
import { nextDecisionNumber }   from './decide.js'

const SEVERITIES     = ['S1', 'S2', 'S3', 'S4', 'DECISION']
const OPEN_WIDTH     = 6
const QUESTION_WIDTH = 4

/**
 * File one issue.
 *
 * Answers `{ ok: true, id, file, line }` or `{ ok: false, reason }`.
 */
export function fileIssue({ root, severity, area, title, detail, blocks, today = new Date() }) {
  const doc = readRegisters(root)
  if (!doc.prefix) return refuse('package.json declares no usable registers.prefix, so no id can be minted')

  const sev = String(severity ?? '').trim().toUpperCase()
  if (!SEVERITIES.includes(sev)) return refuse(`--sev must be one of S1, S2, S3, S4, decision`)
  const question = sev === 'DECISION'

  const cells = { area: oneCell(area), title: oneCell(title), detail: oneCell(detail) }
  for (const [name, value] of Object.entries(cells)) {
    if (!value) return refuse(`--${name} is required`)
  }

  const abs = join(doc.dir, 'ISSUES.md')
  let before
  try { before = readFileSync(abs, 'utf8') } catch { return refuse(`no ISSUES.md at ${abs}`) }

  const lines = before.split('\n')
  const table = question ? sectionTable(lines, /^Needs a decision\b/i) : sectionTable(lines, new RegExp(`^${sev}\\b`, 'i'))
  const where = question ? 'Needs a decision' : sev
  const width = question ? QUESTION_WIDTH : OPEN_WIDTH
  if (!table) return refuse(`ISSUES.md has no \`## ${where}\` table to file into`)
  if (table.width !== width) return refuse(`the ${where} table has ${table.width} columns, not the ${width} its rows carry`)

  const id  = question ? `${doc.prefix}-D${nextDecisionNumber(root)}` : nextId(doc)
  const row = question
    ? [`<a id="${id.toLowerCase()}"></a>${id}`, cells.area, `**${cells.title}**`, cells.detail]
    : [`<a id="${id.toLowerCase()}"></a>${id}`, cells.area, `**${cells.title}**`, 'open', isoDate(today), cells.detail]

  // Before the new row goes in, so the held row's line number is still its own.
  if (blocks) {
    const want = String(blocks).trim().toUpperCase()
    const held = doc.issues.find(r => r.id.toUpperCase() === want || (r.aliases ?? []).some(a => a.toUpperCase() === want))
    if (!held)       return refuse(`--blocks: no issue row has the id ${want}`)
    if (held.closed) return refuse(`--blocks: ${held.id} is closed, so nothing waits on the new row`)
    if (join(root, held.file) !== abs) return refuse(`--blocks: ${held.id} is not in ISSUES.md`)
    const at = held.line - 1
    if (!lines[at]?.includes(held.id)) return refuse(`--blocks: ISSUES.md:${held.line} no longer reads as ${held.id}'s row — reread it`)
    lines[at] = lines[at].replace(/\s*\|\s*$/, ` · blocked by \`${id}\` |`)
  }

  lines.splice(table.body, 0, `| ${row.join(' | ')} |`)

  const baseline = errorKeys(root)
  writeFileSync(abs, lines.join('\n'))

  const added = newErrors(baseline, root)
  if (added.length) {
    writeFileSync(abs, before)
    return refuse(`the row was put back: register:check found ${added.map(f => `${f.rule} — ${f.message}`).join('; ')}`)
  }

  return { ok: true, id, file: abs.slice(root.length + 1), line: table.body + 1, blocks: blocks ? String(blocks).trim().toUpperCase() : null }
}

// ─── the id ───────────────────────────────────────────────────────────────────

export function nextId(doc) {
  const pattern = new RegExp(`^${doc.prefix}-(\\d+)$`)
  let max = 0, width = 1
  for (const r of doc.issues) {
    for (const id of [r.id, ...(r.aliases ?? [])]) {
      const m = pattern.exec(id)
      if (!m) continue
      max   = Math.max(max, Number(m[1]))
      width = Math.max(width, m[1].length)
    }
  }
  return `${doc.prefix}-${String(max + 1).padStart(width, '0')}`
}

// ─── where the row goes ───────────────────────────────────────────────────────

// The first line under the separator of the table below the `##` heading the
// pattern names: the open tables run newest first.
function sectionTable(lines, pattern) {
  let inSection = false
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^##\s+(.+?)\s*$/)
    if (heading) { inSection = pattern.test(heading[1]); continue }
    if (!inSection) continue
    if (/^\|\s*Id\s*\|/i.test(lines[i]) && /^\|\s*:?-{3,}/.test(lines[i + 1] ?? '')) {
      return { body: i + 2, width: lines[i].replace(/^\s*\||\|\s*$/g, '').split('|').length }
    }
  }
  return null
}

function refuse(reason) { return { ok: false, reason } }
