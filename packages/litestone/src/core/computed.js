// computed.js — `@computed` fields: the functions an app passes as
// `createClient({ computed })`, normalized once, and applied to each row read.

import { resolve, pathToFileURL } from '#host'

// ─── Extensions loading ───────────────────────────────────────────────────────

export async function loadComputedFields(computedInput) {
  if (!computedInput) return {}
  // Accept an object directly — { modelName: { fieldName: fn } }
  if (typeof computedInput === 'object') return computedInput
  // Otherwise treat as a file path
  const abs = resolve(computedInput)
  try {
    // `pathToFileURL` rather than `file://` + the path: a relative path makes
    // its first segment the URL's HOSTNAME, which is a different file or none.
    // `@vite-ignore` because a bundler cannot analyze a computed specifier and
    // warns about this one in every app whose graph reaches this file — the
    // path form is a server's, and a browser refuses it at `pathToFileURL`.
    const mod = await import(/* @vite-ignore */ pathToFileURL(abs).href)
    return mod.default ?? mod
  } catch (e) {
    throw new Error(`Failed to load computed functions file: ${abs}\n  ${e.message}`)
  }
}

// A computed field either declares what it reads or it does not, and the two
// are stored the same way so nothing downstream has to ask which form was
// written:
//
//   fullName: row => …                                    → needs: null
//   initials: { needs: ['firstName'], compute: row => … }  → needs: ['firstName']
//
// `needs: null` means *fetch everything* — the original behavior, and still
// the right answer for a fn whose inputs cannot be listed.
//
// Keys beginning with `$` are not fields ($validate is a cross-field validator
// array) and travel through untouched.
export function normalizeComputed(computedFns, schema) {
  if (!computedFns) return {}

  const readableFields = {}
  for (const model of schema.models) {
    readableFields[model.name] = new Set(
      model.fields
        .filter(f => f.type.kind !== 'relation' && f.type.kind !== 'implicitM2M' &&
                     !f.attributes.some(a => a.kind === 'computed'))
        .map(f => f.name)
    )
  }

  const out = {}
  for (const [modelName, fields] of Object.entries(computedFns)) {
    if (!fields || typeof fields !== 'object') { out[modelName] = fields; continue }
    const bag = out[modelName] = {}

    for (const [field, spec] of Object.entries(fields)) {
      if (field.startsWith('$')) { bag[field] = spec; continue }

      if (typeof spec === 'function') { bag[field] = { compute: spec, needs: null }; continue }

      if (!spec || typeof spec !== 'object' || typeof spec.compute !== 'function')
        throw new Error(
          `Computed field '${modelName}.${field}' must be a function, or ` +
          `{ needs: [...], compute: fn } — got ${spec === null ? 'null' : typeof spec}`
        )

      if (!Array.isArray(spec.needs))
        throw new Error(`Computed field '${modelName}.${field}': 'needs' must be an array of field names`)

      // A name that is not a column of this model would be silently undefined
      // at read time, which is the whole failure this declaration exists to
      // stop — so it is refused here, where the list is written.
      const known = readableFields[modelName]
      if (known) {
        const bad = spec.needs.filter(n => !known.has(n))
        if (bad.length)
          throw new Error(
            `Computed field '${modelName}.${field}': needs ${bad.map(n => `'${n}'`).join(', ')}, ` +
            `which ${bad.length > 1 ? 'are' : 'is'} not a readable field of ${modelName}. ` +
            `A computed field may read stored columns and @from fields, not relations ` +
            `or other computed fields`
          )
      }

      const needs = [...spec.needs]
      bag[field] = { compute: spec.compute, needs, handler: needsHandler(modelName, field, needs) }
    }
  }
  return out
}

// The row a `needs` fn receives carries exactly what it declared. Reading
// anything else throws instead of answering undefined — without that, adding a
// line to the fn and forgetting the list converts a working computed field into
// a silently wrong one, which is strictly worse than fetching every column.
//
// `in` is left alone so feature-detection still works, and the handler is built
// once per field rather than once per row.
function needsHandler(modelName, field, needs) {
  return {
    get(target, key) {
      if (typeof key === 'symbol' || key === 'then' || key in target) return target[key]
      throw new Error(
        `Computed field '${modelName}.${field}' read '${String(key)}', which it does not declare. ` +
        `needs: [${needs.map(n => `'${n}'`).join(', ')}]`
      )
    },
  }
}

// ─── Computed fields ──────────────────────────────────────────────────────────

// `wanted` is the caller's select, or null for "the whole row". A computed fn
// outside it is not run at all: its value would be trimmed away a moment later,
// and running it over a row narrowed by that same select is how a fn ends up
// computing from undefined.
export function applyComputed(row, modelName, computedFns, ctx, wanted = null) {
  if (!row) return row
  const fns = computedFns?.[modelName]
  if (!fns) return row
  const out = { ...row }
  for (const field in fns) {
    const plan = fns[field]
    if (typeof plan?.compute !== 'function') continue
    if (wanted && !wanted.has(field)) continue
    out[field] = plan.compute(plan.needs ? needsView(out, plan) : out, ctx)
  }
  return out
}

function needsView(row, plan) {
  const view = {}
  for (const name of plan.needs) view[name] = row[name]
  return new Proxy(view, plan.handler)
}
