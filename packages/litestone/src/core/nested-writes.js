// nested-writes.js — the relation half of one row's write: the nested ops a
// create or update carries under a relation name, split from the scalar
// fields and run around the parent's own statement. belongsTo ops run BEFORE
// it and hand back the foreign keys to inject; hasMany and many-to-many ops
// run AFTER it, with the parent's key in hand. A bulk verb refuses them by
// name, having no parent id to hang children on (`FJS-2040`).
//
// Built once per table by `makeTable`, which hands it the write connection
// and the parent-refusal helpers, and takes back the four names the verbs call.

import { isNestedWrite } from '../plugins/reach.js'
import { modelToAccessor } from './ddl.js'
import { ident } from './query.js'
import { ValidationError } from './validate.js'

// The seam a many-to-many write announces its OTHER side through:
// `tbl[JOINED](key)`. A join row is the only thing a connect writes, so the
// joined row's own columns never change and no table event names it — a live
// list filtered by that relation kept the row until a reload (`FJS-2013`).
export const JOINED = Symbol.for('litestone.joined')

export function makeNestedWrites(shape, ctx, deps) {
  const { modelName } = shape
  const { writeDb, idField, parentRefusal, requireParentGrants, isArchivedParent } = deps

  // ── Nested writes ──────────────────────────────────────────────────────────
  // Split data into scalar fields and nested relation ops.
  //
  // Supported on create():
  //   belongsTo (this table holds the FK):
  //     { connect: { id } }                  — use existing parent, inject FK
  //     { create: { ...data } }              — create parent first, inject FK
  //     { connectOrCreate: { where, create } } — find or create parent
  //
  //   hasMany (child table holds the FK):
  //     { create: row | [rows] }             — create children with FK injected
  //     { connect: where | [wheres] }        — update children FK to this PK
  //
  // Supported on update():
  //   belongsTo: connect, create, connectOrCreate
  //   hasMany:   create, connect, disconnect, delete, update

  // `hasNested` is a BOOLEAN and not something a caller derives, because `nested`
  // is an object and `nested.length` is `undefined` rather than an error — which
  // is falsy, so three guards spelled that way all read *there are no nested
  // writes* and all three were wrong. It cost a create with `select: false`
  // every one of its children, silently (`FJS-615`).
  function extractNestedWrites(data) {
    if (!data) return { scalar: {}, nested: {}, hasNested: false }
    const rels = shape.relations
    const scalar = {}, nested = {}
    for (const [k, v] of Object.entries(data)) {
      if (k in rels && isNestedWrite(v)) {
        nested[k] = v
      } else {
        scalar[k] = v
      }
    }
    return { scalar, nested, hasNested: Object.keys(nested).length > 0 }
  }

  // A bulk verb writes one statement per row shape and has no parent id to hang
  // children on. Left to the column checks, `{ connect: [...] }` on a relation
  // was reported as "messages: must be an array" -- a complaint about a value
  // the caller meant as a nested write (FJS-2040).
  function refuseBulkNested(rows, verb) {
    const named = new Set()
    for (const row of rows) for (const k of Object.keys(extractNestedWrites(row).nested)) named.add(k)
    if (named.size) throw new ValidationError([...named].map(k => ({
      path: [k],
      message: `${verb} takes no nested writes. Write ${k} with ${verb === 'updateMany' ? 'update()' : 'create()'}, one row at a time.`,
    })), { model: modelName, operation: verb === 'updateMany' ? 'update' : 'create' })
  }

  // belongsTo ops — run BEFORE parent insert/update, return FK fields to inject
  async function processBelongsToNested(nested) {
    const extra = {}
    const rels = shape.relations
    for (const [fieldName, ops] of Object.entries(nested)) {
      const rel = rels[fieldName]
      if (!rel || rel.kind !== 'belongsTo') continue
      // ctx.tables is keyed by accessor (camelCase singular), not model name.
      const tbl = ctx.tables?.[modelToAccessor(rel.targetModel)]
      if (!tbl) continue

      const { foreignKeys: fks, referencedKeys: refs } = rel
      // Every column of the key comes from the parent, so a composite one
      // cannot keep a leading column the payload named and point elsewhere.
      const keyFrom = (target) => { for (let i = 0; i < fks.length; i++) extra[fks[i]] = target[refs[i]] }
      const grantsOf = (target) => requireParentGrants(rel.targetModel, fks, refs, refs.map(r => target[r]))
      if (ops.connect) {
        const target = await tbl.findFirst({ where: ops.connect })
        // The same answer the foreign key itself gets, hidden or missing.
        if (!target) {
          const named = Object.keys(ops.connect)
          const byKey = named.length === refs.length && refs.every(r => r in ops.connect)
          throw byKey
            ? parentRefusal(fieldName, fks, refs.map(r => ops.connect[r]), rel.targetModel,
                await isArchivedParent(tbl, rel.targetModel, ops.connect))
            : parentRefusal(fieldName, fks.length === 1 ? fks : [fieldName], [ops.connect], rel.targetModel)
        }
        grantsOf(target)
        keyFrom(target)
      } else if (ops.create) {
        keyFrom(await tbl.create({ data: ops.create }))
      } else if (ops.connectOrCreate) {
        const { where: coWhere, create: coCreate } = ops.connectOrCreate
        let target = await tbl.findFirst({ where: coWhere })
        if (target) grantsOf(target)
        else target = await tbl.create({ data: coCreate })
        keyFrom(target)
      }
    }
    return extra
  }

  // hasMany ops — run AFTER parent insert/update
  async function processHasManyNested(nested, parentPk, parentRow) {
    const rels = shape.relations
    // Pre-resolve co-FK fields keyed by child model — used below to copy
    // parent's tenantId/accountId/etc into child rows during nested writes.
    const coFkForParent = shape.coFk

    // Helper: merge parent's co-FK values into a child create payload.
    // Strict by default (parent wins), opt-out via allowChildFkOverride.
    function applyCoFk(childModel, childRow) {
      const cols = coFkForParent[childModel]
      if (!cols || !cols.length || !parentRow) return childRow
      const result = { ...childRow }
      for (const col of cols) {
        // Only propagate when parent has a real (non-null) value.
        if (parentRow[col] == null) continue
        if (ctx.allowChildFkOverride) {
          // Permissive: child's explicit value wins; only fill if missing/null.
          if (result[col] == null) result[col] = parentRow[col]
        } else {
          // Strict (default): always overwrite. This is the safe choice — a
          // child carrying a different tenantId/accountId than its parent is
          // referentially inconsistent and should never silently happen.
          result[col] = parentRow[col]
        }
      }
      return result
    }

    for (const [fieldName, ops] of Object.entries(nested)) {
      const rel = rels[fieldName]
      if (!rel) continue
      // ctx.tables is keyed by accessor (camelCase singular), not model name.
      const tbl = ctx.tables?.[modelToAccessor(rel.targetModel)]
      if (!tbl) continue

      if (rel.kind === 'manyToMany') {
        // ── Implicit m2m ops — manipulate join table directly ──────────────
        const jt = rel.joinTable
        const sk = rel.selfKey    // join col for this model
        const tk = rel.targetKey  // join col for target model
        const tpk = rel.targetPk ?? 'id'   // the target's @id COLUMN, not the word "id"
        // Target keys whose membership in this relation changed. A created or
        // deleted target announces itself; one only joined or left has no write
        // of its own, so it is announced after the join rows land.
        const joined = new Set()
        // A join row hands whichever side holds a `Capability[]` to the other,
        // so either side's list is a grant here.
        const requireJoinGrants = (target) => {
          requireParentGrants(rel.targetModel, [fieldName], [tpk], [keyOf(target)])
          requireParentGrants(modelName, [fieldName], [idField], [parentPk])
        }

        // A join row is written with INSERT OR IGNORE so connecting twice is
        // idempotent — which also means a NULL key is ignored rather than
        // refused. Reading the target's key by the literal name `id` therefore
        // produced a connect that reported success and wrote nothing on any
        // model keyed by something else. Refuse the undefined instead.
        const keyOf = (row) => {
          const v = row?.[tpk]
          if (v == null)
            throw new Error(`m2m on "${fieldName}": "${rel.targetModel}" row has no "${tpk}" to join on`)
          return v
        }

        if (ops.set) {
          // Replace the relation FIRST, so a create or connect beside it adds to
          // the new set rather than being deleted by it.
          const before = new Set(writeDb.query(`SELECT ${ident(tk).sql} AS k FROM ${ident(jt).sql} WHERE ${ident(sk).sql} = ?`).all(parentPk).map(r => r.k))
          writeDb.run(`DELETE FROM "${jt}" WHERE "${sk}" = ?`, parentPk)
          const wheres = Array.isArray(ops.set) ? ops.set : [ops.set]
          const after = new Set()
          for (const where of wheres) {
            const target = await tbl.findFirst({ where })
            if (!target) throw new Error(`m2m set on "${fieldName}": no "${rel.targetModel}" found matching ${JSON.stringify(where)}`)
            requireJoinGrants(target)
            writeDb.run(`INSERT OR IGNORE INTO "${jt}" ("${sk}", "${tk}") VALUES (?, ?)`, parentPk, keyOf(target))
            after.add(keyOf(target))
          }
          // Only a row that crossed the relation's edge changed membership.
          for (const k of before) if (!after.has(k)) joined.add(k)
          for (const k of after) if (!before.has(k)) joined.add(k)
        }
        if (ops.create) {
          const rows = Array.isArray(ops.create) ? ops.create : [ops.create]
          for (const row of rows) {
            const created = await tbl.create({ data: applyCoFk(rel.targetModel, row) })
            writeDb.run(`INSERT OR IGNORE INTO "${jt}" ("${sk}", "${tk}") VALUES (?, ?)`, parentPk, keyOf(created))
          }
        }
        if (ops.connect) {
          const wheres = Array.isArray(ops.connect) ? ops.connect : [ops.connect]
          for (const where of wheres) {
            const target = await tbl.findFirst({ where })
            if (!target) throw new Error(`m2m connect on "${fieldName}": no "${rel.targetModel}" found`)
            requireJoinGrants(target)
            const res = writeDb.run(`INSERT OR IGNORE INTO "${jt}" ("${sk}", "${tk}") VALUES (?, ?)`, parentPk, keyOf(target))
            if (res.changes) joined.add(keyOf(target))
          }
        }
        if (ops.disconnect) {
          const wheres = Array.isArray(ops.disconnect) ? ops.disconnect : [ops.disconnect]
          for (const where of wheres) {
            const target = await tbl.findFirst({ where })
            if (!target) continue
            const res = writeDb.run(`DELETE FROM "${jt}" WHERE "${sk}" = ? AND "${tk}" = ?`, parentPk, keyOf(target))
            if (res.changes) joined.add(keyOf(target))
          }
        }
        if (ops.delete) {
          const wheres = Array.isArray(ops.delete) ? ops.delete : [ops.delete]
          for (const where of wheres) {
            const target = await tbl.findFirst({ where })
            if (!target) continue
            writeDb.run(`DELETE FROM "${jt}" WHERE "${sk}" = ? AND "${tk}" = ?`, parentPk, keyOf(target))
            await tbl.delete({ where: { [tpk]: keyOf(target) } })
          }
        }
        for (const key of joined) await tbl[JOINED](key)
        continue
      }

      // ── Standard hasMany ops ───────────────────────────────────────────────
      if (rel.kind !== 'hasMany') continue
      // Every column of the child's key comes from this row: a composite one
      // filled from the primary key alone points at nothing, or at a sibling.
      const fk = Object.fromEntries(rel.foreignKeys.map((f, i) => {
        const ref = rel.referencedKeys[i]
        return [f, parentRow?.[ref] ?? (ref === idField ? parentPk : undefined)]
      }))
      // A disconnect clears what may be cleared. A column the key shares with
      // the row's scope stays, and a key with no nullable column is refused by
      // name as required.
      const childFields = ctx.shapes[rel.targetModel].model.fields
      const clearable = rel.foreignKeys.filter(f => childFields.find(x => x.name === f)?.type.optional)
      const cleared = Object.fromEntries((clearable.length ? clearable : rel.foreignKeys).map(f => [f, null]))

      if (ops.create) {
        const rows = Array.isArray(ops.create) ? ops.create : [ops.create]
        for (const row of rows) await tbl.create({ data: { ...applyCoFk(rel.targetModel, row), ...fk } })
      }
      if (ops.connect) {
        const wheres = Array.isArray(ops.connect) ? ops.connect : [ops.connect]
        for (const where of wheres) await tbl.update({ where, data: fk })
      }
      if (ops.disconnect) {
        const wheres = Array.isArray(ops.disconnect) ? ops.disconnect : [ops.disconnect]
        for (const where of wheres) await tbl.update({ where, data: cleared })
      }
      if (ops.delete) {
        const wheres = Array.isArray(ops.delete) ? ops.delete : [ops.delete]
        for (const where of wheres) await tbl.delete({ where })
      }
      if (ops.update) {
        const updates = Array.isArray(ops.update) ? ops.update : [ops.update]
        for (const { where, data } of updates) await tbl.update({ where, data })
      }
    }
  }

  return { extractNestedWrites, refuseBulkNested, processBelongsToNested, processHasManyNested }
}
