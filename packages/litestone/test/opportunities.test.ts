// test/opportunities.test.ts
//
// The other half of the pair. `advise.js` answers *legal and wrong* and this
// answers *legal and missing*, so the assertion shapes differ in one way that
// matters: a rule's negative case is a schema that is CORRECT, and an
// opportunity's negative case is a schema that already took the suggestion.
//
// Both directions on every check, because a suggestion that fires on a schema
// which already declares the word is worse than no suggestion at all — it says
// the reader has not done a thing they have done, which is how a whole section
// gets collapsed and never opened again.
//
// Three of these were wrong the first time they met a real schema and the cases
// that fix them are marked. That is the method rather than an embarrassment:
// a check nobody has pointed at `example` and `basecamp` is a guess.

import { describe, test, expect } from 'bun:test'
import { parse } from '../src/core/parser.js'
import { OPPORTUNITIES, checkOpportunities, wordFor } from '../src/core/opportunities.js'
import { lookup } from '../src/core/catalog.js'

const found = (src: string, id?: string) => {
  const out = parse(src)
  expect(out.valid).toBe(true)          // legal is half the claim
  const all = checkOpportunities(out.schema)
  return id ? all.filter(f => f.id === id) : all
}

// ─── the routing contract ─────────────────────────────────────────────────────

describe('an opportunity is a route into the catalog', () => {
  test('every check names a word that resolves, prefix and all', () => {
    // As TYPED: `lookup` reads the prefix to pick the level, so `@type` lands on
    // the attribute and `type` on the declaration. Without the prefix the route
    // is right by luck.
    for (const o of OPPORTUNITIES)
      expect({ id: o.id, word: o.word, known: !!lookup(o.word) })
        .toEqual({ id: o.id, word: o.word, known: true })
    expect(lookup('@type')!.level).toBe('field')
    expect(lookup('trait')!.level).toBe('schema')
  })

  test('every FINDING names one too, including a check that answers two', () => {
    // `column-declared-and-inert` covers @@softDelete and @@hasTemplates, so
    // the word is on the finding rather than on the check. A finding pointing
    // at a word `explain` cannot look up is a dead end wearing a link.
    const all = found(`
      model A { id Int @id  deletedAt DateTime? }
      model B { id Int @id  isTemplate Boolean @default(false) }`)
    expect(all.map(f => f.word).sort()).toEqual(['@@hasTemplates', '@@softDelete'])
    for (const f of all) expect(wordFor(f)).toBeTruthy()
  })

  test('every check has an id, a confidence, a title and a blurb', () => {
    for (const o of OPPORTUNITIES) {
      expect(o.id).toMatch(/^[a-z0-9-]+$/)
      expect(['likely', 'possible']).toContain(o.confidence)
      expect(o.title.length).toBeGreaterThan(10)
      expect(o.blurb.length).toBeGreaterThan(60)
    }
    expect(new Set(OPPORTUNITIES.map(o => o.id)).size).toBe(OPPORTUNITIES.length)
  })
})

// ─── each check, both directions ──────────────────────────────────────────────

describe('credential-column-in-plain-text', () => {
  const ID = 'credential-column-in-plain-text'

  test('fires on an unprotected token column', () => {
    const f = found(`model Session { id Int @id  token String }`, ID)
    expect(f.map(x => [x.field, x.confidence])).toEqual([['token', 'likely']])
  })

  test('@guarded grades DOWN rather than clearing — it is an access lock, not at rest', () => {
    const f = found(`model Session { id Int @id  token String @guarded }`, ID)
    expect(f.map(x => x.confidence)).toEqual(['possible'])
    expect(f[0].message).toContain('plaintext at rest')
  })

  test('silent once the value is actually protected', () => {
    expect(found(`model U { id Int @id  password String @hashed }`, ID)).toEqual([])
    expect(found(`model U { id Int @id  apiKey String @encrypted }`, ID)).toEqual([])
    expect(found(`model U { id Int @id  token String @secret }`, ID)).toEqual([])
  })

  test('a value with no COLUMN cannot be at rest', () => {
    // basecamp's NotificationChannel.secret, which the first cut reported as a
    // plaintext credential: @transient means it is validated and then lifted
    // off the payload, so nothing below the API boundary ever sees it.
    expect(found(`model Channel { id Int @id  secret String? @transient }`, ID)).toEqual([])
  })
})

describe('column-declared-and-inert', () => {
  const ID = 'column-declared-and-inert'

  test('fires on deletedAt with no @@softDelete', () => {
    const f = found(`model A { id Int @id  deletedAt DateTime? }`, ID)
    expect(f.map(x => x.field)).toEqual(['deletedAt'])
  })

  test('and on isTemplate with no @@hasTemplates', () => {
    expect(found(`model A { id Int @id  isTemplate Boolean @default(false) }`, ID).length).toBe(1)
  })

  test('silent once the attribute is there', () => {
    expect(found(`model A { id Int @id  deletedAt DateTime?  @@softDelete }`, ID)).toEqual([])
  })
})

describe('model-outside-the-gate-ladder', () => {
  const ID = 'model-outside-the-gate-ladder'

  test('fires on the one model nobody graded', () => {
    const f = found(`
      model A { id Int @id  @@gate("4") }
      model B { id Int @id  @@gate("4") }
      model C { id Int @id }`, ID)
    expect(f.map(x => x.model)).toEqual(['C'])
  })

  test('silent on a schema that has not opted into gates at all', () => {
    // The half worth stating: no gates anywhere is a decision, and suggesting
    // one per model to an app that made it is the shape people mute.
    expect(found(`model A { id Int @id }\nmodel B { id Int @id }`, ID)).toEqual([])
  })

  test('silent when every model is graded', () => {
    expect(found(`model A { id Int @id  @@gate("4") }\nmodel B { id Int @id  @@gate("2") }`, ID))
      .toEqual([])
  })
})

describe('gate-with-nothing-saying-whose-row', () => {
  const ID = 'gate-with-nothing-saying-whose-row'
  const AUTH = `model User { id Int @id  @@auth }\n`

  test('raises to likely where the rows plainly belong to someone', () => {
    const f = found(AUTH + `
      model Post {
        id       Int  @id
        authorId Int
        author   User @relation(fields: [authorId], references: [id])
        @@gate("2.4.4.5")
      }`, ID)
    expect(f.map(x => [x.model, x.confidence])).toEqual([['Post', 'likely']])
  })

  test('asks rather than asserts where it cannot see an owner', () => {
    // `Product` in a shop schema: every caller reading every product is what a
    // catalogue IS, and the first cut called all five of example's models a
    // finding. Nothing in a schema distinguishes a catalogue from a possession.
    const f = found(`model Product { id Int @id  name String  @@gate("0.4.4.5") }`, ID)
    expect(f.map(x => x.confidence)).toEqual(['possible'])
    expect(f[0].message).toContain('catalogue')
  })

  test('the tenant column counts as an owner — on the model that spans tenants', () => {
    // Under `strategy row` an ordinary model is already scoped: tenancy
    // desugars into @@deny, which is a policy, so it never reaches this check.
    // The models that DO are the ones declaring @@tenant(none) while carrying
    // the claim — basecamp's WorkspaceMember and AuditEvent, which is where
    // both of that app's `likely` findings come from.
    const TENANCY = `
      tenancy {
        strategy row
        column   workspaceId
      }
    `
    expect(found(TENANCY + `
      model Doc { id Int @id  workspaceId String  @@gate("2.4.4.5") }`, ID)).toEqual([])

    const f = found(TENANCY + `
      model Membership {
        id          Int    @id
        workspaceId String
        @@tenant(none)
        @@gate("2.4.4.5")
      }`, ID)
    expect(f.map(x => x.confidence)).toEqual(['likely'])
  })

  test('silent with a policy, and on a model only asSystem() reaches', () => {
    expect(found(AUTH + `
      model Post { id Int @id  ownerId Int  @@gate("2.4.4.5")
        @@allow('read', ownerId == auth().id) }`, ID)).toEqual([])
    expect(found(`model Secret { id Int @id  @@gate("8") }`, ID)).toEqual([])
  })
})

describe('format-column-with-no-validator', () => {
  const ID = 'format-column-with-no-validator'

  test('fires on email, url and phone alike, naming the word for each', () => {
    const f = found(`model C { id Int @id  email String  website String  phone String }`, ID)
    expect(f.map(x => x.word).sort()).toEqual(['@email', '@phone', '@url'])
  })

  test('silent once the validator is there', () => {
    expect(found(`model C { id Int @id  email String @email }`, ID)).toEqual([])
  })
})

describe('enum-column-with-no-state-machine', () => {
  const ID = 'enum-column-with-no-state-machine'
  const EN = `enum S { draft paid }\n`

  test('fires on a lifecycle-named enum column', () => {
    expect(found(EN + `model O { id Int @id  status S @default(draft) }`, ID).map(x => x.field))
      .toEqual(['status'])
  })

  test('silent once @@transitions declares it, and on a non-enum column of that name', () => {
    expect(found(EN + `model O { id Int @id  status S @default(draft)
      @@transitions(status, draft -> paid) }`, ID)).toEqual([])
    expect(found(`model O { id Int @id  status String }`, ID)).toEqual([])
  })
})

describe('json-column-with-no-shape', () => {
  const ID = 'json-column-with-no-shape'

  test('fires on a bare Json column', () => {
    expect(found(`model A { id Int @id  meta Json }`, ID).map(x => x.field)).toEqual(['meta'])
  })

  test('silent once a type is bound', () => {
    expect(found(`type M { note String }\nmodel A { id Int @id  meta Json @type(M) }`, ID))
      .toEqual([])
  })
})

describe('field-group-repeated-across-models', () => {
  const ID = 'field-group-repeated-across-models'

  test('fires on two columns appearing together in three models', () => {
    const f = found(`
      model A { id Int @id  createdAt DateTime  updatedAt DateTime }
      model B { id Int @id  createdAt DateTime  updatedAt DateTime }
      model C { id Int @id  createdAt DateTime  updatedAt DateTime }`, ID)
    expect(f.length).toBe(1)
    expect(f[0].message).toContain('createdAt, updatedAt')
    expect(f[0].message).toContain('3 models')
  })

  test('one shared column is not a trait', () => {
    expect(found(`
      model A { id Int @id  createdAt DateTime }
      model B { id Int @id  createdAt DateTime }
      model C { id Int @id  createdAt DateTime }`, ID)).toEqual([])
  })

  test('a column is its name AND its type', () => {
    // A trait could not cover both, so they are not the same column.
    expect(found(`
      model A { id Int @id  ref String   note String }
      model B { id Int @id  ref String   note String }
      model C { id Int @id  ref Int      note String }`, ID)).toEqual([])
  })

  test('silent for a model that already uses a trait', () => {
    expect(found(`
      trait T { createdAt DateTime  updatedAt DateTime }
      model A { id Int @id  @@trait(T) }
      model B { id Int @id  @@trait(T) }
      model C { id Int @id  @@trait(T) }`, ID)).toEqual([])
  })
})

describe('text-model-with-no-search', () => {
  const ID = 'text-model-with-no-search'

  test('fires on two prose columns with no @@fts', () => {
    expect(found(`model P { id Int @id  name String  description String }`, ID).length).toBe(1)
  })

  test('one prose column is not a search index', () => {
    expect(found(`model P { id Int @id  name String }`, ID)).toEqual([])
  })

  test('a column search could never match does not count towards it', () => {
    // The same reasoning as advise's fts rule from the other side: an
    // @encrypted column in an index holds ciphertext.
    expect(found(`model P { id Int @id  name String  notes String @encrypted }`, ID)).toEqual([])
  })

  test('silent once @@fts is declared', () => {
    expect(found(`model P { id Int @id  name String  description String
      @@fts([name, description]) }`, ID)).toEqual([])
  })
})


describe('an-open-window-with-nothing-holding-it-open-once', () => {
  const ID = 'an-open-window-with-nothing-holding-it-open-once'
  const WIN = `model P { id Int @id  name String }
    model R {
      id            Int       @id
      planId        Int
      plan          P         @relation(fields: [planId], references: [id])
      effectiveFrom DateTime
      effectiveTo   DateTime?
    }`

  test('fires on a from/to pair with nothing holding one row open', () => {
    expect(found(WIN, ID).map(x => `${x.model}.${x.field}`)).toEqual(['R.effectiveTo'])
  })

  test('silent once the partial unique is declared', () => {
    expect(found(WIN.replace('effectiveTo   DateTime?',
      'effectiveTo   DateTime?\n@@unique([planId], where: effectiveTo == null)'), ID)).toEqual([])
  })

  // The stem is the vocabulary. `periodStart`/`periodEnd` on an invoice line is
  // a SERVICE PERIOD — two lines with a null end are ordinary — and a rule
  // reporting them fires on every billing schema. `example` has exactly that
  // pair and must stay silent.
  test('silent on a from/to pair that is not an effective-dating stem', () => {
    expect(found(`model P { id Int @id }
      model L { id Int @id  pId Int  p P @relation(fields: [pId], references: [id])
        periodStart DateTime  periodEnd DateTime? }`, ID)).toEqual([])
  })

  // A window is per PARENT. One timeline needs no constraint to hold one row
  // open, and reporting it would be advice with nothing to act on.
  test('silent where there is no parent to be open against', () => {
    expect(found(`model S { id Int @id  effectiveFrom DateTime  effectiveTo DateTime? }`, ID)).toEqual([])
  })

  // A required `to` is a closed period, not a window with a row in force.
  test('silent where the end is required', () => {
    expect(found(WIN.replace('effectiveTo   DateTime?', 'effectiveTo   DateTime'), ID)).toEqual([])
  })
})

describe('a-document-priced-through-a-relation', () => {
  const ID  = 'a-document-priced-through-a-relation'
  const CAT = `enum S { draft issued }\n model C { id Int @id  price Int @money(USD) }\n`
  const DOC = CAT + `model D {
      id     Int @id
      cId    Int
      c      C   @relation(fields: [cId], references: [id])
      status S   @default(draft)
      @@transitions(status, draft -> issued)
    }`

  test('fires where a document holds no amount of its own', () => {
    expect(found(DOC, ID).map(x => `${x.model}.${x.field}`)).toEqual(['D.c'])
  })

  test('silent once the document carries the amount', () => {
    expect(found(DOC.replace('status S   @default(draft)',
      'charged Int @money(USD) @immutable\n status S @default(draft)'), ID)).toEqual([])
  })

  // A basket line legitimately reads the live price. Nothing about it is meant
  // to stand, and it declares none of the words that say otherwise.
  test('silent on a row that is not document-shaped', () => {
    expect(found(CAT + `model Line { id Int @id  cId Int  c C @relation(fields: [cId], references: [id]) }`, ID))
      .toEqual([])
  })

  // The other direction is not a price lookup at all. Matching it reported
  // seven findings on `example`, every one of them backwards.
  test('silent on a hasMany, which reads nothing through anything', () => {
    expect(found(`enum S { draft issued }
      model D { id Int @id  status S @default(draft)  lines L[]  @@transitions(status, draft -> issued) }
      model L { id Int @id  dId Int  d D @relation(fields: [dId], references: [id])  amount Int @money(USD) }`, ID))
      .toEqual([])
  })

  // A price that cannot move cannot reprice anything — `example`'s Subscription
  // reads PlanVersion for exactly that reason.
  test('silent where the target is itself dated', () => {
    expect(found(`enum S { draft issued }
      model V { id Int @id  price Int @money(USD)  effectiveFrom DateTime  effectiveTo DateTime? }
      model D { id Int @id  vId Int  v V @relation(fields: [vId], references: [id])
        status S @default(draft)  @@transitions(status, draft -> issued) }`, ID)).toEqual([])
  })

  // A header whose LINES hold the amounts holds them, one level down.
  test('silent where a child carries the money', () => {
    expect(found(`enum S { draft issued }
      model C { id Int @id  price Int @money(USD) }
      model H { id Int @id  cId Int  c C @relation(fields: [cId], references: [id])
        status S @default(draft)  @@transitions(status, draft -> issued) }
      model HL { id Int @id  hId Int  h H @relation(fields: [hId], references: [id])  amount Int @money(USD) }`, ID))
      .toEqual([])
  })
})

describe('a-standing-spelled-on-the-global-row', () => {
  const ID  = 'a-standing-spelled-on-the-global-row'
  const TEN = `tenancy { strategy row  column workspaceId }\n`

  test('likely where the membership row spells the same standing', () => {
    const out = found(TEN + `
      model User { id Int @id  role String  @@auth  @@tenant(none) }
      model Member { id Int @id  workspaceId Int  uId Int  u User @relation(fields: [uId], references: [id])
        role String }
      model Workspace { id Int @id  workspaceId Int }`, ID)
    expect(out.map(x => [x.field, x.confidence])).toEqual([['role', 'likely']])
  })

  test('possible where no membership row carries it', () => {
    const out = found(TEN + `
      model User { id Int @id  isAdmin Boolean @default(false)  @@auth  @@tenant(none) }
      model Thing { id Int @id  workspaceId Int }`, ID)
    expect(out.map(x => [x.field, x.confidence])).toEqual([['isAdmin', 'possible']])
  })

  // The lifecycle stages the framework reads are per PERSON by construction.
  // A rule reporting them fires on every app, `example` and `basecamp` included.
  test('silent on the lifecycle columns and on an ordinary one', () => {
    expect(found(TEN + `
      model User { id Int @id  emailVerified Boolean @default(false)  name String  @@auth  @@tenant(none) }
      model Thing { id Int @id  workspaceId Int }`, ID)).toEqual([])
  })

  // Under `strategy database` a person is inside one tenant already, so the
  // column means one thing where it is read.
  test('silent outside row tenancy', () => {
    expect(found(`model User { id Int @id  role String  @@auth }`, ID)).toEqual([])
  })
})

// ─── the set as a whole ───────────────────────────────────────────────────────

describe('a schema that took every suggestion', () => {
  test('trips nothing', () => {
    expect(found(`
      enum S { draft paid }
      type Meta { note String }
      model User {
        id       Int     @id
        email    String  @email
        password String  @hashed
        @@auth
        @@gate("2.4.4.5")
        @@allow('update', id == auth().id)
      }
      model Order {
        id        Int      @id
        ownerId   Int
        owner     User     @relation(fields: [ownerId], references: [id])
        status    S        @default(draft)
        meta      Json     @type(Meta)
        deletedAt DateTime?
        @@softDelete
        @@transitions(status, draft -> paid)
        @@gate("2.4.4.5")
        @@allow('read', ownerId == auth().id)
      }`)).toEqual([])
  })
})
