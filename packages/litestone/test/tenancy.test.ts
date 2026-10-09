// `tenancy { }` — the one declaration of what a tenant is.
//
// Two strategies and one block. What this suite exists to hold:
//
//   1. **Row tenancy is a NARROWING.** It desugars into `@@deny`, never
//      `@@allow` — allows are OR'd within an operation, so an allow added to a
//      model that already has one widens its reads to every row in the tenant.
//      The isolation cases below are run against a real client for that reason:
//      a policy that admits everything and a policy that is not applied at all
//      look identical from one side.
//   2. **Create and read want opposite answers about an absent value.**
//      checkCreatePolicy runs BEFORE the @default stamp, so a create that omits
//      the column is legitimate; a READ of a row holding no tenant is not.
//   3. **One resolution, four readers.** The registry, the CLI, Studio and
//      Junction all ask `resolveTenancy`, and the precedence — option, then
//      declaration, then default — is asserted rather than repeated.

import { describe, it, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parse } from '../src/core/parser.js'
import { createClient } from '../src/core/client.js'
import { resolveTenancy, tenantFrom } from '../src/core/tenancy.js'
import { createTenantRegistry } from '../src/tenant.js'

const ROW_SCHEMA = `
tenancy {
  strategy row
  column   workspaceId
}

model Project {
  id          Int    @id
  workspaceId Int
  name        String
  @@allow('read', name != '')
}

model Plan {
  id   Int    @id
  code String
  @@tenant(none)
}
`

const tmpDirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'lite-tenancy-'))
  tmpDirs.push(d)
  return d
}
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }) })

describe('tenancy block — parsing', () => {
  it('reads a database block whole', () => {
    const r = parse(`
      tenancy {
        strategy database
        dir      "./tenants"
        registry "./reg.db"
        maxOpen  50
        key      env("TENANT_KEY")
        resolve  subdomain
      }
      model Post { id Int @id }
    `)
    expect(r.valid).toBe(true)
    expect(r.schema.tenancy.strategy).toBe('database')
    expect(r.schema.tenancy.maxOpen).toBe(50)
    expect(r.schema.tenancy.key).toEqual({ kind: 'env', var: 'TENANT_KEY', default: null })
    expect(r.schema.tenancy.resolve).toEqual({ kind: 'subdomain', name: null })
  })

  it('defaults the claim to the column', () => {
    const r = parse(`tenancy { strategy row  column accountId }  model A { id Int @id  accountId Int }`)
    expect(r.schema.tenancy.claim).toBe('accountId')
  })

  it('refuses a property belonging to the other strategy', () => {
    const r = parse(`tenancy { strategy database  column wid }  model A { id Int @id }`)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toContain(`'column' is not a property of strategy database`)
  })

  it('refuses a second block rather than merging', () => {
    const r = parse(`tenancy { strategy row column w } tenancy { strategy row column w } model A { id Int @id }`)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toContain('declared twice')
  })

  it('refuses resolve under strategy row, where nothing reads it', () => {
    const r = parse(`tenancy { strategy row column w resolve header("X-Tenant") } model A { id Int @id w Int }`)
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toContain("'resolve' is not a property of strategy row")
    expect(r.errors.join(' ')).toContain('tenantFrom')
    // The control: the same line under strategy database is the registry's.
    expect(parse(`tenancy { strategy database  resolve header("X-Tenant") } model A { id Int @id }`).valid).toBe(true)
  })

  it('names an unknown resolve form', () => {
    const r = parse(`tenancy { strategy database  resolve cookie("t") } model A { id Int @id }`)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toContain('subdomain, header("X-Name") or claim(fieldName)')
  })

  it('refuses @@tenant with no block, and under strategy database', () => {
    expect(parse(`model A { id Int @id  @@tenant(none) }`).errors[0]).toContain('no \'tenancy\' block')
    expect(parse(`tenancy { strategy database } model A { id Int @id @@tenant(none) }`).errors[0])
      .toContain('strategy row attribute')
  })

  it('refuses @@tenant naming a column the model does not declare', () => {
    const r = parse(`tenancy { strategy row column wid } model A { id Int @id @@tenant(column: "nope") }`)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toContain('names no field on this model')
  })
})

describe('tenancy { strategy row } — desugaring', () => {
  const parsed = parse(ROW_SCHEMA)
  const project = parsed.schema.models.find((m: any) => m.name === 'Project')!
  const plan    = parsed.schema.models.find((m: any) => m.name === 'Plan')!

  it('scopes with denies, never allows', () => {
    expect(parsed.valid).toBe(true)
    const generated = project.attributes.filter((a: any) => a.generated === 'tenancy')
    expect(generated.every((a: any) => a.kind === 'deny')).toBe(true)
    // The model's own @@allow is untouched — tenancy narrows what it admits.
    expect(project.attributes.filter((a: any) => a.kind === 'allow')).toHaveLength(1)
  })

  it('splits create from the reading operations, and grades the result of an update', () => {
    const ops = project.attributes
      .filter((a: any) => a.generated === 'tenancy')
      .map((a: any) => a.operations.join(','))
    // `create` is its own rule because `checkCreatePolicy` runs BEFORE the
    // stamp: an absent column is legitimate on create and belongs to nobody on
    // read. `post-update` rides with the first rule because it asks the same
    // question of the row the write produced — *is this still mine* — which is
    // what stops a caller pushing their own row into another tenant.
    expect(ops).toEqual(['read,update,delete,post-update', 'create'])
  })

  it('stamps the column', () => {
    const field = project.fields.find((f: any) => f.name === 'workspaceId')!
    expect(field.attributes).toContainEqual(
      { kind: 'default', value: { kind: 'call', fn: 'auth', field: 'workspaceId' }, generated: 'tenancy' },
    )
  })

  it('leaves an app-declared default alone', () => {
    const r = parse(`
      tenancy { strategy row  column wid }
      model A { id Int @id  wid Int @default(7) }
    `)
    const defaults = r.schema.models[0].fields.find((f: any) => f.name === 'wid').attributes
      .filter((a: any) => a.kind === 'default')
    expect(defaults).toHaveLength(1)
    expect(defaults[0].value).toEqual({ kind: 'number', value: 7 })
  })

  it('leaves @@tenant(none) entirely alone', () => {
    expect(plan.attributes.filter((a: any) => a.generated === 'tenancy')).toHaveLength(0)
  })

  it('reports the models it did not scope, once, by name', () => {
    const r = parse(`
      tenancy { strategy row  column wid }
      model A { id Int @id  wid Int }
      model B { id Int @id }
      model C { id Int @id }
    `)
    const warning = r.warnings.find(w => w.startsWith('tenancy:'))!
    expect(warning).toContain('B, C')
    expect(warning).toContain('@@tenant(none)')
    expect(r.warnings.filter(w => w.startsWith('tenancy:'))).toHaveLength(1)
  })

  // The jsonl driver runs no access layer, so a scope generated onto one of its
  // models was a rule the schema stated and nothing ran: a stranger created and
  // read every tenant's rows, and a create stamped no tenant (FJS-1920).
  it('refuses a jsonl model holding the tenant column — the driver cannot scope it', () => {
    const r = parse(`
      tenancy { strategy row  column wid }
      database main { path "./app.db" }
      database logs { path "./logs/"  driver jsonl }
      model A       { id Int @id  wid Int  @@db(main) }
      model ApiCall { wid Int  path String  @@db(logs) }
    `)
    expect(r.valid).toBe(false)
    const err = r.errors.find((e: string) => e.includes('ApiCall'))!
    expect(err).toContain('driver jsonl')
    expect(err).toContain('@@tenant(none)')
  })

  it('refuses @@tenant(column:) on a jsonl model', () => {
    const r = parse(`
      tenancy { strategy row  column wid }
      database logs { path "./logs/"  driver jsonl }
      model ApiCall { owner Int  path String  @@db(logs)  @@tenant(column: "owner") }
    `)
    expect(r.errors.join(' ')).toContain('driver jsonl')
  })

  it('refuses @@gate and @@allow on a jsonl model, and a client will not open it', async () => {
    for (const rule of ['@@gate("8")', `@@allow('read', auth() != null)`]) {
      const text = `
        database rawj { path "./rawj/" driver jsonl }
        model Note { id String @id @default(uuid())  text String  @@db(rawj)  ${rule} }
      `
      const r = parse(text)
      expect(r.errors.join(' ')).toContain(`Model 'Note': @@${rule.slice(2, rule.indexOf('('))}`)
      expect(r.errors.join(' ')).toContain('driver jsonl')
      await expect(createClient({ schema: text, databases: ':memory:' })).rejects.toThrow('driver jsonl')
    }
  })

  it('leaves a jsonl model with no tenant column, or @@tenant(none), unscoped and valid', () => {
    const r = parse(`
      tenancy { strategy row  column wid }
      database main { path "./app.db" }
      database logs { path "./logs/"  driver jsonl }
      database audit { path "./audit/" driver trail }
      model A       { id Int @id  wid Int  @@db(main)  @@trail(audit) }
      model Hit     { path String  @@db(logs) }
      model ApiCall { wid Int  path String  @@db(logs)  @@tenant(none) }
    `)
    expect(r.errors).toEqual([])
    for (const name of ['Hit', 'ApiCall']) {
      const m = r.schema.models.find((m: any) => m.name === name)!
      expect(m.attributes.filter((a: any) => a.generated === 'tenancy')).toHaveLength(0)
    }
  })

  it('does not fire the "@@deny with no @@allow" warning about its own rules', () => {
    const r = parse(`tenancy { strategy row  column wid }  model A { id Int @id  wid Int }`)
    expect(r.warnings.filter(w => w.includes('@@deny and no @@allow'))).toHaveLength(0)
  })
})

describe('tenancy { strategy row } — a real client', () => {
  it('isolates reads, writes and creates by the caller\'s own claim', async () => {
    const db  = await createClient({ schema: ROW_SCHEMA, db: ':memory:' })
    const sys = db.asSystem()
    await sys.project.create({ data: { workspaceId: 1, name: 'acme-a' } })
    await sys.project.create({ data: { workspaceId: 2, name: 'globex-a' } })
    await sys.plan.create({ data: { code: 'pro' } })

    const acme   = db.$setAuth({ id: 1, workspaceId: 1 })
    const globex = db.$setAuth({ id: 2, workspaceId: 2 })

    expect((await acme.project.findMany()).map((r: any) => r.name)).toEqual(['acme-a'])
    expect((await globex.project.findMany()).map((r: any) => r.name)).toEqual(['globex-a'])
    expect(await acme.project.count()).toBe(1)

    // Anonymous is not "every tenant", it is none of them.
    expect(await db.project.findMany()).toEqual([])

    // asSystem is the way across, and the only one.
    expect(await sys.project.count()).toBe(2)

    // A model that says it spans tenants does.
    expect((await globex.plan.findMany()).map((r: any) => r.code)).toEqual(['pro'])

    // The stamp: a create that omits the column is legitimate.
    const created = await acme.project.create({ data: { name: 'acme-b' } })
    expect(created.workspaceId).toBe(1)

    // …and one that states another tenant's is refused BY NAME rather than
    // written and then hidden.
    await expect(acme.project.create({ data: { workspaceId: 2, name: 'sneaky' } }))
      .rejects.toThrow('Outside your workspaceId')
    await expect(db.project.create({ data: { workspaceId: 1, name: 'anon' } }))
      .rejects.toThrow()

    // A row in the other tenant is not reachable to write or delete.
    const other = (await sys.project.findMany({ where: { workspaceId: 2 } }))[0] as any
    expect(await acme.project.update({ where: { id: other.id }, data: { name: 'hacked' } })).toBeNull()
    expect(await acme.project.delete({ where: { id: other.id } })).toBeNull()
    expect((await sys.project.findUnique({ where: { id: other.id } }) as any).name).toBe('globex-a')

    db.$close()
  })

  it('hides a row holding no tenant — a read is not a create', async () => {
    const db = await createClient({
      schema: `
        tenancy { strategy row  column wid }
        model A { id Int @id  wid Int?  name String }
      `,
      db: ':memory:',
    })
    await db.asSystem().a.create({ data: { name: 'orphan' } })
    expect(await db.$setAuth({ id: 1, wid: 1 }).a.findMany()).toEqual([])
    expect(await db.asSystem().a.count()).toBe(1)
    db.$close()
  })

  it('publishes the declaration on every flavor of client', async () => {
    const db = await createClient({ schema: ROW_SCHEMA, db: ':memory:' })
    for (const flavor of [db, db.asSystem(), db.$setAuth({ id: 1 })]) {
      expect(flavor.$tenancy.strategy).toBe('row')
      expect(flavor.$tenancy.column).toBe('workspaceId')
      // No `resolve` under row: the resolver says where a request names its
      // tenant, and a declared one would be read by nothing (FJS-D360).
      expect('resolve' in flavor.$tenancy).toBe(false)
    }
    db.$close()
  })

  it('is null when the schema declares no tenancy', async () => {
    const db = await createClient({ schema: `model A { id Int @id }`, db: ':memory:' })
    expect(db.$tenancy).toBeNull()
    db.$close()
  })
})

describe('resolveTenancy', () => {
  const parsed = (text: string) => parse(text).schema

  it('fills the defaults and resolves paths against the schema file', () => {
    const dir = tmp()
    const t = resolveTenancy(parsed(`tenancy { strategy database }  model A { id Int @id }`), {
      schemaPath: join(dir, 'schema.lite'),
    })!
    expect(t.dir).toBe(join(dir, 'tenants'))
    expect(t.registry).toBe(join(dir, 'tenants-registry.db'))
    expect(t.maxOpen).toBe(100)
    // Nothing can infer how a REQUEST names a tenant when each file is one.
    expect(t.resolve).toBeNull()
  })

  it('reads env() and lets an explicit option win', () => {
    process.env.__TENANCY_TEST_DIR = '/srv/tenants'
    const schema = parsed(`
      tenancy { strategy database  dir env("__TENANCY_TEST_DIR", "./fallback") }
      model A { id Int @id }
    `)
    expect(resolveTenancy(schema)!.dir).toBe('/srv/tenants')
    expect(resolveTenancy(schema, { overrides: { dir: '/opt/x' } })!.dir).toBe('/opt/x')
    delete process.env.__TENANCY_TEST_DIR
    expect(resolveTenancy(schema)!.dir).toBe(join(process.cwd(), 'fallback'))
  })

  it('says which env var is missing rather than resolving an empty path', () => {
    const schema = parsed(`tenancy { strategy database  dir env("__TENANCY_ABSENT") }  model A { id Int @id }`)
    expect(() => resolveTenancy(schema)).toThrow('__TENANCY_ABSENT')
  })

  it('reads the key as a value, never as a path', () => {
    const key = 'a'.repeat(64)
    const t = resolveTenancy(parsed(`tenancy { strategy database  key "${key}" }  model A { id Int @id }`))!
    expect(t.key).toBe(key)
  })
})

describe('tenantFrom', () => {
  it('takes the first label of a real subdomain only', () => {
    const r = { kind: 'subdomain' as const, name: null }
    expect(tenantFrom(r, { host: 'acme.example.com' })).toBe('acme')
    expect(tenantFrom(r, { host: 'acme.example.com:8100' })).toBe('acme')
    // A bare host is not a tenant called localhost.
    expect(tenantFrom(r, { host: 'localhost:8100' })).toBeNull()
    expect(tenantFrom(r, { host: 'example.com' })).toBeNull()
  })

  it('takes two labels when the last one is localhost', () => {
    // `.localhost` is a reserved TLD and every resolver already sends it to
    // loopback, so `acme.localhost:8000` is what a person types the first time
    // they try `resolve subdomain` — and answering null there reads as the
    // registry not knowing the tenant rather than the host never naming one.
    const r = { kind: 'subdomain' as const, name: null }
    expect(tenantFrom(r, { host: 'acme.localhost' })).toBe('acme')
    expect(tenantFrom(r, { host: 'acme.localhost:8110' })).toBe('acme')
    // Still not a tenant called localhost, and still not one called example.
    expect(tenantFrom(r, { host: 'localhost' })).toBeNull()
    expect(tenantFrom(r, { host: 'shop.localhost.example.com' })).toBe('shop')
  })

  it('matches a header whatever case the transport used', () => {
    const r = { kind: 'header' as const, name: 'X-Tenant-Id' }
    expect(tenantFrom(r, { headers: { 'x-tenant-id': 'acme' } })).toBe('acme')
    expect(tenantFrom(r, { headers: { 'X-Tenant-Id': 'acme' } })).toBe('acme')
    expect(tenantFrom(r, { headers: {} })).toBeNull()
  })

  it('reads a claim off the principal, as a string', () => {
    const r = { kind: 'claim' as const, name: 'workspaceId' }
    expect(tenantFrom(r, { principal: { workspaceId: 7 } })).toBe('7')
    expect(tenantFrom(r, { principal: null })).toBeNull()
  })
})

describe('createTenantRegistry reads the block', () => {
  it('opens the declared dir and registry with no options passed', async () => {
    const dir  = tmp()
    const text = `
      tenancy {
        strategy database
        dir      "./fleet"
        registry "./fleet-index.db"
      }
      model Post { id Int @id  title String }
    `
    await Bun.write(join(dir, 'schema.lite'), text)

    const tenants = await createTenantRegistry({ path: join(dir, 'schema.lite') })
    await tenants.create('acme')
    expect(existsSync(join(dir, 'fleet', 'acme.db'))).toBe(true)
    expect(existsSync(join(dir, 'fleet-index.db'))).toBe(true)
    expect(tenants.list()).toEqual(['acme'])

    const db = await tenants.get('acme')
    await db.asSystem().post.create({ data: { title: 'hello' } })
    expect(await db.asSystem().post.count()).toBe(1)
    tenants.close()
  })

  it('refuses a row schema instead of writing files nobody reads', async () => {
    await expect(createTenantRegistry({ schema: ROW_SCHEMA })).rejects.toThrow('strategy row')
  })

  // Every sqlite database is redirected to the tenant's own file, and a
  // jsonl/logger one is deliberately left alone — shared across the fleet. That
  // leaves its declared `path` resolving against the process CWD, which for an
  // app assembling its schema in memory is the only thing it can resolve
  // against: run a command from a surface directory and the audit trail lands
  // in a directory nobody looks in. `clientOptions.databases` is the way to pin
  // it, and it used to be dropped on the floor.
  it('lets clientOptions name a shared log path, and still owns the sqlite ones', async () => {
    const dir  = tmp()
    const logs = join(dir, 'elsewhere') + '/'
    const text = `
      tenancy { strategy database  dir "./fleet"  registry "./fleet-index.db" }
      database main { path "./main.db" }
      database logs { path "./logs/"  driver trail }
      model Post { id Int @id  title String  @@trail(logs) }
    `
    await Bun.write(join(dir, 'schema.lite'), text)

    const tenants = await createTenantRegistry({
      path:          join(dir, 'schema.lite'),
      clientOptions: { databases: { logs: { path: logs } } },
    })
    await tenants.create('acme')
    const db: any = await tenants.get('acme')

    // An override is resolved as a path, so the trailing slash it was written
    // with is not part of the answer.
    const paths = db.$databases
    expect(paths.logs.path).toBe(join(dir, 'elsewhere'))
    // …and the tenant's own file is still the tenant's own file.
    expect(paths.main.path).toBe(join(dir, 'fleet', 'acme.db'))
    tenants.close()
  })

  // Spreading a string yields one key per character, so the merge would have
  // taken `':memory:'` silently and built `{ 0: ':', 1: 'm', … }`.
  it('refuses the `databases: ":memory:"` shorthand by name', async () => {
    await expect(createTenantRegistry({
      schema:        `tenancy { strategy database }\nmodel Post { id Int @id }`,
      dir:           join(tmp(), 'fleet'),
      registry:      join(tmp(), 'i.db'),
      clientOptions: { databases: ':memory:' as never },
    })).rejects.toThrow('must be an object')
  })
})

// ─── Moving a row OUT of the tenant ──────────────────────────────────────────
//
// The generated rules used to be read/update/delete plus create, which asks
// *may you touch this row* and never *may the row end up there*. So a caller
// could `update({ where: { id: mine }, data: { workspaceId: theirs } })` — the
// WHERE matched legitimately at the moment it ran, and the row landed in
// somebody else's tenant.
//
// A hand-written `@@allow('all', col == auth().claim)` never had the hole, and
// that is what found it: basecamp's own tests kept passing on the hand-written
// version and failed the moment the same models moved to the declaration. `all`
// expands to every operation including `post-update`, so an allow was graded
// against the RESULTING row for free.

describe('a row cannot be moved out of its tenant', () => {
  const SCHEMA = `
    tenancy { strategy row  column workspaceId  claim workspaceId }
    model Doc  { id Int @id @default(autoincrement())  workspaceId Int  title String  notes Note[] }
    model Note { id Int @id @default(autoincrement())  docId Int  doc Doc @relation(fields: [docId], references: [id])  body String }
  `

  async function seeded() {
    const db: any = await createClient({ db: ':memory:', schema: SCHEMA })
    const sys = db.asSystem()
    await sys.doc.create({ data: { workspaceId: 1, title: 'mine' } })
    await sys.doc.create({ data: { workspaceId: 2, title: 'theirs' } })
    await sys.note.create({ data: { docId: 1, body: 'n' } })
    return { db, sys, caller: db.$setAuth({ id: 'u1', workspaceId: 1 }) }
  }

  it('refuses an update that changes the tenant column, and rolls the row back', async () => {
    const { sys, caller } = await seeded()

    await expect(caller.doc.update({ where: { id: 1 }, data: { workspaceId: 2 } }))
      .rejects.toThrow(/Outside your workspaceId/)

    // The refusal is evaluated after the write, inside the transaction — so the
    // assertion that matters is not the throw, it is that nothing persisted.
    expect((await sys.doc.findUnique({ where: { id: 1 } })).workspaceId).toBe(1)
  })

  // Another tenant's parent is a parent the caller cannot read, so it answers
  // as missing. `Outside your workspaceId` here would say the id exists.
  it('refuses re-pointing a delegated child at another tenant\'s parent, as a missing one', async () => {
    const { sys, caller } = await seeded()

    await expect(caller.note.update({ where: { id: 1 }, data: { docId: 2 } }))
      .rejects.toThrow('docId 2 names no Doc')
    expect((await sys.note.findUnique({ where: { id: 1 } })).docId).toBe(1)
  })

  // The WHERE grades the row before; only the post-update rule reads the row
  // after, and a bulk write that skips it moves rows update() refuses (FJS-1713).
  it('refuses the same move through updateMany, and rolls back every row of it', async () => {
    const { sys, caller } = await seeded()
    await sys.doc.create({ data: { workspaceId: 1, title: 'mine too' } })

    await expect(caller.doc.updateMany({ where: {}, data: { workspaceId: 2 } }))
      .rejects.toThrow(/Outside your workspaceId/)
    expect((await sys.doc.findMany({ where: { workspaceId: 1 } })).map((d: any) => d.id).sort()).toEqual([1, 3])
  })

  it('grades a hand-written post-update rule on updateMany as update() does', async () => {
    const db: any = await createClient({ db: ':memory:', schema: `
      model Task { id Int @id @default(autoincrement())  status String  @@allow('all', true)  @@deny('post-update', status == 'locked') }
    ` })
    const sys = db.asSystem()
    await sys.task.create({ data: { status: 'open' } })
    const caller = db.$setAuth({ id: 'u1' })

    await expect(caller.task.update({ where: { id: 1 }, data: { status: 'locked' } })).rejects.toThrow(/post-update/)
    await expect(caller.task.updateMany({ where: { id: 1 }, data: { status: 'locked' } })).rejects.toThrow(/post-update/)
    expect((await sys.task.findUnique({ where: { id: 1 } })).status).toBe('open')
    expect(await caller.task.updateMany({ where: { id: 1 }, data: { status: 'done' } })).toEqual({ count: 1 })
  })

  // upsertMany's conflict half is an update by SQLite's DO UPDATE, whose WHERE
  // grades the row before, as updateMany's does (FJS-1730).
  it('refuses the same move through upsertMany\'s conflict half, and rolls the batch back', async () => {
    const { sys, caller } = await seeded()

    const err: any = await caller.doc.upsertMany({ data: [
      { id: 9, workspaceId: 1, title: 'new' },
      { id: 1, workspaceId: 2, title: 'mine' },
    ] }).catch((e: any) => e)
    expect(err.message).toMatch(/data\[1\] of 2 failed/)
    expect(err.message).toMatch(/Outside your workspaceId/)
    expect((await sys.doc.findUnique({ where: { id: 1 } })).workspaceId).toBe(1)
    expect(await sys.doc.findUnique({ where: { id: 9 } })).toBeNull()
  })

  it('grades a hand-written post-update rule on upsertMany, a key repeated in the batch included', async () => {
    const db: any = await createClient({ db: ':memory:', schema: `
      model Task { id Int @id  status String  @@allow('all', true)  @@deny('post-update', status == 'locked') }
    ` })
    const sys = db.asSystem()
    await sys.task.create({ data: { id: 1, status: 'open' } })
    const caller = db.$setAuth({ id: 'u1' })

    await expect(caller.task.upsertMany({ data: [{ id: 1, status: 'locked' }] })).rejects.toThrow(/post-update/)
    await expect(caller.task.upsertMany({ data: [{ id: 2, status: 'open' }, { id: 2, status: 'locked' }] })).rejects.toThrow(/post-update/)
    expect((await sys.task.findMany()).map((t: any) => [t.id, t.status])).toEqual([[1, 'open']])
    // A new row may start locked: the rule is about the row after an UPDATE.
    expect(await caller.task.upsertMany({ data: [{ id: 1, status: 'done' }, { id: 3, status: 'locked' }] })).toEqual({ count: 2 })
  })

  it('still allows an ordinary edit — the rule is about the tenant, not the row', async () => {
    const { sys, caller } = await seeded()

    await caller.doc.update({ where: { id: 1 }, data: { title: 'renamed' } })
    expect((await sys.doc.findUnique({ where: { id: 1 } })).title).toBe('renamed')
    expect(await caller.doc.updateMany({ where: {}, data: { title: 'bulk' } })).toEqual({ count: 1 })
  })

  it('asSystem() still moves a row deliberately', async () => {
    // The audited bypass is the way a support tool or a merge script does this.
    const { sys } = await seeded()

    await sys.doc.update({ where: { id: 1 }, data: { workspaceId: 2 } })
    expect((await sys.doc.findUnique({ where: { id: 1 } })).workspaceId).toBe(2)
  })
})

// ─── asSystem() keeps the tenant in scope (FJS-519) ─────────────────────────
//
// `asSystem()` means NO PERMISSION RULES. It did not mean *no scope*, and the
// gap was a hole in a shipped feature: row tenancy desugars to `@@deny`, which
// is a policy, so a system context read every tenant's rows — and a `@@gate("8")`
// model can be read by nothing else, so the only client that could read a
// credential was the one that ignored tenancy.
//
// Two halves, and the second one is what the first needed. Keeping the
// tenancy-generated denies under a system context is the rule; `asSystem()`
// being memoized PER SCOPE is what gives it a claim to keep, because a scoped
// client used to hand back the root's identity-free proxy.

const VAULT_SCHEMA = `
tenancy {
  strategy row
  column   workspaceId
  claim    workspaceId
}

model Secret {
  id          Int    @id @default(autoincrement())
  workspaceId Int
  label       String
  @@gate("8")
}

model Note {
  id          Int    @id @default(autoincrement())
  workspaceId Int
  body        String
  @@gate("0")
}
`

describe('asSystem() and row tenancy', () => {
  const seed = async () => {
    const db   = await createClient({ schema: VAULT_SCHEMA, db: ':memory:' })
    const root = db.asSystem()
    await root.secret.create({ data: { workspaceId: 1, label: 'ws1 key' } })
    await root.secret.create({ data: { workspaceId: 2, label: 'ws2 key' } })
    await root.note.create({ data: { workspaceId: 1, body: 'ws1 note' } })
    await root.note.create({ data: { workspaceId: 2, body: 'ws2 note' } })
    return { db, root }
  }

  it('gives a scoped client its own system proxy rather than the root one', async () => {
    const { db } = await seed()
    const one = db.$setAuth({ id: 1, workspaceId: 1 })
    const two = db.$setAuth({ id: 2, workspaceId: 2 })
    expect(one.asSystem()).not.toBe(db.asSystem())
    expect(one.asSystem()).not.toBe(two.asSystem())
    // Still memoized, per scope.
    expect(one.asSystem()).toBe(one.asSystem())
  })

  it('crosses the gate and keeps the tenant', async () => {
    const { db } = await seed()
    const sys = db.$setAuth({ id: 1, workspaceId: 1 }).asSystem()

    // @@gate("8") is unreachable for the scoped caller and reachable here...
    await expect(db.$setAuth({ id: 1, workspaceId: 1 }).secret.findMany()).rejects.toThrow()
    // ...but only for its own tenant, which is the whole point.
    expect((await sys.secret.findMany()).map((r: any) => r.label)).toEqual(['ws1 key'])
    expect((await sys.note.findMany()).map((r: any) => r.body)).toEqual(['ws1 note'])
  })

  it('keeps nothing when nothing is in scope', async () => {
    // A migration, a seed, or a job with no caller. The generated predicate's
    // first branch is `auth().<claim> == null`, so applying it with no
    // principal would deny every row rather than widen to all of them.
    const { root } = await seed()
    expect((await root.secret.findMany()).length).toBe(2)
    expect((await root.note.findMany()).length).toBe(2)
  })

  it('refuses a cross-tenant write from a scoped system client', async () => {
    const { db, root } = await seed()
    const sys   = db.$setAuth({ id: 1, workspaceId: 1 }).asSystem()
    const other = await root.note.findFirst({ where: { workspaceId: 2 } })

    // The stamp still applies — a create naming nothing lands in the scope.
    expect((await sys.note.create({ data: { body: 'stamped' } })).workspaceId).toBe(1)
    // Naming another tenant is refused, and reaching one matches no rows.
    await expect(sys.note.create({ data: { workspaceId: 2, body: 'x' } })).rejects.toThrow()
    expect(await sys.note.updateMany({ where: { id: other.id }, data: { body: 'hijacked' } })).toEqual({ count: 0 })
    expect((await root.note.findFirst({ where: { id: other.id } })).body).toBe('ws2 note')
  })

  it('refuses moving its own row into another tenant', async () => {
    // post-update, which is the half a hand-written policy got for free.
    const { db } = await seed()
    const sys = db.$setAuth({ id: 1, workspaceId: 1 }).asSystem()
    const mine = await sys.note.create({ data: { body: 'mine' } })
    await expect(sys.note.update({ where: { id: mine.id }, data: { workspaceId: 2 } })).rejects.toThrow()
  })
})

// ─── the connection pool ─────────────────────────────────────────────────────
//
// A pool that closes what it lent out is not a pool (`FJS-640`). The rules
// these hold, none of which a unit test on one side can see:
//
//   1. Eviction never closes a client a request is holding — it used to, and
//      the result was not a dead client but a MIXED one, because bun's close()
//      is sqlite3_close_v2 and the statement cache deferred the real close.
//   2. A LEASE is what makes the common case deterministic: junction pins for
//      the length of a request, so eviction of a finished one closes now
//      rather than waiting for a collection that fd pressure does not trigger.
//   3. A bare get() was never leased, so it is dropped and never closed.
//   4. A fan-out inserts COLD, or an admin dashboard evicts the tenants being
//      served.

describe('tenant pool', () => {
  const POOL_SCHEMA = `
tenancy { strategy database }
model Post { id Int @id @default(autoincrement())  title String }
`
  const registry = async (maxOpen: number) => {
    const dir = tmp()
    return createTenantRegistry({
      schema: POOL_SCHEMA, resolveFrom: dir, dir,
      registry: join(dir, 'r.db'), maxOpen,
    })
  }
  const make = async (t: any, n: number) => {
    for (let i = 0; i < n; i++) {
      const db = await t.getOrCreate(`t${i}`)
      await db.post.create({ data: { title: 'x' } })
    }
  }
  // A closed client refuses BY NAME. Asked as "is it closed" rather than "did
  // it throw", because a throw for any other reason is not this.
  const isClosed = async (db: any) => {
    try { await db.post.count(); return false }
    catch (e: any) { return /client is closed/.test(e.message) }
  }

  it('does not close a client a lease is holding', async () => {
    const t = await registry(4)
    await make(t, 12)
    const held    = await t.get('t1')
    const release = t.retain('t1')
    // Pin every slot, so the pinned entry has to be the victim.
    const others = []
    for (let i = 5; i < 9; i++) { await t.get(`t${i}`); others.push(t.retain(`t${i}`)) }
    await t.get('t11')
    expect(await isClosed(held)).toBe(false)
    expect(t.poolStats().overflows).toBeGreaterThan(0)
    release(); others.forEach(r => r())
  })

  it('closes a client whose every lease has ended, at the next eviction', async () => {
    const t = await registry(4)
    await make(t, 12)
    const done = await t.get('t1')
    t.retain('t1')()                    // a request that came and went
    for (let i = 5; i < 11; i++) await t.get(`t${i}`)
    expect(await isClosed(done)).toBe(true)
  })

  it('never closes a client that was never leased', async () => {
    const t = await registry(4)
    await make(t, 12)
    const bare = await t.get('t1')      // an app holding one, with no lease
    for (let i = 5; i < 11; i++) await t.get(`t${i}`)
    expect(await isClosed(bare)).toBe(false)
  })

  it('releasing twice is a no-op, so a finally is safe', async () => {
    const t = await registry(4)
    await make(t, 6)
    const release = t.retain('t1')
    release(); release()
    expect(t.poolStats().leased).toBe(0)
  })

  it('a fan-out does not evict the tenants being served', async () => {
    const t = await registry(6)
    await make(t, 40)
    // Leased and released, so eviction WOULD close these — which is what makes
    // the assertion mean something. Under a plain LRU a 40-tenant scan through
    // a 6-slot pool evicts every one of them.
    const hot = ['t0', 't1', 't2']
    const held: any[] = []
    for (const id of hot) { held.push(await t.get(id)); t.retain(id)() }
    await t.query((db: any) => db.post.count())
    for (const db of held) expect(await isClosed(db)).toBe(false)
  })

  it('a fan-out reads every tenant', async () => {
    const t = await registry(4)
    await make(t, 20)
    const rows = await t.query((db: any) => db.post.count())
    expect(rows.length).toBe(20)
    expect(rows.every((r: any) => r.result === 1)).toBe(true)
  })

  it('reports pool state a size cannot', async () => {
    const t = await registry(4)
    await make(t, 8)
    const release = t.retain('t7')
    const s = t.poolStats()
    expect(s.maxOpen).toBe(4)
    expect(s.pooled).toBeLessThanOrEqual(4)
    expect(s.leased).toBe(1)
    release()
  })
})

// ─── a unique is scoped per tenant ───────────────────────────────────────────
//
// `FJS-1159`. The tenant column is stated once, in the block, and a schema
// FRAGMENT can never name it — orion ships `FlowCredential.name @unique`, the
// host adds the column with `extend model`, and no edit either can make fixes
// the index. So the desugar prepends the column the way it already prepends a
// deny, and `@unique(global)` — which existed before this — is the opt-out.
//
// **Every claim is a pair**, because a constraint that is per-tenant and one
// that is not applied at all are the same observation from one side: two
// tenants CAN hold the value, and one tenant still CANNOT hold it twice.

const UNIQ_SCHEMA = `
tenancy {
  strategy row
  column   workspaceId
  claim    workspaceId
}

model User {
  id          String @id @default(uuid())
  workspaceId String
  @@auth
  @@tenant(none)
}

model Site {
  id          String  @id @default(uuid())
  workspaceId String
  slug        String  @unique
  // Deliberately across the whole installation — a public subdomain.
  host        String? @unique(global)
  // Nullable and unique: legal as a single constraint, and two NULLs are
  // distinct to it. The rewrite must not quietly change that.
  alias       String? @unique
  note        String  @default("n")
  @@unique([slug, note])
}

// Scoped through its parent and carrying no column of its own: nothing here can
// say WHICH parent to scope by, so this one is still reported.
model Page {
  id     String @id @default(uuid())
  siteId String
  site   Site   @relation(fields: [siteId], references: [id])
  path   String @unique
}
`

describe('a unique on a tenant-scoped model', () => {
  const asOwner = (db: any, ws: string) => db.$setAuth({ id: `u-${ws}`, workspaceId: ws })

  const client = async () => createClient({ schema: UNIQ_SCHEMA, db: ':memory:' })

  it('takes the tenant column, so two tenants hold the same value', async () => {
    const db = await client()
    await asOwner(db, 'w1').site.create({ data: { slug: 'launch' } })
    const other = await asOwner(db, 'w2').site.create({ data: { slug: 'launch' } })
    expect(other.slug).toBe('launch')
    expect(other.workspaceId).toBe('w2')
    db.$close()
  })

  it('…and one tenant still cannot hold it twice — the pair', async () => {
    // Without this the rewrite is indistinguishable from dropping the
    // constraint, which is the way this fix fails.
    const db = await client()
    await asOwner(db, 'w1').site.create({ data: { slug: 'launch' } })
    await expect(asOwner(db, 'w1').site.create({ data: { slug: 'launch' } })).rejects.toThrow()
    db.$close()
  })

  it('leaves `global` alone, in both directions', async () => {
    const db = await client()
    await asOwner(db, 'w1').site.create({ data: { slug: 'a', host: 'shop.example' } })
    // The whole installation, which is what the word says.
    await expect(asOwner(db, 'w2').site.create({ data: { slug: 'b', host: 'shop.example' } }))
      .rejects.toThrow()
    const ok = await asOwner(db, 'w2').site.create({ data: { slug: 'b', host: 'other.example' } })
    expect(ok.host).toBe('other.example')
    db.$close()
  })

  it('keeps a nullable unique nullable — two rows may leave it unset', async () => {
    // Lifting `alias String? @unique` into `[workspaceId, alias]` would be a
    // parse error without `nullsDistinct`, and enforcing it would refuse the
    // second row that simply has no alias. The declaration says what the
    // author's did.
    const db = await client()
    await asOwner(db, 'w1').site.create({ data: { slug: 'a' } })
    await asOwner(db, 'w1').site.create({ data: { slug: 'b' } })
    await asOwner(db, 'w1').site.create({ data: { slug: 'c', alias: 'home' } })
    await expect(asOwner(db, 'w1').site.create({ data: { slug: 'd', alias: 'home' } })).rejects.toThrow()
    await expect(asOwner(db, 'w2').site.create({ data: { slug: 'e', alias: 'home' } })).resolves.toBeTruthy()
    db.$close()
  })

  it('scopes a composite the same way', async () => {
    const db = await client()
    await asOwner(db, 'w1').site.create({ data: { slug: 'x', note: 'n' } })
    const other = await asOwner(db, 'w2').site.create({ data: { slug: 'x', note: 'n' } })
    expect(other.id).toBeTruthy()
    await expect(asOwner(db, 'w1').site.create({ data: { slug: 'y', note: 'n' } }))
      .resolves.toBeTruthy()
    db.$close()
  })

  it('rewrites the DECLARATION, so the DDL is the readable artefact', async () => {
    const r: any = parse(UNIQ_SCHEMA)
    const site = r.schema.models.find((m: any) => m.name === 'Site')
    // The field-level `@unique` is LIFTED to a table constraint — a column
    // cannot carry a two-column UNIQUE.
    const slug = site.fields.find((f: any) => f.name === 'slug')
    expect(slug.attributes.some((a: any) => a.kind === 'unique')).toBe(false)
    const uniques = site.attributes.filter((a: any) => a.kind === 'uniqueIndex').map((a: any) => a.fields)
    expect(uniques).toContainEqual(['workspaceId', 'slug'])
    expect(uniques).toContainEqual(['workspaceId', 'slug', 'note'])
    // `global` is untouched and stays on the field.
    const host = site.fields.find((f: any) => f.name === 'host')
    expect(host.attributes.find((a: any) => a.kind === 'unique')?.global).toBe(true)
  })

  it('says which constraints it scoped, and still reports what it cannot', async () => {
    const r: any = parse(UNIQ_SCHEMA)
    const said = (re: RegExp) => (r.warnings ?? []).filter((w: string) => re.test(w))

    const scoped = said(/unique constraint\(s\) are scoped per tenant/)
    expect(scoped.length).toBe(1)
    expect(scoped[0]).toContain('Site.slug')
    expect(scoped[0]).toContain('Site([slug, note])')
    expect(scoped[0]).not.toContain('Site.host')

    // `Page` carries no `workspaceId`, and which of a model's parents to scope
    // by is not decidable here — so the warning survives for exactly that case.
    const reported = said(/scoped through a PARENT are unique/)
    expect(reported.length).toBe(1)
    expect(reported[0]).toContain('Page.path')
  })
})
