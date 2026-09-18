/**
 * pending.js — the writes this device has made and the server has not confirmed.
 *
 * Phase 1 of the Homestead work (`IDEAS/homestead.md`), and the first thing in
 * this framework that holds a write the network could not carry. Before it, a
 * write made with no server reachable was lost — measured, not assumed, by
 * `example`'s `verify:offline`.
 *
 * ── Queue-first, one path ───────────────────────────────────────────────────
 *
 * The entry is written BEFORE the call goes out, not in a catch after it fails.
 * That is what every production sync engine does — PowerSync records the write
 * and its queue entry in one transaction and sending is that queue draining
 * (`IDEAS/prior-art.md` § 4) — and the reason is that a catch-based queue has
 * two routes to the server with a seam between them, and the seam is where a
 * write goes twice or not at all.
 *
 * ── An entry clears on an ACKNOWLEDGEMENT, never on a send ───────────────────
 *
 * This is the rule `verify:offline` paid for. Chrome's offline mode refuses new
 * connections and carries frames on a socket that is already open, so a call can
 * leave on a socket that has not noticed the network is gone and arrive minutes
 * later with the screen never told. A queue that cleared on send would count
 * that as delivered. `settle()` is called from the success path and nowhere
 * else.
 *
 * ── Why every entry carries a key ───────────────────────────────────────────
 *
 * The key IS the entry's primary key, and it rides on the call as
 * `CallOptions.idempotencyKey`. A replay under the same key answers the first
 * call's result without running the pipeline — no second row, no second email,
 * no second announcement — which is what makes re-sending a write nobody can
 * say arrived a safe thing to do rather than a gamble.
 *
 * Two limits worth knowing before trusting it, both the server's: the claim is
 * backed by the app cache, so it is PER PROCESS and a replay that lands on
 * another instance behind a load balancer executes again; and a caller with no
 * principal gets no entry at all, because `anonymous` is not an identity.
 *
 * ── Durability, and what happens without it ─────────────────────────────────
 *
 * IndexedDB, because a write has to outlive the document — a phone that sleeps
 * in a stockroom is the case this exists for. Where it is unavailable (a private
 * window, blocked site data, a server render) the queue still runs IN MEMORY and
 * says so: `durable` is false. That is deliberate rather than a fallback nobody
 * meant — an in-memory queue still survives an outage the page lives through,
 * which is most of them — but a screen that promises "saved, will sync" while
 * `durable` is false is promising something a reload breaks.
 */

import { getClient } from '@frontierjs/sierra/junction'

const DB_NAME    = 'fjs-pending'
const DB_VERSION = 1
const STORE      = 'writes'

/* ─── storage ──────────────────────────────────────────────────────────────── */

/** A promise for one IDBRequest. */
const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result)
  req.onerror   = () => reject(req.error)
})

/**
 * Open the database, or answer null where there is none to open.
 *
 * Every accessor is guarded rather than the open alone: a private window throws
 * on `indexedDB` itself, a locked-down one returns a handle whose transactions
 * then fail, and a server render has no global at all. Three different shapes
 * of the same answer.
 */
async function openDb() {
  try {
    if (typeof indexedDB === 'undefined') return null
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' })
    }
    return await wrap(req)
  } catch {
    return null
  }
}

/* ─── the queue ────────────────────────────────────────────────────────────── */

/**
 * @param {object}   [opts]
 * @param {Function} [opts.onChange]  called after every mutation, with the list
 * @param {Function} [opts.now]       injected clock, for a test that needs one
 */
export function createPendingQueue({ onChange = null, now = () => Date.now() } = {}) {
  /** Mirror of what is stored, so a screen can read the list synchronously. */
  const mem = new Map()

  let db       = null
  let durable  = false
  const ready  = openDb().then(async (handle) => {
    db = handle
    durable = !!handle
    if (!handle) return
    // Whatever the last session left behind. A write made in a stockroom and
    // abandoned when the phone slept is here, and it is the whole point.
    try {
      const tx = handle.transaction(STORE, 'readonly')
      for (const row of await wrap(tx.objectStore(STORE).getAll())) mem.set(row.key, row)
    } catch { /* a store we cannot read is an empty one */ }
    announce()
  })

  function announce() {
    if (onChange) onChange(list())
  }

  async function write(entry) {
    mem.set(entry.key, entry)
    if (db) {
      try { await wrap(db.transaction(STORE, 'readwrite').objectStore(STORE).put(entry)) }
      catch { durable = false }   // the handle is there and the write is not
    }
    announce()
  }

  async function drop(key) {
    mem.delete(key)
    if (db) {
      try { await wrap(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key)) }
      catch { /* gone from memory either way */ }
    }
    announce()
  }

  /** Oldest first — a queue that replays out of order is not a queue. */
  const list = () => [...mem.values()].sort((a, b) => a.createdAt - b.createdAt)

  return {
    ready,
    get durable() { return durable },

    /**
     * Record the intent. Answers the entry, whose `key` goes on the call.
     *
     * `data` is structured-cloned by IndexedDB, and a `File` clones fine — but
     * phase 1 does not queue one: a write carrying bytes is the second half of
     * phase 2 and the resource refuses it by name rather than storing a blob
     * nothing will ever upload.
     */
    async add({ service, model, method, id, data }) {
      const entry = {
        key:       crypto.randomUUID(),
        service, model, method,
        id:        id ?? null,
        data:      data ?? null,
        createdAt: now(),
        attempts:  0,
        state:     'pending',
        lastError: null,
      }
      await write(entry)
      return entry
    },

    /** The server acknowledged it. The ONLY caller is the success path. */
    settle: (key) => drop(key),

    /**
     * The server answered and refused. Kept rather than dropped, in `rejected`,
     * because a write somebody made and the boundary declined is news — dropping
     * it silently is the failure this whole queue exists to stop, just later in
     * the sequence (`FJS-D300`).
     */
    async reject(key, error) {
      const entry = mem.get(key)
      if (!entry) return
      await write({
        ...entry,
        state:     'rejected',
        lastError: { message: String(error?.message ?? error), code: error?.code ?? null },
      })
    },

    /** It did not reach the server. Counted, kept, tried again later. */
    async defer(key, error) {
      const entry = mem.get(key)
      if (!entry) return
      await write({
        ...entry,
        attempts:  entry.attempts + 1,
        lastError: { message: String(error?.message ?? error), code: error?.code ?? null },
      })
    },

    /** Somebody chose to discard a rejected write. */
    forget: (key) => drop(key),

    list,
    pending:  () => list().filter(e => e.state === 'pending'),
    rejected: () => list().filter(e => e.state === 'rejected'),

    /**
     * Send what is waiting, oldest first, stopping at the first one that still
     * cannot reach the server.
     *
     * Serial and stop-on-unreachable, both deliberate. Serial because a later
     * write may depend on an earlier one — phase 2's problem, and draining in
     * parallel would make it unfixable rather than merely open. Stop-on-
     * unreachable because if one call cannot reach the server the next cannot
     * either, and hammering a dead network turns every entry's `attempts` into
     * a number that means nothing.
     */
    async drain(send) {
      await ready
      for (const entry of list()) {
        if (entry.state !== 'pending') continue
        const outcome = await send(entry)
        if (outcome === 'unreachable') return
      }
    },
  }
}

/**
 * Did this failure mean *the server never heard it*?
 *
 * The client attaches `code` when the server ANSWERED — a status for HTTP, and
 * 408 where either transport timed out. No `code` at all is a request that never
 * got a reply: a fetch that threw, a socket that is gone.
 *
 * **408 is deliberately on the unreachable side.** A timeout is the one answer
 * that does not say whether the write arrived, and that ambiguity is exactly
 * what the idempotency key makes safe — re-sending under the same key either
 * lands the write or replays the answer of the one that already did.
 *
 * Not `retryable`, which is the SERVER saying *the row moved under you, re-read
 * and re-apply*. That is a different question with a different answer and
 * sharing a word would eventually share a branch.
 */
export function unreachable(err) {
  const code = err?.code
  return code === undefined || code === null || code === 408
}

/* ─── the app's queue ──────────────────────────────────────────────────────── */

let _queue = null

/**
 * One queue for the whole app, not one per resource.
 *
 * Order is the reason. A write to an order and a write to its line have to
 * replay in the order they were made, and two queues draining side by side
 * cannot promise that — which is phase 2's dependent-write problem arriving
 * early and unfixably.
 */
export function pendingQueue() {
  if (!_queue) {
    _queue = createPendingQueue()
    _armDrain()
  }
  return _queue
}

/**
 * Send one entry again, as the call it was.
 *
 * The hooks already ran when it was enqueued and what is stored is what they
 * produced — coerced, blank-stripped, validated, version-stamped. Replaying
 * through the resource pipeline would run them a second time on their own
 * output, so this goes straight to the client with the entry's own key.
 */
async function _send(client, entry) {
  const proxy = client.service(entry.service)
  const opts  = { idempotencyKey: entry.key }
  switch (entry.method) {
    case 'create': return proxy.create(entry.data ?? {}, undefined, opts)
    case 'patch':  return proxy.patch(entry.id, entry.data ?? {}, undefined, opts)
    case 'remove': return proxy.remove(entry.id, undefined, opts)
    case 'restore': return proxy.restore(entry.id, undefined, opts)
    default:       return proxy.invoke(entry.method, entry.id, entry.data, undefined, opts)
  }
}

/** Drain everything waiting. Answers what it did, for a caller that wants it. */
export async function drainPending(client) {
  const q = pendingQueue()
  let settled = 0, rejected = 0
  await q.drain(async (entry) => {
    try {
      await _send(client, entry)
      await q.settle(entry.key)
      settled++
      return 'settled'
    } catch (err) {
      if (unreachable(err)) { await q.defer(entry.key, err); return 'unreachable' }
      await q.reject(entry.key, err)
      rejected++
      return 'rejected'
    }
  })
  return { settled, rejected }
}

let _armed = false

/**
 * Drain when the socket comes back, and once at boot.
 *
 * `connect` rather than `navigator.onLine`: the browser says the interface is
 * up, the socket says this client can talk to that server, and it is the second
 * one a queue is waiting on. The boot drain is what empties a queue left behind
 * by a tab that never reconnected at all.
 */
function _armDrain() {
  if (_armed) return
  _armed = true
  try {
    const client = getClient()
    if (!client) return
    const both = async () => {
      await drainPending(client)
      // The bytes go AFTER the rows, because an attachment names a row that has
      // to exist before it can. Imported here rather than at the top for two
      // reasons: it is what keeps the two modules a one-way dependency —
      // attachments asks this file what `unreachable` means — and an app that
      // never queues a photograph never loads the blob queue at all.
      const { drainAttachments } = await import('./attachments.js')
      await drainAttachments(client)
    }
    client.on('connect', () => { both().catch(() => {}) })
    if (client.connected) both().catch(() => {})
  } catch {
    // No client yet — the first write to enqueue will have built one, and the
    // `connect` that follows it drains. A queue that threw here would take the
    // write down with it, which is the opposite of the job.
  }
}

/** Test seam: forget the app-wide queue so a suite can build its own. */
export function _resetPendingQueue() { _queue = null; _armed = false }
