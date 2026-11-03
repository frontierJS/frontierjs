// @ts-check
// studio-queries.js — Studio's saved SQL queries, kept in a sidecar file beside
// the main database (`app.db-studio.json`, named the way SQLite names its own
// -wal and -shm) and never inside it (FJS-D635). A table in the app's database
// was a write Studio made to data it was only showing — `--readonly` included,
// since listing created the table.
//
// An in-memory database has no file to sit beside, so its queries live as long
// as the process does.

import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs'

/** The sidecar for a database file, or null for one with no file. */
export function sidecarFor(/** @type {string | null | undefined} */ dbFile) {
  return dbFile ? `${dbFile}-studio.json` : null
}

/**
 * @param {string | null} path  the sidecar, from sidecarFor
 */
export function openSavedQueries(path) {
  /** @type {any[]} */
  let memory = []

  const read = () => {
    if (!path) return memory
    if (!existsSync(path)) return []
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(parsed?.queries)) throw new Error(`${path} holds no "queries" array`)
    return parsed.queries
  }
  // Written whole and renamed into place, so a second Studio on the same
  // database reads the old list or the new one and never half of either.
  const write = (/** @type {any[]} */ queries) => {
    if (!path) { memory = queries; return }
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ queries }, null, 2) + '\n')
    renameSync(tmp, path)
  }

  return {
    list: () => read().slice().sort((/** @type {any} */ a, /** @type {any} */ b) => a.name.localeCompare(b.name)),
    save(/** @type {string} */ name, /** @type {string} */ sql) {
      const queries = read()
      const hit = queries.find((/** @type {any} */ q) => q.name === name)
      if (hit) hit.sql = sql
      else queries.push({ id: queries.reduce((/** @type {number} */ m, /** @type {any} */ q) => Math.max(m, q.id), 0) + 1, name, sql, createdAt: new Date().toISOString() })
      write(queries)
    },
    remove(/** @type {number} */ id) {
      write(read().filter((/** @type {any} */ q) => q.id !== id))
    },
  }
}
