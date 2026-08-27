// reach.js — which models does this call touch, beyond the one it names?
//
// A rule declared on a model has to fire for every model the CALL reaches, not
// just the one the caller addressed: `team.findMany({ include: { secrets: true } })`
// is a read of Vault, and `create({ data: { author: { create: … } } })` is a create
// on User. Both walks are a property of the arguments and the relation graph, so
// they belong to neither rule that asks — the gate and the capability grid ask the
// same question and must not answer it twice.

// ─── Nested write preflight ───────────────────────────────────────────────────

const OP_KEYS = new Set(['create', 'connect', 'connectOrCreate', 'disconnect', 'delete', 'update'])

export function collectNestedOps(data, tableName, relationMap, ops = []) {
  if (!data || typeof data !== 'object') return ops
  const rels = relationMap[tableName] ?? {}

  for (const [key, val] of Object.entries(data)) {
    if (!(key in rels) || !val || typeof val !== 'object') continue
    if (!Object.keys(val).some(k => OP_KEYS.has(k))) continue
    const rel = rels[key]
    const target = rel.targetModel

    if (val.create)          ops.push({ model: target, op: 'create' })
    if (val.connect)         ops.push({ model: target, op: 'update' })
    if (val.disconnect)      ops.push({ model: target, op: 'update' })
    if (val.delete)          ops.push({ model: target, op: 'delete' })
    if (val.update)          ops.push({ model: target, op: 'update' })
    if (val.connectOrCreate) {
      ops.push({ model: target, op: 'create' })
      ops.push({ model: target, op: 'update' })
    }

    if (val.create) {
      const rows = Array.isArray(val.create) ? val.create : [val.create]
      for (const row of rows) collectNestedOps(row, target, relationMap, ops)
    }
  }
  return ops
}

// ─── Nested read preflight ────────────────────────────────────────────────────
//
// A relation reached through `include:` is a read of the target model, and it
// used to be a read nothing graded. Includes are resolved by their own SQL
// below the query pipeline, so `@@gate` — which fires in onBeforeRead for the
// model being addressed — never saw them: a caller refused `Vault.findMany`
// outright could ask for `team.findMany({ include: { secrets: true } })` and
// get every row of the model they had just been refused.
//
// The walk follows both spellings, because a relation can be named under
// `select:` as well as `include:`, and `_count` counts rows of the target,
// which is a read of it too. Deduped by model: the answer is per model, so a
// tree that mentions the same one ten times asks once.

function pushRelationTargets(spec, model, relationMap, out, seenPaths) {
  if (!spec || typeof spec !== 'object') return out

  const rels = relationMap[model] ?? {}

  for (const [key, val] of Object.entries(spec)) {
    if (!val) continue

    if (key === '_count') {
      const counted = val === true ? null : (val.select ?? val)
      if (counted === null) {
        for (const rel of Object.values(rels))
          if (rel.kind === 'hasMany' || rel.kind === 'manyToMany') out.add(rel.targetModel)
        continue
      }
      if (typeof counted !== 'object') continue
      for (const [alias, cs] of Object.entries(counted)) {
        if (!cs) continue
        const relName = (typeof cs === 'object' && cs.relation) ? cs.relation : alias
        const rel     = rels[relName]
        if (rel) out.add(rel.targetModel)
      }
      continue
    }

    const rel = rels[key]
    if (!rel) continue
    out.add(rel.targetModel)

    if (typeof val !== 'object') continue

    // A cycle in the schema (Team → members → team) would otherwise recurse
    // forever on a self-referential include; the pair is what repeats.
    const path = `${model}.${key}`
    if (seenPaths.has(path)) continue
    seenPaths.add(path)

    pushRelationTargets(val.include, rel.targetModel, relationMap, out, seenPaths)
    pushRelationTargets(val.select,  rel.targetModel, relationMap, out, seenPaths)
  }

  return out
}

export function collectIncludedModels(args, model, relationMap) {
  if (!args) return []
  const out   = new Set()
  const paths = new Set()
  pushRelationTargets(args.include, model, relationMap, out, paths)
  pushRelationTargets(args.select,  model, relationMap, out, paths)
  out.delete(model)
  return [...out]
}

