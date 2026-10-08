/**
 * offline.js — the reads a screen must already hold before it needs them.
 *
 * Phase 4 of the Homestead work (`IDEAS/homestead.md`), and the half `FJS-D307`
 * added on top of the cache. `list-cache.js` is option B — every read that
 * ARRIVES is remembered, and an unreachable one is answered from what was
 * remembered. B alone does not ship the promise: a stocktake in a basement can
 * only query rows somebody happened to open earlier, and *which screens did I
 * visit before I lost signal* is not a thing a person can predict or a developer
 * can test.
 *
 * So a resource says what it must hold, and this warms it.
 *
 *   export const sheets = createResource('stocktakeSheets', {
 *     model:        'StocktakeSheet',
 *     offlineQuery: { query: { closedAt: null } },
 *   })
 *
 * ── The device's tables are the answer; the cache is the fallback ─────────
 *
 * The rows go into the device's own tables when an app has them (`offline: {
 * db: true }`), and that erases the bound a keyed slot puts on them — a query
 * engine does not care which question put a row there. It is also the whole of
 * *hydration*: the tables were previously only as full as what a screen
 * HAPPENED to read, so a person who never opened a screen before losing signal
 * had nothing in it, and `@@sync`'s read direction was a claim with nothing
 * behind it. What an app declares is now what the device holds, whether or not
 * anyone looked.
 *
 * **So the declaration is the DEVICE's window, and the keyed slot is skipped
 * for a model the device kept** (`FJS-D337`). With SQL underneath it, the slot
 * is a second answer to a question the tables answer anyway — and a narrower
 * one, since it replays the exact query it was given and nothing else.
 *
 * **What skips it is the write-through having LANDED, never the config.**
 * `localDb()` answers null on any failure by design — no OPFS, a worker that
 * will not start, a device out of quota — so reading `db: true` as *the device
 * holds this* would leave such a device with an empty screen and nothing said.
 * A warm that finds the rows did not land fills the cache under
 * `listKey(service, query, directives)`, the key `load()` will later look
 * under — the SAME function, because a second derivation would warm slots
 * nothing reads and be invisible until the outage.
 *
 * ── Warming may not touch a store ──────────────────────────────────────────
 *
 * `resource.load()` writes the rows into the store the screen is rendering. A
 * warm runs in the background, under a question nobody is looking at, so going
 * through `load()` would swap the list under somebody's eyes — the feature
 * breaking the screen it exists to protect. It calls `find` and remembers the
 * answer, which is `load()`'s other half and nothing else.
 *
 * ── A declaration only exists once its module does ────────────────────────
 *
 * `createResource` runs at import (Invariant 18) and this runs with it, so a
 * resource nothing has imported yet has declared nothing — and a route's
 * modules are code-split, which means the screen nobody has opened is exactly
 * the one that declares nothing. An app names the screens that must work with
 * no server by importing their resources at boot, after the client exists.
 * `example`'s `web/src/main.js` is one line doing that; the framework half is
 * `FJS-1178`.
 *
 * ── Armed like the queue, and for the same reason ──────────────────────────
 *
 * On `connect` and once at boot, exactly as `pending.js` arms its drain: the
 * socket says this client can talk to that server, where `navigator.onLine`
 * only says the interface is up. Re-warming on every reconnect is what keeps
 * what is held from being a copy of last Tuesday.
 */

import { listCache, listKey }              from './list-cache.js'
import { writeRows, localDbConfigured }    from './local-db.js'
import { getClient }                       from '@frontierjs/sierra/resource'

/**
 * What has been declared, keyed by service name.
 *
 * By SERVICE rather than by resource object: two modules creating a resource
 * over one service with the same declaration are one thing to warm, and a
 * module re-evaluated by HMR would otherwise leave a stale entry behind whose
 * `find` closes over a dead client.
 */
const _declared = new Map()

/**
 * Declare the read. Called by `createResource`, never by an app directly — the
 * declaration belongs beside the model, with the other three `*Query` options.
 *
 * @param {object} spec
 * @param {string} spec.service     the service name, which is half the cache key
 * @param {string} [spec.model]     the model the rows belong to — what the device's
 *                                  tables are named for, and the only thing the
 *                                  cache half does not need
 * @param {Function} spec.find      `(query, directives) => rows` — the resource's own read
 * @param {object} [spec.query]     filters (Invariant 10)
 * @param {object} [spec.directives] limit / offset / orderBy / select
 */
export function declareOffline({ service, model, find, query, directives }) {
  _declared.set(service, {
    service, model: model ?? null, find,
    query: query ?? {}, directives: directives ?? null,
  })
  _armWarm()
}

/**
 * Run every declared read and remember what it answered.
 *
 * Answers a per-service report rather than throwing: one service refusing must
 * not stop the others being held, and a warm that cannot reach the server is
 * the ordinary case rather than a failure — the queue is in the same position
 * and says so the same way.
 *
 * `kept` is whether the rows reached the device's own tables, and it decides
 * the line under it: a model the device holds gets no keyed slot (`FJS-D337`),
 * and one it does not gets the slot it always had. So it is a fact rather than
 * a hope, and a screen can say which of the two it is reading.
 *
 * **Every read is made before any row is written, and the writes run in
 * passes** (`FJS-1279`). A batch the device refused is written again after the
 * others land, until a pass lands nothing; what never lands is on the report as
 * `error`, with its rows. A parent the device does not hold is not a refusal
 * (`FJS-D485`) — its connection does not enforce foreign keys — so what the
 * passes retry is a refusal of any other kind, a quota or a locked pool.
 *
 * @returns {Promise<Array<{service: string, rows?: number, kept?: boolean, error?: string}>>}
 */
export async function warmOffline() {
  const out  = []
  const read = []
  for (const { service, model, find, query, directives } of _declared.values()) {
    try {
      const rows  = await find(query, directives)
      const entry = { service, rows: Array.isArray(rows) ? rows.length : 0, kept: false }
      out.push(entry)
      read.push({ entry, service, model, query, directives, rows })
    } catch (err) {
      out.push({ service, error: err?.message ?? String(err) })
    }
  }

  // Awaited, unlike the write-through a `load()` makes: nothing is rendering,
  // so there is no screen to keep off a disk — and the answer is what decides
  // whether the cache below is written at all.
  let left = localDbConfigured() ? read.filter(r => r.model) : []
  const refused = new Map()
  while (left.length) {
    const again = []
    for (const r of left) {
      try {
        r.entry.kept = await writeRows(r.model, r.rows)
        refused.delete(r)
      } catch (err) {
        refused.set(r, err)
        again.push(r)
      }
    }
    if (again.length === left.length) break
    left = again
  }

  for (const [r, err] of refused) {
    r.entry.error = err?.message ?? String(err)
    _warnOnce(r.service, err)
  }

  for (const r of read)
    if (!r.entry.kept) await listCache().remember(listKey(r.service, r.query, r.directives), r.rows)

  _last = { report: out, ranAt: Date.now() }
  _listeners.forEach(fn => fn(_status))
  return out
}

/* ─── what the warm answered ───────────────────────────────────────────────── */

let _last = null
const _listeners = new Set()

const _status = {
  /** The last warm's report, per service — `null` until one has finished. */
  report:    () => _last?.report ?? null,
  /** When that warm finished, ms since the epoch; `null` until one has. */
  ranAt:     () => _last?.ranAt ?? null,
  /** What was declared, which the report says the outcome of. */
  services:  () => offlineServices(),
  /** After every warm; answers the unsubscribe. */
  subscribe: (fn) => { _listeners.add(fn); return () => _listeners.delete(fn) },
}

/**
 * What this device holds, as the last warm found it (`FJS-D484`).
 *
 * The boot and reconnect warms are armed by Sierra and answer to nobody, so
 * their report was discarded and an app could not tell a device holding its
 * window from one that holds nothing. It is a status object beside
 * `pendingQueue()` for the same reason: one noun a screen reads, subscribes to
 * and shows, rather than a raw promise from a call it did not make.
 *
 * `report()` is `warmOffline()`'s answer — `{service, rows?, kept?, error?}`
 * per declared service — and `kept` is what says the rows are on the device
 * rather than only in the list cache.
 */
export function offlineStatus() { return _status }

// Once per service per document: the warm re-runs on every reconnect, and a
// window the device cannot hold is refused the same way every time.
const _warned = new Set()
function _warnOnce(service, err) {
  if (_warned.has(service)) return
  _warned.add(service)
  console.warn(`[Sierra] the offline warm kept nothing of '${service}' on the device, so its declared read is answered from the list cache: ${err?.message ?? err}`)
}

/** What a screen needs to say how much is held — service names, in declaration order. */
export const offlineServices = () => [..._declared.keys()]

let _armed = false

/**
 * Warm when the socket comes up, and once at boot.
 *
 * Armed by the first declaration rather than at import, so an app that declares
 * nothing installs no listener and makes no request. The boot warm is the one
 * that matters: it is what fills a screen the person has not opened yet, which
 * is the entire difference between this and the cache underneath it.
 */
function _armWarm() {
  if (_armed) return

  // `_armed` is set only where a client was actually found, which is the whole
  // of this ordering. A declaration made before `initJunction` has run — a
  // resource module evaluated at import, which is where every resource is
  // built (Invariant 18) — would otherwise mark the app armed against a client
  // that does not exist, and nothing would ever warm. The declaration is still
  // registered: the map is the record, and the next one to arrive arms it.
  let client = null
  try { client = getClient() } catch { client = null }
  if (!client) return

  _armed = true
  client.on('connect', () => { warmOffline().catch(() => {}) })
  if (client.connected) warmOffline().catch(() => {})
}

/** Test seam: forget every declaration so a suite can build its own. */
export function _resetOffline() { _declared.clear(); _armed = false; _warned.clear(); _last = null; _listeners.clear() }
