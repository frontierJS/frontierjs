// core/migration-journal.js
// "Does this release's migration history agree with the journal of the database
// the box is running?" -- asked in the deploy preflight, before anything is
// shipped or built.
//
// The failure this exists for: a migration file edited after it was applied
// builds into an image in five minutes, and then the new container refuses to
// boot with `<file> was edited after being applied` (litestone's `apply()`
// compares the file's checksum with the one its journal recorded). The health
// check rolls back, which is safe and late. The same comparison is a pure
// function of two things the deploy already has -- the box's journal and the
// local files -- so it is made here, with litestone's own `status()` and
// `checksum()` and no copy of either.

import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { status } from '@frontierjs/litestone/migrations'
import { checksum } from '@frontierjs/litestone/migrate'
import { shWord } from './swap.js'

/** The table litestone's `apply()` records each applied file in. */
export const JOURNAL_TABLE = '_litestone_migrations'

/**
 * Which applied rows the files in `dir` do not agree with.
 *
 * `rows` is `[{ name, checksum }]` as the box's journal holds them. Answers
 * `[{ file, applied, local }]`: `local` is the checksum of the file as it is
 * now, or `null` where the file is gone. A file the journal has not seen yet is
 * a pending migration, not a disagreement.
 */
export function journalDisagreements(rows, dir) {
  const db = new Database(':memory:')
  try {
    db.run(`CREATE TABLE "${JOURNAL_TABLE}" (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)`)
    const put = db.query(`INSERT INTO "${JOURNAL_TABLE}" (name, applied_at, checksum) VALUES (?, ?, ?)`)
    for (const r of rows) put.run(r.name, '', r.checksum)
    const applied = new Map(rows.map(r => [r.name, r.checksum]))
    return status(db, dir)
      .filter(r => r.state === 'modified' || r.state === 'orphaned')
      .map(r => ({
        file:    r.file,
        applied: applied.get(r.file),
        local:   r.state === 'orphaned' ? null : checksum(r.sql),
      }))
  } finally { db.close() }
}

/**
 * The refusal text for `bad`, `{ <database>: [{ file, applied, local }] }`.
 * One line per file with both checksums, and the way out.
 */
export function journalRefusal(bad) {
  const lines = ['The migration files in this release disagree with the database running on the box:']
  for (const [database, list] of Object.entries(bad)) {
    for (const d of list) {
      lines.push(d.local === null
        ? `  ${database}/${d.file} -- applied on the box (checksum ${d.applied}), but this release has no such file`
        : `  ${database}/${d.file} -- edited after it was applied (box ${d.applied}, release ${d.local})`)
    }
  }
  lines.push(
    'The new container would refuse to start on this, after the image was built.',
    'Restore the applied text of each file and put the change in a new migration (litestone migrate create <label>), or, if the box holds nothing worth keeping, reinstall it.')
  return lines.join('\n')
}

// ─── The probe ────────────────────────────────────────────────────────────────
// Run inside the RUNNING container, so the database paths are the ones its own
// env gives (`DATABASE_URL`, `AUDIT_PATH`...) and not a guess made here. It opens
// each declared SQLite database read-only and prints one JSON line:
//   { multi, journals: { <database>: [{ name, checksum }] | null } }
// `null` is a database with no file or no journal table -- nothing to compare.
// `multi` says whether migrations live in db/migrations/<database>/ or flat.
// Double quotes only, because the whole program travels inside single quotes.
const PROBE = `
import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { parseFile } from "@frontierjs/litestone/parser"
const { schema } = parseFile("db/schema.lite")
const dbs = schema.databases.filter(d => !d.driver || d.driver === "sqlite")
const pathOf = d => d.path?.var ? (process.env[d.path.var] ?? d.path.default) : d.path?.value
const targets = dbs.length ? dbs.map(d => [d.name, pathOf(d)]) : [["main", process.env.DATABASE_URL]]
const journals = {}
for (const [name, path] of targets) {
  journals[name] = null
  if (!path || !existsSync(resolve(path))) continue
  let db
  try {
    db = new Database(resolve(path), { readonly: true })
    journals[name] = db.query("SELECT name, checksum FROM ${JOURNAL_TABLE} ORDER BY name").all()
  } catch {} finally { db?.close() }
}
console.log(JSON.stringify({ multi: dbs.length > 0, journals }))
`

/** The script that asks container `container` for its journals. */
export const journalProbeScript = (container) =>
  `docker exec ${shWord(container)} sh -c ${shWord(`cd /app && bun -e ${shWord(PROBE)}`)}`

/** `{ multi, journals }` from what the probe printed, or null where it printed none. */
export function parseProbe(output) {
  const line = String(output ?? '').split('\n').map(l => l.trim()).reverse().find(l => l.startsWith('{'))
  if (!line) return null
  try {
    const out = JSON.parse(line)
    return out && typeof out.journals === 'object' ? out : null
  } catch { return null }
}

/**
 * The disagreements between a probe's journals and the files in
 * `migrationsRoot` (an app's `db/migrations`), `{ <database>: [...] }`; empty
 * where they agree.
 */
export function disagreementsFor(probe, migrationsRoot) {
  const bad = {}
  for (const [name, rows] of Object.entries(probe.journals)) {
    if (!rows?.length) continue
    const list = journalDisagreements(rows, probe.multi ? join(migrationsRoot, name) : migrationsRoot)
    if (list.length) bad[name] = list
  }
  return bad
}

/**
 * The preflight check: probe the running container, compare, and answer
 * `{ ok: true }` or `{ ok: false, message }`.
 *
 * Passes silently where there is nothing to compare: no container (a first
 * deploy), a probe that failed or printed nothing, a database with no journal.
 * Both reads run under `--dry` too, as the one-door check's does: a dry run is
 * where an operator asks whether the deploy would be refused.
 */
export function checkJournal({ machine, container, migrationsRoot }) {
  try { machine.run(`docker inspect ${shWord(container)} > /dev/null 2>&1`, { dry: false }) }
  catch { return { ok: true } }
  let output
  try { output = machine.capture(journalProbeScript(container), { dry: false }) }
  catch { return { ok: true } }
  const probe = parseProbe(output)
  if (!probe) return { ok: true }
  const bad = disagreementsFor(probe, migrationsRoot)
  return Object.keys(bad).length ? { ok: false, message: journalRefusal(bad) } : { ok: true }
}
