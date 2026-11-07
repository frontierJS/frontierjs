// read-only-copy.js — whether this process is serving a read-only copy (`FJS-D1996`).
//
// Outpost sets FRONTIER_READ_ONLY_COPY=<as-of ISO time> on a copy's container,
// and the release image learns it here and nowhere else. `createClient` and
// `createTenantRegistry` open the data readonly under it, and junction answers
// with the header Outpost waits for before it routes the copy. A second reader
// of the var is a second answer to "am I the copy" that can disagree.
//
// A value that does not parse refuses: read as off, it would boot a copy
// writable over yesterday's data, which is the one way this fails open.

import { join, dirname, envVar } from '#host'

export const READ_ONLY_COPY_VAR = 'FRONTIER_READ_ONLY_COPY'

// The database a copy moves Session into; sign-in and sign-out stay writable
// while everything the copy was staged from is readonly (`FJS-D1921`).
export const COPY_SESSIONS_DB = 'sessions'

/**
 * @param {Record<string, string | undefined>} [env] — defaults to the process environment
 * @returns {{ asOf: Date } | null}
 */
export function readOnlyCopy(env) {
  const value = env ? env[READ_ONLY_COPY_VAR] : envVar(READ_ONLY_COPY_VAR)
  if (value == null || value === '') return null
  // Date.parse takes '2026', '1' and 'Nov 6' as dates; the var is always an ISO time.
  const asOf = /^\d{4}-\d{2}-\d{2}T/.test(value) ? new Date(value) : null
  if (!asOf || Number.isNaN(asOf.getTime()))
    throw new Error(
      `${READ_ONLY_COPY_VAR}=${JSON.stringify(value)} is not an ISO time. ` +
      `It marks this process as a read-only copy as of that time; unset it to serve writable.`)
  return { asOf }
}

// What a copy changes about one client's options. An option the caller passed
// wins: `placeModels` whole, and `access` per database name. A schema with no
// Session has nothing to move, and every database is readonly.
//
// A single-database app has no `sessions` block, so its file is a scratch one
// beside main's, discarded with the copy at refresh (`FJS-D1920`). Under
// `strategy database` the tenant registry passes the tenant's own file instead.
/**
 * @param {any} schema — the parsed schema, before placement
 * @param {{ placeModels?: Record<string, string>, access?: Record<string, any>, mainPath?: string | null, overrides?: any }} given
 */
export function copyOptions(schema, { placeModels, access, mainPath, overrides }) {
  const hasSession = schema.models.some((/** @type {any} */ m) => m.name === 'Session')
  const placement  = placeModels ?? (hasSession ? { Session: COPY_SESSIONS_DB } : null)
  const placed     = new Set(Object.values(placement ?? {}))

  /** @type {Record<string, any>} */
  const copyAccess = { main: 'readonly' }
  for (const d of schema.databases)
    if ((!d.driver || d.driver === 'sqlite') && !placed.has(d.name)) copyAccess[d.name] = 'readonly'
  for (const name of placed) copyAccess[name] = 'readwrite'

  /** @type {Record<string, { path: string }>} */
  const paths = {}
  if (overrides !== ':memory:')
    for (const name of placed)
      if (!schema.databases.some((/** @type {any} */ d) => d.name === name) && !overrides?.[name]?.path && mainPath)
        paths[name] = { path: mainPath === ':memory:' ? ':memory:' : join(dirname(mainPath), `copy-${name}.db`) }

  return { placeModels: placement, access: { ...copyAccess, ...(access ?? {}) }, paths }
}
