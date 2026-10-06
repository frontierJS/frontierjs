// Audit 2.2 finding -- workspaces.members reads `include: { user: true }` through
// asSystem() after a membership check, so a viewer (2) gets every colleague's
// whole User row. At the Data boundary the same viewer reads ONLY their own User
// row (@@allow('read', id == auth().id || auth().level >= 4)). FAILS until the
// roster is projected or graded.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { build, type Fixture } from './audit-parity-harness.ts'
import { Driver, summarize } from './audit-parity-paths.ts'
let fx: Fixture, d: Driver
beforeAll(async () => { fx = await build(); d = new Driver(fx) }, 180_000)
afterAll(async () => { await d?.close(); await fx?.env?.close() })

test('control: the Data boundary shows a viewer one User row', async () => {
  expect(summarize(await d.call('job-caller-db', 'viewer', 'users', 'find')).n).toBe(1)
})

test('a viewer reading the roster is shown no more of a colleague\'s User row than the User model lets them read', async () => {
  const r = await fetch(`${fx.env.url}/workspaces/${fx.ws.id}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${fx.tokens.viewer}`, 'x-workspace-id': fx.ws.id, 'x-service-method': 'members' }, body: '{}' })
  const rows: any[] = (await r.json() as any).data
  const others = rows.filter(m => m.userId !== fx.ids.viewer)
  expect(others.length).toBeGreaterThan(0)
  const exposed = others.flatMap(m => Object.keys(m.user ?? {}).filter(k => ['email', 'scopes', 'isSystemAdmin', 'status', 'kind', 'accountId', 'emailVerified'].includes(k)))
  expect(exposed).toEqual([])
})
