// One CapabilityPlugin / ExternalRefPlugin installed into two clients
// (`FJS-1380`, the `FJS-1267` shape). A tenant registry forwards its `plugins`
// to every client it opens, so a second onInit on the same instance is the
// ordinary case. Each client keeps grading, and resolving, against its OWN
// schema: a second client's grid replaced the first's, and its File columns
// were merged into the first's — nothing reports either.
import { describe, it, expect } from 'bun:test'
import { createClient, ExternalRefPlugin } from '../src/index.js'
import { CapabilityPlugin } from '../src/plugins/capability.js'

const grid = (decl: string) => `
model Invoice {
  id  Int    @id @default(autoincrement())
  ref String
  ${decl}
}
model Server {
  id Int @id @default(autoincrement())
  @@capabilities(all)
}
`

describe('one CapabilityPlugin, two clients', () => {
  it('a client whose model declares no grid keeps its own answer after a second client installs', async () => {
    const plugin = new CapabilityPlugin()
    const a = await createClient({ schema: grid('@@capabilities'), db: ':memory:', plugins: [plugin] })
    const b = await createClient({ schema: grid(''), db: ':memory:', plugins: [plugin] })
    const caller = { id: 1, capabilities: [] as string[] }

    // a declares Invoice's grid: no grant, no create.
    await expect(a.$setAuth(caller).invoice.create({ data: { ref: 'A' } })).rejects.toThrow(/Invoice\.create/)
    // b declares none: the grid is not b's to hold.
    expect((await b.$setAuth(caller).invoice.create({ data: { ref: 'B' } })).ref).toBe('B')
    a.$close(); b.$close()
  })
})

class RefStore extends ExternalRefPlugin {
  fieldType = 'File'
  async serialize(value: any) { return { key: value } }
  async resolve(ref: any) { return `resolved:${ref.key}` }
}

describe('one ExternalRefPlugin, two clients', () => {
  it('a second client\'s File columns are not merged into the first\'s', async () => {
    const plugin = new RefStore()
    const doc = (col: string) => `model Doc { id Int @id @default(autoincrement())  cover ${col} }`
    const a = await createClient({ schema: doc('String'), db: ':memory:', plugins: [plugin] })
    const b = await createClient({ schema: doc('File?'), db: ':memory:', plugins: [plugin] })

    // a's cover is a plain String: no store may touch it.
    expect((await a.doc.create({ data: { cover: 'k1' } })).cover).toBe('k1')
    // b's cover is a File and is still stored as a ref.
    const row = await b.doc.create({ data: { cover: 'k2' } })
    expect(row.cover).toEqual({ key: 'k2' })
    a.$close(); b.$close()
  })
})
