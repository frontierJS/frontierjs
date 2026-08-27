# Testing

Litestone ships a `/testing` subpath with everything needed for fast, deterministic test suites: in-memory clients, factories, seeders, and schema-derived test case generators.

## createTestEnv

A migrated database, a client, factories and a principal, in one call.

```js
import { createTestEnv } from '@frontierjs/litestone/testing'

const env = await createTestEnv({
  schema:  'db/schema.lite',          // the text, or a path to it
  plugins: [new GatePlugin({ getLevel: myAppsResolver })],
})

const doc = await env.factories.doc.withParents().createOne()   // arrange, below the boundary
await expect(env.actingAs(viewer).doc.delete({ where: { id: doc.id } })).rejects.toThrow()
env.close()
```

**The tables arrive as a file copy.** The DDL is applied once per schema per
process into a template, and every env after the first is `copyFileSync`. On
basecamp's 37-model schema that is 476ms → 13ms per database. Migration cost is
what dominates a test suite; in SQLite, a database per test is a file copy.

### migrations — test the database a deploy produces

```js
const env = await createTestEnv({ schema: 'db/schema.lite', migrations: 'db/migrations' })
```

Builds the template by replaying the committed migration files instead of
generating DDL from the schema. Takes a directory, a `.sql` path, or an array of
either; a directory contributes every `.sql` it holds, **sorted by filename**.

Worth reaching for whenever the migrations are the thing you ship. Without it a
suite proves the schema works, and says nothing about whether the migration that
builds production agrees with it — which is a question with an answer:

```js
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
| `env.actingAs(user)` | the app's own `getLevel` | anything about behaviour |
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
const t = env.phases({ as: developer })

const lead = await t.arrange(({ factories }) => factories.lead.createOne())
await t.act(as => as.lead.remove({ where: { id: lead.id } }))
await t.assert(read => expect(read.lead.count()).resolves.toBe(0))
```

The body stays linear — nothing threaded through return values, and a line can
still be commented out to bisect. What the phases buy is not tidiness:

| Phase | Reaches | Why |
| --- | --- | --- |
| `arrange` | the **system** client + factories | fixtures are set up below the boundary, so a gate that refuses the principal does not refuse the setup |
| `act` | the **principal's** client | graded by the app's own `getLevel`. **One per scenario** |
| `assert` | the principal's **read-only** client | graded, so *the row exists* cannot stand in for *this user can see it*; read-only, so retrying the scenario is sound |

`arrange` after `act` is refused, because setup after the act is part of the act
— and the two being separable is what lets `arrange` be hoisted and cached.

Not tied to a runner: call it inside whatever `test()` the package uses.

### verifyGateLadder

```js
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
can write to — `@@external`, `jsonl`, `logger` — are skipped.

**Three outcomes.** A write that fails for an unrelated reason is `error`, never
`rejected`; calling it a refusal makes a broken validator look enforced. It is
reported rather than swallowed, because a case that could not run is a hole in
the coverage the count implies.

| `got` | Means |
| --- | --- |
| `rejected` | a `ValidationError` — the rule fired |
| `accepted` | the write succeeded. If the case was `invalid`, the rule is not enforced |
| `error` | the write failed before validation could refuse it — this case proves nothing |

### setup — the arrange every scenario shares

```js
const fx = await env.setup(({ factories }) => factories.account.createOne())

test('a developer archives a lead', async () => {
  const t = env.phases({ as: developer })     // rows are back at fx
  const lead = await t.arrange(({ factories }) => factories.lead.createOne({ accountId: fx.id }))
  …
})
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
await seedTheWorld(env.system)
env.seal()
beforeEach(() => env.reset())
```

### sampleWrites — a row and its payloads, per model

```js
import { sampleWrites } from '@frontierjs/litestone/testing'

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
const env = await createTestEnv({ schema, now: '2026-06-01T00:00:00Z' })

await env.db.sale.findMany()        // the spring window is open
env.clock.advance('20d')
await env.db.sale.findMany()        // it closed on the 15th
env.clock.set('2026-09-15T00:00:00Z')
await env.db.sale.findMany()        // autumn
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
await env.db.note.create({ data: { body: 'x' } })   // stamped 2020
env.clock.advance('100d')
env.db.asSystem().$retain()                          // and now it is old enough to go
```

Until `FJS-531` those stamps were SQLite's own clock — a column DEFAULT and an
AFTER UPDATE trigger — so a frozen clock produced a row dated today and every
window over it was quietly wrong. Stating the timestamp on the write is still
supported and still wins, because key PRESENCE decides:

```js
await env.db.note.create({ data: { body: 'x', createdAt: '2019-05-06T07:08:09.000Z' } })
```

### What it does not move

**SQL that runs without this client.** A raw `db.sql` statement takes whatever
SQLite's clock says, and a `@derived` expression reading `now()` is compiled once
at startup into a subquery with no parameter to bind. Both are reads of the
database's own clock rather than of yours.

## makeTestClient

The primary entry point for tests. Creates an in-memory Litestone client:

```js
import { makeTestClient } from '@frontierjs/litestone/testing'

const { db, factories } = await makeTestClient(`
  model User {
    id    Int @id
    email String    @unique
    role  String    @default("member")
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
      role:  rng.pick(['admin', 'member', 'viewer']),
    }
  }
}

// Usage
const user    = await users.createOne()
const admin   = await users.admin().createOne()
const five    = await users.createMany(5)
const seeded  = users.seed(42).buildMany(10)   // deterministic, no DB write

// State override
const custom  = await users.state({ role: 'admin', email: 'custom@test.com' }).createOne()
```

`model` is the model name as the schema declares it — **PascalCase singular**
(`'User'`, not `'users'`); the accessor is derived from it. Factory names in the
`factories` map follow the accessor (`db.user` → `factories.user`).

### create() / build() — count or overrides

`create()` and `build()` overload on their FIRST argument: a **number** is a count,
anything else is overrides.

```js
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

## Relations

A model is rarely creatable on its own. Four chain methods cover the shapes a
schema can declare, and they compose.

### withParents() — every required parent, recursively

```js
// Deployment → App → Environment → Project → Workspace → Account, in one call
const deployment = await factories.deployment.withParents().createOne()
```

Reads the schema and auto-creates a parent for every **required** belongsTo, then
does the same for that parent, down the chain. Relation cycles (self-references,
`A → B → A`) are refused by name rather than followed — no number of rows satisfies
them, and the error states both cures.

```js
withParents({ optional: true })   // nullable relations get parents too (default: skipped)
withParents({ fresh: true })      // a new parent per row instead of one shared
withParents({ depth: 3 })         // backstop; cycles are what actually terminate it
withParents({ pins: { Account: acct } })   // reuse a row you already have
```

Without this, an `Int` FK falls back to `1` and a `String`/uuid FK gets placeholder
text that no foreign key will accept — which is why a uuid-keyed schema could not be
auto-seeded at all.

#### pins — one parent, shared by everything below

```js
const account = await factories.account.createOne()
// Every generated row lands inside that one Account, however deep it sits
await factories.deployment.withParents({ pins: { Account: account } }).createOne()
await factories.user.withParents({ pins: { Account: account } }).createOne()
```

**Keyed by model, applied at every depth.** That is the difference from `.for()`,
which wires one relation on one factory and so cannot reach a grandparent: a
`Deployment` has no `accountId` of its own, and pinning an Account with `.for()` on
its factory does nothing while `withParents()` builds a fresh one five hops down.

Precedence: an explicit `.for()` wins over a pin for the same relation. A pin for a
model that is not in the chain is unused rather than an error, so one pin map can be
reused across factories.

A pin is also the cure for a **required** cyclic relation, which is why pins are
consulted before the cycle check:

```js
const root  = await db.node.create({ data: { name: 'root', parentId: 1 } })
const child = await factories.node.withParents({ pins: { Node: root } }).createOne()
```

### has() — hasMany children

```js
const author = await factories.author.has('posts', 3).createOne()
author.posts            // → the 3 created posts, each with authorId = author.id
```

Children are created **after** the parent, with the FK pointed back at it. The FK is
found from the child's own `@relation`; when a child declares two relations to the
same parent, name it:

```js
factories.user.has('messages', 2, { fk: 'senderId', overrides: { receiverId: 1 } })
factories.author.has('posts', 3, { factory: draftPosts })
```

### attach() — implicit many-to-many

```js
await factories.post.withParents().attach('tags', 3).createOne()   // generate 3 tags
await factories.post.withParents().attach('tags', [tagA, tagB]).createOne()  // existing rows
```

### withRelation() / for() — one named parent

```js
// Creates a user, then creates a post with post.userId = user.id
const post = await posts.withRelation('author', users).createOne()
post.userId   // → (auto-created user).id
post.author   // → the created user (included)

// One parent shared across the whole createMany (the default) …
await posts.withRelation('author', users).createMany(3)                       // 1 author
// … or a new one per row
await posts.withRelation('author', users, 'authorId', 'id', { fresh: true }).createMany(3)  // 3

// for() — use an existing parent, no auto-create
const p = await posts.for('author', existingUser).createOne()
```

## Seeding past gates

A schema declaring any `@@gate` auto-installs `GatePlugin`, so an unauthenticated
factory grades `STRANGER` and cannot create anything. Seeding is a system concern:

```js
await factories.order.asSystem().withParents().createOne()
await factories.order.actingAs(adminUser).createOne()   // or seed as a principal
await factories.order.usingDb(otherClient).createOne()  // any client
```

The client propagates through the **whole** wired graph — parents, children and m2m
targets all use it, so the first parent does not fail on a gate the top-level call
was allowed past.

## factoryFrom — zero-config

Generates a factory from schema introspection — no class needed:

```js
import { factoryFrom } from '@frontierjs/litestone/testing'
import { parse } from '@frontierjs/litestone'

const { schema } = parse(schemaText)
const users = factoryFrom(schema, 'User', db)

const admin = await users.state({ role: 'admin' }).createOne()
```

## generateFactory — schema-derived definition

Returns a `definition(seq, rng)` function that generates valid data from field types and constraints:

```js
import { generateFactory } from '@frontierjs/litestone/testing'

const defFn = generateFactory(schema, 'User')
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
and friends draw from a small built-in catalogue, matched case- and
separator-insensitively (`first_name` = `firstName`):

```js
// makeTestClient(schema, { seed: 42, autoFactories: true })
{ firstName: 'Luca', lastName: 'Dubois', company: 'Kestrel Labs',
  city: 'Medellin', email: 'lena.quintero601001@test.dev' }
```

Only when a seed was set. **Unseeded output is unchanged** (`FirstName 1`,
`City 1`) — schema-derived test *cases* have to stay stable and diff-able. The
catalogue pool is small, so a `@unique` column also carries the seq token.

**`@regex` is best-effort.** Patterns cannot be inverted in general; the generator
covers the common subset (anchors, literals, `\d`/`\w`/`\s`, character classes with
ranges, groups, alternation, `{n}` `{n,m}` `?` `+` `*`) and then *checks its own
output against the pattern*. If it cannot produce a match it warns and tells you to
override the field — it never silently emits a value the validator will reject.

**FK columns are not resolved by the generator.** An `Int` FK defaults to `1`; a
`String` FK (uuid primary keys) gets placeholder text that will not satisfy a
foreign key. Use `withParents()` — see [Relations](#relations) — or wire a specific
parent with `withRelation()` / `for()` / `fkDefaults`.

## defineFactory — the same thing without the class

```js
import { defineFactory } from '@frontierjs/litestone'

export const UserFactory = defineFactory({
  model:      'User',
  definition: (seq, rng) => ({ email: `u${seq}@x.com`, role: 'member' }),
  traits:     { admin: { role: 'admin' }, viewer: { role: 'viewer' } },
  afterCreate: async (row, db) => { /* … */ },
})

// Returns a CLASS, so it registers exactly like a hand-written subclass:
await makeTestClient(schemaText, { factories: { user: UserFactory } })
```

Everything a subclass can do, with nothing declared twice. `traits` on a subclass
is an instance field, which initialises only after `super()` returns — the sole
reason `Factory`'s constructor returns a Proxy. Here it is known up front, so that
path never runs.

`fli make:factory User` writes one of these into `db/factories/`.

## Seeder

```js
import { Seeder, runSeeder } from '@frontierjs/litestone'

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
class AccountSeeder extends Seeder { async run(db) { … } }

class OrderSeeder extends Seeder {
  static dependsOn = [AccountSeeder, ProductSeeder]
  async run(db) { … }
}

await runSeeder(db, OrderSeeder)          // seeds accounts and products first
await new Seeder().call(db, [OrderSeeder, AccountSeeder])   // AccountSeeder still runs once
```

Each class runs **at most once** per call, dependencies first. A cycle throws and
names the classes in it rather than dropping one silently.

## Fixtures — authored data, not generated

Reference data (countries, plans, currencies) is written down, not invented.

```js
import { loadFixture } from '@frontierjs/litestone'

await loadFixture(db, 'Country', './db/fixtures/countries.json')
await loadFixture(db, 'Plan',    './db/fixtures/plans.csv', { upsert: 'code' })
await loadFixture(db, 'Plan',    [{ code: 'pro', price: 20 }])   // or inline
```

`upsert` names the column to match on, which makes the fixture re-runnable. Rows go
through the ORM, so defaults, validators, `@encrypted` and hooks all apply — a
fixture is an ordinary write. CSV is RFC-4180 (quoted fields, embedded commas, `""`
escapes); unquoted `true`/`false`/numbers/empty are coerced, quoted values stay
strings.

### Seeder.once — idempotent blocks

```js
class BaseSeeder extends Seeder {
  async run(db) {
    await this.once(db, 'base-v1', async () => {
      // runs once and never again, even across deploys
      await db.plans.createMany({ data: [...] })
    })
  }
}
```

The key (`'base-v1'`) is stored in a `_litestone_seeds` table. Re-running the seeder skips already-run blocks.

## Teardown

```js
import { truncate, reset } from '@frontierjs/litestone/testing'

await truncate(db, 'posts')   // hard-delete all rows in one table
await reset(db)               // hard-delete all tables in FK-safe order (dependency order)
await factory.truncate()      // factory instance shorthand
```

`reset()` respects foreign key dependencies — children deleted before parents.

### snapshot / restore — seed once, reset between tests

```js
import { snapshot, restore } from '@frontierjs/litestone/testing'

const { db, factories } = await makeTestClient(schemaText, { seed: 42, autoFactories: true })
await seedEverything(db)          // the expensive part, once
const clean = snapshot(db)

beforeEach(() => restore(db, clean))
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

The second argument is the **model** name — PascalCase singular, `'Post'` and not
`'posts'`. Three resolvers depend on the two spellings not being confused.

```js
import { generateGateMatrix } from '@frontierjs/litestone/testing'

const matrix = generateGateMatrix(schema, 'Post')
// → [{ op: 'read', required: 1, level: 0, label: 'STRANGER', expect: 'deny' }, ...]
```

**Every operation against every reachable level (0–8), by default** — 36 cases per
model. `{ levels: 'edges' }` narrows it to the required level and the one below,
which is 8 cases and proves only the comparison operator. A gate that grants at 6
and again at 2 passes the edges and is a hole.

**A level does not live on the user object.** `$setAuth({ id: 1, level })` grades
whatever the installed `getLevel` says it grades, and the extra key is ignored —
the level comes from the plugin. Drive it from there:

```js
let level = 0
const { db } = await makeTestClient(SCHEMA, {
  plugins: [new GatePlugin({ getLevel: () => level })]
})

for (const c of generateGateMatrix(schema, 'Post')) {
  level = c.level
  // getLevel is clamped to 0–7, so SYSTEM is not reachable through it at all.
  const as = c.level === 8 ? db.asSystem() : db.$setAuth({ id: 1 })
  const run = () => c.op === 'read' ? as.post.findMany() : as.post[c.op](args[c.op])

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
and `@@transitions` gate — and `renderAccessSnapshot()` turns it into one markdown
file to commit.

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

const access = deriveAccess(schema)
access.counts        // { models, gated, unrestricted, policied, protected, transitions }
access.models        // sorted by name — inserting a model does not shift every row

for (const model of access.models)
  for (const { op, level, expect } of gateLadder(model)) { /* … */ }
```

Models are sorted rather than left in schema order, and empty sections are omitted:
both exist so the diff is small and localised. The first section is **Unrestricted**
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

One section per declared database, in declaration order. A `jsonl` or `logger`
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

const { valid, invalid, boundary } = generateValidationCases(schema, 'Lead')
// valid    — complete valid record (correct by construction)
// invalid  — one failing case per constraint: { field, value, rule, expect: 'fail', message }
// boundary — edge values that should pass: { field, value, rule, expect: 'pass' }

test('valid data passes', async () => {
  await db.lead.create({ data: valid })
})

for (const c of invalid) {
  test(`${c.field}: ${c.rule} rejects "${c.value}"`, async () => {
    await expect(db.lead.create({ data: { ...valid, [c.field]: c.value } }))
      .rejects.toThrow(c.message)
  })
}
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
const { db, factories } = await makeTestClient(schemaText, { autoFactories: true })

await factories.user.createOne()
await factories.account.admin().createMany(3)
```

Auto-factories use `generateFactory` under the hood — sensible defaults, no manual definition required.

## Schema mutation testing

```js
import { createTestEnv, mutationScore, schemaMutants } from '@frontierjs/litestone/testing'

const r = await mutationScore({
  schema,
  build: (text) => createTestEnv({ schema: text }),
})
// { total, graded, killed, score, survived, refused, errored }
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
`encrypted-drop` · `unique-drop` · `validator-drop` · `validator-widen`

Pass `{ kinds: [...] }` to narrow. Mutation is **code-only and quote-aware**: an
attribute named inside a doc comment is prose, and editing it produces a mutant
identical to the original that survives everything.

## verifyRowPolicies

```js
expect(await env.verifyRowPolicies()).toEqual([])
await env.verifyRowPolicies({ ops: ['read'] })
```

Every `@@allow`/`@@deny`, executed against rows on **both sides** of its
predicate. A gate refuses and a policy filters, so a wrong policy raises nothing
anywhere — it returns more rows, and more rows is not an error.

**The oracle is a second implementation.** Litestone compiles a policy twice:
`compileSql` for reads (a WHERE) and `evalJs` for creates (JavaScript). This
reads through the compiled WHERE and asks `evalJs` which rows should have come
back. Independent implementations of one rule, so one can grade the other — the
opposite of the oracle problem, and the comparison that found FJS-195.

Covers `read`, `update` and `delete`. **`create` is absent on purpose**: it is
checked by `evalJs` alone, so grading it with `evalJs` would be circular.

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
created first, or the candidate would break the FK and never exist.
