// test/policy-delegation.test.ts
//
// What a `check()` delegation actually reaches, decided at startup (FJS-636).
//
// `check(parent)` compiles to a correlated EXISTS over the TARGET'S POLICY. Two
// shapes make that mean something other than what it reads as, and both are
// decided by the schema alone — which is the whole argument for saying them at
// createClient rather than in the compiler, where the answer would be repeated
// on every query and arrives too late for a schema edit:
//
//   A CYCLE re-enters a model already on the path and compiles to '0'. Failing
//   closed is the right direction and it is not an answer: the author wrote
//   *readable if its parent is* and got *only rows whose foreign key is NULL*,
//   which is data-dependent and therefore reads as a filter doing its job.
//
//   A TARGET WITH NO POLICY for the delegated operation compiles to '1'. That
//   is correct where the target is open and a hole where its protection is a
//   `@@gate` or a capability grid, both of which live a tier above any compiled
//   predicate — so the level guarding the parent reaches the child not at all.
//
// The refusals are paired with the schema one edge different that must still
// build, because a check that refuses a cycle and an open chain alike proves
// nothing about cycles.

import { describe, test, expect, afterEach } from 'bun:test'
import { createClient } from '../src/index.js'

const open = (schema: string) => createClient({ schema, db: ':memory:' })

describe('a check() cycle is refused at startup', () => {
  test('two models delegating to each other name both hops and where it closed', async () => {
    const err = await open(`
      model Left {
        id      Int    @id
        right   Right  @relation(fields: [rightId], references: [id])
        rightId Int
        @@allow('read', check(right))
      }
      model Right {
        id     Int   @id
        left   Left? @relation(fields: [leftId], references: [id])
        leftId Int?
        @@allow('read', check(left))
      }
    `).then(() => null, (e: Error) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain('Left.right → Right')
    expect(err!.message).toContain('Right.left → Left')
    // The consequence, not just the shape — a cycle that only says "circular"
    // leaves the author to work out why an empty table is the same bug.
    expect(err!.message).toContain('foreign key is NULL')
  })

  test('a ring of three closes too — the guard tests the model, not the neighbor', async () => {
    const err = await open(`
      model A {
        id Int @id
        b  B   @relation(fields: [bId], references: [id])
        bId Int
        @@allow('read', check(b))
      }
      model B {
        id Int @id
        c  C   @relation(fields: [cId], references: [id])
        cId Int
        @@allow('read', check(c))
      }
      model C {
        id Int @id
        a  A?  @relation(fields: [aId], references: [id])
        aId Int?
        @@allow('read', check(a))
      }
    `).then(() => null, (e: Error) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain('C.a → A')
  })

  test('a self-relation is refused with the fix it actually has', async () => {
    const err = await open(`
      model Comment {
        id       Int      @id
        parent   Comment? @relation("thread", fields: [parentId], references: [id])
        children Comment[] @relation("thread")
        parentId Int?
        ownerId  Int
        @@allow('read', ownerId == auth().id)
        @@allow('read', check(parent))
      }
    `).then(() => null, (e: Error) => e)

    expect(err).toBeInstanceOf(Error)
    // Not the two-model advice: pointing "one side" at its own columns is not
    // available to a model delegating to itself, and SQL here has no recursion.
    expect(err!.message).toContain('self-relation')
    expect(err!.message).toContain('denormalise')
  })

  test('the operation is followed, so a cycle through check(field, op) is seen', async () => {
    // Neither model's `read` rules cycle; the loop exists only because the
    // update rule crosses into the other model's read.
    const err = await open(`
      model Ticket {
        id      Int    @id
        queue   Queue  @relation(fields: [queueId], references: [id])
        queueId Int
        @@allow('update', check(queue, 'read'))
      }
      model Queue {
        id       Int     @id
        ticket   Ticket? @relation(fields: [ticketId], references: [id])
        ticketId Int?
        @@allow('read', check(ticket, 'update'))
      }
    `).then(() => null, (e: Error) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain('Ticket.queue → Queue')
  })

  // ── the negative controls ──────────────────────────────────────────────────

  test('an open chain builds AND delegates — A → B → C never closes', async () => {
    const db = await open(`
      model Doc {
        id     Int  @id
        folder Folder @relation(fields: [folderId], references: [id])
        folderId Int
        @@allow('read', check(folder))
      }
      model Folder {
        id      Int  @id
        vault   Vault @relation(fields: [vaultId], references: [id])
        vaultId Int
        @@allow('read', check(vault))
      }
      model Vault {
        id      Int @id
        ownerId Int
        @@allow('read', ownerId == auth().id)
      }
    `)
    const sys = db.asSystem()
    await sys.vault.create({ data: { id: 1, ownerId: 7 } })
    await sys.vault.create({ data: { id: 2, ownerId: 9 } })
    await sys.folder.create({ data: { id: 1, vaultId: 1 } })
    await sys.folder.create({ data: { id: 2, vaultId: 2 } })
    await sys.doc.create({ data: { id: 1, folderId: 1 } })
    await sys.doc.create({ data: { id: 2, folderId: 2 } })

    // Two hops of delegation actually reaching the owner column at the end.
    const mine = await db.$setAuth({ id: 7 }).doc.findMany()
    expect(mine.map((d: any) => d.id)).toEqual([1])
    db.$close?.()
  })

  test('two models pointing at each other is not a cycle — only the delegation is', async () => {
    const db = await open(`
      model Author {
        id      Int    @id
        posts   Post[]
        ownerId Int
        @@allow('read', ownerId == auth().id)
      }
      model Post {
        id       Int    @id
        author   Author @relation(fields: [authorId], references: [id])
        authorId Int
        @@allow('read', check(author))
      }
    `)
    const sys = db.asSystem()
    await sys.author.create({ data: { id: 1, ownerId: 7 } })
    await sys.post.create({ data: { id: 1, authorId: 1 } })
    expect(await db.$setAuth({ id: 7 }).post.count()).toBe(1)
    expect(await db.$setAuth({ id: 9 }).post.count()).toBe(0)
    db.$close?.()
  })
})

describe('a check() at protection the compiler cannot see is warned about', () => {
  const origWarn = console.warn
  afterEach(() => { console.warn = origWarn })

  const warningsFrom = async (schema: string) => {
    const out: string[] = []
    console.warn = (msg: string) => { out.push(String(msg)) }
    const db = await open(schema)
    console.warn = origWarn
    return { db, warnings: out.filter(w => w.includes('delegates to')) }
  }

  test('a @@gate-only target warns, and the read it describes is measurably open', async () => {
    const { db, warnings } = await warningsFrom(`
      model Doc {
        id      Int   @id
        vault   Vault @relation(fields: [vaultId], references: [id])
        vaultId Int
        @@allow('read', check(vault))
      }
      model Vault {
        id Int @id
        @@gate("7")
      }
    `)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('@@gate')
    expect(warnings[0]).toContain('places no restriction at all on Doc')

    // The warning is a warning: the behavior is unchanged, and this is the
    // behavior. An anonymous caller reads a document whose vault needs 7.
    const sys = db.asSystem()
    await sys.vault.create({ data: { id: 1 } })
    await sys.doc.create({ data: { id: 1, vaultId: 1 } })
    expect(await db.doc.count()).toBe(1)
    db.$close?.()
  })

  test('a capability grid is the same hole and says so', async () => {
    const { db, warnings } = await warningsFrom(`
      model Doc {
        id      Int   @id
        vault   Vault @relation(fields: [vaultId], references: [id])
        vaultId Int
        @@allow('read', check(vault))
      }
      model Vault {
        id Int @id
        @@capabilities(all)
      }
    `)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('capability grid')
    db.$close?.()
  })

  test('a target with a row policy for that operation is silent', async () => {
    const { db, warnings } = await warningsFrom(`
      model Doc {
        id      Int   @id
        vault   Vault @relation(fields: [vaultId], references: [id])
        vaultId Int
        @@allow('read', check(vault))
      }
      model Vault {
        id      Int @id
        ownerId Int
        @@gate("4")
        @@allow('read', ownerId == auth().id)
      }
    `)
    expect(warnings).toEqual([])
    db.$close?.()
  })

  test('a target with no protection at all is silent — an open parent is not the subject', async () => {
    const { db, warnings } = await warningsFrom(`
      model Doc {
        id      Int   @id
        vault   Vault @relation(fields: [vaultId], references: [id])
        vaultId Int
        @@allow('read', check(vault))
      }
      model Vault { id Int @id }
    `)
    expect(warnings).toEqual([])
    db.$close?.()
  })

  test('the OPERATION is what is graded — a policy for read does not cover a delegated delete', async () => {
    const { db, warnings } = await warningsFrom(`
      model Doc {
        id      Int   @id
        vault   Vault @relation(fields: [vaultId], references: [id])
        vaultId Int
        @@allow('delete', check(vault, 'delete'))
      }
      model Vault {
        id      Int @id
        ownerId Int
        @@gate("4")
        @@allow('read', ownerId == auth().id)
      }
    `)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("'delete'")
    db.$close?.()
  })
})
