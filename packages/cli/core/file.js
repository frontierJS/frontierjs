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

import { readFileSync } from 'node:fs'
import { join }         from 'node:path'

import { readRegisters, withRegisterGuard, requirePrefix, findIssue } from './registers.js'
import { envSmells }                     from './register-check.js'
import { checkedEdit, oneCell, isoDate } from './register-edit.js'
import { nextDecisionNumber }   from './decide.js'
import { envCause }             from './next.js'

const SEVERITIES     = ['S1', 'S2', 'S3', 'S4', 'DECISION']
const OPEN_WIDTH     = 6
const QUESTION_WIDTH = 4

/**
 * File one issue.
 *
 * Answers `{ ok: true, id, file, line, smell }` or `{ ok: false, reason }` —
 * `smell` when the title reads like an environment failure and the detail
 * names no `env:` cause.
 */
export function fileIssue(opts) {
  return withRegisterGuard(opts.root, () => fileUnguarded(opts))
}

function fileUnguarded({ root, severity, area, title, detail, blocks, dry = false, today = new Date() }) {
  const noPrefix = requirePrefix(root, 'no id can be minted')
  if (noPrefix) return refuse(noPrefix)
  const doc = readRegisters(root)

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
    const held = findIssue(doc, blocks)
    if (!held)       return refuse(`--blocks: no issue row has the id ${String(blocks).trim().toUpperCase()}`)
    if (held.closed) return refuse(`--blocks: ${held.id} is closed, so nothing waits on the new row`)
    if (join(root, held.file) !== abs) return refuse(`--blocks: ${held.id} is not in ISSUES.md`)
    const at = held.line - 1
    if (!lines[at]?.includes(held.id)) return refuse(`--blocks: ISSUES.md:${held.line} no longer reads as ${held.id}'s row — reread it`)
    lines[at] = lines[at].replace(/\s*\|\s*$/, ` · blocked by \`${id}\` |`)
  }

  lines.splice(table.body, 0, `| ${row.join(' | ')} |`)

  // `env-smell` is a warning, so the write below is never refused for it and
  // the filer would not hear of it until a check they may never run.
  const smell = !question && envCause({ body: cells.detail }) === null && envSmells(cells.title)
  const filed = { id, file: abs.slice(root.length + 1), line: table.body + 1, blocks: blocks ? String(blocks).trim().toUpperCase() : null, smell }

  // `--dry` is on every command, and a preview that files the row hands the
  // next id to a row nobody meant to keep. register:check is skipped: it grades
  // the file on disk, and writing it to grade it is the write being refused.
  if (dry) return { ok: true, dry: true, ...filed }

  const done = checkedEdit(root, 'row', write => write(abs, lines.join('\n')))
  if (!done.ok) return done

  return { ok: true, ...filed }
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

/** The highest issue and decision numbers the registers hold, 0 where there
 *  are none. A row filed after this read is numbered above both, which is how
 *  a workbench step's own rows are told from what was there before it. */
export function registerHigh(root) {
  const doc = readRegisters(root)
  if (!doc.prefix) return { issue: 0, decision: 0 }
  return { issue: Number(nextId(doc).slice(doc.prefix.length + 1)) - 1, decision: nextDecisionNumber(root) - 1 }
}

/** The rows numbered above each span's `from` marks and at or below its
 *  `until` (none: no ceiling) — what a workbench step filed, one read for every
 *  span. A `D` id is one row: the ruling where `decide` has answered it under
 *  that id, else its § Needs a decision row. Questions and rulings first,
 *  then issues, each by number. */
export function filedSince(root, spans) {
  const doc = readRegisters(root)
  if (!doc.prefix) return spans.map(() => [])
  const issueNo = new RegExp(`^${doc.prefix}-(\\d+)$`)
  const dNo     = new RegExp(`^${doc.prefix}-D(\\d+)$`)
  const rows = new Map()
  for (const r of doc.issues) {
    const i = issueNo.exec(r.id), d = dNo.exec(r.id)
    if (i) rows.set(r.id, { id: r.id, kind: 'issue', n: Number(i[1]), title: r.title, severity: r.severity, status: r.status, file: r.file, line: r.line })
    else if (d) rows.set(r.id, { id: r.id, kind: 'question', n: Number(d[1]), title: r.title, severity: null, status: r.status, file: r.file, line: r.line })
  }
  for (const r of doc.decisions) {
    const d = dNo.exec(r.id ?? '')
    if (d) rows.set(r.id, { id: r.id, kind: 'ruling', n: Number(d[1]), title: r.title, severity: null, status: 'ruled', file: r.file, line: r.line })
  }
  const all = [...rows.values()]
  return spans.map(({ from, until }) => all
    .filter(r => {
      const mark = r.kind === 'issue' ? 'issue' : 'decision'
      return r.n > from[mark] && (!until || r.n <= until[mark])
    })
    .sort((a, b) => (a.kind === 'issue') - (b.kind === 'issue') || a.n - b.n)
    .map(({ n, ...row }) => row))
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
