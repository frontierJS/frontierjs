// test/rate.test.ts
//
// `@@rate([key], max: N, per: <window>)` — how many rows one key may write in a
// window, counted at the Data boundary (`FJS-D1119`, `FJS-D2295`, `FJS-3027`).
// Every case runs against a real database under an injected clock, because the
// question is what the COUNT sees: the rows a write unit adds, the rows older
// than the window, and the principal a `@createdBy` column stamps.

import { describe, test, expect } from 'bun:test'
import { createClient } from '../src/index.js'
import { parse } from '../src/core/parser.js'

const BLOG = `
model User {
  id   Int    @id @default(autoincrement())
  name String
  @@auth
}
model Comment {
  id        Int      @id @default(autoincrement())
  body      String
  authorId  Int?     @createdBy
  createdAt DateTime @default(now())
  @@rate([authorId], max: 3, per: 1m)
}`

const clockAt = (iso: string) => {
  let t = Date.parse(iso)
  return { now: () => new Date(t), advance: (ms: number) => { t += ms } }
}
const blog = async () => {
  const clock = clockAt('2026-11-21T12:00:00.000Z')
  const db = await createClient({ schema: BLOG, db: ':memory:', now: clock.now })
  const alice = await db.asSystem().user.create({ data: { name: 'alice' } })
  const bob   = await db.asSystem().user.create({ data: { name: 'bob' } })
  return { db, clock, as: (u: any) => db.$setAuth(u), alice, bob }
}
const refusal = async (fn: () => Promise<unknown>) => {
  try { await fn(); return null } catch (e: any) { return e }
}

describe('a write quota per principal', () => {
  test('the write past the quota is refused 409, names the key, and lands nothing', async () => {
    const { db, as, alice } = await blog()
    for (let i = 0; i < 3; i++) await as(alice).comment.create({ data: { body: `c${i}` } })
    const err = await refusal(() => as(alice).comment.create({ data: { body: 'flood' } }))
    expect(err?.name).toBe('RateLimitError')
    expect(err.status).toBe(409)
    expect(err.message).toContain('authorId')
    expect(err.key).toEqual({ authorId: alice.id })
    expect(await db.asSystem().comment.count()).toBe(3)
  })

  test('the refusal says when the window reopens', async () => {
    const { clock, as, alice } = await blog()
    await as(alice).comment.create({ data: { body: 'first' } })
    clock.advance(20_000)
    await as(alice).comment.create({ data: { body: 'c1' } })
    await as(alice).comment.create({ data: { body: 'c2' } })
    const err = await refusal(() => as(alice).comment.create({ data: { body: 'flood' } }))
    // The first row leaves the window 60 s after it was written.
    expect(err.retryAt).toBe('2026-11-21T12:01:00.000Z')
    expect(err.retryAfter).toBe(40)
  })

  test('one principal at the quota does not refuse another', async () => {
    const { as, alice, bob } = await blog()
    for (let i = 0; i < 3; i++) await as(alice).comment.create({ data: { body: `a${i}` } })
    await as(bob).comment.create({ data: { body: 'b0' } })
  })

  test('rows older than the window stop counting', async () => {
    const { clock, as, alice } = await blog()
    for (let i = 0; i < 3; i++) await as(alice).comment.create({ data: { body: `c${i}` } })
    clock.advance(60_001)
    await as(alice).comment.create({ data: { body: 'later' } })
  })

  test('a batch is counted whole — createMany past the quota is refused and rolls back', async () => {
    const { db, as, alice } = await blog()
    const err = await refusal(() => as(alice).comment.createMany({ data: [1, 2, 3, 4].map(i => ({ body: `c${i}` })) }))
    expect(err?.name).toBe('RateLimitError')
    expect(await db.asSystem().comment.count()).toBe(0)
  })

  test('the count is inside the write unit — a $transaction past the quota rolls back whole', async () => {
    const { db, as, alice } = await blog()
    const err = await refusal(() => as(alice).$transaction(async (tx: any) => {
      for (let i = 0; i < 4; i++) await tx.comment.create({ data: { body: `c${i}` } })
    }))
    expect(err?.name).toBe('RateLimitError')
    expect(await db.asSystem().comment.count()).toBe(0)
  })

  test('asSystem() is held to it — a quota is about the data, as @@check is', async () => {
    const { db, alice } = await blog()
    for (let i = 0; i < 3; i++) await db.asSystem().comment.create({ data: { body: `c${i}`, authorId: alice.id } })
    expect((await refusal(() => db.asSystem().comment.create({ data: { body: 'x', authorId: alice.id } })))?.name)
      .toBe('RateLimitError')
  })

  test('a row with no key is nobody\'s count', async () => {
    const { db } = await blog()
    for (let i = 0; i < 5; i++) await db.asSystem().comment.create({ data: { body: `anon${i}` } })
    expect(await db.asSystem().comment.count()).toBe(5)
  })
})

describe('a cap with no window', () => {
  test('max: without per: counts every live row of the key', async () => {
    const db = await createClient({ db: ':memory:', schema: `
      model Signup {
        id     Int @id @default(autoincrement())
        slotId Int
        @@rate([slotId], max: 2)
      }` })
    await db.signup.create({ data: { slotId: 1 } })
    await db.signup.create({ data: { slotId: 1 } })
    expect((await refusal(() => db.signup.create({ data: { slotId: 1 } })))?.name).toBe('RateLimitError')
    await db.signup.create({ data: { slotId: 2 } })
  })
})

describe('under @map', () => {
  // An unmapped name in the count's WHERE is read by SQLite as a string
  // literal, which matches nothing and admits every write.
  test('a mapped key and clock are counted by their columns', async () => {
    const clock = clockAt('2026-11-21T12:00:00.000Z')
    const db = await createClient({ db: ':memory:', now: clock.now, schema: `
      model Event {
        id      Int      @id @default(autoincrement())
        keyId   Int      @map("key_id")
        sentAt  DateTime @default(now()) @map("sent_at")
        @@rate([keyId], max: 2, per: 1s, at: sentAt)
      }` })
    await db.event.create({ data: { keyId: 7 } })
    await db.event.create({ data: { keyId: 7 } })
    expect((await refusal(() => db.event.create({ data: { keyId: 7 } })))?.name).toBe('RateLimitError')
    clock.advance(1_000)
    await db.event.create({ data: { keyId: 7 } })
  })
})

describe('a window read through a relation (FJS-2087)', () => {
  // ela's survey cap: at most one Survey per client within the account's own
  // number of days, and no cap at all where the account leaves it empty.
  const SURVEYS = `
  model Account {
    id                   Int  @id @default(autoincrement())
    surveyMinDaysBetween Int?
  }
  model Survey {
    id        Int      @id @default(autoincrement())
    clientId  Int
    accountId Int?
    account   Account? @relation(fields: [accountId], references: [id])
    createdAt DateTime @default(now()) @map("created_at")
    @@rate([clientId], max: 1, per: days(account.surveyMinDaysBetween))
  }`
  const DAY = 86_400_000
  const surveys = async () => {
    const clock = clockAt('2026-11-21T12:00:00.000Z')
    const db = await createClient({ schema: SURVEYS, db: ':memory:', now: clock.now })
    return { db, clock }
  }

  test('the window is the account\'s number of days, and the refusal says when it reopens', async () => {
    const { db, clock } = await surveys()
    const acct = await db.account.create({ data: { surveyMinDaysBetween: 90 } })
    await db.survey.create({ data: { clientId: 1, accountId: acct.id } })
    clock.advance(89 * DAY)
    const err = await refusal(() => db.survey.create({ data: { clientId: 1, accountId: acct.id } }))
    expect(err?.name).toBe('RateLimitError')
    expect(err.status).toBe(409)
    expect(err.per).toBe('90d')
    expect(err.retryAt).toBe('2027-02-19T12:00:00.000Z')
    await db.survey.create({ data: { clientId: 2, accountId: acct.id } })
    clock.advance(DAY)
    await db.survey.create({ data: { clientId: 1, accountId: acct.id } })
    expect(await db.survey.count()).toBe(3)
  })

  test('an account with no number has no cap', async () => {
    const { db } = await surveys()
    const acct = await db.account.create({ data: {} })
    for (let i = 0; i < 3; i++) await db.survey.create({ data: { clientId: 1, accountId: acct.id } })
    await db.survey.create({ data: { clientId: 1 } })
    expect(await db.survey.count()).toBe(4)
  })

  test('the number is read at the write, so changing it moves the next refusal', async () => {
    const { db, clock } = await surveys()
    const acct = await db.account.create({ data: { surveyMinDaysBetween: 90 } })
    await db.survey.create({ data: { clientId: 1, accountId: acct.id } })
    clock.advance(10 * DAY)
    expect((await refusal(() => db.survey.create({ data: { clientId: 1, accountId: acct.id } })))?.name).toBe('RateLimitError')
    await db.account.update({ where: { id: acct.id }, data: { surveyMinDaysBetween: 7 } })
    await db.survey.create({ data: { clientId: 1, accountId: acct.id } })
  })

  test('a refused write inside a transaction rolls the whole unit back', async () => {
    const { db } = await surveys()
    const acct = await db.account.create({ data: { surveyMinDaysBetween: 30 } })
    const err = await refusal(() => db.$transaction(async (tx: any) => {
      await tx.survey.create({ data: { clientId: 5, accountId: acct.id } })
      await tx.survey.create({ data: { clientId: 5, accountId: acct.id } })
    }))
    expect(err?.name).toBe('RateLimitError')
    expect(await db.survey.count()).toBe(0)
  })
})

describe('the declaration', () => {
  const model = (rate: string, extra = '') => `
    model Comment {
      id        Int      @id @default(autoincrement())
      authorId  Int
      createdAt DateTime @default(now())
      ${extra}
      ${rate}
    }`
  const errors = (schema: string) => parse(schema).errors?.join('\n') ?? ''

  test('max: is required', () => {
    expect(errors(model('@@rate([authorId], per: 1m)'))).toContain('max:')
  })
  test('the window is a duration', () => {
    expect(errors(model('@@rate([authorId], max: 3, per: soon)'))).toContain('duration')
  })
  test('a key naming no field is refused', () => {
    expect(errors(model('@@rate([nobody], max: 3, per: 1m)'))).toContain('nobody')
  })
  test('per: with no createdAt and no at: is refused', () => {
    const s = `model Comment {
      id       Int @id @default(autoincrement())
      authorId Int
      @@rate([authorId], max: 3, per: 1m)
    }`
    expect(errors(s)).toContain('createdAt')
  })
  test('at: must be a DateTime', () => {
    expect(errors(model('@@rate([authorId], max: 3, per: 1m, at: authorId)'))).toContain('DateTime')
  })
  test('where: reads this row alone, against literals (FJS-4380)', () => {
    const status = 'status String'
    expect(errors(model(`@@rate([authorId], max: 1, where: status == 'confirmed')`, status))).toBe('')
    expect(errors(model(`@@rate([authorId], max: 1, where: nobody == 'x')`, status))).toContain("'nobody'")
    expect(errors(model(`@@rate([authorId], max: 1, where: createdAt > now())`, status))).toContain('now()')
  })
  const ACCOUNT = `
    model Account {
      id   Int    @id @default(autoincrement())
      gap  Int?
      name String
    }`
  const withAccount = (per: string) => ACCOUNT + model(`@@rate([authorId], max: 1, per: ${per})`,
    `accountId Int?\n      account Account? @relation(fields: [accountId], references: [id])`)
  test('per: days(relation.column) parses', () => {
    expect(errors(withAccount('days(account.gap)'))).toBe('')
  })
  test('per: reads a whole number of days through one to-one relation, and nothing else', () => {
    expect(errors(withAccount('hours(account.gap)'))).toContain('days(')
    expect(errors(withAccount('days(gap)'))).toContain('one relation away')
    expect(errors(withAccount('days(nobody.gap)'))).toContain("'nobody' must be a to-one relation")
    expect(errors(withAccount('days(account.missing)'))).toContain("'Account' has no field 'missing'")
    expect(errors(withAccount('days(account.name)'))).toContain('must be an Int')
  })
  const withAccountMax = (max: string) => ACCOUNT + model(`@@rate([authorId], max: ${max})`,
    `accountId Int?\n      account Account? @relation(fields: [accountId], references: [id])`)
  test('max: reads a whole number through one to-one relation, and nothing else (FJS-4380)', () => {
    expect(errors(withAccountMax('account.gap'))).toBe('')
    expect(errors(withAccountMax('nobody.gap'))).toContain("'nobody' must be a to-one relation")
    expect(errors(withAccountMax('account.missing'))).toContain("'Account' has no field 'missing'")
    expect(errors(withAccountMax('account.name'))).toContain('must be an Int')
    expect(errors(withAccountMax('account.x.y'))).toContain('one relation away')
  })
})

describe('a live-row cap read off the parent (FJS-4380)', () => {
  // grouppi's sign-up sheet: a Slot holds `cap` confirmed Signups, and the rest
  // wait. The count is the confirmed ones only, under the slot's own number.
  const SHEET = `
  model Slot {
    id  Int  @id @default(autoincrement())
    cap Int?
  }
  model Signup {
    id     Int    @id @default(autoincrement())
    slotId Int?   @map("slot_id")
    slot   Slot?  @relation(fields: [slotId], references: [id])
    status String @default("confirmed") @map("state")
    @@rate([slotId], max: slot.cap, where: status == 'confirmed')
  }`
  const sheet = async (cap: number | null = 2) => {
    const db = await createClient({ schema: SHEET, db: ':memory:' })
    const slot = await db.slot.create({ data: { cap } })
    return { db, slot }
  }

  test('the write past the slot\'s cap is refused 409, naming the key and the cap', async () => {
    const { db, slot } = await sheet(2)
    await db.signup.create({ data: { slotId: slot.id } })
    await db.signup.create({ data: { slotId: slot.id } })
    const err = await refusal(() => db.signup.create({ data: { slotId: slot.id } }))
    expect(err?.name).toBe('RateLimitError')
    expect(err.status).toBe(409)
    expect(err.key).toEqual({ slotId: slot.id })
    expect(err.max).toBe(2)
    expect(await db.signup.count()).toBe(2)
  })

  test('a row outside where: does not count, so the waitlist fills past the cap', async () => {
    const { db, slot } = await sheet(1)
    await db.signup.create({ data: { slotId: slot.id } })
    await db.signup.create({ data: { slotId: slot.id, status: 'waitlisted' } })
    await db.signup.create({ data: { slotId: slot.id, status: 'waitlisted' } })
    expect(await db.signup.count()).toBe(3)
  })

  test('an update moving a row into where: is graded — promoting past the cap is refused', async () => {
    const { db, slot } = await sheet(1)
    await db.signup.create({ data: { slotId: slot.id } })
    const waiting = await db.signup.create({ data: { slotId: slot.id, status: 'waitlisted' } })
    const err = await refusal(() => db.signup.update({ where: { id: waiting.id }, data: { status: 'confirmed' } }))
    expect(err?.name).toBe('RateLimitError')
    expect((await db.signup.findUnique({ where: { id: waiting.id } })).status).toBe('waitlisted')
  })

  test('a bulk promotion is graded by the rows it moves, and rolls back whole', async () => {
    const { db, slot } = await sheet(2)
    await db.signup.create({ data: { slotId: slot.id } })
    for (let i = 0; i < 2; i++) await db.signup.create({ data: { slotId: slot.id, status: 'waitlisted' } })
    const err = await refusal(() => db.signup.updateMany({ where: { slotId: slot.id, status: 'waitlisted' }, data: { status: 'confirmed' } }))
    expect(err?.name).toBe('RateLimitError')
    expect(await db.signup.count({ where: { status: 'confirmed' } })).toBe(1)
  })

  test('a slot with no cap admits every row, and a raised cap holds from the next write', async () => {
    const { db, slot } = await sheet(null)
    for (let i = 0; i < 3; i++) await db.signup.create({ data: { slotId: slot.id } })
    await db.slot.update({ where: { id: slot.id }, data: { cap: 4 } })
    await db.signup.create({ data: { slotId: slot.id } })
    expect((await refusal(() => db.signup.create({ data: { slotId: slot.id } })))?.name).toBe('RateLimitError')
  })

  test('two slots are two counts', async () => {
    const { db, slot } = await sheet(1)
    const other = await db.slot.create({ data: { cap: 1 } })
    await db.signup.create({ data: { slotId: slot.id } })
    await db.signup.create({ data: { slotId: other.id } })
    expect(await db.signup.count()).toBe(2)
  })
})
