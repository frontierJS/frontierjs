// @ts-check
// audit-log.js — `@trail` and `@@trail`: which reads and writes are recorded,
// the entry each one writes, and the fire-and-forget write of it.

/** @import { LitestoneSchema, ModelDef, LogEntry, LogRequestContext } from '../index.d.ts' */
/** @import { Ctx } from './field-policy.js' */

// ─── Logger driver helpers ────────────────────────────────────────────────────

// The auto-generated model AST for driver:trail databases in auto mode.
// Shape is fixed — owned by Litestone, not the user.
// Model name: <dbName>Trail  e.g. audit → auditTrail
/**
 * @param {string} dbName
 * @returns {ModelDef}
 */
export function makeLoggerAutoModel(dbName) {
  const name = dbName + 'Trail'
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
    before:    before   != null ? JSON.stringify(before)  : null,
    after:     after    != null ? JSON.stringify(after)   : null,
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
    // files the row as a user (`FJS-D831`).
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

// The warning is once per model, because the failure that produces one produces
// thousands. That is right for a human reading stderr and useless to anything
// asking *is the trail still being written* — an audit trail that stopped
// recording reads exactly like an app doing nothing, and the one warning
// scrolled past hours ago. So the counts are kept as well, and junction puts
// them on /metrics. `stats` is the client's own object, shared by reference.
/**
 * @param {{ create: (args: { data: unknown }) => unknown } | null | undefined} logTable
 * @param {{ model?: string } & Record<string, unknown>} entry
 * @param {{ dropped: number, written: number, lastError?: string, lastDroppedAt?: string, lastWrittenAt?: string } | null | undefined} stats
 */
export function fireLog(logTable, entry, stats) {
  if (!logTable) return
  const swallow = (/** @type {any} */ err) => {
    if (stats) { stats.dropped++; stats.lastError = String(err?.message ?? err); stats.lastDroppedAt = new Date().toISOString() }
    const key = entry?.model ?? 'log'
    if (_loggedLogFailure.has(key)) return
    _loggedLogFailure.add(key)
    console.warn(
      `[litestone] audit write for '${key}' failed and was dropped: ${err?.message ?? err}\n` +
      `            The trail is incomplete from here. Further losses for this model are not reported.`
    )
  }
  const write = () => {
    try {
      Promise.resolve(logTable.create({ data: entry }))
        .then(() => { if (stats) { stats.written++; stats.lastWrittenAt = new Date().toISOString() } })
        .catch(swallow)
    }
    catch (err) { swallow(err) }   // a driver that throws before its first await
  }
  // Registered until it runs, so a process that ends before the next tick can
  // still append it: a seed script ending in `process.exit`, or a crash right
  // after a committed write, left the row in main and no line in the trail.
  const run = () => { if (_pendingLog.delete(run)) write() }
  _pendingLog.add(run)
  if (_pendingLog.size === 1) armExitFlush()
  if (typeof setImmediate === 'function') setImmediate(run)
  else setTimeout(run, 0)
}

const _pendingLog = new Set()
let _exitFlushArmed = false

// The drivers' `create` does its file I/O before its first await, so running a
// queued write here appends synchronously and the process can end on it.
export function flushPendingLogs() {
  for (const run of [..._pendingLog]) run()
}

function armExitFlush() {
  if (_exitFlushArmed || typeof process?.on !== 'function') return
  _exitFlushArmed = true
  process.on('exit', flushPendingLogs)
}
