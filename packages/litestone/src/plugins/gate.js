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

// ─── Level constants ──────────────────────────────────────────────────────────

export const LEVELS = {
  STRANGER:      0,
  VISITOR:       1,
  READER:        2,
  CREATOR:       3,
  USER:          4,
  ADMINISTRATOR: 5,
  OWNER:         6,
  SYSADMIN:      7,   // global system admin — real human, revocable
  SYSTEM:        8,   // asSystem() only — background jobs, migrations
  LOCKED:        9,   // absolute wall — not even asSystem() passes
}

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
  if (required === 9)
    throw new AccessDeniedError(
      `"${model}.${operation}" is LOCKED — not accessible via ORM`,
      { model, operation, required, got: userLevel }
    )
  if (required === 8 && userLevel !== 8)
    throw new AccessDeniedError(
      `"${model}.${operation}" requires SYSTEM access (use asSystem())`,
      { model, operation, required, got: userLevel }
    )
  if (userLevel < required)
    throw new AccessDeniedError(
      `"${model}.${operation}" requires level ${required}, user has level ${userLevel}`,
      { model, operation, required, got: userLevel }
    )
}

// ─── Nested write preflight ───────────────────────────────────────────────────

function collectNestedOps(data, tableName, relationMap, ops = []) {
  if (!data || typeof data !== 'object') return ops
  const rels = relationMap[tableName] ?? {}
  const OP_KEYS = new Set(['create', 'connect', 'connectOrCreate', 'disconnect', 'delete', 'update'])

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

// ─── GatePlugin ───────────────────────────────────────────────────────────────

export class GatePlugin extends Plugin {
  constructor({ getLevel } = {}) {
    super()
    // Default: unauthenticated → STRANGER (0), authenticated → USER (4).
    // Provide getLevel to map your own roles/permissions to levels.
    if (getLevel !== undefined && typeof getLevel !== 'function')
      throw new Error('GatePlugin: getLevel must be a function')
    getLevel = getLevel ?? ((user) => user ? LEVELS.USER : LEVELS.STRANGER)
    this._getLevel    = getLevel
    this._accessMap   = {}
    this._relationMap = {}
  }

  onInit(schema, ctx) {
    this._accessMap   = buildAccessMap(schema)
    this._relationMap = ctx.relationMap ?? {}
  }

  // ── Resolve level for this request's auth user ──────────────────────────────
  // If asSystem() is active, always returns SYSTEM(8) — bypasses @@gate.
  // If auth is null (no $setAuth called), getLevel receives null → typically 0.
  // User getLevel() return values are clamped to 0–7 (SYSADMIN max).

  _resolver(ctx) {
    if (ctx.isSystem) return async () => 8  // SYSTEM level
    const auth = ctx.auth ?? null
    return makeLevelCache(this._getLevel, auth)
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
// Standard getLevel function for FrontierJS apps.
//
// Expects these fields on the auth object (all optional — missing = lower level):
//   verifiedAt   DateTime   — email verified
//   activatedAt  DateTime   — account activated (plan chosen, invite accepted, etc.)
//   role         Text?      — any truthy role string = full user
//   isAdmin      Boolean?   — app-level admin
//   isOwner      Boolean?   — account/tenant owner
//   isSystemAdmin Boolean?  — global system admin
//
// Level scale:
//   0  STRANGER      — not logged in
//   1  VISITOR       — logged in, email unverified
//   2  READER        — verified, not yet activated (read-only)
//   3  CREATOR       — activated, no role assigned (submit but can't manage)
//   4  USER          — has a role, full CRUD
//   5  ADMINISTRATOR — isAdmin
//   6  OWNER         — isOwner (account/tenant owner)
//   7  SYSADMIN      — isSystemAdmin (real human, global)

export function FrontierGateGetLevel(user) {
  if (!user)              return LEVELS.STRANGER
  if (!user.verifiedAt)   return LEVELS.VISITOR
  if (!user.activatedAt)  return LEVELS.READER
  if (!user.role)         return LEVELS.CREATOR
  if (user.isSystemAdmin) return LEVELS.SYSADMIN
  if (user.isOwner)       return LEVELS.OWNER
  if (user.isAdmin)       return LEVELS.ADMINISTRATOR
  return LEVELS.USER
}
