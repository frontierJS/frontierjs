// test/policy-no-assembly.test.ts
//
// FJS-D513: a flow expression assembles values with a template and an object,
// and the grammar is shared with `.lite` policies. A policy asks a question of a
// row and compileSql has no SQL for either, so the parse refuses both by name
// rather than accepting a form one interpreter cannot run.
import { describe, test, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const schema = (allow: string) => `
  model Post {
    id     Int    @id
    status String
    @@allow('read', ${allow})
  }
`

describe('a policy refuses the flow-only value forms', () => {
  test('a template literal', async () => {
    await expect(createClient({ schema: schema('`x${status}` == status') } as never))
      .rejects.toThrow(/template literal builds a value/)
  })

  test('an object', async () => {
    await expect(createClient({ schema: schema('{ a: 1 } == status') } as never))
      .rejects.toThrow(/object builds a value/)
  })
})
