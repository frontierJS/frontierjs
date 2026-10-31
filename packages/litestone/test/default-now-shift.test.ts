// `@default(now() + 4h)` (FJS-3697): the instant a policy and `@@require`
// already read, shifted, as a default the client stamps at create time.

import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
model GlassBreak {
  id        Int      @id @default(autoincrement())
  reason    String
  expiresAt DateTime @default(now() + 4h)
  startedAt DateTime @default(now() - 1d)
}
`

const NOW = new Date('2026-01-01T00:00:00.000Z')

describe('@default(now() + duration)', () => {
  it('stamps the shifted instant from the client clock', async () => {
    const db  = await createClient({ schema: SCHEMA, db: ':memory:', now: () => NOW })
    const row = await db.glassBreak.create({ data: { reason: 'x' } })
    expect(row.expiresAt).toBe('2026-01-01T04:00:00.000Z')
    expect(row.startedAt).toBe('2025-12-31T00:00:00.000Z')
  })

  it('a supplied value wins', async () => {
    const db  = await createClient({ schema: SCHEMA, db: ':memory:', now: () => NOW })
    const row = await db.glassBreak.create({ data: { reason: 'x', expiresAt: '2030-01-01T00:00:00.000Z' } })
    expect(row.expiresAt).toBe('2030-01-01T00:00:00.000Z')
  })

  it('the column DEFAULT floor is shifted too', async () => {
    const db  = await createClient({ schema: SCHEMA, db: ':memory:' })
    const r = db.$rawDbs.main.query(`SELECT dflt_value FROM pragma_table_info('glass_break') WHERE name='expiresAt'`).get()
    expect(String(r?.dflt_value)).toContain('+4 hours')
  })
})
