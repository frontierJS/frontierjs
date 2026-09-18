// host/node.js — what Litestone needs from the runtime that is NOT SQL.
//
// The engine seam (`core/engine.js`) answers *what runs the SQL*. This answers
// everything else a server runtime happens to provide and a browser does not: a
// filesystem, a temp directory, a module resolver, node's crypto, and an async
// context. Two seams, and the division is the useful one — an engine is a
// choice an app makes, a host is a fact about where the code is running.
//
// `#host` resolves to this file everywhere except under the `browser`
// condition, and this half is deliberately a re-export and nothing else. A
// wrapper here would be a second implementation of `node:path` with its own
// bugs, and the server path is the one that must not get slower or stranger to
// make the browser work.
//
// The surface is WIDE and that is the measurement, not a design. Every name
// below is imported by some module in the client's graph; the browser half has
// to answer each one, and the ones it answers by throwing are the honest list
// of what a device cannot do.

// ─── paths ────────────────────────────────────────────────────────────────
export { resolve, join, dirname, basename, extname, isAbsolute } from 'path'

// ─── the filesystem ───────────────────────────────────────────────────────
export {
  existsSync, statSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, writeFileSync, appendFileSync, rmSync, renameSync,
  openSync, readSync, closeSync, watch,
} from 'fs'

export { tmpdir } from 'os'

// ─── resolving a module, for a `.lite` that imports another ───────────────
export { fileURLToPath, pathToFileURL } from 'url'
export { createRequire }                from 'node:module'

// ─── crypto, for @encrypted / @hashed ─────────────────────────────────────
//
// Node's are SYNCHRONOUS, which is what lets an encrypted column be read inside
// the same statement as every other column. WebCrypto is not, which is why the
// browser half refuses rather than approximating.
export { createCipheriv, createDecipheriv, randomBytes, createHmac, createHash } from 'crypto'

// ─── the call in progress ─────────────────────────────────────────────────
//
// Two things ride on this and both are correctness rather than convenience:
// which context OWNS an open transaction, and which flavor of client a table
// method is answering as. `core/client.js` § the flavor of client a call is
// running as has the argument.
export { AsyncLocalStorage } from 'node:async_hooks'
