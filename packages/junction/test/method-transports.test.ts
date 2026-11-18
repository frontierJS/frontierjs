// test/method-transports.test.ts
//
// A custom method an internal route calls in-process had to be listed in
// `methods:` to be admitted at all, which offered it over HTTP and the socket
// too, so the app refused `$.transport !== 'internal'` by hand (`FJS-4345`).
// `transports:` on the entry states who may reach it (`FJS-D2237`).

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createApp, createService, channels } from '../index.ts'
import { buildService } from '../src/core/service.ts'
import { manifest } from '../src/plugins/manifest/index.ts'
import { openapi } from '../src/plugins/openapi/index.ts'

const repositories = createService({
  name: 'repositories',
  methods: ['find', { method: 'pushed', transports: ['internal'] }, 'ping'],
  async find(_ctx: unknown) { return [] },
  async pushed(ctx: any)    { return { recorded: ctx.id ?? null } },
  async ping(_ctx: any)     { return { pong: true } },
})

let app: any

beforeAll(async () => {
  app = createApp({ config: { port: 0 } })
  app.services.register(repositories)
  app.configure(channels())
  app.configure(manifest({ devOnly: false }))
  app.configure(openapi({ title: 'T', version: '1' }))
  app.post('/hooks/post-receive', async (ctx: any) =>
    ctx.json(await app.service('repositories').call('pushed', 7, {})))
  await app.start()
})

afterAll(async () => { await app?.stop() })

test('an in-process caller reaches a method declared for internal only', async () => {
  expect(await app.service('repositories').call('pushed', 3, {})).toEqual({ recorded: 3 })
})

test('a raw route reaches it in-process', async () => {
  const res = await fetch(`http://localhost:${app.http.port}/hooks/post-receive`, { method: 'POST' })
  expect(res.status).toBe(200)
})

test('HTTP is refused with a 405, and a method declaring none still answers', async () => {
  const post = (method: string) => fetch(`http://localhost:${app.http.port}/repositories/1`, {
    method:  'POST',
    headers: { 'content-type': 'application/json', 'x-service-method': method },
    body:    '{}',
  })
  expect((await post('pushed')).status).toBe(405)
  expect((await post('ping')).status).toBe(200)
})

test('the socket is refused with a 405', async () => {
  const ws = new WebSocket(`ws://localhost:${app.http.port}/ws`)
  await new Promise<void>((ok, no) => { ws.onopen = () => ok(); ws.onerror = () => no(new Error('ws')) })
  const frame = await new Promise<any>(ok => {
    ws.onmessage = (e: any) => {
      const f = JSON.parse(e.data)
      if (f.id === 'c1') ok(f)
    }
    ws.send(JSON.stringify({ type: 'service_call', id: 'c1', service: 'repositories', method: 'pushed', meta: { id: 1 } }))
  })
  ws.close()
  expect(frame.type).toBe('service_error')
  expect(frame.error?.code ?? frame.error?.status).toBe(405)
})

test('an agent tool call is refused, since mcp is not internal (FJS-D609)', async () => {
  await expect(app.service('repositories').call('pushed', 3, {}, { transport: 'mcp' }))
    .rejects.toMatchObject({ code: 405 })
})

test('the manifest and OpenAPI do not advertise it, and describe() names the declaration', async () => {
  const man = await (await fetch(`http://localhost:${app.http.port}/manifest`)).json()
  const svc = man.services.find((s: any) => s.name === 'repositories')
  expect(svc.methods).toContain('ping')
  expect(svc.methods).not.toContain('pushed')

  const spec = JSON.stringify(await (await fetch(`http://localhost:${app.http.port}/openapi.json`)).json())
  expect(spec).toContain('ping')
  expect(spec).not.toContain('pushed')

  expect(app.services.get('repositories').describe().transports).toEqual({ pushed: ['internal'] })
})

test('a transport that is not one is refused at build', () => {
  expect(() => buildService(createService({
    name: 'bad',
    methods: [{ method: 'pushed', transports: ['intern'] }],
    async pushed() { return null },
  } as any))).toThrow(/transports/)
})
