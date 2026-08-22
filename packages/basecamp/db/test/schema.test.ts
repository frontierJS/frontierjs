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

import { parseFile, generateDDL, createClient, GatePlugin, LEVELS, listMigrationFiles } from '../../../litestone/src/index.js'
import { createTestEnv } from '../../../litestone/src/testing.js'
import { introspect }     from '../../../litestone/src/core/migrate.js'
// The app's own resolver, not a stand-in. A gate test against a hand-written
// getLevel proves the levels in this file, not the ones the API runs — and the
// two disagreeing is exactly the failure @@gate exists to prevent.
import { basecampGateLevel, WORKSPACE_ROLE_LEVEL } from '../../api/src/core/gate.ts'
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
const MIGRATIONS = join(import.meta.dir, '..', 'migrations')
// Asked rather than spelled, and asked at the path `migrate apply` reads: this
// schema declares `database main`, so litestone looks in migrations/main/, and
// `listMigrationFiles` is the only definition of which files there it will run.
// A file this finds is a file a deploy applies — which is the whole claim the
// rest of this file rests on, and was false in two ways at once (FJS-193).
const MAIN_MIGRATIONS = join(MIGRATIONS, 'main')
const MIGRATION       = join(MAIN_MIGRATIONS, listMigrationFiles(MAIN_MIGRATIONS)[0] ?? '')
const ENC_KEY    = '0'.repeat(64)

// Every environment this file opens, so nothing is left holding a connection.
const envs:    any[] = []
const rawDirs: string[] = []

/**
 * A client on a throwaway database built from the COMMITTED MIGRATION.
 *
 * `migrations:` rather than the schema's generated DDL, and that is the whole
 * point of this file: the assertions below are about the database a deploy
 * produces, not about one derived from the same `.lite` the assertions read.
 *
 * `createTestEnv` owns three things this used to do by hand. It redirects the
 * declared `database main { path env("DATABASE_URL", …) }` into a throwaway
 * directory — a declaration WINS over `createClient({ db })` silently, and when
 * this file passed `db: dbPath` every test quietly opened the DEVELOPMENT
 * database and wrote to it. It builds the tables once per process and copies
 * them per call. And it hands back `system` already scoped.
 */
// `any`: a Litestone client is a Proxy whose accessors are the schema's models,
// which no static type here knows. Every test in this file would otherwise open
// with the same cast.
async function makeEnv(opts: Record<string, unknown> = {}): Promise<any> {
  // The same GatePlugin core/db.ts installs. Leaving it out does NOT give an
  // ungated client — a schema declaring any @@gate installs Litestone's default
  // resolver instead, which grades a plain principal USER(4) and would have
  // these tests asserting against levels no request in this app ever gets.
  const env = await createTestEnv({
    schema:        SCHEMA,
    migrations:    MIGRATIONS,
    encryptionKey: ENC_KEY,
    plugins:       [new GatePlugin({ getLevel: basecampGateLevel })],
    ...opts,
  })
  envs.push(env)
  return env
}

/** The client alone, which is all but one test needs. */
async function client(opts: Record<string, unknown> = {}): Promise<any> {
  return (await makeEnv(opts)).db
}

/**
 * A raw database with the migration replayed, for the two tests that inspect
 * what the migration BUILT rather than what a client does with it.
 */
function freshDb(): string {
  const path = join(scratchDir('ddl'), 'bc.db')
  const raw  = new Database(path)
  raw.run(readFileSync(MIGRATION, 'utf8'))
  raw.close()
  return path
}

/**
 * A throwaway directory this file owns. The env owns its own (`env.dir`); this
 * is for the two things that need one BEFORE a client exists — the raw
 * migration replay, and the `audit` logger database, whose path has to be
 * passed in as a client option.
 */
function scratchDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `basecamp-${label}-`))
  rawDirs.push(dir)
  return dir
}

/**
 * The rows a @@log(audit) write produces, once they are on disk.
 *
 * POLLED, not slept. The writer buffers ~1s and a fixed wait against that is a
 * coin toss under load — this file failed once in a full run and passed on its
 * own immediately after, which is the worst way for a test to be wrong. Waits
 * for the rows the assertions are about, and gives up after ten seconds so a
 * genuine failure is still a failure. Every caller states a timeout above that.
 */
async function auditEntries(dir: string, model: string, ops: string[]): Promise<any[]> {
  const file = join(dir, 'auditLogs.jsonl')
  const read = () => {
    try {
      return readFileSync(file, 'utf8').trim().split('\n')
        .filter(Boolean).map(l => JSON.parse(l)).filter((e: any) => e.model === model)
    } catch { return [] }
  }
  const deadline = Date.now() + 10_000
  let entries = read()
  while (Date.now() < deadline && !ops.every(op => entries.some((e: any) => e.operation === op))) {
    await new Promise(r => setTimeout(r, 100))
    entries = read()
  }
  return entries
}

/** A principal with standing in a workspace, as applyStanding() builds one. */
function as(memberRole: string, extra: Record<string, unknown> = {}) {
  return { id: 'u1', userId: 'u1', memberRole, ...extra }
}

/**
 * A cross-workspace move, well-formed.
 *
 * Twelve models declare `@version` and refuse an update that carries none, and
 * that refusal lands BEFORE the policy — so a payload of `{ workspaceId }`
 * alone grades the version check rather than the tenancy rule these tests are
 * about. Reading the version through `sys` is also the honest shape: a real
 * caller has it because it read the row.
 */
async function moveTo(caller: any, sys: any, accessor: string, id: string, workspaceId: string) {
  const row = await sys[accessor].findUnique({ where: { id } })
  return caller[accessor].update({
    where: { id },
    data:  { workspaceId, ...(row?.version == null ? {} : { version: row.version }) },
  })
}

afterAll(() => {
  for (const env of envs) env.close()
  for (const dir of rawDirs) rmSync(dir, { recursive: true, force: true })
})

// ─── The schema itself ───────────────────────────────────────────────────────

describe('schema.lite', () => {
  test('parses with no errors and no warnings', () => {
    const r = parseFile(SCHEMA)
    expect(r.errors ?? []).toEqual([])
    // One standing warning, and it is the tenancy block reporting what it did:
    // fourteen models carry no `workspaceId` and are scoped through a parent
    // (`FJS-282`). Asserted by shape rather than allowed by silence, so a
    // SECOND warning — a model that is scoped by nothing — still fails here.
    const warnings = (r.warnings ?? []) as string[]
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/scoped through a parent/)
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

  test('every model declares @@gate — Invariant 6 has no exceptions', () => {
    // The inverse of the test that used to stand here, which pinned the gap.
    // A model added without a level is the failure this catches: it would be
    // ungated in a schema where every neighbour is gated, and nothing else
    // would say so — the app would simply let anyone read it.
    const r = parseFile(SCHEMA)
    const ungated = r.schema.models
      .filter((m: any) => !m.attributes.some((a: any) => a.kind === 'gate'))
      .map((m: any) => m.name)
    expect(ungated).toEqual([])
  })

  test('every WorkspaceRole has a level — a role added to the enum fails closed', () => {
    // The enum is the vocabulary; core/gate.ts is the mapping. A value in one
    // and not the other grades VISITOR(1) at runtime, which reads as "the
    // screen is empty for that person" rather than as a missing line.
    const r     = parseFile(SCHEMA)
    const roles = r.schema.enums
      .find((e: any) => e.name === 'WorkspaceRole').values
      .map((v: any) => v.name)
    expect(roles.filter((v: string) => WORKSPACE_ROLE_LEVEL[v] === undefined)).toEqual([])
    // …and nothing in the mapping that the enum does not declare.
    expect(Object.keys(WORKSPACE_ROLE_LEVEL).filter(k => !roles.includes(k))).toEqual([])
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
  test('is where `litestone migrate apply` looks, under a name it matches', () => {
    // The claim every other test here rests on. It was false in two ways at
    // once and nothing said so: the file was named 001_… (which the name
    // pattern rejects) and sat directly under migrations/ (while a schema
    // declaring `database main` is read from migrations/main/). createTestEnv
    // reads the directory loosely, so the suite was green against a database a
    // deploy could not build — `migrate apply` reported "no migration files
    // found" and exited 0. FJS-193.
    const found = listMigrationFiles(MAIN_MIGRATIONS)
    expect(found.length).toBeGreaterThan(0)
    expect(existsSync(MIGRATION)).toBe(true)
  })

  test('is in sync with schema.lite', () => {
    // Same comparison `bun run db:check` makes — a hand-edit to the SQL fails here.
    const r      = parseFile(SCHEMA)
    const onDisk = readFileSync(MIGRATION, 'utf8')
    expect(onDisk).toContain(generateDDL(r.schema))
  })

  test('applies to a fresh database — 38 tables, FK-clean, all STRICT', () => {
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
    // app acts on a machine, one arbitrary and one declared. 38 since
    // `Invitation` — the only door into this app for a human who is not the
    // first one, because `addMember` needs a userId and nothing made users.
    expect(tables.length).toBe(38)
    expect(raw.query('PRAGMA foreign_key_check').all()).toEqual([])

    const nonStrict = tables.filter((t: string) => {
      const sql = (raw.query('SELECT sql FROM sqlite_master WHERE name=?').get(t) as any)?.sql ?? ''
      return !/STRICT/.test(sql)
    })
    expect(nonStrict).toEqual([])
    raw.close()
  })

  test('the database the migrations build is the one schema.lite declares', async () => {
    // The text check above compares the initial migration against generateDDL,
    // which stops meaning anything the moment a second migration file exists —
    // a concatenation of two files does not contain the whole current DDL.
    // This asks the durable question instead: build a database each way and
    // compare what SQLite ended up with. Every other test in this file runs
    // against the migration, so this is what keeps that honest.
    const fromMigrations = await makeEnv()
    const fromSchema     = await makeEnv({ migrations: undefined })

    const a = introspect(fromMigrations.db.$rawDbs.main)
    const b = introspect(fromSchema.db.$rawDbs.main)
    const tablesOf  = (s: any) => Object.keys(s.tables ?? s).sort()
    const columnsOf = (s: any, t: string) => Object.keys((s.tables ?? s)[t].columns ?? {}).sort()

    expect(tablesOf(a)).toEqual(tablesOf(b))
    for (const t of tablesOf(a)) expect([t, columnsOf(a, t)]).toEqual([t, columnsOf(b, t)])
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
    const env = await makeEnv()
    const sys = env.system
    const ws  = await seedWorkspace(sys)
    const KEY = JSON.stringify({ priv: 'SSH-PRIVATE-KEY-DO-NOT-LEAK' })

    await sys.secret.create({ data: { workspaceId: ws.id, name: 'deploy-key', kind: 'ssh_key', data: KEY } })
    env.close()

    expect(readFileSync(env.path, 'latin1')).not.toContain('SSH-PRIVATE-KEY-DO-NOT-LEAK')
  })

  test('round-trips intact for a system reader', async () => {
    const db  = await client()
    const sys = db.asSystem()
    const ws  = await seedWorkspace(sys)
    const KEY = JSON.stringify({ priv: 'ROUND-TRIP' })

    const s = await sys.secret.create({ data: { workspaceId: ws.id, name: 'k', kind: 'ssh_key', data: KEY } })
    expect(s.data).toBe(KEY)
    db.$close()
  })

  test('the data column is absent entirely for a non-system reader', async () => {
    const db  = await client()
    const sys = db.asSystem()
    const ws  = await seedWorkspace(sys)
    await sys.secret.create({ data: { workspaceId: ws.id, name: 'k', kind: 'ssh_key', data: '{"priv":"x"}' } })

    // An ADMINISTRATOR(5), which is the level Secret.read wants — so this is
    // the field policy refusing a caller the GATE let through. Two independent
    // boundaries: @guarded keys on asSystem(), not on a level, and no place on
    // the ladder reaches this column.
    const [row] = await db.$setAuth(as('admin', { workspaceId: ws.id })).secret.findMany({ limit: 1 })
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
    const auditDir = scratchDir('audit')

    const db  = await client({ databases: { audit: { path: auditDir } } })
    const sys = db.asSystem()
    const ws  = await seedWorkspace(sys)

    const s = await sys.secret.create({
      data: { workspaceId: ws.id, name: 'deploy-key', kind: 'ssh_key', data: '{"priv":"AUDIT-LEAK-CANARY"}' },
    })
    await sys.secret.update({ where: { id: s.id }, data: { data: '{"priv":"ROTATED-CANARY"}' } })

    const entries = await auditEntries(auditDir, 'secret', ['create', 'update'])
    db.$close()

    const file = join(auditDir, 'auditLogs.jsonl')
    expect(existsSync(file)).toBe(true)
    const log = readFileSync(file, 'utf8')

    // The access is recorded …
    expect(entries.map(e => e.operation)).toContain('create')
    expect(entries.map(e => e.operation)).toContain('update')

    // … the value is not.
    expect(log).not.toContain('AUDIT-LEAK-CANARY')
    expect(log).not.toContain('ROTATED-CANARY')
    expect(log).toContain('[redacted]')
    // Stated, because the poll above has to fit inside it — bun's default is
    // 5s and the writer's own buffer is ~1s of that.
  }, 20_000)
})

// ─── Access control — the gate ladder ────────────────────────────────────────
// The levels are declared in schema.lite and the mapping onto them is
// api/src/core/gate.ts. These run the pair against a real database, because the
// only thing that proves a level is a refusal: a schema that parses says
// nothing about what a viewer can do.
//
// `memberRole` on the principal is what applyStanding() puts there per request,
// off the WorkspaceMember row for the workspace being addressed. A test that
// invented some other field would be testing a resolver nothing calls.

describe('the gate ladder', () => {

  test('a viewer reads the fleet and creates nothing', async () => {
    const db  = await client()
    const sys = db.asSystem()
    const ws  = await seedWorkspace(sys)
    await sys.app.create({ data: {
      workspaceId: ws.id, environmentId: await seedEnvironmentId(sys, ws), name: 'web', slug: 'web',
    } })

    // The workspace goes on the PRINCIPAL, which is what applyStanding() does
    // per request — App and Project now declare @@allow, and a principal with
    // no workspace matches no rows and may create none.
    const viewer = db.$setAuth(as('viewer', { workspaceId: ws.id }))
    expect((await viewer.app.findMany({ limit: 1 })).length).toBe(1)
    // Refused by the LEVEL, before the policy is consulted — which is the
    // distinction this test is about: a gate refuses, a policy filters.
    await expect(viewer.project.create({ data: { workspaceId: ws.id, name: 'p', slug: 'p' } }))
      .rejects.toThrow(/requires level 4/)
    db.$close()
  })

  test('a developer writes apps and cannot read a secret', async () => {
    const db  = await client()
    const sys = db.asSystem()
    const ws  = await seedWorkspace(sys)
    await sys.secret.create({ data: { workspaceId: ws.id, name: 'k', kind: 'ssh_key', data: '{}' } })

    const dev = db.$setAuth(as('developer', { workspaceId: ws.id }))
    const created = await dev.project.create({ data: { workspaceId: ws.id, name: 'p', slug: 'p' } })
    expect(created.id).toBeTruthy()
    // Secret is the admin tier — and this is the one level that is NOT the same
    // question as @guarded: the column would be hidden anyway, the ROW is what
    // a developer may not list.
    await expect(dev.secret.findMany({ limit: 1 })).rejects.toThrow(/requires level 5/)
    db.$close()
  })

  test('an admin reads secrets; only an owner deletes the workspace', async () => {
    const db  = await client()
    const sys = db.asSystem()
    const ws  = await seedWorkspace(sys)
    await sys.secret.create({ data: { workspaceId: ws.id, name: 'k', kind: 'ssh_key', data: '{}' } })

    const admin = db.$setAuth(as('admin', { workspaceId: ws.id }))
    expect((await admin.secret.findMany({ limit: 1 })).length).toBe(1)
    // remove() on a @@softDelete model is an UPDATE, so this is the update
    // position of the gate (5) rather than the delete one (6) — which is why
    // Workspace is written "1.1.5.6" and not "1.1.5.5": the hard delete is the
    // owner's, and an admin archiving a workspace is a different act.
    await expect(admin.workspace.delete({ where: { id: ws.id } })).rejects.toThrow(/requires level 6/)

    const owner = db.$setAuth(as('owner'))
    expect(await owner.workspace.delete({ where: { id: ws.id } })).toBeTruthy()
    db.$close()
  })

  test('isSystemAdmin outranks membership', async () => {
    const db  = await client()
    const sys = db.asSystem()
    const ws  = await seedWorkspace(sys)
    await sys.secret.create({ data: { workspaceId: ws.id, name: 'k', kind: 'ssh_key', data: '{}' } })

    // No membership anywhere, so the workspace ladder gives nothing — the level
    // is standing alone. The workspace still has to be ON the principal:
    // `Secret` declares row-level tenancy and applyStanding() stamps the
    // workspace being addressed for a system administrator like anyone else.
    // Standing decides the LEVEL; the policy decides which rows.
    const sa = db.$setAuth({ id: 'u9', userId: 'u9', isSystemAdmin: true, workspaceId: ws.id })
    expect((await sa.secret.findMany({ limit: 1 })).length).toBe(1)

    // And standing does not cross a workspace: a system administrator reading
    // another tenant's vault is the hub's job, through asSystem().
    const elsewhere = db.$setAuth({ id: 'u9', userId: 'u9', isSystemAdmin: true, workspaceId: 'other' })
    expect((await elsewhere.secret.findMany({ limit: 1 })).length).toBe(0)
    // The three models holding credential material stay SYSTEM — a level no
    // request reaches — while `User` reads at 4, because an app's own screens
    // list its people. The hub still reads through asSystem(), which is what
    // makes it a hub rather than a screen every developer can open.
    await expect(sa.credential.findMany({ limit: 1 })).rejects.toThrow(/SYSTEM access/)
    await expect(sa.session.findMany({ limit: 1 })).rejects.toThrow(/SYSTEM access/)
    db.$close()
  })

  // `User` gates read AND update at USER(4) — auth's ladder, so that an app can
  // list its people and a person can edit their own profile. A gate is per
  // MODEL, so on its own that is every signed-in caller writing every other
  // person's row, including the column their own level is graded from. These
  // three are what makes the level safe to hold, and none of them is a level:
  // a row policy for whose row, and a field write policy for which columns.
  test('a member reads every person and writes only their own row', async () => {
    const db  = await client()
    const sys = db.asSystem()
    const other = await sys.user.create({ data: { email: 'other@example.com', name: 'Other' } })
    await sys.user.create({ data: { id: 'u1', email: 'u1@example.com', name: 'Me' } })

    const dev = db.$setAuth(as('developer'))
    expect((await dev.user.findMany({ limit: 10 })).length).toBe(2)
    expect((await dev.user.update({ where: { id: 'u1' }, data: { displayName: 'mine' } })).displayName)
      .toBe('mine')

    // A policy FILTERS where a gate refuses, so the cross-row write matches no
    // row and answers null rather than throwing. Reading the row back is what
    // proves it, not the return value.
    await dev.user.update({ where: { id: other.id }, data: { name: 'rewritten' } })
    expect((await sys.user.findUnique({ where: { id: other.id } })).name).toBe('Other')
    db.$close()
  })

  test('nobody promotes themselves onto the hub tier', async () => {
    const db  = await client()
    const sys = db.asSystem()
    await sys.user.create({ data: { id: 'u1', email: 'u1@example.com', name: 'Me' } })

    // Every column basecampGateLevel() reads is a column the caller must not
    // write: isSystemAdmin IS the hub tier, and `suspended` is the status that
    // grades STRANGER — a caller who can lift their own suspension is not
    // suspended. `kind` decides who may own an API key.
    const dev = db.$setAuth(as('developer'))
    await dev.user.update({ where: { id: 'u1' }, data: {
      isSystemAdmin: true, status: 'active', kind: 'bot', displayName: 'ok',
    } })
    const row = await sys.user.findUnique({ where: { id: 'u1' } })
    expect(row.isSystemAdmin).toBe(false)
    expect(row.status).toBe('pending_verification')
    expect(row.kind).toBe('human')
    // A field write policy DROPS the field; the rest of the write lands, which
    // is why the assertion above is the one that matters.
    expect(row.displayName).toBe('ok')

    // The hub's own path — asSystem() — is above all of it. That is how the
    // first system administrator is made in /setup and every later one granted
    // from /hub/users/.
    expect((await sys.user.update({ where: { id: 'u1' }, data: { isSystemAdmin: true } })).isSystemAdmin)
      .toBe(true)
    db.$close()
  })

  test('a suspended principal is STRANGER at the Data boundary, membership or not', async () => {
    // The app refuses a suspended caller at two doors already (login, and an
    // app-level before hook). This is the third, and it is the only one an
    // job calling a service in-process passes through.
    const db  = await client()
    const sys = db.asSystem()
    const ws  = await seedWorkspace(sys)
    await sys.app.create({ data: {
      workspaceId: ws.id, environmentId: await seedEnvironmentId(sys, ws), name: 'web', slug: 'web',
    } })

    const suspended = db.$setAuth(as('owner', { status: 'suspended' }))
    await expect(suspended.app.findMany({ limit: 1 })).rejects.toThrow(/requires level 2, user has level 0/)
    db.$close()
  })

  test('an authenticated caller with no workspace reads Workspace and nothing else', async () => {
    // VISITOR(1) is the level a fresh login holds before it names a workspace,
    // and Workspace is the one model it must be able to read — otherwise the
    // screen that lists the workspaces you could act in cannot load.
    const db  = await client()
    const sys = db.asSystem()
    await seedWorkspace(sys)

    const fresh = db.$setAuth({ id: 'u1', userId: 'u1' })
    expect((await fresh.workspace.findMany({ limit: 1 })).length).toBe(1)
    await expect(fresh.server.findMany({ limit: 1 })).rejects.toThrow(/requires level 2/)
    db.$close()
  })

  test('the audit trail cannot be rewritten from inside the application', async () => {
    // AuditEvent is "5.8.9.9". 9 is LOCKED, which asSystem() does not pass
    // either — the one gate here that is aimed at the app rather than at its
    // callers. It is also why db/seed.js --force cannot clear the table and
    // lets the workspace FK cascade do it.
    const db  = await client()
    const sys = db.asSystem()
    const ws  = await seedWorkspace(sys)
    const ev  = await sys.auditEvent.create({ data: {
      workspaceId: ws.id, actorId: 'u1', action: 'servers.drain',
      subjectType: 'servers', subjectId: 's1',
    } })

    await expect(sys.auditEvent.update({ where: { id: ev.id }, data: { action: 'nothing.happened' } }))
      .rejects.toThrow(/LOCKED/)
    await expect(sys.auditEvent.deleteMany({})).rejects.toThrow(/LOCKED/)
    // An admin still reads it — that is the audit screen.
    expect((await db.$setAuth(as('admin')).auditEvent.findMany({ limit: 1 })).length).toBe(1)
    db.$close()
  })

  test('the levels are the ones the ladder documents', () => {
    // Cheap, and it is what keeps core/gate.ts's header block honest.
    expect(basecampGateLevel(null)).toBe(LEVELS.STRANGER)
    expect(basecampGateLevel({ userId: 'u' })).toBe(LEVELS.VISITOR)
    expect(basecampGateLevel(as('viewer'))).toBe(LEVELS.READER)
    expect(basecampGateLevel(as('billing'))).toBe(LEVELS.READER)
    expect(basecampGateLevel(as('developer'))).toBe(LEVELS.USER)
    expect(basecampGateLevel(as('admin'))).toBe(LEVELS.ADMINISTRATOR)
    expect(basecampGateLevel(as('owner'))).toBe(LEVELS.OWNER)
    expect(basecampGateLevel(as('viewer', { isSystemAdmin: true }))).toBe(LEVELS.SYSADMIN)
    // A role the mapping does not know fails closed rather than upward.
    expect(basecampGateLevel(as('auditor'))).toBe(LEVELS.VISITOR)
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

// ─── Access control — the row policy ─────────────────────────────────────────
// `@@gate` answers *may this caller touch Server at all*; `@@allow` answers
// *which servers*. Server is the first model to declare one, and these run it
// with no service and no hook in the picture — a where-clause in a service
// would pass every one of these whether the policy existed or not.
//
// `workspaceId` reaches auth() the same way `memberRole` does: applyStanding()
// puts both on the principal, once per request, for the workspace being
// addressed.

describe('Server — @@allow, the tenancy the gate cannot express', () => {

  /** Two workspaces, one server in each. Returns both ids. */
  async function twoTenants(sys: any) {
    const a = await seedWorkspace(sys)
    const b = await sys.workspace.create({ data: {
      accountId: a.accountId, ownerId: a.ownerId,
      name: 'Other', slug: `other-${Math.random().toString(36).slice(2, 8)}`,
    } })
    await sys.server.create({ data: { workspaceId: a.id, name: 'a1', slug: 'a1' } })
    await sys.server.create({ data: { workspaceId: b.id, name: 'b1', slug: 'b1' } })
    return { a, b }
  }

  test('a caller reads the servers of the workspace on their principal, and no others', async () => {
    const db      = await client()
    const sys     = db.asSystem()
    const { a }   = await twoTenants(sys)

    // No `where`. Anything that comes back beyond a1 came back because nothing
    // filtered it — which is what the whole declaration is for.
    const rows = await db.$setAuth(as('admin', { workspaceId: a.id })).server.findMany({})
    expect(rows.map((r: any) => r.name)).toEqual(['a1'])
    expect(await db.$setAuth(as('admin', { workspaceId: a.id })).server.count()).toBe(1)
    db.$close()
  })

  test('naming another workspace does not reach its rows', async () => {
    const db          = await client()
    const sys         = db.asSystem()
    const { a, b }    = await twoTenants(sys)
    const other       = await sys.server.findFirst({ where: { workspaceId: b.id } })

    const caller = db.$setAuth(as('owner', { workspaceId: a.id }))
    expect(await caller.server.findUnique({ where: { id: other.id } })).toBeNull()
    // A filter that asks for the other tenant by name is answered, not obeyed.
    expect(await caller.server.findFirst({ where: { workspaceId: b.id } })).toBeNull()
    db.$close()
  })

  test('a server cannot be created into, or moved into, another workspace', async () => {
    const db       = await client()
    const sys      = db.asSystem()
    const { a, b } = await twoTenants(sys)
    const mine     = await sys.server.findFirst({ where: { workspaceId: a.id } })

    const caller = db.$setAuth(as('admin', { workspaceId: a.id }))
    await expect(caller.server.create({ data: { workspaceId: b.id, name: 'x', slug: 'x' } }))
      .rejects.toThrow(/Outside your workspaceId|denied by @@allow/)
    // The post-update half: the row was the caller's when the UPDATE matched it
    // and would not be afterwards, so it rolls back.
    await expect(caller.server.update({ where: { id: mine.id }, data: { workspaceId: b.id } }))
      .rejects.toThrow(/Outside your workspaceId|denied by @@allow/)
    expect((await sys.server.findUnique({ where: { id: mine.id } })).workspaceId).toBe(a.id)
    db.$close()
  })

  test('a workspace carries only its own servers through an include', async () => {
    // The include path builds its own SQL, and until litestone FJS-150 it applied
    // no policy at all — so this is the leak the declaration would otherwise
    // still have: one join away from a model that filters correctly.
    const db       = await client()
    const sys      = await db.asSystem()
    const { a, b } = await twoTenants(sys)

    const rows = await db.$setAuth(as('admin', { workspaceId: a.id }))
      .workspace.findMany({ include: { servers: true } })
    const mine   = rows.find((w: any) => w.id === a.id)
    const theirs = rows.find((w: any) => w.id === b.id)
    expect(mine.servers.map((s: any) => s.name)).toEqual(['a1'])
    expect(theirs?.servers ?? []).toEqual([])
    db.$close()
  })

  test('a principal with no workspace matches nothing — quietly, which is the failure shape', async () => {
    // A policy filters; it does not refuse. So a path that forgot to resolve a
    // workspace and is not asSystem() produces an empty screen rather than an
    // error, and that is what to look for when one goes blank.
    const db  = await client()
    const sys = db.asSystem()
    await twoTenants(sys)

    expect(await db.$setAuth(as('owner')).server.findMany({})).toEqual([])
    // asSystem() is the deliberate way across — the jobs, the hub and the
    // outpost's heartbeat all take it.
    expect((await sys.server.findMany({})).length).toBe(2)
    db.$close()
  })
})

// The same declaration, on the hierarchy every screen walks. Project, Environment
// and App were the second batch to move their tenancy out of the service
// where-clauses and into the schema, and the audit that precedes a declaration
// came out clean for all three: every scoped read already filtered on
// `workspaceId`, and the only paths that legitimately cross a workspace — the
// the jobs and the hub — are `asSystem()`.
//
// One test per property rather than per model, with the three driven through the
// same body: what would differ between them is the columns a create needs, and
// stating that once is what makes a fourth model a one-line addition.

describe('Project · Environment · App — the tenancy declared', () => {

  /** Two workspaces, each with the full hierarchy. */
  async function twoHierarchies(sys: any) {
    const a = await seedWorkspace(sys)
    const b = await sys.workspace.create({ data: {
      accountId: a.accountId, ownerId: a.ownerId,
      name: 'Other', slug: `other-${Math.random().toString(36).slice(2, 8)}`,
    } })
    const build = async (ws: any, tag: string) => {
      const project     = await sys.project.create({ data: { workspaceId: ws.id, name: tag, slug: tag } })
      const environment = await sys.environment.create({ data: {
        workspaceId: ws.id, projectId: project.id, name: 'prod', slug: 'prod', tier: 'production' } })
      const app = await sys.app.create({ data: {
        workspaceId: ws.id, environmentId: environment.id, name: 'web', slug: 'web' } })
      return { project, environment, app }
    }
    return { a, b, mine: await build(a, 'mine'), theirs: await build(b, 'theirs') }
  }

  /** What a create needs beyond a name — the only thing that differs. */
  const extras = (accessor: string, h: any) =>
    accessor === 'environment' ? { projectId: h.project.id, tier: 'staging' }
  : accessor === 'app'         ? { environmentId: h.environment.id }
  : {}

  const ACCESSORS = ['project', 'environment', 'app'] as const

  test('a caller reads only the rows of the workspace on their principal', async () => {
    const db  = await client()
    const sys = db.asSystem()
    const { a, mine } = await twoHierarchies(sys)
    const caller = db.$setAuth(as('developer', { workspaceId: a.id }))

    for (const accessor of ACCESSORS) {
      // No `where` at all: anything beyond the caller's own row came back
      // because nothing filtered it.
      const rows = await caller[accessor].findMany({})
      expect({ accessor, ids: rows.map((r: any) => r.id) }).toEqual({ accessor, ids: [mine[accessor].id] })
    }
    db.$close()
  })

  test('naming another workspace does not reach its rows', async () => {
    const db  = await client()
    const sys = db.asSystem()
    const { a, b, theirs } = await twoHierarchies(sys)
    const caller = db.$setAuth(as('developer', { workspaceId: a.id }))

    for (const accessor of ACCESSORS) {
      expect({ accessor, byId: await caller[accessor].findUnique({ where: { id: theirs[accessor].id } }) })
        .toEqual({ accessor, byId: null })
      // A filter that asks for the other tenant by name is answered, not obeyed.
      expect({ accessor, byWs: await caller[accessor].findFirst({ where: { workspaceId: b.id } }) })
        .toEqual({ accessor, byWs: null })
    }
    db.$close()
  })

  test('nothing can be created into, or moved into, another workspace', async () => {
    const db  = await client()
    const sys = db.asSystem()
    const { a, b, mine, theirs } = await twoHierarchies(sys)
    const caller = db.$setAuth(as('developer', { workspaceId: a.id }))

    for (const accessor of ACCESSORS) {
      await expect(caller[accessor].create({ data: {
        workspaceId: b.id, name: 'x', slug: `x-${accessor}`, ...extras(accessor, theirs),
      } })).rejects.toThrow(/Outside your workspaceId|denied by @@allow/)

      // The post-update half: the row was the caller's when the UPDATE matched
      // it and would not be afterwards, so it rolls back.
      await expect(moveTo(caller, sys, accessor, mine[accessor].id, b.id))
        .rejects.toThrow(/Outside your workspaceId|denied by @@allow/)
      expect((await sys[accessor].findUnique({ where: { id: mine[accessor].id } })).workspaceId).toBe(a.id)
    }
    db.$close()
  })

  test('the jobs still write across workspaces — they are asSystem()', async () => {
    // The deploy job sets App.status for whichever workspace the
    // deployment belongs to, and the job runner reads a Job the same way. If
    // this fails, the declaration has broken the paths a policy is meant not to
    // touch, and the symptom in the app would be a deploy that never lands.
    const db  = await client()
    const sys = db.asSystem()
    const { theirs } = await twoHierarchies(sys)

    expect((await sys.app.update({ where: { id: theirs.app.id }, data: { status: 'running' } })).status)
      .toBe('running')
    expect((await sys.project.findMany({})).length).toBe(2)
    db.$close()
  })
})

// ─── Tenancy, second batch ───────────────────────────────────────────────────
// Deployment, Job and Domain — the three models a person acts on that hang off
// an App rather than off the workspace directly. Their service reads filter on
// `appId` alone in several places (an app's recent deployments, a hostname's
// siblings), which is correct only because the app was already fetched inside
// the workspace. The declaration is what makes it correct without that
// argument, and these tests are what say so with no service in the picture.

describe('Deployment · Job · Domain — the tenancy declared', () => {

  /** Two workspaces, each with an app and one row of each kind under it. */
  async function twoFleets(sys: any) {
    const a = await seedWorkspace(sys)
    const b = await sys.workspace.create({ data: {
      accountId: a.accountId, ownerId: a.ownerId,
      name: 'Other', slug: `other-${Math.random().toString(36).slice(2, 8)}`,
    } })
    const build = async (ws: any, tag: string) => {
      const project = await sys.project.create({ data: { workspaceId: ws.id, name: tag, slug: tag } })
      const environment = await sys.environment.create({ data: {
        workspaceId: ws.id, projectId: project.id, name: 'prod', slug: 'prod', tier: 'production' } })
      const app = await sys.app.create({ data: {
        workspaceId: ws.id, environmentId: environment.id, name: 'web', slug: 'web' } })
      const deployment = await sys.deployment.create({ data: {
        workspaceId: ws.id, appId: app.id, environmentId: environment.id } })
      const job = await sys.job.create({ data: { workspaceId: ws.id, appId: app.id, name: `${tag}-nightly` } })
      const domain = await sys.domain.create({ data: {
        workspaceId: ws.id, appId: app.id, hostname: `${tag}.example.com` } })
      return { app, deployment, job, domain }
    }
    return { a, b, mine: await build(a, 'mine'), theirs: await build(b, 'theirs') }
  }

  /** What a create needs beyond the workspace, and who may make it. The gates
   *  differ — a Domain decides where traffic lands, so it is an admin act. */
  const SHAPES = [
    { accessor: 'deployment', role: 'developer', data: (h: any) => ({ appId: h.app.id }) },
    { accessor: 'job',        role: 'developer', data: (h: any) => ({ appId: h.app.id, name: 'nightly' }) },
    { accessor: 'domain',     role: 'admin',     data: (h: any) => ({ appId: h.app.id, hostname: 'x.example.com' }) },
  ] as const

  test('a caller reads only the rows of the workspace on their principal', async () => {
    const db  = await client()
    const sys = db.asSystem()
    const { a, mine } = await twoFleets(sys)

    for (const { accessor, role } of SHAPES) {
      const caller = db.$setAuth(as(role, { workspaceId: a.id }))
      // No `where` at all: anything past the caller's own row came back because
      // nothing filtered it.
      const rows = await caller[accessor].findMany({})
      expect({ accessor, ids: rows.map((r: any) => r.id) })
        .toEqual({ accessor, ids: [(mine as any)[accessor].id] })
    }
    db.$close()
  })

  test('an appId-only read cannot reach another workspace app', async () => {
    // The shape the services actually use — `where: { appId }` with no
    // workspace clause, safe today only because the app was fetched scoped.
    // Handed the other tenant's appId directly, it must answer nothing.
    const db  = await client()
    const sys = db.asSystem()
    const { a, theirs } = await twoFleets(sys)

    for (const { accessor, role } of SHAPES) {
      const caller = db.$setAuth(as(role, { workspaceId: a.id }))
      expect({ accessor, rows: await caller[accessor].findMany({ where: { appId: theirs.app.id } }) })
        .toEqual({ accessor, rows: [] })
      expect({ accessor, one: await caller[accessor].findUnique({ where: { id: (theirs as any)[accessor].id } }) })
        .toEqual({ accessor, one: null })
    }
    db.$close()
  })

  test('nothing can be created into, or moved into, another workspace', async () => {
    const db  = await client()
    const sys = db.asSystem()
    const { a, b, mine, theirs } = await twoFleets(sys)

    for (const { accessor, role, data } of SHAPES) {
      const caller = db.$setAuth(as(role, { workspaceId: a.id }))

      await expect(caller[accessor].create({ data: { workspaceId: b.id, ...data(theirs) } }))
        .rejects.toThrow(/Outside your workspaceId|denied by @@allow/)

      // The post-update half: the row was the caller's when the UPDATE matched
      // it and would not be afterwards, so it rolls back.
      await expect(moveTo(caller, sys, accessor, (mine as any)[accessor].id, b.id))
        .rejects.toThrow(/Outside your workspaceId|denied by @@allow/)
      expect((await sys[accessor].findUnique({ where: { id: (mine as any)[accessor].id } })).workspaceId)
        .toBe(a.id)
    }
    db.$close()
  })

  test('the jobs still advance another workspace release — they are asSystem()', async () => {
    // The deploy job writes status and steps for whichever workspace the
    // release belongs to, and the job runner reads and stamps a Job the same
    // way. If this fails, the declaration has caught the paths a policy is meant
    // not to touch, and the symptom in the app is a deploy that never lands.
    const db  = await client()
    const sys = db.asSystem()
    const { theirs } = await twoFleets(sys)

    expect((await sys.deployment.update({
      where: { id: theirs.deployment.id }, data: { status: 'success' } })).status).toBe('success')
    expect((await sys.job.update({
      where: { id: theirs.job.id }, data: { status: 'running' } })).status).toBe('running')
    expect((await sys.deployment.findMany({})).length).toBe(2)
    db.$close()
  })
})

// ─── Tenancy, third batch ────────────────────────────────────────────────────
// The six that hang off the workspace directly and are not credential material:
// a network, a recipe, a flag, a channel, an alert rule, a dashboard. Nothing
// reads any of them across a workspace outside the hub and the fleet jobs,
// both asSystem(), so the declaration is the same fact their services already
// filter on. The gates differ (a Recipe is "4.5", a Network and a channel are
// "2.5"), so each row states who acts.

describe('the workspace-owned six — the tenancy declared', () => {

  const SHAPES = [
    { accessor: 'network',             role: 'admin',     data: (t: string) => ({ name: `edge-${t}`, slug: `edge-${t}`, cidr: '10.0.0.0/16' }) },
    { accessor: 'recipe',              role: 'admin',     data: (t: string) => ({ name: `harden-${t}`, slug: `harden-${t}`, script: 'echo hi' }) },
    { accessor: 'featureFlag',         role: 'developer', data: (t: string) => ({ key: `flag-${t}`, name: 'Flag' }) },
    { accessor: 'notificationChannel', role: 'admin',     data: (t: string) => ({ name: `#ops-${t}`, kind: 'slack', config: { channel: '#ops' } }) },
    { accessor: 'alertRule',           role: 'admin',     data: (t: string) => ({ name: `CPU high ${t}`, metricName: 'cpu', severity: 'critical' }) },
    { accessor: 'dashboard',           role: 'developer', data: (t: string) => ({ name: `Overview ${t}`, slug: `overview-${t}` }) },
  ] as const

  /** Two workspaces, one row of every kind in each. */
  async function twoWorkspaces(sys: any) {
    const a = await seedWorkspace(sys)
    const b = await sys.workspace.create({ data: {
      accountId: a.accountId, ownerId: a.ownerId,
      name: 'Other', slug: `other-${Math.random().toString(36).slice(2, 8)}`,
    } })
    const rows: Record<string, { mine: any; theirs: any }> = {}
    for (const { accessor, data } of SHAPES)
      rows[accessor] = {
        mine:   await sys[accessor].create({ data: { workspaceId: a.id, ...data('mine') } }),
        theirs: await sys[accessor].create({ data: { workspaceId: b.id, ...data('theirs') } }),
      }
    return { a, b, rows }
  }

  test('a caller reads only the rows of the workspace on their principal', async () => {
    const db  = await client()
    const sys = db.asSystem()
    const { a, rows } = await twoWorkspaces(sys)

    for (const { accessor, role } of SHAPES) {
      const caller = db.$setAuth(as(role, { workspaceId: a.id }))
      const got    = await caller[accessor].findMany({})
      expect({ accessor, ids: got.map((r: any) => r.id) })
        .toEqual({ accessor, ids: [rows[accessor].mine.id] })
    }
    db.$close()
  })

  test('naming another workspace does not reach its rows', async () => {
    const db  = await client()
    const sys = db.asSystem()
    const { a, b, rows } = await twoWorkspaces(sys)

    for (const { accessor, role } of SHAPES) {
      const caller = db.$setAuth(as(role, { workspaceId: a.id }))
      expect({ accessor, byId: await caller[accessor].findUnique({ where: { id: rows[accessor].theirs.id } }) })
        .toEqual({ accessor, byId: null })
      // A filter that asks for the other tenant by name is answered, not obeyed.
      expect({ accessor, byWs: await caller[accessor].findFirst({ where: { workspaceId: b.id } }) })
        .toEqual({ accessor, byWs: null })
    }
    db.$close()
  })

  test('nothing can be created into, or moved into, another workspace', async () => {
    const db  = await client()
    const sys = db.asSystem()
    const { a, b, rows } = await twoWorkspaces(sys)

    for (const { accessor, role, data } of SHAPES) {
      const caller = db.$setAuth(as(role, { workspaceId: a.id }))

      await expect(caller[accessor].create({ data: { workspaceId: b.id, ...data('smuggled') } }))
        .rejects.toThrow(/Outside your workspaceId|denied by @@allow/)

      await expect(moveTo(caller, sys, accessor, rows[accessor].mine.id, b.id))
        .rejects.toThrow(/Outside your workspaceId|denied by @@allow/)
      expect((await sys[accessor].findUnique({ where: { id: rows[accessor].mine.id } })).workspaceId)
        .toBe(a.id)
    }
    db.$close()
  })

  test('the hub and the fleet jobs still cross — they are asSystem()', async () => {
    // The hub lists every workspace's flags and toggles one; the fleet job
    // stamps a Recipe for whichever workspace owns the run. Both are the paths
    // a policy is meant not to touch, and both would go quiet rather than throw.
    const db  = await client()
    const sys = db.asSystem()
    const { rows } = await twoWorkspaces(sys)

    expect((await sys.featureFlag.findMany({})).length).toBe(2)
    expect((await sys.featureFlag.update({
      where: { id: rows.featureFlag.theirs.id }, data: { isEnabled: true } })).isEnabled).toBe(true)
    expect((await sys.recipe.update({
      where: { id: rows.recipe.theirs.id }, data: { lastRunAt: new Date().toISOString() } })).lastRunAt)
      .toBeTruthy()
    db.$close()
  })
})

// ─── Tenancy, the credential pair ────────────────────────────────────────────
// `Secret` and `ApiKey` were held back from the batches because they are the two
// with real system readers: the conduit resolver reading `secret:<id>`, the
// channels service writing a channel's credential, and the API-key guard asking
// whether a key may act at all. All three are `asSystem()` — which is what makes
// the declaration safe, and is the thing these tests check has not moved.

describe('Secret · ApiKey — the tenancy declared over credential material', () => {

  async function twoVaults(sys: any) {
    const a = await seedWorkspace(sys)
    const b = await sys.workspace.create({ data: {
      accountId: a.accountId, ownerId: a.ownerId,
      name: 'Other', slug: `other-${Math.random().toString(36).slice(2, 8)}`,
    } })
    const build = async (ws: any, tag: string) => ({
      secret: await sys.secret.create({ data: {
        workspaceId: ws.id, name: `deploy-key-${tag}`, kind: 'ssh_key', data: 'PRIVATE', createdBy: 'u1' } }),
      apiKey: await sys.apiKey.create({ data: {
        workspaceId: ws.id, userId: a.ownerId, name: `ci-${tag}`, tokenHint: `bc_${tag}` } }),
    })
    return { a, b, mine: await build(a, 'mine'), theirs: await build(b, 'theirs') }
  }

  const ACCESSORS = ['secret', 'apiKey'] as const

  test('an admin reads only their own workspace vault', async () => {
    const db  = await client()
    const sys = db.asSystem()
    const { a, mine } = await twoVaults(sys)
    const caller = db.$setAuth(as('admin', { workspaceId: a.id }))

    for (const accessor of ACCESSORS) {
      const rows = await caller[accessor].findMany({})
      expect({ accessor, ids: rows.map((r: any) => r.id) })
        .toEqual({ accessor, ids: [(mine as any)[accessor].id] })
    }
    db.$close()
  })

  test('another workspace\'s credential is unreachable by id', async () => {
    const db  = await client()
    const sys = db.asSystem()
    const { a, theirs } = await twoVaults(sys)
    const caller = db.$setAuth(as('admin', { workspaceId: a.id }))

    for (const accessor of ACCESSORS)
      expect({ accessor, row: await caller[accessor].findUnique({ where: { id: (theirs as any)[accessor].id } }) })
        .toEqual({ accessor, row: null })
    db.$close()
  })

  test('nothing can be created into, or moved into, another workspace', async () => {
    const db  = await client()
    const sys = db.asSystem()
    const { a, b, mine } = await twoVaults(sys)
    const caller = db.$setAuth(as('admin', { workspaceId: a.id }))

    await expect(caller.secret.create({ data: {
      workspaceId: b.id, name: 'smuggled', kind: 'generic', data: 'X', createdBy: 'u1' } }))
      .rejects.toThrow(/Outside your workspaceId|denied by @@allow/)
    await expect(caller.apiKey.create({ data: {
      workspaceId: b.id, userId: a.ownerId, name: 'smuggled', tokenHint: 'bc_x' } }))
      .rejects.toThrow(/Outside your workspaceId|denied by @@allow/)

    for (const accessor of ACCESSORS) {
      await expect(moveTo(caller, sys, accessor, (mine as any)[accessor].id, b.id))
        .rejects.toThrow(/Outside your workspaceId|denied by @@allow/)
      expect((await sys[accessor].findUnique({ where: { id: (mine as any)[accessor].id } })).workspaceId)
        .toBe(a.id)
    }
    db.$close()
  })

  test('the three system readers still reach across — they are asSystem()', async () => {
    // The conduit resolver looks a Secret up BY ID with no workspace in the
    // query (core/credentials.ts), and the API-key guard looks a key up by its
    // credential id (services/api-keys/scopes.ts). Both are the caller's
    // workspace only by coincidence of who is asking; a policy applied to them
    // would fail every send and refuse every key, silently.
    const db  = await client()
    const sys = db.asSystem()
    const { theirs } = await twoVaults(sys)

    expect((await sys.secret.findFirst({ where: { id: theirs.secret.id } }))?.data).toBe('PRIVATE')
    expect((await sys.apiKey.findUnique({ where: { id: theirs.apiKey.id } }))?.name).toBe('ci-theirs')
    expect((await sys.apiKey.update({
      where: { id: theirs.apiKey.id }, data: { totalUses: 1 } })).totalUses).toBe(1)
    db.$close()
  })

  test('@encrypted is still what hides the material, not the policy', async () => {
    // The policy answers WHICH rows; `data` being absent from a scoped read is
    // `@encrypted`, and it is absent from the caller's OWN secret too. Losing
    // one of the two would look identical on a cross-workspace read.
    const db  = await client()
    const sys = db.asSystem()
    const { a, mine } = await twoVaults(sys)
    const caller = db.$setAuth(as('admin', { workspaceId: a.id }))

    const own = await caller.secret.findUnique({ where: { id: mine.secret.id } })
    expect(own?.id).toBe(mine.secret.id)
    expect('data' in (own ?? {})).toBe(false)
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
    const db  = await client()
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
    const db  = await client()
    const sys = db.asSystem() as any
    const { rule, chan } = await seedRuleAndChannel(sys)

    await sys.alertRuleChannel.create({ data: { ruleId: rule.id, channelId: chan.id } })
    await expect(
      sys.alertRuleChannel.create({ data: { ruleId: rule.id, channelId: chan.id } }),
    ).rejects.toThrow()
    db.$close()
  })

  test('deleting a channel takes its links with it — no rule is left pointing at nothing', async () => {
    const db  = await client()
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
    const db  = await client()
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
    const db  = await client()
    const sys = db.asSystem() as any
    const { user } = await seedKey(sys)

    await expect(sys.apiKey.create({
      data: { workspaceId: 'no-such-workspace', userId: user.id, name: 'x', tokenHint: 'fjs_x…y' },
    })).rejects.toThrow()
    db.$close()
  })

  test('two keys in one workspace cannot share a name', async () => {
    const db  = await client()
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
    const db  = await client()
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
    const db  = await client()
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
    const auditDir = scratchDir('audit-apikey')

    const db  = await client({ databases: { audit: { path: auditDir } } })
    const sys = db.asSystem() as any
    const { key } = await seedKey(sys)
    await sys.apiKey.update({
      where: { id: key.id },
      data:  { revokedAt: new Date().toISOString(), credentialId: null },
    })

    const entries = await auditEntries(auditDir, 'api_key', ['create', 'update'])

    db.$close()
    expect(entries.map(e => e.operation)).toContain('create')
    expect(entries.map(e => e.operation)).toContain('update')
    // Stated, because the poll above has to fit inside it — bun's default is
    // 5s and the writer's own buffer is ~1s of that.
  }, 20_000)
})

// ─── Compatibility with @frontierjs/auth ─────────────────────────────────────

describe('auth compatibility', () => {
  test('createUser({email, name, role}) succeeds — Basecamp adds no required column', async () => {
    // auth.ts writes exactly these three fields. Any Basecamp addition to User
    // that is NOT nullable or defaulted makes user creation throw.
    const db   = await client()
    const user = await db.asSystem().user.create({
      data: { email: 'sam@example.com', name: 'Sam', role: 'user' },
    })
    expect(user.id).toBeTruthy()
    expect(user.kind).toBe('human')          // defaulted
    expect(user.accountId).toBe(null)        // nullable
    db.$close()
  })

  test('accountId is String — an Int column could not hold Account.id', async () => {
    const db   = await client()
    const sys  = db.asSystem()
    const acct = await sys.account.create({ data: { slug: 'acme', displayName: 'Acme' } })
    const user = await sys.user.create({ data: { email: 'a@b.co', accountId: acct.id } })
    expect(user.accountId).toBe(acct.id)
    expect(acct.id).toMatch(/^[0-9a-f-]{36}$/)
    db.$close()
  })
})

// ─── Volumes ─────────────────────────────────────────────────────────────────
// The first OBSERVED model here — Docker made the disk, an outpost found it, and
// the table is a picture rather than a record. What these pin is the part of
// that which is a schema decision: where its tenancy comes from, that the same
// disk cannot be recorded twice, and that its size is stored in the unit the
// outpost reports.

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
    const db  = await client()
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
    const db  = await client()
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
    const db  = await client()
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
    const db  = await client()
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
    const db  = await client()
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
    const db  = await client()
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
    const db  = await client()
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
    const db  = await client()
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
    const db  = await client()
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

    // UNIQUE(serverId) is what makes an outpost report an upsert rather than an
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
    const db  = await client()
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
    const db  = await client()
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
    const db  = await client()
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
    const db  = await client()
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

// ─── The two state machines, executed ────────────────────────────────────────
// `@@transitions` is the one statement of what a release and a job may do next.
// It replaced three copies of that fact — a TERMINAL list in the deployments
// service, a CANCELLABLE list beside it, and a third copy in the screen — so
// what has to hold is that the boundary refuses the moves those lists used to,
// and that it refuses them for a caller who never goes through the service.

describe('Deployment and Job declare their own state machines', () => {
  // The level comes off `memberRole`, not off `isAdmin` — basecampGateLevel
  // grades a workspace membership and a principal without one is VISITOR(1),
  // which cannot update anything. developer is USER(4), admin ADMINISTRATOR(5).
  function as(db: any, ws: any, memberRole: string) {
    return db.$setAuth({ id: `u-${memberRole}`, workspaceId: ws.id, memberRole })
  }

  async function aDeployment(sys: any, ws: any, status = 'pending') {
    const uniq = () => Math.random().toString(36).slice(2, 8)
    const proj = await sys.project.create({
      data: { workspaceId: ws.id, name: 'P', slug: `p-${uniq()}` },
    })
    const env = await sys.environment.create({
      data: { projectId: proj.id, workspaceId: ws.id, name: 'Prod', slug: 'prod', tier: 'production' },
    })
    const app = await sys.app.create({
      data: { environmentId: env.id, workspaceId: ws.id, name: 'web', slug: `web-${uniq()}`, type: 'container' },
    })
    return sys.deployment.create({ data: { appId: app.id, environmentId: env.id, workspaceId: ws.id, status } })
  }

  test('a release walks its pipeline and cannot walk back', async () => {
    const db  = await client()
    const sys = db.asSystem() as any
    const ws  = await seedWorkspace(sys)
    const d   = await aDeployment(sys, ws)

    // asSystem() bypasses transitions by design, so enforcement has to be asked
    // of a SCOPED client — which is what every request holds.
    const dev = as(db, ws, 'developer')

    expect((await dev.deployment.update({ where: { id: d.id }, data: { status: 'building' } })).status)
      .toBe('building')

    // building -> pending is not declared, and the refusal NAMES what is legal
    // from here, which the old `TERMINAL.includes(...)` guard never did.
    await expect(dev.deployment.update({ where: { id: d.id }, data: { status: 'pending' } }))
      .rejects.toThrow(/from 'building' to 'pending'/)

    db.$close()
  })

  test('a terminal release cannot be cancelled, which is what the service used to check', async () => {
    const db  = await client()
    const sys = db.asSystem() as any
    const ws  = await seedWorkspace(sys)
    const d   = await aDeployment(sys, ws, 'success')

    await expect(as(db, ws, 'admin').deployment.update({ where: { id: d.id }, data: { status: 'cancelled' } }))
      .rejects.toThrow(/from 'success' to 'cancelled'/)

    db.$close()
  })

  test('transitions(row) answers the buttons the screen renders', async () => {
    const db  = await client()
    const sys = db.asSystem() as any
    const ws  = await seedWorkspace(sys)
    const d   = await aDeployment(sys, ws, 'building')

    // The same list `resource.transitions(row)` hands the browser.
    expect((await sys.deployment.transitions(d)).map((m: any) => m.name).sort())
      .toEqual(['cancel', 'fail', 'push', 'succeed'])

    const done = await sys.deployment.transitions({ ...d, status: 'success' })
    expect(done.map((m: any) => m.name)).toEqual(['rollback'])
    expect(done[0].gate).toBe(5)

    db.$close()
  })

  test('a rollback is gated above the level that may deploy', async () => {
    const db  = await client()
    const sys = db.asSystem() as any
    const ws  = await seedWorkspace(sys)
    const d   = await aDeployment(sys, ws, 'success')

    // Deployment's update gate is USER(4) and a developer passes it — this
    // refusal is the MOVE's own floor, which is the whole reason @gate exists
    // on a transition rather than only on the model.
    await expect(as(db, ws, 'developer').deployment.update({ where: { id: d.id }, data: { status: 'rolled_back' } }))
      .rejects.toThrow()

    // …and an administrator makes the same move.
    expect((await as(db, ws, 'admin').deployment.update({ where: { id: d.id }, data: { status: 'rolled_back' } })).status)
      .toBe('rolled_back')

    db.$close()
  })

  test("a job's status is its state, so a successful run returns it to pending", async () => {
    const db  = await client()
    const sys = db.asSystem() as any
    const ws  = await seedWorkspace(sys)
    const job = await sys.job.create({ data: { workspaceId: ws.id, name: 'Nightly', kind: 'scheduled' } })
    // Job's update gate is ADMINISTRATOR(5), not USER(4) — `@@gate("2.4.4.5")`.
    const admin = as(db, ws, 'admin')

    await admin.job.update({ where: { id: job.id }, data: { status: 'running' } })
    expect((await admin.job.update({ where: { id: job.id }, data: { status: 'pending' } })).status).toBe('pending')

    // pending -> failed is not a move: a job that never ran did not fail.
    await expect(admin.job.update({ where: { id: job.id }, data: { status: 'failed' } }))
      .rejects.toThrow(/from 'pending' to 'failed'/)

    db.$close()
  })

  test('a failed job can be re-run and can be cancelled', async () => {
    const db  = await client()
    const sys = db.asSystem() as any
    const ws  = await seedWorkspace(sys)
    const job = await sys.job.create({ data: { workspaceId: ws.id, name: 'Flaky', status: 'failed' } })

    // `cancel` reaches `failed` because remove() cancels whatever it soft-
    // deletes — a job left pending behind a deletedAt is invisible to every
    // read and still on the clock.
    expect((await sys.job.transitions(job)).map((m: any) => m.name).sort()).toEqual(['cancel', 'start'])

    const cancelled = await as(db, ws, 'admin').job.update({ where: { id: job.id }, data: { status: 'cancelled' } })
    expect(cancelled.status).toBe('cancelled')

    // …and cancelled is the end of the line, which is why remove() now asks
    // before it writes rather than cancelling unconditionally.
    expect(await sys.job.transitions(cancelled)).toEqual([])

    db.$close()
  })
})

// ─── Declared constraints, executed ──────────────────────────────────────────
// The other half of the access snapshot's argument. `db/access.snapshot.md`
// DESCRIBES what the schema declares and CI fails a stale one; this asks whether
// the declarations are enforced by a real write. A rule that reaches the browser
// through `x-messages` and is ignored by the server is the failure it exists for.

describe('the access and constraints this schema declares are enforced', () => {
  test('every rule on every model, against a real write', async () => {
    const env = await makeEnv()
    // Each row is already a sentence naming the model, the field and the rule.
    expect((await env.verifyConstraints()).map((m: any) => m.message)).toEqual([])
  }, 60_000)

  test('every protected field is absent below SYSTEM, and present at it', async () => {
    // The column boundary, not the row one. Secret.data is @guarded under a gate
    // that admits ADMINISTRATOR(5), so the field policy is the only thing
    // between an admin and a private key — and a column absent for EVERYONE
    // would pass a check that only looked at the first half.
    const env = await makeEnv()
    expect((await env.verifyFieldProtection()).map((m: any) => m.message)).toEqual([])
  }, 60_000)

  test('every row policy, on rows both sides of its predicate', async () => {
    // A gate refuses and a policy FILTERS, so a wrong one is an empty screen
    // with a 200 and nothing raises anywhere. This grades the compiled WHERE
    // against litestone's own JS evaluator — two independent implementations of
    // one rule. `Server`'s workspace tenancy is the live case.
    // `got: 'skipped'` is the checker REPORTING rather than guessing — a
    // delegated `check()` policy or one gated at SYSTEM, which no synthetic
    // principal can hold. Since `tenancy { strategy row }` generates a
    // `check(parent)` rule for each of the fourteen models scoped through a
    // parent, skipped rows are now the normal state and a violation is what
    // must be empty.
    const env       = await makeEnv()
    const graded    = (await env.verifyRowPolicies()) as any[]
    const violations = graded.filter(m => m.got !== 'skipped')

    expect(violations.map(m => m.message)).toEqual([])
    // The report is asserted too: it should be delegations and SYSTEM gates and
    // nothing else, so a NEW ungradable shape is loud rather than absorbed.
    for (const m of graded)
      expect(m.message).toMatch(/delegates to another model's policy|which no principal can hold/)
  }, 60_000)

  test('every gated model, every level, all four operations', async () => {
    // 37 models x 4 ops x 9 levels. `skipped` rows are Server.create, whose
    // @@allow refuses a synthetic principal before the gate is reached — a
    // policy filters, so it can only ever turn an allow into a deny.
    const env = await makeEnv()
    const rows = await env.verifyGateLadder()
    const graded = rows.filter((m: any) => m.got !== 'skipped')
    expect(graded.map((m: any) => m.message)).toEqual([])
  }, 120_000)
})
