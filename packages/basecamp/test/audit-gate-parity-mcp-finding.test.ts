// Audit 2.2 finding -- `internalOnly()` is `ctx.transport !== 'internal'`, and
// the MCP plugin dispatches through app.service() with no transport, so an
// agent's tool call IS an internal call. HTTP answers 404 to the same methods.
// These FAIL until an MCP call is refused the methods HTTP/WS refuse.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { build, type Fixture } from './audit-parity-harness.ts'
import { Driver } from './audit-parity-paths.ts'
let fx: Fixture, d: Driver
beforeAll(async () => { fx = await build(); d = new Driver(fx) }, 180_000)
afterAll(async () => { await d?.close(); await fx?.env?.close() })

async function release() {
  const sys = fx.env.system as any
  const envRow = await sys.environment.findFirst({ where: { workspaceId: fx.ws.id } })
  const app = await sys.app.create({ data: { workspaceId: fx.ws.id, environmentId: envRow.id, name: 'A', slug: 'a-' + Math.random().toString(36).slice(2, 6) } })
  const dep = await sys.deployment.create({ data: { workspaceId: fx.ws.id, appId: app.id, environmentId: envRow.id, status: 'pending' } })
  return { sys, app, dep }
}
const viaWire = (w: 'viewer' | 'developer', svc: string, id: string, method: string, body: unknown) =>
  fetch(`${fx.env.url}/${svc}/${id}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${fx.tokens[w]}`, 'x-workspace-id': fx.ws.id, 'x-service-method': method }, body: JSON.stringify(body) })

test('control: over HTTP and WS the engine-only methods answer 404 to a viewer', async () => {
  const { dep } = await release()
  expect((await viaWire('viewer', 'deployments', dep.id, 'finishRun', { status: 'failed' })).status).toBe(404)
  const ws = await d.wsClient('viewer')
  await expect((ws.service('deployments') as any).finishRun?.(dep.id, { status: 'failed' }) ?? Promise.reject(new Error('no such'))).rejects.toBeTruthy()
})

test('a VIEWER (2) cannot finish a release through MCP: deployments.finishRun is internalOnly and Deployment.update is SYSTEM', async () => {
  const { sys, app, dep } = await release()
  const c: any = await d.mcpClient('viewer')
  const r = await c.callTool({ name: 'deployments_finishRun', arguments: { id: dep.id, data: { status: 'failed' } } }).catch((e: any) => ({ isError: true, content: [{ text: String(e) }] }))
  expect({ refused: !!r.isError, deployment: (await sys.deployment.findFirst({ where: { id: dep.id } })).status, appStatus: (await sys.app.findFirst({ where: { id: app.id } })).status })
    .toEqual({ refused: true, deployment: 'pending', appStatus: 'unknown' })
})

test('a DEVELOPER (4) cannot forge a server event through MCP: servers.logEvent is internalOnly', async () => {
  const c: any = await d.mcpClient('developer')
  const r = await c.callTool({ name: 'servers_logEvent', arguments: { id: fx.rows.server.id, data: { kind: 'unreachable', message: 'forged-by-agent' } } }).catch((e: any) => ({ isError: true, content: [{ text: String(e) }] }))
  const forged = await (fx.env.system as any).serverEvent.findMany({ where: { serverId: fx.rows.server.id, message: 'forged-by-agent' } })
  expect({ refused: !!r.isError, forged: forged.length }).toEqual({ refused: true, forged: 0 })
})
