/*
 * from-repo.test.ts — a project made from a repository (FJS-D1555).
 *
 * `projects.fromRepo` writes five kinds of row in one transaction, and the
 * claims here are about what those rows SAY: the App a machine builds, the /db
 * layout its variables point at, and an ENCRYPTION_KEY that is a secret
 * variable holding its own value (FJS-1599) and revealed only to an admin,
 * with the reveal in the trail.
 *
 * The forge is never read: a repository on a forge `rawDockerfileUrls`
 * does not read seeds blank with no request (FJS-D1570), and the raw-URL tests
 * hand `readRepoDockerfile` a fetch of their own. `connect` writes to the
 * GitHub sink, each account registered at its address (source.test.ts's
 * reason). The machine is the stub executor, which is also the "no deploy key
 * yet" answer, so a connect here writes the hook and no key.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { join }                   from 'node:path'
import { createTestEnv, session } from '@frontierjs/testing'
import { GatePlugin }             from '@frontierjs/litestone'
import { basecampGateLevel }      from '../src/core/gate.ts'
import { buildBasecampApp }       from '../src/app.ts'
import { grantsFor }              from '../src/core/capabilities.ts'
import { parseAppSource, summarizeSource, DOCKERFILE_BYTES } from '../src/domain/release/app-source.ts'
import { readRepoDockerfile, rawDockerfileUrls, forgeRepo } from '../src/domain/release/dockerfile-template.ts'
import { startGhSink, NO_HOOKS_TOKEN } from '../src/providers/source/github-sink.ts'
import { registerAccount }    from '../src/providers/compute/accounts.ts'
import { connectRepository }  from '../src/services/apps/apps.service.ts'

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
      dockerfile: '  FROM oven/bun:1\nEXPOSE 3000\nEXPOSE 4100/tcp\n', serverId: box.id, hostname: `Shop-${uniq()}.example.com`,
    })
  })

  test('a project, its production environment, and the App a machine builds', async () => {
    expect(made.project.slug).toBe('shop-front')
    expect(made.environment).toMatchObject({ name: 'production', slug: 'production', tier: 'production', isProtected: false })
    // The container port is the seed's last EXPOSE.
    expect(made.app).toMatchObject({
      name: 'Shop Front', slug: 'shop-front', type: 'container', environmentId: made.environment.id,
      volumePath: '/db', healthCheck: '/health', containerPort: 4100, port: 10000,
    })
    expect(made.app.source).toEqual({ kind: 'git', repo: 'git@github.com:acme/shop.git', branch: 'main', dockerfile: 'FROM oven/bun:1\nEXPOSE 3000\nEXPOSE 4100/tcp' })
    // The caller's file is theirs; nothing was seeded.
    expect(made.dockerfile).toEqual({ seeded: 'none' })
  })

  test('the variables point at /db, and ENCRYPTION_KEY is a secret holding its own value', async () => {
    const rows = await (env.system as any).variable.findMany({ where: { appId: made.app.id } })
    const by = Object.fromEntries(rows.map((r: any) => [r.key, r]))
    expect(by.DATABASE_URL.value).toBe('/db/app.db')
    expect(by.AUDIT_PATH.value).toBe('/db/audit.db')
    expect(by.NODE_ENV.value).toBe('production')
    expect(by.FRONTIER_PORT_BE.value).toBe('4100')
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
      serverId: box.id, deployOnPush: false,
    })
    expect(off.app.deployOnPush).toBe(false)
    expect(off.push).toBeNull()
  })

  test('no dockerfile and a forge nothing reads seeds blank, never the template', async () => {
    // A private repository and a public one with no file read the same, so the
    // App carries none and the machine builds the repository's own.
    const r = await fromRepo(developer, { name: `Lab ${uniq()}`, repo: 'https://gitlab.com/acme/lab.git' })
    expect(r.dockerfile).toEqual({ seeded: 'none' })
    expect(r.app.source.dockerfile ?? null).toBeNull()
    expect(r.app.containerPort).toBeNull()
    const keys = (await (env.system as any).variable.findMany({ where: { appId: r.app.id } })).map((v: any) => v.key)
    expect(keys).not.toContain('FRONTIER_PORT_BE')
  })

  test('a seed that exposes nothing stores no container port and no FRONTIER_PORT_BE', async () => {
    for (const dockerfile of ['', 'FROM busybox:1.36\nCOPY www /www\n']) {
      const r = await fromRepo(admin, { name: `Mute ${uniq()}`, repo: 'git@github.com:acme/mute.git', dockerfile })
      expect(r.app.containerPort).toBeNull()
      const keys = (await (env.system as any).variable.findMany({ where: { appId: r.app.id } })).map((v: any) => v.key)
      expect(keys).not.toContain('FRONTIER_PORT_BE')
      expect(keys).toContain('DATABASE_URL')
    }
  })

  test('a server outside the workspace is refused before any row is written', async () => {
    const name = `Nope ${uniq()}`
    await expect(fromRepo(admin, { name, repo: 'git@github.com:a/b.git', dockerfile: '', serverId: 'nope' }))
      .rejects.toThrow(/not found/)
    expect(await (env.system as any).project.count({ where: { name } })).toBe(0)
  })
})

describe('variables.reveal', () => {
  let keyVar: any
  beforeAll(async () => {
    const r = await fromRepo(admin, { name: `Vault ${uniq()}`, repo: 'git@github.com:a/vault.git', dockerfile: '' })
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
// first release's container has stopped. Basecamp picks the port when an App
// lands on a machine (FJS-D1557), from 10000 up past what is held, and
// refuses one stated that another App there publishes.
describe('a host port is one App\'s on a machine', () => {
  let first: any, second: any
  beforeAll(async () => {
    first  = await fromRepo(admin, { name: `Port ${uniq()}`, repo: 'https://gitlab.com/acme/p.git', serverId: box.id })
    second = await fromRepo(admin, { name: `Port ${uniq()}`, repo: 'https://gitlab.com/acme/q.git', serverId: box.id })
  })

  test('placing picks the lowest port the machine publishes nothing on, and no two Apps share one', async () => {
    expect(first.app.port).toBeGreaterThanOrEqual(10000)
    expect(second.app.port).toBeGreaterThan(first.app.port)
    const held = (await env.system.appServer.findMany({ where: { serverId: box.id }, include: { app: true } }))
      .map((r: any) => r.app.port).filter((p: any) => p != null)
    expect(new Set(held).size).toBe(held.length)
  })

  test('an App no machine holds publishes nothing until it is placed, then takes a port it keeps', async () => {
    const apps  = env.as(admin).service('apps')
    const loose = await fromRepo(admin, { name: `Port ${uniq()}`, repo: 'https://gitlab.com/acme/s.git' })
    expect(loose.app.port).toBeNull()
    const placed: any = await apps.call('place', loose.app.id, { serverId: box.id })
    expect(placed.port).toBeGreaterThan(second.app.port)
    const again: any = await apps.call('place', loose.app.id, { serverId: box.id })
    expect(again.port).toBe(placed.port)
  })

  test('every type the release starts as a container is given a port; a static App is not', async () => {
    const apps = env.as(admin).service('apps')
    const made: Record<string, any> = {}
    for (const type of ['database', 'static']) {
      const row: any = await apps.create({ environmentId: first.environment.id, name: `${type} ${uniq()}`, slug: `${type}-${uniq()}`, type })
      made[type] = await apps.call('place', row.id, { serverId: box.id })
    }
    expect(made.database.port).toBeGreaterThanOrEqual(10000)
    expect(made.static.port).toBeNull()
  })

  test('a patch onto a taken port is refused naming the App, and the container port may repeat', async () => {
    const apps = env.as(admin).service('apps')
    await expect(apps.patch(second.app.id, { port: first.app.port })).rejects.toThrow(new RegExp(`Port ${first.app.port} .*${first.app.name}`))
    expect((await apps.patch(second.app.id, { containerPort: 3000, port: 4202 })).port).toBe(4202)
  })

  test('placing an App on a machine where its stated port is taken is refused', async () => {
    const apps  = env.as(admin).service('apps')
    const stated = await fromRepo(admin, { name: `Port ${uniq()}`, repo: 'https://gitlab.com/acme/r.git' })
    await apps.patch(stated.app.id, { port: first.app.port })
    await expect(apps.call('place', stated.app.id, { serverId: box.id })).rejects.toThrow(new RegExp(`Port ${first.app.port}`))
  })

  test('the detail names the host ports the App\'s machines already hold, not its own', async () => {
    const detail = await env.as(admin).service('apps').get(second.app.id)
    expect(detail.portsTaken).toContain(first.app.port)
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

describe('fromRepo `connect` writes at GitHub (FJS-D1571)', () => {
  const sink = startGhSink(0)
  const repo = 'git@github.com:sink-owner/app.git'
  const made: any[] = []
  afterAll(async () => {
    sink.stop()
    for (const s of made) await (env.system as any).secret.delete({ where: { id: s.id } })
  })

  const account = async (name: string, token: string) => {
    const s = await (env.system as any).secret.create({ data: {
      workspaceId: ws.id, name, kind: 'provider_key', providerKind: 'github', data: JSON.stringify({ token }),
    } })
    made.push(s)
    await registerAccount(env.app, s, { address: `http://localhost:${sink.port}` })
    return s
  }
  const connect = (who: any, extra: Record<string, unknown> = {}) => {
    const name = `Linked ${uniq()}`
    return { name, call: fromRepo(who, { name, repo, dockerfile: 'FROM oven/bun:1', serverId: box.id, connect: true, ...extra }) }
  }
  const projects = (name: string) => (env.system as any).project.count({ where: { name } })

  test('no GitHub account refuses before any row is written', async () => {
    const { name, call } = connect(admin)
    await expect(call).rejects.toThrow(/No GitHub account/)
    expect(await projects(name)).toBe(0)
  })

  test('a revoked token refuses by name before any row is written', async () => {
    await account('gh-a-revoked', 'github_pat_revoked')
    const { name, call } = connect(admin)
    await expect(call).rejects.toThrow(/refused 'gh-a-revoked'/)
    expect(await projects(name)).toBe(0)
  })

  test('the hook lands at GitHub with the push secret, the revoked token passed over', async () => {
    await account('gh-b-live', 'github_pat_devtoken')
    const r = await connect(admin).call
    expect(r.connected).toEqual({ account: 'gh-b-live', key: false, hook: true })
    const hook = sink.hooksOf('sink-owner/app').find((h: any) => h.config.url === r.push.url)
    expect(hook?.config).toMatchObject({ url: r.push.url, secret: r.push.secret, content_type: 'json' })
  })

  test('a refused write after the App exists is the note, and the App stands', async () => {
    await account('gh-a-nohooks', NO_HOOKS_TOKEN)
    const { name, call } = connect(admin)
    const r = await call
    expect(r.connected).toMatchObject({ account: 'gh-a-nohooks', hook: false })
    expect(r.note).toMatch(/Webhooks/)
    expect(await projects(name)).toBe(1)
    await (env.system as any).secret.delete({ where: { id: made.pop().id } })
  })

  test('a repository no token sees moves through every account and says so', async () => {
    await account('gh-c-live', 'github_pat_devtoken')
    const accounts = made.filter((s: any) => s.name.endsWith('-live')).map((s: any) => ({ id: s.id, name: s.name }))
    const r = await connectRepository(env.app, 'github', accounts, { owner: 'sink-owner', name: 'missing' },
      { hook: { url: 'http://x/hooks/git/1', secret: 's' } })
    expect(r).toMatchObject({ account: null, key: false, hook: false })
    expect(r.note).toMatch(/not found, or the token was not given it \(asked 2 accounts\)/)
  })

  test('a private repository seeds through the account that sees it, port and all', async () => {
    const r = await connect(admin, { dockerfile: undefined }).call
    expect(r.dockerfile).toEqual({ seeded: 'repo' })
    expect(r.app.source.dockerfile).toBe('FROM oven/bun:1\nEXPOSE 3000')
    expect(r.app.containerPort).toBe(3000)
  })

  const importDockerfile = (who: any, id: string) => env.as(who).service('apps').call('importDockerfile', id, {})

  test('importDockerfile reads the forge before any build, the refused token passed over', async () => {
    const r = await connect(admin, { dockerfile: '' }).call
    expect(await importDockerfile(admin, r.app.id)).toEqual({ path: 'Dockerfile', content: 'FROM oven/bun:1\nEXPOSE 3000\n', from: 'forge' })
  })

  test('a repository no account sees falls to the machine, and the note says both', async () => {
    const r = await fromRepo(admin, { name: `Unseen ${uniq()}`, repo: 'git@github.com:sink-owner/private.git', dockerfile: '', serverId: box.id })
    const answer = await importDockerfile(admin, r.app.id)
    expect(answer).toMatchObject({ path: null, content: null })
    expect(answer.note).toMatch(/sink-owner\/private was not found.*\(asked 3 accounts\); /)
  })

  test('a member below administrator reads through no token, and is not refused for it', async () => {
    const r = await connect(admin, { dockerfile: '' }).call
    const answer = await importDockerfile(developer, r.app.id)
    expect(answer).toMatchObject({ path: null, content: null })
    expect(answer.note).not.toMatch(/GitHub/)
  })

  test('a member below administrator reads no token, and is refused', async () => {
    await expect(connect(developer).call).rejects.toThrow(/No GitHub account/)
  })

  test('connect needs a server and a GitHub repository', async () => {
    await expect(connect(admin, { serverId: undefined }).call).rejects.toThrow(/needs a server/)
    await expect(connect(admin, { repo: 'https://bitbucket.org/acme/app.git' }).call).rejects.toThrow(/not a GitHub repository/)
  })

  test('one parse of a remote: owner and name, .git dropped', () => {
    for (const remote of ['git@github.com:sink-owner/app.git', 'https://github.com/sink-owner/app', 'ssh://git@github.com/sink-owner/app.git/'])
      expect(forgeRepo(remote)).toEqual({ forge: 'github', owner: 'sink-owner', name: 'app' })
    expect(forgeRepo('https://gitlab.com/a/b')).toBeNull()
  })
})
