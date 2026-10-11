# Testing

Litestone ships a `/testing` subpath with everything needed for fast, deterministic test suites: in-memory clients, factories, seeders, and schema-derived test case generators.

Every example on this page runs against one schema, which is the `./schema.lite`
a block opens. `Lead` is gated and carries a `@guarded` column, `Note` has a row
policy, `Order` a state machine, `Node` a required self-reference, and `Message`
two relations to one parent — each is the shape a section below exists for.

```lite
model Account {
  id    Int    @id
  name  String
  users User[]
  leads Lead[]
}

model User {
  id        Int       @id
  email     String    @unique @email
  role      String    @default("member")
  accountId Int?
  account   Account?  @relation(fields: [accountId], references: [id])
  posts     Post[]
  notes     Note[]
  sent      Message[] @relation("sent")
  received  Message[] @relation("received")
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  @@auth
}

model Post {
  id       Int    @id
  title    String @length(3, 80)
  authorId Int
  author   User   @relation(fields: [authorId], references: [id])
  tags     Tag[]
}

model Tag {
  id    Int    @id
  name  String @unique
  posts Post[]
}

model Message {
  id         Int    @id
  body       String
  senderId   Int
  receiverId Int
  sender     User   @relation("sent", fields: [senderId], references: [id])
  receiver   User   @relation("received", fields: [receiverId], references: [id])
}

model Lead {
  id        Int     @id
  email     String  @email
  token     String? @guarded
  accountId Int
  account   Account @relation(fields: [accountId], references: [id])

  @@gate("4.4.4.5")
}

enum OrderStatus { draft paid shipped }

model Order {
  id     Int         @id
  status OrderStatus @default(draft)

  @@transitions(status, pay: draft -> paid, ship: paid -> shipped)
}

model Note {
  id        Int       @id
  body      String
  ownerId   Int
  owner     User      @relation(fields: [ownerId], references: [id])
  createdAt DateTime  @default(now())
  deletedAt DateTime?

  @@softDelete
  @@allow('read', ownerId == auth().id)
}

model Node {
  id       Int    @id
  name     String
  parentId Int
  parent   Node   @relation(fields: [parentId], references: [id])
  children Node[]
}

model Country {
  id   Int    @id
  code String @unique
  name String
}
```

## At a glance

```js
import { createTestEnv, makeTestClient, defineFactory, truncate, reset,
         snapshot, restore, generateGateMatrix, generateValidationCases,
         deriveAccess, factoryFrom, mutationScore } from '@frontierjs/litestone/testing'
import { GatePlugin } from '@frontierjs/litestone'
import { expect } from 'bun:test'
import { readFileSync } from 'node:fs'

const schemaText = readFileSync('./schema.lite', 'utf8')
const getLevel   = (user) => user?.level ?? 0        // the app's own resolver

// The environment: migrated database, client, principal, and a factory per
// model. Tables arrive as a file copy from a template migrated once per schema
// per process — 476ms → 13ms per database on a 37-model schema.
// `migrations: 'db/migrations'` replays the committed files instead of
// generating DDL, so the tests run against the database a deploy produces.
const env = await createTestEnv({
  schema:        './schema.lite',
  autoFactories: true,
  plugins:       [new GatePlugin({ getLevel })],
})

const developer = { id: 1, level: 5 }
env.actingAs(developer)             // the app's own getLevel — anything about behavior
await env.atLevel(4)                // a SYNTHETIC standing — the gate grid only
expect(await env.verifyGateLadder()).toEqual([])      // every gated model × every level × all four ops
expect(await env.verifyReadLadder()).toEqual([])      // the read column alone — no fixtures needed
expect(await env.verifyConstraints()).toEqual([])     // every declared rule, against a real write
expect(await env.verifyFieldProtection()).toEqual([]) // @guarded/@encrypted/@secret, actually read
expect(await env.verifyRowPolicies({ principal: { id: 42 } })).toEqual([])  // @@allow/@@deny, rows on BOTH sides
await env.verifyTenantIsolation()   // tenancy { }, actually crossed — one tenant reaching into another

// Arrange / Act / Assert as three clients rather than three comments. `setup` is
// the arrange every scenario shares — run once, restored by each phases() call.
const fx = await env.setup(({ factories }) => factories.account.createOne())
const t  = env.phases({ as: developer })
const lead = await t.arrange(({ factories }) => factories.lead.createOne({ accountId: fx.id }))
await t.act(as => as.lead.remove({ where: { id: lead.id } }))
await t.assert(read => expect(read.lead.count()).resolves.toBe(0))

// Mutate the schema, run the ORIGINAL's checks against the mutant's database.
// A mutant nothing notices is a hole in the SUITE, and it names itself.
const { score, survived } = await mutationScore({
  schema: schemaText, build: (text) => createTestEnv({ schema: text }),
})
env.seal()
env.reset()
env.close()

const UserFactory = defineFactory({ model: 'User', definition: (seq) => ({ email: `u${seq}@x.co` }) })
const { db, factories } = await makeTestClient(schemaText, {
  seed:          42,           // deterministic RNG seed
  autoFactories: true,         // auto-generate factories for all SQLite models
  factories:     { user: UserFactory },
  data:          async (db) => { await db.country.create({ data: { code: 'FR', name: 'France' } }) },
})
// Always a throwaway tmpdir — a `database` block in the schema is overridden, so a
// test pointed at a real app schema can never open the app's real database.

// Helpers
await truncate(db, 'User')     // DELETE FROM "user"
await reset(db)                // truncate all tables in dependency order

// Seed once, reset between tests — raw rows, so @encrypted keeps its ciphertext
const clean = snapshot(db)
restore(db, clean)

// Test generation — the second argument is the MODEL name, never the accessor
const schema  = db.$schema
const matrix  = generateGateMatrix(schema, 'Lead')        // every op × every level 0–8
const edges   = generateGateMatrix(schema, 'Lead', { levels: 'edges' })  // 2 per op
const cases   = generateValidationCases(schema, 'Lead')   // valid + invalid + boundary + uncheckable
const factory = factoryFrom(schema, 'User', db)

// The declared access surface — gates, policies, protected fields, and per move
// its gate AND its @system, which are two facts that compose rather than one
// grade. `litestone access` renders it to the committed access.snapshot.md.
const access  = deriveAccess(schema)
```

## createTestEnv

A migrated database, a client, a principal and — with `autoFactories: true` —
a factory per model, in one call.

```js
import { createTestEnv } from '@frontierjs/litestone/testing'
import { GatePlugin } from '@frontierjs/litestone'
import { expect } from 'bun:test'

const myAppsResolver = (user) => user?.level ?? 0
const env = await createTestEnv({
  schema:        './schema.lite',     // the text, or a path to it
  autoFactories: true,
  plugins:       [new GatePlugin({ getLevel: myAppsResolver })],
})

const viewer = { id: 2, level: 1 }
const lead = await env.factories.lead.asSystem().withParents().createOne()   // arrange, below the boundary
await expect(env.actingAs(viewer).lead.remove({ where: { id: lead.id } })).rejects.toThrow()
env.close()
```

**The tables arrive as a file copy.** The DDL is applied once per schema per
process into a template, and every env after the first is `copyFileSync`. On
basecamp's 37-model schema that is 476ms → 13ms per database. Migration cost is
what dominates a test suite; in SQLite, a database per test is a file copy.

**`env.factories` are bound to the unscoped client**, so on a gated model they
grade as STRANGER like any other unauthenticated call. `.asSystem()` on a factory
is what seeds past the gate — see [Seeding past gates](#seeding-past-gates) —
and the factories `setup` and `phases().arrange` hand out are already bound to
`env.system`. Without `autoFactories: true` the map is empty; `env.system` is the
client to arrange with by hand.

### migrations — test the database a deploy produces

```js fragment
const env = await createTestEnv({ schema: 'db/schema.lite', migrations: 'db/migrations' })
```

Builds the template by replaying the committed migration files instead of
generating DDL from the schema. Takes a directory, a `.sql` path, or an array of
either; a directory contributes every `.sql` it holds, **sorted by filename**.

Worth reaching for whenever the migrations are the thing you ship. Without it a
suite proves the schema works, and says nothing about whether the migration that
builds production agrees with it — which is a question with an answer:

```js fragment
const fromMigrations = await createTestEnv({ schema, migrations: 'db/migrations' })
const fromSchema     = await createTestEnv({ schema })
// introspect both and compare — basecamp does exactly this
```

A directory here is read more loosely than `litestone migrate apply` reads one:
every `.sql` counts, not only litestone's generated `<14-digit>_<label>.sql`. A
hand-written `001_initial.sql` is a real migration someone means to replay, and a
template that skipped it would produce an empty database and a wall of *no such
table*. A `.js` migration is **refused by name** rather than skipped — it is
handed a client, and a template is built on a raw connection.

### The two auth doors are separate

| | Grades through | Use it for |
| --- | --- | --- |
| `env.actingAs(user)` | the app's own `getLevel` | anything about behavior |
| `env.atLevel(n)` | a synthetic resolver | walking the gate grid |

**Conflating them is the failure this exists to prevent.** A matrix driven by
`atLevel` passes in full while the app's resolver is broken, because the resolver
was never called. `atLevel` builds a second client — a level is fixed when a
client is constructed, so it cannot be a property of a call — dropping any
`GatePlugin` you installed and keeping every other plugin. `atLevel(8)` is
`asSystem()`, because `getLevel` is clamped to 0–7 and SYSTEM is not reachable
through it.

### verifyReadLadder

```js
import { createTestEnv } from '@frontierjs/litestone/testing'
import { expect } from 'bun:test'

const env = await createTestEnv({ schema: './schema.lite' })
expect(await env.verifyReadLadder()).toEqual([])
```

Executes the read column of every gated model at every level against a real
client — 333 assertions on basecamp, **with no fixtures**, because a read either
refuses or answers. It is `verifyGateLadder({ ops: ['read'] })`, kept as its own
name because it is the cheap half and the position where being wrong is a
disclosure rather than a failed write.

Each returned row is already a sentence:

```
Server.read at level 1 (VISITOR) — the schema says deny, the client says allow
```

**A read that throws something that is not a refusal is a mismatch**, not a
`deny`. Counting every throw as a refusal is a false green: an `@@external`
model emits no DDL, so its reads fail with *no such table* at every level, and
the ladder would have called that a pass everywhere the gate refuses.

**What it does and does not prove.** It grades the *enforcement path* against the
*declared gate* — a regression in the plugin, a model whose read is not graded at
all, a plugin swallowing the refusal. It says nothing about the app's own
`getLevel` (that is `actingAs`) and nothing about `@@allow`, which filters rows
rather than refusing, so a policy matching nothing still reads as `allow`.

### phases — Arrange / Act / Assert, scoped rather than commented

```js
import { createTestEnv } from '@frontierjs/litestone/testing'
import { GatePlugin } from '@frontierjs/litestone'
import { expect } from 'bun:test'

const env = await createTestEnv({
  schema:        './schema.lite',
  autoFactories: true,
  plugins:       [new GatePlugin({ getLevel: (user) => user?.level ?? 0 })],
})
const developer = { id: 1, level: 5 }

const t = env.phases({ as: developer })

const lead = await t.arrange(({ factories }) => factories.lead.withParents().createOne())
await t.act(as => as.lead.remove({ where: { id: lead.id } }))
await t.assert(read => expect(read.lead.count()).resolves.toBe(0))
```

The body stays linear — nothing threaded through return values, and a line can
still be commented out to bisect. What the phases buy is not tidiness:

| Phase | Reaches | Why |
| --- | --- | --- |
| `arrange` | `system`, `factories` and `db` | fixtures are set up below the boundary through `system`, so a gate that refuses the principal does not refuse the setup. The factories are bound to `system` too: a fixture a gate grades is graded at level 0, which grades nobody |
| `act` | the **principal's** client | graded by the app's own `getLevel`. **One per scenario** |
| `assert` | the principal's **read-only** client | graded, so *the row exists* cannot stand in for *this user can see it*; read-only, so retrying the scenario is sound |

`arrange` after `act` is refused, because setup after the act is part of the act
— and the two being separable is what lets `arrange` be hoisted and cached.

Not tied to a runner: call it inside whatever `test()` the package uses.

### verifyGateLadder

```js
import { createTestEnv } from '@frontierjs/litestone/testing'
import { expect } from 'bun:test'

const env = await createTestEnv({ schema: './schema.lite' })
expect(await env.verifyGateLadder()).toEqual([])      // all four operations
await env.verifyGateLadder({ ops: ['read'] })          // == verifyReadLadder()
```

Every gated model's ladder, executed: each declared level against a real client,
for read, create, update and delete. Fixtures are built as SYSTEM, so a gate
refusing the principal cannot refuse the setup.

| `got` | Means |
| --- | --- |
| `allow` / `deny` | the client's verdict, compared against the schema's |
| `error` | the call threw something that is not a refusal — nothing was proven |
| `skipped` | a row policy covers this operation, so the gate cannot be isolated |

**`skipped` is one-directional.** A policy *filters*, so it can turn an allow into
a deny and never the reverse — an `allow` where the schema said `deny` is the gate
letting something through and no policy explains it. Skipping both directions
stops a lowered gate on a policied model being graded at all.

### verifyFieldProtection

```js
import { createTestEnv } from '@frontierjs/litestone/testing'
import { expect } from 'bun:test'

const env = await createTestEnv({ schema: './schema.lite' })
expect(await env.verifyFieldProtection()).toEqual([])
```

Every `@guarded` / `@encrypted` / `@secret` field, actually read. The gate ladder
says who may read the **row**; this says which **columns** come back when they do.
They are separate boundaries and a model can pass one while failing the other —
basecamp's `Secret.data` is `@guarded` under a gate that admits ADMINISTRATOR(5),
so the field policy is the only thing between an admin and a private key.

Asserts **absence**, not nullity: `@guarded` removes the key, and a `null` would
be a value the caller could still act on. It also asserts the column comes back
to `asSystem()`, because one absent for everyone is broken rather than protected.

### verifyConstraints

```js
import { createTestEnv } from '@frontierjs/litestone/testing'
import { expect } from 'bun:test'

const env = await createTestEnv({ schema: './schema.lite' })
expect(await env.verifyConstraints()).toEqual([])   // rows are already sentences
await env.verifyConstraints('Lead')                 // one model
```

`generateValidationCases` describes what a schema declares; this executes it. The
oracle is **structural, not textual** — the schema declares a rule, so a value
violating it must be refused, and the message is not asserted. A rule that
reaches the browser through `x-messages` and is ignored by the server is the
failure it exists to find.

Runs as SYSTEM: the question is enforcement, and a `@@gate` refusing the write
first would answer *rejected* for every case including the ones nothing
validates. Rolls its rows back, so it is safe to call mid-suite. Models nothing
can write to — `@@external`, `jsonl`, `trail` — are skipped.

**Three outcomes.** A write that fails for an unrelated reason is `error`, never
`rejected`; calling it a refusal makes a broken validator look enforced. It is
reported rather than swallowed, because a case that could not run is a hole in
the coverage the count implies.

| `got` | Means |
| --- | --- |
| `rejected` | a `ValidationError` — the rule fired |
| `accepted` | the write succeeded. If the case was `invalid`, the rule is not enforced |
| `error` | the write failed before validation could refuse it — this case proves nothing |
| `rejected-by-another-rule` | refused, but by a different rule on the same field, so the case proves nothing about the one it names |
| `uncheckable` | no value could isolate the rule, so it was not asked — reported rather than dropped |

### setup — the arrange every scenario shares

```js
import { createTestEnv } from '@frontierjs/litestone/testing'
import { GatePlugin } from '@frontierjs/litestone'

const env = await createTestEnv({
  schema:        './schema.lite',
  autoFactories: true,
  plugins:       [new GatePlugin({ getLevel: (user) => user?.level ?? 0 })],
})
const developer = { id: 1, level: 5 }

const fx = await env.setup(({ factories }) => factories.account.createOne())

// inside each test():
const t = env.phases({ as: developer })     // rows are back at fx
const lead = await t.arrange(({ factories }) => factories.lead.createOne({ accountId: fx.id }))
```

`setup` takes the **same tools** `arrange` takes — `{ system, factories, db }` —
so hoisting a line out of a test is a move rather than a rewrite. It runs once;
its rows are snapshotted, and every later `phases()` call restores them.

That restore is a truncate + bulk re-insert of the exact rows, which beats
re-running factories through validation, hooks, gates and FTS. Once
template-clone has removed the migration cost, the fixture is what dominates a
suite's runtime, and this is the part that stops paying it per test.

The value `setup` returns **stays valid across restores**: rows go back with the
ids they had, so a captured `fx.id` still names that row.

Two refusals, both the same failure — a baseline that does not describe what the
tests around it started from, which is order-dependent and therefore silent:

- a **second** `setup` would replace the first one's baseline
- a `setup` declared **after a scenario has run** never applied to it

`seal`/`reset` stay independent. A suite driving them by hand keeps its own
snapshot; `phases()` restores `setup`'s baseline and nothing else.

### readOnly

```js
import { readOnly } from '@frontierjs/litestone/testing'
const read = readOnly(db)
```

Read methods are an **allow-list**, so a write method added to litestone later
cannot pass through unnoticed. The doors back out to a writable client are
refused by name — `asSystem`, `$setAuth`, `sql`, `$rawDbs`, `$transaction` —
since each of them hands back something that can write. A typo still raises the
client's own *not a table in this schema* error, which is better than anything
this could say.

### seal / reset

```js
import { createTestEnv } from '@frontierjs/litestone/testing'

const env = await createTestEnv({ schema: './schema.lite' })
await env.system.country.create({ data: { code: 'FR', name: 'France' } })   // seed the world, once
env.seal()
env.reset()                                 // beforeEach(() => env.reset())
```

### sampleWrites — a row and its payloads, per model

```js
import { createTestEnv, sampleWrites } from '@frontierjs/litestone/testing'

const env = await createTestEnv({ schema: './schema.lite' })
const s = await sampleWrites(env.schema, env.system)
s.Lead    // → { idField: 'id', row: {…}, create: {…}, patch: {…} }
```

One seeded row per model, plus the payloads a create and a patch would carry —
every required FK pointed at a parent the same call made. `{ models: [...] }`
narrows it.

The create payload has no server-owned columns in it. Over the wire those are
`readOnly` in the model's JSON Schema, so sending one is a 400 about the fixture
rather than an answer about whatever was under test.

**A model that cannot be seeded comes back as `{ error }` rather than missing.**
An absent key reads as *this model has nothing to test*, which is how a derived
suite silently stops covering the model whose fixture broke.

This exists so something above the Data boundary can derive a call list: mapping
a model onto the service that exposes it is an API-realm fact, and litestone
cannot see it. `@frontierjs/testing`'s `verifyTransportParity()` is the first
consumer.

## The clock — `env.clock`

Time is injectable, and the reason to inject it is not to stop it: it is to
**cross** something. A window that opens, a schedule at a boundary, a row aging
past a retention — every one of those is two assertions with a move between
them, and a frozen instant can only ever make one of them.

```js
import { createTestEnv } from '@frontierjs/litestone/testing'
import { expect } from 'bun:test'

const env = await createTestEnv({ schema: './schema.lite', now: '2026-06-01T00:00:00Z' })

const user = await env.system.user.create({ data: { email: 'a@x.co' } })
expect(user.createdAt).toBe('2026-06-01T00:00:00.000Z')        // stamped by the frozen clock
env.clock.advance('20d')
const moved = await env.system.user.update({ where: { id: user.id }, data: { role: 'admin' } })
expect(moved.updatedAt).toBe('2026-06-21T00:00:00.000Z')       // and the crossing is visible
env.clock.set('2026-09-15T00:00:00Z')
expect(env.clock.now().toISOString()).toBe('2026-09-15T00:00:00.000Z')
```

`now` takes a `Date`, an ISO string, or a function. `env.clock` is the holder
every client this env opened reads through — **including the ones `atLevel`
builds**, which are lazy, so one constructed mid-suite follows a later move
rather than freezing at whatever the clock said when it was made.

| | |
| --- | --- |
| `clock.now()` | the instant every client reads |
| `clock.set(at)` | freeze at, or move to, an instant |
| `clock.advance(by)` | `'90m'`, `'2d'`, `'1y'`, or milliseconds |
| `clock.frozen` | is time standing still? |

**A function stays yours.** Pass one and `set`/`advance` refuse by name: two
things claiming to say what time it is means the loser is whichever one the
reader did not have in mind. Move your own holder instead.

**`advance` from the wall clock also freezes**, because an offset from a moving
clock is still moving and the assertion after it would be a race.

### What it moves

Everything this client writes or grades against: `now()` in a row policy,
`@@softDelete`'s stamp, `@default(now())`, `@updatedAt` on create and on update,
and the retention cutoff. So the crossing this exists for is one call:

```js
import { createTestEnv } from '@frontierjs/litestone/testing'

const env = await createTestEnv({ schema: './schema.lite', now: '2020-01-01T00:00:00Z' })
await env.db.user.create({ data: { email: 'old@x.co' } })   // stamped 2020
env.clock.advance('100d')
await env.db.asSystem().$retain()                           // and now it is old enough to go
```

Until `FJS-531` those stamps were SQLite's own clock — a column DEFAULT and an
AFTER UPDATE trigger — so a frozen clock produced a row dated today and every
window over it was quietly wrong. Stating the timestamp on the write is still
supported and still wins, because key PRESENCE decides:

```js
import { createTestEnv } from '@frontierjs/litestone/testing'

const env = await createTestEnv({ schema: './schema.lite', now: '2020-01-01T00:00:00Z' })
await env.db.user.create({ data: { email: 'older@x.co', createdAt: '2019-05-06T07:08:09.000Z' } })
```

### What it does not move

**SQL that runs without this client.** A raw `db.sql` statement takes whatever
SQLite's clock says, and a `@derived` expression reading `now()` is compiled once
at startup into a subquery with no parameter to bind. Both are reads of the
database's own clock rather than of yours.

## makeTestClient

The primary entry point for tests. Creates an in-memory Litestone client:

```js
import { makeTestClient, defineFactory } from '@frontierjs/litestone/testing'

const MyUserFactory = defineFactory({ model: 'User', definition: (seq) => ({ email: `u${seq}@x.co` }) })

const { db, factories } = await makeTestClient(`
  model Account {
    id    Int    @id
    name  String
    users User[]
  }
  model User {
    id        Int      @id
    email     String   @unique
    role      String   @default("member")
    accountId Int?
    account   Account? @relation(fields: [accountId], references: [id])
  }
`, {
  seed:          42,           // deterministic RNG — same seed = same data every run
  autoFactories: true,         // auto-generate factories for all SQLite models
  factories: { user: MyUserFactory },   // explicit factories override auto-generated
  data: async (db) => {       // seed function — runs after tables created
    await db.account.create({ data: { id: 1, name: 'Test Co' } })
  },
})
```

`makeTestClient` always writes to a throwaway tmpdir — nothing in your project is
touched, no cleanup needed. **This holds even when the schema declares its own
`database` blocks.** A `database` block normally wins over the `db:` option, so
without that override a test using your app's real `schema.lite` would open your
app's real database and write test rows into it; every declared path is redirected
into the tmpdir instead, one file per declared database.

## Factory

```js
import { Factory } from '@frontierjs/litestone/testing'

class UserFactory extends Factory {
  model = 'User'

  traits = {
    admin:  { role: 'admin' },
    viewer: { role: 'viewer' },
  }

  definition(seq, rng) {
    return {
      email: `user${seq}@test.com`,
      role:  rng ? rng.pick(['admin', 'member', 'viewer']) : 'member',   // rng is null until seed(n)
    }
  }
}

// Usage
const users   = new UserFactory(db)
const user    = await users.createOne()
const admin   = await users.admin().createOne()
const five    = await users.createMany(5)
const seeded  = users.seed(42).buildMany(10)   // deterministic, no DB write

// State override
const custom  = await users.state({ role: 'admin', email: 'custom@test.com' }).createOne()
```

`model` is the model name as the schema declares it — **PascalCase singular**
(`'User'`, not `'users'`); the accessor is derived from it. Factory names in the
`factories` map follow the accessor (`db.user` → `factories.user`). The `rng` a
definition receives is `null` until the factory is seeded — `seed(n)`, or the
`seed` option of `makeTestClient` — so a definition that draws from it says what
the unseeded value is.

### create() / build() — count or overrides

`create()` and `build()` overload on their FIRST argument: a **number** is a count,
anything else is overrides.

```js
import { makeTestClient } from '@frontierjs/litestone/testing'
import { readFileSync } from 'node:fs'

const { factories } = await makeTestClient(readFileSync('./schema.lite', 'utf8'), { autoFactories: true })
const users = factories.user

await users.create()                      // → 1 row   (= createOne)
await users.create({ role: 'admin' })     // → 1 row with overrides
await users.create(5)                     // → 5 rows  (= createMany)
await users.create(5, { role: 'admin' })  // → 5 rows with overrides

users.build({ role: 'admin' })            // same rules, no DB write
users.build(5)
```

`createOne` / `createMany` / `buildOne` / `buildMany` are the unambiguous forms and
are what the examples here use. Every chain method (`state`, `seed`, `withRelation`,
`withParents`, `has`, `attach`, `for`, `usingDb`, traits) returns a **clone** —
`f.seed(42)` does not mutate `f`.

### A state further along a state machine

A row under `@@transitions` starts at its column's `@default`, whoever creates it
(`FJS-D470`). A factory asked for another state — by its definition, a `state()`
or an override — creates the row at the entry and makes the declared moves that
reach it: the fewest, the first declared on a tie, never a `@gate(9)` move.

```js
import { createTestEnv } from '@frontierjs/litestone/testing'

const env = await createTestEnv({ schema: './schema.lite', autoFactories: true })
const orders = env.factories.order

await orders.asSystem().create({ status: 'shipped' })   // create, then pay, then ship
```

The moves are ordinary ones on the factory's client, so they are graded (a gated
move needs `asSystem()` or a caller at the level), announced and audited — a seed that runs through an app with listeners sends
whatever those moves send, where a create at the state announced nothing. A state
no declared move reaches is refused by name before anything is written; put such a
row there with `db.asSystem().sql`. `build()` writes nothing and keeps the state.

## Relations

A model is rarely creatable on its own. Four chain methods cover the shapes a
schema can declare, and they compose.

### withParents() — every required parent, recursively

```js
import { createTestEnv } from '@frontierjs/litestone/testing'

const env = await createTestEnv({ schema: './schema.lite', autoFactories: true })
const { factories } = env

// Lead → Account, in one call; a deeper chain is the same call
const lead = await factories.lead.asSystem().withParents().createOne()
```

Reads the schema and auto-creates a parent for every **required** belongsTo, then
does the same for that parent, down the chain. Relation cycles (self-references,
`A → B → A`) are refused by name rather than followed — no number of rows satisfies
them, and the error states both cures.

A nullable key the schema still insists on gets a parent too: the first column of
an `@@arc([a, b])` (the other stays null, so exactly one is set), a key under
`@required(where:)`, and the first key of a `@@check("a IS NOT NULL OR b IS NOT
NULL")` whose every branch names a key. A branch on a scalar is filled instead, and
no parent is built. `verifyGateLadder`'s create row reads the same set. A composite relation — `@relation(fields: [projectId, teamId],
references: [id, teamId])` — fills every column of its key from the one parent, and
a single-column relation over one of those columns (`team` beside `project`) is not
wired separately, because it would point the column at a second, unrelated row.

```js
import { createTestEnv } from '@frontierjs/litestone/testing'

const env = await createTestEnv({ schema: './schema.lite', autoFactories: true })
const { factories } = env

const posts = factories.post
await posts.withParents({ optional: true }).createOne()   // nullable relations get parents too (default: skipped)
await posts.withParents({ fresh: true }).createMany(2)    // a new parent per row instead of one shared
await posts.withParents({ depth: 3 }).createOne()         // backstop; cycles are what actually terminate it
const author = await factories.user.createOne()
await posts.withParents({ pins: { User: author } }).createOne()   // reuse a row you already have
```

Without this, an `Int` FK falls back to `1` and a `String`/uuid FK gets placeholder
text that no foreign key will accept — which is why a uuid-keyed schema could not be
auto-seeded at all.

#### pins — one parent, shared by everything below

```js
import { createTestEnv } from '@frontierjs/litestone/testing'

const env = await createTestEnv({ schema: './schema.lite', autoFactories: true })
const { factories } = env

const account = await factories.account.createOne()
// Every generated row lands inside that one Account, however deep it sits
await factories.lead.asSystem().withParents({ pins: { Account: account } }).createOne()
await factories.user.withParents({ optional: true, pins: { Account: account } }).createOne()
```

**Keyed by model, applied at every depth.** That is the difference from `.for()`,
which wires one relation on one factory and so cannot reach a grandparent: a
`Deployment` has no `accountId` of its own, and pinning an Account with `.for()` on
its factory does nothing while `withParents()` builds a fresh one five hops down.

Precedence: an explicit `.for()` wins over a pin for the same relation. A pin for a
model that is not in the chain is unused rather than an error, so one pin map can be
reused across factories.

**A pin satisfies one relation to its model.** Two relations to the same parent on
one model (`IssueRelation.issue` and `.relatedIssue`) given one pinned Issue would
be the same row twice, which `@@check("issueId <> relatedIssueId")` refuses — so the
first takes the pin and the second gets a parent of its own, unless only the pin can
break a cycle.

A pin is also the cure for a **required** cyclic relation, which is why pins are
consulted before the cycle check:

```js
import { createTestEnv } from '@frontierjs/litestone/testing'

const env = await createTestEnv({ schema: './schema.lite', autoFactories: true })
const { factories, db } = env

const root  = await db.node.create({ data: { name: 'root', parentId: 1 } })
const child = await factories.node.withParents({ pins: { Node: root } }).createOne()
```

### has() — hasMany children

```js
import { createTestEnv } from '@frontierjs/litestone/testing'

const env = await createTestEnv({ schema: './schema.lite', autoFactories: true })
const { factories } = env

const author = await factories.user.has('posts', 3).createOne()
author.posts            // → the 3 created posts, each with authorId = author.id
```

Children are created **after** the parent, with the FK pointed back at it. The FK is
found from the child's own `@relation`; when a child declares two relations to the
same parent, name it:

```js
import { createTestEnv } from '@frontierjs/litestone/testing'

const env = await createTestEnv({ schema: './schema.lite', autoFactories: true })
const { factories } = env

const other  = await factories.user.createOne()
const drafts = factories.post.state({ title: 'Draft' })
await factories.user.has('sent', 2, { fk: 'senderId', overrides: { receiverId: other.id } }).createOne()
await factories.user.has('posts', 3, { factory: drafts }).createOne()
```

### attach() — implicit many-to-many

```js
import { createTestEnv } from '@frontierjs/litestone/testing'

const env = await createTestEnv({ schema: './schema.lite', autoFactories: true })
const { factories } = env

const [tagA, tagB] = await factories.tag.createMany(2)
await factories.post.withParents().attach('tags', 3).createOne()   // generate 3 tags
await factories.post.withParents().attach('tags', [tagA, tagB]).createOne()  // existing rows
```

### withRelation() / for() — one named parent

```js
import { createTestEnv } from '@frontierjs/litestone/testing'

const env = await createTestEnv({ schema: './schema.lite', autoFactories: true })
const { factories } = env

const posts = factories.post, users = factories.user

// Creates a user, then creates a post with post.authorId = user.id
const post = await posts.withRelation('author', users).createOne()
post.authorId // → (auto-created user).id
post.author   // → the created user (included)

// One parent shared across the whole createMany (the default) …
await posts.withRelation('author', users).createMany(3)                       // 1 author
// … or a new one per row
await posts.withRelation('author', users, 'authorId', 'id', { fresh: true }).createMany(3)  // 3

// for() — use an existing parent, no auto-create
const existingUser = await users.createOne()
const p = await posts.for('author', existingUser).createOne()
```

## Seeding past gates

A schema declaring any `@@gate` auto-installs `GatePlugin`, so an unauthenticated
factory grades `STRANGER` and cannot create anything. Seeding is a system concern:

```js
import { createTestEnv } from '@frontierjs/litestone/testing'
import { GatePlugin } from '@frontierjs/litestone'

const env = await createTestEnv({
  schema:        './schema.lite',
  autoFactories: true,
  plugins:       [new GatePlugin({ getLevel: (user) => user?.level ?? 0 })],
})
const { factories } = env

await factories.lead.asSystem().withParents().createOne()
await factories.lead.usingDb(env.system).withParents().createOne()   // any client
```

Or seed as a principal the app's own `getLevel` admits:

```js
import { createTestEnv } from '@frontierjs/litestone/testing'
import { GatePlugin } from '@frontierjs/litestone'

const env = await createTestEnv({
  schema:        './schema.lite',
  autoFactories: true,
  plugins:       [new GatePlugin({ getLevel: (user) => user?.level ?? 0 })],
})
const adminUser = { id: 1, level: 5 }

// The generated payload leaves out the optional @guarded `token`, which only a
// system-context write may name.
await env.factories.lead.actingAs(adminUser).withParents().createOne()
```

The client propagates through the **whole** wired graph — parents, children and m2m
targets all use it, so the first parent does not fail on a gate the top-level call
was allowed past.

## factoryFrom — zero-config

Generates a factory from schema introspection — no class needed:

```js
import { factoryFrom } from '@frontierjs/litestone/testing'
import { parse } from '@frontierjs/litestone'
import { readFileSync } from 'node:fs'

const { schema } = parse(readFileSync('./schema.lite', 'utf8'))
const users = factoryFrom(schema, 'User', db)

const admin = await users.state({ role: 'admin' }).createOne()
```

## generateFactory — schema-derived definition

Returns a `definition(seq, rng)` function that generates valid data from field types and constraints:

```js
import { generateFactory } from '@frontierjs/litestone/testing'

const defFn = generateFactory(db.$schema, 'User')
defFn(1, null)   // → { email: 'User1@test.com', role: 'member' }
```

The generated value satisfies the field's own declared rules — a factory that emits
data the schema rejects is worse than no factory:

| Declared                | Generated                                             |
| ----------------------- | ----------------------------------------------------- |
| `@email`                | `User1@test.com` (shortened if `@length(max)` demands) |
| `@url`                  | `https://example.com/User/1`                          |
| `@phone`                | `+15550000001`                                        |
| `@regex("^[A-Z]{3}$")`  | a value matching the pattern (see below)               |
| `@length(min, max)`     | padded/truncated into range, keeping the seq token     |
| `@gte`/`@gt`/`@lte`/`@lt` | a number inside the range, on `Int` and `Float` alike |
| `@startsWith`/`@endsWith`/`@contains` | text carrying the required affix          |
| `String[] @minItems(2)` | two elements                                           |
| `Enum`                  | first value unseeded, `rng.pick` when seeded           |
| `DateTime`              | derived from `seq` — never the wall clock              |
| `Json` / `Bytes`        | `{}` / bytes when required, `null` when optional       |
| `String?` unconstrained | `null`                                                 |
| `@sequence`             | omitted — the db owns that counter                     |

Every value varies with `seq`, so a `@unique` column survives `createMany()`. If one
collides anyway, `createOne` rebuilds and retries (5 attempts) rather than failing a
long seed — a rebuild advances `seq`, which changes every generated value.

**Well-known field names get real words when seeded.** `firstName`, `lastName`,
`city`, `country`, `company`, `street`, `postcode`, `title`, `description`, `body`
and friends draw from a small built-in catalog, matched case- and
separator-insensitively (`first_name` = `firstName`):

```js
import { makeTestClient } from '@frontierjs/litestone/testing'

const { factories } = await makeTestClient(`
  model Person {
    id        Int    @id
    firstName String
    lastName  String
    company   String
    city      String
    email     String @email
  }
`, { seed: 42, autoFactories: true })

factories.person.buildOne()
// → { firstName: 'Luca', lastName: 'Dubois', company: 'Kestrel Labs',
//     city: 'Medellin', email: 'lena.quintero601001@test.dev' }
```

Only when a seed was set. **Unseeded output is unchanged** (`FirstName 1`,
`City 1`) — schema-derived test *cases* have to stay stable and diff-able. The
catalog pool is small, so a `@unique` column also carries the seq token.

**`@regex` is best-effort.** Patterns cannot be inverted in general; the generator
covers the common subset (anchors, literals, `\d`/`\w`/`\s`, character classes with
ranges, groups, alternation, `{n}` `{n,m}` `?` `+` `*`) and then *checks its own
output against the pattern*. If it cannot produce a match it warns and tells you to
override the field — it never silently emits a value the validator will reject.
An open quantifier takes six characters where the pattern allows, and each class
draws a digit of the row's sequence, so a `@unique` slug differs per row rather than
per alphabet.

**The rules on a row are read, not only the types.** A `Json @type(Address)` carries
an Address, each member generated as a column would be; an optional column under
`@required(where:)` is filled, because a value is legal whether or not the
condition holds; `DateTime @date` draws a calendar date. A model-level `@@check` is
read as the SQL it is — `AND`/`OR`/`NOT`, the six comparisons, `IS [NOT] NULL`,
`[NOT] IN (…)`, arithmetic and parentheses over this row's columns — and the row is
moved until it passes: the later side of an ordering is pushed a day, a unit or an
hour past the earlier; a column held to a literal list takes the first; an identity
such as `total = subtotal + shippingTotal` is computed; a column compared against a
`@default(now())` sibling is placed relative to the clock. A rule outside that
subset, or one no move satisfies, is left to the table to refuse with its declared
message, and the `factories` override is the answer. `@scoped`/`@edge` marks are
not columns and are never written.

**FK columns are not resolved by the generator.** An `Int` FK defaults to `1`; a
`String` FK (uuid primary keys) gets placeholder text that will not satisfy a
foreign key. Use `withParents()` — see [Relations](#relations) — or wire a specific
parent with `withRelation()` / `for()` / `fkDefaults`.

## defineFactory — the same thing without the class

```js
import { defineFactory } from '@frontierjs/litestone'
import { makeTestClient } from '@frontierjs/litestone/testing'
import { readFileSync } from 'node:fs'

export const UserFactory = defineFactory({
  model:      'User',
  definition: (seq, rng) => ({ email: `u${seq}@x.com`, role: 'member' }),
  traits:     { admin: { role: 'admin' }, viewer: { role: 'viewer' } },
  afterCreate: async (row, db) => { /* … */ },
})

// Returns a CLASS, so it registers exactly like a hand-written subclass:
const schemaText = readFileSync('./schema.lite', 'utf8')
await makeTestClient(schemaText, { factories: { user: UserFactory } })
```

Everything a subclass can do, with nothing declared twice. `traits` on a subclass
is an instance field, which initializes only after `super()` returns — the sole
reason `Factory`'s constructor returns a Proxy. Here it is known up front, so that
path never runs.

`fli make:factory User` writes one of these into `db/factories/`.

## Seeder

```js
import { Seeder, runSeeder, defineFactory } from '@frontierjs/litestone'

const UserFactory = defineFactory({
  model:      'User',
  definition: (seq) => ({ email: `u${seq}@x.com` }),
  traits:     { admin: { role: 'admin' } },
})

class DatabaseSeeder extends Seeder {
  async run(db) {
    await new UserFactory(db).admin().createOne({ id: 1 })
    await new UserFactory(db).createMany(10)
  }
}

await runSeeder(db, DatabaseSeeder)
```

### dependsOn — order without a caller who knows it

```js
import { Seeder, runSeeder } from '@frontierjs/litestone'

class AccountSeeder extends Seeder { async run(db) { await db.account.create({ data: { name: 'Acme' } }) } }
class TagSeeder     extends Seeder { async run(db) { await db.tag.createMany({ data: [{ name: `t${Date.now()}` }] }) } }

class OrderSeeder extends Seeder {
  static dependsOn = [AccountSeeder, TagSeeder]
  async run(db) { await db.order.create({ data: {} }) }
}

await runSeeder(db, OrderSeeder)          // seeds accounts and tags first
await new Seeder().call(db, [OrderSeeder, AccountSeeder])   // AccountSeeder still runs once
```

Each class runs **at most once** per call, dependencies first. A cycle throws and
names the classes in it rather than dropping one silently.

## Fixtures — authored data, not generated

Reference data (countries, plans, currencies) is written down, not invented.

```js
import { loadFixture } from '@frontierjs/litestone'
import { writeFileSync } from 'node:fs'

writeFileSync('./countries.json', JSON.stringify([{ code: 'FR', name: 'France' }, { code: 'DE', name: 'Germany' }]))
writeFileSync('./countries.csv',  'code,name\nBR,"Brazil, Federative Republic of"\nJP,Japan\n')

await loadFixture(db, 'Country', './countries.json')
await loadFixture(db, 'Country', './countries.csv', { mode: 'upsert', key: 'code' })
await loadFixture(db, 'Country', [{ code: 'NZ', name: 'New Zealand' }])   // or inline
```

`mode: 'upsert'` with `key` naming the column to match on makes the fixture
re-runnable; the default is `insert`, and a second run then refuses every row the
first one stored. Rows go through the ORM, so defaults, validators, `@encrypted`
and hooks all apply — a fixture is an ordinary write; `asSystem: true` takes it
past gates and policies. CSV is RFC-4180 (quoted fields, embedded commas, `""`
escapes). A cell is text and the column decides what it means — `20` lands in an
`Int` column as a number — and an empty unquoted cell is `null`.

### Seeder.once — idempotent blocks

```js
import { Seeder, runSeeder } from '@frontierjs/litestone'

class BaseSeeder extends Seeder {
  async run(db) {
    await this.once(db, 'base-v1', async () => {
      // runs once and never again, even across deploys
      await db.country.createMany({ data: [{ code: 'FR', name: 'France' }, { code: 'DE', name: 'Germany' }] })
    })
  }
}

await runSeeder(db, BaseSeeder)
await runSeeder(db, BaseSeeder)   // the block is skipped
```

The key (`'base-v1'`) is stored in a `_litestone_seeds` table. Re-running the seeder skips already-run blocks. `await this.forget(db, 'base-v1')` un-records a key so the next run repeats the block — a no-op on a database that has never run one.

## Teardown

```js
import { makeTestClient, truncate, reset } from '@frontierjs/litestone/testing'
import { readFileSync } from 'node:fs'

const { db, factories } = await makeTestClient(readFileSync('./schema.lite', 'utf8'), { autoFactories: true })

await truncate(db, 'Post')          // hard-delete all rows in one table — the MODEL name
await reset(db)                     // hard-delete all tables in FK-safe order (dependency order)
await factories.user.truncate()     // factory instance shorthand
```

`reset()` respects foreign key dependencies — children deleted before parents.

### snapshot / restore — seed once, reset between tests

```js
import { makeTestClient, snapshot, restore } from '@frontierjs/litestone/testing'
import { readFileSync } from 'node:fs'

const { db, factories } = await makeTestClient(readFileSync('./schema.lite', 'utf8'), { seed: 42, autoFactories: true })
await factories.post.withParents().createMany(5)   // the expensive part, once
const clean = snapshot(db)

restore(db, clean)                 // beforeEach(() => restore(db, clean))
```

`restore()` truncates and re-inserts the exact rows, which is far cheaper than
seeding again. Deliberately raw: rows move through the write connection, not the
ORM, so `@encrypted`/`@secret` columns keep the ciphertext they already have (a
round trip through the ORM would re-encrypt them), and no gate, policy, hook or
audit entry fires. FTS5 shadow tables are skipped — writing those directly corrupts
the index.

**Not a transaction.** It is a point-in-time copy and does not isolate concurrent
work — but it survives a client restart and holds no write lock for the length of a
test, which is why it is the primitive here.

## generateGateMatrix — permission test cases

The second argument is the **model** name — PascalCase singular, `'Lead'` and not
`'leads'`. Three resolvers depend on the two spellings not being confused.

```js
import { generateGateMatrix } from '@frontierjs/litestone/testing'

const matrix = generateGateMatrix(db.$schema, 'Lead')
// → [{ op: 'read', required: 4, level: 0, label: 'STRANGER', expect: 'deny' }, ...]
```

**Every operation against every reachable level (0–8), by default** — 36 cases per
model. `{ levels: 'edges' }` narrows it to the required level and the one below,
which is 8 cases and proves only the comparison operator. A gate that grants at 6
and again at 2 passes the edges and is a hole.

**A level does not live on the user object.** `$setAuth({ id: 1, level })` grades
whatever the installed `getLevel` says it grades, and the extra key is ignored —
the level comes from the plugin. Drive it from there:

```js
import { makeTestClient, generateGateMatrix } from '@frontierjs/litestone/testing'
import { GatePlugin } from '@frontierjs/litestone'
import { expect } from 'bun:test'
import { readFileSync } from 'node:fs'

let level = 0
const { db } = await makeTestClient(readFileSync('./schema.lite', 'utf8'), {
  plugins: [new GatePlugin({ getLevel: () => level })]
})
const account = await db.asSystem().account.create({ data: { name: 'Acme' } })
const args = {
  create: { data: { email: 'lead@x.co', accountId: account.id } },
  update: { where: { id: 1 }, data: { email: 'moved@x.co' } },
  delete: { where: { id: 1 } },
}

for (const c of generateGateMatrix(db.$schema, 'Lead')) {
  level = c.level
  // getLevel is clamped to 0–7, so SYSTEM is not reachable through it at all.
  const as = c.level === 8 ? db.asSystem() : db.$setAuth({ id: 1 })
  const run = () => c.op === 'read' ? as.lead.findMany() : as.lead[c.op](args[c.op])

  if (c.expect === 'allow') await expect(run()).resolves.toBeDefined()
  else                      await expect(run()).rejects.toThrow(/requires level/i)
}
```

The verdicts are the plugin's own — `generateGateMatrix` asks `levelPasses()`
rather than restating the comparison, so a matrix cannot certify access the app
does not grant.

## The access snapshot

`deriveAccess(schema)` reads the whole declared access surface back out — every
`@@gate`, `@@allow`, `@@deny`, `@guarded`, `@encrypted`, `@secret`, field `@allow`
and, per declared move, its `@gate` **and its `@system`** — and
`renderAccessSnapshot()` turns it into one markdown file to commit.

The two halves of a move are separate columns because they compose. The gate says
who may ASK; `@system` says the APPLICATION makes it, so no caller reaches it at
any level and the code makes it by naming the move on the write. `@system @gate(5)`
is both: a move the engine decides on behalf of a caller senior enough to ask for
it. Folded into one column, a move gaining `@system` — the widest narrowing a
state machine can make — produced no diff at all (`FJS-613`).

```bash
litestone access            # → access.snapshot.md beside the schema
litestone access --check    # exit 1 if the committed file is stale  (CI)
litestone access --json     # the structured table instead
```

**Commit it and read its diff.** A gate change is otherwise invisible until
something is refused in production: `@@gate` refuses and `@@allow` filters, both
below the API, and a wrong policy is an empty screen with a 200 rather than an
error. The snapshot is tens of lines and names exactly which access moved.

```js
import { deriveAccess, gateLadder } from '@frontierjs/litestone/testing'

const access = deriveAccess(db.$schema)
access.counts        // { models, views, exportable, gated, unrestricted, policied, protected, transitions, systemMoves, sealingMoves }
access.models        // sorted by name — inserting a model does not shift every row

for (const model of access.models)
  for (const { op, level, expect } of gateLadder(model)) { /* … */ }
```

Models are sorted rather than left in schema order, and empty sections are omitted:
both exist so the diff is small and localized. The first section is **Unrestricted**
— models declaring neither `@@gate` nor `@@allow`, which every caller reaches
including an unauthenticated one.

## The DDL snapshot

```bash
litestone ddl               # → ddl.snapshot.sql beside the schema
litestone ddl --check       # exit 1 if the committed file is stale  (CI)
```

The same shape for the opposite problem. Access is a rule nothing below the API
can show you; DDL is a set of names everything above it binds to. Columns are
emitted verbatim camelCase and `DateTime` as ISO-8601 TEXT, so a change in the
emitter renames a column in an app that never touched its schema — and that
app's own tests go through the client that changed with it, which is why nothing
there can see it.

One section per declared database, in declaration order. A `jsonl` or `trail`
database is named and skipped: absent DDL and an absent database have to read
differently. Fragments an app merges at runtime are not in the file.

## The JSON Schema snapshot

```bash
litestone jsonschema --snapshot          # → jsonschema.snapshot.md beside the schema
litestone jsonschema --snapshot --check  # exit 1 if the committed file is stale  (CI)
```

The third one, over the widest bridge in the repo. Junction validates requests
against `generateJsonSchema`'s output, Sierra re-checks the same rules in the
browser, and `<Form>` renders a control from it — three readers, one document,
and no build that breaks when a keyword stops being emitted. A form just stops
validating.

`$defs` first, because it travels whole and a name that disappears is a `$ref`
resolving to nothing in a browser. Then enum values, then per model: the gate,
`x-version`, each relation, each `@@transitions` move with its own gate, and one
row per field — type and default, required, `@label`, the keywords a validator
branches on, and which rule names `x-messages` answers for. Each model closes
with what CREATE mode accepts, which is where a required column only the server
can fill shows up as a form that cannot submit.

A second RENDERING of the generated document, not a second generator — the raw
JSON is what ships, and thousands of lines of it is where a removed keyword
hides.

All three snapshots name the command that regenerates them in their own header —
`<!-- generated by: … -->` in the markdown, `-- generated by: …` in the SQL — so
CI can find and recheck one without being told it exists.

## generateValidationCases — constraint boundary data

```js
import { generateValidationCases } from '@frontierjs/litestone/testing'
import { expect } from 'bun:test'

const { valid, invalid, boundary, uncheckable } = generateValidationCases(db.$schema, 'Lead')
// valid       — complete valid record (correct by construction)
// invalid     — one failing case per constraint: { field, value, rule, expect: 'fail', message }
// boundary    — edge values that should pass: { field, value, rule, expect: 'pass' }
// uncheckable — rules no value could isolate, reported rather than dropped

const system  = db.asSystem()                       // the question is the rule, not the gate
const account = await system.account.create({ data: { name: 'Acme' } })

// valid data passes
await system.lead.create({ data: { ...valid, accountId: account.id } })

for (const c of invalid)   // `${c.field}: ${c.rule} rejects "${c.value}"`
  await expect(system.lead.create({ data: { ...valid, accountId: account.id, [c.field]: c.value } }))
    .rejects.toThrow(c.message)
```

**`c.message` is the field's own message where it declares one.** `@email("Use
your work address")` predicts that sentence, not the default wording — the same
string `x-messages` carries to Junction and Sierra.

Covered: `@email`, `@url`, `@phone`, `@date`, `@datetime`, `@time`, `@regex`,
`@length`, `@gte`/`@gt`/`@lte`/`@lt`, `@startsWith`, `@endsWith`, `@contains`,
and on array columns `@minItems`, `@maxItems`, `@uniqueItems`.

**Every case is executed against a real client in litestone's own suite** —
invalid ones must be refused with the message they predicted, boundary ones must
be accepted, and every field carrying an attribute must produce a case. That test
is what the category is worth: unit tests over the generator's *output* passed
for a long time while `valid` was not valid, authored messages were ignored, and
three rule families generated nothing at all.

## Auto-factories

When `autoFactories: true`, `makeTestClient` generates factories for every SQLite model automatically. Access them via `factories`:

```js
import { makeTestClient } from '@frontierjs/litestone/testing'
import { readFileSync } from 'node:fs'

const { db, factories } = await makeTestClient(readFileSync('./schema.lite', 'utf8'), { autoFactories: true })

await factories.user.createOne()
await factories.account.createMany(3)
```

Auto-factories use `generateFactory` under the hood — sensible defaults, no manual
definition required, and no traits: `state()` is how a generated factory is moved.

## Schema mutation testing

```js
import { createTestEnv, mutationScore, schemaMutants } from '@frontierjs/litestone/testing'
import { readFileSync } from 'node:fs'

const schema = readFileSync('./schema.lite', 'utf8')
const r = await mutationScore({
  schema,
  build: (text) => createTestEnv({ schema: text }),
})
// { total, graded, killed, byParser, score, survived, refused, errored }
```

**Mutate the schema, not the code.** Drop a `@@gate`, grade one down, remove a
`@guarded`, widen a `@length`, delete an `@@allow` — then run the suite derived
from the **original** schema against a database built from the mutant. A mutant
nothing notices is a hole, and it names itself.

A `.lite` file is small and declarative, so the mutation space is **enumerable**
rather than combinatorial: one mutant per attribute occurrence, 30 for `example`
and 232 for `basecamp`.

### The direction is the whole design

Expectations come from the ORIGINAL schema; the database comes from the MUTANT.
That is why `verifyGateLadder`, `verifyConstraints` and `verifyFieldProtection`
all take `{ against }`. Deriving both from the mutant is the oracle problem at
its purest — drop a `@@gate` and the ladder loses the rows that would have caught
it, so every mutant survives and the score reads 100%.

### Outcomes

| | Counts as | Means |
| --- | --- | --- |
| verdict disagreement | **kill** | the suite saw the change |
| parser refused it | **kill** | the schema does not parse |
| the framework refused to load it | **kill** | such a schema cannot ship |
| `survived` | — | nothing in the derived suite can see this change |
| `errored` | **ungraded** | the suite fell over; says nothing either way |

**An `error` or `skipped` row never counts as a kill.** Every mutant once came
back with the same 22 error rows and the score read 93% while four mutations went
completely unnoticed. A mutation score that counts its own harness failures as
successes is the oracle problem wearing a percentage.

### What a survivor means

Not *the schema is wrong* — it is a fact about the **suite**. Two are known and
named rather than hidden:

- **`allow-drop`** — row policies need rows on both sides of a predicate, and
  nothing executed asks.
- **`unique-drop` on a nullable column** — SQLite accepts any number of NULLs in
  a UNIQUE column, so there is no duplicate to try.

### Kinds

`gate-drop` · `gate-lower` · `allow-drop` · `deny-drop` · `guarded-drop` ·
`encrypted-drop` · `unique-drop` · `validator-drop` · `validator-widen` ·
`relator-tighten` · `relator-loosen`

Pass `{ kinds: [...] }` to narrow. Mutation is **code-only and quote-aware**: an
attribute named inside a doc comment is prose, and editing it produces a mutant
identical to the original that survives everything.

## verifyRowPolicies

```js
import { createTestEnv } from '@frontierjs/litestone/testing'
import { expect } from 'bun:test'

const env = await createTestEnv({ schema: './schema.lite' })
const owner = { id: 42 }                      // a principal whose id fits User.id
expect(await env.verifyRowPolicies({ principal: owner })).toEqual([])
await env.verifyRowPolicies({ principal: owner, ops: ['read'] })
```

Every `@@allow`/`@@deny`, executed against rows on **both sides** of its
predicate. A gate refuses and a policy filters, so a wrong policy raises nothing
anywhere — it returns more rows, and more rows is not an error.

**The oracle is a second implementation.** Litestone compiles a policy twice:
`compileSql` for reads (a WHERE) and `evalJs` for creates (JavaScript). This
reads through the compiled WHERE and asks `evalJs` which rows should have come
back. Independent implementations of one rule, so one can grade the other — the
opposite of the oracle problem, and the comparison that found FJS-195.

Covers `read`, `update` and `delete`. **`create` has no WHERE and one
evaluator**, so without a second schema the verdict and the create are one
implementation grading itself; it is graded only under `against`, and only its
column-only `@@deny` rules.

| `got` | Means |
| --- | --- |
| `admitted` / `filtered` | the client's answer, compared against the evaluator's |
| `error` | the rows could not be built, or all fell on one side |
| `skipped` | a `check()` predicate, or a gate above SYSADMIN(7) |

**Rows on one side only are reported, not passed.** A policy that admits
everything and a policy that is not applied at all are the same observation when
every row matches — which is the exact shape this realm exists to stop.

Values are taken off the predicate: the principal's own value for an `auth()`
comparison, the literal for a literal one. Where that field is a **foreign key**
— `workspaceId == auth().workspaceId` is the common case — the parent row is
created first, or the candidate would break the FK and never exist. The default
principal's `id` is a string, so a policy comparing an `Int` key to `auth().id`
is reported as *all excluded* until `principal` names one whose `id` the column
accepts.
