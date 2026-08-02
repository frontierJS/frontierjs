// example/gate-example.js
// Demonstrates gates with different user types.
// Self-contained — creates its own temp DB, no seed required.
//
// Run:  bun example/gate-example.js
//
// ─── @@gate notation ─────────────────────────────────────────────────────────
// Named (canonical):  @@gate(read: READER, write: USER, delete: OWNER)
//   Keys: read, create, update, delete — plus `write`, shorthand for
//   create+update+delete unless one is given explicitly.
// Compact:            @@gate("2.4.4.6")   ← same gate as digits, R.C.U.D
// Shorthand:          @@gate("4")         ← all four ops = USER
//
// Levels: 0=STRANGER 1=VISITOR 2=READER 3=CREATOR 4=USER 5=ADMINISTRATOR
//         6=OWNER 7=SYSADMIN 8=SYSTEM (only asSystem()) 9=LOCKED (nobody, ever)
//
// Gates are enforced by default whenever a model declares @@gate — this demo
// installs its own GatePlugin to show a custom getLevel() with per-role,
// per-model levels (Spatie-style).

import { createClient, autoMigrate, GatePlugin, LEVELS } from '../src/index.js'
import { dirname, resolve }       from 'path'
import { fileURLToPath }          from 'url'
import { unlinkSync, existsSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Role-based level map (Spatie-style) ──────────────────────────────────────
// Each role gets per-model numeric levels. getLevel() returns a number — Litestone
// never sees your role system, it just sees the integer.

const ROLE_LEVELS = {
  'field-manager': {
    Account:  LEVELS.READER,        // 2 — read only
    Product:  LEVELS.READER,        // 2 — read only
    Lead:     LEVELS.USER,          // 4 — full member access
    Message:  LEVELS.USER,          // 4 — can send messages
    AuditLog: LEVELS.STRANGER,      // 0 — no access at all
    Config:   LEVELS.STRANGER,      // 0 — no access at all
  },
}

// ─── Demo schema ──────────────────────────────────────────────────────────────
// Model names are PascalCase and singular — always (accessor = camelCase:
// model AuditLog → db.auditLog). Named gates are canonical; the compact digit
// equivalent is shown in each comment.

const SCHEMA = `
  // Public-ish data — anyone verified can read, admins manage, owners delete
  // Compact: @@gate("2.5.5.6")
  model Account {
    id   Int @id
    name String
    @@gate(read: READER, write: ADMINISTRATOR, delete: OWNER)
  }

  // Catalog — even visitors browse, members buy, owners delete
  // Compact: @@gate("1.4.4.6")
  model Product {
    id    Int @id
    name  String
    price Int
    @@gate(read: VISITOR, write: USER, delete: OWNER)
  }

  // Sales leads — creators can add, members manage, owners delete
  // Compact: @@gate("3.3.4.6")
  model Lead {
    id   Int @id
    name String
    @@gate(read: CREATOR, create: CREATOR, update: USER, delete: OWNER)
  }

  // Messaging — readers see it, members write it, admins moderate (delete)
  model Message {
    id   Int @id
    body String
    @@gate(read: READER, write: USER, delete: ADMINISTRATOR)
  }

  // Audit trail — admins read, only background jobs write, delete locked forever
  // Compact: @@gate("5.8.8.9")
  model AuditLog {
    id     Int @id
    action String
    @@gate(read: ADMINISTRATOR, write: SYSTEM, delete: LOCKED)
  }

  // System config — admins read, only system creates, everything else locked
  model Config {
    id  Int @id
    key String
    val String
    @@gate(read: ADMINISTRATOR, create: SYSTEM, update: LOCKED, delete: LOCKED)
  }
`

// ─── Bootstrap temp DB ────────────────────────────────────────────────────────
// createClient + autoMigrate + ORM seeding — no hand-written DDL or raw SQL.

const TMP = resolve(__dirname, '.gate-demo.db')
if (existsSync(TMP)) unlinkSync(TMP)

const db = await createClient({
  db:     TMP,
  schema: SCHEMA,
  plugins: [
    new GatePlugin({
      async getLevel(user, model) {
        if (!user)             return LEVELS.STRANGER
        if (!user.verifiedAt)  return LEVELS.VISITOR

        if (user.isSystemAdmin)  return LEVELS.SYSADMIN
        if (user.ownedAccountIds?.includes(user.currentAccountId))
          return LEVELS.OWNER

        if (user.isSuperAdmin) return LEVELS.ADMINISTRATOR

        // Per-role, per-model levels — model is the model name ('Lead')
        const rolePerms = ROLE_LEVELS[user.role]
        if (rolePerms) return rolePerms[model] ?? LEVELS.VISITOR

        // Standard hierarchy fallback
        if (user.role === 'admin')  return LEVELS.ADMINISTRATOR
        if (user.role === 'member') return LEVELS.USER
        if (user.role === 'viewer') return LEVELS.READER
        return LEVELS.VISITOR
      }
    })
  ]
})

autoMigrate(db)

{
  const sys = db.asSystem()
  await sys.account.create({ data: { id: 1, name: 'Acme Corp' } })
  await sys.product.create({ data: { id: 1, name: 'Widget', price: 4999 } })
  await sys.lead.create({ data: { id: 1, name: 'Alice' } })
  await sys.message.create({ data: { id: 1, body: 'Hello world' } })
  await sys.auditLog.create({ data: { id: 1, action: 'user.login' } })
  await sys.config.create({ data: { id: 1, key: 'max_users', val: '50' } })
}

// ─── Helper ───────────────────────────────────────────────────────────────────

async function attempt(label, fn) {
  try {
    const result = await fn()
    const count  = Array.isArray(result) ? result.length : result?.id ? 1 : '?'
    console.log(`  ✓  ${label.padEnd(28)} → ${count} row(s)`)
  } catch (e) {
    if (e.code === 'ACCESS_DENIED') {
      const req = e.required === 9 ? 'LOCKED' : e.required === 8 ? 'SYSTEM' : `${e.required}`
      console.log(`  ✗  ${label.padEnd(28)} → denied (user=${e.got ?? '?'} < ${req})`)
    } else {
      console.log(`  !  ${label.padEnd(28)} → ${e.message}`)
    }
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────────

const scenarios = [
  { label: 'Stranger (unauthenticated)', user: null },
  { label: 'Visitor  (unverified)',       user: { role: 'member', verifiedAt: null } },
  { label: 'Reader   (verified viewer)',  user: { role: 'viewer', verifiedAt: '2024-01-01' } },
  { label: 'FieldMgr (role-based map)',   user: { role: 'field-manager', verifiedAt: '2024-01-01' } },
  { label: 'Member   (standard user)',    user: { role: 'member', verifiedAt: '2024-01-01' } },
  { label: 'Admin    (administrator)',    user: { role: 'admin', verifiedAt: '2024-01-01' } },
  { label: 'SysAdmin (isSystemAdmin)',    user: { role: 'member', verifiedAt: '2024-01-01', isSystemAdmin: true } },
  { label: 'Owner    (account owner)',    user: { role: 'member', verifiedAt: '2024-01-01',
                                                  currentAccountId: 1, ownedAccountIds: [1] } },
]

console.log('\n╔══════════════════════════════════════════════════════════════════════╗')
console.log('║  Litestone gates — access level demo                                 ║')
console.log('╠══════════════════════════════════════════════════════════════════════╣')
console.log('║  Account  (read:READER,  write:ADMINISTRATOR, delete:OWNER)          ║')
console.log('║  Product  (read:VISITOR, write:USER,          delete:OWNER)          ║')
console.log('║  Lead     (read:CREATOR, create:CREATOR, update:USER, delete:OWNER)  ║')
console.log('║  Message  (read:READER,  write:USER,          delete:ADMINISTRATOR)  ║')
console.log('║  AuditLog (read:ADMINISTRATOR, write:SYSTEM,  delete:LOCKED)         ║')
console.log('║  Config   (read:ADMINISTRATOR, create:SYSTEM, update+delete:LOCKED)  ║')
console.log('╚══════════════════════════════════════════════════════════════════════╝\n')

for (const { label, user } of scenarios) {
  console.log(`─── ${label}`)
  const userDb = db.$setAuth(user)
  await attempt('read   Account',  () => userDb.account.findMany())
  await attempt('read   Product',  () => userDb.product.findMany())
  await attempt('read   Lead',     () => userDb.lead.findMany())
  await attempt('read   AuditLog', () => userDb.auditLog.findMany())
  await attempt('read   Config',   () => userDb.config.findMany())
  await attempt('create Lead',     async () => {
    const r = await userDb.lead.create({ data: { id: 999, name: 'Test' } })
    await db.asSystem().lead.delete({ where: { id: 999 } }).catch(() => {})
    return r
  })
  console.log()
}

console.log('─── asSystem() — bypasses all gates except LOCKED ───────────────')
const sys = db.asSystem()
await attempt('read   AuditLog', () => sys.auditLog.findMany())
await attempt('create AuditLog', async () => {
  const r = await sys.auditLog.create({ data: { id: 888, action: 'system.test' } })
  // cleanup delete is LOCKED — swallow it so the create's ✓ shows through
  await sys.auditLog.delete({ where: { id: 888 } }).catch(() => {})
  return r
})
await attempt('create Config',   async () => {
  const r = await sys.config.create({ data: { id: 888, key: 'debug', val: 'true' } })
  await sys.config.delete({ where: { id: 888 } }).catch(() => {})
  return r
})
await attempt('update Config',   () =>
  sys.config.update({ where: { id: 1 }, data: { val: '100' } })
)

db.$close()
unlinkSync(TMP)
console.log()
