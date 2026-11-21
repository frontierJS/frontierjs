# The checks a schema contains

A gate, a row policy, a `@guarded` column and a `@length` are declarations, and a declaration can be executed. Four calls on the env run them against a real database, with no fixtures and no assertions to write, and each answers an array of mismatches, each with a `message` that is already a sentence.

```lite
model Account {
  id    Int    @id
  name  String @length(1, 80)
  token String? @guarded
  @@gate(2.4.4.5)
}
```

```js
import { createTestEnv } from '@frontierjs/testing'

const env = await createTestEnv({ schema: './schema.lite', autoFactories: true })

const found = [
  ...await env.verifyGateLadder(),
  ...await env.verifyFieldProtection(),
  ...await env.verifyConstraints(),
  ...await env.verifyRowPolicies(),
]
if (found.length) throw new Error(found.map((row) => row.message).join('\n'))

await env.close()
```

A passing suite is `toEqual([])`, and a failing one's `message` says what disagreed, such as `Server.read at level 1 (VISITOR) — the schema says deny, the client says allow`. They are four separate boundaries and a model can pass one while failing another, so a suite keeps them as four tests.

## What else it can do

- `verifyGateLadder()` checks every declared level of every gated model for read, create, update and delete
- `verifyReadLadder()` checks reads alone
- `verifyFieldProtection()` reads back every `@guarded`, `@encrypted` and `@secret` column
- `verifyConstraints()` tries each validator with values on both sides of its boundary, and runs as system so a gate refusing first cannot make every case read as rejected
- `verifyRowPolicies()` checks each `@@allow` and `@@deny` against rows on both sides of its predicate
- `verifyTenantIsolation()` checks that one tenant cannot see another's rows
- A row with `got: "skipped"` is a case the check could not grade, such as a create refused by a required `@guarded` field before the gate was asked; its `message` says why
- A throw that is not a refusal counts as a mismatch, never a pass, so an `@@external` model with no table fails rather than looks gated
- `generateGateMatrix` and `generateValidationCases` emit the permission and boundary cases as data, for a test that wants to loop over them itself
- `fli test:access` writes `db/access.snapshot.md`, the same ladder as a file a reviewer can read, and `fli test:snapshots` rechecks every committed snapshot
- `fli tutor:test` is the lesson that builds an app and runs these four checks against it

**In depth:** [Testing § createTestEnv](../../../../litestone/docs/testing.md#createtestenv), [§ verifyRowPolicies](../../../../litestone/docs/testing.md#verifyrowpolicies), [test:access](../../../../cli/commands/test/access.md), [tutor:test](../../../../cli/commands/tutor/test.md)
