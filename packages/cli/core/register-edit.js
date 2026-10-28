// ─── register-edit.js — the write half every register verb shares ───────────
//
// close, amend, file, decide, settle and archive each edit a register and must
// not leave it worse: the edit is graded by `register:check`, and a write it
// finds a new error in is put back and refused. That skeleton lives here once.
// Reading a row is `registers.js`; grading is `register-check.js`; this module
// imports both and neither imports it.
//
// The lock is NOT taken here. It has to span the read the edit was computed
// from, or two writers mint the same next id, so each entry point holds
// `withRegisterGuard` around its whole body.
//
// Zero dependencies, plain ESM, node or bun — same rule as its neighbors.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'

import { errorKeys, newErrors, describeNewErrors } from './register-check.js'

/**
 * Run `edit(write)`, then grade the tree. `write(abs, text)` remembers each
 * file's text before its first write, so an edit that touches files as it
 * goes (archive's relink) is put back whole.
 *
 * Answers `{ ok: true, value }` with what `edit` returned, or `{ ok: false,
 * reason }` once every file is back. A file the edit created is removed rather
 * than kept: a restored ISSUES.md beside a new archive holding its rows would
 * carry every moved id twice.
 */
export function checkedEdit(root, what, edit) {
  const baseline = errorKeys(root)
  const before   = new Map()

  const write = (abs, text) => {
    if (!before.has(abs)) before.set(abs, existsSync(abs) ? readFileSync(abs, 'utf8') : null)
    writeFileSync(abs, text)
  }

  const value = edit(write)
  const added = newErrors(baseline, root)
  if (!added.length) return { ok: true, value }

  for (const [abs, text] of before) {
    if (text === null) { try { unlinkSync(abs) } catch {} }
    else writeFileSync(abs, text)
  }
  return { ok: false, reason: `the ${what} was put back: register:check found ${describeNewErrors(added)}` }
}

// ─── cells ────────────────────────────────────────────────────────────────────

// A cell is one line, and a bare `|` would end it.
export function oneCell(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().replace(/(?<!\\)\|/g, '\\|')
}

// UTC: the date is written into a register and read by everybody afterwards,
// and a host clock west of Greenwich files tonight's row under yesterday.
export function isoDate(d) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}
