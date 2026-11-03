/**
 * peer.test.ts — another app calling Basecamp as itself (`FJS-D1196`,
 * `FJS-D1604`): enrolled by its public key, verified at the credential door,
 * graded as its own peer account and held to its key's scopes.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { createTestEnv, session } from '@frontierjs/testing'
import { GatePlugin } from '@frontierjs/litestone'
import { generateSigningKeys, signRequest } from '@frontierjs/toolbelt/signature'
import { basecampGateLevel } from '../src/core/gate.ts'
import { buildBasecampApp } from '../src/app.ts'
import { grantsFor } from '../src/core/capabilities.ts'
import { peerCredential } from '../src/core/hooks.ts'

const SCHEMA     = join(import.meta.dir, '..', '..', 'db', 'schema.lite')
const MIGRATIONS = join(import.meta.dir, '..', '..', 'db', 'migrations')
const ENC_KEY    = '0'.repeat(64)

let env: any, ws: any, owner: any, project: any
let keys: { publicKey: string, privateKey: string }
let peer: { id: string, userId: string, name: string }

const tag = () => Math.random().toString(36).slice(2, 8)
const apiKeys = (who: any) => env.as(who).service('apiKeys')

beforeAll(async () => {
  env = await createTestEnv({
    schema: SCHEMA, migrations: MIGRATIONS, encryptionKey: ENC_KEY,
    plugins: [new GatePlugin({ getLevel: basecampGateLevel })],
    api: ({ db, path }: any) => buildBasecampApp({ db, dbPath: path }),
  })
  const sys  = env.system as any
  const acct = await sys.account.create({ data: { slug: `peer-${tag()}`, displayName: 'Peer' } })
  const user = await sys.user.create({ data: { email: `o-${tag()}@x.co`, accountId: acct.id } })
  ws = await sys.workspace.create({ data: { accountId: acct.id, name: 'Peers', slug: `peers-${tag()}` } })
  await sys.workspaceMember.create({ data: { workspaceId: ws.id, userId: user.id, role: 'owner', capabilities: grantsFor('owner') } })
  owner   = session({ id: user.id, workspaceId: ws.id })
  project = await sys.project.create({ data: { workspaceId: ws.id, name: 'Site', slug: `site-${tag()}` } })

  keys = await generateSigningKeys()
  peer = await apiKeys(owner).call('enrollPeer', null, { name: 'workbench', publicKey: keys.publicKey })
})

afterAll(async () => { await env?.close?.() })

/** The headers a peer sends: the kit's three, and its key named beside them. */
async function signed(opts: { path: string, method?: string, body?: unknown, serviceMethod?: string, privateKey?: string, keyId?: string | null }) {
  const headers: Record<string, string> = await signRequest({
    privateKey: opts.privateKey ?? keys.privateKey, method: opts.method ?? 'POST', path: opts.path,
    serviceMethod: opts.serviceMethod, body: opts.body === undefined ? '' : JSON.stringify(opts.body),
    timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID(),
  })
  if (opts.keyId !== null) headers['X-Fjs-Key'] = opts.keyId ?? peer.id
  return headers
}

function post(path: string, headers: Record<string, string>, serviceMethod: string, body: unknown) {
  const req = env.http.post(path).set('x-service-method', serviceMethod)
  for (const [k, v] of Object.entries(headers)) req.set(k, v)
  return req.send(body)
}

const openBody = (slug: string) => ({
  action:   'open',
  settings: { projectId: project.id, app: '.', domain: 'preview.test', apiUrl: 'https://api.preview.test', serverId: null },
  branch:   { slug, branch: `feat/${slug}`, port: 5173 },
})

async function trailEntry(model: string, operation: string, id: string): Promise<any> {
  for (let i = 0; i < 100; i++) {
    const rows = await (env.system as any).auditTrail.findMany({ where: { model, operation } })
    const hit  = rows.find((r: any) => (typeof r.records === 'string' ? JSON.parse(r.records) : r.records).includes(id))
    if (hit) return hit
    await Bun.sleep(20)
  }
  return null
}

describe('enrollPeer', () => {
  test('makes a peer account, its membership and a key holding only the public half', async () => {
    const sys  = env.system as any
    const user = await sys.user.findUnique({ where: { id: peer.userId } })
    expect(user.kind).toBe('peer')
    expect(user.email).toEndWith('@peers.invalid')

    const member = await sys.workspaceMember.findFirst({ where: { workspaceId: ws.id, userId: peer.userId } })
    expect(member.role).toBe('admin')

    const key = await sys.apiKey.findUnique({ where: { id: peer.id } })
    expect(key).toMatchObject({ userId: peer.userId, publicKey: keys.publicKey, credentialId: null, scopes: ['apps:preview'] })
  })

  test('refuses a key that is not an Ed25519 public key, and a whole key', async () => {
    await expect(apiKeys(owner).call('enrollPeer', null, { name: 'bad', publicKey: 'ssh-ed25519 AAAA' })).rejects.toThrow(/Ed25519/)
    const other = await generateSigningKeys()
    await expect(apiKeys(owner).call('enrollPeer', null, { name: 'whole', publicKey: other.publicKey, scopes: ['admin'] }))
      .rejects.toThrow(/never issued/)
  })
})

describe('the peer door', () => {
  test('a signed open is the peer\'s, and the trail files it as a peer', async () => {
    const body = openBody('try')
    const res  = await post('/apps', await signed({ path: '/apps', body, serviceMethod: 'preview' }), 'preview', body)
    expect(res.status).toBe(200)
    expect(res.body.hostname ?? res.body.data?.hostname).toBe('try.preview.test')

    const opened = res.body.data ?? res.body
    expect(opened.route).toEqual({ ok: false, why: expect.stringContaining('no machine') })
    const env_ = await (env.system as any).environment.findUnique({ where: { id: opened.environmentId } })
    expect(env_).toMatchObject({ workspaceId: ws.id, tier: 'preview', projectId: project.id })

    const entry = await trailEntry('Environment', 'create', opened.environmentId)
    expect(entry?.actorId).toBe(peer.userId)
    expect(entry?.actorType).toBe('peer')
  })

  test('the scope reaches the preview and nothing else', async () => {
    const req = env.http.get('/apps')
    for (const [k, v] of Object.entries(await signed({ path: '/apps', method: 'GET' }))) req.set(k, v)
    const res = await req
    expect(res.status).toBe(403)
    expect(res.body.message).toContain("needs the 'apps:read' scope")
  })

  test('a signature by another key is refused', async () => {
    const other = await generateSigningKeys()
    const body  = openBody('wrong')
    const res   = await post('/apps', await signed({ path: '/apps', body, serviceMethod: 'preview', privateKey: other.privateKey }), 'preview', body)
    expect(res.status).toBe(401)
  })

  test('a replayed nonce is refused', async () => {
    const body    = openBody('again')
    const headers = await signed({ path: '/apps', body, serviceMethod: 'preview' })
    expect((await post('/apps', headers, 'preview', body)).status).toBe(200)
    expect((await post('/apps', headers, 'preview', body)).status).toBe(401)
  })

  test('a revoked key is refused', async () => {
    const pair = await generateSigningKeys()
    const gone = await apiKeys(owner).call('enrollPeer', null, { name: 'retired', publicKey: pair.publicKey })
    await apiKeys(owner).call('revoke', gone.id)
    const body = openBody('revoked')
    const res  = await post('/apps', await signed({ path: '/apps', body, serviceMethod: 'preview', privateKey: pair.privateKey, keyId: gone.id }), 'preview', body)
    expect(res.status).toBe(401)
  })

  test('a signed request naming no key is not this door\'s', async () => {
    const door = peerCredential({ db: env.app.db, logger: env.app.logger })
    const headers = Object.fromEntries(Object.entries(await signed({ path: '/apps', keyId: null })).map(([k, v]) => [k.toLowerCase(), v]))
    expect(await door({ method: 'POST', path: '/apps', query: '', headers, body: '', host: null })).toBeNull()
  })
})
