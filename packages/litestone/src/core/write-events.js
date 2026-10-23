// write-events.js — the write announcement: one funnel every write event
// in the package goes through, so the audience guard, the COMMIT hold, the
// cross-process record and the tenant routing are stated once. A write
// announces a row or a collection, never nothing (`FJS-307`).
//
// Built once per table by `makeTable`, which hands it the emitter, the
// transaction manager and the row reader, and takes back the announcers.

import { checkAnnounce, defer } from './hooks.js'
import { ident, keyIn, tuplesOf } from './query.js'

export function makeWriteEvents(shape, ctx, deps) {
  const { tableName, modelName } = shape
  const { emitter, tx, readDb, idField, _modelToTable, read } = deps

  // ── Write event emitter ───────────────────────────────────────────────────
  // Two audiences for one event: the config-time `onEvent` listeners, fixed at
  // createClient, and any runtime `$tapEvents` taps. Zero-cost when neither
  // exists — the guard runs before the payload is built, which is what keeps
  // the fast paths below reachable for an app that subscribes to nothing.
  //
  // A tap gets `event` folded INTO the payload rather than as a second
  // argument: a subscriber that must handle every kind (Junction announcing a
  // write it did not make) would otherwise re-derive the name from `operation`,
  // which a transition event does not carry.
  function fireEvent(event, eventCtx) {
    // Recorded BEFORE the local-audience guard, and that is the whole of what
    // makes it cross-process: the subscriber this row is for is in another
    // process, so whether anything here is listening says nothing about whether
    // the announcement is wanted (`FJS-642`).
    recordCrossProcess(event, eventCtx)
    if (!emitter && !ctx._eventListeners.size) return
    // An announcement is a claim that a row is there. Inside this context's own
    // transaction it is not there yet and may never be, so it is held and
    // flushed on COMMIT — one funnel, so every announcement in the package gets
    // this and no call site is asked to remember (`FJS-D170`).
    if (tx.owns()) { tx.queueEvent(() => dispatchEvent(event, eventCtx)); return }
    dispatchEvent(event, eventCtx)
  }

  // The id and never the row (`cross-process.js` says why): writing the row
  // would put the plaintext of every @encrypted and @guarded column into a
  // table beside the ciphertext. A collection-scoped write has no row to name
  // and travels as its count, which is the shape `changed` already has
  // (`FJS-D34`).
  function recordCrossProcess(event, eventCtx) {
    const record = ctx._crossProcess?.recorders?.[shape.db]
    if (!record) return
    const row = eventCtx.result ?? eventCtx.record ?? null
    record({
      event,
      model:    modelName,
      scope:    eventCtx.scope ?? 'row',
      count:    eventCtx.count ?? 1,
      recordId: eventCtx.scope === 'collection' ? null : row?.[idField] ?? null,
      detail:   event === 'transition'
        ? { transition: eventCtx.transition, field: eventCtx.field, from: eventCtx.from, to: eventCtx.to }
        : null,
    })
  }

  function dispatchEvent(event, eventCtx) {
    if (emitter) emitter.emit(event, eventCtx, ctx)
    if (!ctx._eventListeners.size) return
    const e = { event, ...eventCtx }
    // Deferred and swallowed, exactly like the emitter's own dispatch: a
    // subscriber is an Observer (FJS-D06) and may not fail the write that
    // announced it.
    defer(() => {
      for (const fn of ctx._eventListeners) {
        try { const r = fn(e, ctx); if (r?.catch) r.catch(() => {}) }
        catch (err) { console.warn(`litestone event tap error (${event}):`, err) }
      }
    })
  }

  // `hasAudience` and not `!emitter && !listeners`: a recorded announcement is
  // for a subscriber in ANOTHER process, so the guards that decide whether to
  // build a payload cannot ask only about this one (`FJS-642`). Still zero-cost
  // for an app that declares nothing and subscribes to nothing, which is what
  // these guards are for.
  const hasAudience = () => !!(emitter || ctx._eventListeners.size || ctx._crossProcess)
  // The subset that can use a `before` image: a cross-process announcement
  // stores ids and nothing else, so it is no reason to read the row first.
  const hasLocalAudience = () => !!(emitter || ctx._eventListeners.size)

  function emitTransitionEvent(transitionResult, record) {
    if (!transitionResult || !hasAudience()) return
    fireEvent('transition', {
      // `modelName`, like every other event this client fires. It used to be
      // `tableName`, so a subscriber handling both kinds got `Order` from an
      // update and `order` from the transition that caused it, and any lookup
      // keyed by the model name silently missed one of the two.
      model:      modelName,
      transition: transitionResult.transitionName,
      field:      transitionResult.field,
      from:       transitionResult.from,
      to:         transitionResult.to,
      record,
      // `scope` is on every event or a consumer has to treat its absence as a
      // third case. A transition is always one row's.
      scope:      'row',
      count:      1,
    })
  }

  // ── The two shapes a write announcement can take ──────────────────────────
  // A write that read its row back says WHICH row changed. A bulk statement
  // answers `{count}` and never builds the rows, so it says how many and under
  // what filter, and a consumer holding no row re-asks rather than guesses.
  // `scope` is stated rather than inferred: `result: null` is not the same fact
  // on both, since a `select: false` write is a ROW write with no row to hand
  // over. The audience check leads in both, so an app that subscribes to
  // nothing does not build the payload.
  //
  // `transition` is set only when THIS write is a named move AND the transition
  // event is going to fire. A consumer announcing one thing per write has no
  // other way to know a second event is coming for the same row: it would
  // either announce twice, or skip an update whose transition event was
  // suppressed (a SYSTEM write) and announce nothing at all.
  //
  // `before` is the row as it stood ahead of an update, shaped like `result`,
  // for a subscriber that must tell who could read it then from who can now. It
  // is absent where no image was read (a bulk write, a restore, a write that
  // began before anything listened), and absent means unknown, never public.
  function fireRowEvent(event, operation, result, transition = null, before = null) {
    if (!hasAudience()) return
    const tenants = result ? tenantsOf([result]) : null
    fireEvent(event, {
      model: modelName, operation, result, scope: 'row', count: 1,
      ...(transition ? { transition } : {}),
      ...(before ? { before } : {}),
      ...(tenants ? { tenants } : {}),
      schema: shape.model,
    })
  }

  function fireCollectionEvent(event, operation, where, count, tenants) {
    // Nothing matched, so nothing changed. A filter that hit no rows must not
    // send every open tab back to the server.
    if (!count) return
    if (!hasAudience()) return
    fireEvent(event, {
      model: modelName, operation, result: null, scope: 'collection', count, where, schema: shape.model,
      ...(tenants ? { tenants } : {}),
    })
  }

  // ── The tenants a write touched ─────────────────────────────────────────
  //
  // Under row tenancy every event says which tenants its rows belong to. A
  // count names no row, so a subscriber routing per tenant -- Junction's
  // function channel on `agency:<id>` -- had nowhere to send it and sent
  // nothing; and a row of a model scoped through its parent (`@@tenant(via:)`,
  // a Share under a Page) carries no column to route by (`FJS-1741`).
  //
  // A model that carries the column reads it off its rows. One scoped through
  // a parent follows the relation its generated tenancy deny follows, one
  // `SELECT DISTINCT` per hop, from the foreign keys on the rows -- which a
  // delete still has, since the parent outlives the child. Resolved on first
  // use: the schema's tenancy is not settled when the table is built. The
  // commitment sweep reads the same path to fire a row in its own tenant.
  let _tenantPath
  function tenantPath() {
    if (_tenantPath !== undefined) return _tenantPath
    const t = ctx.schema?.tenancy
    if (t?.strategy !== 'row') return _tenantPath = null
    const carries = (m) => !!ctx.shapes[m]?.model.fields.some(f => f.name === t.column)
    const walk = (m, seen) => {
      if (carries(m)) return []
      for (const a of ctx.shapes[m]?.model.attributes ?? []) {
        const ref = a.generated === 'tenancy' && a.expr?.type === 'not' && a.expr.expr?.type === 'check' ? a.expr.expr : null
        const rel = ref && ctx.shapes[m].relations?.[ref.field]
        if (rel?.kind !== 'belongsTo' || seen.has(rel.targetModel)) continue
        const rest = walk(rel.targetModel, new Set([...seen, rel.targetModel]))
        if (rest) return [{ field: ref.field, fks: rel.foreignKeys, target: rel.targetModel, refs: rel.referencedKeys }, ...rest]
      }
      return null
    }
    return _tenantPath = walk(modelName, new Set([modelName]))
  }

  function tenantsOf(rows) {
    const path = tenantPath()
    if (!path || !rows?.length) return null
    const distinct = (vs) => [...new Set(vs.filter(v => v != null))]
    const column = ctx.schema.tenancy.column
    if (!path.length) return distinct(rows.map(r => r?.[column]))
    // Each hop carries a key of one or more columns, as tuples (`FJS-2790`).
    let keys = tuplesOf(rows, path[0].fks)
    try {
      for (let i = 0; i < path.length && keys.length; i++) {
        const hop  = path[i]
        const tmap = ctx.shapes[hop.target]?.columnMap ?? {}
        const out  = i + 1 < path.length ? path[i + 1].fks : [column]
        const as   = out.map((_, k) => `v${k}`)
        const sel  = out.map((c, k) => `${ident(tmap[c] ?? c).sql} AS v${k}`).join(', ')
        const refs = hop.refs.map(c => ident(tmap[c] ?? c).sql)
        const next = []
        for (let j = 0; j < keys.length; j += 500) {
          const binds = []
          const sql = `SELECT DISTINCT ${sel} FROM ${ident(_modelToTable(hop.target)).sql} WHERE ${keyIn(refs, keys.slice(j, j + 500), binds)}`
          next.push(...readDb.query(sql).all(...binds))
        }
        keys = tuplesOf(next, as)
      }
    } catch { return null }   // a parent in another database: the tenant stays unnamed
    return distinct(keys.map(k => k[0]))
  }

  /**
   * What this bulk call should announce, and whether it has to fetch rows to do
   * it: `{ mode, wantRows }`. Precedence is **option → client → 'collection'**,
   * the same shape `resolveTenancy` uses one realm over.
   *
   * `wantRows` is ANDed with the audience, so an app that opted in and has no
   * subscriber does not pay for the RETURNING it would throw away.
   */
  function announceFor(option) {
    const mode = checkAnnounce(option, `${modelName}`) ?? ctx.announce ?? 'collection'
    const rowsFor = mode === 'rows' || (mode === 'collection' && !!tenantPath())
    return { mode, wantRows: rowsFor && hasAudience() }
  }

  /**
   * Announce a bulk write, given whatever rows the statement returned.
   *
   * One place, because the alternative is the same three-way branch written out
   * at five call sites — which is how one of them ends up announcing a raw row.
   * Rows go through `read()` first: a subscriber must not receive a `@guarded`
   * or `@encrypted` column that every other event path strips.
   */
  function announceBulk({ mode, event, operation, where, count, rows }) {
    if (mode === 'none') return
    if (mode === 'rows' && rows) {
      for (const r of rows) fireRowEvent(event, operation, read(r, { mode: 'single', hydrateFrom: true }))
      return
    }
    fireCollectionEvent(event, operation, where, count, tenantsOf(rows))
  }
  return {
    fireEvent, hasAudience, hasLocalAudience, emitTransitionEvent,
    fireRowEvent, fireCollectionEvent, tenantPath, tenantsOf, announceFor, announceBulk,
  }
}
