# Grading the checks

A suite that passes says nothing about what it does not look at. `mutationScore` breaks the schema on purpose, one attribute at a time, and runs the checks derived from the **original** schema against a database built from each broken copy. A change nothing notices is a hole in the checks, and it names itself.

```lite
model Account {
  id    Int    @id
  name  String @length(1, 80)
  token String? @guarded
  @@gate(2.4.4.5)
}
```

```js
import { readFileSync } from 'node:fs'
import { createTestEnv, mutationScore } from '@frontierjs/testing'

const schema = readFileSync('./schema.lite', 'utf8')

const result = await mutationScore({
  schema,
  build: (text) => createTestEnv({ schema: text }),
  kinds: ['gate-drop', 'gate-lower', 'guarded-drop', 'validator-widen'],
})

if (result.survived.length) throw new Error(`${result.survived.length} changes nothing noticed`)
console.log(`${result.killed} of ${result.graded} mutants caught`)
```

The direction is the whole design: expectations come from the original and the database comes from the mutant. Derive both from the mutant and dropping a `@@gate` removes the rows that would have caught it, so every mutant survives and the score reads 100%.

## What else it can do

- `fli test:mutate` runs it for the app in the working directory and prints the survivors with their file and line
- `--kinds gate-drop,allow-drop` narrows a run, since each mutant costs a database
- `--suite "bun test api/test"` also runs your own tests on each mutant the derived checks missed
- The kinds are `gate-drop`, `gate-lower`, `allow-drop`, `deny-drop`, `guarded-drop`, `encrypted-drop`, `unique-drop`, `validator-drop`, `validator-widen`, `relator-tighten` and `relator-loosen`
- The mutation space is enumerable, one mutant per attribute occurrence, so a run is bounded
- A mutant the parser or the framework refuses counts as caught, and one where the suite itself fell over is `errored` and counts for nothing
- A survivor is a fact about the checks, not the schema; a `@unique` on a nullable column and a create-only `@@allow` are the two known and expected ones
- An attribute named inside a comment is prose and is never mutated

**In depth:** [Testing § Schema mutation testing](../../../../litestone/docs/testing.md#schema-mutation-testing), [test:mutate](../../../../cli/commands/test/mutate.md)
