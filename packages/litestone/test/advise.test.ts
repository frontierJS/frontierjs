// test/advise.test.ts
//
// Every rule here fires on a schema the PARSER accepts — measured, not assumed:
// each case below parses clean and is still wrong, which is the whole reason the
// rule exists. A rule that could never fire is decoration, and a rule that fires
// on a correct schema is worse than none, so both directions are asserted.

import { describe, test, expect } from 'bun:test'
import { parse } from '../src/core/parser.js'
import { checkRules, RULES, VISIBILITY, visibilityFor, PER_CALLER } from '../src/core/advise.js'
import { CATALOG } from '../src/core/catalog.js'

const findings = (src: string, id?: string) => {
  const out = parse(src)
  expect(out.valid).toBe(true)          // the point: the parser is happy
  const all = checkRules(out.schema)
  return id ? all.filter(f => f.id === id) : all
}

describe('the visibility table', () => {
  test('names all eight combinations', () => {
    expect(VISIBILITY.length).toBe(8)
    for (const stored of [true, false])
      for (const callerWrites of [true, false])
        for (const callerReads of [true, false])
          expect(visibilityFor({ stored, callerWrites, callerReads })).not.toBeNull()
  })

  test('every word it names is a real field attribute', () => {
    for (const row of [...VISIBILITY, PER_CALLER]) {
      if (!row.word) continue
      expect(CATALOG.find(r => r.level === 'field' && r.word === row.word)).toBeTruthy()
    }
  })

  test('it agrees with the parser own table', () => {
    // @computed  no column,  caller does not write, caller reads
    // @transient no column,  caller writes,         caller does not read
    // @system    column,     caller does not write, caller reads
    // @guarded   column,     caller does not write, caller does not read
    expect(visibilityFor({ stored: false, callerWrites: false, callerReads: true  })!.word).toBe('computed')
    expect(visibilityFor({ stored: false, callerWrites: true,  callerReads: false })!.word).toBe('transient')
    expect(visibilityFor({ stored: true,  callerWrites: false, callerReads: true  })!.word).toBe('system')
    expect(visibilityFor({ stored: true,  callerWrites: false, callerReads: false })!.word).toBe('guarded')
  })

  test('a row with no word says why rather than answering nothing', () => {
    for (const row of VISIBILITY)
      if (!row.word) expect(row.answer.length).toBeGreaterThan(0)
  })
})

describe('required-guarded-uncreatable', () => {
  test('fires on a required @guarded column below level 8', () => {
    const f = findings(`
      model Thing {
        id    Int    @id
        token String @guarded
        @@gate("2.4.4.5")
      }`, 'required-guarded-uncreatable')
    expect(f.length).toBe(1)
    expect(f[0].field).toBe('token')
    expect(f[0].severity).toBe('error')
  })

  test('silent when the column is optional, defaulted, or the gate is already system-only', () => {
    for (const body of [
      'token String? @guarded',
      'token String  @guarded @default("x")',
    ]) expect(findings(`model Thing { id Int @id  ${body}  @@gate("2.4.4.5") }`, 'required-guarded-uncreatable')).toEqual([])

    expect(findings(`model Thing { id Int @id  token String @guarded  @@gate("8") }`,
      'required-guarded-uncreatable')).toEqual([])
  })
})

describe('required-system-unfilled', () => {
  test('fires on a required @system column', () => {
    const f = findings(`model Order { id Int @id  trackingCode String @system }`, 'required-system-unfilled')
    expect(f.length).toBe(1)
    expect(f[0].message).toContain("system: ['trackingCode']")
  })

  test('silent when it is optional or defaulted', () => {
    expect(findings(`model Order { id Int @id  t String? @system }`, 'required-system-unfilled')).toEqual([])
    expect(findings(`model Order { id Int @id  t String @system @default("") }`, 'required-system-unfilled')).toEqual([])
  })
})

describe('gate-over-own-standing', () => {
  // Only two shapes let litestone say the model IS the standing: @@auth, and —
  // under row tenancy — the model carrying the claim column that also declares
  // @@tenant(none), which is the membership row rather than a row inside a
  // tenant. Everything else is a name, and a name was wrong on basecamp: the
  // same `role` is a privilege ladder on WorkspaceMember and a machine's job on
  // Server, and calling both an error is how a rule set stops being read.
  test('is an error on the @@auth model', () => {
    const f = findings(`
      model User {
        id      Int     @id
        isAdmin Boolean @default(false)
        @@auth
        @@gate("4.4.4.5")
      }`, 'gate-over-own-standing')
    expect(f.length).toBe(1)
    expect(f[0].severity).toBe('error')
    expect(f[0].message).toContain('@@auth model')
  })

  test('is an error on the model the tenancy claim is read from', () => {
    const f = findings(`
      tenancy { strategy row  column workspaceId }
      model Workspace { id String @id  @@tenant(none) }
      model WorkspaceMember {
        id          String @id
        workspaceId String
        role        String @default("viewer")
        @@tenant(none)
        @@gate("1.5")
      }`, 'gate-over-own-standing')
    expect(f.length).toBe(1)
    expect(f[0].model).toBe('WorkspaceMember')
    expect(f[0].severity).toBe('error')
    expect(f[0].message).toContain('tenancy claim is read from')
  })

  test('a model merely SCOPED by the tenant is a warning, not an error', () => {
    const f = findings(`
      tenancy { strategy row  column workspaceId }
      model Workspace { id String @id  @@tenant(none) }
      model Server {
        id          String @id
        workspaceId String
        role        String @default("general")
        @@gate("2.4.4.5")
      }`, 'gate-over-own-standing')
    expect(f.length).toBe(1)
    expect(f[0].model).toBe('Server')
    expect(f[0].severity).toBe('warn')
    expect(f[0].message).toContain('question rather than a finding')
    expect(f[0].message).toContain('declare @@auth')
  })

  test('a row policy alone is not enough, and the message says which half is missing', () => {
    const f = findings(`
      model User {
        id      Int     @id
        isAdmin Boolean @default(false)
        @@auth
        @@gate("4.4.4.5")
        @@allow('update', id == auth().id)
      }`, 'gate-over-own-standing')
    expect(f.length).toBe(1)
    expect(f[0].message).toContain('WHICH columns')
  })

  test('silent once the column itself carries a write policy', () => {
    expect(findings(`
      model User {
        id      Int     @id
        isAdmin Boolean @default(false) @allow('write', auth().isAdmin)
        @@auth
        @@gate("4.4.4.5")
        @@allow('update', id == auth().id)
      }`, 'gate-over-own-standing')).toEqual([])
  })

  test('silent when the model is system-only for update', () => {
    expect(findings(`model User { id Int @id  isAdmin Boolean @default(false)  @@auth  @@gate("2.4.8.8") }`,
      'gate-over-own-standing')).toEqual([])
  })
})

describe('guarded-and-encrypted-is-secret', () => {
  test('fires on the pair written by hand', () => {
    const f = findings(`model K { id Int @id  key String @guarded @encrypted }`, 'guarded-and-encrypted-is-secret')
    expect(f.length).toBe(1)
    expect(f[0].severity).toBe('info')
  })

  test('silent on @secret itself, which expands into exactly that pair', () => {
    expect(findings(`model K { id Int @id  key String @secret }`, 'guarded-and-encrypted-is-secret')).toEqual([])
  })
})

describe('declared-and-unreferenced', () => {
  test('fires on an enum nothing uses', () => {
    const f = findings(`enum Plan { free pro }\nmodel M { id Int @id }`, 'declared-and-unreferenced')
    expect(f.map(x => x.model)).toEqual(['Plan'])
  })

  test('silent once a field names it, including a field inside a type', () => {
    expect(findings(`enum Plan { free pro }\nmodel M { id Int @id  plan Plan }`,
      'declared-and-unreferenced')).toEqual([])
    expect(findings(`enum Plan { free pro }\ntype Sub { plan Plan }\nmodel M { id Int @id  s Json @type(Sub) }`,
      'declared-and-unreferenced')).toEqual([])
  })

  test('an unreferenced TYPE is reported as a half-answer, because a service input is invisible here', () => {
    const f = findings(`type Payload { note String }\nmodel M { id Int @id }`, 'declared-and-unreferenced')
    expect(f.length).toBe(1)
    expect(f[0].external).toBe(true)
    expect(f[0].message).toContain('input:')
  })
})

describe('fts-over-a-column-search-cannot-read', () => {
  const ID = 'fts-over-a-column-search-cannot-read'

  test('an @encrypted column in @@fts is an error — the index holds ciphertext', () => {
    const f = findings(`
      model Doc {
        id    Int    @id
        title String
        body  String @encrypted
        @@fts([title, body])
      }`, ID)
    expect(f.map(x => [x.field, x.severity])).toEqual([['body', 'error']])
  })

  test('@hashed too, for the same reason in one direction', () => {
    const f = findings(`
      model Doc { id Int @id  title String  body String @hashed  @@fts([title, body]) }`, ID)
    expect(f.map(x => x.severity)).toEqual(['error'])
  })

  test('@guarded is the other half and grades lower — it matches and is then stripped', () => {
    const f = findings(`
      model Doc { id Int @id  title String  body String? @guarded  @@fts([title, body]) }`, ID)
    expect(f.map(x => x.severity)).toEqual(['warn'])
    expect(f[0].message).toContain('snippet')
  })

  test('@secret is both and answers with the half that makes search impossible', () => {
    const f = findings(`
      model Doc { id Int @id  title String  body String? @secret  @@fts([title, body]) }`, ID)
    expect(f.map(x => x.severity)).toEqual(['error'])
  })

  test('silent on an ordinary column', () => {
    expect(findings(`model Doc { id Int @id  title String  body String  @@fts([title, body]) }`, ID))
      .toEqual([])
  })
})

describe('foreign-key-without-index', () => {
  const ID  = 'foreign-key-without-index'
  const REL = `model User { id Int @id }\n`

  test('fires on a foreign key nothing indexes', () => {
    const f = findings(REL + `
      model Post {
        id       Int  @id
        authorId Int
        author   User @relation(fields: [authorId], references: [id])
      }`, ID)
    expect(f.map(x => `${x.model}.${x.field}`)).toEqual(['Post.authorId'])
  })

  test('silent where an index leads with it, or the column is @unique', () => {
    expect(findings(REL + `
      model Post { id Int @id  authorId Int  author User @relation(fields: [authorId], references: [id])
        @@index([authorId]) }`, ID)).toEqual([])
    expect(findings(REL + `
      model Post { id Int @id  authorId Int @unique  author User @relation(fields: [authorId], references: [id]) }`,
      ID)).toEqual([])
  })

  test('a composite that does not LEAD with it does not cover it', () => {
    // The half a naive check gets wrong, and the shape basecamp is full of:
    // @@unique([workspaceId, userId]) leaves userId unindexed, so "which
    // workspaces is this person in" scans the table.
    const f = findings(REL + `
      model Member {
        id          Int  @id
        workspaceId Int
        userId      Int
        user        User @relation(fields: [userId], references: [id])
        @@unique([workspaceId, userId])
      }`, ID)
    expect(f.map(x => x.field)).toEqual(['userId'])
  })
})

describe('transition-to-a-state-nothing-reaches', () => {
  const ID = 'transition-to-a-state-nothing-reaches'

  test('fires on an enum value no move ends at', () => {
    const f = findings(`
      enum S { draft paid shipped orphan }
      model Order {
        id     Int @id
        status S   @default(draft)
        @@transitions(status, draft -> paid, paid -> shipped)
      }`, ID)
    expect(f.map(x => x.message.match(/'(\w+)'/)![1])).toEqual(['orphan'])
  })

  test('the default is reached by being created, not by a move', () => {
    expect(findings(`
      enum S { draft paid }
      model Order { id Int @id  status S @default(draft)  @@transitions(status, draft -> paid) }`,
      ID)).toEqual([])
  })
})

describe('label-column-that-may-be-null', () => {
  test('fires on an optional @@label column', () => {
    const f = findings(`model Person { id Int @id  name String?  @@label(name) }`,
      'label-column-that-may-be-null')
    expect(f.map(x => x.field)).toEqual(['name'])
  })

  test('silent when the column is always there', () => {
    expect(findings(`model Person { id Int @id  name String  @@label(name) }`,
      'label-column-that-may-be-null')).toEqual([])
  })
})

describe('unique-on-an-optional-column', () => {
  test('fires, because SQLite counts NULLs as distinct', () => {
    const f = findings(`model U { id Int @id  externalId String? @unique }`, 'unique-on-an-optional-column')
    expect(f.map(x => x.field)).toEqual(['externalId'])
  })

  test('silent on a required unique column', () => {
    expect(findings(`model U { id Int @id  email String @unique }`, 'unique-on-an-optional-column'))
      .toEqual([])
  })
})

describe('index-another-index-already-covers', () => {
  const ID = 'index-another-index-already-covers'

  test('fires on an index duplicating what @unique already built', () => {
    expect(findings(`model U { id Int @id  email String @unique  @@index([email]) }`, ID).length).toBe(1)
  })

  test('fires on a prefix of a longer index', () => {
    const f = findings(`model U { id Int @id  a Int  b Int  @@index([a])  @@index([a, b]) }`, ID)
    expect(f.length).toBe(1)
    expect(f[0].message).toContain('prefix')
  })

  test('a @@softDelete model is exempt — there the two are not the same index', () => {
    // ddl.js appends WHERE deletedAt IS NULL to every @@index and to no UNIQUE,
    // so the short one is the smaller partial index over the rows an ordinary
    // read wants. Without this, the rule told basecamp to delete nine of those.
    expect(findings(`
      model U {
        id        Int @id
        a         Int
        b         Int
        deletedAt DateTime?
        @@index([a])
        @@unique([a, b])
        @@softDelete
      }`, ID)).toEqual([])
  })

  test('silent where neither is a prefix of the other', () => {
    expect(findings(`model U { id Int @id  a Int  b Int  @@index([a])  @@index([b, a]) }`, ID)).toEqual([])
  })
})

// ─── what the warning says about a lone @@deny ───────────────────────────────
//
// The parser warns about a model with a @@deny and no @@allow, and the warning
// used to say the deny "won't restrict access unless you add @@allow rules".
// That is false and it reads as *this declaration is inert*, which invites
// deleting a rule that is working. Driven here rather than asserted as a string,
// because the claim is about behavior.

describe('a @@deny with no @@allow', () => {
  test('restricts the operation it names', async () => {
    const { createClient } = await import('../src/index.js')
    const db = await createClient({
      schema: `model Doc { id Int @id  ownerId Int  title String  @@deny('update', ownerId == auth().id) }`,
      db: ':memory:',
    })
    await db.asSystem().doc.create({ data: { id: 1, ownerId: 7, title: 'orig' } })

    // The owner is denied; anyone else is not, because nothing else is declared.
    await db.$setAuth({ id: 7 }).doc.update({ where: { id: 1 }, data: { title: 'mine' } })
    expect((await db.asSystem().doc.findUnique({ where: { id: 1 } })).title).toBe('orig')

    await db.$setAuth({ id: 8 }).doc.update({ where: { id: 1 }, data: { title: 'theirs' } })
    expect((await db.asSystem().doc.findUnique({ where: { id: 1 } })).title).toBe('theirs')
    db.$close()
  })

  test('and says what is actually open, rather than that it does nothing', () => {
    const out = parse(`model Doc { id Int @id  ownerId Int  @@deny('update', ownerId == auth().id) }`)
    const w = out.warnings.find((x: string) => x.includes('@@deny and no @@allow'))
    expect(w).toBeTruthy()
    expect(w).toContain('restricts the operations it names')
    expect(w).not.toContain("won't restrict")
  })
})

describe('sync-reference-to-a-server-assigned-id', () => {
  const ID = 'sync-reference-to-a-server-assigned-id'

  const pair = (parentId: string, childSync = '@@sync(server)') => `
    model Session {
      ${parentId}
      lines  Line[]
      @@sync(server)
    }
    model Line {
      id        Int     @id
      sessionId String
      session   Session @relation(fields: [sessionId], references: [id])
      ${childSync}
    }`

  test('fires when both are syncable and the parent id is the server to assign', () => {
    const out = findings(pair('id String @id'), ID)
    expect(out.length).toBe(1)
    expect(out[0].model).toBe('Session')
    expect(out[0].field).toBe('id')
    expect(out[0].severity).toBe('warn')
    // The message has to name the column there is nothing to put in, or a
    // reader has the diagnosis and not the place.
    expect(out[0].message).toContain('sessionId')
  })

  test('every generated id default clears it', () => {
    for (const fn of ['uuid()', 'ulid()', 'cuid()', 'nanoid()'])
      expect(findings(pair(`id String @id @default(${fn})`), ID)).toEqual([])
  })

  test('a parent that is not syncable is silent — it cannot be made offline at all', () => {
    expect(findings(`
      model Session {
        id    String @id
        lines Line[]
      }
      model Line {
        id        Int     @id
        sessionId String
        session   Session @relation(fields: [sessionId], references: [id])
        @@sync(server)
      }`, ID)).toEqual([])
  })

  test('a syncable model with no child referencing it is silent', () => {
    expect(findings(`
      model Movement {
        id       Int @id
        quantity Int
        @@sync(server)
      }`, ID)).toEqual([])
  })

  test('the back-reference does not fire a second time', () => {
    // Session.lines is the same relation from the end that carries no foreign
    // key, so a walk that read both sides would report one problem twice.
    expect(findings(pair('id String @id'), ID).length).toBe(1)
  })
})

describe('the two rules a File on a syncable model earns', () => {
  const FILE_KEYLESS = 'sync-file-with-no-key-to-attach-to'
  const FILE_REQUIRED = 'sync-required-file'

  test('bytes with no key to attach to — the write is not held at all', () => {
    // The bytes replay as a patch NAMING the row, and offline there is no row
    // and no id. Nothing here is a syntax error and the model works perfectly
    // on a network, which is why it is a rule and not a refusal.
    const out = findings(`
      model Count { id Int @id  damage File?  @@sync(server) }`, FILE_KEYLESS)
    expect(out.length).toBe(1)
    expect(out[0].field).toBe('damage')
    expect(out[0].message).toContain('@default(uuid())')
  })

  test('a mintable key clears it', () => {
    expect(findings(`
      model Count { id String @id @default(uuid())  damage File?  @@sync(server) }`,
      FILE_KEYLESS)).toEqual([])
  })

  test('without @@sync it is silent — nothing is replayed', () => {
    expect(findings('model Count { id Int @id  damage File? }', FILE_KEYLESS)).toEqual([])
  })

  test('a required File cannot survive a replay', () => {
    // The row half goes without its bytes, so the create arrives with nothing
    // in the column — which is the whole reason the two halves are separable.
    const out = findings(`
      model Count { id String @id @default(uuid())  damage File  @@sync(server) }`, FILE_REQUIRED)
    expect(out.length).toBe(1)
    expect(out[0].field).toBe('damage')
  })

  test('optional is the spelling that works, and is silent', () => {
    expect(findings(`
      model Count { id String @id @default(uuid())  damage File?  @@sync(server) }`,
      FILE_REQUIRED)).toEqual([])
  })

  test('a required File on a model that is not syncable is nobody\'s business', () => {
    expect(findings('model Count { id Int @id  damage File }', FILE_REQUIRED)).toEqual([])
  })
})

describe('the rule set', () => {
  test('every rule has an id, a severity and a title', () => {
    for (const r of RULES) {
      expect(r.id).toMatch(/^[a-z0-9-]+$/)
      expect(['error', 'warn', 'info']).toContain(r.severity)
      expect(r.title.length).toBeGreaterThan(10)
    }
  })

  test('ids are unique', () => {
    expect(new Set(RULES.map(r => r.id)).size).toBe(RULES.length)
  })

  test('a clean schema trips nothing', () => {
    expect(findings(`
      enum Plan { free pro }
      model User {
        id      Int     @id
        plan    Plan    @default(free)
        isAdmin Boolean @default(false) @allow('write', auth().isAdmin)
        secret  String? @guarded
        @@gate("2.4.4.5")
        @@allow('update', id == auth().id || auth().isAdmin)
      }`)).toEqual([])
  })
})

// ─── a JSON path read into a column ───────────────────────────────────────────
//
// Three ways a path extraction is legal, builds, and answers nothing. All three
// were measured against SQLite before the rules were written: `->` stores the
// quoted form and an index over it is USED and still matches no row; a typo'd
// member is NULL for every row for the life of the table; and an index over the
// document itself cannot serve a path lookup at all.

const TYPED = `type Addr { city String  n Int }`

describe('a @generated column that reads a JSON path', () => {
  test('`->` is reported — it keeps the quotes, so nothing matches', () => {
    const f = findings(`${TYPED}
      model P {
        id   Int    @id
        addr Json   @type(Addr)
        city String @generated("addr -> '$.city'")
      }`, 'json-arrow-answers-json')
    expect(f).toHaveLength(1)
    expect(f[0].field).toBe('city')
    expect(f[0].message).toContain('->>')
  })

  test('`->>` and json_extract are both silent', () => {
    for (const expr of [`addr ->> '$.city'`, `addr ->> 'city'`, `json_extract(addr, '$.city')`])
      expect(findings(`${TYPED}
        model P {
          id   Int    @id
          addr Json   @type(Addr)
          city String @generated("${expr}")
        }`, 'json-arrow-answers-json')).toHaveLength(0)
  })

  test('a member the type does not declare is reported, and the real members are named', () => {
    const f = findings(`${TYPED}
      model P {
        id   Int    @id
        addr Json   @type(Addr)
        city String @generated("addr ->> 'citty'")
      }`, 'json-path-outside-the-declared-type')
    expect(f).toHaveLength(1)
    expect(f[0].message).toContain("no member 'citty'")
    expect(f[0].message).toContain('city, n')
  })

  test('a member declared Int, extracted into a String column, is a warning about ORDER', () => {
    const f = findings(`${TYPED}
      model P {
        id   Int    @id
        addr Json   @type(Addr)
        n    String @generated("addr ->> 'n'")
      }`, 'json-path-outside-the-declared-type')
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('warn')
    expect(f[0].message).toContain('10 before 9')
  })

  test('the matching declaration says nothing', () => {
    expect(findings(`${TYPED}
      model P {
        id   Int    @id
        addr Json   @type(Addr)
        city String @generated("addr ->> 'city'")
        n    Int    @generated("addr ->> 'n'")
      }`, 'json-path-outside-the-declared-type')).toHaveLength(0)
  })

  test('an untyped Json column is not graded — it declares no members to be wrong about', () => {
    expect(findings(`model P {
        id   Int    @id
        addr Json
        city String @generated("addr ->> 'anything'")
      }`, 'json-path-outside-the-declared-type')).toHaveLength(0)
  })

  test('a deeper path is not followed, and says nothing rather than guessing', () => {
    expect(findings(`${TYPED}
      model P {
        id   Int    @id
        addr Json   @type(Addr)
        deep String @generated("addr ->> '$.city.sub'")
      }`, 'json-path-outside-the-declared-type')).toHaveLength(0)
  })

  test('a TEMPLATE is a string being built, not a path being read', () => {
    const all = findings(`model P {
        id   Int    @id
        a    String?
        b    String?
        both String? @generated(\`{a} {b}\`)
      }`)
    expect(all.filter(x => x.id.startsWith('json-'))).toHaveLength(0)
  })
})

describe('an index over a Json column', () => {
  test('@@index over the document is reported', () => {
    const f = findings(`${TYPED}
      model P {
        id   Int  @id
        addr Json @type(Addr)
        @@index([addr])
      }`, 'index-over-a-json-document')
    expect(f).toHaveLength(1)
    expect(f[0].message).toContain('json_extract()')
  })

  test('@@unique over the document is reported as the constraint it is', () => {
    const f = findings(`${TYPED}
      model P {
        id   Int  @id
        addr Json @type(Addr)
        @@unique([addr])
      }`, 'index-over-a-json-document')
    expect(f).toHaveLength(1)
    expect(f[0].message).toContain('may be what was meant')
  })

  test('an index over the EXTRACTED column is the shape it is asking for, and is silent', () => {
    expect(findings(`${TYPED}
      model P {
        id   Int    @id
        addr Json   @type(Addr)
        city String @generated("addr ->> 'city'")
        @@index([city])
      }`, 'index-over-a-json-document')).toHaveLength(0)
  })
})
