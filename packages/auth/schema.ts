// schema.ts
// Auth's contribution to the seed, read off the two `.lite` files beside it.
//
// THE `.lite` FILES ARE THE SOURCE. This module reads them; it does not carry a
// copy. `fli auth:install` reads the same bytes out of the app's node_modules
// rather than importing this file, because `fli` runs on node and this is
// TypeScript — a hand copy lived in `commands/auth/install.md` for exactly that
// reason and drifted twice (pre-rename scalars that no longer parse, a missing
// `role`, and `@@gate("9")`, which is LOCKED and walled the auth tables off
// from this package itself).
//
// The split is by who owns the model, and the gate already states it:
//
//   db/user.lite  — User, @@gate("4.4.4.5") + row and field policies. The app's.
//                   It grows columns, relations point at it, sessionFields reads
//                   it. Appended into the app's own schema.lite.
//   db/auth.lite  — Credential / Session / Verification, all @@gate("8"), which
//                   means nothing outside asSystem() speaks to them and this
//                   package is the only caller that does. Imported, so an
//                   upgrade to this package arrives without a re-inject.
//
// Model names are PascalCase singular (Invariant 2), so the accessors auth.ts
// uses are db.user / db.credential / db.session / db.verification.

import { readFileSync } from 'node:fs'

// A shipped `.lite` file has to parse standalone, so it cannot carry a `${db}`
// placeholder — it spells the attribute out and this rewrites it. `main` is also
// what an absent @@db means, so the literal is redundant to the parser and load
// bearing to the substitution; do not "tidy" it out of the files.
//
// ANCHORED TO THE LINE. Both files discuss the attribute in their own header
// comments, and a bare substring replace rewrote that prose too — leaving a
// copied file whose header described a substitution it no longer showed.
const DB_ATTR = /^([ \t]*)@@db\(main\)/gm

const readLite = (name: string): string =>
  readFileSync(new URL(`./db/${name}`, import.meta.url), 'utf8')

/** Rewrites the database a fragment's models land in. `main` is a no-op. */
export function retargetDb(source: string, db = 'main'): string {
  return db === 'main' ? source : source.replace(DB_ATTR, `$1@@db(${db})`)
}

/**
 * `model User` — the identity table. Belongs in the app's own schema.lite:
 * this is the auth model an app extends, relates to and renders.
 */
export function authUserModel(db = 'main'): string {
  return retargetDb(readLite('user.lite'), db)
}

/**
 * `model Credential` / `Session` / `Verification` — the credential machinery,
 * all @@gate("8"). Belongs in a file of its own that schema.lite imports.
 */
export function authMachineryModels(db = 'main'): string {
  return retargetDb(readLite('auth.lite'), db)
}

/**
 * Both halves as one string, for a caller assembling a schema in memory rather
 * than on disk — `example/api/db.ts` and this package's own test harness.
 * An app installed by `fli auth:install` gets the two-file split instead.
 */
export function authSchemaFragments(db = 'main'): string {
  return `${authUserModel(db)}\n${authMachineryModels(db)}`
}
