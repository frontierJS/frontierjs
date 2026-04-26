# Testing

Litestone ships a `/testing` subpath with everything needed for fast, deterministic test suites: in-memory clients, factories, seeders, and schema-derived test case generators.

## makeTestClient

The primary entry point for tests. Creates an in-memory Litestone client:

```js
import { makeTestClient } from '@frontierjs/litestone/testing'

const { db, factories } = await makeTestClient(`
  model User {
    id    Integer @id
    email Text    @unique
    role  Text    @default("member")
  }
`, {
  seed:          42,           // deterministic RNG — same seed = same data every run
  autoFactories: true,         // auto-generate factories for all SQLite models
  factories: { users: MyUserFactory },  // explicit factories override auto-generated
  data: async (db) => {       // seed function — runs after tables created
    await db.account.create({ data: { id: 1, name: 'Test Co' } })
  },
})
```

`makeTestClient` always uses `:memory:` — no files created, no cleanup needed.

## Factory

```js
import { Factory } from '@frontierjs/litestone/testing'

class UserFactory extends Factory {
  model = 'users'

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

### withRelation — auto-create parent

```js
// Creates a user, then creates a post with post.userId = user.id
const post = await posts.withRelation('author', users).createOne()
post.userId   // → (auto-created user).id
post.author   // → the created user (included)
```

### for() — use existing parent

```js
const post = await posts.for('author', existingUser).createOne()
```

## factoryFrom — zero-config

Generates a factory from schema introspection — no class needed:

```js
import { factoryFrom } from '@frontierjs/litestone/testing'
import { parse } from '@frontierjs/litestone'

const { schema } = parse(schemaText)
const users = factoryFrom(schema, 'users', db)

const admin = await users.state({ role: 'admin' }).createOne()
```

## generateFactory — schema-derived definition

Returns a `definition(seq, rng)` function that generates valid data from field types and constraints:

```js
import { generateFactory } from '@frontierjs/litestone/testing'

const defFn = generateFactory(schema, 'users')
// @email → 'users1@test.com'
// @gte(0) @lte(100) → 50
// Text? → null
// Boolean → true/false
// Enum → random valid value
```

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

await factories.users.createOne()
await factories.accounts.admin().createMany(3)
```

Auto-factories use `generateFactory` under the hood — sensible defaults, no manual definition required.
