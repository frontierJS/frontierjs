// FJS-3930. `file File? @digest(sha256)` fills the `sha256` column from the bytes,
// and states a value there only to have it refused. The auto factory built that
// column from its `@regex`, so every model reaching the owner failed to seed on
// the gate ladder, and the override the message named was never read by it.

import { describe, it, expect } from 'bun:test'
import { createTestEnv, Factory } from '../src/testing.js'

const SCHEMA = `
model Asset {
  id     Int     @id
  name   String
  file   File?   @digest(sha256)
  sha256 String? @regex("^[0-9a-f]{64}$")
  @@gate(0)
}
model AssetNote {
  id      Int    @id
  assetId Int
  asset   Asset  @relation(fields: [assetId], references: [id])
  body    String
  @@gate(0)
}
`

describe('a @digest target on the gate ladder (FJS-3930)', () => {
  it('is left to the bytes, so the model and its children seed', async () => {
    const env = await createTestEnv({ schema: SCHEMA })
    expect(await env.verifyGateLadder()).toEqual([])
  })

  it('a hand factory in createTestEnv({ factories }) is what the ladder seeds with', async () => {
    let used = 0
    class AssetFactory extends Factory {
      model = 'Asset'
      definition(seq: number) { used++; return { id: seq, name: `Hand ${seq}` } }
    }
    const env = await createTestEnv({ schema: SCHEMA, factories: { asset: AssetFactory } })
    expect(await env.verifyGateLadder()).toEqual([])
    expect(used).toBeGreaterThan(0)
  })
})
