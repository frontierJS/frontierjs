// eject.js — promote an @edge / @scoped field group into a real model.
//
// The side table backing an edge is byte-for-byte the explicit join model you'd
// hand-write (D5), so ejecting is a physical RENAME + a schema edit, never a data
// migration. This produces the plan: the new model's .lite text, the rename SQL,
// the fields to remove, and the relations to rewire. It does NOT rewrite the
// user's .lite (that would mean parsing/editing their source) — it hands them the
// exact edits. applyEject() runs the one-line rename against a live DB.

import { buildEdgeMap, modelToTableName } from '../core/ddl.js'

const pascal     = s => s.split(/[_\s]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('')
const lowerFirst = s => s.charAt(0).toLowerCase() + s.slice(1)

function renderType(t) {
  return `${t.name}${t.array ? '[]' : ''}${t.optional ? '?' : ''}`
}

function renderDefault(defAttr) {
  if (!defAttr) return ''
  const v = defAttr.value
  if (v == null) return ''
  switch (v.kind) {
    case 'boolean': return ` @default(${v.value ? 'true' : 'false'})`
    case 'string':  return ` @default("${v.value}")`
    case 'number':
    case 'literal': return ` @default(${typeof v.value === 'string' ? `"${v.value}"` : v.value})`
    case 'now':     return ' @default(now())'
    case 'uuid':    return ' @default(uuid())'
    case 'ulid':    return ' @default(ulid())'
    case 'cuid':    return ' @default(cuid())'
    case 'enum':    return ` @default(${v.value})`
    default:        return ''   // exotic default — user reviews
  }
}

/**
 * Compute the eject plan for an edge field group.
 * @param schema  parsed schema (parseResult.schema)
 * @param target  "Model.field" or "Model.namespace"
 */
export function ejectEdge(schema, target, { pluralize = false } = {}) {
  const [modelName, fieldOrNs] = String(target).split('.')
  if (!modelName || !fieldOrNs)
    throw new Error(`eject target must be "Model.field" or "Model.namespace", got "${target}"`)
  const hostModel = schema.models.find(m => m.name === modelName)
  if (!hostModel) throw new Error(`Model "${modelName}" not found`)

  const edges = buildEdgeMap(schema, pluralize)[modelName] ?? {}
  const targetDesc = edges[fieldOrNs] ?? Object.values(edges).find(d => d.as === fieldOrNs)
  if (!targetDesc)
    throw new Error(`No @edge/@scoped field or namespace "${fieldOrNs}" on model "${modelName}"`)

  // The whole group sharing this side table ejects together.
  const group = Object.values(edges).filter(d => d.table === targetDesc.table)
  const { table: oldTable, hostCol, dimCol, ref, storage } = targetDesc

  const newModelName = pascal(oldTable.replace(/^_/, ''))   // _project_task → ProjectTask
  const newTable     = oldTable.replace(/^_/, '')           // → project_task (== snake(model))

  const hostEntry = { col: hostCol, model: modelName, rel: lowerFirst(modelName) }
  const dimEntry  = { col: dimCol,  model: ref,       rel: lowerFirst(ref) }
  // Match the physical column order so a later autoMigrate sees the table in sync:
  //   decorate join → colA/colB by sorted model name; create-own → host then dim.
  const keyCols = storage === 'decorate'
    ? ([modelName, ref].sort()[0] === ref ? [dimEntry, hostEntry] : [hostEntry, dimEntry])
    : [hostEntry, dimEntry]

  const lines = [`model ${newModelName} {`]
  for (const k of keyCols) lines.push(`  ${k.col} Int @id`)
  for (const k of keyCols) lines.push(`  ${k.rel} ${k.model} @relation(fields: [${k.col}], references: [id], onDelete: Cascade)`)
  for (const d of group) {
    const f = hostModel.fields.find(fl => fl.name === d.field)
    lines.push(`  ${d.field} ${renderType(f.type)}${renderDefault(f?.attributes.find(a => a.kind === 'default'))}`)
  }
  lines.push('}')

  const rewire = storage === 'decorate'
    ? [
        `Replace the implicit m2m between ${modelName} and ${ref} with a relation through ${newModelName}:`,
        `  · on ${modelName}: replace "${lowerFirst(ref)}s ${ref}[]" (or your m2m field) with "${lowerFirst(ref)}Links ${newModelName}[]"`,
        `  · on ${ref}: replace "${lowerFirst(modelName)}s ${modelName}[]" with "${lowerFirst(modelName)}Links ${newModelName}[]"`,
        `Queries that traversed the m2m now go through ${newModelName}; the edge values are plain columns on it.`,
      ]
    : [`This was a create-own (@scoped) side table — no m2m to rewire. Reference ${newModelName} directly.`]

  return {
    host: modelName,
    newModelName,
    oldTable,
    newTable,
    storage,
    fields: group.map(d => d.field),
    model: lines.join('\n'),
    rename: `ALTER TABLE "${oldTable}" RENAME TO "${newTable}";`,
    removeFields: group.map(d => `${modelName}.${d.field}`),
    rewire,
  }
}

/** Run the physical rename against a live raw DB (the no-data-migration step). */
export function applyEject(rawDb, plan) {
  rawDb.run(plan.rename)
  return { renamed: `${plan.oldTable} → ${plan.newTable}` }
}

/** Human-readable plan for the CLI. */
export function formatEjectPlan(plan) {
  return [
    `Eject ${plan.host}.{${plan.fields.join(', ')}} → model ${plan.newModelName}  (${plan.storage})`,
    ``,
    `1. Add this model to your schema:`,
    ``,
    plan.model.split('\n').map(l => `   ${l}`).join('\n'),
    ``,
    `2. Remove the edge field(s) from ${plan.host}: ${plan.fields.join(', ')}`,
    ``,
    `3. ${plan.rewire.join('\n   ')}`,
    ``,
    `4. Rename the physical table (no data migration):`,
    `   ${plan.rename}`,
    `   (run automatically with --apply)`,
  ].join('\n')
}
