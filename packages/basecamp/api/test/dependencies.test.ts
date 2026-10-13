// api/test/dependencies.test.ts
// The dependency mirror: the verdict (pure), a push through the real service
// at each level, and the check against a registry and an OSV that answer from
// a port in this process — the real conduit sending to a fake upstream, so the
// path, the encoding of a scoped name and the 404 are all the wire's.

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { createTestEnv, session } from '@frontierjs/testing'
import { GatePlugin }          from '@frontierjs/litestone'
import { basecampGateLevel }   from '../src/core/gate.ts'
import { buildBasecampApp }    from '../src/app.ts'
import { grantsFor }           from '../src/core/capabilities.ts'
import { bumpOf, statusOf, admits, refreshDependencies } from '../src/core/dependencies.ts'

const SCHEMA     = join(import.meta.dir, '..', '..', 'db', 'schema.lite')
const MIGRATIONS = join(import.meta.dir, '..', '..', 'db', 'migrations')

// ─── The verdict ─────────────────────────────────────────────────────────

describe('bumpOf', () => {
  test('names the part that moved', () => {
    expect(bumpOf('8.3.2', '8.3.4')).toBe('patch')
    expect(bumpOf('8.3.2', '8.5.0')).toBe('minor')
    expect(bumpOf('5.9.3', '7.0.2')).toBe('major')
    expect(bumpOf('8.3.4', '8.3.4')).toBe('current')
  })

  test('below 1.0 the leftmost non-zero part is the breaking one', () => {
    expect(bumpOf('0.5.17', '0.6.1')).toBe('major')
    expect(bumpOf('0.5.17', '0.5.18')).toBe('patch')
    expect(bumpOf('0.0.3', '0.0.4')).toBe('major')
  })

  test('no answer for a copy ahead of latest or a spec that is not a version', () => {
    expect(bumpOf('9.0.0-beta.1', '8.3.4')).toBeNull()
    expect(bumpOf('github:x/y', '1.0.0')).toBeNull()
  })
})

describe('statusOf', () => {
  const base = { installed: ['1.0.0'], latest: '1.0.0', deprecated: null, advisories: {}, checkedAt: '2026-10-12T00:00:00Z' }

  test('an advisory on an installed version outranks everything, checked or not', () => {
    const adv = { '1.0.0': [{ id: 'GHSA-1', summary: 's', severity: 'HIGH', aliases: [] }] }
    expect(statusOf({ ...base, advisories: adv }).status).toBe('vulnerable')
    expect(statusOf({ ...base, advisories: adv, checkedAt: null }).status).toBe('vulnerable')
    expect(statusOf({ ...base, advisories: { '0.9.0': adv['1.0.0'] } }).status).toBe('current')
  })

  test('deprecated outranks a version gap; never checked is its own answer', () => {
    expect(statusOf({ ...base, latest: '3.0.0', deprecated: 'use y' }).status).toBe('deprecated')
    expect(statusOf({ ...base, checkedAt: null }).status).toBe('unchecked')
  })

  test('two installed copies are graded by the one furthest behind', () => {
    expect(statusOf({ ...base, installed: ['2.1.0', '2.0.5'], latest: '2.1.0' }).status).toBe('minor')
  })
})

test('admits answers whether a range reaches latest', () => {
  expect(admits('^8.3.2', '8.3.4')).toBe(true)
  expect(admits('^5.9.3', '7.0.2')).toBe(false)
  expect(admits('^0.5.17', '0.6.1')).toBe(false)
  expect(admits('^1.0.0', null)).toBeNull()
})

// ─── The service and the check ───────────────────────────────────────────

const REGISTRY: Record<string, any> = {
  vite:             { version: '8.3.4' },
  '@biomejs/biome': { version: '2.5.15' },
  lodash:           { version: '4.17.21' },
  request:          { version: '2.88.2', deprecated: 'request has been deprecated' },
}
const VULNS: Record<string, string[]> = { 'lodash@4.17.15': ['GHSA-p6mc-m468-83gw'] }
const seen: string[] = []

let upstream: any, env: any, ws: any, owner: any, developer: any, viewer: any, ownerUser: any

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      seen.push(`${req.method} ${url.pathname}`)
      if (url.pathname === '/v1/querybatch') {
        const { queries } = await req.json() as any
        return Response.json({ results: queries.map((q: any) =>
          ({ vulns: (VULNS[`${q.package.name}@${q.version}`] ?? []).map(id => ({ id })) })) })
      }
      if (url.pathname.startsWith('/v1/vulns/'))
        return Response.json({ id: url.pathname.slice(10), summary: 'Prototype Pollution in lodash',
                               aliases: ['CVE-2020-8203'], database_specific: { severity: 'HIGH' } })
      const m = /^\/(.+)\/latest$/.exec(url.pathname)
      const doc = m && REGISTRY[decodeURIComponent(m[1])]
      return doc ? Response.json(doc) : Response.json({ error: 'Not found' }, { status: 404 })
    },
  })
  process.env.NPM_REGISTRY_URL = `http://localhost:${upstream.port}`
  process.env.OSV_API_URL      = `http://localhost:${upstream.port}`

  env = await createTestEnv({
    schema: SCHEMA, migrations: MIGRATIONS, encryptionKey: '0'.repeat(64),
    plugins: [new GatePlugin({ getLevel: basecampGateLevel })],
    api: ({ db, path }: any) => buildBasecampApp({ db, dbPath: path }),
  })

  const sys  = env.system as any
  const uniq = Math.random().toString(36).slice(2, 8)
  const acct = await sys.account.create({ data: { slug: `deps-${uniq}`, displayName: 'Deps' } })
  const mk   = (role: string) => sys.user.create({ data: { email: `${role}-${uniq}@x.co`, accountId: acct.id, status: 'active' } })
  const [o, d, v] = [await mk('owner'), await mk('dev'), await mk('viewer')]
  ownerUser = o
  ws = await sys.workspace.create({ data: { accountId: acct.id, name: 'Deps', slug: `deps-${uniq}`, ownerId: o.id } })
  for (const [u, role] of [[o, 'owner'], [d, 'developer'], [v, 'viewer']] as const)
    await sys.workspaceMember.create({ data: {
      workspaceId: ws.id, userId: u.id, role, capabilities: grantsFor(role), acceptedAt: new Date().toISOString(),
    } })
  const at = (u: any) => session({ userId: u.id, workspaceId: ws.id })
  owner = at(o); developer = at(d); viewer = at(v)
})

afterAll(async () => {
  upstream?.stop(true)
  delete process.env.NPM_REGISTRY_URL
  delete process.env.OSV_API_URL
  await env?.close?.()
})

const deps = (who: any) => env.as(who).service('dependencies')

const PUSH = {
  project: 'frontierjs', create: true, name: 'FrontierJS',
  members: [
    { path: '',              name: 'frontierjs',          private: true },
    { path: 'packages/mesa', name: '@frontierjs/mesa',    private: false },
    { path: 'example',       name: '@frontierjs/example', private: true },
  ],
  uses: [
    { name: '@biomejs/biome', member: 'frontierjs',          kind: 'dev',        range: '2.5.8',   installed: '2.5.8' },
    { name: 'vite',           member: '@frontierjs/mesa',    kind: 'peer',       range: '^8.3.2',  installed: '8.3.2' },
    { name: 'vite',           member: '@frontierjs/example', kind: 'dev',        range: '^8.3.2',  installed: '8.3.2' },
    { name: 'lodash',         member: '@frontierjs/mesa',    kind: 'dependency', range: '^4.17.0', installed: '4.17.15' },
    { name: 'request',        member: '@frontierjs/example', kind: 'dependency', range: '^2.88.0', installed: '2.88.2' },
    { name: '@kobami/private', member: '@frontierjs/example', kind: 'dependency', range: '^1.0.0', installed: '1.0.0' },
  ],
}

describe('ingest', () => {
  test('a viewer may not push; a developer may', async () => {
    await expect(deps(viewer).call('ingest', null, PUSH)).rejects.toThrow()
    const res = await deps(developer).call('ingest', null, PUSH) as any
    expect(res).toMatchObject({ packages: 5, uses: 6, added: 6, updated: 0, removed: 0, check: 'queued' })
    expect(res.project.slug).toBe('frontierjs')
  })

  test('a project that does not exist is refused unless the push asks to create it', async () => {
    await expect(deps(developer).call('ingest', null, { ...PUSH, project: 'nope', create: false }))
      .rejects.toThrow(/No project 'nope'/)
  })

  test('a push is the whole truth for its project — a dropped declaration leaves', async () => {
    const res = await deps(developer).call('ingest', null, { ...PUSH, uses: PUSH.uses.slice(0, 5) }) as any
    expect(res).toMatchObject({ added: 0, updated: 5, removed: 1 })
    const report = await deps(viewer).call('report', null, { project: 'frontierjs' }) as any
    expect(report.packages.map((p: any) => p.name)).not.toContain('@kobami/private')
    await deps(developer).call('ingest', null, PUSH)
  })

  test('a malformed declaration is refused by its index', async () => {
    await expect(deps(developer).call('ingest', null, { ...PUSH, uses: [{ name: 'x', member: 'y', kind: 'nope', range: '1' }] }))
      .rejects.toThrow(/uses\[0\]/)
  })

  test('nothing but a push writes — the service offers no patch', async () => {
    const [row] = (await deps(developer).find({ name: 'vite' }) as any).data
    await expect(env.as(developer).service('dependencies').patch(row.id, { latest: '0.0.1' })).rejects.toThrow()
  })
})

describe('check', () => {
  test('writes what the registry and OSV said, and the report grades it', async () => {
    const res = await refreshDependencies(env.app, env.system, { workspaceId: ws.id })
    expect(res).toEqual({ checked: 5, failed: 0 })
    expect(seen).toContain('GET /@biomejs%2Fbiome/latest')

    const report = await deps(viewer).call('report', null, {}) as any
    const by = Object.fromEntries(report.packages.map((p: any) => [p.name, p]))

    expect(by.lodash.status).toBe('vulnerable')
    expect(by.lodash.advisories[0]).toMatchObject({ id: 'GHSA-p6mc-m468-83gw', severity: 'HIGH' })
    expect(by.request.status).toBe('deprecated')
    expect(by.vite).toMatchObject({ status: 'patch', inRange: true, latest: '8.3.4', published: true })
    expect(by['@biomejs/biome']).toMatchObject({ status: 'patch', inRange: false, published: false })
    expect(by['@kobami/private']).toMatchObject({ status: 'unknown', checkError: 'not on the public registry' })
    expect(report.packages[0].name).toBe('lodash')
    expect(report.counts).toMatchObject({ vulnerable: 1, deprecated: 1, patch: 2, unknown: 1 })
    expect(report.projects).toHaveLength(1)
  })

  // FJS-2715 — the advisory is on /dependencies/ and nobody is told.
  test('a version that gains an advisory tells the workspace once, not again each run', async () => {
    const told = async () => (env.system as any).notification.findMany({
      where: { userId: ownerUser.id, type: 'dependency_vulnerable' },
    })
    // The first run found lodash@4.17.15 vulnerable: that is the news.
    const first = await told()
    expect(first).toHaveLength(1)
    expect(JSON.stringify(first[0])).toContain('lodash')

    await refreshDependencies(env.app, env.system, { workspaceId: ws.id })
    expect(await told()).toHaveLength(1)

    VULNS['vite@8.3.2'] = ['GHSA-aaaa-bbbb-cccc']
    await refreshDependencies(env.app, env.system, { workspaceId: ws.id })
    const after = await told()
    expect(after).toHaveLength(2)
    expect(JSON.stringify(after.find((n: any) => n.id !== first[0].id))).toContain('vite')
    expect(JSON.stringify(after.find((n: any) => n.id !== first[0].id))).not.toContain('lodash')
    delete VULNS['vite@8.3.2']
  })

  test('a registry that is down keeps the previous answer and says why', async () => {
    upstream.stop(true)
    const res = await refreshDependencies(env.app, env.system, { workspaceId: ws.id })
    expect(res.failed).toBe(5)
    const report = await deps(viewer).call('report', null, { project: 'frontierjs' }) as any
    const vite = report.packages.find((p: any) => p.name === 'vite')
    expect(vite.latest).toBe('8.3.4')
    expect(vite.checkError).toBeTruthy()
  })
})
