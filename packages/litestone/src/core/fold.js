// @ts-check
// fold.js — retention that FOLDS (FJS-D1297).
//
//   model Check {
//     ...
//     @@retention(90d, into: DailyUptime, by: [monitorId, day(checkedAt)], sum: [ok], count: total)
//   }
//
// The sweep sums each batch of doomed rows into the rollup and deletes them in
// one transaction, so a reader adding both tables never sees a row twice or
// not at all. A day is folded whole: the cutoff is the start of the UTC day the
// window reaches, never an instant inside one.
//
// A day lives in the raw table XOR in the rollup. A raw row written for a key
// and day the rollup already holds is refused (FoldedSpanError), because the
// sweep would fold it into a total a reader already took as final, and into a
// sealed one it cannot fold at all.
//
// Names: a key names a field of both models, an aggregate's field names a
// field of both (count's names the rollup's alone), and the bucket lands in
// the rollup column named for the bucket, `day`.

import { modelToTableName, fieldToColumnName, isStoredField, columnDefaultExpr, isUpdatedAtField } from './ddl.js'
import { frozenAfterMove, machineWithMove, sealedStates } from './seal.js'
import { quoteIdent } from './query.js'

export const FOLD_AGGREGATES = ['sum', 'count', 'min', 'max']

// SQLite's day of an ISO instant, in UTC whatever offset the text carries.
const dayOf = (/** @type {string} */ expr) => `strftime('%Y-%m-%d', ${expr})`
const q     = quoteIdent

const typeName = (/** @type {any} */ f) => typeof f?.type === 'object' ? f.type.name : f?.type
const isArray  = (/** @type {any} */ f) => !!(f?.type?.array || f?.array)
const dbOf     = (/** @type {any} */ m) => m.attributes.find((/** @type {any} */ a) => a.kind === 'db')?.name ?? 'main'

/** @param {any} model */
export function foldAttr(model) {
  return model.attributes?.find((/** @type {any} */ a) => a.kind === 'retention' && a.into) ?? null
}

// ─── The parse-time refusals ──────────────────────────────────────────────────
// Each is a fold that would sweep wrong rather than fail: a rollup INSERT
// missing a required column throws mid-sweep, and a key the rollup's unique
// does not cover folds two days into one row.

/** @returns {string[]} */
export function foldProblems(/** @type {any} */ model, /** @type {any} */ schema) {
  const ret = foldAttr(model)
  if (!ret) return []
  const at     = `Model '${model.name}': @@retention(${ret.window}, into: ${ret.into})`
  const rollup = schema.models.find((/** @type {any} */ m) => m.name === ret.into)
  if (!rollup) return [`${at} — '${ret.into}' names no model`]
  if (rollup === model) return [`${at} — a model cannot fold into itself`]
  const errors = []
  if (dbOf(rollup) !== dbOf(model))
    errors.push(`${at} — '${ret.into}' is in database '${dbOf(rollup)}' and this model in '${dbOf(model)}'; a fold writes the rollup and deletes the rows in one transaction, so both live in one file`)

  const raw  = (/** @type {string} */ n) => model.fields.find((/** @type {any} */ f) => f.name === n)
  const roll = (/** @type {string} */ n) => rollup.fields.find((/** @type {any} */ f) => f.name === n)
  const named = new Set()

  for (const b of ret.by.filter((/** @type {any} */ b) => !b.bucket)) {
    const r = raw(b.field), t = roll(b.field)
    if (!r || !t) errors.push(`${at} — key '${b.field}' must be a field of both ${model.name} and ${ret.into}`)
    else if (isArray(r) || r.type.kind === 'relation' || typeName(r) !== typeName(t))
      errors.push(`${at} — key '${b.field}' is ${typeName(r)} on ${model.name} and ${typeName(t)} on ${ret.into}; a key is one scalar type on both`)
    named.add(b.field)
  }

  const day = roll('day')
  if (!day || typeName(day) !== 'String' || !day.attributes.some((/** @type {any} */ a) => a.kind === 'date'))
    errors.push(`${at} — by: day(${ret.from}) lands in ${ret.into}.day, which must be a 'String @date' field`)
  named.add('day')

  for (const { fn, field } of ret.aggs) {
    const t = roll(field)
    if (named.has(field)) errors.push(`${at} — ${ret.into}.${field} is written twice`)
    named.add(field)
    if (!t || isArray(t) || !['Int', 'Float'].includes(typeName(t))) {
      errors.push(`${at} — ${fn}: ${field} writes ${ret.into}.${field}, which must be an Int or Float field`)
      continue
    }
    const imm = t.attributes.find((/** @type {any} */ a) => a.kind === 'immutable')
    if (imm && !imm.after && !rollup.attributes.some((/** @type {any} */ a) => sealedStates(a)))
      errors.push(`${at} — ${ret.into}.${field} is @immutable from create, and a fold adds each batch to it; freeze it at a move with @immutable(after: <move>)`)
    if (fn === 'count') {
      if (typeName(t) !== 'Int') errors.push(`${at} — count: ${field} writes a count, so ${ret.into}.${field} is an Int`)
      continue
    }
    const r = raw(field)
    if (!r || isArray(r) || !['Int', 'Float', 'Boolean'].includes(typeName(r)))
      errors.push(`${at} — ${fn}: ${field} reads ${model.name}.${field}, which must be an Int, Float or Boolean field`)
    else if (typeName(r) === 'Float' && typeName(t) === 'Int')
      errors.push(`${at} — ${fn}: ${field} reads a Float into ${ret.into}.${field}, an Int, which would round it`)
  }

  const key  = [...ret.by.filter((/** @type {any} */ b) => !b.bucket).map((/** @type {any} */ b) => b.field), 'day'].sort().join(',')
  const uniq = [
    ...rollup.attributes.filter((/** @type {any} */ a) => a.kind === 'uniqueIndex' && !a.where).map((/** @type {any} */ a) => a.fields),
    ...rollup.fields.filter((/** @type {any} */ f) => f.attributes.some((/** @type {any} */ a) => a.kind === 'unique')).map((/** @type {any} */ f) => [f.name]),
  ]
  if (!uniq.some(fs => [...fs].sort().join(',') === key))
    errors.push(`${at} — ${ret.into} needs @@unique([${key.split(',').join(', ')}]): the fold adds a batch to the row that key names`)

  // The rollup's row is minted by an INSERT … SELECT, which fills only what the
  // fold names, a SQL default, or a clock it stamps.
  for (const f of rollup.fields) {
    if (named.has(f.name) || !isStoredField(f) || f.type?.optional || f.optional) continue
    const attrs = f.attributes ?? []
    if (columnDefaultExpr(f) != null || isUpdatedAtField(f)) continue
    if (attrs.some((/** @type {any} */ a) => a.kind === 'generated')) continue
    if (attrs.some((/** @type {any} */ a) => a.kind === 'id') && typeName(f) === 'Int') continue
    errors.push(`${at} — the fold creates ${ret.into} rows and cannot fill '${f.name}': give it a SQL default, make it optional, or name it in the fold`)
  }
  return errors
}

// ─── The spec the client and the sweep read ───────────────────────────────────

/**
 * @param {any} model
 * @param {any[]} models  every model the rollup may be
 * @param {boolean} pluralize
 */
export function foldSpec(model, models, pluralize = false) {
  const ret = foldAttr(model)
  if (!ret) return null
  const rollup = models.find((/** @type {any} */ m) => m.name === ret.into)
  if (!rollup) return null
  const rawCol  = (/** @type {string} */ n) => fieldToColumnName(model.fields.find((/** @type {any} */ f) => f.name === n))
  const rollCol = (/** @type {string} */ n) => fieldToColumnName(rollup.fields.find((/** @type {any} */ f) => f.name === n))
  const keys = ret.by.filter((/** @type {any} */ b) => !b.bucket)
    .map((/** @type {any} */ b) => ({ field: b.field, column: rawCol(b.field), rollupColumn: rollCol(b.field) }))
  const aggs = ret.aggs.map((/** @type {any} */ a) =>
    ({ fn: a.fn, from: a.fn === 'count' ? null : rawCol(a.field), to: rollCol(a.field), field: a.field }))
  const named   = new Set([...keys.map((/** @type {any} */ k) => k.field), 'day', ...aggs.map((/** @type {any} */ a) => a.field)])
  const updated = rollup.fields.filter((/** @type {any} */ f) => isStoredField(f) && isUpdatedAtField(f) && !named.has(f.name))
  const created = rollup.fields.filter((/** @type {any} */ f) => isStoredField(f) && !named.has(f.name) && !isUpdatedAtField(f) &&
    f.attributes.some((/** @type {any} */ a) => a.kind === 'default' && a.value?.kind === 'call' && a.value.fn === 'now' && !a.value.shift))

  // A rollup row in one of these states holds a number a reader took as
  // final, and the fold adds nothing to it.
  const seals = []
  const self  = rollup.attributes.map(sealedStates).find(Boolean)
  for (const a of aggs) {
    const f   = rollup.fields.find((/** @type {any} */ x) => x.name === a.field)
    const imm = f?.attributes.find((/** @type {any} */ x) => x.kind === 'immutable')
    if (!imm) continue
    const frozen = imm.after ? frozenAfterMove(machineWithMove(rollup, imm.after), imm.after) : self
    if (frozen) seals.push({ column: rollCol(frozen.field), states: [...frozen.states] })
  }

  return {
    model:       model.name,
    into:        rollup.name,
    window:      ret.window,
    table:       modelToTableName(model, pluralize),
    rollupTable: modelToTableName(rollup, pluralize),
    clock:       { field: ret.from, column: rawCol(ret.from) },
    day:         rollCol('day'),
    keys, aggs, seals,
    stamps:      [...created, ...updated].map(f => fieldToColumnName(f)),
    restamps:    updated.map((/** @type {any} */ f) => fieldToColumnName(f)),
  }
}

// ─── The create guard ─────────────────────────────────────────────────────────
// Conjoined into the INSERT … SELECT the seal guard already makes of a create.

const dayMatch = (/** @type {any} */ spec) =>
  [...spec.keys.map((/** @type {any} */ k) => `${q(k.rollupColumn)} = ?`), `${q(spec.day)} = ${dayOf('?')}`].join(' AND ')

/** @param {any} spec */
export function foldInsertSql(spec) {
  return `NOT EXISTS (SELECT 1 FROM ${q(spec.rollupTable)} WHERE ${dayMatch(spec)})`
}

/** The row's key and clock, in the order foldInsertSql binds them. @param {any} spec @param {any} row */
export function foldInsertParams(spec, row) {
  return [...spec.keys.map((/** @type {any} */ k) => row?.[k.field] ?? null), row?.[spec.clock.field] ?? null]
}

/** The rollup row that refused a create, or null. @param {any} spec @param {any} db @param {any[]} params */
export function foldedDay(spec, db, params) {
  const hit = db.query(`SELECT ${q(spec.day)} AS day FROM ${q(spec.rollupTable)} WHERE ${dayMatch(spec)} LIMIT 1`).get(...params)
  if (!hit) return null
  return { day: hit.day, key: Object.fromEntries(spec.keys.map((/** @type {any} */ k, /** @type {number} */ i) => [k.field, params[i]])) }
}

// ─── The update guard ─────────────────────────────────────────────────────────
// An update naming the clock or a key can move a row into a folded day as
// surely as a create can. The row's new key and day are computed in the
// UPDATE's own scope, so a column the payload leaves alone reads as stored and
// an operator's expression reads the row it is assigning to. COALESCE: a NULL
// key matches no rollup row, as it does on create.

/**
 * A WHERE conjunct true when the written row stays out of every folded day,
 * or null when the payload names neither the clock nor a key.
 * `values` selects the row's new key and clock, for naming the refusal.
 * @param {any} spec @param {Record<string, any>} row @param {{ col: string, expr: string, params: any[] }[]} ops
 */
export function foldMoveClause(spec, row, ops) {
  const cols = [...spec.keys, spec.clock]
  if (!cols.some(c => c.field in row || ops.some(o => o.col === c.field))) return null
  /** @type {any[]} */
  const params = []
  const exprs  = cols.map(c => {
    const op = ops.find(o => o.col === c.field)
    if (op) { params.push(...op.params); return `(${op.expr})` }
    if (c.field in row) { params.push(row[c.field] ?? null); return '?' }
    return q(c.column)
  })
  const clock = /** @type {string} */ (exprs.pop())
  const into  = [...spec.keys.map((/** @type {any} */ k) => q(k.rollupColumn)), q(spec.day)].join(', ')
  return {
    sql:    `COALESCE((${[...exprs, dayOf(clock)].join(', ')}) IN (SELECT ${into} FROM ${q(spec.rollupTable)}), 0) = 0`,
    params,
    values: { sql: [...exprs, clock].map((e, i) => `${e} AS _f${i}`).join(', '), params },
  }
}

// ─── The sweep ────────────────────────────────────────────────────────────────

/** The fold's cutoff: the start of the UTC day `at - window` falls in. */
export function foldCutoff(/** @type {number} */ at, /** @type {number} */ ms) {
  const d = new Date(at - ms)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString()
}

/**
 * Add one batch of doomed rows into the rollup. Run inside the transaction
 * that deletes them. Throws, adding nothing, when a row of the batch belongs
 * to a sealed rollup row.
 *
 * @param {any} db  the raw write handle
 * @param {any} spec
 * @param {string} these  `FROM <table> WHERE rowid IN (SELECT value FROM json_each(?))`
 * @param {string} list   the batch's rowids as JSON
 * @param {string} now    the sweep's clock, ISO
 */
export function foldBatch(db, spec, these, list, now) {
  const encode = (/** @type {any} */ v) => typeof v === 'boolean' ? (v ? 1 : 0) : v
  const groupCols = [...spec.keys.map((/** @type {any} */ k) => q(k.column)), dayOf(q(spec.clock.column))]
  const target    = [...spec.keys.map((/** @type {any} */ k) => q(k.rollupColumn)), q(spec.day)]

  for (const s of spec.seals) {
    const match = target.map((c, i) => `"_r".${c} IS "_b"."g${i}"`).join(' AND ')
    const sealed = db.query(
      `SELECT ${target.map((c, i) => `"_b"."g${i}" AS g${i}`).join(', ')}, "_r".${q(s.column)} AS state ` +
      `FROM (SELECT DISTINCT ${groupCols.map((c, i) => `${c} AS g${i}`).join(', ')} ${these}) "_b" ` +
      `JOIN ${q(spec.rollupTable)} "_r" ON ${match} WHERE "_r".${q(s.column)} IN (${s.states.map(() => '?').join(', ')}) LIMIT 1`,
    ).get(list, ...s.states.map(encode))
    if (sealed) {
      const key   = spec.keys.map((/** @type {any} */ k, /** @type {number} */ i) => `${k.field} ${JSON.stringify(sealed[`g${i}`])}`)
      const state = s.states.find((/** @type {any} */ v) => encode(v) === sealed.state) ?? sealed.state
      throw new Error(`${spec.into} for ${[...key, `day ${sealed[`g${spec.keys.length}`]}`].join(', ')} is at '${state}', which is sealed, ` +
        `and ${spec.model} still holds rows of that day; they are kept rather than folded into a number a reader took as final`)
    }
  }

  const aggExpr = (/** @type {any} */ a) => {
    if (a.fn === 'count') return 'COUNT(*)'
    if (a.fn === 'sum')   return `COALESCE(SUM(${q(a.from)}), 0)`
    return `${a.fn.toUpperCase()}(${q(a.from)})`
  }
  const merge = (/** @type {any} */ a) => {
    const c = q(a.to)
    if (a.fn === 'sum' || a.fn === 'count') return `${c} = COALESCE(${c}, 0) + excluded.${c}`
    return `${c} = COALESCE(${a.fn.toUpperCase()}(${c}, excluded.${c}), ${c}, excluded.${c})`
  }
  const cols = [...target, ...spec.aggs.map((/** @type {any} */ a) => q(a.to)), ...spec.stamps.map(q)]
  const sel  = [...groupCols, ...spec.aggs.map(aggExpr), ...spec.stamps.map(() => '?')]
  const set  = [...spec.aggs.map(merge), ...spec.restamps.map((/** @type {string} */ c) => `${q(c)} = excluded.${q(c)}`)]
  db.prepare(
    `INSERT INTO ${q(spec.rollupTable)} (${cols.join(', ')}) SELECT ${sel.join(', ')} ${these} ` +
    `GROUP BY ${groupCols.map((_, i) => i + 1).join(', ')} ON CONFLICT (${target.join(', ')}) DO UPDATE SET ${set.join(', ')}`,
  ).run(...spec.stamps.map(() => now), list)
}
