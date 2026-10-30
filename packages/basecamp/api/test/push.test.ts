/*
 * push.test.ts — a git push starts a release (FJS-1781, FJS-D884).
 *
 * The door is a conduit Receiver, so the order is conduit's: credential,
 * verify, parse, owner, receipt, apply. What is claimed here is Basecamp's half:
 * the forge's HMAC and the per-App token URL both reach the same apply, a push
 * to another branch releases nothing, a redelivery releases once, and an App
 * that has not opted in is refused at the door and not ignored behind it.
 */

import { test, expect, describe, beforeAll } from 'bun:test'
import { createHmac }             from 'node:crypto'
import { join }                   from 'node:path'
import { createTestEnv, session } from '@frontierjs/testing'
import { GatePlugin }             from '@frontierjs/litestone'
import { basecampGateLevel }      from '../src/core/gate.ts'
import { buildBasecampApp }       from '../src/app.ts'
import { grantsFor }              from '../src/core/capabilities.ts'
import { recordStep }             from '../src/domain/release/release-record.ts'

process.env.BASECAMP_STUB_OUTPOST = '1'

let env: any, ws: any, admin: any, userId: string, box: any, environment: any
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
  const user = await sys.user.create({ data: { email: `u-${uniq()}@x.co`, accountId: acct.id, status: 'active' } })
  userId = user.id

  ws = await sys.workspace.create({ data: {
    accountId: acct.id, name: 'Fleet', slug: `f-${uniq()}` } })
  await sys.workspaceMember.create({ data: {
    workspaceId: ws.id, userId: user.id, role: 'admin',
    capabilities: grantsFor('admin'), acceptedAt: new Date().toISOString() } })
  admin = session({ id: user.id, workspaceId: ws.id })

  box = await sys.server.create({ data: {
    workspaceId: ws.id, name: `box-${uniq()}`, slug: `box-${uniq()}` } })
  box = await sys.server.transition(box.id, 'checkIn')
  const project = await sys.project.create({ data: {
    workspaceId: ws.id, name: 'Shop', slug: `p-${uniq()}` } })
  environment = await sys.environment.create({ data: {
    workspaceId: ws.id, projectId: project.id, name: 'Production', slug: `e-${uniq()}` } })
})

const apps = () => env.as(admin).service('apps')

async function aGitApp(branch: string | undefined = 'main') {
  const slug = `git-${uniq()}`
  const created: any = await apps().create({
    workspaceId: ws.id, environmentId: environment.id, name: slug, slug, type: 'container',
    source: { kind: 'git', repo: 'https://git.example.test/acme/shop.git', ...(branch ? { branch } : {}) },
  })
  await (env.system as any).appServer.create({ data: { appId: created.id, serverId: box.id, replicaIndex: 0 } })
  return created
}

const releases = async (appId: string) =>
  (await (env.system as any).deployment.findMany({ where: { appId } })) as any[]

const sign = (secret: string, body: string) =>
  'sha256=' + createHmac('sha256', secret).update(body).digest('hex')

const push = (ref = 'refs/heads/main', after = uniq()) => ({ ref, after })

/** A forge's delivery: the HMAC dialect GitHub, Forgejo and Gitea all speak. */
function forge(appId: string, secret: string, body: object, delivery = uniq(), signature = sign(secret, JSON.stringify(body))) {
  return env.http.post(`/hooks/git/${appId}`)
    .set('x-hub-signature-256', signature)
    .set('x-github-delivery', delivery)
    .set('x-github-event', 'push')
    .send(body)
}

describe('a push releases the App', () => {

  test('a signed push to the App\'s branch queues a release as whoever enabled push', async () => {
    const app: any = await aGitApp()
    const on: any  = await apps().call('enablePush', app.id, {})
    expect(on.secret).toBeTruthy()
    expect(on.url).toContain(`/hooks/git/${app.id}`)

    const sha = uniq().padEnd(40, '0')
    const res = await forge(app.id, on.secret, {
      ...push('refs/heads/main', sha),
      head_commit: { id: sha, message: 'Cache the manifest', author: { name: 'Kim', email: 'kim@example.test' } },
    })
    expect(res.status).toBe(200)

    const made = await releases(app.id)
    expect(made).toHaveLength(1)
    expect(made[0].triggeredBy).toBe(userId)
    // The door and the payload's commit, as the Releases tab reads them back.
    expect(made[0]).toMatchObject({ trigger: 'push', commitSha: sha, branch: 'main', author: 'Kim', commitMessage: 'Cache the manifest' })
  })

  test('the per-App token URL reaches the same apply, for a sender that signs nothing', async () => {
    const app: any = await aGitApp()
    const on: any  = await apps().call('enablePush', app.id, {})

    const res = await env.http.post(`/hooks/git/${app.id}/${on.token}`).send({})
    expect(res.status).toBe(200)
    expect(await releases(app.id)).toHaveLength(1)

    const wrong = await env.http.post(`/hooks/git/${app.id}/bcpt_nope`).send({})
    expect(wrong.status).toBe(401)
    expect(await releases(app.id)).toHaveLength(1)
  })

  test('a push to another branch is answered and releases nothing', async () => {
    const app: any = await aGitApp()
    const on: any  = await apps().call('enablePush', app.id, {})
    const res = await forge(app.id, on.secret, push('refs/heads/feature'))
    expect(res.status).toBe(200)
    expect(await releases(app.id)).toHaveLength(0)
  })

  test('a redelivery of one delivery releases once', async () => {
    const app: any = await aGitApp()
    const on: any  = await apps().call('enablePush', app.id, {})
    const body = push(), id = uniq()
    expect((await forge(app.id, on.secret, body, id)).status).toBe(200)
    expect((await forge(app.id, on.secret, body, id)).status).toBe(200)
    expect(await releases(app.id)).toHaveLength(1)
  })

  test('a forged or tampered signature is refused and releases nothing', async () => {
    const app: any = await aGitApp()
    const on: any  = await apps().call('enablePush', app.id, {})
    const body = push()
    expect((await forge(app.id, 'not-the-secret', body)).status).toBe(401)
    expect((await forge(app.id, on.secret, body, uniq(), sign(on.secret, JSON.stringify(push())))).status).toBe(401)
    expect(await releases(app.id)).toHaveLength(0)
  })

  test('an App that never enabled push is refused, and so is one that turned it off', async () => {
    const app: any = await aGitApp()
    expect((await forge(app.id, 'anything', push())).status).toBe(401)

    const on: any = await apps().call('enablePush', app.id, {})
    await apps().call('disablePush', app.id, {})
    expect((await forge(app.id, on.secret, push())).status).toBe(401)
    expect(await releases(app.id)).toHaveLength(0)
  })

  test('the secret and the token are shown once and read back as nothing', async () => {
    const app: any = await aGitApp()
    const on: any  = await apps().call('enablePush', app.id, {})
    const row: any = await apps().get(app.id)
    expect(JSON.stringify(row)).not.toContain(on.secret)
    expect(JSON.stringify(row)).not.toContain(on.token)
    expect(row.deployOnPush).toBe(true)
  })

  // Creation's door (FJS-D1558): the same mint as enablePush, so what it
  // answers verifies at the forge and releases; and an App with no machine is
  // never deployOnPush, because the release it would queue fails at step one.
  test('a project made from a repository with a server answers a secret the forge can use', async () => {
    const made: any = await env.as(admin).service('projects').call('fromRepo', null, {
      name: `Made ${uniq()}`, repo: 'https://git.example.test/acme/made.git', branch: 'main', dockerfile: 'FROM oven/bun:1',
      serverId: box.id,
    })
    expect(made.app.deployOnPush).toBe(true)
    const sha = uniq().padEnd(40, '3')
    const res = await forge(made.app.id, made.push.secret, push('refs/heads/main', sha))
    expect(res.status).toBe(200)
    const rows = await releases(made.app.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ trigger: 'push', commitSha: sha, triggeredBy: userId })
    expect((await env.http.post(`/hooks/git/${made.app.id}/${made.push.token}`).send({})).status).toBe(200)
  })

  test('a project made from a repository with no server is never deployOnPush', async () => {
    const made: any = await env.as(admin).service('projects').call('fromRepo', null, {
      name: `Alone ${uniq()}`, repo: 'https://git.example.test/acme/alone.git', dockerfile: 'FROM oven/bun:1',
    })
    expect(made.app.deployOnPush).toBe(false)
    expect(made.push).toBeNull()
    expect((await forge(made.app.id, 'anything', push())).status).toBe(401)
  })
})

// The other two doors, as the API records them: the button has no payload, so
// its row takes the branch off the App and its commit from the build step; the
// laptop names its own commit, `-dirty` included, and the digest it loaded, so
// nothing is built (`FJS-3561`).
describe('the button and the laptop say which door they are', () => {

  const deployments = () => env.as(admin).service('deployments')

  test('the button row is `button` on the App\'s branch, as whoever pressed it', async () => {
    const app: any  = await aGitApp('release')
    const made: any = await deployments().create({ appId: app.id })
    expect(made).toMatchObject({ trigger: 'button', branch: 'release', triggeredBy: userId })
    expect(made.commitSha).toBeNull()
  })

  test('the build step hands the row the commit it built', async () => {
    const app: any  = await aGitApp()
    const made: any = await deployments().create({ appId: app.id })
    const sha  = uniq().padEnd(40, '1')
    const step = await (env.system as any).deploymentStep.findFirst({ where: { deploymentId: made.id, name: 'Build image' } })
    await recordStep(env.app, made, { stepId: step.id, status: 'success', commit: sha })
    expect((await (env.system as any).deployment.findUnique({ where: { id: made.id } })).commitSha).toBe(sha)
  })

  test('the build step hands an App that stores no container port the one its Dockerfile exposes', async () => {
    const app: any  = await aGitApp()
    expect(app.containerPort).toBeNull()
    const made: any = await deployments().create({ appId: app.id })
    const step = await (env.system as any).deploymentStep.findFirst({ where: { deploymentId: made.id, name: 'Build image' } })
    await recordStep(env.app, made, { stepId: step.id, status: 'success', containerPort: 4100 })
    expect((await (env.system as any).app.findUnique({ where: { id: app.id } })).containerPort).toBe(4100)
    // The snapshot is @immutable and keeps none; the runner reads the App's for it.
    const row = await (env.system as any).deployment.findUnique({ where: { id: made.id } })
    expect(row.configSnapshot.runtime.containerPort).toBeUndefined()
  })

  test('a container port the App states is never moved by a build', async () => {
    const app: any  = await aGitApp()
    await apps().patch(app.id, { containerPort: 3000 })
    const made: any = await deployments().create({ appId: app.id })
    const step = await (env.system as any).deploymentStep.findFirst({ where: { deploymentId: made.id, name: 'Build image' } })
    await recordStep(env.app, made, { stepId: step.id, status: 'success', containerPort: 4100 })
    expect((await (env.system as any).app.findUnique({ where: { id: app.id } })).containerPort).toBe(3000)
  })

  test('the laptop row keeps `laptop` and a `-dirty` commit, and builds nothing', async () => {
    const app: any = await aGitApp()
    const sha = uniq().padEnd(40, '2')
    const made: any = await deployments().create({
      appId: app.id, trigger: 'laptop', commitSha: `${sha}-dirty`, branch: 'main',
      toImage: `fjs-${app.id}:${sha.slice(0, 12)}-dirty`, builtImage: `sha256:${'a'.repeat(64)}`,
    })
    expect(made).toMatchObject({ trigger: 'laptop', commitSha: `${sha}-dirty`, branch: 'main' })
    const steps = await (env.system as any).deploymentStep.findMany({ where: { deploymentId: made.id } })
    expect(steps.map((s: any) => s.name)).not.toContain('Build image')
  })
})
