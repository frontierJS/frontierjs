// FJS-1779 — the auto-factory built a fixture from field TYPES and not from the
// rules the schema declares on them, so a quarter of the models in a generated
// schema could not be seeded and went ungraded by every access drive. One test
// per cause; each schema is the shape the base44 stressor measured.
import { describe, test, expect } from 'bun:test'
import { parse } from '../src/core/parser.js'
import { generateFactory, makeTestClient } from '../src/testing.js'

const row = (src: string, seq = 1, model = 'T') => {
  const r = parse(src)
  if (!r.valid) throw new Error(r.errors.join('\n'))
  return generateFactory(r.schema, model)(seq, null) as Record<string, any>
}
const ms = (v: string) => new Date(v).getTime()

// ─── @@check ─────────────────────────────────────────────────────────────────

describe('generateFactory honors a two-column @@check', () => {
  test('endAt > startAt', () => {
    const r = row(`model T { id Int @id; startAt DateTime; endAt DateTime; @@check("endAt > startAt") }`)
    expect(ms(r.endAt)).toBeGreaterThan(ms(r.startAt))
  })

  test('the smaller side named first, and >= / <= / <', () => {
    for (const expr of ['startAt < endAt', 'endAt >= startAt', 'startAt <= endAt']) {
      const r = row(`model T { id Int @id; startAt DateTime; endAt DateTime; @@check("${expr}") }`)
      expect(ms(r.endAt)).toBeGreaterThanOrEqual(ms(r.startAt))
      if (!expr.includes('=')) expect(ms(r.endAt)).toBeGreaterThan(ms(r.startAt))
    }
  })

  test('numbers: max > min', () => {
    for (const seq of [1, 2, 7]) {
      const r = row(`model T { id Int @id; min Int; max Int; @@check("max > min") }`, seq)
      expect(r.max).toBeGreaterThan(r.min)
    }
  })

  test('a check against a literal the row already passes leaves the row alone', () => {
    const r = row(`model T { id Int @id; startAt DateTime; endAt DateTime; @@check("endAt > '2020-01-01'") }`)
    expect(r.startAt).toBe(r.endAt)
  })

  test('@time strings: startTime < endTime', () => {
    const r = row(`model T { id Int @id; startTime String @time; endTime String @time; @@check("startTime < endTime") }`)
    expect(r.endTime > r.startTime).toBe(true)
    expect(r.endTime).toMatch(/^\d\d:\d\d$/)
  })
})

describe('generateFactory reads the rest of the @@check subset', () => {
  test('AND — a box must have a size', () => {
    const r = row(`model T { id Int @id; boxX1 Int @gte(0); boxY1 Int @gte(0); boxX2 Int @gte(0); boxY2 Int @gte(0)
      @@check("boxX1 < boxX2 AND boxY1 < boxY2") }`)
    expect(r.boxX2).toBeGreaterThan(r.boxX1)
    expect(r.boxY2).toBeGreaterThan(r.boxY1)
  })

  test('IN — a required column held to a literal list takes the first', () => {
    const r = row(`model T { id Int @id; contextType String; @@check("contextType IN ('Shift', 'Task')") }`)
    expect(r.contextType).toBe('Shift')
  })

  test('OR over a nullable column that @required(where:) forces non-null', () => {
    const r = row(`enum S { open resolved }
      model T { id Int @id; status S; startedAt DateTime
        resolvedAt DateTime? @required(where: status == 'resolved')
        @@check("resolvedAt IS NULL OR resolvedAt >= startedAt") }`)
    expect(r.resolvedAt).not.toBeNull()
    expect(ms(r.resolvedAt)).toBeGreaterThanOrEqual(ms(r.startedAt))
  })

  test('arithmetic identity — total = subtotal + shippingTotal', () => {
    const r = row(`model T { id Int @id; subtotal Int @gte(0); shippingTotal Int @gte(0); total Int @gte(0)
      platformFee Int @gte(0); sellerNet Int
      @@check("total = subtotal + shippingTotal")
      @@check("sellerNet = total - platformFee") }`)
    expect(r.total).toBe(r.subtotal + r.shippingTotal)
    expect(r.sellerNet).toBe(r.total - r.platformFee)
  })

  test('a boolean against 0 and an enum against a string', () => {
    const r = row(`enum K { incoming outgoing }
      model T { id Int @id; isPrivate Boolean; messageType K
        @@check("isPrivate = 0 OR messageType <> 'incoming'") }`)
    expect(r.isPrivate === false || r.messageType !== 'incoming').toBe(true)
  })

  test('<> between two generated numbers', () => {
    const r = row(`model T { id Int @id; a Int; b Int; @@check("a <> b") }`)
    expect(r.a).not.toBe(r.b)
  })

  test('a rule outside the subset is left to the table', () => {
    const r = row(`model T { id Int @id; name String; @@check("length(name) > 2") }`)
    expect(r.name).toBe('Name 1')
  })
})

// ─── Field rules ─────────────────────────────────────────────────────────────

describe('generateFactory reads the rules on a field', () => {
  test('@required(where:) is filled — a value is legal either way', () => {
    const r = row(`enum ST { text file }
      type SendText { text String; hidden Boolean }
      model T { id Int @id; type ST
        text     Json?   @type(SendText) @required(where: type == 'text')
        fileName String? @required(where: type == 'file')
        note     String? }`)
    expect(r.fileName).not.toBeNull()
    expect(r.text).toEqual({ text: 'Text 1', hidden: false })
    expect(r.note).toBeNull()
  })

  test('Json @type carries the type, members generated as columns are', () => {
    const r = row(`type Address { name String @length(1, 100); line1 String @length(1, 200); line2 String? @length(0, 200)
        city String @length(1, 100); postalCode String @length(1, 20); country String @length(2, 2) }
      model T { id Int @id; shippingAddress Json @type(Address) }`)
    expect(r.shippingAddress.name).toBeString()
    expect(r.shippingAddress.line1).toBeString()
    expect(r.shippingAddress.city).toBeString()
    expect(r.shippingAddress.postalCode.length).toBeLessThanOrEqual(20)
    expect(r.shippingAddress.country).toHaveLength(2)
  })

  test('a type with an array member honors its @minItems', () => {
    const r = row(`type Def { columns String[] @minItems(1); groupBy String?; descending Boolean? }
      model T { id Int @id; definition Json @type(Def) }`)
    expect(r.definition.columns).toHaveLength(1)
    expect(r.definition.groupBy).toBeNull()
  })

  test('an optional @type Json stays null', () => {
    const r = row(`type Cfg { url String }  model T { id Int @id; config Json? @type(Cfg) }`)
    expect(r.config).toBeNull()
  })

  test('DateTime @date draws a calendar date, not a timestamp', () => {
    const r = row(`model T { id Int @id; day DateTime @date }`)
    expect(r.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test('@scoped and @edge are not columns', () => {
    const r = row(`model User { id Int @id; name String; @@auth }
      model Project { id Int @id; name String; tasks T[] }
      model T { id Int @id; title String; projects Project[]
        starred Boolean @scoped @default(false)
        note String? @edge(ref: Project) }`)
    expect(r).not.toHaveProperty('starred')
    expect(r).not.toHaveProperty('note')
    expect(r.title).toBe('Title 1')
  })
})

// ─── @regex ──────────────────────────────────────────────────────────────────

describe('generateFactory draws a distinct @regex value per row', () => {
  test('a one-character minimum does not cap the model at one row', () => {
    const src = `model T { id Int @id; slug String @unique @regex("^[a-z0-9][a-z0-9-]{0,62}$") }`
    const seen = new Set<string>()
    for (let seq = 1; seq <= 60; seq++) {
      const v = row(src, seq).slug
      expect(v).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/)
      seen.add(v)
    }
    expect(seen.size).toBe(60)
  })

  test('a bounded quantifier is still bounded', () => {
    for (const seq of [1, 2, 3, 999]) {
      const r = row(`model T { id Int @id; code String @regex("^[A-Z]{2}\\\\d{4}$") }`, seq)
      expect(r.code).toMatch(/^[A-Z]{2}\d{4}$/)
    }
  })
})

// ─── Through the client ──────────────────────────────────────────────────────

describe('withParents() builds what the schema insists on', () => {
  test('one counter per model — a parent inside a chain and a row at the top do not collide', async () => {
    const { factories } = await makeTestClient(`
      model Customer { id Int @id @default(autoincrement()); externalId String @unique @length(1, 120); payments Payment[] }
      model Payment  { id Int @id @default(autoincrement()); customerId Int
        customer Customer @relation(fields: [customerId], references: [id]); amount Int }`, { autoFactories: true })
    await factories.customer.createMany(3)
    const paid = await factories.payment.withParents({ fresh: true }).createMany(3)
    expect(new Set(paid.map((p: any) => p.customerId)).size).toBe(3)
  })

  test('a composite relation fills every column of its key', async () => {
    const { factories, db } = await makeTestClient(`
      model Team    { id String @id @default(uuid()); name String; projects Project[]; deployments Deployment[] }
      model Project { id Int @id @default(autoincrement()); teamId String
        team Team @relation(fields: [teamId], references: [id]); deployments Deployment[]
        @@unique([id, teamId]) }
      model Deployment { id Int @id @default(autoincrement()); teamId String; projectId Int
        team    Team    @relation(fields: [teamId], references: [id])
        project Project @relation(fields: [projectId, teamId], references: [id, teamId]) }`, { autoFactories: true })
    const d = await factories.deployment.withParents().createOne()
    const project = await db.project.findUnique({ where: { id: d.projectId } })
    expect(project.teamId).toBe(d.teamId)
  })

  test('@@arc — exactly one of two nullable keys is wired', async () => {
    const { factories } = await makeTestClient(`
      model Order   { id Int @id @default(autoincrement()); ref String; attachments Attachment[] }
      model Product { id Int @id @default(autoincrement()); sku String; attachments Attachment[] }
      model Attachment { id Int @id @default(autoincrement()); label String
        orderId Int?;   order   Order?   @relation(fields: [orderId],   references: [id])
        productId Int?; product Product? @relation(fields: [productId], references: [id])
        @@arc([orderId, productId]) }`, { autoFactories: true })
    const a = await factories.attachment.withParents().createOne()
    expect(a.orderId).not.toBeNull()
    expect(a.productId).toBeNull()
  })

  test('a pin satisfies one relation to its model; a second gets its own parent', async () => {
    const { factories } = await makeTestClient(`
      model Issue { id Int @id @default(autoincrement()); title String
        from IssueRelation[] @relation("From"); to IssueRelation[] @relation("To") }
      model IssueRelation { id Int @id @default(autoincrement())
        issueId Int;        issue        Issue @relation("From", fields: [issueId], references: [id])
        relatedIssueId Int; relatedIssue Issue @relation("To",   fields: [relatedIssueId], references: [id])
        @@check("issueId <> relatedIssueId") }`, { autoFactories: true })
    const issue = await factories.issue.createOne()
    const rel   = await factories.issueRelation.withParents({ pins: { Issue: issue } }).createOne()
    expect(rel.issueId).toBe(issue.id)
    expect(rel.relatedIssueId).not.toBe(issue.id)
  })

  test('a @required(where:) foreign key gets a parent', async () => {
    const { factories } = await makeTestClient(`
      enum Kind { charge fee }
      model Charge { id Int @id @default(autoincrement()); code String; lines Line[] }
      model Line { id Int @id @default(autoincrement()); type Kind
        chargeId Int? @required(where: type == 'charge')
        charge Charge? @relation(fields: [chargeId], references: [id]) }`, { autoFactories: true })
    const line = await factories.line.withParents().createOne()
    expect(line.chargeId).not.toBeNull()
  })

  test('eight chains below one @unique @regex slug seed eight teams', async () => {
    const { factories } = await makeTestClient(`
      model Team   { id Int @id @default(autoincrement()); slug String @unique @regex("^[a-z0-9][a-z0-9-]{0,62}$"); runners Runner[] }
      model Runner { id Int @id @default(autoincrement()); teamId Int; team Team @relation(fields: [teamId], references: [id]) }`,
      { autoFactories: true })
    const rows = await factories.runner.withParents({ fresh: true }).createMany(8)
    expect(new Set(rows.map((r: any) => r.teamId)).size).toBe(8)
  })
})

describe('generateFactory reads a check against what the database stamps', () => {
  test('an ordering against a @default(now()) column is read with the clock', () => {
    const r = row(`enum St { active submitted }
      model T { id Int @id; status St; clockInAt DateTime @default(now())
        clockOutAt DateTime? @required(where: status != 'active')
        @@check("clockOutAt IS NULL OR clockInAt < clockOutAt") }`)
    expect(r).not.toHaveProperty('clockInAt')
    expect(ms(r.clockOutAt)).toBeGreaterThan(Date.now())
  })

  test('two predicates that must agree — the true one is made false when the false one cannot move', () => {
    const r = row(`enum Kind { album asset }
      model Album { id Int @id; name String; links T[] }
      model T { id Int @id; type Kind; albumId Int?; album Album? @relation(fields: [albumId], references: [id])
        @@check("(type = 'album') = (albumId IS NOT NULL)") }`)
    expect(r.type).toBe('asset')
    expect(r).not.toHaveProperty('albumId')
  })
})

test('>= against a @default(now()) column lands a full day past the clock, not on it', () => {
  const r = row(`enum St { investigating resolved }
    model T { id Int @id; status St @default(investigating); startedAt DateTime @default(now())
      resolvedAt DateTime? @required(where: status == 'resolved')
      @@check("resolvedAt IS NULL OR resolvedAt >= startedAt") }`)
  expect(ms(r.resolvedAt) - Date.now()).toBeGreaterThan(80_000_000)
})
