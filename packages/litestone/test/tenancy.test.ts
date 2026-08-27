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

  it('names an unknown resolve form', () => {
    const r = parse(`tenancy { strategy row column w resolve cookie("t") } model A { id Int @id w Int }`)
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

  it('does not scope a jsonl or logger model — there is no policy engine there', () => {
    const r = parse(`
      tenancy { strategy row  column wid }
      database main { path "./app.db" }
      database logs { path "./logs/"  driver jsonl }
      model A       { id Int @id  wid Int  @@db(main) }
      model ApiCall { wid Int  path String  @@db(logs) }
    `)
    const log = r.schema.models.find((m: any) => m.name === 'ApiCall')!
    expect(log.attributes.filter((a: any) => a.generated === 'tenancy')).toHaveLength(0)
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

  it('publishes the declaration on every flavour of client', async () => {
    const db = await createClient({ schema: ROW_SCHEMA, db: ':memory:' })
    for (const flavour of [db, db.asSystem(), db.$setAuth({ id: 1 })]) {
      expect(flavour.$tenancy.strategy).toBe('row')
      expect(flavour.$tenancy.column).toBe('workspaceId')
      // A row app already knows which tenant a caller is in — it is the claim.
      expect(flavour.$tenancy.resolve).toEqual({ kind: 'claim', name: 'workspaceId' })
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
      database logs { path "./logs/"  driver logger }
      model Post { id Int @id  title String  @@log(logs) }
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

  it('refuses re-pointing a delegated child at another tenant\'s parent', async () => {
    const { sys, caller } = await seeded()

    await expect(caller.note.update({ where: { id: 1 }, data: { docId: 2 } }))
      .rejects.toThrow(/Outside your workspaceId/)
    expect((await sys.note.findUnique({ where: { id: 1 } })).docId).toBe(1)
  })

  it('still allows an ordinary edit — the rule is about the tenant, not the row', async () => {
    const { sys, caller } = await seeded()

    await caller.doc.update({ where: { id: 1 }, data: { title: 'renamed' } })
    expect((await sys.doc.findUnique({ where: { id: 1 } })).title).toBe('renamed')
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
// being memoised PER SCOPE is what gives it a claim to keep, because a scoped
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
    // Still memoised, per scope.
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
