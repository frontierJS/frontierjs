# Testing

Litestone ships a `/testing` subpath with everything needed for fast, deterministic test suites: in-memory clients, factories, seeders, and schema-derived test case generators.

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
`A → B → A`) are skipped rather than followed — no number of rows satisfies them.

```js
withParents({ optional: true })   // nullable relations get parents too (default: skipped)
withParents({ fresh: true })      // a new parent per row instead of one shared
withParents({ depth: 3 })         // backstop; cycles are what actually terminate it
```

Without this, an `Int` FK falls back to `1` and a `String`/uuid FK gets placeholder
text that no foreign key will accept — which is why a uuid-keyed schema could not be
auto-seeded at all.

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

```js
import { generateGateMatrix } from '@frontierjs/litestone/testing'

const matrix = generateGateMatrix(schema, 'posts')
// → [{ op: 'read', level: 1, label: 'VISITOR', expect: 'allow' }, ...]

for (const { op, level, label, expect: expected } of matrix) {
  test(`${op} as ${label} → ${expected}`, async () => {
    const userDb = db.$setAuth({ id: 1, level })
    if (expected === 'allow') {
      await expect(userDb.posts[op === 'read' ? 'findMany' : op]({})).resolves.toBeDefined()
    } else {
      await expect(userDb.posts[op === 'read' ? 'findMany' : op]({})).rejects.toThrow()
    }
  })
}
```

## generateValidationCases — constraint boundary data

```js
import { generateValidationCases } from '@frontierjs/litestone/testing'

const { valid, invalid, boundary } = generateValidationCases(schema, 'leads')
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

## Auto-factories

When `autoFactories: true`, `makeTestClient` generates factories for every SQLite model automatically. Access them via `factories`:

```js
const { db, factories } = await makeTestClient(schemaText, { autoFactories: true })

await factories.user.createOne()
await factories.account.admin().createMany(3)
```

Auto-factories use `generateFactory` under the hood — sensible defaults, no manual definition required.
