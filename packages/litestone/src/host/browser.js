// host/browser.js — the same surface as `host/node.js`, answered by a browser.
//
// Three kinds of answer, and the kinds matter more than the count.
//
// **Implemented.** Paths are pure string arithmetic and a browser wants exactly
// the same answers, so they are written out rather than shimmed away. The async
// context is a stack, which is correct HERE and nowhere else — see below.
//
// **Refused by name.** A filesystem, a temp directory, a module resolver. These
// are not missing features, they are the shape of the place: there is no
// directory to make and no `.lite` on disk to read, because a browser client is
// handed its schema already parsed. Each throws saying what was reached for and
// what to do instead, at the moment it is called, so the answer arrives with a
// stack rather than as `undefined is not a function`.
//
// **Refused on purpose.** `@encrypted` and `@hashed`. WebCrypto is asynchronous
// and the engine contract is synchronous, so there is no honest way to decrypt a
// column inside the statement that read it — but that is the smaller reason.
// The larger one is that decrypting on a device means the key is on the device,
// and a column is `@encrypted` precisely because somebody decided it should not
// be lying around. A local database holding the ciphertext and refusing to read
// it is the correct outcome, not a gap.

const no = (what, instead) => () => {
  const e = new Error(`[Litestone] ${what} is not available in a browser. ${instead}`)
  e.code = 'HOST_UNAVAILABLE'
  throw e
}

// ─── paths ────────────────────────────────────────────────────────────────
//
// POSIX only. A database name in OPFS is an opaque key that happens to look
// like a path, and there is no drive letter in a browser to get wrong.

export const isAbsolute = (p) => p.startsWith('/')

const normalize = (parts) => {
  const out = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else out.push('..') }
    else out.push(part)
  }
  return out
}

export function join(...segments) {
  const parts = segments.filter(Boolean).join('/').split('/')
  const lead  = segments[0]?.startsWith('/') ? '/' : ''
  return (lead + normalize(parts).join('/')) || '.'
}

// No `process.cwd()` to resolve against, so the root IS the root. An app that
// wanted a path relative to something has to say what.
export function resolve(...segments) {
  let out = []
  for (const seg of segments) {
    if (!seg) continue
    if (seg.startsWith('/')) out = seg.split('/')
    else out = out.concat(seg.split('/'))
  }
  return '/' + normalize(out).join('/')
}

export function dirname(p) {
  const i = p.lastIndexOf('/')
  if (i === -1) return '.'
  if (i === 0)  return '/'
  return p.slice(0, i)
}

export function basename(p, ext) {
  const b = p.slice(p.lastIndexOf('/') + 1)
  return ext && b.endsWith(ext) && b !== ext ? b.slice(0, -ext.length) : b
}

export function extname(p) {
  const b = basename(p)
  const i = b.lastIndexOf('.')
  return i <= 0 ? '' : b.slice(i)
}

// ─── the filesystem there isn't ───────────────────────────────────────────

const FS = 'a browser has no filesystem — a database is a name in OPFS, and the schema arrives already parsed.'

// `existsSync` is the one that ANSWERS rather than throws. Every caller asks it
// to decide whether a file has to be created, and *no* is both true and the
// answer that makes them do the right thing; throwing here would turn a boot
// into a crash for a question with a correct answer.
export const existsSync = () => false

export const statSync      = no('statSync', FS)
export const mkdirSync     = no('mkdirSync', FS)
export const readdirSync   = no('readdirSync', FS)
export const mkdtempSync   = no('mkdtempSync', FS)
export const readFileSync  = no('readFileSync', FS)
export const writeFileSync = no('writeFileSync', FS)
export const appendFileSync = no('appendFileSync', FS)
export const rmSync        = no('rmSync', FS)
export const renameSync    = no('renameSync', FS)
export const openSync      = no('openSync', FS)
export const readSync      = no('readSync', FS)
export const writeSync     = no('writeSync', FS)
export const fstatSync     = no('fstatSync', FS)
export const closeSync     = no('closeSync', FS)
export const watch         = no('watch', 'cross-process change notification is a server concern; OPFS serializes writers itself.')
export const tmpdir        = no('tmpdir', FS)

// ─── resolving a module ───────────────────────────────────────────────────

const PARSED = 'pass the schema as text or already parsed — a `.lite` that imports another is resolved at build time.'
export const fileURLToPath = no('fileURLToPath', PARSED)
export const pathToFileURL = no('pathToFileURL', PARSED)
export const createRequire = no('createRequire', PARSED)

// ─── crypto ───────────────────────────────────────────────────────────────

const KEYS = 'an @encrypted or @hashed column is not readable on a device: WebCrypto is asynchronous, and holding the key here would defeat the attribute.'
export const createCipheriv   = no('createCipheriv', KEYS)
export const createDecipheriv = no('createDecipheriv', KEYS)
export const createHmac       = no('createHmac', KEYS)
// WebCrypto's digest is asynchronous and every caller here is inside a
// synchronous statement. What reaches for it is the migration journal, which is
// a server's record of files on a disk — neither of which a device has.
export const createHash       = no('createHash', 'A migration digest is taken where the migration files are.')
export const randomBytes      = (n) => crypto.getRandomValues(new Uint8Array(n))

// ─── the call in progress ─────────────────────────────────────────────────
//
// A STACK, and it is correct here for one stated reason: the browser client
// runs inside a worker that handles one request at a time. Nothing else is in
// flight, so *the current store* and *the store of the call I am inside* are
// the same thing, which is the only property `AsyncLocalStorage` is being asked
// for (transaction ownership, and the flavor a table answers as).
//
// **It is wrong the moment two calls interleave**, because a store restored on
// exit is restored for whoever is running, not for whoever entered. So the
// worker's serialization is not a performance choice that can be relaxed later
// — it is what makes this class honest, and `src/browser/worker.js` says so
// where it enforces it.
export class AsyncLocalStorage {
  #store = undefined

  getStore() { return this.#store }

  // The restore has to wait for a PROMISE to settle, not for `fn` to return.
  // Every caller here is `async`, so a `try/finally` around the call restores
  // the previous store at the callee's first `await` — while the call is still
  // running — and the next read of `ctx.isSystem` finds nothing and throws the
  // refusal meant for a floating promise. Caught by the conformance drive on
  // the first run after this file existed.
  run(store, fn, ...args) {
    const previous = this.#store
    this.#store = store
    let result
    try {
      result = fn(...args)
    } catch (err) {
      this.#store = previous
      throw err
    }
    if (result && typeof result.then === 'function') {
      return result.then(
        (value) => { this.#store = previous; return value },
        (err)   => { this.#store = previous; throw err },
      )
    }
    this.#store = previous
    return result
  }

  enterWith(store) { this.#store = store }
}
