// capabilities.js — what a capability IS, derived rather than declared.
//
// `FJS-D139`: a capability is a REFERENCE to something the seed already states,
// never a name in a list. So there is no `enum Capability` to keep in step, and
// this module is the one place the set comes from — validation, the grant
// column, the affordance, the snapshot and a role editor's picker all read it.
//
// Four forms, each already declared once:
//
//   Invoice.delete            an operation on a model      the model
//   Invoice.void              a named move                 @@transitions
//   Invoice.note              a column, on write           @capability
//   NetworkAttachment.create  an operation on a join model the model
//
// Which operations a model contributes is `FJS-D140`: create, update, delete and
// every named move by default, plus read where the model wrote @@capabilities(all).
// Read is opt-in because its refusal is the silent one.

// A move the ENGINE makes and a person never does is not a grant anybody could
// hold, so offering one in a role editor is offering nothing. A schema marks it
// two ways and both count:
//
//   @gate(8)  getLevel is clamped to 7, so no caller passes and asSystem()
//             bypasses the check entirely. Gate 9 is LOCKED and refuses
//             asSystem() too.
//   @system   the move is refused unless the call opts in with { system: true },
//             which is the application saying it makes this move itself.
//
// The second is the more precise spelling and the one an application reaches
// for — the parser already refuses `@system @gate(>=8)` as two answers to one
// question, so the two never overlap. Reading only the gate gave basecamp's
// `Server` eight move capabilities where three are human, which is the noise
// this exclusion exists to keep out of a picker (`FJS-506`).
const machineMove = (t) => t.gate === 8 || t.gate === 9 || t.system === true

const WRITE_OPS = ['create', 'update', 'delete']

/**
 * Every capability this schema declares, sorted by model then by name.
 *
 * Each entry is `{ name, model, kind, target, gate }` — `kind` is
 * `'operation' | 'move' | 'column'`, `target` is the operation, move or column
 * name, and `gate` is a move's own `@gate(N)` where it has one.
 *
 * A model that does not carry `@@capabilities` contributes nothing: the switch
 * is what says this model is graded that way at all.
 */
export function capabilitiesForModel(model) {
  const decl = model.attributes?.find(a => a.kind === 'capabilities')
  if (!decl) return []

  const out = []
  const add = (kind, target, gate = null) =>
    out.push({ name: `${model.name}.${target}`, model: model.name, kind, target, gate })

  if (decl.read) add('operation', 'read')
  for (const op of WRITE_OPS) add('operation', op)

  for (const attr of (model.attributes ?? []).filter(a => a.kind === 'transitions')) {
    for (const [name, t] of Object.entries(attr.transitions ?? {})) {
      if (machineMove(t)) continue
      add('move', name, t.gate ?? null)
    }
  }

  for (const field of model.fields ?? []) {
    if (field.attributes?.some(a => a.kind === 'capability')) add('column', field.name)
  }

  return out
}

export function deriveCapabilities(schema) {
  return (schema.models ?? [])
    .flatMap(capabilitiesForModel)
    .sort((a, b) => a.model.localeCompare(b.model) || a.name.localeCompare(b.name))
}

/** The same set as names alone — what a grant column validates a value against. */
export function capabilityNames(schema) {
  return new Set(deriveCapabilities(schema).map(c => c.name))
}

/**
 * The same declarations keyed by model, for a reader that has a model in hand and
 * needs an answer per call rather than a list — enforcement asks this one.
 *
 * `{ [model]: { read: boolean, moves: Set<string>, columns: Set<string> } }`, and a
 * model absent from it declares no grid. One reading of the attributes, because two
 * would let the set a picker OFFERS drift from the set the boundary ENFORCES.
 */
export function capabilityDeclarations(schema) {
  const out = {}
  for (const c of deriveCapabilities(schema)) {
    const m = out[c.model] ??= { read: false, moves: new Set(), columns: new Set(), moveFields: new Set() }
    if (c.kind === 'operation' && c.target === 'read') m.read = true
    if (c.kind === 'move')   m.moves.add(c.target)
    if (c.kind === 'column') m.columns.add(c.target)
  }

  // Which COLUMN a move writes, for the reader that has a payload rather than a
  // move name. `update({ data: { status: 'cancelled' } })` and
  // `transition(id, 'cancel')` are the same move and both are enforced, so a
  // payload naming the transitions field is graded by the move it resolves to
  // and not by the model's `update` — which resolution needs the stored row and
  // therefore happens where the transition itself is checked.
  for (const model of schema.models ?? []) {
    const m = out[model.name]
    if (!m) continue
    for (const attr of model.attributes.filter(a => a.kind === 'transitions'))
      if (attr.field) m.moveFields.add(attr.field)
  }
  return out
}

/** The name of the synthesised type. A schema declaring its own is refused. */
export const CAPABILITY_TYPE = 'Capability'

/**
 * Synthesise `enum Capability` from the schema's own surface, so a column that
 * HOLDS capabilities is declared `Capability[]` rather than `String[]`.
 *
 * `FJS-D147`. It is a real enum rather than a new kind of thing, and that is the
 * whole of the implementation: an enum ARRAY is already stored as a JSON column,
 * already validated member-by-member at the write (SQLite cannot CHECK the
 * elements of a JSON array, so that loop IS the boundary), already emitted into
 * `$defs` with its values, and already answered by `db.$enums`. So the typo
 * refusal, the storage and the picker all come from machinery that exists.
 *
 * The type is only synthesised where something declares the grid — a
 * `Capability[]` over an empty set would refuse every value it was ever given,
 * which is a column that cannot be written and cannot say why.
 */
export function expandCapabilityType(schema) {
  const errors = []
  const declared = (schema.enums ?? []).find(e => e.name === CAPABILITY_TYPE)
  const usedBy   = []

  for (const model of schema.models ?? [])
    for (const field of model.fields ?? [])
      if (field.type?.name === CAPABILITY_TYPE) usedBy.push(`${model.name}.${field.name}`)

  // An app's own `enum Capability` and the synthesised one cannot both be the
  // answer, and silently preferring either is the failure D139 exists to remove:
  // one spelling would validate against a hand-written list and read as though it
  // validated against the derived one.
  if (declared) {
    errors.push(
      `enum ${CAPABILITY_TYPE}: '${CAPABILITY_TYPE}' is synthesised by litestone from the models that ` +
      `declare @@capabilities, so it cannot also be declared. A capability is a reference to something ` +
      `the schema already states (FJS-D139) — rename this enum, or drop it and let the type derive.`)
    return errors
  }

  const values = [...capabilityNames(schema)]
  if (!values.length) {
    if (usedBy.length) errors.push(
      `${usedBy.join(', ')}: declared ${CAPABILITY_TYPE}[], but no model declares @@capabilities — ` +
      `the set is derived from the models that opt in, so it is empty and every value written here ` +
      `would be refused. Add @@capabilities to the models this grant is meant to cover.`)
    return errors
  }

  schema.enums.push({
    name:     CAPABILITY_TYPE,
    values:   values.map(name => ({ name, comments: [] })),
    comments: [],
    synthesised: true,
  })

  // Only once a model has opted in. Below that `auth().capabilities` is the app's
  // own bag and this package has nothing to say about what is in it; `FJS-D151`
  // only claims the name for schemas that declare the grid.
  errors.push(...checkCapabilityLiterals(schema, new Set(values)))
  return errors
}

/**
 * Every `'Some.name' in auth().capabilities` written by hand, wherever it appears.
 *
 * The grant column is not the only place a capability name is HELD — the read tier
 * has no attribute of its own, because a column read must strip rather than refuse
 * (a capability throws, and refusing would 403 a caller who never named the column),
 * so it is spelled as the predicate `FJS-D129` already compiles both ways. That
 * literal refers to nothing the parser resolves, which is the one door `FJS-D139`'s
 * *a typo cannot exist* does not cover on its own: a misspelling makes the predicate
 * permanently false, so the column vanishes for EVERYBODY — holders included — with
 * no parse error, no read error and nothing in a log. Measured.
 *
 * A deep walk rather than a switch over node kinds: the pattern is one shape and a
 * node type this misses is a hole that fails silent in exactly the way being closed.
 */
function collectCapabilityLiterals(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) collectCapabilityLiterals(n, out); return out }
  if (node.type === 'compare' && node.op === 'in' &&
      node.right?.type === 'auth' && node.right.field === 'capabilities' &&
      node.left?.type === 'literal' && typeof node.left.value === 'string')
    out.push(node.left.value)
  for (const v of Object.values(node)) collectCapabilityLiterals(v, out)
  return out
}

function checkCapabilityLiterals(schema, legal) {
  const errors = []
  const seen   = new Set()

  const check = (exprHolder, where) => {
    for (const name of collectCapabilityLiterals(exprHolder)) {
      const key = `${where}:${name}`
      if (legal.has(name) || seen.has(key)) continue
      seen.add(key)
      errors.push(
        `${where}: '${name}' in auth().capabilities names no capability this schema declares. ` +
        `A capability is a reference (FJS-D139), so this predicate can never be true and the rule it ` +
        `guards is dead — silently. ${suggestion(name, legal)}`)
    }
  }

  for (const model of schema.models ?? []) {
    for (const attr of model.attributes ?? [])
      if (attr.kind === 'allow' || attr.kind === 'deny' || attr.kind === 'scope')
        check(attr.expr, `Model '${model.name}'`)
    for (const field of model.fields ?? [])
      for (const attr of field.attributes ?? [])
        if (attr.kind === 'fieldAllow')
          check(attr.expr, `Model '${model.name}', field '${field.name}'`)
  }
  return errors
}

/** Nearest legal name by a cheap edit distance, or a pointer to the whole list. */
function suggestion(name, legal) {
  let best = null, bestD = Infinity
  for (const c of legal) {
    if (Math.abs(c.length - name.length) > 4) continue
    const d = editDistance(name, c)
    if (d < bestD) { bestD = d; best = c }
  }
  return bestD <= Math.max(2, Math.floor(name.length / 3))
    ? `Did you mean '${best}'?`
    : `The set is derived from the models declaring @@capabilities.`
}

function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = tmp
    }
  }
  return prev[b.length]
}
