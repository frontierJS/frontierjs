// core/db-path.js — where a relative `database { path }` lands, and what is
// said when landing there mints something.
//
// Node builtins only, and no import of the client: the CLI has its own reasons
// to answer the same question before a client exists, and a second copy of this
// rule is how `litestone studio` run from `db/` came to serve an empty database
// it had just created while every other command in the tree opened the real one
// (`FJS-449`).

import { existsSync, statSync } from 'fs'
import { dirname, basename, resolve } from 'path'
import { fileURLToPath } from 'url'

// Where a relative `database { path }` is anchored.
//
// The declaration is written against the APP ROOT — `db/schema.lite` says
// `./db/shop.db`, naming a sibling of itself from one level up — so anchoring
// it to the process CWD makes the same schema mean a different file depending
// on which directory the command was typed in. That is `FJS-449`: `litestone
// studio` run from `db/` opened `db/db/shop.db`, an empty database it had just
// created, and served it for nineteen hours; a `vite build` run from a surface
// root prerendered twelve product pages as zero products and exited 0.
//
// The app root is where `db/` lives (Invariant 3), so it is the schema file's
// own directory, or its parent when that directory is named `db`. A schema kept
// anywhere else anchors to its own directory, which is what a flat single-file
// example wants and is what it already got from the CWD.
export function schemaAnchor(schemaFilePath) {
  if (!schemaFilePath) return null
  const dir = dirname(resolve(schemaFilePath))
  return basename(dir) === 'db' ? dirname(dir) : dir
}

/**
 * The directory a relative declared path resolves against, from `resolveFrom`.
 *
 *   'cwd'          the process working directory — the default, unchanged
 *   'schema'       the app root, derived from the schema FILE (schemaAnchor)
 *   '<dir>'        that directory, said outright
 *   file: URL      the directory it names — a URL ending in `/` IS the
 *                  directory, anything else names a file and its dirname is
 *
 * **The default stays 'cwd' and the reason is measured.** Anchoring every
 * caller that passes a schema file breaks isolation-by-CWD, which is a real
 * contract and not an accident: basecamp's seed test runs the seeder in a
 * scratch directory with `cwd: dir`, redirecting `database main` by env var and
 * `database audit` — which has no env var — by the CWD alone. Under an
 * unconditional anchor that audit log went back to the shared `db/audit/` and
 * the suite failed with SQLITE_BUSY. basecamp's own `core/db.ts` documents
 * depending on it.
 *
 * **A STATED anchor is the half that reaches an embedded schema.** `'schema'`
 * needs a file, and an app that assembles its schema in memory — auth's
 * fragments, the outbox model, a tenant registry — has none, so it fell back to
 * the CWD and every declared path followed whichever directory the process
 * started in. Naming the root is the only thing that can be true from any of
 * them, and it is one statement rather than one absolute `join()` per path.
 *
 * A stated anchor that is not a directory throws. It is a statement, and a
 * statement that quietly reverts to the CWD is the failure this exists to end.
 */
export function resolveAnchor(resolveFrom, schemaFilePath) {
  if (!resolveFrom || resolveFrom === 'cwd') return null
  if (resolveFrom === 'schema') return schemaAnchor(schemaFilePath)

  const stated = resolveFrom instanceof URL ? urlDir(resolveFrom)
               : typeof resolveFrom === 'string' && resolveFrom.startsWith('file:') ? urlDir(new URL(resolveFrom))
               : typeof resolveFrom === 'string' ? resolve(resolveFrom)
               : null

  if (!stated)
    throw new Error(
      `createClient({ resolveFrom }): expected 'cwd', 'schema', a directory path or a file: URL, ` +
      `got ${typeof resolveFrom}`
    )

  if (!isDir(stated))
    throw new Error(
      `createClient({ resolveFrom }): not a directory — ${stated}\n` +
      `  Every relative \`database { path }\` would resolve against it. ` +
      `Name the app root: resolveFrom: new URL('../..', import.meta.url)`
    )

  return stated
}

// A URL ending in `/` names the directory; anything else names a file in it.
function urlDir(url) {
  const p = fileURLToPath(url)
  return url.pathname.endsWith('/') ? p : dirname(p)
}

function isDir(p) {
  try { return existsSync(p) && statSync(p).isDirectory() } catch { return false }
}

/**
 * A database was opened somewhere that did not exist a moment ago.
 *
 * Creating the FILE is ordinary — every first run does it. Creating the
 * DIRECTORY it sits in is the signal, and it is the one every measured instance
 * of `FJS-449` shares: `example/db/db/`, `example/web/db/` and `example/site/db/`
 * were each minted by a command run one directory away from where the path was
 * written. Nothing failed in any of them — SQLite opened a fresh database and
 * every tool then reported on that one — and the repo's `*.db*` ignore rule
 * means `git status` stays clean, so the only way to find one is to go looking.
 *
 * The cwd is in the message because the resolved path alone does not say what
 * went wrong: `db/shop.db` from the app root and from a surface root print the
 * same relative string and name different files.
 */
export function noteMintedDirectory(dir, absPath) {
  console.warn(
    `[litestone] Created ${dir} for a database that was not there.\n` +
    `            path: ${absPath}\n` +
    `            cwd:  ${process.cwd()}\n` +
    `            A relative \`database { path }\` resolves against the working directory. ` +
    `If this is not where the data lives, the command was run from the wrong place — ` +
    `anchor it with createClient({ resolveFrom }).`
  )
}
