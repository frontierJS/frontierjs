// constraint-refusals.js — a refused write said in the caller's words: SQLite's
// unique, CHECK, datatype and foreign-key failures translated into the errors
// junction maps by name, a parent the caller cannot read refused as a missing
// one, a delete a child still blocks, and the row of a batch that failed.
//
// Built once per table by `makeTable`, which hands it both connections, the
// column translations and the row readers it cannot derive from `shape`, and
// takes back the functions its verbs call. Every translator runs on the
// failing path only.

import { modelToAccessor, fieldToColumnName, arcCheckExpr, arcDefaultMessage, mapExprCols, pointDefaultMessage } from './ddl.js'
import { keyIn, tuplesOf } from './query.js'
import { ValidationError } from './validate.js'
import { AccessDeniedError } from './plugin.js'
import { requireGrantSubset } from '../plugins/capability.js'
import { checkCreatePolicy } from './policy.js'
import {
  SoftDeletedUniqueError, UniqueConflictError, uniqueConflictColumns, isUniqueConflict,
  checkViolationExpr, isCheckViolation, datatypeMismatch, isDatatypeMismatch,
  ForeignKeyError, isForeignKeyFailure,
} from './errors.js'

// Whether any read rule adds to a read of this table for its flavor:
// `tbl[NARROWED]()`. hiddenParents asks it of a PARENT's table, whose rules
// only that table's closure knows.
export const NARROWED = Symbol.for('litestone.narrowed')

export function makeConstraintRefusals(shape, ctx, deps) {
  const { tableName, modelName, softDelete, columnMap } = shape
  const { readDb, writeDb, col, _fieldOf, _ecp, redactValue, readAll, requiredFailure, selectWhere } = deps
  const plugins = ctx.plugins

  // ── a UNIQUE conflict, said in the caller's own words ───────────────────────
  //
  // Only ever runs on the failing path, so the happy path pays nothing. Two
  // questions in order, because the answers are different actions.
  //
  // A DELETED row holding the value is asked first, with one extra SELECT
  // against the deleted rows alone: a soft-deleted row keeps its @unique values
  // and the way out is restore-or-release, which nothing in SQLite's message
  // hints at (FJS-204).
  //
  // Otherwise a live row holds it, which is the ordinary case — and it used to
  // be the one path with no answer at all, escaping as SQLite's own sentence
  // inside a 500 (FJS-441).
  //
  // Every write path that can hit the constraint routes through here, because
  // they gave four different answers to one question — two of them silently
  // (FJS-276).
  //
  // An UPDATE names only the columns it changes, and a unique index (a partial
  // one most of all) can span columns it leaves alone. `reached(cols)` reads
  // those from the row the statement was aimed at, so the values are the row's
  // own after the write rather than `undefined` (FJS-2691).
  function asUniqueConflict(err, data, reached) {
    if (!isUniqueConflict(err) || err instanceof UniqueConflictError) return err
    const cols = uniqueConflictColumns(err)?.map(_fieldOf)
    if (!cols?.length) return err
    let rows = Array.isArray(data) ? data : [data]
    if (reached && rows.length === 1 && rows[0] && typeof rows[0] === 'object'
        && cols.some(c => !(c in rows[0]) || rows[0][c] === undefined)) {
      let held = null
      try { held = reached(cols) } catch { /* the plain answer below stands */ }
      if (held) {
        const merged = { ...held }
        for (const [k, v] of Object.entries(rows[0])) if (v !== undefined) merged[k] = v
        rows = [merged]
      }
    }
    if (softDelete) {
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        if (cols.some(c => row[c] === undefined)) continue
        const where = {}
        for (const c of cols) where[c] = row[c]
        let hit = null
        try { hit = readDb.query(
          `SELECT * FROM "${tableName}" WHERE ${cols.map(c => `"${col(c)}" = ?`).join(' AND ')} AND "${col('deletedAt')}" IS NOT NULL LIMIT 1`
        ).get(...cols.map(c => row[c] ?? null)) } catch { return err }
        if (!hit) continue
        const idField = shape.model.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
        return new SoftDeletedUniqueError(modelName, cols, cols.map(c => redactValue(c, row[c])), hit[idField], idField)
      }
    }
    // A live row holds the value, which is the ordinary case and the one that
    // used to escape as a 500 carrying `product_variant.sku`.
    const named = rows.find(r => r && typeof r === 'object' && cols.some(c => r[c] !== undefined))
    return new UniqueConflictError(
      modelName, cols,
      cols.map(c => (named?.[c] === undefined ? undefined : redactValue(c, named[c]))),
      { keys: _parentKeys.flatMap(p => p.fields) })
  }

  // A CHECK the row did not satisfy.
  //
  // It used to escape as SQLite's own sentence inside a 500 — the server saying
  // it broke about a request it understood perfectly, and a validation problem
  // at that. `@@unique` has had the translated answer since `FJS-441`; `@check`
  // is the same class and had never been given one (`FJS-534`).
  //
  // It becomes a `ValidationError` rather than a class of its own, because the
  // way out is the way out of every other validation failure: send a different
  // value. Two errors exist where two RECOVERIES exist — restore-or-release
  // against send-another-value is why `SoftDeletedUniqueError` is separate from
  // `UniqueConflictError` — and there is only one here.
  //
  // **The expression is for the developer and never for the person.** It goes on
  // `err.constraint` and into the summary message, and it stays out of the
  // per-field `errors[]` a form renders: `qty > 0` under a control is SQL
  // reaching somebody who did not write it. An author who wants a sentence
  // there writes one — `@check("qty > 0", "must be at least one")`.
  function asCheckViolation(err) {
    if (!isCheckViolation(err) || err instanceof ValidationError) return err
    const expr = checkViolationExpr(err)
    if (!expr) return err

    const model = shape.model
    const norm  = (e) => String(e ?? '').replace(/\s+/g, ' ').trim()
    const want  = norm(expr)
    // SQLite reports the text the EMITTER wrote, which is in column space on a
    // mapped model, and every `expr` compared against it here is the author's
    // and names fields. Run through the same translation the emitter used, or
    // no declaration matches and every violation falls through to the generic
    // sentence these branches exist to replace.
    const asWritten = (e) => norm(mapExprCols(e, columnMap))

    // A field's own check names the column, so the message lands on the box.
    const field = model?.fields?.find(f =>
      f.attributes?.some(a => a.kind === 'check' && asWritten(a.expr) === want))
    if (field) {
      const declared = field.attributes.find(a => a.kind === 'check' && asWritten(a.expr) === want)
      const out = new ValidationError([
        { path: [field.name], message: declared?.message ?? 'is not valid' },
      ])
      out.model      = modelName
      out.constraint = expr
      return out
    }

    // `@required(where: …)` is the same technique as the arc below — rebuild
    // what the emitter wrote and compare — and it is the branch that makes the
    // declaration worth having over a hand-written `@@check`. SQLite reports a
    // violation by the constraint's SOURCE TEXT and has no field to blame, so
    // without this the refusal is the generic form-level sentence: correct, and
    // no use to somebody looking at five boxes wondering which one it means.
    //
    // The message and the path both come from `requiredFailure`, which is the
    // one owner of *why this field cannot be left without a value* — so a
    // conditional required says the same sentence as an unconditional one, and
    // `@required(where: …, "…")`'s wording is picked up for free by the same
    // lookup that reads `@required("…")`.
    const condReq = model?.fields?.find(f => {
      const req = f.attributes?.find(a => a.kind === 'required' && a.whereSql)
      if (!req) return false
      return norm(`NOT (${mapExprCols(req.whereSql, columnMap)}) OR "${col(f.name)}" IS NOT NULL`) === want
    })
    if (condReq) {
      const out = new ValidationError([requiredFailure(condReq)])
      out.model      = modelName
      out.constraint = expr
      return out
    }

    // An @@arc compiles to a CHECK with no `expr` of its own, so it is found by
    // rebuilding the SQL the emitter wrote. Without this branch every arc
    // violation falls through to the generic sentence below, which is the
    // failure `FJS-534` describes one attribute earlier.
    const arc = model?.attributes?.find(a =>
      a.kind === 'arc' && norm(arcCheckExpr(a, columnMap)) === want)
    if (arc) {
      const out = new ValidationError([
        { path: [], message: arc.message ?? arcDefaultMessage(arc) },
      ])
      out.model      = modelName
      out.constraint = expr
      return out
    }

    // SQLite reports a CHECK that opens with a column by that column's name
    // alone, not by its text, so a point's refusal arrives as `location` and
    // is found by the field. Without this the refusal is the model-level
    // sentence below -- no column, no rule.
    for (const f of model?.fields ?? []) {
      const pt = f.attributes?.find(a => a.kind === 'point')
      if (!pt || want !== fieldToColumnName(f)) continue
      const out = new ValidationError([{ path: [f.name], message: pointDefaultMessage(pt) }])
      out.model      = modelName
      out.constraint = expr
      return out
    }

    // A model-level one spans columns by definition, so there is no single box
    // to mark and the empty path is the form-level answer — the shape
    // `VersionConflictError` already takes for a refusal about a whole record.
    const declared = model?.attributes?.find(a => a.kind === 'check' && asWritten(a.expr) === want)
    const out = new ValidationError([
      { path: [], message: declared?.message ?? 'this record is not valid' },
    ])
    out.model      = modelName
    out.constraint = expr
    return out
  }

  // A value of the wrong storage class in a STRICT column (FJS-1609, FJS-D521).
  // SQLite's sentence is true of a physical column and tells nobody what to
  // send, so it becomes the same 422 a validator's refusal is.
  function asDatatypeMismatch(err) {
    if (!isDatatypeMismatch(err) || err instanceof ValidationError) return err
    const m = datatypeMismatch(err)
    if (!m) return err
    const field = _fieldOf(m.column)
    const out = new ValidationError([
      { path: [field], message: `cannot hold a ${m.stored} value — the field is ${m.declared}` },
    ])
    out.model = modelName
    return out
  }

  // One owner for "SQLite refused this write". Every constraint routes through
  // here, because eight call sites each choosing which translator to try is how
  // one of them ends up trying neither.
  function asConstraintError(err, data, reached) {
    if (isCheckViolation(err)) return asCheckViolation(err)
    if (isDatatypeMismatch(err)) return asDatatypeMismatch(err)
    if (isForeignKeyFailure(err)) return asMissingParent(err, data)
    return asUniqueConflict(err, data, reached)
  }

  // ── a foreign key naming a row that is not there (FJS-1454) ────────────────
  //
  // SQLite names neither the column nor the value, so each declared key the
  // row carries is looked up in its parent until one is missing. Physical
  // names come from the table's own foreign_key_list, so `@map` needs no second
  // spelling. Failing path only.
  function asMissingParent(err, data) {
    if (err instanceof ForeignKeyError) return err
    const row = Array.isArray(data) ? data[0] : data
    try {
      // One entry per column; a composite key shares its `id` across them.
      const keys = new Map()
      for (const fk of writeDb.query(`PRAGMA foreign_key_list("${tableName}")`).all()) {
        if (!keys.has(fk.id)) keys.set(fk.id, [])
        keys.get(fk.id).push(fk)
      }
      // A single-column key first: when its parent is missing, so is the
      // composite parent that shares the column, and the single one is the cause.
      for (const cols of [...keys.values()].sort((a, b) => a.length - b.length)) {
        const fields = cols.map(c => _fieldOf(c.from))
        const values = fields.map(f => row?.[f])
        if (values.some(v => v == null)) continue
        const hit = readDb.query(
          `SELECT 1 FROM "${cols[0].table}" WHERE ${cols.map(c => `"${c.to}" = ?`).join(' AND ')} LIMIT 1`
        ).get(...values)
        if (hit) continue
        // Two relations may share a leading column (`crew` and `crewDay`), so
        // the whole list is what names one.
        const [relation, rel] = Object.entries(shape.relations)
          .find(([, r]) => r.kind === 'belongsTo' &&
            r.foreignKeys.length === fields.length && r.foreignKeys.every((n, i) => n === fields[i])) ?? []
        return parentRefusal(relation, fields, values, rel?.targetModel ?? cols[0].table)
      }
    } catch { return err }
    return new ForeignKeyError(modelName)
  }

  // The one spelling of *that parent is not there*, for a missing parent and a
  // hidden one alike: a difference between the two answers is the oracle.
  function parentRefusal(relation, fields, values, target, archived = false) {
    const one = fields.length === 1
    const out = new ForeignKeyError(modelName, {
      relation,
      field:  one ? fields[0] : fields,
      value:  one ? redactValue(fields[0], values[0]) : fields.map((f, i) => redactValue(f, values[i])),
      target,
      archived,
    })
    Object.defineProperty(out, 'key', { value: { fields, values }, enumerable: false })
    return out
  }

  // An update naming the parent a row already has moves nothing: a form posts
  // the whole row back, and a row that may be edited under a parent its editor
  // cannot read must stay editable. Only a matched row the write would MOVE
  // makes the hidden parent the caller's choice. Inside the write's unit.
  function movesOnto(refusal, whereSql, whereParams) {
    const { fields, values } = refusal.key
    return !!writeDb.query(
      `SELECT 1 FROM "${tableName}" WHERE ${whereSql ? `(${whereSql}) AND ` : ''}` +
      `NOT (${fields.map(f => `"${col(f)}" IS ?`).join(' AND ')}) LIMIT 1`
    ).get(...whereParams, ...values.map(_ecp))
  }

  // ── a foreign key naming a parent the caller cannot read ───────────────────
  //
  // A row the caller cannot read answers as missing, and naming it as a parent
  // is a read. SQLite admits the key because the row exists, so Alice could
  // file a Task under Bob's Project — one `findUnique` told her is not there —
  // and the difference between that success and Project 999's refusal told her
  // which ids are real. Asked of the parent table's own `exists()` under the
  // caller, so the gate, the read filters, soft delete and the read policy are
  // the definition every read already uses. asSystem() is the blind reference,
  // and a key the engine stamped is its statement rather than the caller's.
  const _parentKeys = shape.model.fields.flatMap(f => {
    if (f.type?.kind !== 'relation') return []
    const a = f.attributes.find(x => x.kind === 'relation' && x.fields)
    return a ? [{ relation: f.name, target: f.type.name, fields: [a.fields].flat(), references: [a.references].flat() }] : []
  })

  // ── a key to a row holding a grant is that grant ──────────────────────────
  //
  // The resolver flattens a role row onto whoever holds a key to it, so the
  // column guard alone is walked around: an admin refused writing a role with
  // more than they hold points their own key at the owner's role and takes all
  // of it (FJS-2324). The parent is read past every rule, since a policy
  // stripping the list would grade it as empty. One hop — a key to a row that
  // keys a role is the resolver's to flatten, and nothing here can see it.
  function grantColumnsOf(target) {
    return (ctx.shapes[target]?.model?.fields ?? []).filter(f => f.type?.name === 'Capability').map(f => f.name)
  }

  function parentRows(sink, references, values) {
    return sink.rowsWhere(references, [values])
  }

  function requireParentGrants(target, fields, references, values) {
    if (ctx.isSystem) return
    const grants = grantColumnsOf(target)
    const sink   = grants.length && ctx.cascadeSinkFor?.(target)
    if (!sink) return
    for (const r of parentRows(sink, references, values))
      for (const g of grants) requireGrantSubset(modelName, fields.join(', '), r[g], ctx)
  }

  // A template is a live row the caller may read, not a hidden one: the
  // template filter shapes which rows a statement is ABOUT, and grading a
  // parent by it refused every child added under a template (FJS-2630).
  async function canRead(tbl, where, templates = false, deleted = false) {
    try { return await tbl.exists({ where, ...(templates ? { withTemplates: true } : {}), ...(deleted ? { withDeleted: true } : {}) }) }
    catch (e) { if (e instanceof AccessDeniedError) return false; throw e }
  }

  // A parent unreadable now and readable with `withDeleted` is archived. Any
  // caller may pass that flag, so saying so tells her nothing she could not
  // ask; a parent she could not read either way stays indistinguishable from
  // a missing one.
  async function isArchivedParent(tbl, target, where) {
    return !!ctx.shapes?.[target]?.softDelete &&
      await canRead(tbl, where, ctx.shapes?.[target]?.hasTemplates != null, true)
  }

  // A parent no read rule narrows hides a row from the caller only by the
  // gate refusing the whole model, which needs no query to ask. Without this,
  // every write naming a foreign key paid one exists() per key on a schema
  // with nothing to hide.
  async function hidesNothing(tbl, target) {
    if (tbl[NARROWED]?.() !== false) return false
    try { if (plugins?.hasPlugins) await plugins.beforeRead(target, {}, ctx); return true }
    catch (e) { if (e instanceof AccessDeniedError) return false; throw e }
  }

  // Graded before the write and THROWN where SQLite's own refusal of a missing
  // parent would land — after validation, at the row's place in a batch — so
  // the two answers differ in nothing, order included. Only a parent that
  // EXISTS and is hidden is refused here: a missing one is SQLite's to refuse,
  // and it may be a row this same call is writing — an earlier row of the
  // batch, or the row itself.
  //
  // `stamped` is per row, as writeData's is: one row's stamp must not excuse
  // another row's caller-named key.
  //
  // A key the call names under `system:` is the application's statement, as a
  // stamp is: a hook that copies a parent id from a row it read puts there a
  // parent the caller may not read, and grading it as the caller's guess
  // answered 422 'names no …' for a value the caller never chose (FJS-1953).
  //
  // A refusal names the first hidden relation and carries every one in
  // `hidden`, for the create policy to read as missing: a rule reading a
  // hidden parent's column answers by that column, and the caller chose both
  // the key and the payload it is compared with (FJS-1712).
  //
  // A parent holding a `Capability[]` is graded here too, only once the caller
  // can read it: a hidden one answers as hidden, and naming its list would read it.
  async function hiddenParents(rows, stamped = [], system = null) {
    const out = []
    if (ctx.isSystem || !_parentKeys.length) return out
    const lifted = new Set(system == null ? [] : [system].flat())
    for (const p of _parentKeys) {
      const tbl  = ctx.tables?.[modelToAccessor(p.target)]
      const sink = ctx.cascadeSinkFor?.(p.target)
      if (!tbl || !sink) continue
      const grants = grantColumnsOf(p.target)
      const blind  = await hidesNothing(tbl, p.target)
      if (blind && !grants.length) continue
      const verdict = new Map()
      for (const [i, row] of rows.entries()) {
        if (!row || typeof row !== 'object' || !p.fields.every(f => f in row)) continue
        if (p.fields.every(f => stamped[i]?.has(f) || lifted.has(f))) continue
        const values = p.fields.map(f => row[f])
        if (values.some(v => v == null || typeof v === 'object')) continue
        const key = JSON.stringify(values)
        if (!verdict.has(key)) verdict.set(key, blind ||
          await canRead(tbl, Object.fromEntries(p.references.map((r, j) => [r, values[j]])), ctx.shapes?.[p.target]?.hasTemplates != null) ||
          !parentRows(sink, p.references, values).length)
        if (verdict.get(key)) {
          requireParentGrants(p.target, p.fields, p.references, values)
          continue
        }
        if (out[i]) { out[i].hidden.add(p.relation); continue }
        const archived = await isArchivedParent(tbl, p.target, Object.fromEntries(p.references.map((r, j) => [r, values[j]])))
        out[i] = parentRefusal(p.relation, p.fields, values, p.target, archived)
        Object.defineProperty(out[i], 'hidden', { value: new Set([p.relation]), enumerable: false })
      }
    }
    return out
  }

  // checkCreatePolicy, with one answer for a parent the create names. Under row
  // tenancy a child scoped through its parent is denied when that parent is not
  // in the caller's tenant, which a missing row and another tenant's both are,
  // and a private one in the caller's own tenant is not. RETURNS that refusal,
  // for the caller to throw where hiddenParents' lands: thrown here, before
  // validation and ahead of earlier rows of a batch, a payload that also fails
  // validation told a missing parent from a hidden one (FJS-1704). `hidden` is
  // hiddenParents' refusal for the row, whose parents the policy reads as missing.
  function checkCreate(row, hidden) {
    const v = checkCreatePolicy(modelName, row, ctx, hidden?.hidden)
    if (!v) return
    const p = _parentKeys.find(k => k.relation === v.parent)
    if (!p) throw new AccessDeniedError(v.message, { model: modelName, operation: 'create' })
    return parentRefusal(p.relation, p.fields, p.fields.map(f => row?.[f]), p.target)
  }

  // Two parent refusals for one row answer as the relation hiddenParents would
  // have met first, whichever of the two found it.
  function firstRefusal(a, b) {
    if (!a || !b) return a ?? b
    const at = r => _parentKeys.findIndex(k => k.relation === r.relation)
    return at(b) < at(a) ? b : a
  }

  // ── a delete a child still refers to (FJS-1454) ────────────────────────────
  //
  // The refusing child may sit under a cascade, so the walk follows every
  // Cascade relation from `rows` and stops at the first child whose relation
  // does not let go of its parent. Run after the refused DELETE rolled back.
  //
  // The walk is a system lookup, so every blocker is kept and
  // `nameBlockerForCaller` picks the one this caller may be told about.
  function asRestrictedDelete(err, rows, from = modelName) {
    if (!isForeignKeyFailure(err) || err instanceof ForeignKeyError) return err
    try {
      let frontier = [[from, rows]]
      const seen = new Set()
      const blockers = []
      while (frontier.length) {
        const next = []
        for (const [parent, parentRows] of frontier) {
          for (const rel of Object.values(ctx.shapes[parent].relations)) {
            if (rel.kind !== 'hasMany' || rel.onDelete === 'SetNull' || rel.onDelete === 'SetDefault') continue
            const sink = ctx.cascadeSinkFor?.(rel.targetModel)
            if (!sink) continue
            const keys = tuplesOf(parentRows, rel.referencedKeys)
            if (!keys.length) continue
            const found = sink.rowsWhere(rel.foreignKeys, keys)
              .filter(r => !seen.has(`${rel.targetModel}\0${r[sink.idField]}`))
            if (!found.length) continue
            if (rel.onDelete !== 'Cascade') {
              blockers.push({ model: rel.targetModel, idField: sink.idField, ids: found.map(r => r[sink.idField]) })
              continue
            }
            for (const r of found) seen.add(`${rel.targetModel}\0${r[sink.idField]}`)
            next.push([rel.targetModel, found])
          }
        }
        frontier = next
      }
      if (blockers.length) {
        const out = new ForeignKeyError(modelName, { child: { model: blockers[0].model, id: blockers[0].ids[0] } })
        Object.defineProperty(out, 'blockers', { value: blockers, enumerable: false })
        return out
      }
    } catch { return err }
    return new ForeignKeyError(modelName)
  }

  // A model whose `@@gate` locks delete (9) is append-only, and a parent's
  // Cascade is SQLite removing its rows past the gate. The DELETE is refused as
  // a Restrict child would refuse it, whoever asks, asSystem() included
  // (`FJS-D1281`). The model walk is static and is done once; the row walk runs
  // only when a locked model sits under a Cascade chain from this one.
  let _lockedBelow = null
  function lockedBelowCascade() {
    if (_lockedBelow) return _lockedBelow
    const locked = new Set()
    if (ctx.gateFor) {
      const seen = new Set([modelName])
      const queue = [modelName]
      while (queue.length) {
        for (const rel of Object.values(ctx.shapes[queue.shift()].relations)) {
          if (rel.kind !== 'hasMany' || rel.onDelete !== 'Cascade' || seen.has(rel.targetModel)) continue
          seen.add(rel.targetModel)
          queue.push(rel.targetModel)
          if (ctx.gateFor(rel.targetModel, 'delete') === 9) locked.add(rel.targetModel)
        }
      }
    }
    return (_lockedBelow = locked)
  }

  function refuseLockedCascade(where) {
    if (!lockedBelowCascade().size) return
    const sel = selectWhere(where)
    const rows = readAll(readDb.query(sel.sql).all(...sel.params))
    const blockers = []
    const seen = new Set()
    let frontier = [[modelName, rows]]
    while (frontier.length) {
      const next = []
      for (const [parent, parentRows] of frontier) {
        for (const rel of Object.values(ctx.shapes[parent].relations)) {
          if (rel.kind !== 'hasMany' || rel.onDelete !== 'Cascade') continue
          const sink = ctx.cascadeSinkFor?.(rel.targetModel)
          if (!sink) continue
          const keys = tuplesOf(parentRows, rel.referencedKeys)
          if (!keys.length) continue
          const found = sink.rowsWhere(rel.foreignKeys, keys)
            .filter(r => !seen.has(`${rel.targetModel}\0${r[sink.idField]}`))
          if (!found.length) continue
          for (const r of found) seen.add(`${rel.targetModel}\0${r[sink.idField]}`)
          if (_lockedBelow.has(rel.targetModel)) blockers.push({ model: rel.targetModel, idField: sink.idField, ids: found.map(r => r[sink.idField]) })
          next.push([rel.targetModel, found])
        }
      }
      frontier = next
    }
    if (!blockers.length) return
    const out = new ForeignKeyError(modelName, { child: { model: blockers[0].model, id: blockers[0].ids[0] } })
    Object.defineProperty(out, 'blockers', { value: blockers, enumerable: false })
    throw out
  }

  // The same answer for a statement that deleted this table's rows by a WHERE
  // (deleteMany, a hard remove): the refused DELETE rolled back, so the rows it
  // named are still there to be read.
  function refusedDelete(err, whereSql, params) {
    if (!isForeignKeyFailure(err) || err instanceof ForeignKeyError) return err
    let rows
    try { rows = readAll(writeDb.query(`SELECT * FROM "${tableName}"${whereSql ? ` WHERE ${whereSql}` : ''}`).all(...params)) }
    catch { return err }
    return asRestrictedDelete(err, rows)
  }

  // A `@hardDelete` child removed by a soft delete's cascade. The refusing row
  // sits under the CHILD, so the walk starts from the child rows.
  function refusedChildDelete(err, childModel, childTable, foreignKeys, keys) {
    if (!isForeignKeyFailure(err) || err instanceof ForeignKeyError) return err
    let rows
    const binds = []
    try { rows = writeDb.query(`SELECT * FROM "${childTable}" WHERE ${keyIn(foreignKeys.map(f => `"${f}"`), keys, binds)}`).all(...binds) }
    catch { return err }
    return asRestrictedDelete(err, rows, childModel)
  }

  // The first blocking child the caller can read is named by id; when every
  // one is hidden, only its model is — a model is schema, an id is data. That
  // the delete is refused at all cannot be hidden under Restrict.
  async function nameBlockerForCaller(err) {
    const blockers = err?.blockers
    if (!blockers || ctx.isSystem) return err
    for (const { model, idField, ids } of blockers) {
      const tbl = ctx.tables?.[modelToAccessor(model)]
      if (!tbl) continue
      for (let i = 0; i < ids.length; i += 500) {
        let hit = null
        try { hit = await tbl.findFirst({ where: { [idField]: { in: ids.slice(i, i + 500) } }, select: { [idField]: true } }) }
        catch (e) { if (!(e instanceof AccessDeniedError)) throw e }
        if (hit) return new ForeignKeyError(modelName, { child: { model, id: hit[idField] } })
      }
    }
    return new ForeignKeyError(modelName, { child: { model: blockers[0].model } })
  }

  // ── which row of a batch ────────────────────────────────────────────────────
  //
  // A batch write throws SQLite's own message, which names the COLUMN and never
  // the row: `UNIQUE constraint failed: post.slug` against a 500-row import
  // leaves bisecting the batch by hand as the only way to find the row that did
  // it. The loop knows the index, so the error says it — as `data[i]`, the
  // subscript the caller can go and look at, not a 1-based ordinal (FJS-207).
  //
  // The whole batch is inside one transaction, so nothing landed; saying so is
  // the difference between re-running the import and hunting for partial rows.
  //
  // A unique conflict also names the values that collided, redacted the way the
  // audit trail redacts them — a @unique column may be @encrypted, where the
  // stored value is ciphertext and belongs in an error message even less than a
  // plaintext would.
  //
  // The error is annotated rather than replaced: its class is what carries the
  // status and `retryable` past the boundary, and a batch wrapper would flatten
  // SoftDeletedUniqueError's 409 into an unclassified 500.
  function asBatchRowError(err, index, total, row) {
    if (!err || typeof err !== 'object' || err.batchIndex != null) return err
    err.batchIndex = index
    err.batchSize  = total
    // A translated conflict already names the columns and their values, so
    // repeating them here gives one sentence saying it twice.
    const cols  = err.fields ? null : isUniqueConflict(err) ? uniqueConflictColumns(err)?.map(_fieldOf) : null
    const named = cols?.length && row
      ? ` (${cols.map(c => `${c} = ${JSON.stringify(redactValue(c, row[c] ?? null))}`).join(', ')})`
      : ''
    // Litestone's own errors already open with the model name; repeating it
    // gives `Post: data[1] … Post: a soft-deleted row …`.
    const rest = err.message?.startsWith(`${modelName}: `)
      ? err.message.slice(modelName.length + 2)
      : err.message
    try {
      err.message = `${modelName}: data[${index}] of ${total}${named} failed — nothing in the batch was written. ${rest}`
    } catch { /* a frozen message keeps the properties above */ }
    return err
  }

  return {
    asConstraintError, parentRefusal, movesOnto, requireParentGrants, isArchivedParent, hiddenParents,
    checkCreate, firstRefusal, refuseLockedCascade, refusedDelete, refusedChildDelete, nameBlockerForCaller,
    asBatchRowError,
  }
}
