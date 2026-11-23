// test/registered-client.test.ts
//
// FJS-1258 / FJS-D495 — does `createClient()` answer the app's generated client?
//
// Nothing at runtime can answer that, so this compiles. The REAL generator's
// output is written beside a consumer file and `tsc --noEmit` is run over both.
// `paths` points the package specifier at this source: without it the
// augmentation would declare a NEW ambient module and pass while proving
// nothing. `@ts-expect-error` rides in the same run, so the negative half fails
// the compile the moment a model accessor widens back to `unknown`.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { parse, generateTypeScript } from '../src/index.js'

const HERE = import.meta.dir
const SRC  = resolve(HERE, '../src/index.d.ts')
const TSC  = resolve(HERE, '../../../node_modules/.bin/tsc')

const SCHEMA = `
  model Employee {
    id   Int    @id
    name String
    pin  String @guarded
  }
`

const USAGE = `
  import { createClient } from '@frontierjs/litestone'

  export async function run() {
    const db  = await createClient({ schema: 'model X { id Int @id }', db: ':memory:' })
    const one = await db.employee.findFirst({ where: { name: 'a' } })
    const sys = await db.asSystem().employee.findFirst({ where: { name: 'a' } })
    const row: { id: number; name: string } | null = sys
    // @ts-expect-error -- a column the model lacks
    await db.employee.findFirst({ where: { nope: 1 } })
    // Members the generated interface does not list still reach it from the
    // package's own (FJS-2502). The scaffold's retention job calls the first.
    const swept: number = (await db.asSystem().$retain()).reduce((n, r) => n + r.removed, 0)
    const held: number = await db.$lock('k', async () => 1)
    return { ...one, ...row, swept, held }
  }
`

function compile(audience: 'client' | 'system', schema = SCHEMA, usage = USAGE): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'litestone-registered-'))
  try {
    writeFileSync(join(dir, 'db.d.ts'), generateTypeScript(parse(schema).schema, { audience }))
    writeFileSync(join(dir, 'use.ts'), usage)
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        strict:                     true,
        target:                     'ESNext',
        module:                     'Preserve',
        moduleResolution:           'bundler',
        lib:                        ['ESNext', 'DOM', 'DOM.Iterable'],
        types:                      [],
        skipLibCheck:               true,
        allowImportingTsExtensions: true,
        noEmit:                     true,
        paths: { '@frontierjs/litestone': [SRC] },
      },
      files: ['db.d.ts', 'use.ts'],
    }, null, 2))

    const proc = Bun.spawnSync([TSC, '--noEmit', '-p', dir], { cwd: dir })
    const out  = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr)
    return { ok: proc.exitCode === 0, out }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the generated client reaches createClient()', () => {
  test('a system-audience file types db and db.asSystem() with no call-site change', () => {
    const { ok, out } = compile('system')
    expect(out).toBe('')
    expect(ok).toBe(true)
  })

  test('a client-audience file registers nothing: it strips what the server client reads', () => {
    const { ok, out } = compile('client')
    expect(ok).toBe(false)
    expect(out).toContain('use.ts')
  })

  test('the registration is a module augmentation of the package, system audience only', () => {
    const sys    = generateTypeScript(parse(SCHEMA).schema, { audience: 'system' })
    const client = generateTypeScript(parse(SCHEMA).schema, { audience: 'client' })
    expect(sys).toContain(`declare module '@frontierjs/litestone'`)
    expect(sys).toContain('interface Register')
    expect(client).not.toContain('interface Register')
  })

  test('junction\'s AppDb is augmented only for the system audience asked to augment', () => {
    const parsed = parse(SCHEMA).schema
    const at     = (audience: 'client' | 'system', augment?: 'junction') =>
      generateTypeScript(parsed, { audience, augment })
    expect(at('system', 'junction')).toContain('interface AppDb extends GeneratedLitestoneClient')
    expect(at('system')).not.toContain('AppDb')
    expect(at('client', 'junction')).not.toContain('AppDb')
  })

  // FJS-4507 -- an app's two files share one tsc program, so each junction
  // module is registered by one audience: two ServiceTypes registrations whose
  // rows differ are TS2320.
  test('the browser\'s ServiceTypes is registered by the client audience alone', () => {
    const parsed = parse(SCHEMA).schema
    const at     = (audience: 'client' | 'system') => generateTypeScript(parsed, { audience, augment: 'junction' })
    expect(at('client')).toContain(`declare module '@frontierjs/junction/client'`)
    expect(at('system')).not.toContain(`declare module '@frontierjs/junction/client'`)
  })
})

// FJS-2779 -- a read is typed by what it asked for. include and select were
// `any`, so a relation read was a type error that ran fine and a select's row
// claimed columns it never fetched.
const RELATED = `
  model Location { id Int @id  key String  name String  events Event[] }
  model Event {
    id Int @id
    title String
    rank Int
    locationId Int?
    location Location? @relation(fields: [locationId], references: [id])
  }
`

const READS = `
  import { createClient } from '@frontierjs/litestone'

  export async function run() {
    const db = await createClient({ schema: 'model X { id Int @id }', db: ':memory:' })
    const sys = db.asSystem()

    // include adds the relation, at the relation's own type
    const withLoc = await sys.event.findMany({ include: { location: true } })
    const key: string | undefined = withLoc[0].location?.key
    const first = await sys.event.findFirst({ include: { location: true } })
    const viaFirst: string | undefined = first?.location?.key
    const many = await sys.location.findMany({ include: { events: true } })
    const title: string = many[0].events[0].title
    const counted = await sys.location.findFirstOrThrow({ include: { _count: true } })
    const n: number = counted._count.events

    // no include: the relation is not on the row
    const bare = await sys.event.findFirstOrThrow({ orderBy: { rank: 'asc' } })
    // @ts-expect-error -- not asked for
    bare.location
    // @ts-expect-error -- include: false does not add it
    ;(await sys.event.findMany({ include: { location: false } }))[0].location

    // select narrows the row
    const picked = await sys.event.findMany({ select: { id: true } })
    const id: number = picked[0].id
    // @ts-expect-error -- never fetched
    picked[0].title
    const both = await sys.event.findUniqueOrThrow({ where: { id: 1 }, select: { id: true }, include: { location: true } })
    const bothId: number = both.id
    const bothKey: string | undefined = both.location?.key
    // @ts-expect-error -- never fetched
    both.title
    const onlyRel = await sys.event.findFirst({ select: { location: true } })
    // @ts-expect-error -- a select of the relation alone fetches no column
    onlyRel?.title

    // a name the model lacks is refused where it is written
    // @ts-expect-error -- no such relation
    await sys.event.findMany({ include: { nope: true } })
    // @ts-expect-error -- no such column
    await sys.event.findMany({ select: { nope: true } })

    const counted2 = await sys.event.findManyAndCount({ select: { id: true } })
    const total: number = counted2.total + counted2.rows[0].id

    return { key, viaFirst, title, n, id, bothId, bothKey, total }
  }
`

describe('a read is typed by its include and select (FJS-2779)', () => {
  test('relations arrive with include, columns narrow with select, OrThrow takes what findFirst takes', () => {
    const { ok, out } = compile('system', RELATED, READS)
    expect(out).toBe('')
    expect(ok).toBe(true)
  })
})

// FJS-2898 -- a nested select on an include narrows the relation's row, and a
// create/update/upsert answers what it was asked for like a read does.
const NESTED = `
  import { createClient } from '@frontierjs/litestone'

  export async function run() {
    const db = await createClient({ schema: 'model X { id Int @id }', db: ':memory:' })
    const sys = db.asSystem()

    // a nested select keeps only the columns it names, on a one and on a many
    const one = await sys.event.findMany({ include: { location: { select: { key: true } } } })
    const key: string | undefined = one[0].location?.key
    // @ts-expect-error -- the nested select never fetched it
    one[0].location?.name
    const many = await sys.location.findFirstOrThrow({ include: { events: { select: { title: true } } } })
    const title: string = many.events[0].title
    // @ts-expect-error -- the nested select never fetched it
    many.events[0].rank
    const off = await sys.event.findFirstOrThrow({ include: { location: { select: { key: true, name: false } } } })
    // @ts-expect-error -- false fetches nothing
    off.location?.name
    // a nested options object with no select keeps the full row
    const wide = await sys.event.findFirstOrThrow({ include: { location: { where: { key: 'a' } } } })
    const wideName: string | undefined = wide.location?.name
    // a nested select under a select of the relation
    const viaSelect = await sys.event.findFirstOrThrow({ select: { location: { select: { key: true } } } })
    const sk: string | undefined = viaSelect.location?.key
    // @ts-expect-error -- the nested select never fetched it
    viaSelect.location?.name

    // a write answers what it was asked for
    const data = { title: 't', rank: 1 }
    const made = await sys.event.create({ data, include: { location: true } })
    const madeKey: string | undefined = made.location?.key
    const plain = await sys.event.create({ data })
    // @ts-expect-error -- not asked for
    plain.location
    const picked = await sys.event.create({ data, select: { id: true } })
    const pid: number = picked.id
    // @ts-expect-error -- never fetched
    picked.title
    const upd = await sys.event.update({ where: { id: 1 }, data, select: { id: true } })
    const uid: number | undefined = upd?.id
    // @ts-expect-error -- never fetched
    upd?.title
    const ups = await sys.event.upsert({ where: { id: 1 }, create: data, update: data, include: { location: { select: { key: true } } } })
    const upk: string | undefined = ups.location?.key
    // @ts-expect-error -- the nested select never fetched it
    ups.location?.name
    const none = await sys.event.create({ data, select: false })
    const nothing: null = none
    // @ts-expect-error -- no such relation
    await sys.event.create({ data, include: { nope: true } })

    return { key, title, wideName, sk, madeKey, pid, uid, upk, nothing }
  }
`

describe('a nested select and a write are typed by what they asked for (FJS-2898)', () => {
  test('a nested select narrows the relation; create/update/upsert follow include and select', () => {
    const { ok, out } = compile('system', RELATED, NESTED)
    expect(out).toBe('')
    expect(ok).toBe(true)
  })
})

// FJS-3079 -- `system: [...]` is the documented way to write a @system column
// or lift @@gate, and the generated TableClient had no such key, so the
// runtime-correct call was a TS2353 excess-property error.
const SYSTEMIC = `
  model Component {
    id          Int     @id
    name        String
    lastCheckOk Boolean? @system
    @@gate(5)
  }
`

const SYSTEM_WRITES = `
  import { createClient } from '@frontierjs/litestone'

  export async function run() {
    const db = await createClient({ schema: 'model X { id Int @id }', db: ':memory:' })
    const sys = db.asSystem()

    await sys.component.create({ data: { name: 'a' }, system: ['lastCheckOk', '@@gate'] })
    await sys.component.update({ where: { id: 1 }, data: { lastCheckOk: true }, system: ['lastCheckOk'] })
    await sys.component.updateMany({ where: { name: 'a' }, data: { lastCheckOk: false }, system: ['lastCheckOk'] })
    await sys.component.upsert({ where: { id: 1 }, create: { name: 'a' }, update: { lastCheckOk: true }, system: ['lastCheckOk'] })
    await sys.component.createMany({ data: [{ name: 'a' }], system: ['@@gate'] })
    await sys.component.upsertMany({ data: [{ name: 'a' }], system: ['@@gate'] })

    // @ts-expect-error -- a name that is neither a column nor '@@gate'
    await sys.component.update({ where: { id: 1 }, data: {}, system: ['nope'] })
  }
`

describe('a write may name what it supplies as the application (FJS-3079)', () => {
  test('system: [...] is accepted on every write and refuses a name that is no column', () => {
    const { ok, out } = compile('system', SYSTEMIC, SYSTEM_WRITES)
    expect(out).toBe('')
    expect(ok).toBe(true)
  })
})

// FJS-3304 -- a @system column is writable only through `system` on a client
// that is not asSystem(), so the types say so: it is absent from the
// Create/Update a bare write takes and arrives with the name in `system: [...]`.
const SYSTEM_ONLY = `
  import { createClient } from '@frontierjs/litestone'

  export async function run() {
    const db = await createClient({ schema: 'model X { id Int @id }', db: ':memory:' })
    const sys = db.asSystem()

    await sys.component.create({ data: { name: 'a', lastCheckOk: true }, system: ['lastCheckOk'] })
    await sys.component.update({ where: { id: 1 }, data: { lastCheckOk: null }, system: ['lastCheckOk'] })
    await sys.component.updateMany({ where: {}, data: { lastCheckOk: false }, system: ['lastCheckOk', '@@gate'] })
    await sys.component.upsert({ where: { id: 1 }, create: { name: 'a', lastCheckOk: true }, update: { lastCheckOk: true }, system: ['lastCheckOk'] })
    await sys.component.createMany({ data: [{ name: 'a', lastCheckOk: true }], system: ['lastCheckOk'] })

    // @ts-expect-error -- named in data and not in system: refused at run time
    await db.component.create({ data: { name: 'a', lastCheckOk: true } })
    // @ts-expect-error -- same on update
    await db.component.update({ where: { id: 1 }, data: { lastCheckOk: true } })
    // @ts-expect-error -- '@@gate' lifts the gate, not the column
    await db.component.update({ where: { id: 1 }, data: { lastCheckOk: true }, system: ['@@gate'] })
    // @ts-expect-error -- the value is still typed
    await sys.component.update({ where: { id: 1 }, data: { lastCheckOk: 'yes' }, system: ['lastCheckOk'] })
    // an ordinary column needs no system
    await sys.component.update({ where: { id: 1 }, data: { name: 'b' } })
  }
`

describe('a @system column is writable only through system (FJS-3304)', () => {
  test('data names it only where system does, on every write', () => {
    const { ok, out } = compile('system', SYSTEMIC, SYSTEM_ONLY)
    expect(out).toBe('')
    expect(ok).toBe(true)
  })

  test('the row still carries the column', () => {
    const ts = generateTypeScript(parse(SYSTEMIC).schema, { audience: 'system' })
    expect(ts).toMatch(/export interface Component \{[^}]*lastCheckOk\?: boolean/)
    expect(ts).not.toMatch(/export interface ComponentCreate \{[^}]*lastCheckOk/)
    expect(ts).not.toMatch(/export interface ComponentUpdate \{[^}]*lastCheckOk/)
  })
})

// FJS-3910 -- asSystem() writes a @system column without naming it, so its
// types take the column in data as they take any other. `db` itself still
// needs system: [...].
const SYSTEM_CLIENT = `
  import { createClient } from '@frontierjs/litestone'

  export async function run() {
    const db = await createClient({ schema: 'model X { id Int @id }', db: ':memory:' })
    const sys = db.asSystem()

    await sys.component.create({ data: { name: 'a', lastCheckOk: true } })
    await sys.component.createMany({ data: [{ name: 'a', lastCheckOk: true }] })
    await sys.component.update({ where: { id: 1 }, data: { lastCheckOk: null } })
    await sys.component.updateMany({ where: {}, data: { lastCheckOk: false } })
    await sys.component.upsert({ where: { id: 1 }, create: { name: 'a', lastCheckOk: true }, update: { lastCheckOk: true } })
    // naming it stays legal under asSystem()
    await sys.component.update({ where: { id: 1 }, data: { lastCheckOk: true }, system: ['lastCheckOk'] })
    // @ts-expect-error -- the value is still typed
    await sys.component.update({ where: { id: 1 }, data: { lastCheckOk: 'yes' } })
    // @ts-expect-error -- a column the model lacks
    await sys.component.update({ where: { id: 1 }, data: { nope: 1 } })

    // the client that is not asSystem() still refuses it at run time, so still at compile time
    // @ts-expect-error -- named in data and not in system
    await db.component.update({ where: { id: 1 }, data: { lastCheckOk: true } })
    // @ts-expect-error -- a person's client, system audience types or not
    await db.$setAuth({ id: 1 }).component.update({ where: { id: 1 }, data: { lastCheckOk: true } })
  }
`

describe('asSystem() takes a @system column in data (FJS-3910)', () => {
  test('every write on the asSystem client, and none on the client that is not', () => {
    const { ok, out } = compile('system', SYSTEMIC, SYSTEM_CLIENT)
    expect(out).toBe('')
    expect(ok).toBe(true)
  })
})

// ─── FJS-4202: the tenancy claim column ──────────────────────────────────────

const TENANTED = `
  model Account { id Int @id  name String }
  model Client {
    id        Int    @id
    accountId Int
    name      String
  }
  tenancy { strategy row  column accountId  claim accountId }
`

const TENANT_CLIENT = `
  import { createClient } from '@frontierjs/litestone'

  export async function run() {
    const db = await createClient({ schema: 'model X { id Int @id }', db: ':memory:' })
    // the claim stamps the column, so a principal's create does not name it
    await db.$setAuth({ accountId: 1 }).client.create({ data: { name: 'a' } })
    await db.$setAuth({ accountId: 1 }).client.createMany({ data: [{ name: 'a' }] })
    // asSystem() has no claim to stamp from
    await db.asSystem().client.create({ data: { name: 'a', accountId: 1 } })
    // @ts-expect-error -- asSystem() names the column
    await db.asSystem().client.create({ data: { name: 'a' } })
    // @ts-expect-error -- a column the model lacks
    await db.$setAuth({ accountId: 1 }).client.create({ data: { name: 'a', nope: 1 } })
  }
`

describe('the tenancy claim column is optional in Create (FJS-4202)', () => {
  test('a principal omits it, asSystem() must name it', () => {
    const { ok, out } = compile('system', TENANTED, TENANT_CLIENT)
    expect(out).toBe('')
    expect(ok).toBe(true)
  })
})

// FJS-4508 -- $setAuth takes any object or null at runtime. Typed as an index
// signature, it refused an interface without one (junction's SessionContext),
// so `$setAuth(ctx.user)` failed tsc, and `$setAuth(null)` is how junction's
// bearer.ts unscopes a client.
const SCOPED = `
  import { createClient, type LitestoneClient } from '@frontierjs/litestone'

  interface Session { id: string; userType: string; role?: string }

  export async function run(user: Session, root: LitestoneClient) {
    const db = await createClient({ schema: 'model X { id Int @id }', db: ':memory:' })
    const scoped = db.$setAuth(user).employee
    const bare   = db.$setAuth(null)
    const claims = db.$setAuth({ id: 1, capabilities: ['x'] })
    const plain  = root.$setAuth(user).$setAuth(null)
    // @ts-expect-error -- a principal is an object
    db.$setAuth('alice')
    return { scoped, bare, claims, plain }
  }
`

describe('$setAuth takes a principal of any declared shape, or null (FJS-4508)', () => {
  test('an interface without an index signature, null and a claims literal all compile', () => {
    const { ok, out } = compile('system', SCHEMA, SCOPED)
    expect(out).toBe('')
    expect(ok).toBe(true)
  })
})

// FJS-4576 -- each call below is a documented shape that runs; the generated
// system types refused all eight, so an app adopting db:types failed tsc on
// correct code.
const DOCUMENTED = `
  model Post {
    id         Int       @id @default(autoincrement())
    title      String
    tags       String[]
    isTemplate Boolean   @default(false)
    dueAt      DateTime?
    isLate     Boolean   @derived(dueAt < now())
    labels     Label[]
    comments   Comment[]
    @@hasTemplates(field: "isTemplate")
    @@fts([title])
  }
  model Label { id Int @id @default(autoincrement())  name String  posts Post[] }
  model Comment {
    id     Int    @id @default(autoincrement())
    body   String
    postId Int
    post   Post   @relation(fields: [postId], references: [id])
  }
`

const DOCUMENTED_USAGE = `
  import { createClient } from '@frontierjs/litestone'

  export async function run(labelId: number, postId: number) {
    const db = await createClient({ schema: 'model X { id Int @id }', db: ':memory:' })
    await db.post.findMany({ where: { labels: { some: { id: labelId } } } })
    await db.post.findMany({ where: { labels: { none: { name: 'x' } }, comments: { every: { body: 'x' } } } })
    await db.post.findMany({ where: { comments: { some: { body: 'x' } } } })
    await db.comment.findMany({ where: { post: { is: { title: 'x' } } } })
    await db.comment.findMany({ where: { post: { isNot: { title: 'x' } } } })
    const withLabels = await db.post.findMany({ include: { labels: true } })
    const names: string[] = withLabels[0].labels.map(l => l.name)
    await db.post.create({ data: { title: 'x' } })
    await db.post.update({ where: { id: postId }, data: { labels: { connect: [{ id: labelId }] } } })
    await db.post.update({ where: { id: postId }, data: { labels: { disconnect: [{ id: labelId }] } } })
    await db.post.findUnique({ where: { id: postId }, onlyTemplates: true })
    await db.post.findMany({ withTemplates: true })
    await db.post.search('x', { raw: true, select: { id: true }, withRank: false })
    // @ts-expect-error -- a @derived column is computed, never written
    await db.post.create({ data: { title: 'x', isLate: true } })
    // @ts-expect-error -- a relation filter takes the target's own columns
    await db.post.findMany({ where: { labels: { some: { nope: 1 } } } })
    return names
  }
`

describe('the generated system types admit every documented query shape (FJS-4576)', () => {
  test('relation filters, m2m include and connect, templates, search and create all compile', () => {
    const { ok, out } = compile('system', DOCUMENTED, DOCUMENTED_USAGE)
    expect(out).toBe('')
    expect(ok).toBe(true)
  })
})

// FJS-D2332 -- a select LIST is typed as the object it stands for: each entry
// is checked where it is written, and the row is typed field by field, through
// every hop of a path.
const PATHS = `
  model Event { id Int @id  title String  types TicketType[] }
  model TicketType {
    id Int @id
    name String
    eventId Int
    event Event @relation(fields: [eventId], references: [id])
    tickets Ticket[]
  }
  model Member { id Int @id  name String  email String  tickets Ticket[] }
  model Ticket {
    id Int @id
    code String
    memberId Int?
    member Member? @relation(fields: [memberId], references: [id])
    ticketTypeId Int
    ticketType TicketType @relation(fields: [ticketTypeId], references: [id])
  }
`

const LISTS = `
  import { createClient } from '@frontierjs/litestone'

  export async function run() {
    const db = await createClient({ schema: 'model X { id Int @id }', db: ':memory:' })
    const sys = db.asSystem()

    // columns, inline with no as const
    const cols = await sys.ticket.findMany({ select: ['id', 'code'] })
    const code: string = cols[0].code
    const cid: number = cols[0].id
    // @ts-expect-error -- never fetched
    cols[0].memberId

    // a one-hop path: the relation's fields, at its cardinality
    const one = await sys.ticket.findFirstOrThrow({ select: ['code', 'member:name+email'] })
    const email: string | undefined = one.member?.email
    // @ts-expect-error -- an optional relation is null-able
    const bad: string = one.member.name
    // @ts-expect-error -- never fetched
    one.member?.id

    // three hops nest select at each: the middle hops carry only the path
    const deep = await sys.member.findMany({ select: ['id', 'tickets.ticketType.event:title'] })
    // a to-one relation is typed null-able whatever its optionality, as the object form is
    const title: string | undefined = deep[0].tickets[0].ticketType?.event?.title
    // @ts-expect-error -- a middle hop answers only the path below it
    deep[0].tickets[0].code
    // @ts-expect-error -- never fetched
    deep[0].tickets[0].ticketType?.name

    // entries naming one relation merge; a path with no colon is the whole row
    const merged = await sys.ticket.findFirstOrThrow({ select: ['member:name', 'member:email', 'ticketType'] })
    const both: [string | undefined, string | undefined] = [merged.member?.name, merged.member?.email]
    const whole: number | undefined = merged.ticketType?.eventId

    // the list is the object: the two answer one type
    const asObject = await sys.ticket.findFirstOrThrow({ select: { code: true, member: { select: { name: true, email: true } } } })
    const same: typeof one = asObject

    // writes and the count variant take it too
    const made = await sys.ticket.create({ data: { code: 'c', ticketTypeId: 1 }, select: ['id'] })
    const mid: number = made.id
    const page = await sys.ticket.findManyAndCount({ select: ['code'] })
    const pc: string = page.rows[0].code

    // @ts-expect-error -- an unknown column
    await sys.ticket.findMany({ select: ['id', 'cdoe'] })
    // @ts-expect-error -- an unknown hop
    await sys.member.findMany({ select: ['tickets.tikcetType.event:title'] })
    // @ts-expect-error -- a column used as a hop
    await sys.ticket.findMany({ select: ['code.x:y'] })
    // @ts-expect-error -- an unknown leaf field
    await sys.ticket.findMany({ select: ['member:nmae'] })
    // @ts-expect-error -- an unknown leaf field after a valid one
    await sys.ticket.findMany({ select: ['member:name+nope'] })

    return { code, cid, email, bad, title, both, whole, same, mid, pc }
  }
`

describe('a select list is typed as the object it stands for (FJS-D2332)', () => {
  test('entries are checked where written and the row is typed through every hop', () => {
    const { ok, out } = compile('system', PATHS, LISTS)
    expect(out).toBe('')
    expect(ok).toBe(true)
  })
})
