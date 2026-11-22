// @ts-check
// zoned.js — the instant a wall clock and its zone resolve to
//
// `startsAt DateTime @zoned(onDate, startLocal, site.timeZone)` is a stored
// column litestone derives (`FJS-D963`, spelt by `FJS-D1434`). It is stored
// rather than read at read time because `@@exclude`, an index and a `where`
// all need it as a column. Stored, it goes stale the moment any source moves
// without it, so nobody but this module writes it:
//
//   - a create derives it from the payload, reading the zone off the parent;
//   - an update naming a source re-derives it from the payload laid over the
//     stored row;
//   - a write to the ZONE recomputes every child through the relation, inside
//     the parent's write unit, and notes each child's exclusion key so
//     `@@exclude` grades the new instants at commit.
//
// A wall clock in a spring-forward gap takes the later side and a repeated
// hour its earlier instant (`fromWall`'s `compatible`, fixed by `FJS-D1434`):
// a zone correction must never be refused because some child's stored clock
// does not exist under the new zone.

import { fromWall, plainDateIn }                     from '@frontierjs/toolbelt/datetime'
import { columnMapFor, modelToTableName }            from './ddl.js'
import { quoteIdent }                                from './query.js'
import { inferToOneFrom }                            from './schema-maps.js'
import { ValidationError }                           from './validate.js'

// ─── The map ────────────────────────────────────────────────────────────────

/**
 * `byModel[child]` lists each derived field and its sources; `byParent[parent]`
 * lists the children whose zone is a column of that parent, one edge per
 * (child, relation).
 */
export function buildZonedMap(/** @type {any} */ schema, pluralize = false) {
  /** @type {Record<string, any[]>} */ const byModel  = {}
  /** @type {Record<string, any[]>} */ const byParent = {}
  /** @type {Record<string, Record<string, any>>} */ const windows = {}
  for (const model of schema.models) {
    const cols = columnMapFor(model)
    const col  = (/** @type {string} */ f) => cols[f] ?? f
    const win  = windowDays(model, schema, pluralize, col)
    if (win) windows[model.name] = win
    for (const field of model.fields) {
      const zoned = field.attributes.find((/** @type {any} */ a) => a.kind === 'zoned')
      if (!zoned || field.type.name !== 'DateTime' || zoned.sources?.length !== 2) continue
      const [date, time] = zoned.sources
      // `after:` is validated to name a sibling on the same day and zone, so the
      // end needs only the anchor's clock (`FJS-D2294`).
      const anchorTime = zoned.after
        ? model.fields.find((/** @type {any} */ f) => f.name === zoned.after)?.attributes.find((/** @type {any} */ a) => a.kind === 'zoned')?.sources?.[1] ?? null
        : null
      const entry = { field: field.name, column: col(field.name), date, time, dateColumn: col(date), timeColumn: col(time),
        anchorTime, anchorTimeColumn: anchorTime && col(anchorTime),
        zone: /** @type {string|null} */ (null), zoneDefault: /** @type {string|null} */ (null), via: /** @type {any} */ (null), label: '' }
      entry.label = `@zoned(${date}, ${time}, ${zoned.path.join('.')}${zoned.after ? `, after: ${zoned.after}` : ''})`
      if (zoned.path.length === 1) {
        entry.zone = zoned.path[0]
        const def = model.fields.find((/** @type {any} */ f) => f.name === entry.zone)
          ?.attributes.find((/** @type {any} */ a) => a.kind === 'default')?.value
        entry.zoneDefault = def?.kind === 'string' ? def.value : null
      } else {
        const hop = inferToOneFrom(model, schema, { rel: zoned.path[0] })
        if (hop.error) continue                                   // validate() already named it
        const pcols = columnMapFor(hop.targetModel)
        const pcol  = (/** @type {string} */ f) => pcols[f] ?? f
        entry.via = {
          rel:        zoned.path[0],
          parent:     hop.targetModel.name,
          table:      modelToTableName(hop.targetModel, pluralize),
          fkFields:   hop.fkFields,
          refColumns: hop.refFields.map(pcol),
          zoneField:  zoned.path[1],
          zoneColumn: pcol(zoned.path[1]),
        }
        const edges = (byParent[hop.targetModel.name] ??= [])
        let edge = edges.find(e => e.child === model.name && e.rel === zoned.path[0])
        if (!edge) edges.push(edge = {
          child:      model.name,
          rel:        zoned.path[0],
          table:      modelToTableName(model, pluralize),
          zoneField:  zoned.path[1],
          zoneColumn: pcol(zoned.path[1]),
          // [child FK column, parent column], index-aligned.
          pairs:      hop.fkFields.map((/** @type {string} */ f, /** @type {number} */ i) => [col(f), pcol(hop.refFields[i])]),
          fields:     [],
        })
        edge.fields.push({ column: entry.column, dateColumn: entry.dateColumn, timeColumn: entry.timeColumn, anchorTimeColumn: entry.anchorTimeColumn })
      }
      ;(byModel[model.name] ??= []).push(entry)
    }
  }
  return { byModel, byParent, windows }
}

// ─── A window over a zoned day ──────────────────────────────────────────────
//
// `expiresOn String @date @zoned(account.timeZone)` under `@@expires` ends at
// midnight in each row's own zone (`FJS-D1053`). SQLite has no zone table, so
// the zones present are read first and each is put on the day it is on now;
// every zone sits within a day of UTC, so the row's today is one CASE over two
// bound lists, with UTC the ELSE that also takes a null zone. An `Int @unit(min)`
// offset needs no list: SQLite adds the minutes itself. It is a predicate, not a
// post-filter, so `count`, `take` and an include agree with the rows.

/** The `@zoned` source of each window column of `model`, by field; null when none is zoned. */
function windowDays(/** @type {any} */ model, /** @type {any} */ schema, /** @type {boolean} */ pluralize, /** @type {(f: string) => string} */ col) {
  const exp = model.attributes.find((/** @type {any} */ a) => a.kind === 'expires')
  const eff = model.attributes.find((/** @type {any} */ a) => a.kind === 'effective')
  const names = [exp?.column, eff?.from, eff?.to].filter(Boolean)
  const table = modelToTableName(model, pluralize)
  /** @type {Record<string, any>} */ const out = {}
  for (const name of names) {
    const field = model.fields.find((/** @type {any} */ f) => f.name === name)
    if (!field?.attributes.some((/** @type {any} */ a) => a.kind === 'date')) continue
    const path = field.attributes.find((/** @type {any} */ a) => a.kind === 'zoned')?.path
    if (!path?.length) continue
    const self = `${quoteIdent(table)}.`
    if (path.length === 1) {
      const zf = model.fields.find((/** @type {any} */ f) => f.name === path[0])
      const zc = quoteIdent(col(path[0]))
      out[name] = { column: col(name), offset: zf?.type.name === 'Int', zone: `${self}${zc}`, zoneField: path[0],
        distinct: `SELECT DISTINCT ${zc} FROM ${quoteIdent(table)} WHERE ${zc} IS NOT NULL` }
      continue
    }
    const hop = inferToOneFrom(model, schema, { rel: path[0] })
    if (hop.error) continue                                       // validate() already named it
    const pcols = /** @type {Record<string, string>} */ (columnMapFor(hop.targetModel))
    const pcol  = (/** @type {string} */ f) => pcols[f] ?? f
    const ptab  = quoteIdent(modelToTableName(hop.targetModel, pluralize))
    const zc    = quoteIdent(pcol(path[1]))
    const on    = hop.fkFields.map((/** @type {string} */ f, /** @type {number} */ i) =>
      `"zone_parent".${quoteIdent(pcol(hop.refFields[i]))} = ${self}${quoteIdent(col(f))}`).join(' AND ')
    out[name] = { column: col(name), offset: hop.targetModel.fields.find((/** @type {any} */ f) => f.name === path[1])?.type.name === 'Int',
      zone:     `(SELECT "zone_parent".${zc} FROM ${ptab} AS "zone_parent" WHERE ${on})`,
      distinct: `SELECT DISTINCT ${zc} FROM ${ptab} WHERE ${zc} IS NOT NULL`,
      parent:   { fkFields: hop.fkFields,
        sql: `SELECT ${zc} AS "zone" FROM ${ptab} WHERE ${hop.refFields.map((/** @type {string} */ f) => `${quoteIdent(pcol(f))} = ?`).join(' AND ')}` } }
  }
  return Object.keys(out).length ? out : null
}

const DAY_MS = 86_400_000

/**
 * `"<column>" <op> <the row's today>` at the instant `at`, as SQL and its binds.
 * `all(sql)` runs `src.distinct` and answers its rows.
 */
export function zonedDayCompare(/** @type {any} */ src, /** @type {string} */ op, /** @type {string} */ at,
  /** @type {(sql: string) => any[]} */ all) {
  const lhs = quoteIdent(src.column)
  if (src.offset) return { sql: `${lhs} ${op} date(?, COALESCE(${src.zone}, 0) || ' minutes')`, params: [at] }
  const utc    = at.slice(0, 10)
  const before = new Date(Date.parse(utc) - DAY_MS).toISOString().slice(0, 10)
  const after  = new Date(Date.parse(utc) + DAY_MS).toISOString().slice(0, 10)
  /** @type {string[]} */ const behind = []
  /** @type {string[]} */ const ahead  = []
  for (const row of all(src.distinct)) {
    const zone = Object.values(row)[0]
    let day
    try { day = plainDateIn(at, zone) } catch { continue }           // not a zone: read in UTC, as a null one is
    if (day === before) behind.push(zone)
    else if (day === after) ahead.push(zone)
  }
  const inList = `IN (SELECT value FROM json_each(?))`
  return {
    sql: `${lhs} ${op} (CASE WHEN ${src.zone} ${inList} THEN ? WHEN ${src.zone} ${inList} THEN ? ELSE ? END)`,
    params: [JSON.stringify(behind), before, JSON.stringify(ahead), after, utc],
  }
}

/**
 * The day `row` is on at the instant `at`, in its own zone — `zonedDayCompare`'s
 * rule for a row in hand, which a broadcast grades with no query to filter through.
 * `get(sql, params)` answers one row; a parent's zone is read through it.
 */
export function zonedDayOf(/** @type {any} */ src, /** @type {any} */ row, /** @type {string} */ at,
  /** @type {(sql: string, params: any[]) => any} */ get) {
  let zone = null
  if (src.zoneField) zone = row[src.zoneField]
  else if (src.parent) {
    const key = src.parent.fkFields.map((/** @type {string} */ f) => row[f])
    if (key.every((/** @type {any} */ v) => v != null)) zone = get(src.parent.sql, key)?.zone ?? null
  }
  if (zone == null) return at.slice(0, 10)
  if (src.offset) return new Date(Date.parse(at) + Number(zone) * 60_000).toISOString().slice(0, 10)
  try { return plainDateIn(at, zone) } catch { return at.slice(0, 10) }   // not a zone: UTC, as the SQL reads it
}

// ─── The instant ────────────────────────────────────────────────────────────

/**
 * `2026-07-01` + `09:00` in `America/New_York` → `2026-07-01T13:00:00.000Z`; null when any source is.
 * With `after`, an instant at or before it is read on the next day — `22:00–06:00` ends the morning
 * after, and an end equal to its start is 24 hours (`FJS-D2294`).
 */
export function wallInstant(/** @type {any} */ date, /** @type {any} */ time, /** @type {any} */ zone, /** @type {string|null} */ after = null) {
  if (date == null || time == null || zone == null) return null
  const [year, month, day] = String(date).split('-').map(Number)
  const [hour, minute, second = 0] = String(time).split(':').map(Number)
  // A number is an `Int @unit(min)` offset east of UTC (`FJS-D1290`): no gap, no repeated hour.
  const on = (/** @type {Date} */ d) => new Date(typeof zone === 'number'
    ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute, second) - zone * 60_000
    : fromWall({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
      hour, minute, second }, zone, { disambiguation: 'compatible' })).toISOString()
  const at = on(new Date(Date.UTC(year, month - 1, day)))
  return after != null && at <= after ? on(new Date(Date.UTC(year, month - 1, day + 1))) : at
}

// ─── The writes ─────────────────────────────────────────────────────────────

export function makeZoned(/** @type {any} */ shape, /** @type {any} */ deps) {
  const { modelName, tableName } = shape
  const { readDb, writeDb, col, buildWhereWithEncryption, sinkFor } = deps
  const own     = shape.zoned ?? []
  const parents = shape.zonedParents ?? []
  const ownKeys = new Set(own.map((/** @type {any} */ z) => z.field))
  const parentZoneFields = new Set(parents.map((/** @type {any} */ e) => e.zoneField))

  // The app never writes the instant, system included: a value written by hand
  // is a value the next source write silently replaces.
  function refuseZonedWrite(/** @type {any} */ data) {
    if (!ownKeys.size || !data || typeof data !== 'object') return
    const named = own.filter((/** @type {any} */ z) => Object.hasOwn(data, z.field))
    if (named.length) throw new ValidationError(named.map((/** @type {any} */ z) => ({
      path: [z.field],
      message: `${z.field} is ${z.label} — litestone derives it from the wall clock and the zone, so it cannot be written. Write ${z.date}, ${z.time} or the zone instead`,
    })), { model: modelName, operation: 'write' })
  }

  const sourcesOf = (/** @type {any} */ z) => [z.date, z.time, ...(z.anchorTime ? [z.anchorTime] : []), ...(z.zone ? [z.zone] : z.via.fkFields)]
  const zoneOf = (/** @type {any} */ z, /** @type {any} */ row) => {
    if (z.zone) return row[z.zone]
    const key = z.via.fkFields.map((/** @type {string} */ f) => row[f])
    if (key.some((/** @type {any} */ v) => v == null)) return null
    const on = z.via.refColumns.map((/** @type {string} */ c) => `${quoteIdent(c)} = ?`).join(' AND ')
    return writeDb.query(`SELECT ${quoteIdent(z.via.zoneColumn)} AS z FROM ${quoteIdent(z.via.table)} WHERE ${on}`).get(...key)?.z ?? null
  }

  // The payload with every instant whose sources it names laid in. An update
  // reads the stored row for the sources it does not name; several rows must
  // agree on the value, since one SET writes it to all of them.
  function deriveZoned(/** @type {any} */ data, { creating = false, where = /** @type {any} */ (null) } = {}) {
    if (!ownKeys.size || !data || typeof data !== 'object' || Array.isArray(data)) return data
    const touched = own.filter((/** @type {any} */ z) => creating || sourcesOf(z).some(k => Object.hasOwn(data, k)))
    if (!touched.length) return data
    let stored = /** @type {any[]|null} */ (null)
    const out = { ...data }
    for (const z of touched) {
      const missing = creating ? [] : sourcesOf(z).filter(k => !Object.hasOwn(data, k))
      let rows = [data]
      if (missing.length) {
        if (!where) throw new ValidationError([{ path: [z.field], message:
          `${z.field} is ${z.label} — this write names ${sourcesOf(z).filter(k => Object.hasOwn(data, k)).join(', ')} with no row to read ` +
          `${missing.join(', ')} from; name every source, or write through update()` }], { model: modelName, operation: 'write' })
        stored ??= readStored(where)
        rows = stored.map(r => ({ ...r, ...data }))
      }
      const values = [...new Set(rows.map(r => {
        const zone = z.zone && creating && r[z.zone] === undefined ? z.zoneDefault : zoneOf(z, r)
        const after = z.anchorTime ? wallInstant(r[z.date], r[z.anchorTime], zone) : null
        return wallInstant(r[z.date], r[z.time], zone, after)
      }))]
      if (values.length > 1) throw new ValidationError([{ path: [z.field], message:
        `${z.field} is ${z.label}, and this write moves it to a different instant on each of the ${rows.length} rows it reaches — ` +
        `one statement writes one value; update the rows one at a time` }], { model: modelName, operation: 'write' })
      if (values.length) out[z.field] = values[0]
    }
    return out
  }

  function readStored(/** @type {any} */ where) {
    const fields = [...new Set(own.flatMap(sourcesOf))]
    const params = /** @type {any[]} */ ([])
    const sql    = buildWhereWithEncryption(where, params)
    const sel    = fields.map(f => `${quoteIdent(col(f))} AS ${quoteIdent(f)}`).join(', ')
    return readDb.query(`SELECT ${sel} FROM ${quoteIdent(tableName)}${sql ? ` WHERE ${sql}` : ''}`).all(...params)
  }

  // ── The cascade, on the parent ───────────────────────────────────────────

  const zoneTouched = (/** @type {any} */ data) => parents.length > 0 && data != null && typeof data === 'object'
    && Object.keys(data).some(k => parentZoneFields.has(k))

  // The parents a WHERE names, read before the statement runs: the statement
  // may move a row out of its own filter.
  function zonedParentKeys(/** @type {string|null} */ whereSql, /** @type {any[]} */ params) {
    const cols = [...new Set(parents.flatMap((/** @type {any} */ e) => e.pairs.map((/** @type {any} */ [, p]) => p)))]
    const sel  = cols.map(c => quoteIdent(c)).join(', ')
    return writeDb.query(`SELECT DISTINCT ${sel} FROM ${quoteIdent(tableName)}${whereSql ? ` WHERE ${whereSql}` : ''}`).all(...params)
  }

  // Every child of these parents re-derived under the parent's zone as it now
  // stands, written inside the parent's unit. Each child is handed to `note` so
  // the exclusion grade sees its new range. A moved child is a write to that
  // child: its own table stamps `@updatedAt` here and, once the unit has let
  // go, announces and trails the [before, after] answered per model — written
  // raw and left at that, a live list of shifts never heard its instants move
  // (FJS-4480).
  function recomputeZonedChildren(/** @type {any[]} */ keys, /** @type {(model: string, row: any) => void} */ note) {
    /** @type {Map<string, any[]>} */ const moved = new Map()
    for (const e of parents) {
      const sink  = sinkFor(e.child)
      const stamp = sink?.stampSets([]) ?? []
      const on   = e.pairs.map((/** @type {any} */ [c, p]) => `_p.${quoteIdent(p)} = _c.${quoteIdent(c)}`).join(' AND ')
      const keyed = e.pairs.map((/** @type {any} */ [, p]) => `_p.${quoteIdent(p)} = ?`).join(' AND ')
      const read = writeDb.query(`SELECT _c.rowid AS "__rowid", _c.*, _p.${quoteIdent(e.zoneColumn)} AS "__zone" ` +
        `FROM ${quoteIdent(e.table)} _c JOIN ${quoteIdent(tableName)} _p ON ${on} WHERE ${keyed}`)
      for (const key of keys) {
        for (const child of read.all(...e.pairs.map((/** @type {any} */ [, p]) => key[p]))) {
          const { __rowid, __zone, ...before } = child
          const sets = []
          const binds = []
          for (const f of e.fields) {
            const after = f.anchorTimeColumn ? wallInstant(child[f.dateColumn], child[f.anchorTimeColumn], __zone) : null
            const value = wallInstant(child[f.dateColumn], child[f.timeColumn], __zone, after)
            if (value === child[f.column]) continue
            sets.push(`${quoteIdent(f.column)} = ?`)
            binds.push(value)
            child[f.column] = value
          }
          if (!sets.length) continue
          const after = writeDb.query(`UPDATE ${quoteIdent(e.table)} SET ${[...sets, ...stamp].join(', ')} WHERE rowid = ? RETURNING *`)
            .get(...binds, __rowid)
          note(e.child, child)
          if (!sink) continue
          if (!moved.has(e.child)) moved.set(e.child, [])
          moved.get(e.child)?.push([before, after])
        }
      }
    }
    return moved
  }

  return { refuseZonedWrite, deriveZoned, zoneTouched, zonedParentKeys, recomputeZonedChildren }
}
