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

import { readRegisters, REGISTER_FILES, ISSUE_STATUS, IDEA_STATUS, RULING_STATUS, SEVERITY } from './registers.js'

const ISO = /^\d{4}-\d{2}-\d{2}$/

// A cell that says *nothing here* rather than a value. The register writes all
// three and means the same by each.
const BLANK = new Set(['', '—', '-', 'n/a'])

// `clock: true` marks the one rule whose answer changes overnight. A caller
// that must be reproducible — CI, a committed artefact — reports it and never
// grades on it: a branch that changed nothing must not go red because a date
// passed.
export const RULES = [
  { id: 'unparsed-record',  level: 'error', what: 'a line with a record\'s shape that produced no record — the reader could not see it, so every rule below passes over it' },
  { id: 'duplicate-id',     level: 'error', what: 'one id naming two records — an id is never reused' },
  { id: 'unknown-ref',      level: 'error', what: 'a citation pointing at an id no register holds' },
  { id: 'dead-link',        level: 'error', what: 'a linked path that is not in the tree' },
  { id: 'unknown-status',   level: 'error', what: 'a status outside the register\'s own vocabulary' },
  { id: 'closed-in-open',   level: 'error', what: 'a closed row still sitting in an open section — every count above it is wrong' },
  { id: 'row-shape',        level: 'error', what: 'a row whose columns do not line up with its table — read into the wrong fields, and any cell past the header\'s width is dropped when rendered' },
  { id: 'unknown-severity', level: 'error', what: 'an open row in a section with no severity' },
  { id: 'cross-register-id', level: 'error', what: 'an open decision QUESTION whose id already names a ruling — either the ruling landed and nothing closed the row, or the two are different subjects wearing one id' },
  { id: 'ruling-status',    level: 'error', what: 'a ruling declaring a status outside the vocabulary, or retiring itself without naming what replaced it' },
  { id: 'malformed-date',   level: 'error', what: 'a date that is not ISO-8601' },
  { id: 'ruling-order',     level: 'warn',  what: 'a ruling dated later than the one above it — a section runs newest first, so the top of one is the current thinking' },
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

  // A root holding none of the registers is not a project whose registers
  // agree with each other — it is a directory this check cannot answer for,
  // and answering `0 open · 0 rulings · ✓` is the one thing it must not do.
  // The case is ordinary rather than hypothetical: `fli` walks UP to the
  // nearest package root, so running this from `packages/cli` reads that
  // package's own directory, finds nothing, and grades a clean sheet — which
  // is what the root `CLAUDE.md` tells everyone to do before running anything.
  // A refusal here rather than in each caller, because a caller that has to
  // remember to ask is the same hole one layer up.
  if (!doc.sources.length) {
    throw new Error(
      `no register at ${root}\n` +
      `  looked for: ${REGISTER_FILES.join(' · ')}\n` +
      `  a register that is absent cannot be graded, and a pass here would say it agrees with itself.\n` +
      `  run this from the root of a project that keeps registers.`
    )
  }

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

  // ── a register the reader could not read ──
  //
  // Graded first and as an error, because every rule under it is asked of the
  // records that parsed: a file none of them came from is a file all of them
  // pass. The refusal above separates *no register here* from *an empty one*;
  // this separates an empty one from an UNREADABLE one, which is the state a
  // project not using this id prefix is in — an `ACME-1` table graded
  // `0 open · ✓ every register agrees with itself`.

  for (const row of doc.unparsed) {
    add('unparsed-record', row,
      'has a record\'s shape and produced no record — the reader takes an id it did not find here',
      row.text)
  }

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
    // ── does the row line up with the table it is in ──
    //
    // Graded before the closed guard, because this is the one rule about a
    // closed row that is still about TODAY: a row wider than its header has its
    // last cell dropped when the file is rendered, and for § Closed that cell
    // is *how*. Asked at the date column alone — the only cell with a shape,
    // and the only one sitting ahead of every free-text column, so a `|` in a
    // Detail cannot move it while a column the header does not have moves it by
    // one.
    //
    // Both directions were live when this was written and neither was visible.
    // Four closed rows sat in § S3 wearing the closed shape, so `closed-in-open`
    // could not see them — the reader infers a row's shape from its CELL COUNT,
    // so a four-cell row in a six-column table was read as a decision-shaped one
    // and given a status nobody wrote. Two open rows sat in § Closed and were
    // therefore counted as done, which is the more expensive direction: a defect
    // that is still there and is in nobody's list.
    if (row.headWidth != null && row.columns !== row.headWidth) {
      // The header declares the shape and the row disagrees with it. Graded on
      // the COUNT alone, which is exact — a date cell holding something odd is
      // `malformed-date`'s, a bad value in the right column.
      const wider = row.columns > row.headWidth
      add('row-shape', row,
        `has ${row.columns} cells where its table declares ${row.headWidth}`,
        wider
          ? 'every cell past the header\'s width is dropped when the file is rendered — fold it into the ' +
            'last declared column, and escape a `|` that is part of the prose'
          : `it is a row from another table: column ${(row.dateColumn ?? 0) + 1} should hold the date and ` +
            'the row does not reach it, so the reader gives it a status nobody wrote and no other rule sees it')
    }

    if (row.closed) continue

    // ── the question and the ruling that answers it ──
    //
    // `duplicate-id` keys on `kind:id`, so a `FJS-D##` appearing once as the
    // question in `ISSUES.md` and once as the ruling in `DECISIONS.md` is
    // exempt — and that exemption assumes the pair are the SAME subject. Where
    // they are not, the register holds two different questions under one id and
    // every rule here passes them (`FJS-768`, found by reading rather than by
    // running: `FJS-D183` was the encryption envelope in one file and the
    // transaction scope in the other).
    //
    // The rule cannot tell the two causes apart, and does not try: an id whose
    // ruling EXISTS while the question is still open is wrong either way. Either
    // the ruling answers this row and nothing closed it — the register saying a
    // settled question is open, which is how a fixed thing gets re-argued — or
    // it answers a different one and the id was issued twice. The message names
    // both, because the fix differs and only a person can say which it is.
    if (row.severity === 'decision' && doc.decisions.some(d => d.id && d.id.toLowerCase() === String(row.id).toLowerCase())) {
      add('cross-register-id', row,
        `${row.id} is open here and already names a ruling`,
        'if that ruling answers this row, close it and cite the ruling; if it answers something else, ' +
        'the id was issued twice — reissue THIS one, since the ruling is the half other documents cite')
    }

    // `closed` is in ISSUE_STATUS because the READER synthesises it for every row
    // under § Closed — which is what made it silently legal as a hand-written
    // cell in an open section, where it means the opposite. A row saying it is
    // done, in the table of what is not, is counted as open by everything that
    // reads this file: `register:check`'s own tally, `ws:map`, `ws:atlas`, and
    // whoever is choosing what to work on next. Sixteen of them had accumulated
    // when this rule was written, one being the only S1.
    //
    // Its own rule rather than an `unknown-status`, because the remedy is not
    // *you wrote a bad word*: the row is correct and it is in the wrong place.
    // This is the direction the register's own Conventions section already
    // names — *the register also goes stale in the closing direction, which
    // nothing here was watching for*.
    if (row.status === 'closed') {
      add('closed-in-open', row,
        `is closed but sits under ${row.severity} — move it to § Closed, which is what every count reads`)
    } else if (!ISSUE_STATUS.includes(row.status)) {
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

  // The ruling above this one, within the same section. `doc.decisions` is in
  // file order, so a section change resets it.
  let prevInSection = null
  let prevSection   = null

  for (const ruling of doc.decisions) {
    if (ruling.section !== prevSection) { prevSection = ruling.section; prevInSection = null }

    if (!ruling.id) {
      add('unnamed-ruling', ruling, `"${truncate(ruling.title)}" has no id`)
    }
    if (!ISO.test(ruling.date)) {
      add('malformed-date', ruling, `date "${ruling.date}" is not YYYY-MM-DD`)
    }

    // ── newest first ──
    //
    // A section is read from the top, so the order is a claim about which
    // ruling is current. It was the practice in seven sections of nine and
    // written down in none, which is how the other two drifted into a legacy
    // block at the foot — the original ascending run, with every later ruling
    // prepended above it (`FJS-D196`'s neighbour: the convention nothing
    // grades is the one that stops being true quietly).
    //
    // Reported against the LATER ruling, which is the one that moves up, and
    // only within a section — the file's sections are subject areas and have no
    // order between them. A warning rather than an error: the register does not
    // contradict itself here, and a ruling deliberately placed beside the one it
    // amends is a legitimate reason to be out of order that no rule can see.
    if (prevInSection && ISO.test(ruling.date) && ISO.test(prevInSection.date) && prevInSection.date < ruling.date) {
      add('ruling-order', ruling,
        `is dated ${ruling.date} and sits below ${prevInSection.id ?? 'a ruling'} dated ${prevInSection.date}`,
        'a section runs newest first — move it above, or say in the ruling why it sits where it does')
    }
    prevInSection = ruling

    // ── what a ruling says about itself ──
    //
    // Absence is the answer for nearly every ruling and is not graded: being in
    // `DECISIONS.md` is the statement that it was decided, so a status is only
    // written where that has stopped being true (`FJS-D196`). What is graded is
    // the two ways a written one can be useless — a word outside the set, and a
    // retirement that does not say what replaced it, which sends the reader
    // looking through 182 rulings for a successor nobody named. `withdrawn` is
    // the exception on purpose: nothing replaced it, and that is the content.
    if (ruling.status == null) continue

    if (!RULING_STATUS.includes(ruling.status)) {
      add('ruling-status', ruling,
        `status "${ruling.status}" is not one of ${RULING_STATUS.join(', ')}`,
        'a ruling with no status is in force, which is the state of nearly every one — a word is written only where that stopped being true')
    } else if (ruling.status !== 'withdrawn' && !ruling.supersededBy) {
      add('ruling-status', ruling,
        `is ${ruling.status} and names no ruling`,
        `name the ruling that replaced it, or the issue that moved it — a reader who cannot follow the retirement has to search 182 rulings for a successor nobody wrote down`)
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
    sources: doc.sources,
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
  // What was READ, beside what was found in it. A project keeping two of the
  // three registers is normal; the line exists so a small count is legible as
  // a small register rather than as a register nobody opened.
  out.push(`  read ${(result.sources ?? []).join(' · ')}  in ${result.root}`)
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
