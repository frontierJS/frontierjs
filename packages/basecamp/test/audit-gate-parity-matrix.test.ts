// Audit 2.2 -- gate parity across paths. PASSING half: the cells where the
// path agrees with the model's @@gate. Findings live in the two
// audit-gate-parity-*-finding files, which fail until fixed.
//
// Paths: HTTP (/api REST), WS (client over a real socket), MCP (/mcp over a
// real client), job-caller-svc (app.runAs + app.service, what a runsAsCaller
// job does), job-caller-db (app.runAs + app.withDb, the Data boundary alone),
// job-app (asSystem(), what a runsAsApp job does).
//
// AUDIT_DUMP=<file> writes the full cell matrix as JSON.
import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { build, type Fixture } from './audit-parity-harness.ts'
import { Driver, summarize, type PathName, type Who2 } from './audit-parity-paths.ts'

let fx: Fixture, d: Driver
const uniq = () => Math.random().toString(36).slice(2, 8)
beforeAll(async () => { fx = await build(); d = new Driver(fx) }, 180_000)
afterAll(async () => { await d?.close(); await fx?.env?.close() })

const WIRE: PathName[] = ['http', 'ws', 'mcp', 'job-caller-svc', 'job-caller-db']
const MEMBERS: Who2[] = ['outsider', 'viewer', 'developer', 'admin', 'owner']
const LEVEL: Record<string, number> = { stranger: 0, outsider: 1, viewer: 2, developer: 4, admin: 5, owner: 6 }
// service -> [read, create, update, delete], the model's @@gate
const GATE: Record<string, number[]> = {
  secrets: [5, 5, 5, 5], servers: [2, 4, 4, 5], variables: [2, 4, 4, 4], audit: [5, 8, 9, 9],
}
const ACC: any = { secrets: 'secret', servers: 'server', variables: 'variable', audit: 'auditEvent' }
const dump: Record<string, unknown> = {}

describe('reads follow the read digit on every path', () => {
  for (const svc of ['secrets', 'servers', 'variables', 'audit']) for (const path of WIRE) {
    test(`${svc} via ${path}`, async () => {
      for (const w of MEMBERS) {
        const s: any = summarize(await d.call(path, w, svc, 'find'))
        dump[`read|${svc}|${path}|${w}`] = { ok: s.ok, n: s.n, fields: s.fields, status: s.status }
        const should = LEVEL[w] >= GATE[svc][0]
        expect({ svc, path, w, answered: s.ok }).toEqual({ svc, path, w, answered: should })
        if (s.ok) {
          expect(s.leaks).toEqual([])
          // tenancy: the neighbour workspace's rows never arrive
          expect(s.rows.every((r: any) => r.workspaceId == null || r.workspaceId === fx.ws.id)).toBe(true)
          if (svc === 'audit') expect(s.rows.every((r: any) => r.workspaceId === fx.ws.id)).toBe(true)
        }
      }
    })
  }
})

describe('writes follow the create/update/delete digits on every path', () => {
  const sys = () => fx.env.system as any
  async function fresh(svc: string) {
    const envRow = await sys().environment.findFirst({ where: { workspaceId: fx.ws.id } })
    if (svc === 'secrets')   return sys().secret.create({ data: { workspaceId: fx.ws.id, name: 'f-' + uniq(), data: '{"a":1}' } })
    if (svc === 'servers')   return sys().server.create({ data: { workspaceId: fx.ws.id, name: 'f-' + uniq(), slug: 'f-' + uniq() } })
    return sys().variable.create({ data: { workspaceId: fx.ws.id, environmentId: envRow.id, key: 'F_' + uniq().toUpperCase(), value: 'v' } })
  }
  for (const svc of ['secrets', 'servers', 'variables']) for (const path of WIRE) {
    test(`${svc} via ${path}: an allowed write lands and a refused one does not`, async () => {
      const envRow = await sys().environment.findFirst({ where: { workspaceId: fx.ws.id } })
      const body = svc === 'secrets' ? { name: 'n-' + uniq(), data: '{"a":1}' }
        : svc === 'servers' ? { name: 'n-' + uniq(), slug: 'n-' + uniq() }
        : { environmentId: envRow.id, key: 'N_' + uniq().toUpperCase(), value: 'v' }
      for (const w of MEMBERS) {
        const key = svc === 'variables' ? 'key' : 'name'
        const made = await d.call(path, w, svc, 'create', undefined, body === undefined ? undefined : { ...body, [key]: (body as any)[key] + w, ...(svc === 'servers' ? { slug: (body as any).slug + w } : {}) })
        const landed = !!(await sys()[ACC[svc]].findFirst({ where: { [key]: (body as any)[key] + w } }))
        const should = LEVEL[w] >= GATE[svc][1]
        expect({ svc, path, w, op: 'create', ok: made.ok, landed }).toEqual({ svc, path, w, op: 'create', ok: should, landed: should })

        const row = await fresh(svc)
        const field = svc === 'variables' ? 'value' : 'name'
        const to = 'chg-' + uniq()
        const patched = await d.call(path, w, svc, 'patch', row.id, { [field]: to, ...(row.version != null ? { version: row.version } : {}) })
        const after = await sys()[ACC[svc]].findFirst({ where: { id: row.id } })
        const shouldU = LEVEL[w] >= GATE[svc][2]
        expect({ svc, path, w, op: 'patch', ok: patched.ok, landed: after[field] === to }).toEqual({ svc, path, w, op: 'patch', ok: shouldU, landed: shouldU })

        const gone = await fresh(svc)
        const removed = await d.call(path, w, svc, 'remove', gone.id)
        const left = await sys()[ACC[svc]].findFirst({ where: { id: gone.id } })
        const shouldD = LEVEL[w] >= GATE[svc][3]
        expect({ svc, path, w, op: 'remove', ok: removed.ok, landed: !left || !!left.deletedAt }).toEqual({ svc, path, w, op: 'remove', ok: shouldD, landed: shouldD })
      }
    }, 60_000)
  }

  test('audit is read-only on every path: no level writes it, and the data boundary says LOCKED even for asSystem()', async () => {
    for (const path of WIRE) for (const w of MEMBERS) for (const m of ['create', 'patch', 'remove']) {
      const row = await sys().auditEvent.create({ data: { workspaceId: fx.ws.id, action: 'f.did', subjectType: 'x', subjectId: 'x' } })
      const r = await d.call(path, w, 'audit', m, m === 'create' ? undefined : row.id, m === 'create' ? { action: 'forged', subjectType: 'x', subjectId: 'x' } : m === 'patch' ? { action: 'tampered' } : undefined)
      expect({ path, w, m, ok: r.ok }).toEqual({ path, w, m, ok: false })
      const after = await sys().auditEvent.findFirst({ where: { id: row.id } })
      expect(after.action).toBe('f.did')
    }
    const row = await sys().auditEvent.create({ data: { workspaceId: fx.ws.id, action: 'f.did', subjectType: 'x', subjectId: 'x' } })
    expect((await d.call('job-app', 'owner', 'audit', 'patch', row.id, { action: 'z' })).body).toMatch(/LOCKED/)
    expect((await d.call('job-app', 'owner', 'audit', 'remove', row.id)).body).toMatch(/LOCKED/)
  })
})

describe('User (1.8.1.5): own row at every standing, the rest at 4, created and deleted by nobody a caller can be', () => {
  test('the users service answers the caller\'s own row on every wire, and drops the columns a person may not write', async () => {
    const sys = fx.env.system as any
    for (const path of ['http', 'ws', 'mcp', 'job-caller-svc'] as PathName[]) for (const w of MEMBERS) {
      const me = fx.ids[w as keyof typeof fx.ids]!
      const got = await d.call(path, w, 'users', 'get', 'me')
      expect(got.ok).toBe(true)
      expect(summarize(got).rows![0].id).toBe(me)
      const before = await sys.user.findFirst({ where: { id: me } })
      await d.call(path, w, 'users', 'patch', 'me', { displayName: 'dn-' + uniq(), isSystemAdmin: true, status: 'suspended', kind: 'bot', role: 'admin', scopes: ['*'], emailVerified: !before.emailVerified })
      const after = await sys.user.findFirst({ where: { id: me } })
      for (const k of ['isSystemAdmin', 'status', 'kind', 'role', 'scopes', 'emailVerified']) expect([k, after[k]]).toEqual([k, before[k]])
      expect(after.displayName).not.toBe(before.displayName)
    }
  })
  test('at the Data boundary: below 4 one reads only oneself, at 4 everybody; nobody updates another; create needs SYSTEM; delete needs 5', async () => {
    const sys = fx.env.system as any
    const total = await sys.user.count()
    const n = async (w: Who2) => summarize(await d.call('job-caller-db', w, 'users', 'find')).n
    expect([await n('outsider'), await n('viewer')]).toEqual([1, 1])
    for (const w of ['developer', 'admin', 'owner'] as Who2[]) expect(await n(w)).toBe(total)
    const victim = fx.ids.outsider!
    for (const w of ['developer', 'owner'] as Who2[]) {
      await d.call('job-caller-db', w, 'users', 'patch', victim, { displayName: 'pwn-' + uniq() })
      expect(String((await sys.user.findFirst({ where: { id: victim } })).displayName)).not.toMatch(/^pwn-/)
      expect((await d.call('job-caller-db', w, 'users', 'create', undefined, { email: `n-${uniq()}@x.co` })).ok).toBe(false)
    }
    const t = await sys.user.create({ data: { email: `t-${uniq()}@x.co` } })
    expect((await d.call('job-caller-db', 'developer', 'users', 'remove', t.id)).ok).toBe(false)
  })
})

describe('documented exceptions, pinned so a change to them is seen', () => {
  test('a sysadmin (7) naming a workspace they are not in is refused BY NAME on every service path, and reads nothing (200) at the Data boundary -- principal.snapshot.md "No row is no claim"', async () => {
    for (const svc of ['secrets', 'servers', 'variables']) {
      for (const path of ['http', 'ws', 'mcp', 'job-caller-svc'] as PathName[]) {
        const r = await d.call(path, 'sysadmin', svc, 'find')
        expect(r.ok).toBe(false)
      }
      const db: any = await d.call('job-caller-db', 'sysadmin', svc, 'find')
      expect(db.ok).toBe(true)
      expect(summarize(db).n).toBe(0)
    }
  })
  test('asSystem() grades at 8: reads every workspace, decrypts @encrypted, sees @guarded; 9 stays locked', async () => {
    const sec: any = summarize(await d.call('job-app', 'owner', 'secrets', 'find'))
    expect(sec.fields).toContain('data')
    expect(sec.leaks).toContain('OTHER-PLAINTEXT')
    const srv: any = summarize(await d.call('job-app', 'owner', 'servers', 'find'))
    expect(srv.fields).toContain('enrollTokenHash')
    const vr: any = summarize(await d.call('job-app', 'owner', 'variables', 'find'))
    expect(vr.fields).toContain('secretValue')
    const au: any = summarize(await d.call('job-app', 'owner', 'audit', 'find'))
    expect(au.rows.some((r: any) => r.workspaceId === null)).toBe(true)
    expect(summarize(await d.call('job-caller-db', 'admin', 'audit', 'find')).rows!.some((r: any) => r.workspaceId === null)).toBe(false)
  })
  test('MCP offers custom methods to any signed-in caller (surface.snapshot.md "who may call"); the call is refused by the hook, not the list', async () => {
    const viewer = await d.tools('viewer') as Set<string>
    expect(viewer.has('servers_issueEnrollment')).toBe(true)
    expect((await d.call('mcp', 'viewer', 'servers', 'issueEnrollment', fx.rows.server.id)).ok).toBe(false)
  })
  test('a tenancy-filtered update or delete at the Data boundary answers null, not a refusal (data-hazards: a @@gate refuses, a @@allow filters)', async () => {
    const sys = fx.env.system as any
    const sec = await sys.secret.create({ data: { workspaceId: fx.ws.id, name: 'rv-' + uniq(), data: '{}' } })
    const r = await d.call('job-caller-db', 'sysadmin', 'secrets', 'patch', sec.id, { name: 'x-' + uniq(), version: sec.version })
    expect(r.ok).toBe(true); expect(r.body).toBeNull()
    expect((await sys.secret.findFirst({ where: { id: sec.id } })).name).toBe(sec.name)
  })
})

test('dump', () => { if (process.env.AUDIT_DUMP) writeFileSync(process.env.AUDIT_DUMP, JSON.stringify(dump, null, 1)) })
