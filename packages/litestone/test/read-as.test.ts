// read-as.test.ts — `$readAs`, the fifth sibling.
//
// `FJS-631`. `@@allow` compiles into a SELECT's WHERE, so a row that reaches a
// caller through a query is filtered by construction and a row that reaches
// them any other way is filtered by nothing. Junction owns the fan-out of a
// broadcast and cannot own the rule — the gate, the row policies and the field
// policies are declared here, and a second implementation of any of them is a
// second answer to who may read.
//
// Every refusal below is paired with the acceptance of the identical row by a
// principal the schema admits, for `FJS-351`'s reason: a function that refuses
// everything is indistinguishable from one that works, from the refused side.

import { test, expect, describe } from 'bun:test'
import { createClient } from '../src/core/client.js'

const SCHEMA = `
database main { path ":memory:" }

model Order {
  id         Int     @id @default(autoincrement())
  reference  String
  total      Int
  margin     Int?    @allow('read', auth().isStaff == true)
  internal   String? @guarded
  userId     String?
  @@gate(1.4.4.5)
  @@allow('read', auth().isStaff == true)
  @@allow('read', userId == auth().id)
}

// Reads at 0, no policy, no field rule — nothing to grade.
model Product {
  id   Int    @id @default(autoincrement())
  name String
}

// Gated but unpoliced: the gate alone is a reason to grade.
model Ledger {
  id   Int @id @default(autoincrement())
  memo String
  @@gate(5.8.9.9)
}

// A policy and nothing else. Order carries a gate AND a policy, so a check that
// never read the policy still graded it — this is the model that tells them apart.
model Note {
  id     Int     @id @default(autoincrement())
  userId String?
  @@allow('read', userId == auth().id)
}

model Draft {
  id     Int     @id @default(autoincrement())
  hidden Boolean @default(false)
  @@deny('read', hidden == true)
}

// Read is on the grid and on nothing else: no gate, no policy. Each verb is a
// capability the caller's role holds (FJS-2527).
model Lead {
  id   Int    @id @default(autoincrement())
  name String
  @@capabilities(all)
}

// The grid without \`(all)\`: writes and moves only, so read stays open.
model Memo {
  id   Int    @id @default(autoincrement())
  body String
  @@capabilities
}
`

const client = () => createClient({ schema: SCHEMA, resolveFrom: import.meta.dir })

const ROW = { id: 1, reference: 'ORD-1001', total: 4194, margin: 1200, internal: 'do not show', userId: 'u-owner' }
const staff    = { id: 'u-staff', isStaff: true }
const owner    = { id: 'u-owner', isStaff: false }
const stranger = { id: 'u-other', isStaff: false }

describe('who may see the row at all', () => {
  test('nobody is refused by the gate — the whole answer for a stranger', async () => {
    const db = await client()
    expect(await db.$readAs('order', ROW, null)).toBeNull()
  })

  test('a signed-in caller the row policy excludes is refused', async () => {
    const db = await client()
    expect(await db.$readAs('order', ROW, stranger)).toBeNull()
  })

  test('and the controls — the owner and staff each get the row', async () => {
    const db = await client()
    expect((await db.$readAs('order', ROW, owner))?.id).toBe(1)
    expect((await db.$readAs('order', ROW, staff))?.id).toBe(1)
  })

  test('the gate is asked BEFORE the row policy, as every other layer reads it', async () => {
    // `Ledger` declares a gate and no policy, so a caller below it is refused
    // by a mechanism a policy walk would never reach.
    const db = await client()
    expect(await db.$readAs('ledger', { id: 1, memo: 'x' }, owner)).toBeNull()
    expect((await db.$readAs('ledger', { id: 1, memo: 'x' }, { id: 'a', isAdmin: true }))?.memo).toBe('x')
  })
})

describe('the capability grid, where (all) puts read on it — FJS-2527', () => {
  test('a reader whose grant lacks Model.read is refused the row a query would not have answered', async () => {
    const db = await client()
    const row = { id: 1, name: 'Casey' }
    expect(await db.$readAs('lead', row, { id: 'site', capabilities: ['Lead.create'] })).toBeNull()
    expect(await db.$readAs('lead', row, { id: 'guest' })).toBeNull()
    expect(await db.$readAs('lead', row, null)).toBeNull()
  })

  test('and the control — a reader holding Lead.read gets the row', async () => {
    const db = await client()
    const row = { id: 1, name: 'Casey' }
    expect(await db.$readAs('lead', row, { id: 'closer', capabilities: ['Lead.read'] })).toEqual(row)
  })

  test('a grid that leaves read off grades nothing on read', async () => {
    const db = await client()
    expect(await db.$readAs('memo', { id: 1, body: 'x' }, { id: 'anyone' })).toEqual({ id: 1, body: 'x' })
    expect(db.$readGrading('memo')).toBe('open')
  })

  test('a model whose only read rule is its grid is graded, not open', async () => {
    const db = await client()
    expect(db.$readGrading('lead')).toBe('graded')
  })
})

describe('what of the row they may see', () => {
  test('a field the caller may not read is stripped, and the writer’s copy is not the answer', async () => {
    // The announced row came from a staff write, so it carries `margin`.
    const db = await client()
    const asOwner = await db.$readAs('order', ROW, owner)
    expect(asOwner.margin).toBeUndefined()
    expect(asOwner.reference).toBe('ORD-1001')

    const asStaff = await db.$readAs('order', ROW, staff)
    expect(asStaff.margin).toBe(1200)
  })

  test('a @guarded column is stripped for everybody, staff included', async () => {
    const db = await client()
    expect((await db.$readAs('order', ROW, staff)).internal).toBeUndefined()
    expect((await db.$readAs('order', ROW, owner)).internal).toBeUndefined()
  })

  test('the row handed in is not mutated — the caller may still send it elsewhere', async () => {
    const db = await client()
    await db.$readAs('order', ROW, owner)
    expect(ROW.margin).toBe(1200)
    expect(ROW.internal).toBe('do not show')
  })
})

describe('$readGrading — when the whole pass can be skipped', () => {
  test('a model with no gate, no policy and no field rule is open', async () => {
    const db = await client()
    expect(db.$readGrading('product')).toBe('open')
  })

  test('a gate alone makes it graded', async () => {
    const db = await client()
    expect(db.$readGrading('ledger')).toBe('graded')
  })

  test('a policy makes it graded', async () => {
    const db = await client()
    expect(db.$readGrading('order')).toBe('graded')
  })

  test('a policy ALONE makes it graded — an allow, and a deny', async () => {
    // `open` here is an ungraded broadcast: junction skips `$readAs` and sends
    // every row to every subscriber.
    const db = await client()
    expect(db.$readGrading('note')).toBe('graded')
    expect(db.$readGrading('draft')).toBe('graded')
  })

  test('an unknown accessor is graded — the fail-closed direction', async () => {
    // The sibling contract answers `{}` / `[]` for an unknown accessor because
    // *I cannot judge this* is not *this is wrong*. Here it is a permission, so
    // the same uncertainty has to fall the other way.
    const db = await client()
    expect(db.$readGrading('nope')).toBe('graded')
    expect(await db.$readAs('nope', ROW, staff)).toBeNull()
  })

  test('an open model still answers the row unchanged', async () => {
    const db = await client()
    const p = { id: 1, name: 'Widget' }
    expect(await db.$readAs('product', p, null)).toEqual(p)
  })
})

describe('the sibling contract', () => {
  test('every flavor of client answers identically for the same principal', async () => {
    // $capabilitiesFor's rule: the subject is an ARGUMENT, so which client is
    // asking cannot change the answer. Defaulting to the client's own principal
    // would break exactly that.
    const db = await client()
    const answers = await Promise.all([
      db.$readAs('order', ROW, owner),
      db.asSystem().$readAs('order', ROW, owner),
      db.$setAuth(staff).$readAs('order', ROW, owner),
      db.$setAuth(null).$readAs('order', ROW, owner),
    ])
    const first = JSON.stringify(answers[0])
    for (const a of answers) expect(JSON.stringify(a)).toBe(first)
    // …and it is the OWNER's answer, not the asking client's.
    expect(answers[1].margin).toBeUndefined()
  })

  test('a null row is null, never an empty object', async () => {
    const db = await client()
    expect(await db.$readAs('order', null, staff)).toBeNull()
  })
})

describe('$readReach — which writes can take a row from its reader', () => {
  // A revoked share writes a Share, never the Page, so a reader holding the
  // page is asked again only if the Share is known to decide it (`FJS-1743`).
  const REACH = `
database main { path ":memory:" }

model Workspace {
  id      Int    @id @default(autoincrement())
  ownerId String
  pages   Page[]
  @@allow('read', ownerId == auth().id)
}

model Page {
  id          Int       @id @default(autoincrement())
  workspaceId Int
  workspace   Workspace @relation(fields: [workspaceId], references: [id])
  ownerId     String
  shares      Share[]
  blocks      Block[]
  @@allow('read', ownerId == auth().id || shares.some(userId == auth().id) || workspace.ownerId == auth().id)
}

model Share {
  id     Int    @id @default(autoincrement())
  pageId Int
  page   Page   @relation(fields: [pageId], references: [id])
  userId String
}

model Block {
  id     Int  @id @default(autoincrement())
  pageId Int
  page   Page @relation(fields: [pageId], references: [id])
  @@allow('read', check(page))
}

model Tag {
  id   Int    @id @default(autoincrement())
  name String
}
`
  const reachClient = () => createClient({ schema: REACH, resolveFrom: import.meta.dir })

  test('a path and a .some() reach the models they cross into', async () => {
    const db = await reachClient()
    expect(db.$readReach('page')).toEqual(['Page', 'Share', 'Workspace'])
  })

  test('a check() reaches the delegated model and everything IT reaches', async () => {
    const db = await reachClient()
    expect(db.$readReach('block')).toEqual(['Block', 'Page', 'Share', 'Workspace'])
  })

  test('a model with no policy reaches itself, and an unknown accessor nothing', async () => {
    const db = await reachClient()
    expect(db.$readReach('tag')).toEqual(['Tag'])
    expect(db.$readReach('nope')).toEqual([])
    expect(db.asSystem().$readReach('block')).toEqual(db.$readReach('block'))
  })
})

describe('$fromReach — which writes move a @from value (FJS-2632)', () => {
  const FROM = `
database main { path ":memory:" }

model Shift {
  id          Int          @id @default(autoincrement())
  adults      Int          @from(Assignment, count: true)
  assignments Assignment[]
}

model Assignment {
  id      Int   @id @default(autoincrement())
  shiftId Int
  shift   Shift @relation(fields: [shiftId], references: [id])
  start   Int    @from(shift, id)
}

model Tag {
  id   Int    @id @default(autoincrement())
  name String
}
`
  test('an aggregate reaches its target, a to-one column its parent, a plain model nothing', async () => {
    const db = await createClient({ schema: FROM, resolveFrom: import.meta.dir })
    expect(db.$fromReach('shift')).toEqual(['Assignment'])
    expect(db.$fromReach('assignment')).toEqual(['Shift'])
    expect(db.$fromReach('tag')).toEqual([])
    expect(db.$fromReach('nope')).toEqual([])
    expect(db.asSystem().$fromReach('shift')).toEqual(['Assignment'])
  })
})

describe('$readColumns — which columns of a reached model a verdict reads', () => {
  // A heartbeat stamped on a reached row moves nobody's access; only the
  // columns a policy or a join reads can (`FJS-3127`).
  const COLS = `
database main { path ":memory:" }

model Project {
  id      Int     @id @default(autoincrement())
  ownerId String
  runs    Run[]
  @@allow('read', ownerId == auth().id)
}

model Run {
  id          Int       @id @default(autoincrement())
  projectId   Int
  project     Project   @relation(fields: [projectId], references: [id])
  heartbeatAt DateTime?
  chunks      Chunk[]
  @@allow('read', check(project))
}

model Chunk {
  id     Int    @id @default(autoincrement())
  runId  Int
  run    Run    @relation(fields: [runId], references: [id])
  body   String
  @@allow('read', check(run))
}

model Note {
  id        Int       @id @default(autoincrement())
  body      String
  deletedAt DateTime?
  @@softDelete
}

model Doc {
  id     Int  @id @default(autoincrement())
  noteId Int
  note   Note @relation(fields: [noteId], references: [id])
  @@allow('read', note.body != null)
}
`
  const colsClient = () => createClient({ schema: COLS, resolveFrom: import.meta.dir })

  test('a check() chain lists the policy fields and the join keys, not the rest', async () => {
    const db = await colsClient()
    expect(db.$readColumns('chunk')).toEqual({
      Chunk:   ['runId'],
      Project: ['id', 'ownerId'],
      Run:     ['id', 'projectId'],
    })
  })

  test('a model every read filters by soft delete lists its deletedAt', async () => {
    const db = await colsClient()
    expect(db.$readColumns('doc')).toEqual({ Doc: ['noteId'], Note: ['body', 'deletedAt', 'id'] })
  })

  test('every flavor answers alike, and an unknown accessor answers nothing', async () => {
    const db = await colsClient()
    expect(db.asSystem().$readColumns('chunk')).toEqual(db.$readColumns('chunk'))
    expect(db.$readColumns('nope')).toEqual({})
  })
})
