// drivers/jsonl-index.js — the SQLite sidecar beside a .jsonl file, and the
// lock that says who may change that file.
//
// It is one module because TWO callers need it and they are not each other's:
// the driver appends and reads through it, and `tools/retention.js` compacts
// through it. Compaction previously reached the sidecar the only way it could
// from outside — `rmSync` — and deleting a database another process holds open
// is what `FJS-540` was.
//
// ─── The lock, and why it is a transaction rather than a lockfile ───────────
//
// A byte offset cannot be computed before the append and cannot be recovered
// after it: `statSync(f).size` then `appendFileSync` is two syscalls, and a
// second process appending between them makes the recorded offset name the
// OTHER writer's line. Measured on the shipped code, two processes and no
// artificial delay: **1,999 of 8,000 recorded offsets pointed at another
// writer's line** — one in four, and an indexed read then answers the wrong
// record with no error, which for an audit trail is the worst failure there is.
//
// So the pair has to be serialised across processes, and the lock is
// `BEGIN IMMEDIATE` on this database rather than a lockfile. Not preference:
// **a lockfile has no answer for a writer that dies holding it.** Stale-lock
// detection by pid or mtime is the standard footgun — it either blocks the
// trail for ever or breaks the lock while the holder is alive — and SQLite has
// already solved it, because the operating system drops a dead process's file
// locks.
//
// ─── WAL, which is the second half of that decision ─────────────────────────
//
// Taking a write lock per append is only affordable if the lock is cheap.
// Measured, 8 processes × 400 appends:
//
//   rollback journal   2 of 8 processes killed by the DDL · 12 rows dropped to
//                      SQLITE_BUSY · worst insert 5,007 ms · mean 9.6–65.2 ms
//   WAL                0 killed · 0 dropped · worst 79 ms · mean 0.03–0.27 ms
//
// A rollback journal makes readers and writers exclude each other on the one
// file every process touches, so a single open reader blocks a writer for the
// whole `busy_timeout` and then fails it (measured: 5,006 ms → SQLITE_BUSY).
// `core/pragmas.js` says what that costs: a synchronous driver means the wait
// is the event loop, and five seconds of it is five seconds of a server
// answering nobody.
//
// **WAL was tried before and taken back out, and the reason was real.** WAL
// adds `-wal` and `-shm` beside the database, and compaction USED to delete the
// index — leaving those two behind. Measured, and it is worse than the
// maintenance worry it was recorded as: after the unlink a live process's next
// write answers `SQLITE_READONLY_DBMOVED` under a rollback journal, which is a
// loud crash, and answers **`ok` under WAL**, silently writing into an inode
// with no directory entry. WAL turns a crash into a lie.
//
// That is why the unlink had to go FIRST and why it is not coming back:
// compaction rebuilds this index rather than deleting it (`rebuildIndex`), so
// nothing separates the database from its WAL. The order is the ruling.

import { existsSync, readFileSync } from 'fs'
import { Database } from 'bun:sqlite'
import { applyBusyTimeout } from '../core/pragmas.js'

/** SQLite type per `.lite` scalar, for the index's own columns. */
export const FIELD_TYPES = {
  String: 'TEXT', Int: 'INTEGER', Float: 'REAL', Boolean: 'INTEGER',
  DateTime: 'TEXT', Json: 'TEXT', Any: 'ANY',
}

/** The sidecar's path. One definition, because two modules open it. */
export const indexPathFor = (filePath) => filePath + '.index.db'

/**
 * What this model's index is made of.
 *
 * Derived from the model and nowhere else, so the driver writing a row and the
 * compaction rewriting every row cannot disagree about the shape. They did not
 * disagree before this existed only because compaction did not write rows at
 * all — it deleted the file.
 */
export function indexShapeFor(model) {
  const storedFields = model.fields.filter(f =>
    f.type.kind !== 'relation' &&
    !f.attributes.some(a => a.kind === 'computed' || a.kind === 'transient')
  )
  const idName     = model.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? null
  const indexAttrs = model.attributes.filter(a => a.kind === 'index')
  // With an `@id` the index can upsert by it; without one — an audit log — the
  // offset is the key, since every appended line is at a distinct byte.
  const indexedFieldNames = idName
    ? [...new Set([idName, ...indexAttrs.flatMap(a => a.fields)])]
    : [...new Set(indexAttrs.flatMap(a => a.fields))]
  return { storedFields, idName, indexAttrs, indexedFieldNames, hasIndex: indexAttrs.length > 0 }
}

/**
 * Open the sidecar in the one configuration every caller must agree on.
 *
 * WAL is set on every open rather than once at creation because it is how a
 * database opened by an older build is carried forward — `journal_mode = WAL`
 * is persistent in the file, so this is a no-op on the second open and the
 * migration for everybody else.
 *
 * `synchronous = NORMAL` is WAL's companion: under WAL it is durable across a
 * process crash and only risks the last transactions on a power loss, which is
 * the right trade for a row that is fire-and-forget by construction.
 */
export function openIndexDb(indexPath, busyTimeout = null) {
  const db = new Database(indexPath)

  // ── The upgrade, and why it may fail without failing the open ────────────
  //
  // `journal_mode = WAL` is persistent in the file, so this is the migration
  // for every index an older build wrote — and it needs a moment with no other
  // connection on the database. A rolling deploy is precisely when there IS
  // one: the old process is still serving and still reading the trail.
  //
  // Measured against a live reader: the switch waits the whole `busy_timeout`
  // and then throws `SQLITE_BUSY` — **5,008 ms and an exception at boot, on the
  // audit path**. So it is attempted with a short wait of its own and its
  // failure is swallowed. The mode is persistent, so a later start with nobody
  // holding the file completes it; until then the index is correct and merely
  // has the old contention profile, because correctness here is the LOCK and
  // not the journal mode.
  db.run('PRAGMA busy_timeout = 50')
  try { db.run('PRAGMA journal_mode = WAL') } catch { /* another process holds it; next start */ }

  applyBusyTimeout(db, busyTimeout)
  // WAL's companion. Durable across a process crash, and only the last
  // transactions are at risk on a power loss — the right trade for a row that
  // is fire-and-forget by construction. A no-op under a rollback journal.
  try { db.run('PRAGMA synchronous = NORMAL') } catch { /* not fatal to the write */ }
  return db
}

/**
 * Hold this file's write lock for the length of `fn`.
 *
 * `BEGIN IMMEDIATE` takes SQLite's RESERVED lock at once rather than on the
 * first write, which is the whole point: the thing being guarded — reading the
 * file's size and appending to it — is not a SQL statement, so a deferred
 * transaction would take the lock too late to have guarded anything.
 *
 * Re-entrant by inspection rather than by counting: a caller already inside one
 * passes through, because `BEGIN` inside a transaction is an error and the
 * outer holder's lock is the one that matters.
 */
export function withWriteLock(db, fn) {
  if (db.inTransaction) return fn()
  db.run('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.run('COMMIT')
    return out
  } catch (err) {
    try { db.run('ROLLBACK') } catch { /* the throw below is the report */ }
    throw err
  }
}

/**
 * Create the index table if it is absent, and drop it when its shape has drifted.
 *
 * The index is a CACHE — every column in it is re-derivable from the .jsonl,
 * which is the source of truth. So when the declared column types no longer
 * match the table on disk, drop it and let it refill rather than writing into a
 * shape that will throw. `CREATE TABLE IF NOT EXISTS` does nothing to an
 * existing table, so without this an index built before a type changed keeps the
 * old column for ever and every write fails with a datatype error naming a
 * column the schema no longer describes.
 *
 * Two ways the shape can be wrong and only the first was checked. A changed TYPE
 * fails the write with a datatype error naming the column; a MISSING column
 * fails it with `has no column named …`, which is what an existing trail does
 * the first time a model gains an indexed field — and the audit path swallows
 * both, so a deployment upgrades and stops recording with one warning and no
 * other symptom.
 *
 * **It answers early when the table is already right**, which is not a
 * micro-optimisation: `CREATE TABLE` and `DROP TABLE` need SQLite's schema lock,
 * and running DDL on every open is what killed 2 of 8 concurrent processes
 * outright. A read-only pragma query needs no write lock at all.
 */
export function ensureIndexTable(db, model, shape, filePath) {
  const { storedFields, idName, indexAttrs, indexedFieldNames } = shape
  const table = `${model.name}_idx`

  const declared = new Map(indexedFieldNames.map(name => {
    const f = storedFields.find(f => f.name === name)
    return [name, f ? (FIELD_TYPES[f.type.name] ?? 'TEXT') : 'TEXT']
  }))
  const existing = db.query(`SELECT name, type FROM pragma_table_info(?)`).all(table)
  const have     = new Set(existing.map(col => col.name))
  const drifted  = existing.length > 0 && (
    existing.some(col => declared.has(col.name) && declared.get(col.name) !== col.type) ||
    [...declared.keys()].some(name => !have.has(name))
  )
  // Already right, and every index present. Nothing to lock for.
  if (existing.length > 0 && !drifted) return
  // A table that is ABSENT over a file that already has lines must be filled,
  // not merely created. Nothing did that: `drifted` is false when there is no
  // table at all, so an index created beside an existing trail stayed empty and
  // every indexed read answered nothing — which reads as an empty log. The old
  // compaction unlinked this database on every sweep, so that was the state a
  // trail reached the first night its retention elapsed.
  const stale = existing.length === 0 && existsSync(filePath)

  const colDefs = indexedFieldNames.map(name => `  "${name}" ${declared.get(name)}`)
  colDefs.push(`  "_offset" INTEGER NOT NULL`)
  const pk = idName ? `PRIMARY KEY ("${idName}")` : `PRIMARY KEY ("_offset")`

  withWriteLock(db, () => {
    if (drifted) db.run(`DROP TABLE "${table}"`)
    db.run(`CREATE TABLE IF NOT EXISTS "${table}" (\n${colDefs.join(',\n')},\n  ${pk}\n) STRICT;`)
    for (const attr of indexAttrs) {
      const cols = attr.fields.map(f => `"${f}"`).join(', ')
      db.run(`CREATE INDEX IF NOT EXISTS "idx_${model.name}_${attr.fields.join('_')}" ON "${table}" (${cols});`)
    }
    // A dropped index is refilled from the .jsonl, which has every line and
    // every byte offset. Without this the rows written before the type changed
    // stay in the file and become unfindable through the index — the log would
    // look truncated, which for an audit trail is the worst possible failure.
    if (drifted || stale) refill(db, model, shape, filePath)
  })
}

/**
 * Re-derive every index row from the file, replacing what is there.
 *
 * The compaction half of the contract: a rewritten file has moved every byte
 * offset the index holds, and the answer is to rebuild them rather than to
 * delete the database — which is what used to happen and what made WAL unsafe.
 *
 * Takes the lock, so a concurrent append cannot land between the clear and the
 * refill and be missed.
 */
export function rebuildIndex(db, model, filePath) {
  const shape = indexShapeFor(model)
  if (!shape.hasIndex && !shape.idName) return
  // Compaction runs inside `makeJsonlTable` BEFORE the driver has opened its
  // index, so the table legitimately may not exist yet. That is not a rebuild
  // this function can do — and it does not need to: `ensureIndexTable` fills a
  // table it creates over a non-empty file.
  const present = db.query(`SELECT name FROM pragma_table_info(?)`).all(`${model.name}_idx`).length > 0
  if (!present) return
  withWriteLock(db, () => {
    db.run(`DELETE FROM "${model.name}_idx"`)
    refill(db, model, shape, filePath)
  })
}

/** The refill itself. Caller holds the lock. */
function refill(db, model, shape, filePath) {
  if (!existsSync(filePath)) return
  const { indexedFieldNames } = shape
  const cols = [...indexedFieldNames, '_offset']
  const stmt = db.query(
    `INSERT OR REPLACE INTO "${model.name}_idx" (${cols.map(c => `"${c}"`).join(', ')}) ` +
    `VALUES (${cols.map(() => '?').join(', ')})`
  )
  let offset = 0
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const bytes = Buffer.byteLength(line, 'utf8') + 1   // + the newline
    if (line.trim()) {
      try {
        const record = JSON.parse(line)
        stmt.run(...indexedFieldNames.map(c => record[c] ?? null), offset)
      } catch { /* a torn last line — skip it, the file is append-only */ }
    }
    offset += bytes
  }
}
