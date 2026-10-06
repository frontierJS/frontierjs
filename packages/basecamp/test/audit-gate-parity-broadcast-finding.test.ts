// Audit 2.2 finding -- a graded broadcast is refused to EVERY recipient on every
// model whose read gate is above VISITOR(1). channels({ claims }) answers
// { workspaceId } and not the standing, so $readAs grades each socket at level 1.
// Nothing leaks (it fails closed); no live store of servers / variables / secrets
// ever updates. These FAIL until the channel claim carries the member's standing.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { build, http, type Fixture } from './audit-parity-harness.ts'
import { Driver } from './audit-parity-paths.ts'
import { toDataPrincipal } from '@frontierjs/junction'
let fx: Fixture, d: Driver
const uniq = () => Math.random().toString(36).slice(2, 8)
beforeAll(async () => { fx = await build(); d = new Driver(fx) }, 180_000)
afterAll(async () => { await d?.close(); await fx?.env?.close() })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function listen() {
  const got: Record<string, Array<{ name: string; data: any }>> = {}
  for (const w of ['outsider', 'viewer', 'developer', 'admin', 'owner'] as const) {
    const c = await d.wsClient(w); got[w] = []
    c.on('event', (name: string, data: any) => got[w].push({ name, data }))
  }
  await sleep(500)
  return got
}

test('control: the Data boundary DOES grade the same row per standing when it is told the standing', async () => {
  const db = fx.env.db as any
  const row = await (fx.env.system as any).server.findFirst({ where: { id: fx.rows.server.id } })
  const seen: Record<string, boolean | string[]> = {}
  for (const [w, role] of [['viewer', 'viewer'], ['developer', 'developer'], ['admin', 'admin']] as const) {
    const out = await db.$readAs('server', row, { id: fx.ids[w], workspaceId: fx.ws.id, memberRole: role })
    seen[w] = out ? Object.keys(out).filter(k => k === 'enrollTokenHash') : false
  }
  expect(seen).toEqual({ viewer: [], developer: [], admin: [] })
  const sec = await (fx.env.system as any).secret.findFirst({ where: { id: fx.rows.secret.id } })
  expect(await db.$readAs('secret', sec, { id: fx.ids.developer, workspaceId: fx.ws.id, memberRole: 'developer' })).toBeFalsy()
  const adm = await db.$readAs('secret', sec, { id: fx.ids.admin, workspaceId: fx.ws.id, memberRole: 'admin' })
  expect(adm).toBeTruthy(); expect('data' in adm).toBe(false)
})

test('a server patched over HTTP reaches every subscribed member at or above Server.read (2), without its guarded columns', async () => {
  const got = await listen()
  await http(fx, 'owner', 'PATCH', `/servers/${fx.rows.server.id}`, { name: 'bc-' + uniq() })
  await sleep(1200)
  const patched = (w: string) => got[w].filter(e => e.name === 'servers patched')
  expect({ outsider: patched('outsider').length, viewer: patched('viewer').length, developer: patched('developer').length, admin: patched('admin').length, owner: patched('owner').length })
    .toEqual({ outsider: 0, viewer: 1, developer: 1, admin: 1, owner: 1 })
  for (const w of ['viewer', 'developer', 'admin', 'owner']) expect(JSON.stringify(patched(w)[0].data)).not.toContain('HASH-OF-ENROLL-TOKEN')
})

test('a secret created over HTTP reaches administrators and owners only, and never carries `data`', async () => {
  const got = await listen()
  await http(fx, 'owner', 'POST', '/secrets', { name: 'bc-' + uniq(), data: '{"k":"PLAINTEXT-SECRET-DATA"}' })
  await sleep(1200)
  const created = (w: string) => got[w].filter(e => e.name === 'secrets created')
  expect({ viewer: created('viewer').length, developer: created('developer').length, admin: created('admin').length, owner: created('owner').length })
    .toEqual({ viewer: 0, developer: 0, admin: 1, owner: 1 })
  expect(JSON.stringify(created('admin')[0].data)).not.toContain('PLAINTEXT-SECRET-DATA')
})

test('an UPDATE refused to a recipient does not become a `removed` frame for the row they are looking at', async () => {
  // removalFrameFor() turns a refused update into `{ id }` removal so a revoked
  // reader's store drops the row. With every recipient refused for the wrong
  // reason, every patch tells every open store to drop the row it just edited.
  const got = await listen()
  await http(fx, 'owner', 'PATCH', `/servers/${fx.rows.server.id}`, { name: 'bc-' + uniq() })
  await sleep(1200)
  const dropped = ['viewer', 'developer', 'admin', 'owner'].filter(w => got[w].some(e => e.name === 'servers removed'))
  expect(dropped).toEqual([])
})
