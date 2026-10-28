/*
 * from-repo.test.ts — a project made from a repository (FJS-D1555).
 *
 * `projects.fromRepo` writes five kinds of row in one transaction, and the
 * claims here are about what those rows SAY: the App a machine builds, the /db
 * layout its variables point at, and an ENCRYPTION_KEY that is a secret
 * variable holding its own value (FJS-1599) and revealed only to an admin,
 * with the reveal in the trail.
 *
 * The forge is never reached: a repository on a forge `rawDockerfileUrls`
 * does not read seeds the template with no request, and the raw-URL tests
 * hand `readRepoDockerfile` a fetch of their own. The machine is the stub
 * executor, which is also the "no deploy key yet" answer.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { join }                   from 'node:path'
import { createTestEnv, session } from '@frontierjs/testing'
import { GatePlugin }             from '@frontierjs/litestone'
import { basecampGateLevel }      from '../src/core/gate.ts'
import { buildBasecampApp }       from '../src/app.ts'
import { grantsFor }              from '../src/core/capabilities.ts'
import { parseAppSource, summarizeSource, DOCKERFILE_BYTES } from '../src/domain/release/app-source.ts'
import { readRepoDockerfile, rawDockerfileUrls, fjsDockerfileTemplate } from '../src/domain/release/dockerfile-template.ts'

process.env.BASECAMP_STUB_OUTPOST = '1'

let env: any, ws: any, admin: any, developer: any, box: any
const uniq = () => Math.random().toString(36).slice(2, 8)

beforeAll(async () => {
  env = await createTestEnv({
    schema:        join(import.meta.dir, '..', '..', 'db', 'schema.lite'),
    migrations:    join(import.meta.dir, '..', '..', 'db', 'migrations'),
    encryptionKey: '0'.repeat(64),
    plugins:       [new GatePlugin({ getLevel: basecampGateLevel })],
    api: ({ db, path }: any) => buildBasecampApp({ db, dbPath: path }),
  })
  const sys  = env.system as any
  const acct = await sys.account.create({ data: { slug: `a-${uniq()}`, displayName: 'A' } })
  const a    = await sys.user.create({ data: { email: `a-${uniq()}@x.co`, accountId: acct.id, status: 'active' } })
  const d    = await sys.user.create({ data: { email: `d-${uniq()}@x.co`, accountId: acct.id, status: 'active' } })
  ws = await sys.workspace.create({ data: { accountId: acct.id, name: 'Fleet', slug: `f-${uniq()}`, ownerId: a.id } })
  for (const [u, role] of [[a, 'admin'], [d, 'developer']] as const)
    await sys.workspaceMember.create({ data: {
      workspaceId: ws.id, userId: u.id, role, capabilities: grantsFor(role), acceptedAt: new Date().toISOString() } })
  admin     = session({ id: a.id, workspaceId: ws.id })
  developer = session({ id: d.id, workspaceId: ws.id })

  box = await sys.server.create({ data: { workspaceId: ws.id, name: `box-${uniq()}`, slug: `box-${uniq()}` } })
  box = await sys.server.transition(box.id, 'checkIn')
}, 120_000)

afterAll(async () => { await env?.close() })

const fromRepo = (who: any, payload: Record<string, unknown>) =>
  env.as(who).service('projects').call('fromRepo', null, payload)

describe('projects.fromRepo makes the five rows', () => {
  let made: any
  beforeAll(async () => {
    made = await fromRepo(admin, {
      name: 'Shop Front', repo: 'git@github.com:acme/shop.git', branch: 'main',
      dockerfile: '  FROM oven/bun:1\n', serverId: box.id, hostname: `Shop-${uniq()}.example.com`, port: 4100,
    })
  })

  test('a project, its production environment, and the App a machine builds', async () => {
    expect(made.project.slug).toBe('shop-front')
    expect(made.environment).toMatchObject({ name: 'production', slug: 'production', tier: 'production', isProtected: false })
    expect(made.app).toMatchObject({
      name: 'Shop Front', slug: 'shop-front', type: 'container', environmentId: made.environment.id,
      volumePath: '/db', healthCheck: '/health', containerPort: 3000, port: 4100,
    })
    expect(made.app.source).toEqual({ kind: 'git', repo: 'git@github.com:acme/shop.git', branch: 'main', dockerfile: 'FROM oven/bun:1' })
    // The caller's file is theirs; nothing was seeded.
    expect(made.dockerfile).toEqual({ seeded: 'none' })
  })

  test('the variables point at /db, and ENCRYPTION_KEY is a secret holding its own value', async () => {
    const rows = await (env.system as any).variable.findMany({ where: { appId: made.app.id } })
    const by = Object.fromEntries(rows.map((r: any) => [r.key, r]))
    expect(by.DATABASE_URL.value).toBe('/db/app.db')
    expect(by.AUDIT_PATH.value).toBe('/db/audit.db')
    expect(by.NODE_ENV.value).toBe('production')
    expect(by.FRONTIER_PORT_BE.value).toBe('3000')
    expect(by.ENCRYPTION_KEY.secret).toBe(true)
    expect(by.ENCRYPTION_KEY.value).toBeNull()
    expect(by.ENCRYPTION_KEY.secretValue).toMatch(/^[0-9a-f]{64}$/)
    // No Secret row: one copy of the key, on the variable.
    expect(await (env.system as any).secret.count({ where: { name: { contains: 'ENCRYPTION_KEY' } } })).toBe(0)
  })

  test('the hostname is a primary Domain, and the App is placed on the server', async () => {
    expect(made.app.domains).toHaveLength(1)
    expect(made.app.domains[0].isPrimary).toBe(true)
    expect(made.app.domains[0].hostname).toBe(made.app.domains[0].hostname.toLowerCase())
    const placed = await (env.system as any).appServer.findMany({ where: { appId: made.app.id } })
    expect(placed.map((p: any) => p.serverId)).toEqual([box.id])
  })

  test('a stub machine makes no deploy key, and the create says so rather than failing', () => {
    expect(made.app.deployPublicKey).toBeNull()
    expect(made.note).toMatch(/stub/)
  })

  test('with a server, deploy on push is on and the answer carries the credentials once', async () => {
    expect(made.app.deployOnPush).toBe(true)
    expect(made.push.url).toContain(`/hooks/git/${made.app.id}`)
    expect(made.push.tokenUrl).toBe(`${made.push.url}/${made.push.token}`)
    expect(made.push.secret).toBeTruthy()
    const row: any = await env.as(admin).service('apps').get(made.app.id)
    expect(JSON.stringify(row)).not.toContain(made.push.secret)
    expect(JSON.stringify(row)).not.toContain(made.push.token)
  })

  test('`deployOnPush: false` leaves it off, with a server', async () => {
    const off = await fromRepo(admin, {
      name: `Quiet ${uniq()}`, repo: 'git@github.com:acme/quiet.git', dockerfile: 'FROM oven/bun:1',
      serverId: box.id, port: 4102, deployOnPush: false,
    })
    expect(off.app.deployOnPush).toBe(false)
    expect(off.push).toBeNull()
  })

  test('no dockerfile and a forge nothing reads seeds the template', async () => {
    const r = await fromRepo(developer, { name: `Lab ${uniq()}`, repo: 'https://gitlab.com/acme/lab.git', port: 4101 })
    expect(r.dockerfile).toEqual({ seeded: 'template' })
    expect(r.app.source.dockerfile).toBe(fjsDockerfileTemplate().trim())
  })

  test('a server outside the workspace is refused before any row is written', async () => {
    const name = `Nope ${uniq()}`
    await expect(fromRepo(admin, { name, repo: 'git@github.com:a/b.git', dockerfile: '', serverId: 'nope', port: 4102 }))
      .rejects.toThrow(/not found/)
    expect(await (env.system as any).project.count({ where: { name } })).toBe(0)
  })
})

describe('variables.reveal', () => {
  let keyVar: any
  beforeAll(async () => {
    const r = await fromRepo(admin, { name: `Vault ${uniq()}`, repo: 'git@github.com:a/vault.git', dockerfile: '', port: 4103 })
    keyVar = await (env.system as any).variable.findFirst({ where: { appId: r.app.id, key: 'ENCRYPTION_KEY' } })
  })

  test('a developer is refused', async () => {
    await expect(env.as(developer).service('variables').call('reveal', keyVar.id)).rejects.toThrow()
  })

  test('an admin gets the value, and the trail holds who looked', async () => {
    const r = await env.as(admin).service('variables').call('reveal', keyVar.id) as any
    expect(r).toEqual({ id: keyVar.id, key: 'ENCRYPTION_KEY', value: keyVar.secretValue })
    await new Promise(res => setImmediate(res))
    const rows = await (env.system as any).auditEvent.findMany({ where: { action: 'variables.reveal', subjectId: keyVar.id } })
    expect(rows.length).toBe(1)
    expect(JSON.stringify(rows[0])).not.toContain(keyVar.secretValue)
  })
})

describe('source.dockerfile', () => {
  test('accepted when a non-empty string, trimmed, and absent when blank', () => {
    expect(parseAppSource({ kind: 'git', repo: 'r', dockerfile: '\n FROM x \n' })).toEqual({ kind: 'git', repo: 'r', dockerfile: 'FROM x' })
    expect(parseAppSource({ kind: 'git', repo: 'r', dockerfile: '   ' })).toEqual({ kind: 'git', repo: 'r' })
    expect(parseAppSource({ kind: 'git', repo: 'r', dockerfile: 7 })).toEqual({ kind: 'git', repo: 'r' })
  })

  test('capped', () => {
    expect(() => parseAppSource({ kind: 'git', repo: 'r', dockerfile: 'x'.repeat(DOCKERFILE_BYTES + 1) })).toThrow(/bytes/)
  })

  test('a list carries its size, not its text', () => {
    expect(summarizeSource({ kind: 'git', repo: 'r', dockerfile: 'FROM x' })).toEqual({ kind: 'git', repo: 'r', dockerfileBytes: 6 })
  })
})

// FJS-3563: docker refuses the second container on a host port, after the
// first release's container has stopped; Basecamp refuses it at the row.
describe('a host port is one App\'s on a machine', () => {
  let first: any, second: any
  beforeAll(async () => {
    first  = await fromRepo(admin, { name: `Port ${uniq()}`, repo: 'https://gitlab.com/acme/p.git', serverId: box.id, port: 4200 })
    second = await fromRepo(admin, { name: `Port ${uniq()}`, repo: 'https://gitlab.com/acme/q.git', serverId: box.id, port: 4201 })
  })

  test('fromRepo onto a machine where another App publishes the port is refused, naming it', async () => {
    await expect(fromRepo(admin, { name: `Port ${uniq()}`, repo: 'https://gitlab.com/acme/r.git', serverId: box.id, port: 4200 }))
      .rejects.toThrow(new RegExp(`Port 4200 .*${first.app.name}`))
  })

  test('a patch onto a taken port is refused, and the container port may repeat', async () => {
    const apps = env.as(admin).service('apps')
    await expect(apps.patch(second.app.id, { port: 4200 })).rejects.toThrow(/Port 4200/)
    expect((await apps.patch(second.app.id, { containerPort: 3000, port: 4202 })).port).toBe(4202)
  })

  test('placing an App on a machine where its port is taken is refused', async () => {
    const apps = env.as(admin).service('apps')
    const loose = await fromRepo(admin, { name: `Port ${uniq()}`, repo: 'https://gitlab.com/acme/s.git', port: 4200 })
    await expect(apps.call('place', loose.app.id, { serverId: box.id })).rejects.toThrow(/Port 4200/)
  })

  test('the detail names the host ports the App\'s machines already hold, not its own', async () => {
    const detail = await env.as(admin).service('apps').get(second.app.id)
    expect(detail.portsTaken).toContain(4200)
    expect(detail.portsTaken).not.toContain(4202)
  })
})

describe('readRepoDockerfile', () => {
  test('the three remote spellings become raw URLs, deploy/Dockerfile first', () => {
    expect(rawDockerfileUrls('https://github.com/acme/shop', 'main')).toEqual([
      'https://raw.githubusercontent.com/acme/shop/main/deploy/Dockerfile',
      'https://raw.githubusercontent.com/acme/shop/main/Dockerfile',
    ])
    expect(rawDockerfileUrls('git@github.com:acme/shop.git', 'main')[0])
      .toBe('https://raw.githubusercontent.com/acme/shop/main/deploy/Dockerfile')
    expect(rawDockerfileUrls('https://bitbucket.org/team/shop', 'main')[1])
      .toBe('https://bitbucket.org/team/shop/raw/main/Dockerfile')
    expect(rawDockerfileUrls('https://github.com/acme/shop')[0]).toContain('/HEAD/')
    expect(rawDockerfileUrls('https://gitlab.com/acme/shop', 'main')).toEqual([])
    expect(rawDockerfileUrls('https://github.com/acme/../etc', 'main')).toEqual([])
  })

  test('falls through a missing deploy/Dockerfile to Dockerfile', async () => {
    const asked: string[] = []
    const fetch = (async (url: string) => {
      asked.push(url)
      return url.endsWith('/deploy/Dockerfile') ? new Response('nf', { status: 404 }) : new Response('FROM oven/bun\n')
    }) as unknown as typeof globalThis.fetch
    expect(await readRepoDockerfile({ repo: 'git@github.com:acme/shop.git', branch: 'dev' }, { fetch }))
      .toEqual({ path: 'Dockerfile', content: 'FROM oven/bun\n' })
    expect(asked).toHaveLength(2)
  })

  test('a sign-in page is not a Dockerfile', async () => {
    const fetch = (async () => new Response('<!doctype html><title>Log in</title>')) as unknown as typeof globalThis.fetch
    expect(await readRepoDockerfile({ repo: 'https://bitbucket.org/team/shop' }, { fetch })).toBeNull()
  })
})
