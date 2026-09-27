// One GatePlugin installed into two clients (`FJS-1267`). A tenant registry
// forwards its `plugins` to every client it opens, and an app exports one
// resolver from one module, so a second client is the ordinary case. Each
// client must go on grading against its OWN schema's ladder — a second one
// that tightened a gate made the first refuse, and one that loosened it made
// the first admit, with nothing to see.
import { describe, it, expect } from 'bun:test'
import { createClient, GatePlugin, LEVELS } from '../src/index.js'

const withGate = (gate: string) => `
model Author {
  id    String @id
  notes Note[]
}
model Note {
  id       String @id
  authorId String
  author   Author @relation(fields: [authorId], references: [id])
  @@gate("${gate}")
}
`

async function seeded(schema: string, plugin: GatePlugin) {
  const db = await createClient({ schema, db: ':memory:', plugins: [plugin] })
  await db.asSystem().author.create({ data: { id: 'a1' } })
  await db.asSystem().note.create({ data: { id: 'n1', authorId: 'a1' } })
  return db
}

const user = { id: 'u1' }

describe('one GatePlugin, two clients', () => {
  it('a second client that TIGHTENS a gate leaves the first one admitting', async () => {
    const gate = new GatePlugin({ getLevel: () => LEVELS.USER })
    const a = await seeded(withGate('4.4.4.4'), gate)
    expect(await a.$setAuth(user).note.findMany()).toHaveLength(1)

    const b = await seeded(withGate('8.4.4.4'), gate)
    await expect(b.$setAuth(user).note.findMany()).rejects.toThrow(/requires SYSTEM/)

    expect(await a.$setAuth(user).note.findMany()).toHaveLength(1)
    expect(await a.$setAuth(user).author.findMany({ include: { notes: true } })).toHaveLength(1)
    b.$close()
    expect(await a.$setAuth(user).note.findMany()).toHaveLength(1)
    a.$close()
  })

  it('a second client that LOOSENS a gate leaves the first one refusing', async () => {
    const gate = new GatePlugin({ getLevel: () => LEVELS.USER })
    const a = await seeded(withGate('8.4.4.4'), gate)
    const b = await seeded(withGate('4.4.4.4'), gate)
    expect(await b.$setAuth(user).note.findMany()).toHaveLength(1)

    await expect(a.$setAuth(user).note.findMany()).rejects.toThrow(/requires SYSTEM/)
    await expect(a.$setAuth(user).author.findMany({ include: { notes: true } })).rejects.toThrow(/requires SYSTEM/)
    a.$close(); b.$close()
  })
})
