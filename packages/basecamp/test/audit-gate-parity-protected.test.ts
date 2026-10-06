// Audit 2.2 -- protected fields on every wire (FJS-D473) and filter oracles.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { build, type Fixture } from './audit-parity-harness.ts'
import { Driver, summarize, SENTINELS, type PathName } from './audit-parity-paths.ts'
let fx: Fixture, d: Driver
const uniq = () => Math.random().toString(36).slice(2, 8)
beforeAll(async () => { fx = await build(); d = new Driver(fx) }, 180_000)
afterAll(async () => { await d?.close(); await fx?.env?.close() })
const PATHS: PathName[] = ['http', 'ws', 'mcp', 'job-caller-svc', 'job-caller-db']

test('no read or write result on any path carries @encrypted / @guarded material', async () => {
  const envRow = await (fx.env.system as any).environment.findFirst({ where: { workspaceId: fx.ws.id } })
  for (const path of PATHS) {
    const cells: Array<[string, string, string, any, any]> = [
      ['admin', 'secrets', 'get', fx.rows.secret.id, undefined],
      ['admin', 'secrets', 'create', undefined, { name: 'p-' + uniq(), data: '{"k":"PLAINTEXT-SECRET-DATA"}' }],
      ['admin', 'secrets', 'patch', fx.rows.secret.id, { data: '{"k":"PLAINTEXT-SECRET-DATA"}', version: fx.rows.secret.version }],
      ['viewer', 'servers', 'get', fx.rows.server.id, undefined],
      ['developer', 'servers', 'patch', fx.rows.server.id, { name: 'p-' + uniq() }],
      ['viewer', 'variables', 'get', fx.rows.secretVar.id, undefined],
      ['developer', 'variables', 'create', undefined, { environmentId: envRow.id, key: 'P_' + uniq().toUpperCase(), secret: true, value: 'SECRET-VAR-PLAINTEXT' }],
    ]
    for (const [w, svc, m, id, data0] of cells) {
      const data = m === 'patch' && svc === 'secrets' ? { ...data0, version: (await (fx.env.system as any).secret.findFirst({ where: { id } })).version } : path === 'job-caller-db' && svc === 'variables' && m === 'create' ? { environmentId: data0.environmentId, key: data0.key, secret: true, secretValue: data0.value } : data0
      const r = await d.call(path, w as any, svc, m, id, data)
      expect({ path, svc, m, ok: r.ok }).toEqual({ path, svc, m, ok: true })
      const s = summarize(r)
      expect({ path, svc, m, leaks: (s as any).leaks, protectedKeys: ((s as any).fields as string[]).filter(f => ['data', 'secretValue', 'enrollTokenHash'].includes(f)) })
        .toEqual({ path, svc, m, leaks: [], protectedKeys: [] })
    }
  }
})

test('a protected column cannot be filtered on (no equality / prefix oracle) on any path', async () => {
  for (const path of PATHS) for (const [svc, q] of [
    ['servers', { enrollTokenHash: 'HASH-OF-ENROLL-TOKEN' }], ['servers', { enrollTokenHash: { startsWith: 'HASH-OF' } }],
    ['variables', { secretValue: { not: null } }], ['variables', { secretValue: 'SECRET-VAR-PLAINTEXT' }],
  ] as const) {
    let ok = true
    if (path === 'http') {
      const qs = Object.entries(q).map(([k, v]) => typeof v === 'object' ? `${k}[${Object.keys(v)[0]}]=${Object.values(v)[0]}` : `${k}=${v}`).join('&')
      ok = (await fetch(`${fx.env.url}/${svc}?${qs}`, { headers: { authorization: `Bearer ${fx.tokens.viewer}`, 'x-workspace-id': fx.ws.id } })).status < 400
    } else if (path === 'ws') {
      ok = await (await d.wsClient('viewer')).service(svc).find(q).then(() => true, () => false)
    } else if (path === 'mcp') {
      const c: any = await d.mcpClient('viewer')
      ok = !(await c.callTool({ name: `${svc}_find`, arguments: { query: q } }).catch(() => ({ isError: true }))).isError
    } else if (path === 'job-caller-svc') {
      ok = await fx.env.app.runAs(fx.ids.viewer, { tenant: fx.ws.id }, () => fx.env.app.service(svc).find(q).then(() => true, () => false))
    } else {
      ok = await fx.env.app.runAs(fx.ids.viewer, { tenant: fx.ws.id }, () => fx.env.app.withDb((db: any) => db[svc === 'servers' ? 'server' : 'variable'].findMany({ where: q }).then(() => true, () => false)))
    }
    expect({ path, svc, q: JSON.stringify(q), answered: ok }).toEqual({ path, svc, q: JSON.stringify(q), answered: false })
  }
})
