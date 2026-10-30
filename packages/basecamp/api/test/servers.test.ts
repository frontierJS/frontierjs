/*
 * servers.test.ts — what a machine's heartbeat may write (FJS-D1555).
 *
 * `App.deployPublicKey` is `@system`, and the heartbeat is one of its two
 * writers. The machine is signed in by its own enrolled key and trusted to
 * name its OWN keys: an App placed on another machine, or none, is never
 * written from this one's report, and a value carrying a private block is
 * never shown.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { join }                   from 'node:path'
import { mkdtempSync }            from 'node:fs'
import { tmpdir }                 from 'node:os'
import { ensureCert }             from '@frontierjs/outpost/cert'
import { createTestEnv, session } from '@frontierjs/testing'
import { generateSigningKeys, signRequest }            from '@frontierjs/toolbelt/signature'
import { GatePlugin }             from '@frontierjs/litestone'
import { basecampGateLevel }      from '../src/core/gate.ts'
import { buildBasecampApp }       from '../src/app.ts'
import { grantsFor }              from '../src/core/capabilities.ts'

const CERT = ensureCert(mkdtempSync(join(tmpdir(), 'basecamp-outpost-cert-'))).cert
const KEY  = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMhq7c1jXrJ0aZQ0vE8hJ1bqzW2Yv3l0n7cL8pXk9fQ2 fjs-app'

let env: any, machine: any, secret: string, placed: any, elsewhere: any, admin: any
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
  const ws   = await sys.workspace.create({ data: { accountId: acct.id, name: 'Fleet', slug: `f-${uniq()}` } })
  await sys.workspaceMember.create({ data: {
    workspaceId: ws.id, userId: user.id, role: 'admin', capabilities: grantsFor('admin'), acceptedAt: new Date().toISOString() } })
  admin = session({ id: user.id, workspaceId: ws.id })

  machine = await sys.server.create({ data: { workspaceId: ws.id, name: 'm-01', slug: `m-${uniq()}` } })
  const other = await sys.server.create({ data: { workspaceId: ws.id, name: 'm-02', slug: `m-${uniq()}` } })

  const project = await sys.project.create({ data: { workspaceId: ws.id, name: 'P', slug: `p-${uniq()}` } })
  const envRow  = await sys.environment.create({ data: { workspaceId: ws.id, projectId: project.id, name: 'production', slug: 'production' } })
  const mkApp   = (slug: string) => sys.app.create({ data: {
    workspaceId: ws.id, environmentId: envRow.id, name: slug, slug, source: { kind: 'git', repo: 'git@github.com:a/b.git' } } })
  placed    = await mkApp(`placed-${uniq()}`)
  elsewhere = await mkApp(`elsewhere-${uniq()}`)
  await sys.appServer.create({ data: { appId: placed.id,    serverId: machine.id, replicaIndex: 0 } })
  await sys.appServer.create({ data: { appId: elsewhere.id, serverId: other.id,   replicaIndex: 0 } })

  // Enrolled the way a real machine is, so the heartbeat is signed with its own key.
  const { mintEnrollToken, hashEnrollToken } = await import('../src/providers/compute/enrollment.ts')
  const token = mintEnrollToken().token
  await sys.server.update({ where: { id: machine.id },
    data: { enrollTokenHash: hashEnrollToken(token), enrollExpiresAt: new Date(Date.now() + 60_000) } })
  const keys = await generateSigningKeys()
  await env.http.post(`/servers/${machine.id}/enroll`).send({ token, cert: CERT, publicKey: keys.publicKey })
  secret = keys.privateKey
}, 120_000)

afterAll(async () => { await env?.close() })

async function heartbeat(body: Record<string, unknown>) {
  const path = `/servers/${machine.id}`
  const req  = env.http.post(path).set('x-service-method', 'heartbeat')
  const headers = await signRequest({
    privateKey: secret, method: 'POST', path, serviceMethod: 'heartbeat', body: JSON.stringify(body),
    timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID(),
  })
  for (const [k, v] of Object.entries(headers)) req.set(k, v)
  return req.send(body)
}

const keyOf = async (id: string) =>
  (await (env.system as any).app.findUnique({ where: { id } })).deployPublicKey

describe('the heartbeat writes App.deployPublicKey', () => {
  test('for an App placed on this server, and for no other', async () => {
    const res = await heartbeat({ outpost_version: '0.5.0', health: { cpu: 1 }, deploy_keys: [
      { app_id: placed.id,    public_key: KEY },
      { app_id: elsewhere.id, public_key: KEY },
      { app_id: 'no-such-app', public_key: KEY },
    ] })
    expect(res.status).toBe(200)
    expect(await keyOf(placed.id)).toBe(KEY)
    expect(await keyOf(elsewhere.id)).toBeNull()
  })

  test('a value that is not a public key is never shown', async () => {
    const res = await heartbeat({ outpost_version: '0.5.0', health: { cpu: 1 }, deploy_keys: [
      { app_id: placed.id, public_key: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----' },
    ] })
    expect(res.status).toBe(200)
    expect(await keyOf(placed.id)).toBe(KEY)
  })

  test('a heartbeat with no deploy_keys leaves the column as it was', async () => {
    expect((await heartbeat({ outpost_version: '0.5.0', health: { cpu: 1 } })).status).toBe(200)
    expect(await keyOf(placed.id)).toBe(KEY)
  })

  test('a person cannot write it, an admin included', async () => {
    const tried = env.as(admin).service('apps').patch(placed.id, { deployPublicKey: 'ssh-ed25519 AAAAmine' })
    await tried.catch(() => {})
    expect(await keyOf(placed.id)).toBe(KEY)
  })
})
