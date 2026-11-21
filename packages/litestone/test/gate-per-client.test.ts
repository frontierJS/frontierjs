// One GatePlugin installed into two clients (`FJS-1267`). A tenant registry
// forwards its `plugins` to every client it opens, and an app exports one
// resolver from one module, so a second client is the ordinary case. Each
// client must go on grading against its OWN schema's ladder — a second one
// that tightened a gate made the first refuse, and one that loosened it made
// the first admit, with nothing to see.
import { describe, it, expect, afterAll } from 'bun:test'
import { createClient, GatePlugin, LEVELS } from '../src/index.js'

const withGate = (gate: string) => `
model Author {
  id    String @id
  notes Note[]
  @@gate(0)
}
model Note {
  id       String @id
  authorId String
  author   Author @relation(fields: [authorId], references: [id])
  @@gate(${gate})
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

// A GatePlugin built by a second copy of litestone (`FJS-4382`): a script
// outside an app resolves the bun cache's copy for `./testing` and the app's
// linked one for its gate module. `instanceof` is false across copies, so the
// client added the default resolver beside the app's and graded a level-4
// principal at the default's 3, and createTestEnv's ladder kept the app's gate
// under every level it held. The copy is the real src/ tree, not a stand-in.
describe('a GatePlugin from a second litestone copy', () => {
  const roots: string[] = []
  afterAll(async () => {
    const { rmSync } = await import('node:fs')
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })
  const copy = async () => {
    const { mkdtempSync, cpSync, symlinkSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join, resolve } = await import('node:path')
    const pkg  = resolve(import.meta.dir, '..')
    const root = mkdtempSync(join(tmpdir(), 'litestone-copy-'))
    roots.push(root)
    cpSync(join(pkg, 'src'), join(root, 'src'), { recursive: true })
    cpSync(join(pkg, 'package.json'), join(root, 'package.json'))
    symlinkSync(join(pkg, 'node_modules'), join(root, 'node_modules'))
    return import(join(root, 'src/plugins/gate.js'))
  }
  const schema = `
model Note {
  id String @id
  @@gate(4.4.4.5)
}
`

  it('is the gate the client runs, so the app grades its own principal', async () => {
    const { GatePlugin: Foreign } = await copy()
    expect(Foreign).not.toBe(GatePlugin)
    const db = await createClient({ schema, db: ':memory:', plugins: [new Foreign({ getLevel: () => LEVELS.USER })] })
    await db.asSystem().note.create({ data: { id: 'n1' } })
    expect(await db.$setAuth({ id: 'u1' }).note.findMany()).toHaveLength(1)
    db.$close()
  })

  it('is the gate createTestEnv replaces at each level of its ladder', async () => {
    const { GatePlugin: Foreign } = await copy()
    const { createTestEnv } = await import('../src/testing.js')
    const env = await createTestEnv({ schema, plugins: [new Foreign({ getLevel: () => LEVELS.USER })] })
    await env.system.note.create({ data: { id: 'n1' } })
    const admin = await env.atLevel(LEVELS.ADMINISTRATOR)
    expect((await admin.note.delete({ where: { id: 'n1' } })).id).toBe('n1')
    await env.close()
  })
})
