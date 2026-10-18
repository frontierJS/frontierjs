// device-schema.test.ts — the schema a device is given (`IDEAS/homestead.md`
// phase 4, `FJS-D307`).
//
// **The test that matters is that the result BOOTS.** A filter over a tree is
// the kind of code that looks right in a snapshot and produces something no
// client can open — a relation whose target is not there, an enum a column
// refers to and nothing defines, a node missing a key some reader takes the
// length of. So the last two blocks here hand the output to `createClient` and
// write a row through it, once over a fixture and once over `example`'s own
// schema, which is the one that has 53 models and everything in it.
//
// Every other block is a PAIRING: the thing that crosses beside the thing that
// does not, because a filter that kept everything would pass every test that
// only asserts presence.
//
// The JSON round trip in the boot tests is not decoration. What reaches a
// device crosses `postMessage` and may cross `fetch` before that, so anything
// the filter leaves behind that does not survive `JSON.stringify` — a Map, a
// Set, a class instance — is a failure that only appears in a browser.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { parse, parseFile }  from '../src/core/parser.js'
import { deviceSchema }      from '../src/device-schema.js'
import { createClient }      from '../src/index.js'

const EXAMPLE = resolve(import.meta.dir, '../../../example/db/schema.lite')

// Two syncable models, one relation between them, one relation OUT of the set,
// one enum each side of the line, and a `type` reached only through a field.
const SOURCE = `
enum Kind { counted  estimated }
enum Colour { red  blue }

type Position {
  aisle String
  shelf Int
}

/// Prose on a model that crosses.
model Sheet {
  id     String @id @default(uuid())
  /// Prose on a field that crosses.
  note   String?
  counts Count[]
  @@gate(5.5.5.9)
  @@sync(server)
}

model Count {
  id        String   @id @default(uuid())
  sheetId   String
  sheet     Sheet    @relation(fields: [sheetId], references: [id])
  variantId Int
  variant   Variant  @relation(fields: [variantId], references: [id])
  kind      Kind
  where     Json?    @type(Position)
  counted   Int
  @@gate(5.5.5.9)
  @@allow(read, counted >= 0)
  @@index([sheetId])
  @@sync(append)
}

/// Prose on a model that does not cross.
model Variant {
  id     Int     @id
  colour Colour
  counts Count[]
  @@gate(5.5.5.9)
}
`

const project = (src = SOURCE) => deviceSchema(parse(src))

const modelNamed = (result: any, name: string) =>
  result.parsed.schema.models.find((m: any) => m.name === name)

const fieldNames = (result: any, name: string) =>
  modelNamed(result, name).fields.map((f: any) => f.name)

const noteFor = (result: any, what: string) =>
  result.notes.find((n: any) => n.what === what)

// ─── which models cross ───────────────────────────────────────────────────

describe('the set is @@sync and nothing else', () => {
  test('a model that declares it crosses; a model that does not is absent and graded', () => {
    const r = project()
    expect(r.models.sort()).toEqual(['Count', 'Sheet'])
    expect(modelNamed(r, 'Variant')).toBeUndefined()
    expect(noteFor(r, 'Variant')).toEqual({
      grade: 'lost', what: 'Variant', why: 'it declares no @@sync',
    })
  })

  test('a schema where nothing declares @@sync answers no models, and says so', () => {
    const r = deviceSchema(parse('model A { id Int @id  @@gate(0) }'))
    expect(r.models).toEqual([])
    expect(noteFor(r, 'the schema')?.grade).toBe('noted')
  })

  // The row policy crosses WITH the model, because the opt-in `FJS-D303`
  // requires is the `@@sync` declaration itself — a model in this projection
  // has opted in by being in it. Pinned because the obvious reading of that
  // ruling is a second attribute, and adding one would be a new word in the
  // language to say something already said.
  test('a kept model keeps its policies and its gate', () => {
    const count = modelNamed(project(), 'Count')
    expect(count.attributes.some((a: any) => a.kind === 'allow')).toBe(true)
    expect(count.attributes.some((a: any) => a.kind === 'gate')).toBe(true)
    expect(count.attributes.some((a: any) => a.kind === 'sync')).toBe(true)
  })
})

// ─── the relations ────────────────────────────────────────────────────────

describe('a relation out of the set comes out, and its column stays', () => {
  test('the relation field is gone and the foreign key is not', () => {
    const r = project()
    expect(fieldNames(r, 'Count')).not.toContain('variant')
    expect(fieldNames(r, 'Count')).toContain('variantId')
  })

  test('the note names the column that stayed, so the reader knows what to join on', () => {
    const note = noteFor(project(), 'Count.variant')
    expect(note.grade).toBe('lost')
    expect(note.why).toContain('variantId is still a column')
  })

  test('a relation to a model that IS in the set survives, both ways round', () => {
    const r = project()
    expect(fieldNames(r, 'Count')).toContain('sheet')
    expect(fieldNames(r, 'Sheet')).toContain('counts')
  })

  test('an index over a column that stayed is untouched', () => {
    const count = modelNamed(project(), 'Count')
    expect(count.attributes.find((a: any) => a.kind === 'index').fields).toEqual(['sheetId'])
  })
})

// ─── what a kept field drags along ────────────────────────────────────────

describe('enums and types follow the fields that use them', () => {
  test('an enum a kept model uses crosses; one only a dropped model uses does not', () => {
    const enums = project().parsed.schema.enums.map((e: any) => e.name)
    expect(enums).toEqual(['Kind'])
  })

  test('a `type` reached through a field crosses', () => {
    expect(project().parsed.schema.types.map((t: any) => t.name)).toEqual(['Position'])
  })

  // A `type` whose field names another `type`. Walked transitively, or the
  // second arrives as a name nothing defines and every read of that column
  // fails on a client that otherwise booted.
  test('a type reached only through another type crosses too', () => {
    const src = SOURCE.replace('  shelf Int\n', '  shelf Int\n  bay   Bay\n') +
      '\ntype Bay { code String }\n'
    expect(deviceSchema(parse(src)).parsed.schema.types.map((t: any) => t.name).sort())
      .toEqual(['Bay', 'Position'])
  })
})

// ─── the prose ────────────────────────────────────────────────────────────

describe('no prose crosses', () => {
  test('not one `///` comment survives, at any depth', () => {
    const text = JSON.stringify(project().parsed)
    expect(text).not.toContain('Prose on')
    for (const found of deepValues(project().parsed, 'comments')) expect(found).toEqual([])
  })

  // Emptied rather than deleted: `ddl.js` reads `model.comments.length` without
  // asking, so a node missing the key throws inside DDL generation — which is
  // exactly how this was found.
  test('every node still HAS the key', () => {
    const sheet = modelNamed(project(), 'Sheet')
    expect(sheet.comments).toEqual([])
    expect(sheet.fields.every((f: any) => Array.isArray(f.comments))).toBe(true)
  })
})

// ─── what lives above a model ─────────────────────────────────────────────

describe('the blocks a device cannot have', () => {
  test('a declared database is dropped, and the note says why it had to be', () => {
    const src = SOURCE + '\ndatabase main { path "./db/shop.db" }\n'
    const r = deviceSchema(parse(src))
    expect(r.parsed.schema.databases).toEqual([])
    expect(r.notes.find((n: any) => n.what.startsWith('database'))?.grade).toBe('changed')
  })

  // The pairing, and it is the reason the drop is not cosmetic. `db:` overrides
  // a declared `main` and overrides nothing else, so a SECOND block keeps the
  // path it declares — `example`'s is `database audit { driver trail }` over
  // `./db/audit/`, a fleet-wide file on a server and a host filesystem path
  // `host/browser.js` refuses by name.
  test('unfiltered, a second database keeps its own path — filtered, it is not there at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'device-schema-'))
    const src = SOURCE + `\ndatabase main { path "${join(dir, 'main.db')}" }\n` +
                         `\ndatabase audit { path "${join(dir, 'audit/')}" driver trail }\n`

    const unfiltered = await createClient({ parsed: parse(src), db: ':memory:' })
    expect(unfiltered.$databases.main.path).toBe(':memory:')
    expect(unfiltered.$databases.audit.path).toContain('audit')
    unfiltered.$close?.()

    const filtered = await createClient({ parsed: deviceSchema(parse(src)).parsed, db: ':memory:' })
    expect(Object.keys(filtered.$databases)).toEqual(['main'])
    expect(filtered.$databases.main.path).toBe(':memory:')
    filtered.$close?.()
  })

  test('a model routed with @@db loses the attribute, since the block it names is gone', () => {
    const src = SOURCE.replace('  @@sync(server)', '  @@db(main)\n  @@sync(server)') +
      '\ndatabase main { path "./m.db" }\n'
    const sheet = modelNamed(deviceSchema(parse(src)), 'Sheet')
    expect(sheet.attributes.some((a: any) => a.kind === 'db')).toBe(false)
  })

  // FJS-2406: the model-level trail names a database the device does not have,
  // and the field-level one was already graded. Silence here is a trail that
  // does nothing with no one told.
  test('a model-level @@trail(audit) loses the attribute and is graded, as the field-level one is', () => {
    const src = SOURCE.replace('  @@sync(server)', '  @@trail(audit)\n  @@sync(server)') +
      '\ndatabase audit { path "./audit/" driver trail }\n'
    const r = deviceSchema(parse(src))
    expect(modelNamed(r, 'Sheet').attributes.some((a: any) => a.kind === 'trail')).toBe(false)
    expect(noteFor(r, 'Sheet @@trail(audit)')?.grade).toBe('lost')
  })

  // FJS-2539 (FJS-D893): a device never holds the ciphertext. Left in, the schema
  // makes createClient demand a key the device must not have.
  test('@encrypted and @hashed columns are dropped, graded, and the result opens with no key', async () => {
    const src = `
model Vault {
  id     Int    @id @default(autoincrement())
  label  String
  token  String @encrypted
  digest String @hashed
  @@index([token])
  @@sync(server)
}`
    const r = deviceSchema(parse(src))
    expect(fieldNames(r, 'Vault')).toEqual(['id', 'label'])
    expect(noteFor(r, 'Vault.token')?.grade).toBe('lost')
    expect(noteFor(r, 'Vault.digest')?.grade).toBe('lost')
    expect(noteFor(r, 'Vault.token')?.why).toContain('@encrypted')
    const db = (await createClient({ parsed: JSON.parse(JSON.stringify(r.parsed)), db: ':memory:' })).asSystem()
    await db.vault.create({ data: { label: 'a' } })
    expect((await db.vault.findFirst()).label).toBe('a')
  })

  test('a model rule that reads a dropped protected column is refused by name', () => {
    const src = `
model Vault {
  id    Int    @id @default(autoincrement())
  token String @encrypted
  @@check("token IS NOT NULL")
  @@sync(server)
}`
    expect(() => deviceSchema(parse(src))).toThrow(/Vault @@check reads token/)
  })

  test('a tenancy block is dropped and graded', () => {
    const src = 'tenancy {\n  strategy database\n  dir "./shops"\n  registry "./r.db"\n  resolve subdomain\n}\n' + SOURCE
    const r = deviceSchema(parse(src))
    expect(r.parsed.schema.tenancy).toBeNull()
    expect(noteFor(r, 'tenancy')?.grade).toBe('lost')
    expect(JSON.stringify(r.parsed)).not.toContain('./shops')
  })

  test('traits and extends are already resolved into the models, so they carry nothing', () => {
    const r = project()
    expect(r.parsed.schema.traits).toEqual([])
    expect(r.parsed.schema.extends).toEqual([])
    expect(r.parsed.schema.imports).toEqual([])
  })
})

// ─── the refusals ─────────────────────────────────────────────────────────

describe('what it will not do', () => {
  test('a schema that does not parse is refused by name rather than filtered', () => {
    expect(() => deviceSchema(parse('model {'))).toThrow(/does not parse/)
  })

  test('something that is not a parse result is refused with the call that works', () => {
    expect(() => deviceSchema({ models: [] } as any)).toThrow(/parseFile/)
  })
})

// ─── a policy that reads past the set ─────────────────────────────────────

// `FJS-D847`. The relation a policy reads comes out with the model it points
// at, and the policy does not compile without it — the device database never
// opens and every offline read falls through to the list cache (`FJS-2248`).
// Each refusal is paired with the same schema once the named model declares
// `@@sync`, opened and read through the policy.
describe('a @@sync model whose policy reads a model that is not @@sync is refused', () => {
  const PORTAL = (rule: string, collectionSync = '') => `
model Collection {
  id        Int        @id
  ownerId   Int
  bookmarks Bookmark[]
  @@gate(0)
  ${collectionSync}
}

model Bookmark {
  id           Int        @id
  collectionId Int
  collection   Collection @relation(fields: [collectionId], references: [id])
  url          String
  @@gate(0)
  ${rule}
  @@sync(server)
}
`
  const READS = "@@allow(read, collection.ownerId == auth().id)"

  test('a path through the relation: refused, naming the model to add @@sync to', () => {
    expect(() => deviceSchema(parse(PORTAL(READS))))
      .toThrow(/Bookmark @@allow\(read\) reads collection\.ownerId, and Collection does not declare @@sync[\s\S]*Add @@sync to Collection/)
  })

  test('with Collection synced it builds, opens, and the policy answers on the device', async () => {
    const r = deviceSchema(parse(PORTAL(READS, '@@sync(server)')))
    expect(r.models.sort()).toEqual(['Bookmark', 'Collection'])

    const root = await createClient({ parsed: JSON.parse(JSON.stringify(r.parsed)), db: ':memory:' })
    const sys  = root.asSystem()
    await sys.collection.create({ data: { id: 1, ownerId: 7 } })
    await sys.collection.create({ data: { id: 2, ownerId: 8 } })
    await sys.bookmark.create({ data: { id: 1, collectionId: 1, url: 'a' } })
    await sys.bookmark.create({ data: { id: 2, collectionId: 2, url: 'b' } })

    const mine = await root.$setAuth({ id: 7 }).bookmark.findMany()
    expect(mine.map((b: any) => b.url)).toEqual(['a'])
  })

  test('check(rel) is refused the same way', () => {
    expect(() => deviceSchema(parse(PORTAL("@@allow(read, check(collection))"))))
      .toThrow(/delegates to check\(collection\)[\s\S]*Add @@sync to Collection/)
  })

  test('rel.some(...) on a to-many is refused the same way', () => {
    const src = PORTAL('', '@@sync(server)')
      .replace('  @@gate(0)\n  @@sync(server)\n}\n\nmodel Bookmark',
               '  @@gate(0)\n  @@allow(read, tags.some(name == "x"))\n  @@sync(server)\n}\n\nmodel Bookmark')
      .replace('  bookmarks Bookmark[]', '  bookmarks Bookmark[]\n  tags      Tag[]') +
      '\nmodel Tag {\n  id Int @id\n  name String\n  collectionId Int\n  collection Collection @relation(fields: [collectionId], references: [id])\n}\n'
    expect(() => deviceSchema(parse(src)))
      .toThrow(/Collection @@allow\(read\) reads tags, and Tag does not declare @@sync[\s\S]*Add @@sync to Tag/)
  })

  test('a field-level @allow is refused the same way', () => {
    const src = PORTAL('', '@@sync(server)').replace('  url          String',
      "  url          String     @allow(read, collection.ownerId == auth().id)")
    expect(() => deviceSchema(parse(src.replace('@@sync(server)\n}\n\nmodel Bookmark', '\n}\n\nmodel Bookmark'))))
      .toThrow(/Bookmark\.url @allow\(read\) reads collection\.ownerId/)
  })

  test('every crossing is named in one refusal, and each model to add once', () => {
    const src = PORTAL(READS + "\n  @@deny(delete, collection.ownerId != auth().id)")
    let message = ''
    try { deviceSchema(parse(src)) } catch (e: any) { message = e.message }
    expect(message).toContain('@@allow(read)')
    expect(message).toContain('@@deny(delete)')
    expect(message.match(/Add @@sync to (.*?),/)?.[1]).toBe('Collection')
  })

  // The relation that stays because nothing reads it through a policy is still
  // only graded: `Count.variant` in SOURCE is the case, and it boots below.
  test('a dropped relation no policy reads is a note, not a refusal', () => {
    expect(noteFor(project(), 'Count.variant')?.grade).toBe('lost')
  })
})

// ─── it boots ─────────────────────────────────────────────────────────────

describe('the result is a schema a client can open', () => {
  test('a row is written and read back through the relation that stayed', async () => {
    const r  = project()
    const db = (await createClient({
      parsed: JSON.parse(JSON.stringify(r.parsed)), db: ':memory:',
    })).asSystem()

    const sheet = await db.sheet.create({ data: { note: 'aisle 3' } })
    await db.count.create({ data: { sheetId: sheet.id, variantId: 42, kind: 'counted', counted: 9 } })

    const back = await db.sheet.findUnique({ where: { id: sheet.id }, include: { counts: true } })
    expect(back.counts.length).toBe(1)
    expect(back.counts[0].variantId).toBe(42)
  })

  test('the enum that came with it is still enforced', async () => {
    const db = (await createClient({
      parsed: JSON.parse(JSON.stringify(project().parsed)), db: ':memory:',
    })).asSystem()
    const sheet = await db.sheet.create({ data: {} })
    await expect(db.count.create({ data: { sheetId: sheet.id, variantId: 1, kind: 'guessed', counted: 1 } }))
      .rejects.toThrow(/counted, estimated/)
  })

  // The gate is the one thing that must not be a device-side nicety: it is
  // compiled the same way here as on a server, which is the claim phase 4
  // exists to make.
  test('the gate crossed with the model and refuses at the same level', async () => {
    const db = await createClient({
      parsed: JSON.parse(JSON.stringify(project().parsed)), db: ':memory:',
    })
    await expect(db.sheet.create({ data: {} })).rejects.toThrow(/requires level 5/)
  })
})

// ─── over the real thing ──────────────────────────────────────────────────

describe("example's own schema", () => {
  test('four models cross out of fifty-three, and the ones that do are the ones that said so', () => {
    const r = deviceSchema(parseFile(EXAMPLE))
    expect(r.models.sort()).toEqual(['InventoryMovement', 'ProductVariant', 'StocktakeCount', 'StocktakeSheet'])
    expect(r.parsed.schema.enums.map((e: any) => e.name)).toEqual(['Size', 'StockMovementKind'])
  })

  // Not a byte budget — `FJS-D302` owns that — but a floor under the claim the
  // filter exists to make. A change that starts carrying the whole tree would
  // pass every assertion above and fail this one.
  test('what a device gets is a small fraction of what the app parses', () => {
    const whole = parseFile(EXAMPLE)
    const ratio = JSON.stringify(deviceSchema(whole).parsed).length / JSON.stringify(whole).length
    expect(ratio).toBeLessThan(0.10)
  })

  test('none of the app‘s prose reaches it', () => {
    const text = JSON.stringify(deviceSchema(parseFile(EXAMPLE)).parsed)
    expect(text).not.toContain('SIGNED, and it is the movement')
    expect(text).not.toContain('FJS-D')
  })

  test('it boots, and the ledger takes a movement', async () => {
    const db = (await createClient({
      parsed: JSON.parse(JSON.stringify(deviceSchema(parseFile(EXAMPLE)).parsed)), db: ':memory:',
    })).asSystem()

    // The variant crosses on its own `@@sync(field)`, so the ledger's foreign key
    // resolves to a real table on the device and a movement needs a row to name.
    await db.productVariant.create({ data: { id: 42, productId: 1, sku: 'TEE-RED-M', price: 1299 } })
    const sheet = await db.stocktakeSheet.create({ data: { note: 'aisle 3' } })
    await db.stocktakeCount.create({
      data: { sheetId: sheet.id, variantId: 42, counted: 9, expected: 11 },
    })
    const movement = await db.inventoryMovement.create({
      data: { variantId: 42, kind: 'adjusted', quantity: -2, stockBefore: 11, stockAfter: 9 },
    })

    expect(movement.kind).toBe('adjusted')
    const back = await db.stocktakeSheet.findUnique({ where: { id: sheet.id }, include: { counts: true } })
    expect(back.counts[0].expected).toBe(11)
  })
})

/** Every value under `key`, at any depth — the only way to grade a whole tree. */
function deepValues(node: any, key: string, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) deepValues(n, key, out); return out }
  for (const [k, v] of Object.entries(node)) {
    if (k === key) out.push(v)
    else deepValues(v, key, out)
  }
  return out
}
