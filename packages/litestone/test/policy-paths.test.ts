// policy-paths.test.ts — a row policy naming a column ONE relation away.
//
// `@@allow(read, order.userId == auth().id)` used to be `Expected RPAREN, got
// '.'`, so *the lines of my own orders* had nowhere to live but a copy of the
// id on the child (`FJS-499`). `FJS-D221` rules the dotted form, the compiler
// owns the joins, and `FJS-D1027` bounds it at two to-one hops.
//
// The two compilers agreeing is asserted in `policy-interpreters.test.ts`,
// beside the `check()` block it shares a shape with — one oracle, not two. What
// is here is the other two halves.
//
// **Every refusal is PAIRED with the legitimate shape one character away**
// (`FJS-351`). A policy compiles into a WHERE, so a wrong one is an empty
// screen with a 200 rather than an error; a guard that refused the correct
// spelling too would satisfy any test that only asked about the refusal.
//
// **And the COST, which no behavioral test can see.** A correlated subquery is
// invisible to every assertion above — the rows come back right whether the
// parent is reached by its key or scanned once per child row. So the last block
// EXPLAINs the bytes the client actually sent, over a table sized past the
// point SQLite is right to scan, with a hand-written correlation on an
// unindexed column beside it as the control.

import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '../src/index.js'

const KEY = 'a'.repeat(64)

/** The message `createClient` refuses a schema with, or '' when it accepts. */
async function refusal(schema: string): Promise<string> {
  try {
    const db: any = await createClient({ schema, db: ':memory:', encryptionKey: KEY })
    db.$close()
    return ''
  } catch (e: any) { return String(e.message).replace(/\s+/g, ' ') }
}

/** Two models and a to-one relation, with one rule dropped into either. */
const S = (rule: string, on: 'Doc' | 'Owner' = 'Doc', ownerCols = '') => `
model Owner {
  id        String   @id
  userId    String?
  editorIds String[]
  ${ownerCols}
  docs      Doc[]
  ${on === 'Owner' ? rule : ''}
}
model Doc {
  id      String @id
  ownerId String?
  owner   Owner? @relation(fields: [ownerId], references: [id])
  ${on === 'Doc' ? rule : ''}
}
`

describe('one hop is accepted', () => {
  it('the form the workaround existed for', async () => {
    expect(await refusal(S(`@@allow(read, owner.userId == auth().id)`))).toBe('')
  })

  it('and it is what admits the row — the PARENT decides, not the child', async () => {
    // The control for the whole file. Agreement is cheap for a rule admitting
    // everybody; this separates rows, and separates them by a column that lives
    // on the other model — so a hop compiled away to the child's own `ownerId`
    // fails here and passes everything else.
    const db: any = await createClient({ schema: S(`@@allow(read, owner.userId == auth().id)`), db: ':memory:' })
    const sys = db.asSystem()
    await sys.owner.create({ data: { id: 'o1', userId: 'u1', editorIds: [] } })
    await sys.owner.create({ data: { id: 'o2', userId: 'u2', editorIds: [] } })
    await sys.doc.create({ data: { id: 'mine',   ownerId: 'o1' } })
    await sys.doc.create({ data: { id: 'theirs', ownerId: 'o2' } })
    await sys.doc.create({ data: { id: 'orphan', ownerId: null } })

    const read = async (who: string | null) =>
      (await db.$setAuth(who ? { id: who } : null).doc.findMany()).map((x: any) => x.id).sort()

    expect(await read('u1')).toEqual(['mine'])
    expect(await read('u2')).toEqual(['theirs'])
    // An absent parent is an absent VALUE, not an absent RULE. `check()` allows
    // a null foreign key on purpose — it delegates a policy, and a row naming
    // no parent is not a row naming somebody else's — but a path yields a value
    // and SQL's NULL keeps no row under an @@allow.
    expect(await read(null)).toEqual([])
    db.$close()
  })
})

describe('the hops are bounded at two, and the bound is discoverable from the mistake', () => {
  it('a third hop is a parse error naming the rule', async () => {
    const msg = await refusal(S(`@@allow(read, owner.docs.owner.userId == auth().id)`))
    expect(msg).toContain('crosses three relations')
    expect(msg).toContain('TWO to-one relations')
  })

  it('a second hop over a to-many is refused at startup', async () => {
    const msg = await refusal(S(`@@allow(read, owner.docs.id == auth().id)`))
    expect(msg).toContain("'docs' is hasMany")
  })

  it('and one hop over the same relation is fine', async () => {
    expect(await refusal(S(`@@allow(read, owner.userId == auth().id)`))).toBe('')
  })

  it('a to-many is refused, in the words check() uses', async () => {
    // Two ways to cross a relation in a policy, and they must not come to
    // accept different sets. `any child matches` is a different question and
    // `FJS-D221` leaves it unruled rather than pre-paying for it with syntax.
    const msg = await refusal(S(`@@allow(read, docs.id == auth().id)`, 'Owner'))
    expect(msg).toContain('hasMany')
    expect(msg).toContain('belongsTo')
  })

  it('and the to-ONE side of the same relation is accepted', async () => {
    expect(await refusal(S(`@@allow(read, owner.id == auth().id)`, 'Doc'))).toBe('')
  })
})

describe('what the hop lands on is checked against the target model', () => {
  it('an unknown relation lists the ones that exist', async () => {
    const msg = await refusal(S(`@@allow(read, ownr.userId == auth().id)`))
    expect(msg).toContain("'ownr' is not a relation")
    expect(msg).toContain('Relations: owner')
  })

  it('an unknown column names the TARGET model and its fields', async () => {
    // Not this model's fields, which is what the local branch prints and what a
    // walk that forgot to follow the hop would print here.
    const msg = await refusal(S(`@@allow(read, owner.usrId == auth().id)`))
    expect(msg).toContain('is not a field on Owner')
    expect(msg).toContain("reached as 'owner.usrId'")
    expect(msg).toContain('userId')
  })

  it('and the correctly spelled column on the same relation is accepted', async () => {
    expect(await refusal(S(`@@allow(read, owner.userId == auth().id)`))).toBe('')
  })

  it('a column with no storage is refused — @computed and @transient', async () => {
    for (const attr of ['@computed', '@transient']) {
      const msg = await refusal(S(`@@allow(read, owner.tag == auth().id)`, 'Doc', `tag String? ${attr}`))
      expect(msg, attr).toContain('no column to correlate on')
    }
    // The pair: an ordinary column declared in the same slot is accepted, so
    // the refusal is keyed on the attribute and not on the extra field.
    expect(await refusal(S(`@@allow(read, owner.tag == auth().id)`, 'Doc', `tag String?`))).toBe('')
  })

  it('an ENCODED column across the hop is refused rather than compared', async () => {
    // The failure this whole feature exists to remove, arriving through the fix
    // for it: ciphertext compared against a plaintext operand matches nothing,
    // which is an empty screen with a 200. `encodedCompare` encodes the operand
    // for a LOCAL column and has no counterpart across a relation.
    for (const attr of ['@encrypted(deterministic: true)', '@hashed', '@secret']) {
      const msg = await refusal(S(`@@allow(read, owner.tok == auth().id)`, 'Doc', `tok String? ${attr}`))
      expect(msg, attr).toContain('would match nothing')
    }
    expect(await refusal(S(`@@allow(read, owner.tok == auth().id)`, 'Doc', `tok String?`))).toBe('')
  })
})

describe('membership crosses the hop, and the same shapes are refused', () => {
  it('a list on the parent is read by json_each over the subquery', async () => {
    const db: any = await createClient({ schema: S(`@@allow(read, auth().id in owner.editorIds)`), db: ':memory:' })
    const sys = db.asSystem()
    await sys.owner.create({ data: { id: 'o1', userId: 'x', editorIds: ['u1', 'u3'] } })
    await sys.owner.create({ data: { id: 'o2', userId: 'x', editorIds: [] } })
    await sys.doc.create({ data: { id: 'shared',  ownerId: 'o1' } })
    await sys.doc.create({ data: { id: 'private', ownerId: 'o2' } })

    const read = async (who: string) =>
      (await db.$setAuth({ id: who }).doc.findMany()).map((x: any) => x.id)
    expect(await read('u1')).toEqual(['shared'])
    // The pair. A grader that delivered every row would pass the line above.
    expect(await read('u9')).toEqual([])
    db.$close()
  })

  it('a SCALAR column on the parent is refused as the list', async () => {
    const msg = await refusal(S(`@@allow(read, auth().id in owner.userId)`))
    expect(msg).toContain('not an array field')
  })
})

describe('a hop is a policy form and not a schema-wide one', () => {
  it('@derived refuses it and points at @from', async () => {
    // A correlated subquery is static SQL, so this is a scope refusal rather
    // than an impossibility — and @from already crosses a relation to bring a
    // value onto a row, which is the one owner it would otherwise duplicate.
    const msg = await refusal(`
model Owner { id String @id  vip Boolean @default(false)  docs Doc[] }
model Doc {
  id      String  @id
  ownerId String?
  owner   Owner?  @relation(fields: [ownerId], references: [id])
  isVip   Boolean @derived(owner.vip == true)
}
`)
    expect(msg).toContain('crosses a relation')
    expect(msg).toContain('@from(owner, vip)')
  })

  it('an index predicate refuses it, and says what it CAN read', async () => {
    // The sentence matters as much as the refusal: `pathSql` is handed no
    // relation map on this path and would report the relation as missing, which
    // is false about the schema and points at the wrong line.
    const msg = await refusal(`
model Owner { id String @id  vip Boolean @default(false)  docs Doc[] }
model Doc {
  id      String  @id
  qty     Int
  ownerId String?
  owner   Owner?  @relation(fields: [ownerId], references: [id])
  @@index([qty], where: owner.vip == true)
}
`)
    expect(msg).toContain('crosses a relation')
    expect(msg).toContain('reads the row it is about')
    expect(msg).not.toContain('is not a relation on this model')
  })
})

// ─── the cost, which no assertion above can see ───────────────────────────────

describe('the correlated subquery reaches the parent by its key', () => {
  it('EXPLAIN says SEARCH on the parent, not a scan per row', async () => {
    // EXPLAIN the bytes the CLIENT sent. A hand-written lookalike passes
    // whatever the compiler does, which is no test of it at all.
    const dir  = mkdtempSync(join(tmpdir(), 'litestone-hop-'))
    const file = join(dir, 'db.sqlite')
    try {
      const seen: any[] = []
      const db: any = await createClient({
        schema: S(`@@allow(read, owner.userId == auth().id)`), db: file,
        onQuery: (e: any) => seen.push(e),
      })
      const sys = db.asSystem()
      // Past the point SQLite is right to scan. Four rows would make a scan the
      // correct plan and the assertion meaningless.
      for (let i = 0; i < 300;  i++) await sys.owner.create({ data: { id: 'o' + i, userId: 'u' + (i % 7), editorIds: [] } })
      for (let i = 0; i < 3000; i++) await sys.doc.create({ data: { id: 'd' + i, ownerId: 'o' + (i % 300) } })
      await sys.sql`ANALYZE`

      seen.length = 0
      const rows = await db.$setAuth({ id: 'u1' }).doc.findMany()
      expect(rows.length).toBeGreaterThan(0)
      const q = seen.find(e => e.operation === 'findMany')
      expect(q.sql).toMatch(/SELECT "owner"\."userId" FROM "owner" WHERE "owner"\."id" = "doc"\."ownerId"/)

      const raw = new Database(file, { readonly: true })
      try {
        const detail = (sql: string, params: unknown[] = []) =>
          (raw.prepare('EXPLAIN QUERY PLAN ' + sql).all(...(params as any[])) as any[])
            .map(r => r.detail).join(' | ')

        const plan = detail(q.sql, q.params)
        expect(plan).toContain('CORRELATED SCALAR SUBQUERY')
        expect(plan).toMatch(/SEARCH owner USING (COVERING )?INDEX/)
        expect(plan).not.toMatch(/SCAN owner/)
        // The word that separates a key lookup from a correlation SQLite has to
        // pay for: an AUTOMATIC index is one it builds at query time because
        // the schema offered none. The referenced key is a real index — the
        // relation's own — so the plan must never name one.
        expect(plan).not.toContain('AUTOMATIC')

        // The control, and it is what makes the four lines above an assertion
        // rather than a description of whatever SQLite happened to print. The
        // SAME correlation on a column with no index is answered with an
        // AUTOMATIC one — so the plan CAN say the thing being ruled out, and
        // the compiler correlating on the REFERENCED KEY is what stops it. It
        // is also why `not.toMatch(/SCAN owner/)` is not enough on its own:
        // SQLite is clever enough not to scan, and the cost moves into a
        // transient index instead of showing up as the word a reader expects.
        expect(detail(
          `SELECT * FROM "doc" WHERE (SELECT "owner"."id" FROM "owner" WHERE "owner"."userId" = "doc"."ownerId") = ?`,
          ['u1'],
        )).toContain('AUTOMATIC')
      } finally { raw.close() }
      db.$close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60000)
})

// ─── a model in a second database ─────────────────────────────────────────────
//
// The JS half answers a create or a postUpdate by reading another row. It read
// on MAIN's connection, where a model declared `@@db(chat)` has no table, so
// the write threw `no such table: channel` (FJS-4396). One rule form each that
// reads another row: a path, a check() and a some().

describe('a policy on a model in a second database reads that database', () => {
  const schema = `
database main { path ":memory:" }
database chat { path ":memory:" }

model User {
  id String @id
  @@auth
}
model Channel {
  id       String    @id
  ownerId  String
  topic    String?
  members  Member[]
  messages Message[]
  @@db(chat)
  @@allow(read, ownerId == auth().id)
  @@allow(update, true)
  @@allow(postUpdate, members.some(userId == auth().id))
}
model Member {
  id        String  @id
  channelId String
  channel   Channel @relation(fields: [channelId], references: [id])
  userId    String
  @@db(chat)
  @@allow(read, true)
  @@allow(create, check(channel, 'read'))
}
model Message {
  id        String  @id
  channelId String
  channel   Channel @relation(fields: [channelId], references: [id])
  @@db(chat)
  @@allow(read, true)
  @@allow(create, channel.ownerId == auth().id)
}
`
  const open = async () => {
    const db: any = await createClient({ schema, encryptionKey: KEY })
    await db.asSystem().channel.create({ data: { id: 'c1', ownerId: 'u1' } })
    return db
  }
  const as = (db: any, id: string) => db.$setAuth({ id })

  it('a one-hop path admits the owner and refuses anybody else', async () => {
    const db = await open()
    try {
      await as(db, 'u1').message.create({ data: { id: 'm1', channelId: 'c1' } })
      await expect(as(db, 'u2').message.create({ data: { id: 'm2', channelId: 'c1' } }))
        .rejects.toThrow(/denied/i)
      expect((await db.asSystem().message.findMany()).map((m: any) => m.id)).toEqual(['m1'])
    } finally { db.$close() }
  })

  it('a check() delegation admits the owner and refuses anybody else', async () => {
    const db = await open()
    try {
      await as(db, 'u1').member.create({ data: { id: 'k1', channelId: 'c1', userId: 'u1' } })
      await expect(as(db, 'u2').member.create({ data: { id: 'k2', channelId: 'c1', userId: 'u2' } }))
        .rejects.toThrow(/denied/i)
      expect((await db.asSystem().member.findMany()).map((m: any) => m.id)).toEqual(['k1'])
    } finally { db.$close() }
  })

  it('a some() over children admits a member and refuses anybody else', async () => {
    const db = await open()
    try {
      await db.asSystem().member.create({ data: { id: 'k1', channelId: 'c1', userId: 'u1' } })
      await as(db, 'u1').channel.update({ where: { id: 'c1' }, data: { topic: 'mine' } })
      await expect(as(db, 'u2').channel.update({ where: { id: 'c1' }, data: { topic: 'theirs' } }))
        .rejects.toThrow(/denied/i)
      expect((await db.asSystem().channel.findMany()).map((c: any) => c.topic)).toEqual(['mine'])
    } finally { db.$close() }
  })
})

// ─── two hops (FJS-D1027) ─────────────────────────────────────────────────────
//
// Two to-one hops then a column, or up to two then one `.some(…)`. Each case
// grades the SQL half (read, update, delete) and the JS half (create) on the
// same rows, so the two compilers are asked the same question.

const LINES = (rule: string) => `
model Customer {
  id     String  @id
  userId String?
  orders Order[]
  @@allow(read, true)
}
model Order {
  id         String    @id
  customerId String?
  customer   Customer? @relation(fields: [customerId], references: [id])
  lines      Line[]
  @@index([customerId])
  @@allow(read, true)
}
model Line {
  id      String  @id
  orderId String?
  note    String?
  order   Order?  @relation(fields: [orderId], references: [id])
  @@index([orderId])
  ${rule}
}
`

const ORGS = (invoiceRead: string) => `
enum Role { admin finance support }
model Organization {
  id          String       @id
  memberships Membership[]
  invoices    Invoice[]
  @@allow(read, true)
}
model Membership {
  id             String       @id
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id])
  userId         String
  role           Role
  @@index([organizationId])
  @@allow(read, true)
}
model Invoice {
  id             String       @id
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id])
  amount         Int          @default(0)
  @@index([organizationId])
  @@allow(read, ${invoiceRead})
  @@allow(update, organization.memberships.some(userId == auth().id && role == 'finance'))
}
`

const QUO = `
model Org {
  id      String        @id
  members Member[]
  numbers PhoneNumber[]
  @@allow(read, true)
}
model Member {
  id     String @id
  orgId  String
  org    Org    @relation(fields: [orgId], references: [id])
  userId String
  @@index([orgId])
  @@allow(read, true)
}
model PhoneNumber {
  id      String         @id
  orgId   String
  org     Org            @relation(fields: [orgId], references: [id])
  holders NumberMember[]
  @@index([orgId])
  @@allow(read, true)
}
model NumberMember {
  id            String      @id
  phoneNumberId String
  phoneNumber   PhoneNumber @relation(fields: [phoneNumberId], references: [id])
  userId        String
  @@index([phoneNumberId])
  @@allow(create, phoneNumber.org.members.some(userId == this.userId))
  @@allow(read, phoneNumber.org.members.some(userId == this.userId))
}
`

const lands = (p: Promise<unknown>) => p.then(() => true, () => false)

describe('two to-one hops then a column', () => {
  it('grants on read, update and delete (SQL) and on create (JS), and refuses the other user', async () => {
    const db: any = await createClient({ schema: LINES(`@@allow(all, order.customer.userId == auth().id)`), db: ':memory:', encryptionKey: KEY })
    const sys = db.asSystem()
    await sys.customer.create({ data: { id: 'c1', userId: 'u1' } })
    await sys.customer.create({ data: { id: 'c2', userId: 'u2' } })
    await sys.order.create({ data: { id: 'o1', customerId: 'c1' } })
    await sys.order.create({ data: { id: 'o2', customerId: 'c2' } })
    await sys.line.create({ data: { id: 'l1', orderId: 'o1' } })
    await sys.line.create({ data: { id: 'l2', orderId: 'o2' } })
    await sys.line.create({ data: { id: 'l3', orderId: 'o1' } })
    const u1 = db.$setAuth({ id: 'u1' })

    expect((await u1.line.findMany()).map((x: any) => x.id).sort()).toEqual(['l1', 'l3'])
    expect(await lands(u1.line.update({ where: { id: 'l1' }, data: { note: 'mine' } }))).toBe(true)
    await lands(u1.line.update({ where: { id: 'l2' }, data: { note: 'theirs' } }))
    expect((await sys.line.findUnique({ where: { id: 'l2' } })).note).toBe(null)
    await lands(u1.line.delete({ where: { id: 'l2' } }))
    expect(await sys.line.findUnique({ where: { id: 'l2' } })).toBeTruthy()
    expect(await lands(u1.line.delete({ where: { id: 'l3' } }))).toBe(true)

    expect(await lands(u1.line.create({ data: { id: 'n1', orderId: 'o1' } }))).toBe(true)
    expect(await lands(u1.line.create({ data: { id: 'n2', orderId: 'o2' } }))).toBe(false)
    // An order with no customer has no value at the end of the chain: NULL in
    // both halves, which an @@allow fails closed on.
    await sys.order.create({ data: { id: 'o3' } })
    expect(await lands(u1.line.create({ data: { id: 'n3', orderId: 'o3' } }))).toBe(false)
    db.$close()
  })

  it('a column across a to-ONE then .some over a to-one are refused', async () => {
    expect(await refusal(LINES(`@@allow(read, order.customer.some(userId == auth().id))`))).toContain("'order.customer' is a to-one")
    expect(await refusal(LINES(`@@allow(read, order.customer.usrId == auth().id)`))).toContain("reached as 'order.customer.usrId'")
  })
})

describe('one to-one hop then .some (FJS-D2280)', () => {
  it('a finance member updates, support and another org\'s finance are refused', async () => {
    const db: any = await createClient({ schema: ORGS('true'), db: ':memory:', encryptionKey: KEY })
    const sys = db.asSystem()
    await sys.organization.create({ data: { id: 'a' } })
    await sys.organization.create({ data: { id: 'b' } })
    await sys.membership.create({ data: { id: 'm1', organizationId: 'a', userId: 'fin', role: 'finance' } })
    await sys.membership.create({ data: { id: 'm2', organizationId: 'a', userId: 'sup', role: 'support' } })
    await sys.membership.create({ data: { id: 'm3', organizationId: 'b', userId: 'other', role: 'finance' } })
    await sys.invoice.create({ data: { id: 'i1', organizationId: 'a' } })
    const bump = async (who: string, amount: number) => {
      await lands(db.$setAuth({ id: who }).invoice.update({ where: { id: 'i1' }, data: { amount } }))
      return (await sys.invoice.findUnique({ where: { id: 'i1' } })).amount
    }
    expect(await bump('sup', 5)).toBe(0)
    expect(await bump('other', 6)).toBe(0)
    expect(await bump('fin', 7)).toBe(7)
    db.$close()
  })
})

describe('two to-one hops then .some, with this.col', () => {
  it('create (JS) and read (SQL) admit the org member and refuse the stranger', async () => {
    const db: any = await createClient({ schema: QUO, db: ':memory:', encryptionKey: KEY })
    const sys = db.asSystem()
    await sys.org.create({ data: { id: 'g' } })
    await sys.member.create({ data: { id: 'k1', orgId: 'g', userId: 'member' } })
    await sys.phoneNumber.create({ data: { id: 'p1', orgId: 'g' } })
    const as = db.$setAuth({ id: 'member' })
    expect(await lands(as.numberMember.create({ data: { id: 'x1', phoneNumberId: 'p1', userId: 'stranger' } }))).toBe(false)
    expect(await lands(as.numberMember.create({ data: { id: 'x2', phoneNumberId: 'p1', userId: 'member' } }))).toBe(true)
    // The same rule through the WHERE, over a row the JS half refused.
    await sys.numberMember.create({ data: { id: 'x3', phoneNumberId: 'p1', userId: 'stranger' } })
    expect((await as.numberMember.findMany()).map((x: any) => x.id)).toEqual(['x2'])
    db.$close()
  })
})

describe('a chain reaches every hop by its key', () => {
  // Rows are written on a raw connection: the plan is the question, and
  // thousands of client creates would be the test's whole runtime.
  const plan = async (schema: string, fill: (raw: Database) => void, who: string, model: string) => {
    const dir  = mkdtempSync(join(tmpdir(), 'litestone-chain-'))
    const file = join(dir, 'db.sqlite')
    try {
      const seen: any[] = []
      const db: any = await createClient({ schema, db: file, encryptionKey: KEY, onQuery: (e: any) => seen.push(e) })
      const raw = new Database(file)
      try {
        raw.transaction(() => fill(raw))()
        raw.run('ANALYZE')
        seen.length = 0
        const rows = await db.$setAuth({ id: who })[model].findMany()
        expect(rows.length).toBeGreaterThan(0)
        const q = seen.find(e => e.operation === 'findMany')
        return (raw.prepare('EXPLAIN QUERY PLAN ' + q.sql).all(...q.params) as any[]).map(r => r.detail).join(' | ')
      } finally { raw.close(); db.$close() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  it('two hops then a column: no AUTOMATIC index', async () => {
    const detail = await plan(LINES(`@@allow(read, order.customer.userId == auth().id)`), (raw) => {
      for (let i = 0; i < 300; i++)  raw.run('INSERT INTO customer (id, userId) VALUES (?, ?)', ['c' + i, 'u' + (i % 7)])
      for (let i = 0; i < 1000; i++) raw.run('INSERT INTO "order" (id, customerId) VALUES (?, ?)', ['o' + i, 'c' + (i % 300)])
      for (let i = 0; i < 3000; i++) raw.run('INSERT INTO line (id, orderId) VALUES (?, ?)', ['l' + i, 'o' + (i % 1000)])
    }, 'u1', 'line')
    expect(detail).not.toContain('AUTOMATIC')
    expect(detail).not.toMatch(/SCAN (customer|"?order"?|__h)/)
  }, 60000)

  it('one hop then .some, and two hops then .some: no AUTOMATIC index', async () => {
    const orgs = (raw: Database) => {
      for (let i = 0; i < 200; i++)  raw.run('INSERT INTO organization (id) VALUES (?)', ['g' + i])
      for (let i = 0; i < 2000; i++) raw.run('INSERT INTO membership (id, organizationId, userId, role) VALUES (?, ?, ?, ?)', ['m' + i, 'g' + (i % 200), 'u' + (i % 50), 'finance'])
      for (let i = 0; i < 3000; i++) raw.run('INSERT INTO invoice (id, organizationId, amount) VALUES (?, ?, 0)', ['i' + i, 'g' + (i % 200)])
    }
    const one = await plan(ORGS(`organization.memberships.some(userId == auth().id)`), orgs, 'u1', 'invoice')
    expect(one).not.toContain('AUTOMATIC')
    expect(one).toMatch(/SEARCH __some (EXISTS )?USING (COVERING )?INDEX/)

    const two = await plan(QUO, (raw) => {
      for (let i = 0; i < 200; i++)  raw.run('INSERT INTO org (id) VALUES (?)', ['g' + i])
      for (let i = 0; i < 2000; i++) raw.run('INSERT INTO member (id, orgId, userId) VALUES (?, ?, ?)', ['k' + i, 'g' + (i % 200), 'u' + (i % 50)])
      for (let i = 0; i < 600; i++)  raw.run('INSERT INTO phone_number (id, orgId) VALUES (?, ?)', ['p' + i, 'g' + (i % 200)])
      for (let i = 0; i < 3000; i++) raw.run('INSERT INTO number_member (id, phoneNumberId, userId) VALUES (?, ?, ?)', ['x' + i, 'p' + (i % 600), 'u' + (i % 50)])
    }, 'u1', 'numberMember')
    expect(two).not.toContain('AUTOMATIC')
    expect(two).toMatch(/SEARCH __some (EXISTS )?USING (COVERING )?INDEX/)
  }, 60000)
})
