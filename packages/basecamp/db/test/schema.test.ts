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
// The API realm's half of the widget vocabulary. Imported rather than restated:
// the whole point of the first Dashboard test is that these two lists are one
// list, and a copy here would be a third.
import { WIDGET_KINDS } from '../../api/src/services/dashboards/kinds.ts'
// The reclaim vocabulary, for the same reason: the schema cannot hold it (an
// enum array does not parse), so the test that keeps it a single home has to
// read the one home rather than restate it.
import { RECLAIM_TARGET_NAMES } from '../../api/src/services/cleanup/targets.ts'
// The hub's copy of the two status vocabularies. It exists so a bad value is
// refused by name at the API rather than by a CHECK constraint message; this
// import is what keeps it a copy of the schema rather than a second opinion.
import { USER_STATUSES, WORKSPACE_STATUSES } from '../../api/src/services/hub/hub.service.ts'

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

  test('applies to a fresh database — 33 tables, FK-clean, all STRICT', () => {
    const path = freshDb()
    const raw  = new Database(path)
    const tables = raw.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all().map((r: any) => r.name)
    // 25 when `Domain` landed 2026-08-06 — `App.domain`, one nullable string,
    // became a model so an app can answer on more than one hostname and carry
    // a certificate per hostname. 27 since `NotificationChannel` and the
    // `AlertRuleChannel` join replaced `AlertRule.channels`, a Json array of
    // ids pointing at rows that did not exist. 29 since `FeatureFlag` and
    // `FlagOverride` — the mock keyed per-environment state by TIER NAME, and
    // an override now points at a real Environment row. 30 since `ApiKey`, the
    // token Basecamp issues rather than presents. 31 since `Volume` — the first
    // model here that is OBSERVED rather than declared. 33 since `Dashboard`
    // and `DashboardWidget` — a widget names a kind from a declared vocabulary,
    // so a saved view is an arrangement rather than a stored query. 37 since
    // `Recipe`, `RecipeRun`, `DiskUsage` and `CleanupRun` — the two ways this
    // app acts on a machine, one arbitrary and one declared.
    expect(tables.length).toBe(37)
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

// ─── Alert delivery ──────────────────────────────────────────────────────────
// `AlertRule.channels` used to be `Json @default("[]")` — an array of ids
// pointing at rows no model declared. These three tests are what a Json array
// could not answer: is the id real, does the pair stay unique, and does the
// link go when the channel does.

describe('AlertRuleChannel — the join that replaced a Json array of ids', () => {
  async function seedRuleAndChannel(sys: any): Promise<{ ws: any; rule: any; chan: any }> {
    const ws   = await seedWorkspace(sys)
    const rule = await sys.alertRule.create({
      data: { workspaceId: ws.id, name: 'CPU high', metricName: 'cpu', severity: 'critical' },
    })
    const chan = await sys.notificationChannel.create({
      data: { workspaceId: ws.id, name: '#ops-alerts', kind: 'slack', config: { channel: '#ops' } },
    })
    return { ws, rule, chan }
  }

  test('a link to a channel that does not exist is refused', async () => {
    const db  = await client(freshDb())
    const sys = db.asSystem() as any
    const { rule } = await seedRuleAndChannel(sys)

    // The whole point of the migration away from Json: this used to be a
    // successful write of a dangling id.
    await expect(
      sys.alertRuleChannel.create({ data: { ruleId: rule.id, channelId: 'no-such-channel' } }),
    ).rejects.toThrow()
    db.$close()
  })

  test('the same channel cannot be attached to a rule twice', async () => {
    const db  = await client(freshDb())
    const sys = db.asSystem() as any
    const { rule, chan } = await seedRuleAndChannel(sys)

    await sys.alertRuleChannel.create({ data: { ruleId: rule.id, channelId: chan.id } })
    await expect(
      sys.alertRuleChannel.create({ data: { ruleId: rule.id, channelId: chan.id } }),
    ).rejects.toThrow()
    db.$close()
  })

  test('deleting a channel takes its links with it — no rule is left pointing at nothing', async () => {
    const db  = await client(freshDb())
    const sys = db.asSystem() as any
    const { rule, chan } = await seedRuleAndChannel(sys)
    await sys.alertRuleChannel.create({ data: { ruleId: rule.id, channelId: chan.id } })

    // NotificationChannel is @@softDelete, so `.remove()` stamps deletedAt and
    // leaves the row — and its links — in place on purpose. The FK cascade only
    // shows on a real DELETE, which is raw SQL, which needs asSystem().
    await sys.sql`DELETE FROM "notification_channel" WHERE "id" = ${chan.id}`

    expect(await sys.alertRuleChannel.count({ where: { ruleId: rule.id } })).toBe(0)
    db.$close()
  })
})

// ─── API keys ────────────────────────────────────────────────────────────────
// The model owns the operational half of a token @frontierjs/auth minted. What
// these check is the half that is a schema decision rather than a service one:
// the token is not here, the workspace boundary is a foreign key, and a revoked
// key is still a row.

describe('ApiKey — the token Basecamp issues', () => {
  async function seedKey(sys: any, over: Record<string, unknown> = {}) {
    const ws   = await seedWorkspace(sys)
    const user = await sys.user.create({ data: { email: `k${Math.random().toString(36).slice(2, 8)}@x.co` } })
    const key  = await sys.apiKey.create({
      data: {
        workspaceId: ws.id, userId: user.id, name: 'ci-bot',
        tokenHint: 'fjs_AbCd…wXyZ', credentialId: 'cred-1',
        scopes: ['servers:read'], ...over,
      },
    })
    return { ws, user, key }
  }

  test('there is no column that could hold a token', () => {
    // The whole security property, asserted against the DDL rather than taken
    // on trust from the model: a column added later called `token` would make
    // the service's "shown exactly once" promise quietly false, and nothing
    // else in this repo would notice.
    const ddl   = readFileSync(MIGRATION, 'utf8')
    const start = ddl.indexOf('CREATE TABLE IF NOT EXISTS "api_key"')
    const table = ddl.slice(start, start + ddl.slice(start).indexOf(') STRICT;'))

    expect(table).toContain('"tokenHint"')
    expect(table).not.toMatch(/"token"\s+TEXT/)
    expect(table).not.toContain('"secret"')
    expect(table).not.toContain('"value"')
  })

  test('scopes round-trip as an array, not as the string "[]"', async () => {
    // FJS-120: a JSON Schema default of "[]" on an array field used to reach
    // the boundary as the two characters rather than an empty list.
    const db  = await client(freshDb())
    const sys = db.asSystem() as any
    const { key } = await seedKey(sys, { scopes: ['servers:read', 'projects:write'] })

    expect(key.scopes).toEqual(['servers:read', 'projects:write'])

    const bare = await sys.apiKey.create({
      data: { workspaceId: key.workspaceId, userId: key.userId, name: 'no-scopes', tokenHint: 'fjs_x…y' },
    })
    expect(bare.scopes).toEqual([])
    db.$close()
  })

  test('a key cannot be created in a workspace that does not exist', async () => {
    const db  = await client(freshDb())
    const sys = db.asSystem() as any
    const { user } = await seedKey(sys)

    await expect(sys.apiKey.create({
      data: { workspaceId: 'no-such-workspace', userId: user.id, name: 'x', tokenHint: 'fjs_x…y' },
    })).rejects.toThrow()
    db.$close()
  })

  test('two keys in one workspace cannot share a name', async () => {
    const db  = await client(freshDb())
    const sys = db.asSystem() as any
    const { ws, user } = await seedKey(sys)

    await expect(sys.apiKey.create({
      data: { workspaceId: ws.id, userId: user.id, name: 'ci-bot', tokenHint: 'fjs_p…q' },
    })).rejects.toThrow()
    db.$close()
  })

  test('a revoked key is still a row — revocation is a state, not a deletion', async () => {
    // ApiKey declares no @@softDelete on purpose: revoked is visible and
    // deleted is gone, two states rather than four. So a revoke has to leave
    // something an ordinary read can still see.
    const db  = await client(freshDb())
    const sys = db.asSystem() as any
    const { key } = await seedKey(sys)

    const revoked = await sys.apiKey.update({
      where: { id: key.id },
      data:  { revokedAt: new Date().toISOString(), credentialId: null },
    })
    expect(revoked.revokedAt).toBeTruthy()
    expect(revoked.credentialId).toBe(null)
    expect(await sys.apiKey.count({ where: { id: key.id } })).toBe(1)
    db.$close()
  })

  test('deleting the workspace takes its keys with it', async () => {
    const db  = await client(freshDb())
    const sys = db.asSystem() as any
    const { ws, key } = await seedKey(sys)

    // Workspace is @@softDelete(cascade), so the FK cascade only shows on a
    // real DELETE — raw SQL, which needs asSystem().
    await sys.sql`DELETE FROM "workspace" WHERE "id" = ${ws.id}`
    expect(await sys.apiKey.count({ where: { id: key.id } })).toBe(0)
    db.$close()
  })

  test('issuing and revoking a key are both in the row-level audit trail', async () => {
    // @@log(audit) on ApiKey. Handing out and taking away access is the class
    // of thing the trail exists for, so it is asserted rather than assumed —
    // and the hint is not a secret, so unlike Secret.data it may appear.
    const auditDir = join(dir, `audit-apikey-${Math.random().toString(36).slice(2)}`)
    const cwd      = process.cwd()
    process.chdir(dir)                     // logger path is CWD-relative

    const db  = await client(freshDb(), { databases: { audit: { path: auditDir } } })
    const sys = db.asSystem() as any
    const { key } = await seedKey(sys)
    await sys.apiKey.update({
      where: { id: key.id },
      data:  { revokedAt: new Date().toISOString(), credentialId: null },
    })

    await new Promise(r => setTimeout(r, 1500))   // buffered ~1s, flushed on exit
    db.$close()
    process.chdir(cwd)

    const log = readFileSync(join(auditDir, 'auditLogs.jsonl'), 'utf8')
    const entries = log.trim().split('\n').map(l => JSON.parse(l)).filter(e => e.model === 'api_key')
    expect(entries.map(e => e.operation)).toContain('create')
    expect(entries.map(e => e.operation)).toContain('update')
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

// ─── Volumes ─────────────────────────────────────────────────────────────────
// The first OBSERVED model here — Docker made the disk, an agent found it, and
// the table is a picture rather than a record. What these pin is the part of
// that which is a schema decision: where its tenancy comes from, that the same
// disk cannot be recorded twice, and that its size is stored in the unit the
// agent reports.

describe('Volume — observed, not declared', () => {
  async function seedServer(sys: any) {
    const ws = await seedWorkspace(sys)
    const s  = await sys.server.create({
      data: { workspaceId: ws.id, name: 'gw-01', slug: `gw-${Math.random().toString(36).slice(2, 8)}` },
    })
    return { ws, server: s }
  }

  test('carries no workspaceId — its tenancy is the join through its server', () => {
    // Asserted against the DDL, because a denormalised copy added later would
    // make two owners of one answer and every query would still work. The
    // service's scope (`serversOf`) is written on the assumption there is no
    // other route to a volume's workspace.
    const ddl   = readFileSync(MIGRATION, 'utf8')
    const start = ddl.indexOf('CREATE TABLE IF NOT EXISTS "volume"')
    const table = ddl.slice(start, start + ddl.slice(start).indexOf(') STRICT;'))

    expect(table).toContain('"serverId"')
    expect(table).not.toContain('"workspaceId"')
    // Bytes, and only bytes. A `sizeGb` column would be the same number twice,
    // rounded in the copy nothing can un-round.
    expect(table).toMatch(/"sizeBytes"\s+INTEGER/)
    expect(table).not.toContain('"sizeGb"')
  })

  test('the same disk cannot be recorded twice on one server', async () => {
    const db  = await client(freshDb())
    const sys = db.asSystem() as any
    const { server } = await seedServer(sys)

    await sys.volume.create({ data: { serverId: server.id, name: 'pg-data' } })
    // @@unique([serverId, name]) is what makes a report an UPSERT rather than
    // an append — without it every check-in would add a second row for the
    // same disk and the fleet's total would climb on a timer.
    await expect(sys.volume.create({ data: { serverId: server.id, name: 'pg-data' } })).rejects.toThrow()
    db.$close()
  })

  test('a volume goes when its server does — nothing observes a machine that is gone', async () => {
    const db  = await client(freshDb())
    const sys = db.asSystem() as any
    const { server } = await seedServer(sys)

    await sys.volume.create({ data: { serverId: server.id, name: 'uploads' } })
    // Hard delete: Server is @@softDelete, so `remove` would leave the volume
    // pointing at a row that still exists. Cascade is about the real deletion.
    await sys.server.delete({ where: { id: server.id } })

    expect(await sys.volume.count({ where: { serverId: server.id } })).toBe(0)
    db.$close()
  })

  test('containers round-trip as an array of names', async () => {
    const db  = await client(freshDb())
    const sys = db.asSystem() as any
    const { server } = await seedServer(sys)

    const v = await sys.volume.create({
      data: { serverId: server.id, name: 'redis-data', inUse: true, containers: ['redis', 'api'] },
    })
    expect(v.containers).toEqual(['redis', 'api'])

    // FJS-120's shape: an array field defaulting to "[]" used to arrive as the
    // two characters rather than an empty list.
    const bare = await sys.volume.create({ data: { serverId: server.id, name: 'orphan' } })
    expect(bare.containers).toEqual([])
    expect(bare.inUse).toBe(false)
    db.$close()
  })
})

// ─── Dashboards ──────────────────────────────────────────────────────────────
// A widget names a KIND from a declared vocabulary; it never carries a query.
// What that decision costs is a second place the vocabulary lives — the enum in
// the schema and the spec table the service validates against — so the first
// test here holds them together in BOTH directions. The rest pin the part of a
// widget's subject that is a schema decision rather than a service rule.

describe('Dashboard — a declared vocabulary, not a stored query', () => {
  test('every widget kind is declared once, in both places', () => {
    const schema = parseFile(SCHEMA).schema
    // A parsed enum value is a record, not a string — it carries the comments
    // written above it.
    const declared = (schema.enums.find((e: any) => e.name === 'WidgetKind')?.values ?? [])
      .map((v: any) => v.name ?? v)
    const specced  = WIDGET_KINDS.map(k => k.kind)

    // Both directions. A kind in the schema with no spec is placeable and
    // unconfigurable; a spec with no enum member is offered by the picker and
    // refused by the column, which is a button that cannot work.
    expect([...declared].sort()).toEqual([...specced].sort())
  })

  test('a widget carries no query — the columns are a kind, a subject and knobs', () => {
    // Against the DDL, because the point is what CANNOT be stored. A `query`
    // or `accessor` column added later would still make every read work, and
    // the policy it walks around would fail silently.
    const ddl   = readFileSync(MIGRATION, 'utf8')
    const start = ddl.indexOf('CREATE TABLE IF NOT EXISTS "dashboard_widget"')
    const table = ddl.slice(start, start + ddl.slice(start).indexOf(') STRICT;'))

    expect(table).toContain('"kind"')
    expect(table).toContain('"serverId"')
    expect(table).toContain('"appId"')
    expect(table).not.toContain('"query"')
    expect(table).not.toContain('"accessor"')
    expect(table).not.toContain('"sql"')

    // The enum reaches SQLite as a CHECK, which is what makes the vocabulary
    // enforceable below the API as well as at it.
    expect(table).toContain(`CHECK ("kind" IN (`)
    for (const spec of WIDGET_KINDS) expect(table).toContain(`'${spec.kind}'`)
  })

  test('a kind outside the vocabulary is refused by the column', async () => {
    const db  = await client(freshDb())
    const sys = db.asSystem() as any
    const ws  = await seedWorkspace(sys)
    const board = await sys.dashboard.create({
      data: { workspaceId: ws.id, name: 'Ops', slug: `ops-${Math.random().toString(36).slice(2, 8)}` },
    })

    await expect(sys.dashboardWidget.create({
      data: { dashboardId: board.id, kind: 'sql_query' },
    })).rejects.toThrow()
    db.$close()
  })

  test('a widget whose server is really deleted keeps its place and loses its subject', async () => {
    const db  = await client(freshDb())
    const sys = db.asSystem() as any
    const ws  = await seedWorkspace(sys)
    const server = await sys.server.create({
      data: { workspaceId: ws.id, name: 'gw-01', slug: `gw-${Math.random().toString(36).slice(2, 8)}` },
    })
    const board = await sys.dashboard.create({
      data: { workspaceId: ws.id, name: 'Ops', slug: `ops-${Math.random().toString(36).slice(2, 8)}` },
    })
    const widget = await sys.dashboardWidget.create({
      data: { dashboardId: board.id, kind: 'server_health', serverId: server.id },
    })

    // SetNull, not Cascade. A card that vanishes with the machine takes the
    // only evidence of what was being watched with it; a card that says the
    // server is gone is the thing an operator needs to see.
    await sys.server.delete({ where: { id: server.id } })

    const after = await sys.dashboardWidget.findUnique({ where: { id: widget.id } })
    expect(after).not.toBeNull()
    expect(after.serverId).toBeNull()
    db.$close()
  })

  test('widgets go when their dashboard does', async () => {
    const db  = await client(freshDb())
    const sys = db.asSystem() as any
    const ws  = await seedWorkspace(sys)
    const board = await sys.dashboard.create({
      data: { workspaceId: ws.id, name: 'Ops', slug: `ops-${Math.random().toString(36).slice(2, 8)}` },
    })
    await sys.dashboardWidget.create({ data: { dashboardId: board.id, kind: 'server_fleet' } })

    // Hard delete: Dashboard is @@softDelete, so `remove` leaves the widgets
    // pointing at a row that still exists — which is right, since restoring a
    // board with no cards would be restoring a different board.
    await sys.dashboard.delete({ where: { id: board.id } })
    expect(await sys.dashboardWidget.count({ where: { dashboardId: board.id } })).toBe(0)
    db.$close()
  })

  test('two dashboards in one workspace cannot share a name', async () => {
    const db  = await client(freshDb())
    const sys = db.asSystem() as any
    const ws  = await seedWorkspace(sys)

    await sys.dashboard.create({ data: { workspaceId: ws.id, name: 'Ops overview', slug: 'ops-overview' } })
    // @@unique([workspaceId, slug]) — the slug is derived from the name, so
    // this is what stops two boards reading identically in the list.
    await expect(sys.dashboard.create({
      data: { workspaceId: ws.id, name: 'Ops overview', slug: 'ops-overview' },
    })).rejects.toThrow()
    db.$close()
  })
})

// ─── Recipes and reclaim ─────────────────────────────────────────────────────
// Two ways to act on a machine. A recipe is arbitrary code and no vocabulary
// can bound it, so what these pin is the RECORD: the script a run actually ran,
// and where the reclaim vocabulary lives now that it cannot be an enum.

describe('Recipe and CleanupRun — the arbitrary act and the declared one', () => {
  async function seedServer(sys: any, ws: any, name = 'runner-01') {
    return sys.server.create({
      data: { workspaceId: ws.id, name, slug: `${name}-${Math.random().toString(36).slice(2, 8)}` },
    })
  }

  test('one run vocabulary, not three — JobRun, RecipeRun and CleanupRun share RunStatus', () => {
    const schema = parseFile(SCHEMA).schema
    const byName = Object.fromEntries(schema.models.map((m: any) => [m.name, m]))

    for (const model of ['JobRun', 'RecipeRun', 'CleanupRun']) {
      const status = byName[model].fields.find((f: any) => f.name === 'status')
      // Three copies of the same five words drift apart one value at a time,
      // and the screens then disagree about what "finished" looks like.
      expect(status.type.name).toBe('RunStatus')
    }
    expect(schema.enums.some((e: any) => e.name === 'JobRunStatus')).toBe(false)
  })

  test('a run keeps the script it ran — editing the recipe does not rewrite history', async () => {
    const db  = await client(freshDb())
    const sys = db.asSystem() as any
    const ws  = await seedWorkspace(sys)
    const server = await seedServer(sys, ws)

    const recipe = await sys.recipe.create({
      data: { workspaceId: ws.id, name: 'Restart nginx', slug: 'restart-nginx', script: 'nginx -s reload' },
    })
    const run = await sys.recipeRun.create({
      data: { recipeId: recipe.id, serverId: server.id, script: recipe.script },
    })

    // The recipe is editable — that is the point of saving one. What must not
    // move is the output's own copy of what produced it: a run read against a
    // script that has since changed is not evidence of anything.
    await sys.recipe.update({ where: { id: recipe.id }, data: { script: 'rm -rf /' } })

    const after = await sys.recipeRun.findUnique({ where: { id: run.id } })
    expect(after.script).toBe('nginx -s reload')
    db.$close()
  })

  test('runs go when their recipe or their server does', async () => {
    const db  = await client(freshDb())
    const sys = db.asSystem() as any
    const ws  = await seedWorkspace(sys)
    const [a, b] = [await seedServer(sys, ws, 'a-01'), await seedServer(sys, ws, 'b-01')]

    const recipe = await sys.recipe.create({
      data: { workspaceId: ws.id, name: 'Check disk', slug: 'check-disk', script: 'df -h' },
    })
    await sys.recipeRun.create({ data: { recipeId: recipe.id, serverId: a.id, script: 'df -h' } })
    await sys.recipeRun.create({ data: { recipeId: recipe.id, serverId: b.id, script: 'df -h' } })

    // Hard delete both ways: Server and Recipe are @@softDelete, so `remove`
    // leaves the runs pointing at rows that still exist — which is right, since
    // a deleted recipe's history is still what happened to those machines.
    await sys.server.delete({ where: { id: a.id } })
    expect(await sys.recipeRun.count({ where: { recipeId: recipe.id } })).toBe(1)

    await sys.recipe.delete({ where: { id: recipe.id } })
    expect(await sys.recipeRun.count({ where: { recipeId: recipe.id } })).toBe(0)
    db.$close()
  })

  test('the reclaim vocabulary has exactly one home, and it is not the schema', () => {
    // `targets ReclaimTarget[]` does not parse — *array [] is only supported for
    // Text, Integer, File, or a model name for many-to-many* — so the column is
    // `String[]` and the list lives in the service. What this holds is that
    // nobody later adds the enum "for completeness": a declared enum with no
    // CHECK joining it to the column is two homes, which is exactly the shape
    // that let AlertRule.severity default to a value its own API refused.
    const schema = parseFile(SCHEMA).schema
    const declaredElsewhere = schema.enums.filter((e: any) =>
      (e.values ?? []).some((v: any) => RECLAIM_TARGET_NAMES.includes(v.name ?? v)))
    expect(declaredElsewhere.map((e: any) => e.name)).toEqual([])

    const ddl   = readFileSync(MIGRATION, 'utf8')
    const start = ddl.indexOf('CREATE TABLE IF NOT EXISTS "cleanup_run"')
    const table = ddl.slice(start, start + ddl.slice(start).indexOf(') STRICT;'))

    // A sweep names targets and never carries a command. A `command` or
    // `script` column here would make this screen a recipe screen with none of
    // the safeguards the recipes service applies.
    expect(table).toContain('"targets"')
    expect(table).not.toContain('"command"')
    expect(table).not.toContain('"script"')
  })

  test('a disk picture is one row per server, and it counts no volumes', () => {
    const ddl   = readFileSync(MIGRATION, 'utf8')
    const start = ddl.indexOf('CREATE TABLE IF NOT EXISTS "disk_usage"')
    const table = ddl.slice(start, start + ddl.slice(start).indexOf(') STRICT;'))

    // UNIQUE(serverId) is what makes an agent report an upsert rather than an
    // append — without it a machine checking in every minute grows a row a
    // minute and the screen shows the first one it finds.
    expect(table).toContain('UNIQUE ("serverId")')

    // `Volume` owns per-disk sizes. A count here would be a second answer to a
    // question already answered, and the two would part company the first time
    // a report was missed.
    expect(table).not.toContain('"volumes')
    expect(table).not.toContain('"unusedVolume')
    // Nor a last-cleanup stamp: CleanupRun records when a sweep ran and what it
    // freed, and a stamp here would go stale the first time one failed.
    expect(table).not.toContain('"lastCleanup')
  })

  test('the same server cannot hold two disk pictures', async () => {
    const db  = await client(freshDb())
    const sys = db.asSystem() as any
    const ws  = await seedWorkspace(sys)
    const server = await seedServer(sys, ws)

    await sys.diskUsage.create({ data: { serverId: server.id, imagesTotal: 3 } })
    await expect(sys.diskUsage.create({ data: { serverId: server.id, imagesTotal: 4 } })).rejects.toThrow()
    db.$close()
  })
})

// ─── The hub tier ────────────────────────────────────────────────────────────
// Phase 10 added the two words this app enforces on — `suspended` on a user and
// on a workspace — and one column that decides who may say them. All three had
// been free strings or absent, which is the shape that let AlertRule default to
// a severity its own API refused: a vocabulary in a service and nothing in the
// schema holding it.

describe('the hub tier — suspension, and who may grant it', () => {
  test('both status vocabularies are declared once, in both places', () => {
    const schema = parseFile(SCHEMA).schema
    const values = (name: string) =>
      (schema.enums.find((e: any) => e.name === name)?.values ?? []).map((v: any) => v.name ?? v)

    // The service's copy exists so a bad value is refused by NAME rather than
    // by a SQLite constraint message three layers down. This is what keeps the
    // copy a copy.
    expect([...values('UserStatus')].sort()).toEqual([...USER_STATUSES].sort())
    expect([...values('WorkspaceStatus')].sort()).toEqual([...WORKSPACE_STATUSES].sort())
  })

  test('a status outside the vocabulary is refused by the column', async () => {
    const db  = await client(freshDb())
    const sys = db.asSystem() as any
    const ws  = await seedWorkspace(sys)

    await expect(sys.workspace.update({ where: { id: ws.id }, data: { status: 'paused' } }))
      .rejects.toThrow()
    await expect(sys.user.create({
      data: { email: `x${Math.random().toString(36).slice(2, 8)}@x.co`, status: 'banned' },
    })).rejects.toThrow()
    db.$close()
  })

  test('suspension is not deletion — the rows and their children stay', async () => {
    const db  = await client(freshDb())
    const sys = db.asSystem() as any
    const ws  = await seedWorkspace(sys)
    await sys.project.create({
      data: { workspaceId: ws.id, name: 'Website', slug: `web-${Math.random().toString(36).slice(2, 8)}` },
    })

    await sys.workspace.update({ where: { id: ws.id }, data: { status: 'suspended' } })

    // @@softDelete(cascade) stamps every child; a status change must not.
    // Confusing the two would make "suspend" an unrecoverable action wearing a
    // reversible label.
    const after = await sys.workspace.findUnique({ where: { id: ws.id } })
    expect(after.status).toBe('suspended')
    expect(after.deletedAt).toBeNull()
    expect(await sys.project.count({ where: { workspaceId: ws.id } })).toBe(1)
    db.$close()
  })

  test('the privileged bit is its own column, and it is off by default', async () => {
    const db  = await client(freshDb())
    const sys = db.asSystem() as any
    const user = await sys.user.create({ data: { email: `y${Math.random().toString(36).slice(2, 8)}@x.co` } })

    // NOT auth's `role`, which defaults to "user" and which nothing in this app
    // reads. The name is load-bearing beyond this app: `isSystemAdmin` is what
    // sessionGateLevel() grades SYSADMIN(7) on, so this is the column @@gate
    // will read when FJS-007 lands.
    expect(user.isSystemAdmin).toBe(false)
    expect(user.role).toBe('user')
    expect(user.status).toBe('pending_verification')
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
