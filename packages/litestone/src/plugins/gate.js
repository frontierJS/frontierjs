// src/plugins/gate.js — Official Litestone Gate Plugin
//
// Schema-defined numeric access control. Each model declares the minimum
// user level required for each CRUD operation. The host app provides a
// getLevel() function that returns a level (0–7) for the current user.
//
// ─── Level scale ─────────────────────────────────────────────────────────────
//
//   0  STRANGER      — unauthenticated
//   1  VISITOR       — authenticated but unverified
//   2  READER        — verified, reads public content
//   3  CREATOR       — can create content
//   4  USER          — full member, standard read/write
//   5  ADMINISTRATOR — admin access
//   6  OWNER         — account/tenant owner, full CRUD
//   7  SYSADMIN      — global system admin (1–2 devs); set user.isSystemAdmin = true
//   8  SYSTEM        — internal only; only asSystem() reaches this level
//   9  LOCKED        — hard wall, nothing gets through ever (not even asSystem)
//
// ─── How SYSADMIN differs from SYSTEM ────────────────────────────────────────
//
//   SYSADMIN (7) is a real human — a super-admin account in your user table.
//   Your getLevel() function can return 7 when user.isSystemAdmin is true.
//   They go through normal auth ($setAuth), appear in audit logs, and can be
//   revoked by removing isSystemAdmin from their account.
//
//   SYSTEM (8) is for background jobs, migrations, and internal processes.
//   It is granted by asSystem() only — getLevel() is never called.
//   It has no user identity, no audit trail, and cannot be set in the DB.
//
// ─── Schema syntax ───────────────────────────────────────────────────────────
//
//   @@gate("R.C.U.D")     — four positions: Read, Create, Update, Delete
//   @@gate("2")           — all ops require level 2+
//   @@gate("2.4")         — R=2, C=4, U=4(inherit), D=4(inherit)
//   @@gate("2.4.5")       — R=2, C=4, U=5, D=5(inherit)
//   @@gate("2.4.5.6")     — fully explicit
//   @@gate("5.8.8.9")     — R=ADMIN, C/U=SYSTEM, D=LOCKED
//   @@gate("7.8.9.9")     — R=SYSADMIN, C=SYSTEM, U/D=LOCKED
//
// ─── Install ──────────────────────────────────────────────────────────────────
//
//   import { GatePlugin, LEVELS } from '@frontierjs/litestone/plugins/gate'
//
//   const db = createClient('./app.db', './schema.lite', {
//     plugins: [
//       new GatePlugin({
//         getLevel: async (user, model) => {
//           if (!user) return LEVELS.STRANGER
//           if (user.isSystemAdmin) return LEVELS.SYSADMIN   // ← the new level
//           if (user.role === 'admin') return LEVELS.ADMINISTRATOR
//           return LEVELS.USER
//         }
//       })
//     ]
//   })
//
//   const userDb = db.$setAuth(req.user)
//   db.asSystem()   // ← SYSTEM level, for background jobs only

import { Plugin, AccessDeniedError } from '../core/plugin.js'
import { collectNestedOps, collectIncludedModels } from './reach.js'

// ─── Level constants ──────────────────────────────────────────────────────────

// The scale, the comparison and the grader are `@frontierjs/toolbelt/gate` and
// are re-exported here rather than declared. Three realms need the ladder and
// the dependency direction forbids two of them from asking this package, so it
// was a hand copy at four places and drifted (`FJS-520`, ruled `FJS-D197`).
// The kit is substrate, below the graph, so litestone, junction and sierra may
// all import it and there is one definition again.
import { LEVELS, levelPasses, levelName, gradeStanding } from '@frontierjs/toolbelt/gate'

export { LEVELS, levelPasses, levelName }

// ─── Parse @@gate string ──────────────────────────────────────────────────────
// "2.4.5.6" → { read: 2, create: 4, update: 5, delete: 6 }
// Missing positions cascade from left (less dangerous → more dangerous)

export function parseGateString(str) {
  const parts = String(str).split('.').map(Number)

  if (parts.some(isNaN))
    throw new Error(`@@gate: invalid value "${str}" — expected numbers separated by dots`)

  if (parts.some(n => n < 0 || n > 9 || !Number.isInteger(n)))
    throw new Error(`@@gate: levels must be integers 0–9, got "${str}"`)

  const [r, c, u, d] = parts

  const read   = r ?? 0
  const create = c ?? read
  const update = u ?? create
  const del    = d ?? update

  return { read, create, update, delete: del }
}

// ─── Validate gate tuple ──────────────────────────────────────────────────────
// Levels must be non-decreasing (read ≤ create ≤ update ≤ delete)
// except for SYSTEM(8) and LOCKED(9) which are sentinels and can appear anywhere

function isSentinel(n) { return n === 8 || n === 9 }

export function validateGate(gate, modelName) {
  const ops = ['read', 'create', 'update', 'delete']
  let prev = 0
  for (const op of ops) {
    const n = gate[op]
    if (!isSentinel(n) && !isSentinel(prev) && n < prev) {
      throw new Error(
        `@@gate on "${modelName}": levels must be non-decreasing in R.C.U.D order ` +
        `(${op}=${n} is less than previous=${prev})`
      )
    }
    if (!isSentinel(n)) prev = n
  }
}

// ─── Build access map from parsed schema ─────────────────────────────────────

function buildAccessMap(schema) {
  const map = {}
  for (const model of schema.models) {
    const gateAttr = model.attributes?.find(a => a.kind === 'gate')
    if (!gateAttr) continue
    const gate = parseGateString(gateAttr.value)
    validateGate(gate, model.name)
    map[model.name] = gate
  }
  return map
}

// ─── Level cache ──────────────────────────────────────────────────────────────
// getLevel() is called at most once per model per request — cached on ctx.auth.
// Clamp to 0–7: user code can return SYSADMIN(7) via user.isSystemAdmin.
// Only the runtime (asSystem) can set SYSTEM(8).

const SYSTEM_RESOLVER = async () => 8

function makeLevelCache(getLevel, auth) {
  const cache = new Map()
  return async (model) => {
    if (!cache.has(model)) {
      const level = await getLevel(auth, model)
      cache.set(model, Math.max(0, Math.min(7, level ?? 0)))
    }
    return cache.get(model)
  }
}

// ─── Access check ─────────────────────────────────────────────────────────────

function checkLevel(required, userLevel, model, operation) {
  if (levelPasses(required, userLevel)) return

  if (required === 9)
    throw new AccessDeniedError(
      `"${model}.${operation}" is LOCKED — not accessible via ORM`,
      { model, operation, required, got: userLevel }
    )
  if (required === 8)
    throw new AccessDeniedError(
      `"${model}.${operation}" requires SYSTEM access (use asSystem())`,
      { model, operation, required, got: userLevel }
    )
  throw new AccessDeniedError(
    `"${model}.${operation}" requires level ${required}, user has level ${userLevel}`,
    { model, operation, required, got: userLevel }
  )
}

// ─── GatePlugin ───────────────────────────────────────────────────────────────

export class GatePlugin extends Plugin {
  constructor({ getLevel } = {}) {
    super()
    // The default is the shipped grader, and it used to be a second one written
    // here: `user ? USER : STRANGER`, which read nothing but *is there a user*
    // and therefore graded an `isSystemAdmin` caller USER(4). Against
    // `gradeStanding` it disagreed on 212 of the 216 combinations of the fields
    // a session carries — a whole ladder's worth of standing, silently absent
    // for anyone who constructed the plugin without a resolver (`FJS-D197`).
    // Pass `getLevel` to map an app's own roles onto the scale.
    if (getLevel !== undefined && typeof getLevel !== 'function')
      throw new Error('GatePlugin: getLevel must be a function')
    getLevel = getLevel ?? gradeStanding
    this._getLevel    = getLevel
    this._accessMap   = {}
    this._relationMap = {}
    // Per-ctx level resolvers. A ctx object is stable for the lifetime of a
    // scoped client ($setAuth), so caching here delivers the documented
    // "getLevel() called at most once per model per request" behavior.
    this._resolvers   = new WeakMap()
  }

  onInit(schema, ctx) {
    this._accessMap   = buildAccessMap(schema)
    this._relationMap = ctx.relationMap ?? {}
    // Publish the level resolver onto ctx. GatePlugin owns the 0–7 scale and
    // the per-request cache; anything else that needs a level (the @@transitions
    // gate check in client.js) asks here rather than calling getLevel itself,
    // so one user gets one level per model per request.
    //
    // The caller passes its own ctx: asSystem() spreads this ctx into a new
    // object, and _resolver keys its cache on identity.
    ctx.levelFor = (model, forCtx) => this._resolver(forCtx ?? ctx)(model)

    // The DECLARED level beside the caller's own, for the same reason: a second
    // reading of `@@gate` is how an artefact comes to certify access the plugin
    // does not grant. `$readAs` is the caller — it grades a row for somebody who
    // is not this client's principal, so it needs both halves and may spell
    // neither. `null` where the model declares no gate for that operation.
    ctx.gateFor = (model, op) => this._accessMap[model]?.[op] ?? null
  }

  // ── Resolve level for this request's auth user ──────────────────────────────
  // If asSystem() is active, always returns SYSTEM(8) — bypasses @@gate.
  // If auth is null (no $setAuth called), getLevel receives null → typically 0.
  // User getLevel() return values are clamped to 0–7 (SYSADMIN max).

  _resolver(ctx) {
    if (ctx.isSystem) return SYSTEM_RESOLVER  // SYSTEM level
    // Keyed on the FLAVOR, falling back to the ctx object for a ctx that is not
    // the shared one. A table's ctx is shared across every flavor since
    // `FJS-722`, so keying on it gave the first caller's level to everyone —
    // an `isSystemAdmin` reader answered at whatever level the process saw
    // first, which is a wrong ANSWER and not an error.
    const key = ctx._flavor ?? ctx
    let resolver = this._resolvers.get(key)
    if (!resolver) {
      resolver = makeLevelCache(this._getLevel, ctx.auth ?? null)
      this._resolvers.set(key, resolver)
    }
    return resolver
  }

  // ── Gate check helper ───────────────────────────────────────────────────────

  async _check(model, op, ctx) {
    const gate = this._accessMap[model]
    if (!gate) return
    const required  = gate[op]
    if (required == null) return
    const userLevel = await this._resolver(ctx)(model)
    checkLevel(required, userLevel, model, op)
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  async onBeforeRead(model, args, ctx) {
    await this._check(model, 'read', ctx)
    for (const target of collectIncludedModels(args, model, this._relationMap))
      await this._check(target, 'read', ctx)
  }

  // ── Create ──────────────────────────────────────────────────────────────────

  async onBeforeCreate(model, args, ctx) {
    await this._check(model, 'create', ctx)
    const nested  = collectNestedOps(args?.data, model, this._relationMap)
    const resolve = this._resolver(ctx)
    for (const { model: m, op } of nested) {
      const gate = this._accessMap[m]
      if (!gate) continue
      const required = gate[op] ?? gate.create
      const level    = await resolve(m)
      checkLevel(required, level, m, op)
    }
  }

  // ── Update ──────────────────────────────────────────────────────────────────

  async onBeforeUpdate(model, args, ctx) {
    await this._check(model, 'update', ctx)
    const nested  = collectNestedOps(args?.data, model, this._relationMap)
    const resolve = this._resolver(ctx)
    for (const { model: m, op } of nested) {
      const gate = this._accessMap[m]
      if (!gate) continue
      const required = gate[op] ?? gate.update
      const level    = await resolve(m)
      checkLevel(required, level, m, op)
    }
  }

  // ── Delete ──────────────────────────────────────────────────────────────────

  async onBeforeDelete(model, args, ctx) {
    await this._check(model, 'delete', ctx)
  }
}

// ─── FrontierGateGetLevel ──────────────────────────────────────────────────────────
// Standard getLevel function for FrontierJS apps, and the resolver auto-installed
// when a schema declares @@gate and the app supplies no GatePlugin of its own.
//
// Expects these fields on the auth object (all optional):
//   verifiedAt    DateTime?  — when the user verified (email, phone, …)
//   activatedAt   DateTime?  — when the account became active
//   role          String?    — any truthy role string = full user
//   isAdmin       Boolean?   — app-level admin
//   isOwner       Boolean?   — account/tenant owner
//   isSystemAdmin Boolean?   — global system admin
//
// ── undefined is not null, and the difference is the whole design ────────────
//
//   undefined → the app does not model this stage. NOT an objection.
//   null      → the app models it and this user has not reached it.
//
// So an app with no verification flow leaves verifiedAt unset and its sessions
// grade USER; an app that has one sets it to null until the user verifies, and
// those sessions grade VISITOR. Absence never means "not yet" — otherwise every
// app would have to restate a lifecycle it does not have just to make @@gate
// usable at all.
//
// This used to test `!user.verifiedAt`, which collapses that distinction:
// undefined is falsy, so EVERY session from an app without a verification flow
// graded VISITOR(1) — below the USER(4) an ordinary model needs to read. With
// gates auto-installed, that 403s the entire API of any such app.
//
// ── Explicit standing wins over the lifecycle ────────────────────────────────
//
// The isSystemAdmin / isOwner / isAdmin checks run BEFORE the role check. They
// used to run after `if (!user.role) return CREATOR`, so a system admin who
// carried no role string graded CREATOR(3) — contradicting this function's own
// documented scale. An owner who never completed an activation step is still
// the owner.
//
// The name this package has always exported for the shipped grader, and it is
// `@frontierjs/toolbelt/gate`'s `gradeStanding` under an alias. Junction's
// `sessionGateLevel` is the same binding from the other side: it was a hand
// copy across a boundary this package cannot cross, the two carried a comment
// each saying *change one, change both*, and they drifted anyway — 8 of 216
// sessions graded CREATOR(3) here and USER(4) there, so one `@@gate("4")` read
// was a 403 or a 200 depending on which resolver an app had installed
// (`FJS-520`, ruled `FJS-D197`). The scale is on the kit; what to read about a
// caller is in `gradeStanding`'s own doc comment.
export const FrontierGateGetLevel = gradeStanding
