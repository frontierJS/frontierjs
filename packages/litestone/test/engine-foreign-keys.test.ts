// engine-foreign-keys.test.ts — an engine that holds a window says so (`FJS-D485`, `FJS-1373`).
//
// A device keeps a partial window of the server's rows, so a child naming a
// parent outside it is the ordinary case and not corruption. The engine states
// `foreignKeys: false` and the connection opens without enforcing them; the
// server enforced them already. An engine that says nothing keeps them on.

import { describe, it, expect, afterEach } from 'bun:test'
import { setEngine, currentEngine } from '../src/core/engine.js'
import { createClient } from '../src/index.js'

const SCHEMA = `
model Sheet {
  id    Int @id
  lines Line[]
}
model Line {
  id      Int @id
  sheetId Int
  sheet   Sheet @relation(fields: [sheetId], references: [id])
}
`

const original = currentEngine()
afterEach(() => { setEngine(original) })

describe('foreign keys on a connection', () => {
  it('are enforced for an engine that says nothing', async () => {
    const db = await createClient({ schema: SCHEMA, db: ':memory:' })
    await expect(db.asSystem().line.create({ data: { id: 1, sheetId: 99 } })).rejects.toThrow(/names no Sheet/)
  })

  it('are not enforced for an engine that declares foreignKeys: false', async () => {
    setEngine({ ...original, foreignKeys: false })
    const db = await createClient({ schema: SCHEMA, db: ':memory:' })
    await db.asSystem().line.upsertMany({ data: [{ id: 1, sheetId: 99 }] })
    expect((await db.asSystem().line.findMany({ where: {} })).length).toBe(1)
  })
})
