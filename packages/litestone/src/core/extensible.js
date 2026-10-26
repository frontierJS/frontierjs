// extensible.js — the @@extensible pool for one table: which key of the blob
// holds which indexed slot. The pool's shape is a fact about the SCHEMA and is
// read once; which key holds which slot is a fact about the DATA, read per
// write from the declaring table — raw, because this runs inside a write of a
// different model and the declaring table's own gate must not stand in front
// of it. The mirror is derived, so every rebuild here is raw and announces
// nothing.
//
// Built once per table by `makeTable`, which hands it the two connections,
// the column map and the where compiler, and takes back what writeData and
// the where rewrite call. These are the cold halves of writeData (`FJS-1108`):
// inline they doubled its bytecode past what JSC optimizes.

import { modelToTableName } from './ddl.js'
import { quoteIdent, blobKeyPath } from './query.js'
import { ValidationError } from './validate.js'

// Every `@@extensible` slot a pool has handed out, per (model, tenant, scope),
// on the declaring table's database. Not on the declaring model, which would
// gain rows the app never wrote (`FJS-D1145`).
export const EXT_SLOTS = quoteIdent('_litestone_ext_slots')

export function makeExtensible(shape, ctx, deps) {
  const { tableName, modelName } = shape
  const { readDb, writeDb, col, buildWhereWithEncryption } = deps
  // ── @@extensible, resolved once per table ───────────────────────────────────
  //
  // The pool's shape is a fact about the SCHEMA, so it is read here; which key
  // holds which slot is a fact about the DATA, so that is read below.
  const _extensible = (() => {
    const ext = shape.model.attributes?.find(a => a.kind === 'extensible')
    if (!ext?.max) return null   // no pool means no mirror to keep
    const decl = ctx.models[ext.declaredBy]
    // Which enum member means a numeric slot is decided by the SEED's own
    // `max:` keys and the affinity the expansion gave them, so this asks the
    // expanded columns rather than matching on the word 'number'. It reads the
    // stamped kind and not the column's first letter: the letter is an artefact
    // of how the pool was named, and a member renamed from `number` to
    // `numeric` would have moved every value into a text slot with nothing
    // failing.
    const numeric = new Set(shape.model.fields
      .filter(f => f.extKind && f.type.name === 'Float').map(f => f.extKind))
    return {
      column:      ext.column,
      mirror:      `${ext.column}Slots`,
      declaredBy:  ext.declaredBy,
      scope:       ext.scope ?? null,
      declTable:   decl ? modelToTableName(decl, ctx.pluralize ?? false) : null,
      kindOf:      (k) => (numeric.has(k) ? 'number' : 'text'),
    }
  })()

  /**
   * This model's declarations, read straight off the declaring table.
   *
   * A raw read rather than the declaring table's own verbs, because this runs
   * INSIDE a write of a different model: going back through the API would apply
   * that model's gate to a caller who is writing a customer, and refuse a write
   * for want of a permission on a table they never named. What the mirror is
   * built from is not a thing the caller is reading.
   *
   * Cached per client and dropped whenever the declaring table is written, so a
   * key declared at three o'clock is projected by the next write rather than by
   * the next process.
   */
  /**
   * The pool `target` declares — its slots in INDEX order and the kind each one
   * holds — or null where that model has no pool.
   *
   * Takes a model NAME rather than reading this table's own, because its caller
   * is the DECLARING table: one declaring table serves every extensible model,
   * so the pool a row is allocated out of is chosen per row and never per
   * client. `Customer` may have a pool while `Product` has none, and both are
   * declared through the same table on the same day.
   */
  function extPoolFor(target) {
    const model = ctx.models?.[target]
    if (!model?.attributes?.some(a => a.kind === 'extensible' && a.max)) return null
    const index = model.attributes.find(a => a.kind === 'index' && a.generated === 'extensible')
    if (!index) return null
    // Slots only: row tenancy leads the index with its tenant column, which is
    // an index prefix and not a slot anything can be allocated into.
    const kinds = new Map(model.fields.filter(f => f.extKind).map(f => [f.name, f.extKind]))
    const ext   = model.attributes.find(a => a.kind === 'extensible')
    return {
      order:  index.fields.filter(s => kinds.has(s)),
      kind:   Object.fromEntries(kinds),
      numeric: new Set(model.fields.filter(f => f.extKind && f.type.name === 'Float').map(f => f.extKind)),
      table:  modelToTableName(model, ctx.pluralize ?? false),
      column: ext.column,
      mirror: `${ext.column}Slots`,
      scope:  ext.scope ?? null,
    }
  }

  // What a blob value becomes in a slot of `kind`, or undefined where it holds
  // none. The one rule for a write's mirror and for the backfill of a promoted
  // key, so a row written before the declaration and one written after cannot
  // disagree.
  function slotValue(kind, v) {
    // An unpromoted or absent key is omitted rather than written null: a
    // missing JSON path and a null one both read NULL through json_extract,
    // so writing it costs bytes on every row and buys nothing.
    if (v === undefined || v === null || v === '') return undefined
    if (kind === 'number') {
      // The column's affinity is REAL or TEXT and nothing coerces on the
      // way in, so a number arriving as a string would sort as text and
      // compare wrong.
      const n = Number(v)
      return Number.isFinite(n) ? n : undefined
    }
    return String(v)
  }

  function _extDeclarations(tenant, scope) {
    if (!_extensible?.declTable) return []
    const cache = (ctx.extDecl ??= new Map())
    const at    = `${modelName}\0${_extTenantCol ? tenant : ''}\0${_extensible.scope ? scope : ''}`
    const hit   = cache.get(at)
    if (hit) return hit
    // A scoped declaration is the parent row's, so the read is narrowed by it
    // the way the tenant column narrows it under row tenancy.
    const narrow = [['model', modelName]]
    if (_extTenantCol)     narrow.push([_extTenantCol, tenant])
    if (_extensible.scope) narrow.push([_extensible.scope, scope])
    const rows = readDb.query(
      `SELECT "key", "type", "slot" FROM "${_extensible.declTable}" WHERE ${narrow.map(([c]) => `${quoteIdent(c)} = ?`).join(' AND ')}`
    ).all(...narrow.map(([, v]) => v)) ?? []
    cache.set(at, rows)
    return rows
  }

  // Under row tenancy every tenant shares the declaring TABLE, so each raw read
  // of it is narrowed to one tenant — unnarrowed, one tenant's declaration took
  // another's slot and promoted its values into an indexed column (`FJS-1290`).
  // Null where there is nothing to narrow: no row tenancy, or a declaring model
  // with no tenant column, whose declarations are the installation's on purpose.
  const _extTenantCol = (() => {
    const t = ctx.schema?.tenancy
    if (t?.strategy !== 'row') return null
    const decl = ctx.models?.[_extensible ? _extensible.declaredBy : modelName]
    return decl?.fields?.some(f => f.name === t.column) ? t.column : null
  })()

  // The value a where pins `col` to, looking through AND only: the read rules
  // fold the caller's where under an AND with the filter, soft-delete and
  // policy clauses, so the pin is rarely at the top. An OR or NOT pins nothing.
  function pinnedIn(where, col) {
    if (!where || typeof where !== 'object') return null
    if (Array.isArray(where)) {
      for (const w of where) { const p = pinnedIn(w, col); if (p != null) return p }
      return null
    }
    const own = where[col]
    if (own != null && typeof own !== 'object') return own
    return where.AND ? pinnedIn(where.AND, col) : null
  }

  // Which tenant a pool read is for: the one the payload states, else the
  // caller's claim, else the one a filter pins, else the one tenant the rows
  // of a write's where belong to (a tenant column is @immutable, so an update
  // cannot state it). A system call naming none is refused rather than read
  // across every tenant, because the wrong tenant's declarations map a value
  // into a slot with nothing failing.
  function extTenant(data, where) {
    const col = _extTenantCol
    if (data && data[col] != null) return data[col]
    const claim = ctx.auth?.[ctx.schema.tenancy.claim]
    if (claim != null) return claim
    const pinned = pinnedIn(where, col)
    if (pinned != null) return pinned
    if (where && data && ctx.models?.[modelName]?.fields?.some(f => f.name === col)) {
      const params = []
      const sql = buildWhereWithEncryption(where, params)
      const seen = readDb.query(`SELECT DISTINCT ${quoteIdent(col)} AS t FROM ${quoteIdent(tableName)}${sql ? ` WHERE ${sql}` : ''} LIMIT 2`).all(...params)
      if (seen.length === 1 && seen[0].t != null) return seen[0].t
    }
    throw new ValidationError([{ path: [col], message:
      `${modelName}: @@extensible under row tenancy reads declarations per tenant, and this call names none — ` +
      `state '${col}' on it, or make it as the tenant` }])
  }

  // Which parent row a pool read is for: the one the payload states, else the
  // one a filter pins, else the one row the where reaches. Declarations are a
  // parent row's, so a read naming none would project one scope's keys onto
  // another's values with nothing failing. Rows spread over several parents
  // are refused for the same reason: one SET cannot carry a mirror per row.
  function extScope(data, where) {
    const col = _extensible.scope
    if (data && data[col] != null) return data[col]
    const pinned = pinnedIn(where, col)
    if (pinned != null) return pinned
    if (where && data) {
      const params = []
      const sql = buildWhereWithEncryption(where, params)
      const seen = readDb.query(`SELECT DISTINCT ${quoteIdent(col)} AS s FROM ${quoteIdent(tableName)}${sql ? ` WHERE ${sql}` : ''} LIMIT 2`).all(...params)
      if (seen.length === 1) return seen[0].s
      if (seen.length > 1) throw new ValidationError([{ path: [col], message:
        `${modelName}: this write reaches rows of more than one '${col}', and each has its own declarations — narrow it to one '${col}'` }])
    }
    throw new ValidationError([{ path: [col], message:
      `${modelName}: @@extensible(scope: ${col}) reads declarations per '${col}', and this call names none — state '${col}' on it` }])
  }

  function allocateExtSlot(data, stamped) {
    // Allocation runs before the INSERT, where a literal @default is still the
    // DDL's to fill. A model or type left to it is read from the default here,
    // or the row lands with a model and no slot and reads as a full pool.
    const stated = f => data[f] ?? shape.literalDefaults.find(d => d.field === f)?.value
    const model  = String(stated('model') ?? '')
    const type   = String(stated('type'))
    const pool   = extPoolFor(model)
    let slot = null
    if (pool) {
      // Raw, and narrowed by model, for the reason `_extDeclarations` is:
      // this runs inside somebody's write and must not put the declaring
      // table's own gate in front of it. Narrowed because one declaring table
      // serves every extensible model and `t1` on a customer is not `t1` on a
      // product.
      // Under a scope the pool is the parent row's: database 2's first text
      // field is `t1` whatever database 1 holds.
      const narrow = [['model', model]]
      if (_extTenantCol) narrow.push([_extTenantCol, extTenant(data)])
      if (pool.scope)    narrow.push([pool.scope, data[pool.scope]])
      const at = narrow.map(([c]) => ` AND ${quoteIdent(c)} = ?`).join('').slice(5)
      const taken = new Set(readDb.query(`SELECT "slot" FROM "${tableName}" WHERE ${at} AND "slot" IS NOT NULL`)
        .all(...narrow.map(([, v]) => v)).map(r => r.slot))
      // First free of the matching kind, in INDEX order — so the field a
      // tenant declares first lands leftmost, where a one-term query reaches
      // it. A full pool answers null, which is the ordinary end of a pool and
      // not a failure: the field still stores and still renders.
      slot = pool.order.find(s => pool.kind[s] === type && !taken.has(s)) ?? null
      // A free slot can still hold the values of the declaration that freed
      // it: a delete leaves every row's mirror as it was, and only that row's
      // next write rewrites it. Handed on as it stands, the new key filters
      // on the old key's values (`FJS-1752`). The mirror is derived, so the
      // rebuild is raw and announces nothing — the same footing as the read
      // above.
      // The clear reads every row the tenant holds, inside the one writer,
      // wherever the slot is not the index's leading column: SQLite recomputes
      // the generated column from the row rather than reading it off the index
      // (`FJS-3134`, `FJS-3141`). A slot this pool has never handed out never
      // held a value, so the clear runs only for one in the record. Taken
      // slots are recorded too, so a slot a raw insert stated is cleared when
      // it is reused (`FJS-D1145`).
      const owner = [model, _extTenantCol ? String(extTenant(data)) : '', pool.scope ? String(data[pool.scope] ?? '') : '']
      const held  = slot && writeDb.query(`SELECT 1 FROM ${EXT_SLOTS} WHERE model = ? AND tenant = ? AND scope = ? AND slot = ?`)
        .get(...owner, slot)
      if (slot) {
        const record = writeDb.query(`INSERT OR IGNORE INTO ${EXT_SLOTS} (model, tenant, scope, slot) VALUES (?, ?, ?, ?)`)
        for (const s of [...taken, slot]) record.run(...owner, s)
      }
      const only = [], vals = []
      if (_extTenantCol) { only.push(` AND ${quoteIdent(_extTenantCol)} = ?`); vals.push(extTenant(data)) }
      if (pool.scope)    { only.push(` AND ${quoteIdent(pool.scope)} = ?`);    vals.push(data[pool.scope]) }
      if (held) {
        const sql  = `UPDATE "${pool.table}" SET "${pool.mirror}" = json_remove("${pool.mirror}", ?) ` +
          `WHERE ${quoteIdent(slot)} IS NOT NULL`
        writeDb.run(sql + only.join(''), `$.${slot}`, ...vals)
      }
      if (slot) backfillExtSlot(pool, slot, String(data.key), only.join(''), vals)
    }
    data    = { ...data, slot }
    stamped = stamped ? new Set([...stamped, 'slot']) : new Set(['slot'])
    return [data, stamped]
  }

  // A key promoted into `slot` holds no value in the mirror of any row that
  // existed before the declaration, because a mirror is filled by the write
  // that carries the blob: the indexed filter answered 0 where the scan answered
  // every match (`FJS-3028`). Filled here, by the one path that hands a slot
  // out, for the rows of the tenant and scope it was handed in.
  //
  // One UPDATE takes the values whose JSON type already is the slot's kind;
  // the rest are coerced by `slotValue`, the rule a write's mirror uses, so a
  // row backfilled and a row written after the declaration cannot disagree. It
  // is raw and announces nothing, on the footing of the clear above, and it
  // holds the writer for the table's rows (20k rows/s measured at 10M).
  function backfillExtSlot(pool, slot, key, only, vals) {
    const col    = quoteIdent(pool.column)
    const mirror = quoteIdent(pool.mirror)
    const path   = blobKeyPath(key)
    const number = pool.numeric.has(pool.kind[slot])
    // json_type is NULL for a missing key, and for a blob that does not parse,
    // which json_type would otherwise throw on.
    const type   = `CASE WHEN json_valid(${col}) THEN json_type(${col}, ?) END`
    const fast   = number ? `${type} IN ('integer', 'real')` : `${type} = 'text' AND json_extract(${col}, ?) <> ''`
    const fastBinds = number ? [path] : [path, path]
    writeDb.run(
      `UPDATE ${quoteIdent(pool.table)} SET ${mirror} = json_set(COALESCE(${mirror}, '{}'), ?, json_extract(${col}, ?)) ` +
      `WHERE ${fast}${only}`, `$.${slot}`, path, ...fastBinds, ...vals)
    const rest = writeDb.query(
      `SELECT rowid AS r, ${col} AS b FROM ${quoteIdent(pool.table)} ` +
      `WHERE ${type} NOT IN ('null') AND NOT (${fast})${only}`).all(path, ...fastBinds, ...vals)
    const set = writeDb.query(`UPDATE ${quoteIdent(pool.table)} SET ${mirror} = json_set(COALESCE(${mirror}, '{}'), ?, ?) WHERE rowid = ?`)
    for (const { r, b } of rest) {
      let blob
      try { blob = JSON.parse(b) } catch { continue }
      const v = slotValue(number ? 'number' : 'text', blob?.[key])
      if (v !== undefined) set.run(`$.${slot}`, v, r)
    }
  }

  function mirrorExtSlots(data, stamped, where, blob = data[_extensible.column]) {
    const declared = _extDeclarations(_extTenantCol ? extTenant(data, where) : undefined,
                                      _extensible.scope ? extScope(data, where) : undefined)
    const slots    = {}
    if (blob && typeof blob === 'object') {
      for (const d of declared) {
        if (!d.slot) continue
        const v = slotValue(_extensible.kindOf(d.type), blob[d.key])
        if (v !== undefined) slots[d.slot] = v
      }
    }
    data = { ...data, [_extensible.mirror]: slots }
    // The framework filled it, so the @system refusal below has to let it
    // past — the same hatch `@updatedBy` and the tenancy stamp ride on.
    stamped = stamped ? new Set([...stamped, _extensible.mirror]) : new Set([_extensible.mirror])
    return [data, stamped]
  }

  // A move without the blob re-mirrors the STORED blob against the new
  // scope's declarations; left alone, the old scope's slots stay in a mirror
  // the new scope reads, and its filters match values the row never had
  // there. The blob itself is not written, so the audit trail does not record
  // a change to it. One row only: rows reached together hold different blobs,
  // and one SET carries one mirror.
  function remirrorMovedRow(data, stamped, where) {
    const scope  = _extensible.scope
    const refuse = (why) => { throw new ValidationError([{ path: [scope], message:
      `${modelName}: moving ${why} to another '${scope}' re-projects '${_extensible.column}' against the new one's declarations — send '${_extensible.column}' in the same write` }]) }
    if (!where) refuse('a row with no where')
    const params = []
    const sql    = buildWhereWithEncryption(where, params)
    const rows   = readDb.query(`SELECT ${quoteIdent(col(_extensible.column))} AS b FROM ${quoteIdent(tableName)}${sql ? ` WHERE ${sql}` : ''} LIMIT 2`).all(...params)
    if (rows.length > 1) refuse('several rows')
    // Nothing reached means nothing to mirror, and the UPDATE matches nothing.
    if (!rows.length) return [data, stamped]
    let blob = rows[0].b
    if (typeof blob === 'string') {
      try { blob = JSON.parse(blob) } catch { refuse('a row whose stored blob does not parse') }
    }
    return mirrorExtSlots(data, stamped, where, blob)
  }

  return {
    _extensible, _extDeclarations, _extTenantCol, extTenant, extScope,
    allocateExtSlot, mirrorExtSlots, remirrorMovedRow,
  }
}
