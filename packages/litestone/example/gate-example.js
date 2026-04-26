// example/gate-example.js
// Demonstrates the GatePlugin with different user types.
// Self-contained — creates its own temp DB, no seed required.
//
// Run:  bun example/gate-example.js
//
// ─── @@gate notation ─────────────────────────────────────────────────────────
// The four positions map to: Read . Create . Update . Delete
// Levels: 0=STRANGER 1=VISITOR 2=READER 3=CREATOR 4=USER 5=ADMIN 6=OWNER
//         7=SYSTEM (only asSystem()) 8=LOCKED (nobody, ever)
//
// Numeric:  @@gate("2.4.4.6")
// Named:    @@gate("READER.USER.USER.OWNER")   ← same thing, coming soon
// Shorthand:@@gate("4")                        ← all four ops = USER
// Partial:  @@gate("2.4")                      ← R=READER C=USER U=USER D=USER

import { createClient, GatePlugin, LEVELS, AccessDeniedError } from '../src/index.js'
import { parse }                from '../src/core/parser.js'
import { generateDDL }          from '../src/core/ddl.js'
import { splitStatements }      from '../src/core/migrate.js'
import { Database }             from 'bun:sqlite'
import { dirname, resolve }     from 'path'
import { fileURLToPath }        from 'url'
import { unlinkSync, existsSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Role-based level map (Spatie-style) ──────────────────────────────────────
// Each role gets per-model numeric levels. getLevel() returns a number — Litestone
// never sees your role system, it just sees the integer.

const ROLE_LEVELS = {
  'field-manager': {
    accounts:   LEVELS.READER,        // 2 — read only
    products:   LEVELS.READER,        // 2 — read only
    leads:      LEVELS.USER,          // 4 — full member access
    messages:   LEVELS.USER,          // 4 — can send messages
    audit_logs: LEVELS.STRANGER,      // 0 — no access at all
    config:     LEVELS.STRANGER,      // 0 — no access at all
  },
}

// ─── Demo schema ──────────────────────────────────────────────────────────────
// Each model shows the numeric gate AND the equivalent named levels as a comment.
// Two models (messages, config) also show how you might express one-liner semantics.

const SCHEMA = `
  // Public-ish data — anyone can read, admins manage, owners delete
  // @@gate("2.5.5.6") = READER.ADMIN.ADMIN.OWNER
  model accounts {
    id   Integer @id
    name Text
    @@gate("2.5.5.6")
  }

  // Catalog — even visitors browse, members buy, owners delete
  // @@gate("1.4.4.6") = VISITOR.USER.USER.OWNER
  model products {
    id    Integer @id
    name  Text
    price Integer
    @@gate("1.4.4.6")
  }

  // Sales leads — creators can add, members manage, owners delete
  // @@gate("3.3.4.6") = CREATOR.CREATOR.USER.OWNER
  model leads {
    id   Integer @id
    name Text
    @@gate("3.3.4.6")
  }

  // Messaging — readers see it, members write it, admins moderate (delete)
  // Named syntax: separate read from write from delete
  model messages {
    id   Integer @id
    body Text
    @@gate(read: READER, write: USER, delete: ADMINISTRATOR)
  }

  // Audit trail — admins read, only background jobs write, delete is locked forever
  // @@gate("5.8.8.9") = ADMIN.SYSTEM.SYSTEM.LOCKED
  model audit_logs {
    id     Integer @id
    action Text
    @@gate("5.8.8.9")
  }

  // System config — admins read, only system creates, everything else locked
  // Named syntax with write shorthand then override delete
  model config {
    id  Integer @id
    key Text
    val Text
    @@gate(read: ADMINISTRATOR, create: SYSTEM, update: LOCKED, delete: LOCKED)  // SYSADMIN also ok for read
  }
`

// ─── Bootstrap temp DB ────────────────────────────────────────────────────────

const TMP = resolve(__dirname, '.gate-demo.db')
if (existsSync(TMP)) unlinkSync(TMP)

const parseResult = parse(SCHEMA)
if (!parseResult.valid) {
  console.error('Schema errors:', parseResult.errors.join('\n'))
  process.exit(1)
}

const tmpDb = new Database(TMP)
for (const stmt of splitStatements(generateDDL(parseResult.schema))) {
  if (!stmt.startsWith('PRAGMA')) tmpDb.run(stmt)
}
tmpDb.run(`INSERT INTO accounts   VALUES (1, 'Acme Corp')`)
tmpDb.run(`INSERT INTO products   VALUES (1, 'Widget', 4999)`)
tmpDb.run(`INSERT INTO leads      VALUES (1, 'Alice')`)
tmpDb.run(`INSERT INTO messages   VALUES (1, 'Hello world')`)
tmpDb.run(`INSERT INTO audit_logs VALUES (1, 'user.login')`)
tmpDb.run(`INSERT INTO config     VALUES (1, 'max_users', '50')`)
tmpDb.close()

// ─── Client ───────────────────────────────────────────────────────────────────

const db = await createClient(TMP, parseResult, {
  plugins: [
    new GatePlugin({
      async getLevel(user, model) {
        if (!user)             return LEVELS.STRANGER
        if (!user.verifiedAt)  return LEVELS.VISITOR

        if (user.isSystemAdmin)  return LEVELS.SYSADMIN
        if (user.ownedAccountIds?.includes(user.currentAccountId))
          return LEVELS.OWNER

        if (user.isSuperAdmin) return LEVELS.ADMINISTRATOR

        // Per-role, per-model levels
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

// ─── Helper ───────────────────────────────────────────────────────────────────

async function attempt(label, fn) {
  try {
    const result = await fn()
    const count  = Array.isArray(result) ? result.length : result?.id ? 1 : '?'
    console.log(`  ✓  ${label.padEnd(28)} → ${count} row(s)`)
  } catch (e) {
    if (e.code === 'ACCESS_DENIED') {
      const req = e.required === 8 ? 'LOCKED' : e.required === 7 ? 'SYSTEM' : `${e.required}`
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

console.log('\n╔════════════════════════════════════════════════════════════════╗')
console.log('║  Litestone GatePlugin — access level demo                      ║')
console.log('╠════════════════════════════════════════════════════════════════╣')
console.log('║  accounts   "2.5.5.6"  READER  . ADMIN  . ADMIN  . OWNER      ║')
console.log('║  products   "1.4.4.6"  VISITOR . USER   . USER   . OWNER      ║')
console.log('║  leads      "3.3.4.6"  CREATOR . CREATOR. USER   . OWNER      ║')
console.log('║  messages   (read:READER, write:USER, delete:ADMIN)             ║')
console.log('║  audit_logs "5.8.8.9"  ADMIN   . SYSTEM . SYSTEM . LOCKED     ║')
console.log('║  config     (read:ADMIN, create:SYSTEM, update:LOCKED, d:LOCKED)║')
console.log('╚════════════════════════════════════════════════════════════════╝\n')

for (const { label, user } of scenarios) {
  console.log(`─── ${label}`)
  const userDb = db.$setAuth(user)
  await attempt('read   accounts',   () => userDb.accounts.findMany())
  await attempt('read   products',   () => userDb.products.findMany())
  await attempt('read   leads',      () => userDb.leads.findMany())
  await attempt('read   audit_logs', () => userDb.audit_logs.findMany())
  await attempt('read   config',     () => userDb.config.findMany())
  await attempt('create lead',       async () => {
    const r = await userDb.leads.create({ data: { id: 999, name: 'Test' } })
    await db.asSystem().leads.delete({ where: { id: 999 } }).catch(() => {})
    return r
  })
  console.log()
}

console.log('─── asSystem() — bypasses all gates ─────────────────────────────')
const sys = db.asSystem()
await attempt('read   audit_logs', () => sys.audit_logs.findMany())
await attempt('create audit_log',  async () => {
  const r = await sys.audit_logs.create({ data: { id: 888, action: 'system.test' } })
  await sys.audit_logs.delete({ where: { id: 888 } })
  return r
})
await attempt('create config',     async () => {
  const r = await sys.config.create({ data: { id: 888, key: 'debug', val: 'true' } })
  await sys.config.delete({ where: { id: 888 } })
  return r
})
await attempt('update config',     () =>
  sys.config.update({ where: { id: 1 }, data: { val: '100' } })
)

db.$close()
unlinkSync(TMP)
console.log()
