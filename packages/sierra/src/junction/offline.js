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
 * ── It fills the device's tables too, and that is the hydration ───────────
 *
 * A warm fills the cache under `listKey(service, query, directives)`, which is
 * the key `load()` will later look under — the SAME function, because a second
 * derivation would warm slots nothing reads and be invisible until the outage.
 * Keyed by question, that is a cache with a schedule: the declared question is
 * answerable offline and a different one is not.
 *
 * **The same rows go into the device's own tables when an app has them**
 * (`offline: { db: true }`), and that erases the bound — a query engine does not
 * care which question put a row there. It is also the whole of *hydration*: the
 * tables were previously only as full as what a screen HAPPENED to read, so a
 * person who never opened a screen before losing signal had nothing in it, and
 * `@@sync`'s read direction was a claim with nothing behind it. What an app
 * declares is now what the device holds, whether or not anyone looked.
 *
 * **The declaration keeps meaning the SCREEN's question** — matching it exactly
 * is what makes the cache slot the one `load()` reads — so the device is as full
 * as the declared window and no fuller. A device-sized window and a screen-sized
 * one are two grains, and one option cannot be both while the cache is still
 * underneath (`IDEAS/homestead.md` § Open questions).
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
import { writeThrough, localDbConfigured } from './local-db.js'
import { getClient }                       from '@frontierjs/sierra/junction'

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
 * `kept` is whether the rows reached the device's own tables, and it is in the
 * report because *hydrated nothing* and *hydrated* are otherwise one answer: the
 * cache holds the declared question either way, so a screen asking exactly that
 * question renders identically with the database empty.
 *
 * @returns {Promise<Array<{service: string, rows?: number, kept?: boolean, error?: string}>>}
 */
export async function warmOffline() {
  const out = []
  for (const { service, model, find, query, directives } of _declared.values()) {
    try {
      const rows = await find(query, directives)
      await listCache().remember(listKey(service, query, directives), rows)

      // Awaited, unlike the write-through a `load()` makes: nothing is
      // rendering, so there is no screen to keep off a disk — and the report
      // is worth having only if it is a fact rather than a hope.
      const kept = model && localDbConfigured()
        ? await writeThrough(model, rows)
        : false

      out.push({ service, rows: Array.isArray(rows) ? rows.length : 0, kept })
    } catch (err) {
      out.push({ service, error: err?.message ?? String(err) })
    }
  }
  return out
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
export function _resetOffline() { _declared.clear(); _armed = false }
