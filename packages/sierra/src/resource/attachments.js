/**
 * attachments.js — the BYTES this device is holding, which are not a row.
 *
 * Phase 2 of the Homestead work (`IDEAS/homestead.md`), ruled by `FJS-D301`.
 * Two queues rather than one, which is where every SDK that has had to do this
 * ended up (`IDEAS/review-prior-art.md` § 4), and the reasons are not stylistic:
 *
 *   · **A 4MB photograph must not block a 200-byte correction.** One FIFO
 *     carrying both makes the small write wait on the large one over exactly
 *     the connection that cannot carry the large one.
 *   · **A row and its bytes fail differently.** A refused write is news for a
 *     person to act on; a half-sent upload is a retry. Sharing a queue would
 *     mean sharing `attempts`, `state` and a drain rule, and one of the two
 *     would get the wrong one.
 *   · **An object is immutable once named.** The key here names the bytes and
 *     is never rewritten, which is what makes re-sending safe. A row entry is
 *     the opposite — it carries a payload somebody may still be editing.
 *
 * ── What crosses, and what does not ─────────────────────────────────────────
 *
 * Nothing new. An entry drains as an ordinary `patch` carrying the Blob, which
 * junction's client already turns into multipart and litestone's `FileStorage`
 * already turns into an object plus a ref. There is no upload endpoint, no
 * pending-file value in the column, and no second answer to who may write —
 * which is the same argument phase 1 made for having no sync protocol.
 *
 * ── Why it is a PATCH and not part of the create ────────────────────────────
 *
 * The row has to exist before its bytes can name it. So the write queue drains
 * first and this one after it, and the id this entry carries is the one the
 * BROWSER minted (`x-mint`, phase 2) — which is the only reason a photograph
 * taken in a stockroom has anything to attach itself to. A model whose key only
 * the server can assign cannot hold an attachment offline, and the schema
 * advisor says so rather than leaving it to be discovered.
 *
 * ── The online path is unchanged ────────────────────────────────────────────
 *
 * A create with a photograph on a working network is still ONE multipart call.
 * The entry here is written before that call goes out — queue-first, the same
 * rule — and settled by the same acknowledgement that settles the write. The
 * split only happens when the send could not arrive.
 */

import { getClient }  from '@frontierjs/sierra/resource'
import { unreachable } from './pending.js'
import { isStaleWrite } from './field-rules.js'

const DB_NAME    = 'fjs-attachments'
const DB_VERSION = 1
const STORE      = 'blobs'

/** A promise for one IDBRequest. */
const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result)
  req.onerror   = () => reject(req.error)
})

/**
 * Open the database, or answer null where there is none to open.
 *
 * Guarded the same three ways `pending.js` is — a private window throws on
 * `indexedDB` itself, a locked-down one hands back a handle whose transactions
 * fail, and a server render has no global.
 *
 * **A separate DATABASE rather than a second store beside the writes.** A blob
 * store is the one that fills a device's quota, and a quota failure that took
 * the write queue down with it would lose a row to save a photograph.
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
 * @param {Function} [opts.now]  injected clock, for a test that needs one
 */
export function createAttachmentQueue({ now = () => Date.now() } = {}) {
  const mem = new Map()

  let db      = null
  let durable = false
  const ready = openDb().then(async (handle) => {
    db = handle
    durable = !!handle
    if (!handle) return
    try {
      const tx = handle.transaction(STORE, 'readonly')
      for (const row of await wrap(tx.objectStore(STORE).getAll())) mem.set(row.key, row)
    } catch { /* a store we cannot read is an empty one */ }
    announce()
  })

  const listeners = new Set()
  function announce() {
    const l = list()
    for (const fn of listeners) fn(l)
  }

  async function write(entry) {
    mem.set(entry.key, entry)
    if (db) {
      // A Blob is structured-cloneable and IndexedDB stores it by reference to
      // the browser's own blob store, so this does not read the bytes into JS.
      // It is also the write most likely to fail on quota, which is why a
      // failure here only costs durability rather than the entry.
      try { await wrap(db.transaction(STORE, 'readwrite').objectStore(STORE).put(entry)) }
      catch { durable = false }
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

  const list = () => [...mem.values()].sort((a, b) => a.createdAt - b.createdAt)

  return {
    ready,
    get durable() { return durable },

    /**
     * Hold one field's bytes for one row. Answers the entry.
     *
     * `id` is the row the bytes belong to and is REQUIRED — an attachment with
     * nothing to attach to is a file nobody will ever find. The caller is the
     * resource layer, which has the id because the browser minted it.
     */
    async add({ service, model, id, field, blob, versionField = null, callHeaders = null }) {
      if (id == null)  throw new Error('an attachment needs the id of the row it belongs to')
      if (!field)      throw new Error('an attachment needs the field it fills')
      const entry = {
        key:       crypto.randomUUID(),
        service, model, field,
        id,
        blob,
        // The `@version` column, where the model has one. Litestone refuses a
        // patch there that carries no version, and the version this patch
        // needs is the one the row is at once the write queue has drained —
        // not knowable now, so `version` is read at the first send and kept.
        versionField,
        version:   null,
        // The workspace the row was written in; the bytes drain there, not in
        // whichever one the client names at drain (`FJS-1372`).
        callHeaders,
        // Copied out of the Blob so a list can be rendered without touching the
        // bytes — a queue screen showing three photographs should not decode
        // three photographs.
        name:      blob?.name ?? null,
        type:      blob?.type ?? null,
        size:      blob?.size ?? null,
        createdAt: now(),
        attempts:  0,
        state:     'pending',
        lastError: null,
      }
      await write(entry)
      return entry
    },

    /** The server acknowledged it. The ONLY caller is a success path. */
    settle: (key) => drop(key),

    /**
     * The server answered and refused — a type `@accept` does not allow, a row
     * that is gone. Kept in `rejected`, for the reason a refused write is
     * (`FJS-D300`): the person took the photograph, and dropping it silently is
     * the failure this exists to stop.
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

    /**
     * The version the next send carries. Kept on the entry because a send
     * whose answer was lost may have landed and moved the row, and a re-send
     * reading afresh would reuse the idempotency key under a different
     * payload, which junction refuses `422`. Null forgets it.
     */
    async pin(key, version) {
      const entry = mem.get(key)
      if (!entry) return null
      const next = { ...entry, version }
      await write(next)
      return next
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

    /** Somebody chose to discard a rejected upload. */
    discard: (key) => drop(key),

    /** Called with the list after every change; answers the unsubscribe. */
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },

    list,
    pending:  () => list().filter(e => e.state === 'pending'),
    rejected: () => list().filter(e => e.state === 'rejected'),

    /** Bytes waiting, in total. What a screen shows before asking to upload on data. */
    bytes: () => list().filter(e => e.state === 'pending').reduce((n, e) => n + (e.size ?? 0), 0),

    /**
     * Send what is waiting, oldest first, stopping at the first one that still
     * cannot reach the server.
     *
     * Serial rather than parallel, and for a different reason than the write
     * queue's: these are the large ones. Three uploads sharing a stockroom's
     * one bar of signal finish later than three taken in turn, and all three
     * time out together.
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

/* ─── the app's queue ──────────────────────────────────────────────────────── */

let _queue = null

/** One attachment queue for the whole app, the way there is one write queue. */
export function attachmentQueue() {
  if (!_queue) _queue = createAttachmentQueue()
  return _queue
}

/**
 * Send one entry again, as the patch it is.
 *
 * Straight to the client rather than through the resource pipeline, for the
 * same reason a replayed write is: the hooks ran when the row was written, and
 * running them again on their own output would coerce and validate a payload
 * that is now one Blob.
 */
async function _send(client, q, entry) {
  const svc  = client.service(entry.service)
  const data = { [entry.field]: entry.blob }
  const call = entry.callHeaders ? { callHeaders: entry.callHeaders } : {}
  if (entry.versionField) {
    if (entry.version == null) {
      const row = await svc.get(entry.id, undefined, undefined, call)
      entry = (await q.pin(entry.key, row?.[entry.versionField] ?? null)) ?? entry
    }
    data[entry.versionField] = entry.version
  }
  return svc.patch(
    entry.id,
    data,
    undefined,
    // The key is the entry's, so a re-send after a timeout nobody can read
    // replays the first answer instead of uploading a second object and
    // orphaning the first. `madeAt` dates it when the file was attached, not
    // when it uploaded (`FJS-D469`).
    { idempotencyKey: entry.key, madeAt: entry.createdAt, ...call },
  )
}

/** Drain everything waiting. Answers what it did, for a caller that wants it. */
export async function drainAttachments(client) {
  const q = attachmentQueue()
  let settled = 0, rejected = 0
  await q.drain(async (entry) => {
    try {
      try {
        await _send(client, q, entry)
      } catch (err) {
        // Somebody else wrote the row between the read and the patch. The
        // bytes do not depend on what they wrote, so read it again once —
        // a failed call released the idempotency key, so the new version
        // may ride it.
        if (!isStaleWrite(err)) throw err
        await _send(client, q, await q.pin(entry.key, null) ?? entry)
      }
      await q.settle(entry.key)
      settled++
      return 'settled'
    } catch (err) {
      // The write queue's own question, asked of the same client's errors.
      // A second copy of it here would be a second answer to *did the server
      // hear this*, and the two would drift on the day 408 stops meaning what
      // it means.
      if (unreachable(err)) { await q.defer(entry.key, err); return 'unreachable' }
      await q.reject(entry.key, err)
      rejected++
      return 'rejected'
    }
  })
  return { settled, rejected }
}

/** Test seam: forget the app-wide queue so a suite can build its own. */
export function _resetAttachmentQueue() { _queue = null }
