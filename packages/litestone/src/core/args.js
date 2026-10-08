// @ts-check
// args.js — what a verb may be passed, and the refusal when it is not.
//
// Argument names per verb, the keys a `where`, `orderBy` or aggregate may
// name, `@guarded` on the way in, and the did-you-mean each refusal carries.
// `withArgValidation` wraps every table; the collectors are also asked by
// `$checkWhere`/`$checkOrderBy` before a call exists.

import {
  centerOf, filterableKeysFor, sortableKeysFor, OPAQUE_SORT, rawClause, isRawClause, isNamedAgg, quoteIdent,
} from './query.js'
import { ValidationError } from './validate.js'
import { AccessDeniedError } from './plugin.js'
import { compileFieldPredicate, buildPolicyFilter } from './policy.js'
import { hoistedFieldRead } from './field-policy.js'

// Suggest the closest match for an unknown key from a set of valid keys.
// Used in write-data validation to give users actionable typo hints —
// "Unknown field 'emial' on User. Did you mean: email?". Levenshtein with a
// small ceiling, since field names are short and typos are usually 1–2 edits.
/** @import { ModelDef } from '../index.d.ts' */
/** @import { Ctx } from './field-policy.js' */
/** @import { Shape } from './client.js' */

/** @typedef {{ model: string, key: string }} Found  a protected name an argument reached, and on which model */
/**
 * What the walkers look for, named as the `Shape` facet that holds it: `@guarded`
 * columns, columns carrying a read predicate, or `@from` aggregates over a
 * policied target. A relation key hops to the next model through
 * `shapes[m].relations`, and the facet is read off whichever model the hop
 * lands on — one walk grades all three.
 * @typedef {'guardedKeys' | 'fieldReadKeys' | 'policiedAggregates'} ProtectedFacet
 */
/** @typedef {Record<string, any>} KeyProblem  one refusal — `key`, `reason`, `message`, and per reason more */

/** @param {string} unknown @param {Iterable<string>} allowed */
export function suggestKey(unknown, allowed) {
  if (!unknown) return null
  const lower = String(unknown).toLowerCase()
  let best = null
  let bestDist = Infinity
  for (const candidate of allowed) {
    const cand = String(candidate).toLowerCase()
    // Cheap pre-filter: skip candidates whose length differs by > 3
    if (Math.abs(cand.length - lower.length) > 3) continue
    const d = editDistance(lower, cand)
    if (d < bestDist) { bestDist = d; best = candidate }
  }
  // Threshold: allow up to 2 edits for very short names (so transposition
  // typos like "naem" → "name" qualify), scaling up to ~1/3 of the input
  // length for longer names. Also require the suggestion to keep more chars
  // than it changes — otherwise short typos like "x" match anything.
  const threshold = Math.max(2, Math.floor(lower.length / 3))
  if (bestDist > threshold) return null
  if (bestDist >= lower.length) return null
  return best
}

// A refusal has to say what WOULD have been legal, and past a certain size the
// full list stops being that. `Capability` is derived from the whole schema —
// 153 values on a real application — and a message carrying all of them is one
// nobody reads, so a large enum suggests the nearest name instead and says how
// to see the rest. The threshold is about the message, not about capabilities:
// any generated enum grows past it eventually.
const ENUM_LIST_LIMIT = 12

/** @param {Record<string, any>} meta @param {unknown} offending */
export function enumOptions(meta, offending) {
  const values = [...meta.values]
  if (values.length <= ENUM_LIST_LIMIT) return `must be one of: ${values.join(', ')}`
  const near = suggestKey(offending, values)
  return (near ? `did you mean "${near}"? ` : '') +
         `${values.length} values are legal — db.$enums.${meta.enumName} is the list`
}

// ─── Query-arg validation ─────────────────────────────────────────────────────
// An unknown where-field REJECTS, on a read as on a write. take/skip are
// rejected everywhere with a pointer to limit/offset. AND/OR/NOT are descended
// into; relation sub-filters are not (their keys belong to the related model).

// Collect the same problems checkWhereKeys reports, without throwing or running
// the query.
//
// It exists because a refusal and a MESSAGE are two different jobs and only one
// of them belongs here: over HTTP the caller needs a 400 naming the key and the
// suggestion, where a thrown ValidationError arrives as whatever the boundary
// above makes of it. Litestone keeps the one definition of "is this a valid
// where key" — the typo hint and the AND/OR/NOT descent included — rather than
// Junction growing a second one that drifts. Returns [] when the where is fine,
// so `if (problems.length)` reads naturally at the call site.

// ─── a distance order is not a sort of the document ──────────────────────────
//
// A `@point` column is a `Json` column, so `sortableKeysFor` calls it `opaque`
// and is right to: its stored text is a serialization, and ordering by that
// orders rows by whichever key serialized first. `{ site: { near: … } }` is the
// one shape under that key which is NOT sorting the document, so it is lifted
// out before the guard sees it.
//
// One owner, because there are two guards and they are reached from opposite
// ends: `checkOrderBy` grades a call this client is about to run, and
// `$checkOrderBy` answers junction's `autoSort` BEFORE the call is made. The
// second was missed when the first was written, so every distance-ordered list
// over HTTP was a 400 naming the column as unsortable — with the same query
// working perfectly through the client (`FJS-D321`'s ordering, refused at the
// API boundary alone).

/** `{ field → the @point attribute }` for a model, empty for one with none. */
/** @param {ModelDef} model */
export function pointFieldsOf(model) {
  return new Map(
    (model?.fields ?? [])
      .map(f => [f.name, f.attributes?.find(a => a.kind === 'point')])
      .filter(([, pt]) => pt))
}

/** Is this orderBy entry a distance order rather than a sort of the column? */
/** @param {ReturnType<typeof pointFieldsOf>} points @param {string} key @param {unknown} val */
function isNearOrderFor(points, key, val) {
  return points.has(key) && val !== null && typeof val === 'object' && !Array.isArray(val) && val.near != null
}

/**
 * Split an `orderBy` into the entries an ordinary sort guard should grade and
 * the first thing wrong with a distance order, if anything is.
 *
 * `kept` keeps the caller's own shape per item — an item whose every key was a
 * near-order contributes nothing, so an orderBy that is ONLY a distance order
 * leaves an empty list and the guard has nothing to say about it.
 */
/** @param {ReturnType<typeof pointFieldsOf>} points @param {any} orderBy */
export function liftNearOrders(points, orderBy) {
  const items = Array.isArray(orderBy) ? orderBy : [orderBy]
  const kept  = []
  for (const item of items) {
    if (!item || typeof item !== 'object') { kept.push(item); continue }
    const rest = {}
    for (const [key, val] of Object.entries(item)) {
      if (!isNearOrderFor(points, key, val)) { rest[key] = val; continue }
      if (!centerOf(val.near)) return { kept, problem: { key, message:
        `orderBy ${key}.near needs a numeric lat and lng — got ${JSON.stringify(val.near)}` } }
    }
    if (Object.keys(rest).length) kept.push(rest)
  }
  return { kept, problem: null }
}

// ─── @guarded on the way IN ───────────────────────────────────────────────────
//
// `@guarded` locks a column in both directions, and the read half used to be
// only a STRIP: the value never came back, and the same caller could still name
// it in a `where` or an `orderBy`. That recovers it. Measured — an 11-character
// value read out one character at a time by `startsWith`, one row match each,
// and `orderBy` leaking the ordering of every row in a single request
// (FJS-393). `@secret` was covered only by accident: it expands to
// `@encrypted @guarded`, and it is the encrypted half that refuses a
// filter, on the unrelated ground that ciphertext under a random IV can never
// equal a plaintext.
//
// It cannot live in `filterableKeysFor`. That answers whether a column CAN be
// compared, which is a fact about the schema and is why `$checkWhere` may be
// asked of any flavor of client. This asks who is asking, so it belongs at the
// read, beside the write refusal it mirrors.
//
// **The walk crosses relations, because the grammar does.** `where: { author:
// { is: { ssn: … } } }` reads a guarded column on a model this table is not,
// and so does a relation `orderBy` and a nested `include`. So the question is
// per model and `reaches` is the precomputed gate: a model from which no
// guarded column can be reached, through any depth of relation, skips the walk
// on one boolean.

const REL_FILTER_MODES = new Set(['some', 'every', 'none', 'is', 'isNot'])
const WHERE_LOGIC      = new Set(['AND', 'OR', 'NOT'])

/** @param {Found[]} found @param {string} accessorName @param {string} method */
function fieldReadRelationError(found, accessorName, method) {
  const first = found[0]
  const names = [...new Set(found.map(f => `"${f.key}"`))].join(', ')
  return new AccessDeniedError(
    `${first.model}: ${names} carries @allow('read', …) and is named through a RELATION from ` +
    `${accessorName}.${method}. The predicate decides which ROWS of ${first.model} this caller may ` +
    `read the column on, and a filter one relation away has no row of ${first.model} to decide it ` +
    `against — so comparing it there would recover the value of rows the predicate refuses. ` +
    `Filter on ${first.model} directly, or read it through asSystem().`,
    { model: first.model, operation: 'read' },
  )
}

// Only a relation key or a logical/relation operator is descended into. A
// nested object under an ordinary column is a typed-Json path, where a key that
// happens to share a guarded column's name means something else entirely.
/** @param {any} where @param {string} modelName @param {ProtectedFacet} facet @param {Record<string, Shape>} shapes @param {Found[]} out @param {number} [depth] */
function walkGuardedWhere(where, modelName, facet, shapes, out, depth = 0) {
  if (!where || typeof where !== 'object' || depth > 12) return out
  if (Array.isArray(where)) {
    for (const w of where) walkGuardedWhere(w, modelName, facet, shapes, out, depth + 1)
    return out
  }
  const own  = shapes[modelName][facet]
  const rels = shapes[modelName].relations
  for (const [k, v] of Object.entries(where)) {
    if (WHERE_LOGIC.has(k)) { walkGuardedWhere(v, modelName, facet, shapes, out, depth + 1); continue }
    if (own.has(k)) { out.push({ model: modelName, key: k }); continue }
    const rel = rels[k]
    if (!rel || !v || typeof v !== 'object') continue
    for (const [mode, inner] of Object.entries(v))
      if (REL_FILTER_MODES.has(mode)) walkGuardedWhere(inner, rel.targetModel, facet, shapes, out, depth + 1)
  }
  return out
}

/** @param {any} orderBy @param {string} modelName @param {ProtectedFacet} facet @param {Record<string, Shape>} shapes @param {Found[]} out @param {number} [depth] */
function walkGuardedOrderBy(orderBy, modelName, facet, shapes, out, depth = 0) {
  if (!orderBy || typeof orderBy !== 'object' || depth > 12) return out
  const own  = shapes[modelName][facet]
  const rels = shapes[modelName].relations
  for (const item of Array.isArray(orderBy) ? orderBy : [orderBy]) {
    if (!item || typeof item !== 'object') continue
    for (const [k, v] of Object.entries(item)) {
      if (own.has(k)) { out.push({ model: modelName, key: k }); continue }
      const rel = rels[k]
      if (rel && v && typeof v === 'object') walkGuardedOrderBy(v, rel.targetModel, facet, shapes, out, depth + 1)
    }
  }
  return out
}

// An include carries a whole nested read — its own where, orderBy and include —
// against the target model, so it is the same questions asked one relation along.
/** @param {any} include @param {string} modelName @param {ProtectedFacet} facet @param {Record<string, Shape>} shapes @param {Found[]} out @param {number} [depth] */
function walkGuardedInclude(include, modelName, facet, shapes, out, depth = 0) {
  if (!include || typeof include !== 'object' || depth > 12) return out
  const rels = shapes[modelName].relations
  for (const [k, v] of Object.entries(include)) {
    const rel = rels[k]
    if (!rel || !v || typeof v !== 'object') continue
    walkGuardedWhere(v.where, rel.targetModel, facet, shapes, out, depth + 1)
    walkGuardedOrderBy(v.orderBy, rel.targetModel, facet, shapes, out, depth + 1)
    walkGuardedInclude(v.include, rel.targetModel, facet, shapes, out, depth + 1)
  }
  return out
}

// ─── nested include arguments ─────────────────────────────────────────────
//
// `where`, `orderBy` and `select` refuse an unknown key BY NAME — at the top
// level. An `include` hops to another model, `withArgValidation` closes over
// this one, and nothing followed it, so the nested copies of those same three
// options reached SQL ungraded. One door, three different failures:
//
//   include > select   the key went into the relation's SELECT list UNQUOTED,
//                      so a name carrying a `"` broke the statement's structure
//                      rather than being refused.
//   include > where    the key was quoted, and SQLite resolves a double-quoted
//                      identifier it cannot bind as a STRING LITERAL — two
//                      constants compared, an empty relation, and no error.
//   include > orderBy  accepted, and dropped.
//
// `walkGuardedInclude` already recurses this exact shape to ask whether a
// column is @guarded. This is the existence check beside it, and it calls the
// same generic graders the top level does rather than restating their wording.
/** @param {any} include @param {string} modelName @param {string} method @param {Ctx} ctx @param {boolean} isWrite @param {number} [depth] */
function checkIncludeArgs(include, modelName, method, ctx, isWrite, depth = 0) {
  if (!include || typeof include !== 'object' || depth > 12) return
  const rels = ctx.shapes[modelName].relations
  for (const [k, v] of Object.entries(include)) {
    const rel    = rels[k]
    const target = rel && ctx.models?.[rel.targetModel]
    if (!target || !v || typeof v !== 'object' || Array.isArray(v)) continue
    const name = rel.targetModel

    const keys = filterableKeysFor(target)
    for (const d of Object.values(ctx.shapes[name].edges)) keys.filterable.add(d.as)
    checkWhereKeys(v.where, keys, name, method, isWrite,
      new Set(Object.keys(ctx.shapes[name].scopes)), ctx)
    checkWhereKeys(v.cursor, keys, name, method, isWrite,
      new Set(Object.keys(ctx.shapes[name].scopes)), ctx)

    const { sortable, relations, computed, transient, opaque } = sortableKeysFor(target)
    const problems = collectOrderByKeyProblems(
      v.orderBy, sortable, relations, computed, opaque, false, transient, [], null,
      sortHopFor(ctx, name))
    if (problems.length) throw new ValidationError([{
      path:    ['include', k, 'orderBy', problems[0].key],
      message: problems[0].message.replace('%MODEL%', `${name}.${method}`),
    }])

    if (v.select && typeof v.select === 'object' && !Array.isArray(v.select)) {
      const selectable = new Set()
      for (const f of target.fields) if (!transient.has(f.name)) selectable.add(f.name)
      for (const d of Object.values(ctx.shapes[name].edges)) selectable.add(d.as)
      for (const [sk, sv] of Object.entries(v.select)) {
        if (!sv || selectable.has(sk)) continue
        throw new ValidationError([{
          path:    ['include', k, 'select', sk],
          message: `Unknown field '${sk}' in select for ${name}.${method}` +
                   (suggestKey(sk, selectable) ? `. Did you mean: ${suggestKey(sk, selectable)}?` : ''),
        }])
      }
    }
    checkIncludeArgs(v.include, name, method, ctx, isWrite, depth + 1)
  }
}

// The resolver `collectOrderByKeyProblems` takes for a relation hop: a relation
// name on `modelName` to the sort sets of what it points at. Returned lazily
// per hop rather than built for every model up front, because most orderBys
// name no relation at all.
/** @param {Ctx} ctx @param {string} modelName */
export function sortHopFor(ctx, modelName) {
  return (/** @type {string} */ relName) => {
    const rel    = ctx.shapes[modelName].relations[relName]
    const target = rel && ctx.models?.[rel.targetModel]
    if (!target) return null
    return { ...sortableKeysFor(target), model: rel.targetModel, hop: sortHopFor(ctx, rel.targetModel) }
  }
}

// Every place a caller's arguments name a column. `select` is absent on purpose
// — it is answered by the strip, which is the half that already worked.
/** @param {any} args @param {string} modelName @param {ProtectedFacet} facet @param {Record<string, Shape>} shapes */
function collectGuardedArgs(args, modelName, facet, shapes) {
  if (!args || typeof args !== 'object') return []
  /** @type {Found[]} */
  const out = []
  walkGuardedWhere(args.where, modelName, facet, shapes, out)
  walkGuardedOrderBy(args.orderBy, modelName, facet, shapes, out)
  walkGuardedInclude(args.include, modelName, facet, shapes, out)
  // A cursor is a row's column values, so it compares exactly as a where does.
  walkGuardedWhere(args.cursor, modelName, facet, shapes, out)
  return out
}

/** @param {Found[]} found @param {string} accessorName @param {string} method */
function guardedArgsError(found, accessorName, method) {
  const first  = found[0]
  const names  = [...new Set(found.map(f => `"${f.key}"`))].join(', ')
  const plural = names.includes(',')
  const onOther = found.some(f => f.model !== first.model)
  return new AccessDeniedError(
    `${first.model}: ${names} ${plural ? 'are' : 'is'} @guarded — a system-context column on read as ` +
    `well as write, so a where, an orderBy, a distinct or a cursor cannot name ` +
    `${plural ? 'them' : 'it'} either. Comparing a column this caller cannot read recovers its value ` +
    `one comparison at a time, and ordering by it leaks the ordering of every row at once. ` +
    (onOther ? `Reached through a relation from ${accessorName}.${method}. ` : '') +
    `Read it through asSystem(), or narrow by a column that is not guarded.`,
    { model: first.model, operation: 'read' },
  )
}

// ─── a @from aggregate over a policied target ────────────────────────────────
//
// The aggregate in the SELECT is recomputed under the caller's row policy, but
// a `where` or an `orderBy` naming it runs the startup subquery, which counts
// every row that exists: `where: { kidCount: { gt: 1 } }` answered for a
// parent whose second kid the caller cannot read (FJS-1647). So naming one is
// refused while the target's read policy applies to this caller, as a gated
// target's is (FJS-1646). Which aggregates those are is `shape.policiedAggregates`,
// so a relation hop and an include are walked the same way a guarded column is;
// this only says whether any model has one, so a schema with none pays nothing.
/** @param {Ctx} ctx */
const anyPoliciedAggregate = (ctx) => Object.values(ctx.shapes).some(s => s.policiedAggregates.size > 0)

/** @param {Found[]} found @param {string} accessorName @param {string} method @param {Ctx} ctx */
function policiedAggregateError(found, accessorName, method, ctx) {
  const first  = found[0]
  const target = ctx.shapes[first.model].fromFields[first.key].aggRef.model
  return new AccessDeniedError(
    `${first.model}: "${first.key}" is a @from aggregate over ${target}, and ${target}'s read policy ` +
    `decides which of its rows this caller counts. A where or an orderBy runs the aggregate over ` +
    `every row of ${target}, so ${accessorName}.${method} cannot name it. Read the field and ` +
    `filter the answer, or read it through asSystem().`,
    { model: first.model, operation: 'read' },
  )
}

// The keys a GLOBAL filter may name. `filterableKeysFor` reads the model; an
// edge namespace is a write-side shape the model does not declare, and
// `withArgValidation` folds it into the caller's own where-key check the same
// way — so a filter naming one is legitimate and must not be refused.
/** @param {ModelDef} model @param {Record<string, any>} edges  the model's `@edge` fields — `shape.edges` */
export function globalFilterKeysFor(model, edges) {
  const keys = filterableKeysFor(model)
  for (const d of Object.values(edges)) keys.filterable.add(d.as)
  return keys
}

// Why an unknown key is fatal in a global filter and a warning in a caller's
// `where`. A caller has a hint and a stack; the filter is the app's own
// configuration, applied to every read of the model for the life of the
// process, and both of its failures are silent: `{ nope: 'x' }` compiles to
// `'nope' = 'x'` and empties the model, `{ nope: 'nope' }` compiles to
// `'nope' = 'nope'` and returns every row of it past a filter that was supposed
// to narrow. There is nobody to warn.
/** @param {string} accessor @param {string} modelName @param {KeyProblem} problem */
export function globalFilterRefusal(accessor, modelName, problem) {
  return `the global filter for "${accessor}" cannot be applied — ` +
         problem.message.replace('%MODEL%', modelName) +
         (problem.reason === 'unknown'
           ? `. SQLite reads an identifier it cannot bind as a string literal, so this filter matches ` +
             `no row at all — or every row, if the value happens to equal the key` +
             (problem.suggestion ? `. Did you mean: ${problem.suggestion}?` : '')
           : '')
}

const WHERE_REASONS = {
  computed:  (/** @type {string} */ k) => `'${k}' is a @computed field on %MODEL% — it is derived in JS after the row is read, so SQLite cannot filter by it. `
                  + `It is not a column, and comparing one is comparing string constants: it matches every row when the value happens to equal '${k}', and none otherwise. `
                  + `To filter by a derived value make it @from or @generated, or store it`,
  encrypted: (/** @type {string} */ k) => `'${k}' is @encrypted on %MODEL% — the column holds ciphertext under a random IV, so no plaintext can ever equal it and this filter matches nothing. `
                  + `Use @encrypted(deterministic: true) if the value must be both looked up and read back, @hashed if it only ever needs matching (@secret @hashed if it also wants the lock and the audit trail), `
                  + `or filter on a column that is not encrypted`,
  transient: (/** @type {string} */ k) => `'${k}' is @transient on %MODEL% — it is a payload key the API accepts and nothing stores, so there is no column to filter by. `
                  + `Filter by what the service wrote instead (a @transient credential is looked up through the row it was lifted into)`,
  unknown:   (/** @type {string} */ k) => `Unknown field '${k}' in where for %MODEL%`,
}

// ─── descending a relation filter ─────────────────────────────────────────────
//
// `{ customer: { is: { nope: 1 } } }` used to stop at `customer`: the key is a
// real relation, so it passed, and the object under it was never graded. The
// inner key then reached SQL as an identifier and SQLite answered `no such
// column: t.nope` — a 500 quoting a fragment of a query, where the same typo one
// level up is a 400 naming the field and suggesting the right one (`FJS-776`).
//
// It is also Invariant 8's class. The name is quoted and not injectable, but a
// caller-supplied name entered a SQL pattern, and the top-level check exists
// precisely so that cannot happen.
//
// The walk mirrors `walkGuardedWhere`: only a relation key and a known mode are
// descended into, because a nested object under an ordinary column is a
// typed-Json path where a key means something else entirely.
//
// `rel` is `{ ctx, model }` and is optional — without it this grades one level,
// which is what the two callers that hold no schema context still get.

const _whereKeyCache = new WeakMap()

// A @guarded/@secret column is not a client's business, and a refusal must not
// hand one over. `FJS-D205` keeps it out of the client's JSON Schema, so a
// message naming it answers what the bundle is ruled not to carry — measured as
// `Sortable: createdAt, email, id, notes, ssn` reaching a caller the gate then
// refused a legitimate read (`FJS-914`).
//
// It narrows what a refusal DISCLOSES and never what is legal. Whether a key is
// valid is a question about the schema — `$checkWhere` says so in as many words
// and every flavor of client must answer it identically, so filtering the legal
// set here would make one caller's standing decide another's 400. Whether a
// non-system caller should be able to ORDER BY a guarded column at all is a
// real question and a separate one: the value is stripped from the row, but the
// ORDER still ranks it.
//
// `asSystem()` discloses everything, and a model declaring no @guarded pays
// nothing — the same Set is handed straight back.
export const _guardedNames = (/** @type {{ name: string }} */ model, /** @type {Ctx} */ ctx) => {
  const own = ctx.shapes[model.name].guardedKeys
  return own.size && !ctx.isSystem ? own : null
}

export const _shownSet = (/** @type {Set<string>} */ set, /** @type {Set<string> | null | undefined} */ hidden) => hidden ? new Set([...set].filter(n => !hidden.has(n))) : set

/** @param {ModelDef} model @param {Ctx} ctx */
function whereKeysFor(model, ctx) {
  let keys = _whereKeyCache.get(model)
  if (!keys) {
    keys = filterableKeysFor(model)
    for (const d of Object.values(ctx.shapes[model.name].edges)) keys.filterable.add(d.as)
    // Keyed on the MODEL object, which belongs to the parsed schema — so two
    // clients over one schema share the answer and a second schema cannot
    // collide with it.
    _whereKeyCache.set(model, keys)
  }
  return keys
}

/**
 * @param {any} where
 * @param {Set<string>} filterable
 * @param {Set<string>} computed
 * @param {Set<string>} encrypted
 * @param {KeyProblem[]} [out]
 * @param {Set<string> | null} [scopes]
 * @param {Set<string> | null} [transient]
 * @param {{ ctx: Ctx, model: string } | null} [rel]  where this `where` sits, when one relation in
 * @param {string} [path]
 * @param {number} [depth]
 */
export function collectWhereKeyProblems(where, filterable, computed, encrypted, out = [], scopes = null, transient = null, rel = null, path = '', depth = 0) {
  if (!where || typeof where !== 'object' || Array.isArray(where)) return out
  const at = (/** @type {string} */ k) => path ? `${path}.${k}` : k
  for (const [k, v] of Object.entries(where)) {
    if (k === 'AND' || k === 'OR' || k === 'NOT') {
      for (const w of Array.isArray(v) ? v : [v]) collectWhereKeyProblems(w, filterable, computed, encrypted, out, scopes, transient, rel, path, depth)
      continue
    }
    // A scope is a NAME in the table the schema declared, so this is the one
    // key whose VALUE is checked rather than the key itself (Invariant 8: the
    // name is looked up, never interpolated).
    if (k === '$scope') {
      for (const n of Array.isArray(v) ? v : [v]) {
        if (typeof n === 'string' && scopes?.has(n)) continue
        out.push({
          key:        '$scope',
          reason:     'scope',
          suggestion: typeof n === 'string' ? suggestKey(n, scopes ?? new Set()) : null,
          allowed:    [...(scopes ?? [])].sort(),
          message:    `Unknown scope '${n}' — ` + (scopes?.size
            ? `%MODEL% declares: ${[...scopes].sort().join(', ')}`
            : `%MODEL% declares no @@scope`),
        })
      }
      continue
    }
    // Only the tag's brand may reach the pattern, at any depth (`FJS-D613`).
    // A string or a JSON look-alike is refused HERE rather than in the compiler
    // so it answers as every other bad key does, with its path -- a plain Error
    // is a 500.
    if (k === '$raw') {
      if (!isRawClause(v)) out.push({
        key: '$raw', path: at('$raw'), reason: 'raw-untagged', allowed: [], suggestion: null,
        message: `where.$raw on %MODEL% must be a sql\`\` tag` +
                 (typeof v === 'string' ? ', not a string — the tag binds its values, a string would put them in the pattern' : '') +
                 `. Write: where: { $raw: sql\`…\` }`,
      })
      continue
    }
    if (filterable.has(k)) {
      // A relation is filterable AND carries a nested where. Grade that where
      // against the TARGET's columns, or the inner key reaches SQL ungraded.
      const link = depth < 12 ? rel?.ctx?.shapes[rel.model].relations[k] : null
      const targetModel = link && rel.ctx.models?.[link.targetModel]
      if (targetModel && v && typeof v === 'object' && !Array.isArray(v)) {
        const tk = whereKeysFor(targetModel, rel.ctx)
        const tScopes = new Set(Object.keys(rel.ctx.shapes[targetModel.name].scopes))
        for (const [mode, inner] of Object.entries(v)) {
          if (!REL_FILTER_MODES.has(mode)) {
            // The compiler throws on this as a bare Error, which reaches a
            // caller as a 500. Graded here so it is refused by name beside
            // every other bad key in the same request.
            out.push({
              key:        mode,
              path:       at(k) + `.${mode}`,
              model:      rel.model,
              reason:     'relation-operator',
              suggestion: suggestKey(mode, REL_FILTER_MODES),
              allowed:    [...REL_FILTER_MODES].sort(),
              message:    `'${mode}' is not a relation filter on %MODEL%.${k} — use ` +
                          `${[...REL_FILTER_MODES].sort().join(', ')}`,
            })
            continue
          }
          collectWhereKeyProblems(inner, tk.filterable, tk.computed, tk.encrypted, out, tScopes, tk.transient,
                                  { ctx: rel.ctx, model: targetModel.name }, at(k) + `.${mode}`, depth + 1)
        }
      }
      continue
    }
    const reason = computed.has(k)  ? 'computed'
                 : transient?.has(k)  ? 'transient'
                 : encrypted.has(k)  ? 'encrypted' : 'unknown'
    out.push({
      key:        k,
      // Where the key was, so a message can say `customer.is.nope` rather than
      // `nope` — which names no model a caller can act on when the key is two
      // relations away.
      path:       at(k),
      model:      rel?.model ?? null,
      reason,
      suggestion: reason === 'unknown' ? suggestKey(k, filterable) : null,
      allowed:    [...filterable].sort(),
      message:    WHERE_REASONS[reason](k),
    })
  }
  return out
}


// ─── orderBy key validation ───────────────────────────────────────────────────
//
// The sibling of collectWhereKeyProblems, and it does NOT inherit the
// warn-on-read half of that split. A bad filter key returns fewer rows, which
// the caller can see; a bad sort key returns the RIGHT rows in the wrong order,
// which nothing can see. Until this existed `orderBy: { bogusColumn: 'desc' }`
// and `orderBy: { aComputedField: 'asc' }` were both a silent no-op — SQLite
// never received a column it could not resolve, because buildOrderBy quoted the
// key and SQLite resolved it against the SELECT aliases, finding nothing.
//
// Sortable is a narrower question than filterable, so this cannot reuse the
// where set: a @computed field is a JS function over a row that SQLite has
// never heard of, so it can be neither sorted nor paginated, while a @from
// field is a correlated subquery aliased into the SELECT list and sorts fine.
//
// Relation keys pass through — buildRelationOrderBy owns that grammar.
//
// `allowAggregates` is groupBy/aggregate, where `_count` and `_sum` are the
// point of the query rather than a typo.
/**
 * @param {any} orderBy
 * @param {Set<string>} sortable
 * @param {Set<string>} relations
 * @param {Set<string>} computed
 * @param {Map<string, string>} opaque  key → why it cannot be sorted (`OPAQUE_SORT`'s keys)
 * @param {boolean} allowAggregates
 * @param {Set<string> | null} [transient]
 * @param {KeyProblem[]} [out]
 * @param {Set<string> | null} [shown]
 * @param {((relName: string) => any) | null} [hop]
 */
export function collectOrderByKeyProblems(orderBy, sortable, relations, computed, opaque, allowAggregates, transient = null, out = [], shown = null, hop = null) {
  if (!orderBy) return out
  // What the caller is TOLD is sortable. Legality stays `sortable`.
  const list = shown ?? sortable
  for (const item of Array.isArray(orderBy) ? orderBy : [orderBy]) {
    if (!item || typeof item !== 'object') continue
    for (const [key, val] of Object.entries(item)) {
      // The escape hatch names its own columns, so there is nothing here to
      // check — the same standing `where`'s `$raw` has.
      if (key === '$raw')                         continue
      if (allowAggregates && key.startsWith('_')) continue
      // A relation hop. `{ author: { name: 'asc' } }` sorts the parent by a
      // column of the CHILD, so the name under it is graded against the child's
      // model and not this one — and skipping the hop outright is how a caller's
      // string reached the join's ORDER BY ungraded (Invariant 8). `hop`
      // resolves the target the way `walkGuardedOrderBy` already does; without
      // one there is nothing to grade against and the hop is passed over.
      if (relations.has(key)) {
        const sets = val && typeof val === 'object' && !Array.isArray(val)
          ? hop?.(key) : null
        if (!sets) continue
        const nested = collectOrderByKeyProblems(
          val, sets.sortable, sets.relations, sets.computed, sets.opaque,
          // `{ posts: { _count: 'asc' } }` counts the relation rather than
          // naming a column of it, so the aggregate form is legal here whatever
          // it was one level up.
          true, sets.transient, [], null, sets.hop)
        for (const p of nested) out.push({ ...p, via: key, message: p.message.replace('%MODEL%', sets.model) })
        continue
      }
      if (sortable.has(key))                      continue
      const opaqueWhy = opaque?.get(key)
      if (opaqueWhy) {
        out.push({
          key,
          reason:     'opaque',
          suggestion: null,
          sortable:   [...list].sort(),
          message:    `Cannot orderBy '${key}' on %MODEL% — it is ${OPAQUE_SORT[opaqueWhy]}. ` +
                      `Sort by a column that holds the value itself. ` +
                      `Sortable: ${[...list].sort().join(', ')}`,
        })
        continue
      }
      if (transient?.has(key)) {
        out.push({
          key,
          reason:     'transient',
          suggestion: null,
          sortable:   [...list].sort(),
          message:    `Cannot orderBy '${key}' on %MODEL% — it is @transient, a payload key the API ` +
                      `accepts and nothing stores, so there is no column to sort by. ` +
                      `Sortable: ${[...list].sort().join(', ')}`,
        })
        continue
      }
      if (computed.has(key)) {
        out.push({
          key,
          reason:     'computed',
          suggestion: null,
          sortable:   [...list].sort(),
          message:    `Cannot orderBy '${key}' on %MODEL% — it is a @computed field, which is a JS ` +
                      `function over a row, so SQLite can neither sort nor paginate by it. ` +
                      `To sort by a derived value make it @from or @generated, or store it. ` +
                      `Sortable: ${[...list].sort().join(', ')}`,
        })
        continue
      }
      const hint = suggestKey(key, list)
      out.push({
        key,
        reason:     'unknown',
        suggestion: hint,
        sortable:   [...list].sort(),
        message:    `Unknown orderBy field '${key}' on %MODEL%.` +
                    (hint ? ` Did you mean: ${hint}?` : ` Sortable: ${[...list].sort().join(', ')}`),
      })
      // A nested object under an unknown key is a relation orderBy on a
      // relation that does not exist — same problem, already reported.
      void val
    }
  }
  return out
}

// ─── aggregate / groupBy key validation ───────────────────────────────────────
//
// The third sibling of collectWhereKeyProblems and collectOrderByKeyProblems,
// and the narrowest of the three, because an aggregate does two things neither
// of the others does: it NAMES a column in the SELECT, and it never builds a
// row. So `MAX("whatever")` reaches SQLite verbatim — an unresolvable
// double-quoted identifier is read as a string CONSTANT, and the query succeeds
// (FJS-202) — and `read()` never runs, so nothing strips a protected column
// before the value is handed back (FJS-273).
//
// Two tiers, and the split is what a caller does with the answer:
//
//   naming  — `by:` and `_count: { distinct }` need a real column and nothing
//             more. GROUP BY over stored text is self-consistent (every
//             distinct value is its own group), so the opaque bucket passes.
//   value   — everything that produces a value out of the column takes the
//             opaque bucket too: MAX over ciphertext orders by ciphertext, SUM
//             over a JSON array answers 0.
//
// Protection is asked separately, in makeTable, because it depends on the
// CALLER and this does not.
const AGG_REASONS = {
  computed: (/** @type {string} */ k, /** @type {string} */ op) => `Cannot ${op} '${k}' on %MODEL% — it is a @computed field, a JS function over a row, so it is not a ` +
                       `column SQLite can aggregate. Make it @generated to aggregate it in SQL, or aggregate in JS after the read.`,
  from:     (/** @type {string} */ k, /** @type {string} */ op) => `Cannot ${op} '${k}' on %MODEL% — it is a @from field, a correlated subquery aliased into the SELECT ` +
                       `rather than a column, so it cannot be aggregated in the same statement. Aggregate the target model instead.`,
  relation: (/** @type {string} */ k, /** @type {string} */ op) => `Cannot ${op} '${k}' on %MODEL% — it is a relation, not a column. Aggregate the related model, or use ` +
                       `orderBy: { ${k}: { _count: … } } to sort by it.`,
  opaque:   (/** @type {string} */ k, /** @type {string} */ op, /** @type {keyof typeof OPAQUE_AGG} */ why) => `Cannot ${op} '${k}' on %MODEL% — it is ${OPAQUE_AGG[why]}. Aggregate a column that holds the value itself.`,
  transient:(/** @type {string} */ k, /** @type {string} */ op) => `Cannot ${op} '${k}' on %MODEL% — it is @transient, a payload key the API accepts and nothing stores, ` +
                       `so there is no column to aggregate.`,
}

// The opaque bucket said for an aggregate rather than for a sort. Same columns
// and the same reason — the stored TEXT is a storage detail — but MIN/MAX and
// SUM/AVG fail differently from ORDER BY and the sentence has to say which.
const OPAQUE_AGG = {
  array:     `an array column, stored as a JSON document — MIN/MAX compare that text, so '[10]' ranks below '[9]', and SUM answers 0`,
  json:      `a Json column, stored as a document — an aggregate compares the serialized text, so the answer is about whichever key serialized first`,
  file:      `a File column, stored as a reference document — an aggregate compares that JSON text, never anything about the file`,
  encrypted: `@encrypted — an aggregate compares ciphertext, which orders nothing and re-shuffles on every re-encryption`,
  hashed:    `@hashed — the column holds a one-way digest, so an aggregate would answer a fact about digests rather than about values. ` +
             `A digest can be matched in a where and never read back, by any caller`,
}

/**
 * @param {string[]} names
 * @param {Record<string, any>} sets  the model's key sets — `aggregatable`, `computed`, `from`, `relations`, `opaque`, `transient`
 * @param {string} op
 * @param {any} valueRead
 * @param {KeyProblem[]} [out]
 */
export function collectAggKeyProblems(names, sets, op, valueRead, out = []) {
  const { columns, computed, transient, from, relations, opaque } = sets
  for (const key of names) {
    if (key == null) continue
    if (computed.has(key))  { out.push({ key, reason: 'computed', message: AGG_REASONS.computed(key, op) }); continue }
    if (transient.has(key)) { out.push({ key, reason: 'transient', message: AGG_REASONS.transient(key, op) }); continue }
    if (from.has(key))      { out.push({ key, reason: 'from',     message: AGG_REASONS.from(key, op) });     continue }
    if (relations.has(key)) { out.push({ key, reason: 'relation', message: AGG_REASONS.relation(key, op) }); continue }
    if (!columns.has(key)) {
      const hint = suggestKey(key, columns)
      out.push({
        key,
        reason:  'unknown',
        message: `Unknown ${op} field '${key}' on %MODEL%.` +
                 (hint ? ` Did you mean: ${hint}?` : ` Columns: ${[...columns].sort().join(', ')}`),
      })
      continue
    }
    const why = valueRead && opaque.get(key)
    if (why) out.push({ key, reason: 'opaque', message: AGG_REASONS.opaque(key, op, why) })
  }
  return out
}

/**
 * @param {any} where
 * @param {ReturnType<typeof whereKeysFor>} keys
 * @param {string} modelName
 * @param {string} method
 * @param {boolean} isWrite
 * @param {Set<string> | null} [scopes]
 * @param {Ctx | null} [ctx]
 */
function checkWhereKeys(where, keys, modelName, method, isWrite, scopes = null, ctx = null) {
  // The CONTAINER first. A `where` that is not an object emits no clause at all
  // — `buildWhere` walks its entries and finds no column among them — which is
  // byte-identical to what an absent `where` emits, so `deleteMany({ where: 5 })`
  // destroyed every row and reported the count as success (FJS-934). A string or
  // an array is the same fault failing the other way: their entries ARE keys (a
  // string's character indices), so they compile to a predicate over columns
  // named `0`, `1`, `2` and match nothing.
  //
  // `where: {}` is untouched and means every row on purpose. That is the whole
  // distinction: absent and empty are a caller saying so, and a malformed value
  // is a caller who believes they narrowed.
  if (where != null && (typeof where !== 'object' || Array.isArray(where))) {
    throw new ValidationError([{
      path:    ['where'],
      message: `'where' on ${modelName}.${method} must be an object — got ` +
               `${Array.isArray(where) ? 'an array' : typeof where}. It narrows nothing as ` +
               `written, and on ${modelName}.${method} that is ` +
               (isWrite ? 'every row in the table' : 'every row') + `. Omit it, or pass {} to ` +
               `mean every row deliberately.`,
    }])
  }
  const problems = collectWhereKeyProblems(where, keys.filterable, keys.computed, keys.encrypted, [], scopes, keys.transient,
                                           ctx ? { ctx, model: modelName } : null)
  for (const p of problems) {
    // The PATH where it is nested, the bare key where it is not: `customer.is.nope`
    // names something a caller can find, and `nope` alone does not once the key
    // is a relation away.
    const where_ = p.path && p.path !== p.key ? `'${p.path}'` : `'${p.key}'`
    const on     = p.model && p.model !== modelName ? ` on ${p.model}` : ''
    // Both halves, or the fix closes the branch nobody takes: a real typo lands
    // on the suggestion, and `sn` suggested `ssn` before this.
    const hidden     = ctx ? _guardedNames({ name: p.model ?? modelName }, ctx) : null
    const allowed    = hidden ? p.allowed.filter((/** @type {string} */ n) => !hidden.has(n)) : p.allowed
    const suggestion = hidden && p.suggestion && hidden.has(p.suggestion)
      ? suggestKey(p.key, new Set(allowed))
      : p.suggestion
    const msg = p.reason === 'unknown'
      ? `Unknown field ${where_} in where for ${modelName}.${method}${on}.` +
        (suggestion ? ` Did you mean: ${suggestion}?` : ` Valid fields: ${allowed.join(', ')}`)
      : p.message.replace('%MODEL%', p.model && p.model !== modelName ? p.model : `${modelName}.${method}`)
    // Every unknown key throws, a read as much as a write. The read half warned
    // on the reading that a typo'd filter still executed and merely answered
    // too much; it does neither. SQLite resolves a double-quoted identifier it
    // cannot bind as a STRING LITERAL, so `{ ownerIdd: 1 }` compares two
    // constants and answers NO rows — the same wrong answer the reason below
    // already refuses to report by warning — and a key carrying a `"` closes
    // the quote, which is enough to unbalance the parentheses a row policy is
    // ANDed inside and lift it off the query (Invariant 8, `FJS-634`).
    //
    // The did-you-mean hint is the half worth keeping and it survives: it
    // arrives in the error instead of in a log nobody reads.
    throw new ValidationError([{ path: ['where', p.key], message: msg }])
  }
}

const ARG_READ_METHODS = [
  'findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow',
  'count', 'exists', 'findManyAndCount', 'aggregate', 'groupBy', 'findManyCursor',
]
const ARG_WRITE_METHODS = [
  'update', 'updateMany', 'remove', 'removeMany', 'delete', 'deleteMany', 'restore', 'upsert',
]

// ─── the argument names each verb reads ───────────────────────────────────
//
// A closed set per verb, because a key the verb does not read is DROPPED, and
// the key most often misspelled is the one that narrows: `deleteMany({ wher })`
// deleted every row the caller could reach and answered the count as success,
// and `findMany({ search })` answered every row as the hits (`FJS-1310`). Each
// list is what the method body destructures or reads; a verb growing an option
// adds it here or the option is refused by name on its first call.
const VIEW_FLAGS = ['withDeleted', 'onlyDeleted', 'withTemplates', 'onlyTemplates', 'withExpired', 'onlyExpired', 'asOf']
const FIND_ARGS  = ['where', 'include', 'select', 'orderBy', 'scopedBy', ...VIEW_FLAGS]
const PAGE_ARGS  = [...FIND_ARGS, 'limit', 'offset', 'distinct']
const AGG_ARGS   = ['where', '_count', '_sum', '_avg', '_min', '_max', '_stringAgg', ...VIEW_FLAGS]
const REMOVE_ARGS = ['where', ...VIEW_FLAGS]
const ARG_NAMES = {
  findMany:          new Set([...PAGE_ARGS, 'recursive', 'window']),
  findFirst:         new Set(FIND_ARGS),
  findFirstOrThrow:  new Set(FIND_ARGS),
  findUnique:        new Set(FIND_ARGS),
  findUniqueOrThrow: new Set(FIND_ARGS),
  // `count(args)` over a page's own arguments is how a page learns its total,
  // and `findManyAndCount` hands one object to both halves. A page argument is
  // therefore known to count, and means nothing there.
  count:             new Set([...PAGE_ARGS, 'window']),
  exists:            new Set(['where', ...VIEW_FLAGS]),
  findManyAndCount:  new Set([...PAGE_ARGS, 'window']),
  aggregate:         new Set(AGG_ARGS),
  groupBy:           new Set([...AGG_ARGS, 'by', 'having', 'orderBy', 'limit', 'offset', 'fillGaps', 'interval', 'timeZone']),
  findManyCursor:    new Set(['cursor', 'limit', 'where', 'select', 'include', 'orderBy', 'withDeleted', 'onlyDeleted']),
  search:            new Set(['limit', 'offset', 'where', 'orderBy', 'select', 'include', 'highlight', 'snippet', 'withRank', ...VIEW_FLAGS]),
  create:            new Set(['data', 'include', 'select', 'scopedBy', 'system']),
  update:            new Set(['where', 'data', 'include', 'select', 'scopedBy', 'system', '_bypassVersion', '_move', 'base', ...VIEW_FLAGS]),
  updateMany:        new Set(['where', 'data', 'system', 'announce', ...VIEW_FLAGS]),
  upsert:            new Set(['where', 'create', 'update', 'include', 'select', 'system', ...VIEW_FLAGS]),
  remove:            new Set(REMOVE_ARGS),
  removeMany:        new Set([...REMOVE_ARGS, 'announce']),
  delete:            new Set(REMOVE_ARGS),
  deleteMany:        new Set([...REMOVE_ARGS, 'announce']),
  restore:           new Set(['where']),
}

/**
 * What a `view` refuses. Everything else `makeTable` offers is forwarded.
 *
 * Wider than `ARG_WRITE_METHODS`, which is about validating arguments: this is
 * about what a projection has no business doing at all, so it carries the two
 * creates and the two FTS verbs as well. `search` is a read and is here anyway —
 * a view declares no `@@fts`, so the index it would query does not exist — which
 * is why the name says REFUSED rather than writes: two of the thirteen are not
 * writes, and this list is emitted into every app's generated `.d.ts`.
 */
export const VIEW_REFUSED = new Set([
  'create', 'createMany',
  'update', 'updateMany',
  'upsert', 'upsertMany',
  'remove', 'removeMany',
  'delete', 'deleteMany',
  'restore',
  'search', 'optimizeFts',
])

// Non-mutating wrapper: returns a shallow copy so shared/cached table objects
// (jsonl cache, per-scope rebuilds) never accumulate nested wrappers.
/**
 * @param {Record<string, any>} table  a built table — its methods, wrapped here
 * @param {ModelDef} model
 * @param {Ctx} ctx
 */
export function withArgValidation(table, model, ctx) {
  if (!table || !model) return table
  // These two are the only per-FLAVOR facts this wrapper needs, and they are
  // asked per CALL rather than at build time. The table is built once and
  // shared across every flavor (`FJS-722`), so `ctx.isSystem` here would be a
  // read of the flavor while there is no call in progress — the one thing the
  // shared ctx refuses. Both halves are a Set lookup, so asking per call costs
  // nothing that mattered; what it buys is that `asSystem()` and a caller's own
  // client are the same object.
  const shape = ctx.shapes[model.name]
  const reachesGuarded   = shape.reachesGuarded
  const reachesFieldRead = shape.reachesFieldRead
  const checkGuarded   = () => reachesGuarded   && !ctx.isSystem
  const checkFieldRead = () => reachesFieldRead && !ctx.isSystem
  const whereKeys = filterableKeysFor(model)
  for (const d of Object.values(ctx.shapes[model.name].edges)) whereKeys.filterable.add(d.as)
  const scopeNames = new Set(Object.keys(shape.scopes))
  const modelName = model.name
  const { sortable, relations, computed, transient, opaque } = sortableKeysFor(model)

  // A caller's arguments named a field carrying a read predicate. Same-model:
  // conjoin the compiled predicate as a SIBLING of their where, so the rows they
  // cannot read the column on cannot be distinguished by it. Through a relation:
  // refused, because the predicate decides rows of the OTHER model and there is
  // no row of it here to decide against (`FJS-D129`).
  //
  // An orderBy is not a filter, so it narrows nothing (`FJS-1664`): a cell the
  // caller cannot read sorts as NULL and its row stays. Conjoined, a sort
  // changed the result set — count() said 2 and the sorted page held 1.
  const readExprs   = (/** @type {string} */ key) => shape.fieldPolicy[key]?.allow?.read
  const predicateFor = (/** @type {string} */ key) => compileFieldPredicate(modelName, readExprs(key), 'read', ctx)

  const applyFieldRead = (/** @type {any} */ args, /** @type {string} */ method) => {
    const found = collectGuardedArgs(args, modelName, 'fieldReadKeys', ctx.shapes)
    if (!found.length) return args

    const foreign = found.filter(f => f.model !== modelName)
    if (foreign.length) throw fieldReadRelationError(foreign, modelName, method)

    const conjoin = new Set([
      ...walkGuardedWhere(args.where, modelName, 'fieldReadKeys', ctx.shapes, []),
      ...walkGuardedWhere(args.cursor, modelName, 'fieldReadKeys', ctx.shapes, []),
    ].map(f => f.key))
    if (method === 'groupBy' || method === 'aggregate')
      for (const f of found) conjoin.add(f.key)
    else {
      const orderBy = maskOrderBy(args.orderBy, method, conjoin)
      if (orderBy !== args.orderBy) args = { ...args, orderBy }
    }

    const parts = []
    for (const key of conjoin) {
      const pred = predicateFor(key)
      if (pred) parts.push(pred)
    }
    if (!parts.length) return args

    const raw = rawClause(
      parts.map(p => `(${p.sql})`).join(' AND '),
      parts.flatMap(p => p.params),
    )
    // AND rather than a merge into their object: their `where` stays whole and
    // becomes one operand, so nothing they wrote — a NOT above all of it
    // included — can reach the predicate.
    return { ...args, where: args?.where ? { AND: [args.where, { $raw: raw }] } : { $raw: raw } }
  }

  // A plain same-model sort on a field-read column becomes
  // CASE WHEN <predicate> THEN col END — NULL exactly where the read strips the
  // cell. A predicate that reads only the caller has one answer for every row:
  // true sorts the column as it is, false is refused, because every cell would
  // be NULL and the order the caller asked for would silently be none. A
  // near-order cannot take an expression, so it is added to `conjoin`.
  const maskOrderBy = (/** @type {any} */ orderBy, /** @type {string} */ method, /** @type {any} */ conjoin) => {
    if (!orderBy || typeof orderBy !== 'object') return orderBy
    const own = shape.fieldReadKeys
    let changed = false
    const items = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap(item => {
      if (!item || typeof item !== 'object') return [item]
      const out = []
      let rest = null
      for (const [k, dir] of Object.entries(item)) {
        const keep = () => { (rest ??= {})[k] = dir }
        if (!own.has(k)) { keep(); continue }
        const plain = typeof dir === 'string' || (dir !== null && typeof dir === 'object' && !('near' in dir))
        if (!plain) { conjoin.add(k); keep(); continue }
        const pred = predicateFor(k)
        if (!pred) { keep(); continue }
        // A predicate compiled one line up, so the column carries read exprs.
        const answer = hoistedFieldRead(ctx, /** @type {unknown[]} */ (readExprs(k)))
        if (answer === true) { keep(); continue }
        if (answer === false) throw new AccessDeniedError(
          `${modelName}.${method} cannot sort by "${k}": its @allow('read') admits this caller on no row, so every ` +
          `value would sort as NULL and the order asked for would be none. Sort by a column this caller can read.`,
          { model: modelName, operation: 'read' })
        // A keyset cursor resumes from the value the last row holds, and a cell
        // this caller cannot read holds none for them.
        if (method === 'findManyCursor') throw new ValidationError([{ path: ['orderBy', k], message:
          `${modelName}.findManyCursor cannot sort by "${k}": its @allow('read') is decided per row, and a cursor ` +
          `resumes from the value each row holds, which a row this caller cannot read has none of. Page with limit/offset.` }])
        if (rest) { out.push(rest); rest = null }
        changed = true
        if (typeof dir === 'object' && dir.dir == null) continue
        const d = String(typeof dir === 'string' ? dir : dir.dir).toUpperCase()
        if (d !== 'ASC' && d !== 'DESC')
          throw new ValidationError([{ path: ['orderBy', k], message: `orderBy direction must be 'asc' or 'desc', got: ${typeof dir === 'string' ? dir : dir.dir}` }])
        let nulls = ''
        if (typeof dir === 'object' && dir.nulls) {
          const n = String(dir.nulls).toUpperCase()
          if (n !== 'FIRST' && n !== 'LAST')
            throw new ValidationError([{ path: ['orderBy', k], message: `orderBy nulls must be 'first' or 'last', got: ${dir.nulls}` }])
          nulls = ` NULLS ${n}`
        }
        const col = quoteIdent(shape.columnMap[k] ?? k)
        out.push({ $raw: rawClause(`CASE WHEN (${pred.sql}) THEN ${col} END ${d}${nulls}`, pred.params) })
      }
      if (rest) out.push(rest)
      return out
    })
    if (!changed) return orderBy
    return Array.isArray(orderBy) || items.length !== 1 ? items : items[0]
  }

  const _pointFields = pointFieldsOf(model)

  const isNearOrder = (/** @type {string} */ key, /** @type {unknown} */ val) => isNearOrderFor(_pointFields, key, val)

  const checkOrderBy = (/** @type {any} */ args, /** @type {string} */ method) => {
    // Every call passes through here, and one naming no order has nothing to grade.
    if (!args?.orderBy) return

    // A near-order is graded HERE rather than being passed through: the shape
    // is this package's to refuse, and `buildOrderBy` throwing is a 500 where
    // this is a 400 about what the caller wrote.
    let orderBy = args.orderBy
    if (_pointFields.size) {
      const { kept, problem } = liftNearOrders(_pointFields, orderBy)
      if (problem) throw new ValidationError([{ path: ['orderBy', problem.key], message: problem.message }])
      if (!kept.length) return
      orderBy = Array.isArray(args.orderBy) ? kept : kept[0]
    }
    // `_depth` is a column only a tree read has, so it is sortable only there.
    const sortableHere = args?.recursive ? new Set([...sortable, '_depth']) : sortable
    // Read HERE and not where the table is built: one table serves every flavor
    // of client and takes the caller from the call in progress.
    const hidden = _guardedNames(model, ctx)
    const problems = collectOrderByKeyProblems(
      orderBy, sortableHere, relations, computed, opaque,
      method === 'groupBy' || method === 'aggregate', transient, [],
      _shownSet(sortableHere, hidden), sortHopFor(ctx, modelName),
    )
    if (!problems.length) return
    const p = problems[0]
    throw new ValidationError([{
      path:    ['orderBy', p.key],
      message: p.message.replace('%MODEL%', `${modelName}.${method}`),
    }])
  }

  // ─── select / distinct ──────────────────────────────────────────────────
  //
  // The third and fourth positions a caller can name a column in. `where` and
  // `orderBy` refuse an unknown key BY NAME; these two accepted anything and
  // ignored it, so `select: { nope: true }` answered `[{}]` — indistinguishable
  // from a column whose value is legitimately absent — and `distinct` over a
  // field with no column returned every row undeduplicated (FJS-601).
  //
  // The question here is *is this a stored field at all*, never *may this
  // caller read it*: a `select` naming a @guarded column must keep answering
  // nothing, which is the documented read strip and is checked above.
  const selectable = new Set()
  for (const f of model.fields) if (!transient.has(f.name)) selectable.add(f.name)
  for (const d of Object.values(ctx.shapes[model.name].edges)) selectable.add(d.as)
  // `distinct` is a SQL clause and reaches real columns only. A relation, a
  // @computed field and a @transient key are each something SQLite has never
  // heard of, and DISTINCT over an identifier it cannot bind silently dedupes
  // nothing rather than failing.
  const distinctable = new Set([...sortable, ...opaque.keys()])

  const selectRefusal = (/** @type {string} */ position, /** @type {string} */ key, /** @type {Iterable<string>} */ allowed, /** @type {string} */ method) => new ValidationError([{
    path:    [position, key],
    message: transient.has(key)
      ? `Cannot ${position} '${key}' on ${modelName}.${method} — it is @transient, a payload key ` +
        `the API accepts and nothing stores, so there is no column to read`
      : computed.has(key) && position === 'distinct'
        ? `Cannot distinct '${key}' on ${modelName}.${method} — it is a @computed field, derived in ` +
          `JS after the row is read, so SQLite cannot group by it`
        : relations.has(key) && position === 'distinct'
          ? `Cannot distinct '${key}' on ${modelName}.${method} — it is a relation, which has no ` +
            `column on this table`
          : `Unknown field '${key}' in ${position} for ${modelName}.${method}` +
            (suggestKey(key, allowed) ? `. Did you mean: ${suggestKey(key, allowed)}?` : ''),
  }])

  // The CONTAINER is checked before the keys. A `select` that is not an object
  // projects no columns at all — `parseSelectArg` walks its entries, finds no
  // field name among them and emits `"_no_cols_"` — so `select: ['id']` answers
  // `{}` and reports success, which every downstream reader sees as a row that
  // exists and is empty (FJS-828). The list IS the wire spelling; junction's
  // `parseSelect` turns `$select=id,title` into the object before a read, and
  // accepting one here as well would be a second owner of that translation.
  const selectContainerRefusal = (/** @type {unknown} */ sel, /** @type {string} */ method, /** @type {boolean} */ isWrite) => new ValidationError([{
    path:    ['select'],
    message: `'select' on ${modelName}.${method} must be an object naming columns — got ` +
             `${Array.isArray(sel) ? 'an array' : typeof sel}. Write ` +
             `{ ${[...selectable][0] ?? 'id'}: true }` +
             (isWrite ? `, or 'select: false' for do not hand me the row` : '') +
             `. A list is the wire form — $select=a,b — and the API boundary converts it.`,
  }])

  // `distinct` is a boolean and SQLite is why. The clause it emits is
  // `SELECT DISTINCT`, which dedupes the whole projected row; there is no
  // `DISTINCT ON`, so a list of columns has nothing to compile to. It was
  // accepted anyway — `buildSQL` reads `distinct === true` and nothing else, so
  // `distinct: ['title']` emitted no DISTINCT at all and three rows over two
  // titles came back as three, while `checkSelect` validated the list's
  // ELEMENTS by name, so the API answered as though it had understood the
  // argument (FJS-935). The same shape FJS-828 refuses one option along.
  //
  // Both things a caller could have meant already have a spelling, which is why
  // this refuses rather than growing a window function: the distinct VALUES are
  // `select` plus `distinct: true`, and one whole row per value is `groupBy` —
  // where WHICH row survives is a question the caller answers rather than one
  // an arbitrary partition answers for them.
  const distinctShapeRefusal = (/** @type {unknown} */ d, /** @type {string} */ method) => new ValidationError([{
    path:    ['distinct'],
    message: `'distinct' on ${modelName}.${method} is a boolean — got ` +
             `${Array.isArray(d) ? 'an array' : typeof d}. SQLite has no DISTINCT ON, so a ` +
             `column list has nothing to compile to and was silently ignored. For the ` +
             `distinct VALUES of a column, write ` +
             `{ select: { ${[...distinctable][0] ?? 'id'}: true }, distinct: true }; for one whole ` +
             `row per value, groupBy({ by: [...] }), which also says which row you want.`,
  }])

  // An include's own `distinct` is read by NOTHING — not `true`, not a list, and
  // its elements were never name-checked either, so `include: { posts: { distinct:
  // ['nope'] } }` was accepted whole and answered every post. The top-level half
  // at least honoured the boolean. Refused at any depth rather than implemented,
  // because an include is one batched IN-query over every parent: a DISTINCT
  // there dedupes ACROSS parents, which is not what anyone writing it meant, and
  // per-parent is the same window `distinctShapeRefusal` declines to grow.
  const refuseNestedDistinct = (/** @type {any} */ include, /** @type {string} */ method, depth = 0) => {
    if (!include || typeof include !== 'object' || depth > 12) return
    for (const v of Object.values(include)) {
      if (!v || typeof v !== 'object') continue
      if (v.distinct != null) throw new ValidationError([{
        path:    ['include', 'distinct'],
        message: `'distinct' inside an include on ${modelName}.${method} is read by nothing and ` +
                 `was silently ignored. An include is one batched query across every parent row, ` +
                 `so a DISTINCT there would dedupe across parents. Read the related model ` +
                 `directly, or groupBy it.`,
      }])
      refuseNestedDistinct(v.include, method, depth + 1)
    }
  }

  const checkSelect = (/** @type {any} */ args, /** @type {string} */ method, /** @type {boolean} */ isWrite) => {
    const sel = args?.select
    if (sel == null && args?.distinct == null && !args?.include) return
    if (sel != null && (typeof sel !== 'object' || Array.isArray(sel))) {
      if (!(isWrite && sel === false)) throw selectContainerRefusal(sel, method, isWrite)
    }
    if (sel && typeof sel === 'object' && !Array.isArray(sel)) {
      for (const [k, v] of Object.entries(sel)) {
        if (!v || selectable.has(k)) continue
        throw selectRefusal('select', k, selectable, method)
      }
    }
    if (args?.distinct != null && typeof args.distinct !== 'boolean')
      throw distinctShapeRefusal(args.distinct, method)
    refuseNestedDistinct(args?.include, method)
  }

  const checkTakeSkip = (/** @type {any} */ args, /** @type {string} */ method) => {
    if (!args || typeof args !== 'object' || !('take' in args || 'skip' in args)) return
    for (const bad of ['take', 'skip']) {
      if (bad in args) throw new ValidationError([{
        path:    [bad],
        message: `'${bad}' is not a Litestone option on ${modelName}.${method} — use ` +
                 (bad === 'take' ? `'limit' (max rows to return)` : `'offset' (rows to skip)`),
      }])
    }
  }

  // The argument object's own keys, before anything inside them. A named
  // aggregate (`_revenue: { sum: 'total' }`) is a key the caller coins, so it
  // is graded by shape rather than by name.
  const checkArgNames = (/** @type {any} */ args, /** @type {string} */ method) => {
    const known = ARG_NAMES[/** @type {keyof typeof ARG_NAMES} */ (method)]
    if (!known || !args || typeof args !== 'object') return
    const aggs = method === 'aggregate' || method === 'groupBy'
    for (const [k, v] of Object.entries(args)) {
      if (known.has(k) || (aggs && isNamedAgg(k, v))) continue
      // Every read but findMany refuses it by its own check, which says why.
      if (k === 'recursive' && ARG_READ_METHODS.includes(method)) continue
      const hint = k === 'search' || k === '$search'
        ? `. A full-text search is its own verb: ${modelName}.search(query, { where, limit })`
        : suggestKey(k, known) ? `. Did you mean: ${suggestKey(k, known)}?` : ''
      throw new ValidationError([{
        path:    [k],
        message: `Unknown argument '${k}' to ${modelName}.${method} — it would have been ignored` +
                 hint + `. ${method} reads: ${[...known].join(', ')}`,
      }])
    }
  }

  // ─── the guards a call's OPTIONS get, in one sequence ──────────────────────
  //
  // Every place a caller can name a column — `where`, `orderBy`, `select`,
  // `include` — plus the two shape checks and the field-read narrowing. It is a
  // function rather than a block inside `wrap` because `search` takes
  // `(query, opts)` and cannot go through `wrap` at all, so its guards were a
  // hand copy of this list and had drifted: `checkOrderBy` was never added to
  // it, while `search()` honors the option (`FJS-1044`), and `select` had been
  // forgotten there once already (`FJS-601`). A verb outside the argv shape is a
  // verb every future guard has to remember.
  //
  // Answers the args, because the field-read narrowing REWRITES them.
  const guardArgs = (/** @type {any} */ args, /** @type {string} */ method, /** @type {boolean} */ isWrite) => {
    checkTakeSkip(args, method)
    checkArgNames(args, method)
    // Before the key checks: an unknown key on a read only warns, and a
    // guarded one is spelled right.
    if (checkGuarded()) {
      const found = collectGuardedArgs(args, modelName, 'guardedKeys', ctx.shapes)
      if (found.length) throw guardedArgsError(found, modelName, method)
    }
    if (anyPoliciedAggregate(ctx) && args && typeof args === 'object') {
      /** @type {Found[]} */
      const found = []
      walkGuardedWhere(args.where, modelName, 'policiedAggregates', ctx.shapes, found)
      walkGuardedOrderBy(args.orderBy, modelName, 'policiedAggregates', ctx.shapes, found)
      walkGuardedInclude(args.include, modelName, 'policiedAggregates', ctx.shapes, found)
      const live = found.filter(f => buildPolicyFilter(
        ctx.shapes[f.model].fromFields[f.key].aggRef.model, 'read', ctx))
      if (live.length) throw policiedAggregateError(live, modelName, method, ctx)
    }
    checkWhereKeys(args?.where, whereKeys, modelName, method, isWrite, scopeNames, ctx)
    checkOrderBy(args, method)
    checkSelect(args, method, isWrite)
    checkIncludeArgs(args?.include, modelName, method, ctx, isWrite)
    // After the key checks, so a caller naming a column that does not exist
    // still hears about the typo rather than a predicate they cannot see.
    return checkFieldRead() ? applyFieldRead(args, method) : args
  }

  // async wrappers so a validation failure is a REJECTION, matching how the
  // underlying methods fail — a sync throw from a promise-returning API is a
  // third failure mode nobody handles.
  const out = { ...table }
  // A symbol-keyed seam (`PLAN`) is non-enumerable, so the spread above lost
  // it; it takes no caller arguments to validate and passes through as is.
  for (const sym of Object.getOwnPropertySymbols(table))
    Object.defineProperty(out, sym, { value: /** @type {any} */ (table)[sym], enumerable: false })
  const wrap = (/** @type {string} */ method, /** @type {boolean} */ isWrite) => {
    const fn = table[method]
    if (typeof fn !== 'function') return
    out[method] = async (args = {}) => fn.call(table, guardArgs(args, method, isWrite))
  }
  for (const m of ARG_READ_METHODS)  wrap(m, false)
  for (const m of ARG_WRITE_METHODS) wrap(m, true)

  // `create` shapes a row with `select` like every verb above and is in neither
  // list, because the rest of that wrapper reads a `where` it does not have and
  // its guarded refusal is worded for a filter. So it takes the select check
  // alone: `create({ data, select: { nope: true } })` answered `{}` — the row
  // was written and the caller was handed nothing, with no error either way.
  if (typeof table.create === 'function') {
    const fn = table.create
    out.create = async (args = {}) => {
      checkArgNames(args, 'create')
      checkSelect(args, 'create', true)
      return fn.call(table, args)
    }
  }

  // search(query, opts) — the only read whose options are not the first
  // argument, which is why it is here and not in ARG_READ_METHODS. It takes the
  // SAME sequence, so a guard added above reaches it without anyone
  // remembering to.
  if (typeof table.search === 'function') {
    const fn = table.search
    out.search = async (/** @type {string} */ q, opts = {}) => fn.call(table, q, guardArgs(opts, 'search', false))
  }
  return out
}

/** @param {string} a @param {string} b */
function editDistance(a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  // Iterative DP with two rows — O(min(a,b)) memory.
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  let curr = new Array(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        curr[j - 1] + 1,        // insertion
        prev[j]   + 1,          // deletion
        prev[j - 1] + cost,     // substitution
      )
    }
    [prev, curr] = [curr, prev]
  }
  return prev[b.length]
}
