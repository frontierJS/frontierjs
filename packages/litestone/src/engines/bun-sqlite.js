// engines/bun-sqlite.js — the server engine, and the only file in this package
// that names `bun:sqlite`.
//
// `test/engine-seam.test.ts` asserts that, because the value of the seam is
// entirely in the count being one: a tenth `new Database()` somewhere else
// would work perfectly on Bun and take the browser down with it, silently, at
// whatever future moment somebody tried to build litestone for a browser.
//
// There is no adapter here. Bun's Database already answers the contract in
// `core/engine.js` method for method — the contract was READ OFF it rather
// than designed against it, because a second engine is the thing that has to
// bend, and pretending otherwise would have cost a wrapper on the hot path for
// no reader's benefit.
//
// ─── The one optional part: sqlite-vec ────────────────────────────────────
//
// `FJS-D331` rules the extension an optional accelerator and never the
// mechanism, so this file must work identically whether or not it is there.
// Installing the package is how a server opts in — there is no flag, because
// "a server may install it" is the whole of the decision and a flag would be a
// second way to say the same thing.
//
// Two things about it are worth knowing before changing this:
//
//   • `SELECT load_extension(…)` as SQL answers `not authorized` on Bun. The C
//     API that `db.loadExtension()` reaches is the only door, which is why a
//     string arriving in a query cannot open one. Do not "fix" that by enabling
//     the SQL function.
//   • the resolve is SYNCHRONOUS and lazy, through `createRequire`. A top-level
//     `await import('sqlite-vec')` would make this module async, and it is
//     imported by `core/engine.js` which is imported by everything — so the
//     whole graph would become async to save one require of a 4 kB shim.

import { Database }     from 'bun:sqlite'
import { createRequire } from 'node:module'

// `undefined` until the first open asks; `null` once asked and not found, so a
// missing package is looked for once rather than on every connection.
let vec

function findVec() {
  if (vec !== undefined) return vec
  try {
    // The npm package is a shim over a per-platform binary, and it throws
    // rather than answering a path on a platform it has no build for — Alpine
    // being the one that bites, since there is no musl build in the set. A
    // throw here is an absent accelerator and never an error: the JS path in
    // `core/vector.js` is the ruled default and already handles every read.
    const mod = createRequire(import.meta.url)('sqlite-vec')
    vec = { entry: mod.getLoadablePath() }
  } catch {
    vec = null
  }
  return vec
}

// ─── Arming is per connection, and it is NOT done at open ─────────────────
//
// An extension loads into a CONNECTION, so every connection that runs a
// similarity query needs it. Doing that in `open()` is the obvious version and
// it is wrong: measured, `loadExtension` costs **0.535 ms** against a 0.115 ms
// bare open, so it makes every connection 5.6x more expensive — and litestone
// opens far more connections than an app has databases. Every migration diff
// builds a pristine `:memory:` schema, `createTestEnv` clones a template per
// test, each tenant is a client, and each database has a read and a write
// handle. None of those run a vector query. Loading there took the erpnext
// corpus test from passing to an 11.1 s timeout.
//
// So the capability carries the MEANS rather than the fact of having done it:
// whatever compiles a similarity read arms the connection it is about to use,
// once. `armed` is a WeakSet so a closed connection is collectable.
const armed = new WeakSet()

export default {
  name: 'bun:sqlite',
  sync: true,

  // A getter rather than a value: the capability is decided by what is
  // installed, and a value computed at module load would run the resolve on
  // every import of litestone, including the ones that never open a database.
  get vector() {
    if (findVec() === null) return null
    return {
      cosineDistance: 'vec_distance_cosine',
      // Idempotent and cheap on repeat, because the caller cannot reasonably
      // track which connection it is on — `wrapDb` hands out a statement cache,
      // not a database.
      arm(db) {
        if (armed.has(db)) return
        db.loadExtension(findVec().entry)
        armed.add(db)
      },
    }
  },

  open(path, { readonly = false } = {}) {
    return readonly ? new Database(path, { readonly: true }) : new Database(path)
  },
}
