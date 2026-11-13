// FJS-4201. `id String @id @lower @regex("^[a-z0-9]+$")` is a slug-keyed table.
// The auto factory wrote '{Model}-{seq}' for every String @id, which the
// pattern refuses, so the gate ladder and test:mutate failed on the id column.

import { describe, it, expect } from 'bun:test'
import { parse } from '../src/core/parser.js'
import { createTestEnv, generateFactory } from '../src/testing.js'

const SCHEMA = `
model Font {
  id     String @id @lower @regex("^[a-z0-9]+$")
  family String @length(1, 120)
  @@gate(0)
}
`

describe('a String @id carrying @regex (FJS-4201)', () => {
  it('the factory builds an id the pattern accepts', async () => {
    const def = generateFactory(parse(SCHEMA).schema, 'Font')
    const ids = [1, 2, 3].map(seq => (def(seq, null) as any).id)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+$/)
    expect(new Set(ids).size).toBe(3)
  })

  it('the gate ladder seeds the model', async () => {
    const env = await createTestEnv({ schema: SCHEMA })
    expect(await env.verifyGateLadder()).toEqual([])
  })
})
