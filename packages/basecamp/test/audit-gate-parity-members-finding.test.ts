// Audit 2.2 finding -- workspaces.members reads the roster through asSystem()
// after a membership check, so the User read policy (a viewer reads ONLY their
// own row below level 4) never runs on it. FJS-D619 rules the roster is meant
// for every member and carries a colleague's name, address and avatar, nothing
// more (FJS-1862). The key form's bot list read `kind` off that roster, so it is
// api-keys.owners now, and that is graded here beside it.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { build, type Fixture, type Who } from './audit-parity-harness.ts'
import { Driver, summarize } from './audit-parity-paths.ts'
import { grantsFor } from '../api/src/core/capabilities.ts'
let fx: Fixture, d: Driver
const bots: Record<string, string> = {}
beforeAll(async () => {
  fx = await build(); d = new Driver(fx)
  const sys = fx.env.system as any
  for (const role of ['developer', 'owner']) {
    const u = await sys.user.create({ data: { email: `bot-${role}-${Date.now()}@bots.invalid`, displayName: `Bot ${role}`, kind: 'bot', status: 'active' } })
    await sys.workspaceMember.create({ data: { workspaceId: fx.ws.id, userId: u.id, role, capabilities: grantsFor(role), acceptedAt: new Date().toISOString() } })
    bots[role] = u.id
  }
}, 180_000)
afterAll(async () => { await d?.close(); await fx?.env?.close() })

const call = (who: Who, service: string, method: string, id = '') =>
  fetch(`${fx.env.url}/${service}${id ? `/${id}` : ''}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${fx.tokens[who]}`, 'x-workspace-id': fx.ws.id, 'x-service-method': method }, body: '{}' })

test('control: the Data boundary shows a viewer one User row', async () => {
  expect(summarize(await d.call('job-caller-db', 'viewer', 'users', 'find')).n).toBe(1)
})

test('a viewer reading the roster is shown a colleague\'s name, address and avatar and nothing else', async () => {
  const r = await call('viewer', 'workspaces', 'members', fx.ws.id)
  expect(r.status).toBe(200)
  const rows: any[] = (await r.json() as any).data
  const others = rows.filter(m => m.userId !== fx.ids.viewer)
  expect(others.length).toBeGreaterThan(0)
  const allowed = ['id', 'name', 'displayName', 'email', 'avatarUrl']
  expect(others.flatMap(m => Object.keys(m.user ?? {}).filter(k => !allowed.includes(k)))).toEqual([])
  expect(others.every(m => typeof m.user?.email === 'string')).toBe(true)
})

test('owners lists the bots an admin may issue a key to, and none senior to them', async () => {
  const r = await call('admin', 'api-keys', 'owners')
  expect(r.status).toBe(200)
  const ids = ((await r.json() as any).data as any[]).map(b => b.userId)
  expect(ids).toEqual([bots.developer])
})

test('owners lists every bot to an owner', async () => {
  const ids = ((await (await call('owner', 'api-keys', 'owners')).json() as any).data as any[]).map(b => b.userId)
  expect(ids.sort()).toEqual([bots.developer, bots.owner].sort())
})

test('owners is refused below admin, as create is', async () => {
  for (const who of ['viewer', 'developer'] as const) expect([who, (await call(who, 'api-keys', 'owners')).status]).toEqual([who, 403])
})
