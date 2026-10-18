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

// FJS-3304 -- a @system column is writable only through `system`, so the types
// say so: it is absent from the Create/Update a bare write takes and arrives
// with the name in `system: [...]`.
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
    await sys.component.create({ data: { name: 'a', lastCheckOk: true } })
    // @ts-expect-error -- same on update
    await sys.component.update({ where: { id: 1 }, data: { lastCheckOk: true } })
    // @ts-expect-error -- '@@gate' lifts the gate, not the column
    await sys.component.update({ where: { id: 1 }, data: { lastCheckOk: true }, system: ['@@gate'] })
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
