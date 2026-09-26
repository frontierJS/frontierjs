// test/claim-source.test.ts
//
// `claim <name> from <Model>(<subject>)[.<column>]` — a claim whose value is
// read off a row pointing at the caller, and `db.$claimsFor(principal)`, which
// reads it.
//
// Every refusal is a claim that would resolve to the WRONG value rather than to
// none, and each is PAIRED with the schema one declaration away that builds —
// a check that refuses the correct spelling too proves nothing about the wrong
// one (`FJS-351`).
//
// The resolution half runs against a real client. What it has to prove is that
// a caller with no row holds NOTHING in both policy interpreters: a sourced
// claim is null for most callers of most apps, and a null that read as TRUE in
// the create path would be an open door with no error anywhere.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, parse, parseFile } from '../src/index.js'

const USER = `model User { id Int @id @default(autoincrement())  @@auth }`

const employee = (extra = '', subject = 'userId Int @unique') => `
model Employee {
  id        Int       @id @default(autoincrement())
  ${subject}
  user      User      @relation(fields: [userId], references: [id])
  siteId    Int
  pin       String?   @guarded
  deletedAt DateTime?
  ${extra}
  @@softDelete
}`

const errorsOf = (src: string) => parse(src).errors.join('\n')

// ─── the declaration ─────────────────────────────────────────────────────────

describe('claim … from parses', () => {
  test('both forms, and the names still reach the claim list', () => {
    const r = parse(`claim employeeId from Employee(userId)
claim siteId from Employee(userId).siteId
claim cartToken
${USER}${employee()}`)
    expect(r.errors).toEqual([])
    expect(r.schema.claims).toEqual(['employeeId', 'siteId', 'cartToken'])
    expect(r.schema.claimSources).toEqual({
      employeeId: { model: 'Employee', subject: 'userId', column: null },
      siteId:     { model: 'Employee', subject: 'userId', column: 'siteId' },
    })
  })
})

describe('a claim that would resolve to the wrong value is refused', () => {
  const ok = (claim: string, rest = USER + employee()) => expect(errorsOf(claim + '\n' + rest)).toBe('')

  test('no @@auth model — there is no caller id to look up by', () => {
    const noAuth = USER.replace('  @@auth', '') + employee()
    expect(errorsOf('claim siteId from Employee(userId).siteId\n' + noAuth)).toContain('no model is @@auth')
    ok('claim siteId from Employee(userId).siteId')
  })

  test('a model that does not exist', () => {
    expect(errorsOf('claim siteId from Employe(userId).siteId\n' + USER + employee())).toContain("names no model 'Employe'")
    ok('claim siteId from Employee(userId).siteId')
  })

  test('a subject that is not a key to the @@auth model', () => {
    // siteId is unique here and still wrong: it is compared with the caller's
    // id, and a site number is not one.
    const src = USER + employee('', 'userId Int @unique') .replace('siteId    Int', 'siteId    Int @unique')
    expect(errorsOf('claim employeeId from Employee(siteId)\n' + src)).toContain("'siteId' is not a key to @@auth User")
    ok('claim employeeId from Employee(userId)', src)
  })

  test('a subject that is not unique — one caller, two rows', () => {
    const loose = USER + employee('', 'userId Int')
    expect(errorsOf('claim siteId from Employee(userId).siteId\n' + loose)).toContain("'userId' is not unique on Employee")
    ok('claim siteId from Employee(userId).siteId')
  })

  test('@@unique([userId]) is as unique as @unique', () => {
    ok('claim siteId from Employee(userId).siteId', USER + employee('@@unique([userId])', 'userId Int'))
  })

  test('unique per TENANT is the membership shape, and the refusal says so', () => {
    const row = `tenancy { strategy row  column workspaceId }
model User { id Int @id @default(autoincrement())  @@auth  @@tenant(none) }
model Employee {
  id          Int  @id @default(autoincrement())
  workspaceId Int
  userId      Int  @unique
  user        User @relation(fields: [userId], references: [id])
  siteId      Int
}`
    const err = errorsOf('claim siteId from Employee(userId).siteId\n' + row)
    expect(err).toContain('unique per tenant')
    expect(err).toContain('membershipClaim')
    ok('claim siteId from Employee(userId).siteId', row.replace('userId      Int  @unique', 'userId      Int  @unique(global)'))
  })

  test('a column that is not there, or is not one stored value', () => {
    expect(errorsOf('claim siteId from Employee(userId).site\n' + USER + employee())).toContain("'site' is not a field of Employee")
    expect(errorsOf('claim who from Employee(userId).user\n' + USER + employee())).toContain('not a stored scalar column')
    ok('claim siteId from Employee(userId).siteId')
  })

  test('a protected column — a claim is copied onto every principal', () => {
    expect(errorsOf('claim pin from Employee(userId).pin\n' + USER + employee())).toContain("'pin' is protected")
    ok('claim siteId from Employee(userId).siteId')
  })

  test('a name the @@auth model already answers', () => {
    const withCol = `model User { id Int @id @default(autoincrement())  siteId Int?  @@auth }` + employee()
    expect(errorsOf('claim siteId from Employee(userId).siteId\n' + withCol)).toContain("'siteId' is already a claim — a column of @@auth User")
    ok('claim employeeSite from Employee(userId).siteId', withCol)
  })

  test("a name that is the framework's — a row may not decide who the caller is", async () => {
    const src = (name: string) => `claim ${name} from Employee(userId).siteId\n${USER}${employee()}`
    const refused = await createClient({ schema: src('role'), db: ':memory:' }).then(() => null, (e: Error) => e.message)
    expect(refused).toContain("'role' is the framework's")
    expect(await createClient({ schema: src('siteRole'), db: ':memory:' })).toBeTruthy()
  })

  test('two files reading one claim off two different rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claim-src-'))
    writeFileSync(join(dir, 'staff.lite'), `claim siteId from Employee(userId).siteId\n${employee()}`)
    writeFileSync(join(dir, 'schema.lite'), `import "./staff.lite"\nclaim siteId from Employee(userId).id\n${USER}`)
    expect(parseFile(join(dir, 'schema.lite')).errors.join('\n')).toContain("claim 'siteId' is read from two different rows")

    writeFileSync(join(dir, 'schema.lite'), `import "./staff.lite"\nclaim siteId from Employee(userId).siteId\n${USER}`)
    expect(parseFile(join(dir, 'schema.lite')).errors).toEqual([])
  })
})

// ─── the resolution ──────────────────────────────────────────────────────────

const SHOP = `claim employeeId from Employee(userId)
claim siteId     from Employee(userId).siteId
${USER}${employee()}
model Shift {
  id     Int    @id @default(autoincrement())
  siteId Int
  note   String
  @@allow('read',   siteId == auth().siteId)
  @@allow('create', siteId == auth().siteId)
}`

async function shop() {
  const db: any = await createClient({ schema: SHOP, db: ':memory:' })
  const sys = db.asSystem()
  await sys.user.create({ data: {} })
  await sys.user.create({ data: {} })
  await sys.employee.create({ data: { userId: 1, siteId: 7 } })
  await sys.shift.create({ data: { siteId: 7, note: 'mine' } })
  await sys.shift.create({ data: { siteId: 9, note: 'theirs' } })
  return db
}

const scoped = async (db: any, who: Record<string, unknown>) => db.$setAuth({ ...who, ...(await db.$claimsFor(who)) })

describe('db.$claimsFor(principal)', () => {
  test('reads each claim off the row pointing at the caller', async () => {
    const db = await shop()
    expect(await db.$claimsFor({ id: 1 })).toEqual({ employeeId: 1, siteId: 7 })
  })

  test('a caller with no row holds none — null, which is a statement, not silence', async () => {
    const db = await shop()
    expect(await db.$claimsFor({ id: 2 })).toEqual({ employeeId: null, siteId: null })
  })

  test('a caller with no id gets nothing to hold', async () => {
    const db = await shop()
    expect(await db.$claimsFor(null)).toEqual({})
    expect(await db.$claimsFor({})).toEqual({})
  })

  test("a junction principal's TEXT id finds an Int subject", async () => {
    // Every junction principal carries its id as a string (`FJS-713`).
    const db = await shop()
    expect(await db.$claimsFor({ id: '1' })).toEqual({ employeeId: 1, siteId: 7 })
  })

  test("the model's own exclusions apply — a soft-deleted role row resolves to nothing", async () => {
    const db = await shop()
    await db.asSystem().employee.remove({ where: { id: 1 } })
    expect(await db.$claimsFor({ id: 1 })).toEqual({ employeeId: null, siteId: null })
  })

  test('every flavor answers the same for the same caller', async () => {
    const db = await shop()
    const want = { employeeId: 1, siteId: 7 }
    expect(await db.$setAuth({ id: 2 }).$claimsFor({ id: 1 })).toEqual(want)
    expect(await db.asSystem().$claimsFor({ id: 1 })).toEqual(want)
  })

  test('one read per row, however many claims come off it', async () => {
    const db = await shop()
    const seen: string[] = []
    const off = db.$tapQuery((e: { sql: string }) => { if (/"employee"/.test(e.sql)) seen.push(e.sql) })
    await db.$claimsFor({ id: 1 })
    off()
    expect(seen.length).toBe(1)
  })

  test('a schema with no sourced claim reads nothing', async () => {
    const db: any = await createClient({ schema: USER, db: ':memory:' })
    expect(await db.$claimsFor({ id: 1 })).toEqual({})
  })
})

describe('the claim decides rows, and no row decides none', () => {
  test('read — the employee sees their site, a caller with no row sees nothing', async () => {
    const db = await shop()
    expect((await (await scoped(db, { id: 1 })).shift.findMany()).map((r: any) => r.note)).toEqual(['mine'])
    expect(await (await scoped(db, { id: 2 })).shift.findMany()).toEqual([])
  })

  test('create — the JS interpreter reads the null claim the way SQL does', async () => {
    const db = await shop()
    const make = async (who: Record<string, unknown>) =>
      (await scoped(db, who)).shift.create({ data: { siteId: 7, note: 'x' } }).then(() => 'allow', () => 'deny')
    expect(await make({ id: 1 })).toBe('allow')
    expect(await make({ id: 2 })).toBe('deny')
  })
})
