// @ts-check
// pre-migrate.js — the copy an app's boot takes before it applies pending
// migrations, reached by `@frontierjs/litestone/migrations` (`FJS-3907`, `FJS-4627`).
//
// A migration has no `down`, by ruling — the way back is a copy of the
// database from before it ran, which `litestone migrate apply --backup` takes
// and a boot's `apply()` does not. Each migration is its own transaction, so a
// failing one rolls back by itself; the copy is for one that COMMITS and is
// wrong, where the alternative is the last scheduled backup.
//
// Each copy is read with `PRAGMA integrity_check` before it counts, and a
// crash loop keeps the first copy of its run beside the newest ones, since
// every later copy holds what an earlier failed boot already migrated.
//
// A database with nothing applied yet is a first boot and has no rows to
// lose, so it is not copied. A copy that fails throws: migrating without it is
// the thing this file exists to prevent.

import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from '#host'
import { basename, dirname, join } from 'path'
import { openDatabase } from './engine.js'
import { migrationStatus } from './migrations.js'
import { parseFile } from './parser.js'
import { resolveDbPath } from './databases.js'
import { resolveAnchor } from './db-path.js'

/**
 * Each SQLite database the schema declares, at the path `createClient` with the
 * same `resolveFrom` would open. A boot migrates these BEFORE it builds the
 * client: a client opened on a fresh file creates every table, and the first
 * migration then fails on a table that already exists.
 * @param {string} schemaPath
 * @param {{ resolveFrom?: any }} [opts]
 * @returns {{ name: string, path: string }[]}
 */
export function declaredDatabasePaths(schemaPath, { resolveFrom } = {}) {
  const { schema } = parseFile(schemaPath)
  const anchor = resolveAnchor(resolveFrom, schemaPath)
  return schema.databases
    .filter((/** @type {any} */ db) => db.driver !== 'jsonl' && db.driver !== 'trail')
    .map((/** @type {any} */ db) => ({ name: db.name, path: resolveDbPath(db.path, undefined, anchor) }))
    .filter((/** @type {{ name: string, path: string }} */ db) => db.path && db.path !== ':memory:')
}

/** How many copies are kept. Each is the whole database, on the disk it lives on. */
export const PRE_MIGRATE_KEEP = 3

/** Beside the database. Outpost's swap lists this directory by name (`FJS-D2044`). */
export const preMigrateDir = (/** @type {string} */ dbPath) => join(dirname(dbPath), 'pre-migrate')

/**
 * The copy's path, or null when there was nothing to protect or nothing to apply.
 * @param {any} rawDb  a raw SQLite handle on `dbPath`, opened before any client
 * @param {string} dbPath
 * @param {string} migrationsDir
 * @param {{ info(msg: string, meta?: object): void }} log
 * @returns {string | null}
 */
export function copyBeforeMigrating(rawDb, dbPath, migrationsDir, log) {
  if (!dbPath || dbPath === ':memory:') return null
  const rows    = migrationStatus(rawDb, migrationsDir)
  const pending = rows.filter(r => r.state === 'pending').map(r => r.file)
  if (!pending.length || !rows.some(r => r.state === 'applied')) return null

  const dir  = preMigrateDir(dbPath)
  mkdirSync(dir, { recursive: true })
  // Outpost's swap reads this name: the database it replaces, and an instant it
  // holds against the moment the old container stopped (`FJS-D2044`).
  const dest = join(dir, `${basename(dbPath)}--${new Date().toISOString().replace(/:/g, '-')}.db`)
  try {
    // Bound, never interpolated (Invariant 8). Refuses an existing file, and
    // the name is to the millisecond.
    rawDb.run('VACUUM INTO ?', [dest])
    // The copy holds what the live file holds, so it is no more readable than it.
    chmodSync(dest, statSync(dbPath).mode & 0o777)
    // VACUUM INTO copies a damaged page as readily as a sound one, and a copy
    // nobody has read is a restore that fails when it is wanted.
    const verdict = integrity(dest)
    if (verdict !== 'ok') throw new Error(`PRAGMA integrity_check said: ${verdict}`)
    // A boot that fails and restarts copies again; the newest pending file is
    // the same across that loop, so it names the run `prune` protects.
    writeFileSync(runMark(dest), pending[pending.length - 1])
  } catch (err) {
    // Any failure leaves a copy nobody can restore from, so it goes and the boot stops.
    rmSync(dest, { force: true })
    rmSync(runMark(dest), { force: true })
    throw new Error(`[litestone] the copy before migrating failed, so nothing was migrated: ${/** @type {Error} */ (err).message} — ${dest}`)
  }
  prune(dir, pending[pending.length - 1])
  log.info('copied the database before migrating', { path: dest, pending })
  return dest
}

const runMark = (/** @type {string} */ copy) => `${copy}.run`

/** @param {string} path */
function integrity(path) {
  // Not `readonly`: a read-only handle skips the CHECK/NOT NULL half of the
  // verdict, and the copy is a fresh non-WAL file this process just wrote.
  const copy = openDatabase(path)
  try {
    const rows = /** @type {{ integrity_check: string }[]} */ (copy.query('PRAGMA integrity_check').all())
    return rows.map(r => r.integrity_check).slice(0, 3).join('; ')
  } finally { copy.close() }
}

/**
 * Keeps the newest copies, and the first copy of the run still failing. A
 * crash loop copies on every boot, and the first is the only one from before
 * the migration that committed; the newest three would all be after it.
 * @param {string} dir
 * @param {string} run
 */
function prune(dir, run) {
  const copies = readdirSync(dir).filter(n => n.endsWith('.db')).sort()
  const first  = copies.find(n => readMark(join(dir, n)) === run)
  const kept   = new Set(copies.slice(-PRE_MIGRATE_KEEP))
  if (first && !kept.has(first)) {
    kept.delete([...kept][0])
    kept.add(first)
  }
  for (const name of copies) {
    if (kept.has(name)) continue
    const path = join(dir, name)
    rmSync(path, { force: true })
    rmSync(runMark(path), { force: true })
  }
}

/** @param {string} copy */
function readMark(copy) {
  try { return readFileSync(runMark(copy), 'utf8') } catch { return null }  // an unreadable mark only loses the copy its crash-loop protection; it must not stop a boot
}
