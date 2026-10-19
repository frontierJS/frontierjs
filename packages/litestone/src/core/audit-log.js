// @ts-check
// audit-log.js — `@trail` and `@@trail`: which reads and writes are recorded,
// the entry each one writes, and the fire-and-forget write of it.

/** @import { LitestoneSchema, ModelDef, LogEntry, LogRequestContext } from '../index.d.ts' */
/** @import { Ctx } from './field-policy.js' */

// ─── Trail driver helpers ────────────────────────────────────────────────────

// The auto-generated model AST for driver:trail databases in auto mode.
// Shape is fixed — owned by Litestone, not the user.
// Model name: <DbName>Trail  e.g. audit → AuditTrail — PascalCase like every
// model (Invariant 2); the accessor `db.auditTrail` is derived from it.
/**
 * @param {string} dbName
 * @returns {string}
 */
export function trailModelName(dbName) {
  return dbName.charAt(0).toUpperCase() + dbName.slice(1) + 'Trail'
}

/**
 * @param {string} dbName
 * @returns {ModelDef}
 */
export function makeLoggerAutoModel(dbName) {
  const name = trailModelName(dbName)
  const f = (/** @type {string} */ fieldName, /** @type {string} */ typeName, optional = false) => ({
    name: fieldName,
    type: { kind: 'scalar', name: typeName, optional, array: false },
    attributes: [],
    comments: [],
  })
  return {
    name,
    fields: [
      f('operation',  'String'),
      f('model',      'String'),
      f('field',      'String',     true),
      // WHICH named move an update was, where it was one. `operation` stays
      // `update` because the row is one; two moves between the same states
      // write identical before- and after-images, and only this separates
      // an order abandoned by its commitment from one a person cancelled.
      f('transition', 'String',     true),
      f('records',    'Json'),
      f('before',     'Json',     true),
      f('after',      'Json',     true),
      // NOT Int. The actor is whatever the host app's users are keyed by, and
      // @frontierjs/auth issues `id String @id @default(uuid())` — so an Int
      // column threw SQLITE_CONSTRAINT_DATATYPE on the first audited write with
      // a known actor, taking the request with it. `Any` is a real SQLite STRICT
      // column type; the jsonl driver maps it, and the .jsonl itself was always
      // untyped JSON.
      f('actorId',    'Any',  true),
      f('actorType',  'String',     true),
      // Support mode: `actorId` is the OPERATOR and this is the principal the
      // boundary actually enforced as. Filing an impersonated write under the
      // impersonated person is the default everywhere else and is what makes a
      // trail unusable as evidence — the person who did it is the one who is
      // missing from it. `episodeId` groups a whole episode, which is what
      // answers *who looked at my record, when, and why* rather than *what
      // happened to this row*.
      f('subjectId',  'Any',  true),
      f('episodeId',  'String',     true),
      // WHERE the write came from. Every other audit package in the field
      // records ip/user-agent/url and this one recorded none of them, so a row
      // said who wrote it and nothing about the request that carried it.
      //
      // `correlationId` is the one none of them has, and it is the reason the
      // rest are worth having: it is what joins this row to the log lines the
      // same request wrote. `source` stands where laravel-auditing puts `url` —
      // a URL is the wrong shape here, because the same write arrives over HTTP,
      // over a socket frame that has no URL, and from a job with no request at
      // all, while `orders.pay` is one answer for all three.
      f('correlationId', 'String', true),
      f('source',        'String', true),
      f('origin',        'String', true),
      f('ip',            'String', true),
      f('userAgent',     'String', true),
      // Under `strategy database` one trail database is shared by the whole
      // fleet by design, so without this the trail cannot tell two tenants
      // apart at all.
      f('tenant',        'String', true),
      f('meta',       'Json',     true),
      { name: 'createdAt', type: { kind: 'scalar', name: 'DateTime', optional: false, array: false },
        attributes: [{ kind: 'default', value: { kind: 'call', fn: 'now' } }], comments: [] },
    ],
    attributes: [
      { kind: 'db',    name: dbName },
      // SYSTEM, as the auth models are. A row here carries the before- and
      // after-image of every trailed write, every tenant's included, so an
      // ungated trail hands a caller with no principal what every model it
      // records refuses them. The trail's own writes do not pass the gate.
      { kind: 'gate',  value: '8' },
      { kind: 'index', fields: ['actorId'] },
      { kind: 'index', fields: ['model'] },
      // *Everything that happened in this request* is the question a trail is
      // read with once it can be asked at all.
      { kind: 'index', fields: ['correlationId'] },
      { kind: 'index', fields: ['episodeId'] },
    ],
    comments: [],
  }
}

// Build a map of @trail and @@trail declarations from the schema.
// Returns:
//   fields: { 'ModelName.fieldName': [{ db, reads, writes }] }
//   models: { 'ModelName':           [{ db, reads, writes }] }
/** @typedef {{ db: unknown, reads: unknown, writes: unknown }} LogTarget  one `@trail`/`@@trail` declaration, as the parser wrote it */
/** @param {LitestoneSchema} schema */
export function buildLogMap(schema) {
  /** @type {Record<string, LogTarget[]>} */
  const fields = {}
  /** @type {Record<string, LogTarget[]>} */
  const models = {}

  for (const model of schema.models) {
    // Field-level @trail
    for (const field of model.fields) {
      const logAttr = field.attributes.find(a => a.kind === 'trail')
      if (!logAttr) continue
      const key = `${model.name}.${field.name}`
      if (!fields[key]) fields[key] = []
      fields[key].push({ db: logAttr.db, reads: logAttr.reads, writes: logAttr.writes })
    }
    // Model-level @@trail (can appear multiple times)
    for (const attr of model.attributes) {
      if (attr.kind !== 'trail') continue
      if (!models[model.name]) models[model.name] = []
      models[model.name].push({ db: attr.db, reads: attr.reads, writes: attr.writes })
    }
  }

  return { fields, models }
}

/**
 * What KIND of caller a principal is, for the trail's `actorType`.
 *
 * A principal states its own type where it has one. Otherwise the object
 * decides, and the distinction that matters is an `id`: a claims-only
 * principal — `$setAuth({ cartToken })`, what junction hands the Data boundary
 * for a caller with no session — is a bearer capability and has none. Reading
 * any principal OBJECT as a user filed every guest write as a person nobody
 * could name, which is a null id wearing the same shape as a session whose id
 * went missing (`FJS-1195`).
 *
 * `system` rather than nothing for `asSystem()`, because *the application did
 * this* and *nobody was in scope* are different answers and only one of them
 * is null. `src/export.js` said `system` here while this line said nothing.
 * @param {Ctx} ctx
 */
function actorTypeOf(ctx) {
  if (ctx.auth?.type) return String(ctx.auth.type)
  if (ctx.isSystem)   return 'system'
  if (!ctx.auth)      return null
  return ctx.auth.id != null ? 'user' : 'bearer'
}

/**
 * A before/after image as the line stores it. A Bytes column is a Uint8Array,
 * which `JSON.stringify` writes as an object keyed by index — about 13
 * characters a byte, and no longer bytes — in both images of every later update
 * of the row (`FJS-2164`). It goes down as base64, the form the JSON Schema
 * already names for Bytes. `btoa` and no `Buffer`: this runs in a browser
 * (`FJS-D305`). `this[key]` because a Buffer has already been through its own
 * `toJSON` by the time the replacer sees it.
 * @param {unknown} image
 */
function imageJson(image) {
  return JSON.stringify(image, function (key, value) {
    const raw = this[key]
    if (!(raw instanceof Uint8Array)) return value
    let binary = ''
    for (const byte of raw) binary += String.fromCharCode(byte)
    return btoa(binary)
  })
}

// Build the log entry object from the standard fields + onLog.
// ctx is the request context (has ctx.auth).
// onLog is the user-supplied function from createClient options.
/**
 * @param {{ operation: LogEntry['operation'], model: string, field?: string | null, transition?: string | null,
 *           records?: unknown[], before?: unknown, after?: unknown, lifted?: string[] | null }} write
 * @param {Ctx} ctx
 * @param {((entry: Record<string, unknown>, ctx: Ctx) => Record<string, any> | null | void) | null | undefined} onLog
 */
export function buildLogEntry({ operation, model, field, transition, records, before, after, lifted }, ctx, onLog) {
  // WHERE the write came from. Supplied by whoever owns the request — junction
  // installs a closure over its own request store — because this package sits
  // BELOW the one that has a request (Invariant 1) and must not learn about it.
  // Same shape as `now`: a function the client is handed, called at the moment
  // the value is needed rather than read once at construction, because these
  // change per request and a client is built once.
  //
  // A throw here must not take the write with it. The audit row is a side
  // effect of a write that already succeeded, and a provider that fails should
  // cost the provenance columns and nothing else.
  /** @type {LogRequestContext | null} */
  let from = null
  const provide = ctx._logContext?.fn
  if (provide) { try { from = provide() ?? null } catch { from = null } }

  const entry = {
    operation,
    model,
    field:     field    ?? null,
    transition: transition ?? null,
    records:   JSON.stringify(records ?? []),
    before:    before   != null ? imageJson(before) : null,
    after:     after    != null ? imageJson(after)  : null,
    // An episode inverts the actor. Inside one the principal in scope IS the
    // subject — that is what makes the ceiling the subject's — so `ctx.auth.id`
    // answers who the write was made AS and nobody answers who made it. The
    // operator comes down the same closure as the rest of the provenance, and
    // where there is one the two ids swap roles.
    //
    // A BEARER has the same shape for the opposite reason: the principal is a
    // capability rather than a person, so it carries no id at all and the row
    // would be filed under nobody. The grant is the actor and what it was for
    // is the subject, which is the only way *which link wrote this* survives a
    // revocation. Both arrive down the provenance closure because neither is
    // on the principal — one is deliberately hidden from it, the other is a
    // row this package never read. A person holding a grant as well is the
    // actor over it: the grant is a thing they held, and `actorType` already
    // files the row as a user (`FJS-D832`).
    actorId:   from?.operatorId ?? ctx.auth?.id ?? from?.bearerId ?? null,
    actorType: from?.operatorId ? (from.operatorType ?? 'support') : actorTypeOf(ctx),
    subjectId: from?.operatorId ? (ctx.auth?.id ?? null)
             : from?.bearerId  ? (from?.bearerSubject ?? null)
             : null,
    episodeId: from?.episodeId ?? null,
    correlationId: from?.correlationId ?? null,
    source:        from?.source        ?? null,
    origin:        from?.origin        ?? null,
    ip:            from?.ip            ?? null,
    userAgent:     from?.userAgent     ?? null,
    tenant:        from?.tenant        ?? null,
    // A write that named `system: ['@@gate']` is filed under the person who
    // caused it, at a level they do not hold — without the mark the row reads
    // as a gate the trail watched fail (`FJS-D575`).
    meta:      lifted?.length ? JSON.stringify({ lifted }) : null,
    createdAt: new Date().toISOString(),
  }

  if (onLog) {
    try {
      // A SNAPSHOT of the three keys the flavor decides, over the live ctx as
      // prototype so everything schema-derived still resolves through it.
      //
      // `onLog` runs inside the call, so the live ctx would answer — but a
      // callback that keeps what it was handed (batching entries, pushing them
      // onto an array) reads it after the call is over, and a live view throws
      // there by design. Freezing the principal is what that callback wanted;
      // `tables` is deliberately NOT frozen in, because a held ctx that can
      // still write rows is the escape rather than a use of it.
      const seen = Object.create(ctx, {
        auth:     { value: ctx.auth,     enumerable: true },
        isSystem: { value: ctx.isSystem, enumerable: true },
        scopedBy: { value: ctx.scopedBy, enumerable: true },
      })
      const extra = onLog(entry, seen) ?? {}
      if ('actorId'   in extra && extra.actorId   != null) entry.actorId   = extra.actorId
      if ('actorType' in extra && extra.actorType != null) entry.actorType = extra.actorType
      if ('meta'      in extra && extra.meta      != null) entry.meta      = JSON.stringify(
        lifted?.length && typeof extra.meta === 'object' && !Array.isArray(extra.meta) ? { ...extra.meta, lifted } : extra.meta
      )
    } catch {}
  }

  return entry
}

/**
 * The entry as a trail table is written: its Json columns as values. `onLog`
 * sees the text, but the table encodes a Json column itself, so handing it text
 * stores a quoted string that reads back as text rather than the object
 * (`FJS-2038`).
 * @param {Record<string, any>} entry
 */
export function trailRowValues(entry) {
  const out = { ...entry }
  for (const column of ['records', 'before', 'after', 'meta'])
    if (typeof out[column] === 'string') out[column] = JSON.parse(out[column])
  return out
}

// Fire-and-forget write to a log table.
// Never blocks, never throws to caller.
// Uses setImmediate (or setTimeout fallback) to push the I/O outside the current
// event loop tick entirely — avoids microtask-queue I/O stacking on hot paths.
//
// **The catch has to be on the PROMISE.** Every driver's `create` is `async`, so
// a `try` around the call catches nothing: the throw becomes a rejected promise
// with no handler, which under Bun is an unhandled rejection rather than the
// swallowed write this is documented to be. It stayed invisible because the one
// realistic failure — a contended index — could not happen while the index had
// a five-second wait; `busyTimeout: { audit: 0 }` makes it happen every time.
//
// Swallowed, but not silent: a lost audit row is the one write whose whole
// purpose is being there afterwards, so the first loss per log table says so.
// Once, because the failure that produces one produces thousands.
const _loggedLogFailure = new Set()
const _inFlightLog = new Set()

// The warning is once per model, because the failure that produces one produces
// thousands. That is right for a human reading stderr and useless to anything
// asking *is the trail still being written* — an audit trail that stopped
// recording reads exactly like an app doing nothing, and the one warning
// scrolled past hours ago. So the counts are kept as well, and junction puts
// them on /metrics. `stats` is the client's own object, shared by reference.
//
// Entries queued for one log table in the same tick go down as ONE createMany.
// The cost of a trail write is its commit — five B-tree pages into the index's
// WAL, plus the checkpoints they bring — not the entry or the pipeline, so a
// request that writes ten rows paid ten commits for ten lines (`FJS-2317`).
/**
 * @typedef {{ create: (args: { data: unknown }) => unknown, createMany: (args: { data: unknown[] }) => unknown }} LogTable
 * @typedef {{ dropped: number, written: number, lastError?: string, lastDroppedAt?: string, lastWrittenAt?: string }} LogStats
 */
/**
 * @param {LogTable | null | undefined} logTable
 * @param {{ model?: string } & Record<string, unknown>} entry
 * @param {LogStats | null | undefined} stats
 */
export function fireLog(logTable, entry, stats) {
  if (!logTable) return
  const queued = _pendingLog.get(logTable)
  if (queued) { queued.entries.push(entry); return }
  // Registered until it runs, so a process that ends before the next tick can
  // still append it: a seed script ending in `process.exit`, or a crash right
  // after a committed write, left the row in main and no line in the trail.
  _pendingLog.set(logTable, { entries: [entry], stats })
  armExitFlush()
  const run = () => flushLog(logTable)
  if (typeof setImmediate === 'function') setImmediate(run)
  else setTimeout(run, 0)
}

/** @type {Map<LogTable, { entries: Array<{ model?: string } & Record<string, unknown>>, stats: LogStats | null | undefined }>} */
const _pendingLog = new Map()
let _exitFlushArmed = false

/**
 * @param {LogTable} logTable
 * @param {boolean} [now]  write with no await, for a process that is ending
 */
function flushLog(logTable, now = false) {
  const queued = _pendingLog.get(logTable)
  if (!queued) return
  _pendingLog.delete(logTable)
  const { entries, stats } = queued
  // A SQL trail's `create` awaits its pipeline, so on a process ending in this
  // tick the INSERT never runs; its `appendSync` is the same rows with no await.
  const sync = now && typeof logTable.appendSync === 'function' ? logTable.appendSync.bind(logTable) : null
  if (sync) {
    const each = () => { for (const entry of entries) writeLogSync(() => sync([entry]), [entry], stats) }
    return entries.length === 1 ? each() : writeLogSync(() => sync(entries), entries, stats, each)
  }
  if (entries.length === 1) return writeLog(() => logTable.create({ data: entries[0] }), entries, stats)
  // A batch that fails is retried one entry at a time, so one entry a SQL
  // trail's own model refuses costs that entry and not the request's others.
  writeLog(() => logTable.createMany({ data: entries }), entries, stats,
    () => { for (const entry of entries) writeLog(() => logTable.create({ data: entry }), [entry], stats) })
}

/**
 * @param {() => unknown} write
 * @param {Array<{ model?: string }>} entries
 * @param {LogStats | null | undefined} stats
 * @param {() => void} [fallback]
 */
function writeLogSync(write, entries, stats, fallback) {
  try {
    write()
    if (stats) { stats.written += entries.length; stats.lastWrittenAt = new Date().toISOString() }
  } catch (err) { dropLog(err, entries, stats, fallback) }
}

/**
 * @param {() => unknown} write
 * @param {Array<{ model?: string }>} entries
 * @param {LogStats | null | undefined} stats
 * @param {() => void} [fallback]
 */
function writeLog(write, entries, stats, fallback) {
  const swallow = (/** @type {any} */ err) => dropLog(err, entries, stats, fallback)
  try {
    const settled = Promise.resolve(write())
      .then(() => { if (stats) { stats.written += entries.length; stats.lastWrittenAt = new Date().toISOString() } })
      .catch(swallow)
      .finally(() => _inFlightLog.delete(settled))
    _inFlightLog.add(settled)
  }
  catch (err) { swallow(err) }   // a driver that throws before its first await
}

/**
 * @param {any} err
 * @param {Array<{ model?: string }>} entries
 * @param {LogStats | null | undefined} stats
 * @param {(() => void) | undefined} fallback
 */
function dropLog(err, entries, stats, fallback) {
  if (fallback) return fallback()
  if (stats) { stats.dropped += entries.length; stats.lastError = String(err?.message ?? err); stats.lastDroppedAt = new Date().toISOString() }
  const key = entries[0]?.model ?? 'log'
  if (_loggedLogFailure.has(key)) return
  _loggedLogFailure.add(key)
  console.warn(
    `[litestone] audit write for '${key}' failed and was dropped: ${err?.message ?? err}\n` +
    `            The trail is incomplete from here. Further losses for this model are not reported.`
  )
}

// A jsonl driver's `create` and `createMany` do their file I/O before their
// first await, and a SQL trail's table has `appendSync`, so a queued write run
// here lands before this returns and the process can end on it.
export function flushPendingLogs() {
  for (const logTable of [..._pendingLog.keys()]) flushLog(logTable, true)
}

// A SQL trail's `create` runs the table's pipeline, so its INSERT lands a few
// microtasks after `flushPendingLogs` started it. A client that closes in
// between arms its throw first, and the row is dropped with 'This Litestone
// client is closed'. Null when nothing is in flight, so a close with no trail
// work stays synchronous. A batch that fails retries entry by entry, and those
// writes register while the first settles, hence the loop.
/** @returns {Promise<void> | null} */
export function drainPendingLogs() {
  flushPendingLogs()
  if (!_inFlightLog.size) return null
  return (async () => {
    while (_inFlightLog.size) await Promise.allSettled([..._inFlightLog])
  })()
}

function armExitFlush() {
  const proc = typeof process === 'undefined' ? undefined : process
  if (_exitFlushArmed || typeof proc?.on !== 'function') return
  _exitFlushArmed = true
  proc.on('exit', flushPendingLogs)
}
