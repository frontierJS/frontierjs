// capability.js — the grid the ladder cannot express, enforced.
//
// A `@@gate` grades WHO is asking on one axis; a capability grades WHAT is being
// asked for, and the two are ANDed with the gate as the floor (`FJS-D146`). Both
// checks therefore fire at the same seam — this plugin's hooks and GatePlugin's
// run off the same twenty-odd call sites, so a read path that grades one grades
// the other and neither can be checked where the other is not.
//
// ─── How this differs from a policy, and why it may ──────────────────────────
//
// A `@@allow` compiles into the WHERE: it FILTERS, and a wrong one is an empty
// screen. A capability THROWS. That is safe here and is not safe there — a policy
// decides WHICH ROWS, so refusing by name would answer *there is a row you may not
// see*, while a capability is verb-scoped and row-independent: `Invoice.void`
// leaks nothing about any invoice. Refusing is also the only useful answer, since
// a caller who does not hold it will not hold it for the next row either.
//
// ─── What asSystem() does to it ──────────────────────────────────────────────
//
// Drops it. A capability is PERMISSION, not scope — the distinction `FJS-519`
// draws — so it goes the way the gate and the row policies go, and unlike the
// tenancy denies, which are scope and survive.
//
// Nothing enforces read unless the model wrote `@@capabilities(all)` (`FJS-D140`):
// a missing write capability announces itself in the error, a missing read one is
// a blank screen, so the silent half is the one you opt into.

import { Plugin, AccessDeniedError } from '../core/plugin.js'
import { collectNestedOps, collectIncludedModels } from './reach.js'
import { capabilityDeclarations } from '../core/capabilities.js'

// The caller's set. `FJS-D151` names it `auth().capabilities`, and `FJS-D149` makes
// it per tenant — so no principal is an empty set rather than a bypass, which is
// what makes an anonymous caller fail closed on a model that declares a grid.
//
// A principal carrying the key as something other than a list is an application
// bug in the resolver that built it, and it is thrown for rather than read as
// nothing: an empty set looks exactly like *this person was granted nothing*, and
// that is a refusal somebody would spend an afternoon debugging in the data.
function heldBy(auth, model) {
  const held = auth?.capabilities
  if (held == null) return EMPTY
  if (held instanceof Set)  return held
  if (Array.isArray(held))  return new Set(held)
  throw new Error(
    `auth().capabilities must be an array or a Set — got ${typeof held}, grading "${model}". ` +
    `The principal resolver that built this caller is what sets it`)
}

const EMPTY = new Set()

export class CapabilityPlugin extends Plugin {
  onInit(schema, ctx) {
    this._decls       = capabilityDeclarations(schema)
    this._relationMap = ctx.relationMap ?? {}
  }

  /** Does this model declare a grid at all, and does the grid cover reads? */
  declares(model) { return this._decls[model] ?? null }

  _check(model, op, ctx) {
    const decl = this._decls[model]
    if (!decl) return                       // no grid declared, nothing to hold
    if (ctx.isSystem) return                // permission, not scope
    if (op === 'read' && !decl.read) return // writes-and-moves is the default

    requireCapability(model, op, ctx)
  }

  /**
   * The model-wide `update` grant, required only for the part of the payload no
   * FINER grant covers.
   *
   * A finer tier REPLACES the coarse one for the action it names; it does not
   * add to it. The whole complaint the column tier answers is that *set a
   * variable* arrives bundled with *edit everything else about the environment*
   * — so if writing a `@capability` column ALSO demanded `Model.update`, the
   * grant could still only be handed to somebody who already held the one it
   * was meant to withhold, and the tier would be decoration. Measured that way
   * round first.
   *
   * So an update naming only graded columns is graded by those columns alone. An
   * update naming anything else needs `Model.update` as well, because the rest
   * of the payload is exactly what that grant is about. A write naming NO
   * columns at all (a bare touch) is an ordinary update.
   */
  _checkUpdate(model, args, ctx) {
    const decl = this._decls[model]
    if (!decl) return
    if (ctx.isSystem) return

    const data = args?.data
    const keys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : []

    // Three kinds of key, not two. A transitions field is graded by the MOVE it
    // resolves to, which needs the stored row — so it is checked where the
    // transition is, and is neither graded nor charged to `update` here.
    // Otherwise a grant of `Server.reboot` alone could not reboot anything.
    const graded   = keys.filter(k => decl.columns.has(k))
    const moves    = keys.filter(k => decl.moveFields.has(k) && !decl.columns.has(k))
    const ungraded = keys.filter(k => !decl.columns.has(k) && !decl.moveFields.has(k))

    for (const k of graded) requireCapability(model, k, ctx)
    if (ungraded.length || (!graded.length && !moves.length)) requireCapability(model, 'update', ctx)
  }

  async onBeforeRead(model, args, ctx) {
    this._check(model, 'read', ctx)
    for (const target of collectIncludedModels(args, model, this._relationMap))
      this._check(target, 'read', ctx)
  }

  async onBeforeCreate(model, args, ctx) {
    this._check(model, 'create', ctx)
    for (const { model: m, op } of collectNestedOps(args?.data, model, this._relationMap))
      this._check(m, op, ctx)
  }

  async onBeforeUpdate(model, args, ctx) {
    this._checkUpdate(model, args, ctx)
    for (const { model: m, op } of collectNestedOps(args?.data, model, this._relationMap))
      this._check(m, op, ctx)
  }

  async onBeforeDelete(model, args, ctx) {
    this._check(model, 'delete', ctx)
  }
}

/**
 * The one refusal. Exported because two checks live outside this plugin's hooks and
 * must refuse identically: a named move, which is graded where the transition's own
 * `@gate` is, and a `@capability` column, which is graded against the payload.
 *
 * `AccessDeniedError` rather than a class of its own — every layer above already
 * maps it to a 403, and the capability name travels as its own field so a reader
 * does not have to parse the sentence. `required` stays the gate's numeric level
 * and is left absent here.
 */
export function requireCapability(model, action, ctx) {
  const name = `${model}.${action}`
  if (heldBy(ctx.auth, model).has(name)) return
  throw new AccessDeniedError(
    `"${name}" requires the capability "${name}" and this caller holds no such grant`,
    { model, operation: action, capability: name })
}

/**
 * The escalation guard: **you may only grant what you hold**.
 *
 * A property of the COLUMN rather than a predicate each application restates
 * (`FJS-D147`) — a `Capability[]` says what it holds, so the rule comes with it and
 * there is no model that can forget to write it. Without one, a role editor is a
 * route from any tenant administrator to every capability in the application.
 *
 * A SUBSET rather than a comparison of two ranks, and that is the substance. This
 * repo's own hand-written version grades role LEVELS ordinally, so a developer (2)
 * may hand out billing (1) — two sets neither of which contains the other, and a
 * sideways move is invisible to any comparison of two numbers (`FJS-529`).
 *
 * Seeding roles therefore belongs to `asSystem()`: a caller holding nothing can
 * grant nothing, which is the rule working rather than an obstacle to route around.
 *
 * Separation of duties — *the person who administers access must not use it* — is
 * the real exception this forbids, it is squarely in the 20%, and the hatch is a
 * service method that writes its own rule. `grantable Capability[]` is the shape
 * that would generalize it and is deliberately not shipped: a blunt off-switch on a
 * security rule is the worse of the two.
 */
export function requireGrantSubset(model, field, values, ctx) {
  const held   = heldBy(ctx.auth, model)
  const wanted = Array.isArray(values) ? values : values == null ? [] : [values]
  const over   = wanted.filter(v => !held.has(String(v)))
  if (!over.length) return

  throw new AccessDeniedError(
    `${model}.${field}: cannot grant ${over.map(v => `"${v}"`).join(', ')} — a caller may only grant ` +
    `capabilities they hold themselves, and this one holds ${held.size ? `${held.size} of them` : 'none'}. ` +
    `Seeding roles is asSystem()'s job; handing out authority you do not have is what this refuses.`,
    { model, operation: 'write', capability: over[0] })
}
