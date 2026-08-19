// ─── register-check.js — the registers, graded ───────────────────────────────
//
// `ISSUES.md`, `DECISIONS.md` and `IDEAS/` are prose, and prose is checked by
// attention. The register's own rules say so out loud — *an id is never
// reused*, *an id resolves in exactly one place*, *nothing is open unless it is
// here* — and every one of them was held up by nobody. The first parse of this
// tree found three ids each naming two different defects, one id naming three
// rulings, and 84 rulings with no id at all.
//
// This is the engine. `fli register:check` is one caller and `scripts/ci.mjs`
// is meant to be the other, the same two-caller shape as `core/checks.js`:
// zero dependencies, plain ESM, node or bun, so it runs before anything is
// installed.
//
// ── What is an error and what is a warning ───────────────────────────────────
//
// An **error** is a register that contradicts itself: two records under one id,
// a citation pointing at nothing, a link to a file that is not there, a value
// outside a vocabulary the register declares. None of those can be true on
// purpose.
//
// A **warning** is a register that is thin: a ruling nobody named, a row with
// no anchor to link, a date that has not moved in a long time. Every one of
// those is a legitimate state to be in on the way to somewhere.
//
// ── The clock ────────────────────────────────────────────────────────────────
//
// `stale-verified` is the one rule that reads the time of day, so its output is
// not reproducible and this must never feed a committed snapshot. `staleDays: 0`
// turns it off for a caller that needs a stable answer.

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { readRegisters, ISSUE_STATUS, IDEA_STATUS, SEVERITY } from './registers.js'

const ISO = /^\d{4}-\d{2}-\d{2}$/

// A cell that says *nothing here* rather than a value. The register writes all
// three and means the same by each.
const BLANK = new Set(['', '—', '-', 'n/a'])

// `clock: true` marks the one rule whose answer changes overnight. A caller
// that must be reproducible — CI, a committed artefact — reports it and never
// grades on it: a branch that changed nothing must not go red because a date
// passed.
export const RULES = [
  { id: 'duplicate-id',     level: 'error', what: 'one id naming two records — an id is never reused' },
  { id: 'unknown-ref',      level: 'error', what: 'a citation pointing at an id no register holds' },
  { id: 'dead-link',        level: 'error', what: 'a linked path that is not in the tree' },
  { id: 'unknown-status',   level: 'error', what: 'a status outside the register\'s own vocabulary' },
  { id: 'unknown-severity', level: 'error', what: 'an open row in a section with no severity' },
  { id: 'malformed-date',   level: 'error', what: 'a date that is not ISO-8601' },
  { id: 'unnamed-ruling',   level: 'warn',  what: 'a ruling with no id — nothing can cite it' },
  { id: 'missing-anchor',   level: 'warn',  what: 'an open row with no anchor — nothing can link it' },
  { id: 'stale-verified',   level: 'warn',  what: 'an open row nobody has re-checked in a long time', clock: true },
]

const LEVEL_OF = Object.fromEntries(RULES.map(r => [r.id, r.level]))

/**
 * Every finding, in register order. `staleDays: 0` disables the one rule that
 * reads the clock; `today` is injectable so a test asserts a fixed answer.
 */
export function runRegisterCheck({ root, staleDays = 60, today = new Date() } = {}) {
  const doc      = readRegisters(root)
  const findings = []

  const add = (rule, record, message, detail) => findings.push({
    rule,
    level:  LEVEL_OF[rule],
    id:     record?.id ?? null,
    kind:   record?.kind ?? null,
    file:   record?.file ?? null,
    line:   record?.line ?? null,
    message,
    ...(detail ? { detail } : {}),
  })

  // ── one id, one record ──
  //
  // Reported against the SECOND record, because the first one is where the id
  // was legitimately issued and the second is the one somebody has to rename.

  for (const dup of doc.ids.duplicates) {
    add('duplicate-id', { id: dup.id, kind: dup.kind, file: dup.at.file, line: dup.at.line },
      `${dup.id} names more than one ${dup.kind}`,
      `also at ${dup.also.file}${dup.also.line ? `:${dup.also.line}` : ''}`)
  }

  const known = doc.ids.byId

  // ── every record ──

  const all = [...doc.issues, ...doc.decisions, ...doc.ideas]

  for (const record of all) {
    // A record citing itself is a sentence, not a reference.
    for (const ref of record.refs ?? []) {
      if (ref.toLowerCase() === String(record.id).toLowerCase()) continue
      if (known.has(ref.toLowerCase())) continue
      add('unknown-ref', record, `cites ${ref}, which no register holds`)
    }

    // A closed record's links point at the code as it was. A file renamed since
    // is the normal outcome of fixing the thing, and grading it would make the
    // register harder to close things in.
    if (record.closed) continue

    for (const path of record.files ?? []) {
      // Two conventions are in use and both are legitimate: a link relative to
      // the file it is in (`../ISSUES.md` from a paper under `IDEAS/`) and one
      // relative to the workspace (`packages/mesa/src/compiler.js`, written the
      // same way from any depth). At the root they coincide, which is why one
      // register could be read with either and the other could not. A path is
      // dead only when neither reading finds it.
      if (existsSync(resolve(root, dirname(record.file), path))) continue
      if (existsSync(resolve(root, path))) continue
      add('dead-link', record, `links ${path}, which is not in the tree`)
    }
  }

  // ── issues ──
  //
  // A closed row is history: its section carries no severity, its links point
  // at code that has legitimately moved, and grading it would make the register
  // harder to close things in.

  for (const row of doc.issues) {
    if (row.closed) continue

    if (!ISSUE_STATUS.includes(row.status)) {
      add('unknown-status', row, `status "${row.status}" is not one of ${ISSUE_STATUS.join(', ')}`)
    }

    // A decision-shaped row sits in its own section and is graded by the ruling
    // it is waiting for, not by a severity it has never carried.
    if (row.severity !== 'decision' && !SEVERITY.includes(row.severity)) {
      add('unknown-severity', row, `sits under a section with no severity ("${row.severity}")`)
    }

    if (!BLANK.has(row.verified.toLowerCase()) && !ISO.test(row.verified)) {
      add('malformed-date', row, `verified "${row.verified}" is not YYYY-MM-DD`)
    }

    if (!row.anchor) {
      add('missing-anchor', row, 'has no <a id> — a ruling cannot link to it')
    }

    const age = staleDays > 0 && ISO.test(row.verified) ? daysBetween(row.verified, today) : null
    if (age !== null && age > staleDays) {
      add('stale-verified', row, `last verified ${age} days ago (${row.verified})`)
    }
  }

  // ── decisions ──

  for (const ruling of doc.decisions) {
    if (!ruling.id) {
      add('unnamed-ruling', ruling, `"${truncate(ruling.title)}" has no id`)
    }
    if (!ISO.test(ruling.date)) {
      add('malformed-date', ruling, `date "${ruling.date}" is not YYYY-MM-DD`)
    }
  }

  // ── ideas ──
  //
  // A paper with no frontmatter is not graded on values it does not declare —
  // the reader reports it as `form: 'heading'` and the migration is what fixes
  // it. Grading it here would fail a tree nobody has migrated yet.

  for (const paper of doc.ideas) {
    if (paper.form !== 'frontmatter') continue

    if (!IDEA_STATUS.includes(paper.status)) {
      add('unknown-status', paper, `status "${paper.status}" is not one of ${IDEA_STATUS.join(', ')}`)
    }
    for (const [field, value] of [['dated', paper.dated], ['revised', paper.revised]]) {
      if (!value) continue
      if (!ISO.test(value)) add('malformed-date', paper, `${field} "${value}" is not YYYY-MM-DD`)
    }
  }

  const errors   = findings.filter(f => f.level === 'error')
  const warnings = findings.filter(f => f.level === 'warn')

  return {
    root,
    findings,
    errors,
    warnings,
    counts: {
      issues:      doc.issues.length,
      open:        doc.issues.filter(i => !i.closed).length,
      decisions:   doc.decisions.length,
      namedRulings: doc.decisions.filter(r => r.id).length,
      ideas:       doc.ideas.length,
      errors:      errors.length,
      warnings:    warnings.length,
    },
    byRule: Object.fromEntries(RULES.map(r => [r.id, findings.filter(f => f.rule === r.id).length])),
  }
}

/** Whole days between an ISO date and a moment, floored, never negative. */
function daysBetween(iso, to) {
  const from = Date.parse(`${iso}T00:00:00Z`)
  if (Number.isNaN(from)) return 0
  return Math.max(0, Math.floor((to.getTime() - from) / 86_400_000))
}

function truncate(text = '', n = 60) {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text
}

/**
 * The findings as lines, worst first and grouped by rule — a register with 90
 * warnings read one-per-line is a wall nobody finishes.
 */
export function formatRegisterCheck(result) {
  const out = []
  const { counts } = result

  out.push(`  ${counts.open} open · ${counts.decisions} rulings (${counts.namedRulings} named) · ${counts.ideas} ideas`)
  out.push('')

  if (!result.findings.length) {
    out.push('  ✓  every register agrees with itself')
    return out
  }

  for (const rule of RULES) {
    const hits = result.findings.filter(f => f.rule === rule.id)
    if (!hits.length) continue

    const mark = rule.level === 'error' ? '✗' : '⚠'
    out.push(`  ${mark}  ${rule.id} — ${rule.what}  (${hits.length})`)

    for (const f of hits) {
      const where = f.line ? `${f.file}:${f.line}` : f.file
      out.push(`       ${f.id ?? '—'}  ${f.message}`)
      out.push(`         ${where}${f.detail ? `  · ${f.detail}` : ''}`)
    }
    out.push('')
  }

  out.push(`  ${counts.errors} error(s), ${counts.warnings} warning(s)`)
  return out
}
