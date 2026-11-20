# Testing

`@frontierjs/litestone/testing` builds a throwaway database, a client and a factory per model in one call, so a test arranges rows without writing them by hand.

```lite
model Account {
  id    Int    @id
  name  String
  users User[]
}

model User {
  id        Int     @id
  email     String  @unique
  accountId Int
  account   Account @relation(fields: [accountId], references: [id])
}
```

```js
import { readFileSync } from 'node:fs'
import { makeTestClient } from '@frontierjs/litestone/testing'

const { db, factories } = await makeTestClient(readFileSync('./schema.lite', 'utf8'), { seed: 42, autoFactories: true })

await factories.user.withParents().createMany(3)
if (await db.user.count() !== 3 || await db.account.count() !== 1) throw new Error('expected 3 users under one parent account')
```

`withParents()` creates the account the required foreign key points at, so a child is one call. The database is a tmpdir file; nothing in the project is touched.

## What else it can do

- `createTestEnv` adds a principal (`actingAs`), a gate grid (`atLevel`) and migrates from committed files with `migrations:`
- `verifyGateLadder`, `verifyReadLadder`, `verifyFieldProtection`, `verifyConstraints` and `verifyRowPolicies` check the declared rules against real writes
- `defineFactory` and `Factory` take states (`users.admin().createOne()`) and a seeded RNG
- `has()`, `attach()` and `for()` build children, many-to-many rows and one named parent
- `Seeder` orders seed blocks with `dependsOn`, and `Seeder.once` makes one idempotent
- `snapshot` and `restore` seed once and reset between tests; `truncate` and `reset` empty tables
- `env.clock` freezes or moves the time a client reads
- `generateGateMatrix` and `generateValidationCases` emit permission and boundary cases from the schema
- `mutationScore` mutates the schema and reports what the suite misses

**In depth:** [Testing § createTestEnv](../../testing.md#createtestenv), [§ makeTestClient](../../testing.md#maketestclient), [§ Factory](../../testing.md#factory), [§ Relations](../../testing.md#relations), [§ Schema mutation testing](../../testing.md#schema-mutation-testing)
