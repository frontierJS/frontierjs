// ─── basecamp-blueprint.test.js — `fli basecamp:blueprint` and its rows ─────────
//
// The command repeats what the Blueprints page does, in the page's order, so
// the order is what is asserted: the App from the entry, its placement, the
// Domain, then a queued release. The stand-in Basecamp keeps rows and records
// each write, so a refusal can be shown to have written nothing, and a step that
// fails after the App exists can be shown to leave it named.

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { writeBasecamp } from '../core/basecamps.js'

let server, home, rows, writes
const origin = () => `http://localhost:${server.port}`

const reset = () => {
  rows = {
    blueprints: [{ id: 'bp-hs', slug: 'headscale', name: 'Headscale' }, { id: 'bp-old', slug: 'ghost', name: 'Ghost', deprecatedAt: '2026-01-01' }],
    servers: [{ id: 'srv-1', slug: 'yuma-test', name: 'yuma-test', status: 'online' }],
    projects: [], environments: [], apps: [], domains: [], deployments: [],
  }
  writes = []
}

beforeAll(() => {
  server = Bun.serve({ port: 0, async fetch(req) {
    const url    = new URL(req.url)
    const method = req.headers.get('x-service-method')
    const [, coll, id] = url.pathname.split('/')
    const body   = req.method === 'GET' ? null : await req.json().catch(() => ({}))
    const json   = (data, status = 200) => Response.json(data, { status })
    if (req.method === 'GET') {
      if (id) return json(rows[coll].find(r => r.id === id) ?? { message: 'not found' }, rows[coll].some(r => r.id === id) ? 200 : 404)
      const where = Object.fromEntries([...url.searchParams].filter(([k]) => !k.startsWith('$')))
      return json((rows[coll] ?? []).filter(r => Object.entries(where).every(([k, v]) => r[k] === v)))
    }
    writes.push([coll, method ?? req.method, body])
    if (coll === 'apps' && method === 'place' && rows.failPlace) return json({ message: 'no capacity' }, 400)
    if (coll === 'apps' && method === 'place') return json(rows.apps.find(a => a.id === id))
    if (coll === 'apps' && method === 'fromBlueprint') {
      const row = { id: `app-${rows.apps.length + 1}`, name: body.name, slug: body.name.toLowerCase(), environmentId: body.environmentId }
      rows.apps.push(row)
      return json(row)
    }
    const row = { id: `${coll}-${rows[coll].length + 1}`, ...body }
    rows[coll].push(row)
    return json(row)
  } })
  home = mkdtempSync(join(tmpdir(), 'fli-blueprint-'))
  writeBasecamp('stand-in', { url: origin(), apiKey: 'key' }, { home })
})
afterAll(() => { server?.stop(true); rmSync(home, { recursive: true, force: true }) })
beforeEach(reset)

// Async: a sync spawn would block the stand-in it calls.
const run = async (...args) => {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '../bin/fli.js'), 'basecamp:blueprint', ...args],
    { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), NO_COLOR: '1' }, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { out: out + err, code }
}
const verbs = () => writes.map(([coll, what]) => `${coll}:${what}`)

describe('installing an entry', () => {
  test('makes the project, then the App, its placement, the Domain and a queued release, in that order', async () => {
    const r = await run('headscale', '--domain', 'hs.example.test', '--param', 'HEADSCALE_SERVER_URL=https://hs.example.test', '--param', 'K=a=b')
    expect(r.code).toBe(0)
    expect(verbs()).toEqual(['projects:POST', 'environments:POST', 'apps:fromBlueprint', 'apps:place', 'domains:POST', 'deployments:POST'])
    const [, , made] = writes.find(([c, m]) => c === 'apps' && m === 'fromBlueprint')
    expect(made).toMatchObject({ blueprintId: 'bp-hs', name: 'Headscale', values: { HEADSCALE_SERVER_URL: 'https://hs.example.test', K: 'a=b' } })
    expect(writes.find(([c]) => c === 'environments')[2]).toMatchObject({ tier: 'production', projectId: 'projects-1' })
    expect(writes.find(([c]) => c === 'domains')[2]).toEqual({ appId: 'app-1', hostname: 'hs.example.test' })
    expect(writes.find(([c]) => c === 'deployments')[2]).toEqual({ appId: 'app-1' })
    expect(r.out).toMatch(/Headscale.*on yuma-test/)
    expect(r.out).toContain('/deployments/deployments-1/')
  })

  test('with no --domain makes no Domain, and an existing project is reused', async () => {
    rows.projects.push({ id: 'p-1', slug: 'headscale' })
    rows.environments.push({ id: 'e-1', projectId: 'p-1', tier: 'production' })
    expect((await run('headscale')).code).toBe(0)
    expect(verbs()).toEqual(['apps:fromBlueprint', 'apps:place', 'deployments:POST'])
  })

  test('--dry reads and writes nothing, and never prints a value', async () => {
    const r = await run('headscale', '--dry', '--domain', 'hs.example.test', '--param', 'HEADSCALE_SERVER_URL=https://secret.example.test')
    expect(r.code).toBe(0)
    expect(writes).toEqual([])
    expect(r.out).toContain('HEADSCALE_SERVER_URL')
    expect(r.out).not.toContain('secret.example.test')
  })
})

describe('what it refuses', () => {
  test('an unknown or withdrawn entry, naming the slugs the catalog holds', async () => {
    for (const slug of ['nope', 'ghost']) {
      const r = await run(slug)
      expect(r.code).not.toBe(0)
      expect(r.out).toMatch(/no blueprint .*it holds: headscale/)
    }
    expect(writes).toEqual([])
  })

  test('a malformed --param before any write', async () => {
    const r = await run('headscale', '--param', 'NOEQUALS')
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('KEY=VALUE')
    expect(writes).toEqual([])
  })

  test('a second run, since the environment already holds the App', async () => {
    rows.projects.push({ id: 'p-1', slug: 'headscale' })
    rows.environments.push({ id: 'e-1', projectId: 'p-1', tier: 'production' })
    rows.apps.push({ id: 'app-9', slug: 'headscale', environmentId: 'e-1' })
    const r = await run('headscale')
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('app-9')
    expect(writes).toEqual([])
  })

  test('a hostname another App holds leaves the App made and names it', async () => {
    rows.domains.push({ id: 'd-1', appId: 'app-other', hostname: 'hs.example.test' })
    const r = await run('headscale', '--domain', 'HS.example.test')
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/App 'Headscale' \(app-1\) was made but not released.*another App \(app-other\)/)
    expect(verbs()).not.toContain('deployments:POST')
  })

  test('a server that is not online', async () => {
    const r = await run('headscale', '--server', 'elsewhere')
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/no online server 'elsewhere' — online: yuma-test/)
    expect(writes).toEqual([])
  })
})
