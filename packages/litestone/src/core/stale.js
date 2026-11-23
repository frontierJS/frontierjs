// ─── @stale — a stored aggregate that says when it is stale ───────────────────
//
// `stale Boolean @system @stale(on: [gradeItem.aggregatesCategory.items.grades(where: userId == this.userId), …])`
//
// The schema cannot say a rollup's arithmetic (`FJS-D1301` C), so it says what
// the stored value depends on. Each source is a relation path walked from the
// declaring row to the rows it reads, with an optional `where:` in `@from`'s
// form: unqualified names are the source row's, `this.col` the declaring row's.
// A write to a source row sets the flag on every LIVE declaring row that
// reaches it, by trigger, in the write's own statement — so a raw UPDATE, a
// cascade and a delete mark too (`FJS-D2307`). The app's job clears the mark by
// writing the successor row with the flag false.
//
// What it cannot see stays the app's: a source nobody listed, and a declaring
// row that does not exist yet.
//
// Trigger writes skip the audit trail and the client's clock. SQLite's
// `recursive_triggers` is off, and the update trigger does not fire on the flag
// itself, so a mark climbs one level per write the job makes.

import { modelToTableName, columnMapFor, isStoredField, isSoftDelete } from './ddl.js'
import { inferFromFk } from './schema-maps.js'
import { compileFromWhere } from './policy.js'
import { quoteIdent } from './query.js'

const relationName = (f) => f.attributes.find(a => a.kind === 'relation')?.name ?? null
const col = (model, name) => columnMapFor(model)[name] ?? name

/**
 * One source path walked from `model`. Each hop joins the previous alias to
 * the next on every column of the key, whichever side holds it. Answers
 * `{ error }` rather than throwing so validate() words it.
 */
export function resolveStalePath(model, path, schema, pluralize = false) {
  const hops = []
  let at = model
  for (const name of path) {
    const f = at.fields.find(x => x.name === name)
    if (!f || f.type?.kind !== 'relation')
      return { error: f?.type?.kind === 'implicitM2M'
        ? `'${name}' on ${at.name} is a many-to-many, and a mark reaches a source through a foreign key`
        : `'${name}' is not a relation on ${at.name}` }
    const next = schema.models.find(m => m.name === f.type.name)
    if (!next) return { error: `'${name}' on ${at.name} points at unknown model '${f.type.name}'` }
    const own = f.attributes.find(a => a.kind === 'relation' && a.fields)
    const from = at
    if (own) {
      const fk  = [].concat(own.fields)
      const idf = next.fields.find(x => x.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
      const ref = own.references ? [].concat(own.references) : [idf]
      hops.push({ table: modelToTableName(next, pluralize), on: (p, n) =>
        fk.map((c, i) => `${p}.${quoteIdent(col(from, c))} = ${n}.${quoteIdent(col(next, ref[i]))}`).join(' AND ') })
    } else {
      const fk = inferFromFk(from, next, relationName(f))
      if (!fk || fk.ambiguous || fk.unresolvedVia)
        return { error: `'${name}' on ${at.name} has no foreign key on ${next.name} that it can be told apart by — name the relation on both sides` }
      hops.push({ table: modelToTableName(next, pluralize), on: (p, n) =>
        fk.fkCols.map((c, i) => `${n}.${quoteIdent(col(next, c))} = ${p}.${quoteIdent(col(from, fk.refCols[i]))}`).join(' AND ') })
    }
    at = next
  }
  return { hops, source: at }
}

const usesClock = (node) => /"type":"(now|shift)"/.test(JSON.stringify(node ?? null))

/** Every refusal one model's `@stale` fields earn, worded for validate(). */
export function staleProblems(model, schema) {
  const errors = []
  const dbOf = (m) => m.attributes.find(a => a.kind === 'db')?.name ?? 'main'
  for (const field of model.fields) {
    const attr = field.attributes.find(a => a.kind === 'stale')
    if (!attr) continue
    const where = `Model '${model.name}', field '${field.name}': @stale`
    if (field.type?.name !== 'Boolean' || field.type.array)
      errors.push(`${where} marks a Boolean column, and '${field.name}' is ${field.type?.name}`)
    if (!field.attributes.some(a => a.kind === 'system'))
      errors.push(`${where} needs @system on '${field.name}': the mark is the triggers' and the job's, and a caller who clears it hides a stale aggregate`)
    if (!attr.sources.length) errors.push(`${where} lists no source — write on: [<relation>.<relation>, …]`)
    for (const s of attr.sources) {
      const label = `${where} source '${s.path.join('.')}'`
      const hop = resolveStalePath(model, s.path, schema)
      if (hop.error) { errors.push(`${label} — ${hop.error}`); continue }
      if (dbOf(hop.source) !== dbOf(model))
        errors.push(`${label} — ${hop.source.name} lives in database '${dbOf(hop.source)}' and ${model.name} in '${dbOf(model)}', and a trigger reaches one file`)
      if (!s.where) continue
      if (usesClock(s.where)) { errors.push(`${label} — where: reads the clock, and a trigger has none`); continue }
      try { compileFromWhere(hop.source, `${label} where:`, s.where, schema, model) }
      catch (e) { errors.push(e.message) }
    }
  }
  return errors
}

/** The trigger trio for every `@stale` source in the slice of a schema one database holds. */
export function createStaleTriggers(schema, pluralize = false) {
  const out = []
  for (const model of schema.models) {
    if (model.attributes.some(a => a.kind === 'external')) continue
    const table = quoteIdent(modelToTableName(model, pluralize))
    const live  = []
    const to    = model.attributes.find(a => a.kind === 'effective')?.to
    if (to)                  live.push(`${table}.${quoteIdent(col(model, to))} IS NULL`)
    if (isSoftDelete(model)) live.push(`${table}.${quoteIdent(col(model, 'deletedAt'))} IS NULL`)

    for (const field of model.fields) {
      const attr = field.attributes.find(a => a.kind === 'stale')
      if (!attr) continue
      const flag = `${table}.${quoteIdent(col(model, field.name))}`
      attr.sources.forEach((s, i) => {
        const { hops, source } = resolveStalePath(model, s.path, schema, pluralize)
        const sourceTable = modelToTableName(source, pluralize)
        const stored = source.fields.filter(f => isStoredField(f)).map(f => col(source, f.name))
        const flags  = new Set(source.fields.filter(f => f.attributes.some(a => a.kind === 'stale')).map(f => col(source, f.name)))
        const where  = s.where ? compileFromWhere(source, '@stale', s.where, schema, model).sql.replaceAll('%SELF%', table) : null

        const reaches = (row) => {
          const alias = (k) => k === 0 ? table : k === hops.length ? row : `_s${k}`
          const on = hops.map((h, k) => h.on(alias(k), alias(k + 1)))
          const path = hops.length === 1 ? on[0]
            : `EXISTS (SELECT 1 FROM ${hops.slice(0, -1).map((h, k) => `${quoteIdent(h.table)} AS _s${k + 1}`).join(', ')} WHERE ${on.join(' AND ')})`
          // The where: names the source's columns bare, so it reads them off a
          // one-row table of this row: bare inside the UPDATE they would be
          // the declaring table's own.
          const filter = where
            ? [`EXISTS (SELECT 1 FROM (SELECT ${stored.map(c => `${row}.${quoteIdent(c)} AS ${quoteIdent(c)}`).join(', ')}) WHERE ${where})`]
            : []
          return `  UPDATE ${table} SET ${quoteIdent(col(model, field.name))} = 1 WHERE ${[`${flag} = 0`, ...live, path, ...filter].join(' AND ')};`
        }

        const base = `${modelToTableName(model, pluralize)}_${col(model, field.name)}_${i}`
        const name = (v) => quoteIdent(`${base}_stale_${v}`)
        const ofCols = stored.filter(c => !flags.has(c)).map(quoteIdent).join(', ')
        out.push(
          `-- ${model.name}.${field.name} is stale after a write to ${s.path.join('.')}`,
          ...['insert', 'update', 'delete'].map(v => `DROP TRIGGER IF EXISTS ${name(v)};`),
          `CREATE TRIGGER ${name('insert')} AFTER INSERT ON ${quoteIdent(sourceTable)} BEGIN`,
          reaches('new'),
          `END;`,
          `CREATE TRIGGER ${name('update')} AFTER UPDATE OF ${ofCols} ON ${quoteIdent(sourceTable)} BEGIN`,
          reaches('old'),
          reaches('new'),
          `END;`,
          `CREATE TRIGGER ${name('delete')} AFTER DELETE ON ${quoteIdent(sourceTable)} BEGIN`,
          reaches('old'),
          `END;`,
        )
      })
    }
  }
  return out.join('\n')
}
