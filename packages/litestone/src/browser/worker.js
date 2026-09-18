// browser/worker.js — Litestone's client, running in a dedicated worker.
//
// This is the whole of the browser port's runtime half. A page imports
// `browser/client.js`, which starts this file as a module worker; everything
// below runs where OPFS's synchronous access handles exist, which is the only
// place they do.
//
// ─── Why the client is HERE and not on the page ───────────────────────────
//
// Because the engine contract is synchronous and OPFS is only synchronous in a
// worker, those two facts pick the thread between them. What makes it cheap is
// that the model API was ALREADY async — `findMany` has always been awaited —
// so the round trip hides inside an `await` an app already writes. Nothing in
// `core/client.js` changed to get here.
//
// ─── One call at a time, and it is load-bearing ───────────────────────────
//
// Messages are queued and run strictly in order. That is not throughput
// caution: `host/browser.js`'s `AsyncLocalStorage` is a single slot, and a
// single slot answers *the store of the call I am inside* correctly only while
// there is exactly one call. Two overlapping calls would restore each other's
// store, and what that looks like is a table answering as the wrong principal —
// silently, with rows. So the queue is the shim's proof obligation, and it may
// not be relaxed for speed without replacing the shim first.
//
// A read is microseconds of synchronous SQLite, so the queue costs a page
// nothing it would notice.

import { setEngine }               from '../core/engine.js'
import { createSqliteWasmEngine }  from '../engines/sqlite-wasm.js'

let client = null

// The queue. `tail` is the promise for everything already accepted; a new
// message chains onto it, so ordering is the microtask queue's job rather than
// a flag somebody has to remember to clear on the error path.
let tail = Promise.resolve()

self.onmessage = (event) => {
  const message = event.data
  tail = tail.then(() => handle(message)).catch((err) => {
    // Nothing above should reject — `handle` answers its own errors — so a
    // rejection here is a defect in this file rather than in a caller's query.
    // Reported rather than swallowed, or the queue dies silently and every
    // later call hangs with no message.
    self.postMessage({ id: message?.id, err: describe(err) })
  })
}

async function handle({ id, op, ...rest }) {
  try {
    const result = await run(op, rest)
    self.postMessage({ id, ok: result })
  } catch (err) {
    self.postMessage({ id, err: describe(err) })
  }
}

async function run(op, args) {
  if (op === 'open')  return open(args)
  if (op === 'call')  return call(args)
  if (op === 'close') { client?.$close?.(); client = null; return true }
  throw new Error(`[Litestone] unknown worker op '${op}'. Expected: open, call, close.`)
}

// ─── open ─────────────────────────────────────────────────────────────────

async function open({ schema, db = '/litestone.db', wasmUrl, vfs, capacity, options = {} }) {
  if (client) throw new Error('[Litestone] this worker already holds a client. Start a second worker for a second database.')

  // The URL is the page's to decide — bundled, on a CDN, or out of the service
  // worker's precache — so it arrives as a string rather than being imported
  // here, where a bundler would pull 868 kB of wasm into every build that so
  // much as mentions Litestone.
  const engine = await createSqliteWasmEngine({
    load: () => import(/* @vite-ignore */ wasmUrl),
    ...(vfs ? { vfs } : {}), ...(capacity ? { capacity } : {}),
  })
  setEngine(engine)

  const { createClient } = await import('../core/client.js')

  // A string is `.lite` source; an object is a parse result the host already
  // made. The second is the one a real app uses, and the reason is disclosure
  // rather than speed: shipping the app's whole `.lite` would undo the prose
  // stripping `FJS-D204` measured at 23 kB and hand over the row policies
  // `FJS-D303` ruled a model must OPT IN to. A projection is a filter over the
  // parsed tree, which needs no emitter and cannot accidentally carry a comment.
  client = typeof schema === 'string'
    ? await createClient({ ...options, schema, db })
    : await createClient({ ...options, parsed: schema, db })

  // Answered so the page's proxy can refuse a misspelled model by name instead
  // of posting a message that fails three layers down.
  return { engine: engine.name, models: modelsOf(client) }
}

// A model accessor is the thing that can `findMany`. Asked that way rather than
// by excluding `$`-prefixed keys, because the client's own surface also carries
// `sql` and `query` — two plain names that are not models and that a list
// written out here would have to be kept in step with.
const modelsOf = (c) => Object.keys(c).filter(k => typeof c[k]?.findMany === 'function')

// ─── call ─────────────────────────────────────────────────────────────────

const FLAVORS = new Set(['system', 'auth', 'none'])

function call({ flavor, model, method, args = [] }) {
  if (!client) throw new Error('[Litestone] no client in this worker — call open() first.')

  const scoped = scopeFor(flavor)
  const table  = scoped[model]
  if (!table) throw new Error(
    `[Litestone] '${model}' is not a model in this schema. Models: ${modelsOf(client).join(', ')}`)

  const fn = table[method]
  if (typeof fn !== 'function') throw new Error(`[Litestone] '${model}.${method}' is not a method.`)

  return fn.call(table, ...args)
}

function scopeFor(flavor) {
  if (!flavor || flavor.kind === 'none') return client
  if (!FLAVORS.has(flavor.kind)) throw new Error(`[Litestone] unknown flavor '${flavor.kind}'.`)
  if (flavor.kind === 'system') return client.asSystem()
  return client.$setAuth(flavor.user)
}

// ─── errors ───────────────────────────────────────────────────────────────
//
// An Error survives `structuredClone` as name and message and loses everything
// else, and everything else is what a caller acts on: `ACCESS_DENIED` is how
// sierra decides whether to hide a screen or show a failure. So the fields are
// copied out by name, and any own enumerable property comes along — a
// ValidationError carries its field list that way.

function describe(err) {
  if (!err || typeof err !== 'object') return { name: 'Error', message: String(err) }
  const out = { name: err.name ?? 'Error', message: err.message ?? String(err) }
  for (const key of ['code', 'model', 'operation', 'required', 'got', 'capability', 'field', 'errors'])
    if (err[key] !== undefined) out[key] = err[key]
  return out
}
