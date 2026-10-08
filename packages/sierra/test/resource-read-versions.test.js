/**
 * test/resource-read-versions.test.js
 *
 * Which rows a resource keeps the read `@version` of, and what a patch of a row
 * it holds none for does (`FJS-D468`, `FJS-1309`).
 *
 * The map was the last 200 rows read, in insertion order. A board of 300 rows
 * forgot its first 100, and a row that arrived by push was never read at all,
 * so an edit to either went up with no version and the server refused it in
 * words about `asSystem()`. Now a row a view still HOLDS is never evicted, the
 * first sight of a row in a held view is its read, and a patch that still has
 * no version is refused here, by name, before anything is sent or queued.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'
// Junction by relative path — `bun install` resolves workspace:* to a copy.
import { Store } from '../../junction/src/client/index.ts'
import { NodeRegistry } from '../../junction/src/client/nodes.ts'

const calls = []
const rows = new Map()
let registry = new NodeRegistry()

vi.mock('@frontierjs/sierra/resource', () => ({
  getClient: () => ({
    get nodes() { return registry },
    service: () => ({
      get:   async (id) => { calls.push(['get', id]); return rows.get(id) ?? null },
      find:  async () => ({ data: [...rows.values()] }),
      patch: async (id, data) => {
        calls.push(['patch', id, data])
        const next = { ...(rows.get(id) ?? {}), ...data, version: (rows.get(id)?.version ?? 0) + 1 }
        rows.set(id, next)
        return next
      },
      on: () => {},
    }),
    // Junction's real Store, bound to the real registry, so a list HOLDS the
    // nodes of the rows it shows — which is what eviction asks about.
    resource: (_name, idField, { model }) => {
      const store = new Store()
      store.bind({ registry, model, idField })
      return {
        store,
        stale: { reset() {} },
        load: async () => { const list = [...rows.values()]; store.set(list); return list },
        // Junction's rule about WHEN to read: a row a node already holds is not
        // read again.
        record: (id, { load }) => {
          const release = registry.node(model, id).hold()
          const held = registry.peek(model, id)?.get()
          const ready = held != null ? Promise.resolve(held) : load()
          return { id, ready, release }
        },
      }
    },
  }),
}))

const { createResource } = await import('../src/resource/resource.js')
const { registerSchemas } = await import('../src/resource/schema-registry.js')
const { parse } = await import('../../litestone/src/core/parser.js')
const { generateJsonSchema } = await import('../../litestone/src/jsonschema.js')

const { schema, valid, errors } = parse(`
  model Issue {
    id      Int    @id
    title   String?
    version Int    @version
  }
`)
if (!valid) throw new Error(`fixture schema is invalid: ${errors.join('; ')}`)
const DEFS = generateJsonSchema(schema, { mode: 'update' }).$defs

beforeEach(() => {
  registerSchemas(DEFS, ['Issue'])
  registry = new NodeRegistry()
  calls.length = 0
  rows.clear()
  // One Linear board: five columns of 60.
  for (let id = 1; id <= 300; id++) rows.set(id, { id, title: `issue ${id}`, version: 3 })
})

const lastPatch = () => calls.filter(c => c[0] === 'patch').at(-1)?.[2]

describe('a row a view holds is never forgotten', () => {
  test('a list of 300 rows keeps the version of its FIRST row', async () => {
    const r = createResource('issues', { model: 'Issue' })
    await r.load()
    expect(r.version(1)).toBe(3)
    await r.service.patch(1, { title: 'dragged' })
    expect(lastPatch()).toEqual({ title: 'dragged', version: 3 })
  })

  test('an unheld find() row past the cap is still evicted', async () => {
    const r = createResource('issues', { model: 'Issue' })
    await r.service.find({})
    expect(r.version(1)).toBeNull()
    expect(r.version(300)).toBe(3)
  })
})

describe('the first sight of a row in a held view is its read', () => {
  test('a row that arrived by push is patched with the version the screen showed', async () => {
    const r = createResource('issues', { model: 'Issue' })
    await r.load()
    rows.set(301, { id: 301, title: 'filed by Léa', version: 1 })
    r.store.upsert(rows.get(301))
    expect(r.version(301)).toBe(1)
    await r.service.patch(301, { title: 'dragged by Ana' })
    expect(lastPatch()).toEqual({ title: 'dragged by Ana', version: 1 })
  })

  test('a push after the read still does not move it', async () => {
    const r = createResource('issues', { model: 'Issue' })
    await r.load()
    r.store.upsert({ id: 1, title: 'edited elsewhere', version: 4 })
    expect(r.version(1)).toBe(3)
  })

  test('record() over a node another view already holds remembers what it shows', async () => {
    const r = createResource('issues', { model: 'Issue' })
    registry.write('Issue', { id: 400, title: 'sub-issue', version: 2 })
    const release = registry.node('Issue', 400).hold()
    const view = r.record(400)
    await view.ready
    expect(calls.some(c => c[0] === 'get')).toBe(false)
    expect(r.version(400)).toBe(2)
    await r.service.patch(400, { title: 'Done' })
    expect(lastPatch()).toEqual({ title: 'Done', version: 2 })
    view.release(); release()
  })
})

describe('a patch with no version to carry is refused on the device', () => {
  test('a row never read or seen: refused by name, nothing sent', async () => {
    const r = createResource('issues', { model: 'Issue' })
    const err = await r.service.patch(1, { title: 'x' }).catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('VERSION_UNREAD')
    expect(err.message).toContain('reload')
    expect(err.message).not.toContain('asSystem')
    expect(calls.filter(c => c[0] === 'patch')).toEqual([])
  })

  test('an unheld find() row that was evicted is refused the same way', async () => {
    const r = createResource('issues', { model: 'Issue' })
    await r.service.find({})
    const err = await r.service.patch(1, { title: 'x' }).catch(e => e)
    expect(err.code).toBe('VERSION_UNREAD')
    expect(calls.filter(c => c[0] === 'patch')).toEqual([])
  })

  test('an explicit version is the caller\'s own control and goes through', async () => {
    const r = createResource('issues', { model: 'Issue' })
    await r.service.patch(1, { title: 'x', version: 3 })
    expect(lastPatch()).toEqual({ title: 'x', version: 3 })
  })
})
