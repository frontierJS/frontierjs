// db/test/schema.test.ts
// The Data realm's contract, pinned.
//
// Everything here was verified by hand while the schema was being built; this
// file is what keeps it true. It deliberately tests BEHAVIOUR against a real
// database rather than asserting on the schema AST — a `.lite` file that parses
// is not the same as one that works.
//
// Litestone is imported by RELATIVE PATH, not by package specifier: an edit to
// the workspace source must be what these tests run against.

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { parseFile, generateDDL, createClient } from '../../../litestone/src/index.js'

const SCHEMA     = join(import.meta.dir, '..', 'schema.lite')
const MIGRATION  = join(import.meta.dir, '..', 'migrations', '001_initial_schema.sql')
const ENC_KEY    = '0'.repeat(64)

let dir: string

function freshDb(name = 'bc.db') {
  const path = join(dir, `${Math.random().toString(36).slice(2)}-${name}`)
  const raw  = new Database(path)
  raw.run(readFileSync(MIGRATION, 'utf8'))
  raw.close()
  return path
}

/**
 * A client on a throwaway database.
 *
 * The path is steered through DATABASE_URL, not the `db` option, because
 * schema.lite declares `database main { path env("DATABASE_URL", …) }` and a
 * declaration WINS over `createClient({ db })` — silently, with no error and no
 * warning. When this file passed `db: dbPath`, every test quietly opened the
 * DEVELOPMENT database instead: assertions started reading rows from local
 * dev data (a Secret named 'deploy-key' where the test had written 'k'), and
 * the tests were writing to it too.
 *
 * env() is read when the schema is parsed, so it has to be set before the call
 * rather than passed to it.
 */
async function client(dbPath: string, opts: Record<string, unknown> = {}) {
  process.env.DATABASE_URL = dbPath
  return createClient({ path: SCHEMA, encryptionKey: ENC_KEY, ...opts })
}

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'basecamp-db-')) })
afterAll(()  => { rmSync(dir, { recursive: true, force: true }) })

// ─── The schema itself ───────────────────────────────────────────────────────

describe('schema.lite', () => {
  test('parses with no errors and no warnings', () => {
    const r = parseFile(SCHEMA)
    expect(r.errors ?? []).toEqual([])
    expect(r.warnings ?? []).toEqual([])
  })

  test('every model name is PascalCase singular — Invariant 2', () => {
    const r = parseFile(SCHEMA)
    const bad = r.schema.models
      .map((m: any) => m.name)
      .filter((n: string) => !/^[A-Z][A-Za-z0-9]*$/.test(n) || n.endsWith('s'))
    expect(bad).toEqual([])
  })

  test('no model is named Service — the API realm owns that noun', () => {
    const r = parseFile(SCHEMA)
    const names = r.schema.models.map((m: any) => m.name)
    expect(names).not.toContain('Service')
    expect(names).toContain('App')
  })

  test('auth owns the four identity model names — renaming one breaks auth.ts', () => {
    const r = parseFile(SCHEMA)
    const names = r.schema.models.map((m: any) => m.name)
    for (const required of ['User', 'Credential', 'Session', 'Verification'])
      expect(names).toContain(required)
  })

  test('gates are absent — a KNOWN GAP against Invariant 6, not a decision', () => {
    // Pins the current state so the gap stays visible; not an endorsement.
    // Invariant 6 has no exceptions and this schema owes 24 declarations
    // (levels in db/README.md §Access control). When they land, INVERT this
    // test rather than deleting it.
    //
    // The blocker is the per-workspace mapping, not the resolver: Litestone's
    // default was fixed 2026-08-04 and now grades a verified auth session
    // USER(4); example/api/gate.ts is the four-line pattern for the rest.
    const r = parseFile(SCHEMA)
    const gated = r.schema.models
      .filter((m: any) => m.attributes.some((a: any) => a.kind === 'gate'))
      .map((m: any) => m.name)
    expect(gated).toEqual([])
  })

  test('soft-deleting parents cascade — archiving a workspace cannot orphan live rows', () => {
    const r = parseFile(SCHEMA)
    const byName = Object.fromEntries(r.schema.models.map((m: any) => [m.name, m]))
    for (const parent of ['Account', 'Workspace', 'Project', 'Environment', 'App']) {
      const sd = byName[parent].attributes.find((a: any) => a.kind === 'softDelete')
      expect(sd?.cascade).toBe(true)
    }
  })
})

// ─── The generated migration ─────────────────────────────────────────────────

describe('generated migration', () => {
  test('is in sync with schema.lite', () => {
    // Same comparison `bun run db:check` makes — a hand-edit to the SQL fails here.
    const r      = parseFile(SCHEMA)
    const onDisk = readFileSync(MIGRATION, 'utf8')
    expect(onDisk).toContain(generateDDL(r.schema))
  })

  test('applies to a fresh database — 24 tables, FK-clean, all STRICT', () => {
    const path = freshDb()
    const raw  = new Database(path)
    const tables = raw.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all().map((r: any) => r.name)
    expect(tables.length).toBe(24)
    expect(raw.query('PRAGMA foreign_key_check').all()).toEqual([])

    const nonStrict = tables.filter((t: string) => {
      const sql = (raw.query('SELECT sql FROM sqlite_master WHERE name=?').get(t) as any)?.sql ?? ''
      return !/STRICT/.test(sql)
    })
    expect(nonStrict).toEqual([])
    raw.close()
  })

  test('columns are verbatim camelCase, not snake_case', () => {
    const raw  = new Database(freshDb())
    const cols = raw.query('SELECT name FROM pragma_table_info(?)').all('workspace_member').map((r: any) => r.name)
    expect(cols).toContain('workspaceId')
    expect(cols).not.toContain('workspace_id')
    raw.close()
  })
})

// ─── Field protection ────────────────────────────────────────────────────────
// VISION.md constraint 7: secrets are held, never shown.

describe('Secret.data protection', () => {
  test('is encrypted at rest — the key is not in the database file', async () => {
    const path = freshDb()
    const db   = await client(path)
    const sys  = db.asSystem()
    const ws   = await seedWorkspace(sys)
    const KEY  = JSON.stringify({ priv: 'SSH-PRIVATE-KEY-DO-NOT-LEAK' })

    await sys.secret.create({ data: { workspaceId: ws.id, name: 'deploy-key', kind: 'ssh_key', data: KEY } })
    db.$close()

    expect(readFileSync(path, 'latin1')).not.toContain('SSH-PRIVATE-KEY-DO-NOT-LEAK')
  })

  test('round-trips intact for a system reader', async () => {
    const db  = await client(freshDb())
    const sys = db.asSystem()
    const ws  = await seedWorkspace(sys)
    const KEY = JSON.stringify({ priv: 'ROUND-TRIP' })

    const s = await sys.secret.create({ data: { workspaceId: ws.id, name: 'k', kind: 'ssh_key', data: KEY } })
    expect(s.data).toBe(KEY)
    db.$close()
  })

  test('the data column is absent entirely for a non-system reader', async () => {
    const db  = await client(freshDb())
    const sys = db.asSystem()
    const ws  = await seedWorkspace(sys)
    await sys.secret.create({ data: { workspaceId: ws.id, name: 'k', kind: 'ssh_key', data: '{"priv":"x"}' } })

    const [row] = await db.$setAuth({ userId: 'u1', role: 'admin' }).secret.findMany({ limit: 1 })
    expect(row.name).toBe('k')          // metadata is readable
    expect('data' in row).toBe(false)   // the value is not merely null — the key is gone
    db.$close()
  })

  test('is String, not Json — @encrypted on a Json field destroys the value', () => {
    // Litestone stringifies with String(obj) before encrypting, so a Json
    // column round-trips as "[object Object]". Remove this guard only when
    // that is fixed upstream.
    const r     = parseFile(SCHEMA)
    const model = r.schema.models.find((m: any) => m.name === 'Secret')
    const field = model.fields.find((f: any) => f.name === 'data')
    expect(field.type.name).toBe('String')
    expect(field.attributes.some((a: any) => a.kind === 'encrypted')).toBe(true)
  })
})

// ─── Audit trail ─────────────────────────────────────────────────────────────

describe('audit logging', () => {
  test('records that a secret was written without recording the secret', async () => {
    const auditDir = join(dir, `audit-${Math.random().toString(36).slice(2)}`)
    const cwd      = process.cwd()
    process.chdir(dir)                     // logger path is CWD-relative

    const db  = await client(freshDb(), { databases: { audit: { path: auditDir } } })
    const sys = db.asSystem()
    const ws  = await seedWorkspace(sys)

    const s = await sys.secret.create({
      data: { workspaceId: ws.id, name: 'deploy-key', kind: 'ssh_key', data: '{"priv":"AUDIT-LEAK-CANARY"}' },
    })
    await sys.secret.update({ where: { id: s.id }, data: { data: '{"priv":"ROTATED-CANARY"}' } })

    await new Promise(r => setTimeout(r, 1500))   // buffered ~1s, flushed on exit
    db.$close()
    process.chdir(cwd)

    const file = join(auditDir, 'auditLogs.jsonl')
    expect(existsSync(file)).toBe(true)
    const log = readFileSync(file, 'utf8')

    // The access is recorded …
    const entries = log.trim().split('\n').map(l => JSON.parse(l)).filter(e => e.model === 'secret')
    expect(entries.map(e => e.operation)).toContain('create')
    expect(entries.map(e => e.operation)).toContain('update')

    // … the value is not.
    expect(log).not.toContain('AUDIT-LEAK-CANARY')
    expect(log).not.toContain('ROTATED-CANARY')
    expect(log).toContain('[redacted]')
  })
})

// ─── Access control without gates ────────────────────────────────────────────
// @@gate was removed on 2026-08-04 (see DECISIONS.md). These pin what that did
// and — more importantly — what it did NOT weaken.

describe('access control after gate removal', () => {

  test('no GatePlugin is auto-installed, so an ordinary caller can read', async () => {
    // The whole point of the removal: with any @@gate present, Litestone
    // auto-installs a resolver that grades every auth session VISITOR(1) and
    // this read would throw ACCESS_DENIED.
    const db  = await client(freshDb())
    const sys = db.asSystem()
    const ws  = await seedWorkspace(sys)
    await sys.app.create({ data: {
      workspaceId: ws.id, environmentId: await seedEnvironmentId(sys, ws), name: 'web', slug: 'web',
    } })

    const rows = await db.$setAuth({ userId: 'u1', role: 'user' }).app.findMany({ limit: 1 })
    expect(rows.length).toBe(1)
    db.$close()
  })

  test('@guarded/@encrypted STILL protect without gates — field policy is not GatePlugin', async () => {
    // Field policy keys on asSystem(), not on a level, so removing gates does
    // not expose a single protected column. This is the safety net for the
    // whole decision.
    const db  = await client(freshDb())
    const sys = db.asSystem()
    const ws  = await seedWorkspace(sys)
    await sys.secret.create({ data: {
      workspaceId: ws.id, name: 'k', kind: 'ssh_key', data: '{"priv":"STILL-PROTECTED"}',
    } })

    const [row] = await db.$setAuth({ userId: 'u1', role: 'admin' }).secret.findMany({ limit: 1 })
    expect(row.name).toBe('k')
    expect('data' in row).toBe(false)
    db.$close()
  })

  test('re-adding a single gate would re-arm the auto-install — the trap, pinned', async () => {
    // Not a test of Basecamp but of the thing that bit us: one @@gate in an
    // inline schema is enough for enforcement to appear with no plugin asked for.
    const gatedSchema = `
      model Thing {
        id   String @id @default(uuid())
        name String
        @@gate(read: ADMINISTRATOR)
      }
    `
    const db = await createClient({ schema: gatedSchema, db: ':memory:' })
    await expect(db.$setAuth({ userId: 'u1', role: 'admin' }).thing.findMany({ limit: 1 }))
      .rejects.toThrow(/ACCESS_DENIED|requires level/)
    db.$close()
  })
})

// ─── Compatibility with @frontierjs/auth ─────────────────────────────────────

describe('auth compatibility', () => {
  test('createUser({email, name, role}) succeeds — Basecamp adds no required column', async () => {
    // auth.ts writes exactly these three fields. Any Basecamp addition to User
    // that is NOT nullable or defaulted makes user creation throw.
    const db   = await client(freshDb())
    const user = await db.asSystem().user.create({
      data: { email: 'sam@example.com', name: 'Sam', role: 'user' },
    })
    expect(user.id).toBeTruthy()
    expect(user.kind).toBe('human')          // defaulted
    expect(user.accountId).toBe(null)        // nullable
    db.$close()
  })

  test('accountId is String — an Int column could not hold Account.id', async () => {
    const db   = await client(freshDb())
    const sys  = db.asSystem()
    const acct = await sys.account.create({ data: { slug: 'acme', displayName: 'Acme' } })
    const user = await sys.user.create({ data: { email: 'a@b.co', accountId: acct.id } })
    expect(user.accountId).toBe(acct.id)
    expect(acct.id).toMatch(/^[0-9a-f-]{36}$/)
    db.$close()
  })
})

// ─── helpers ─────────────────────────────────────────────────────────────────

async function seedEnvironmentId(sys: any, ws: any) {
  const proj = await sys.project.create({
    data: { workspaceId: ws.id, name: 'Dash', slug: `dash-${Math.random().toString(36).slice(2, 8)}` },
  })
  const env = await sys.environment.create({
    data: { projectId: proj.id, workspaceId: ws.id, name: 'Production', slug: 'prod', tier: 'production' },
  })
  return env.id
}

async function seedWorkspace(sys: any) {
  const acct = await sys.account.create({ data: { slug: `acme-${Math.random().toString(36).slice(2, 8)}`, displayName: 'Acme' } })
  const user = await sys.user.create({ data: { email: `u${Math.random().toString(36).slice(2, 8)}@x.co`, accountId: acct.id } })
  return sys.workspace.create({
    data: { accountId: acct.id, name: 'Fleet', slug: `fleet-${Math.random().toString(36).slice(2, 8)}`, ownerId: user.id },
  })
}
