// api/test/source.test.ts
// The source boundary: a GitHub token becomes a workspace ACCOUNT (`FJS-D1571`),
// the account an address, and the address takes a deploy key and a push hook
// and answers a file.
//
// edge.test.ts's two tiers. **The dialect** is graded against a hand-written
// `send` — given these bytes from GitHub, what does this app believe — and
// **the seam** through the real app: conduit resolves the token out of an
// `@encrypted` column and a real listener on a real port checks it. The address
// comes from `registerAccount(…, { address })`, for compute.test.ts's reason:
// `core/env.ts` snapshots `process.env` at first import.

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { createTestEnv, session } from '@frontierjs/testing'
import { GatePlugin }    from '@frontierjs/litestone'
import { basecampGateLevel }       from '../src/core/gate.ts'
import { buildBasecampApp }        from '../src/app.ts'
import { startGhSink, NO_HOOKS_TOKEN } from '../src/providers/source/github-sink.ts'
import { sourceConnectorFor }      from '../src/providers/source/index.ts'
import { connectorFor }            from '../src/providers/compute/index.ts'
import { edgeConnectorFor }        from '../src/providers/edge/index.ts'
import { registerAccount, sendVia, accountConnectorFor } from '../src/providers/compute/accounts.ts'

const SCHEMA     = join(import.meta.dir, '..', '..', 'db', 'schema.lite')
const MIGRATIONS = join(import.meta.dir, '..', '..', 'db', 'migrations')
const ENC_KEY    = '0'.repeat(64)
const sink       = startGhSink(0)
const GH_SINK    = `http://localhost:${sink.port}`
const GH_TOKEN   = 'github_pat_devtoken'

const github: any = sourceConnectorFor('github')
const REPO        = { owner: 'sink-owner', name: 'app' }
const KEY         = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBasecampSourceTestKey'

let env: any, app: any, ws: any, account: any, owner: any

const registerAtSink = async (secret: any): Promise<string> => {
  const target = await registerAccount(app, secret, { address: GH_SINK })
  if (!target) throw new Error(`registerAtSink: ${secret.name} registered nothing`)
  return target
}

const ghAccount = (name: string, token: string) => (env.system as any).secret.create({ data: {
  workspaceId: ws.id, name, kind: 'provider_key', providerKind: 'github',
  data: JSON.stringify({ token }),
}})

beforeAll(async () => {
  env = await createTestEnv({
    schema: SCHEMA, migrations: MIGRATIONS, encryptionKey: ENC_KEY,
    plugins: [new GatePlugin({ getLevel: basecampGateLevel })],
    api: ({ db, path }: any) => buildBasecampApp({ db, dbPath: path }),
  })
  app = env.app

  const sys  = env.system as any
  const uniq = Math.random().toString(36).slice(2, 8)
  const acct = await sys.account.create({ data: { slug: `gh-${uniq}`, displayName: 'GH' } })
  const user = await sys.user.create({ data: { email: `o-${uniq}@x.co`, accountId: acct.id } })
  ws = await sys.workspace.create({
    data: { accountId: acct.id, name: 'Source', slug: `source-${uniq}`, ownerId: user.id },
  })
  const { grantsFor } = await import('../src/core/capabilities.ts')
  await sys.workspaceMember.create({ data: {
    workspaceId: ws.id, userId: user.id, role: 'owner', capabilities: grantsFor('owner'),
  }})
  owner   = session({ id: user.id, workspaceId: ws.id })
  account = await ghAccount('gh-main', GH_TOKEN)
})

afterAll(async () => { sink.stop(); await env?.close?.() })

// ─── The dialect ─────────────────────────────────────────────────────────

describe('GitHub dialect', () => {
  const refused = (status: number, data: unknown = null) =>
    async () => ({ data, status, error: { kind: status >= 500 ? 'server_error' : 'client_error' } })

  test('each refusal names its cause: a dead token, a missing grant, an unseen repository', async () => {
    await expect(github.setDeployKey(refused(401), REPO, { title: 't', key: KEY })).rejects.toThrow('revoked or has expired')
    await expect(github.setPushHook(refused(403, { message: 'Resource not accessible by personal access token' }), REPO,
      { url: 'https://x/hooks', secret: 's' })).rejects.toThrow('give it Webhooks › Read and write')
    await expect(github.setDeployKey(refused(404), REPO, { title: 't', key: KEY })).rejects.toThrow('sink-owner/app was not found, or the token was not given it')
  })

  test('a key already on the repository is answered, not added, whatever comment it was typed with', async () => {
    const asked: string[] = []
    const send = async (req: any) => {
      asked.push(req.method)
      return { data: [{ id: 7, title: 'old', key: KEY, read_only: true }], status: 200 }
    }
    const key = await github.setDeployKey(send, REPO, { title: 'basecamp', key: `${KEY} root@machine` })
    expect(key).toEqual({ id: '7', title: 'old', key: KEY, readOnly: true })
    expect(asked).toEqual(['GET'])
  })

  test('a file is read off its base64, and a directory or a file too large to carry is passed over', async () => {
    const asked: string[] = []
    const send = async (req: any) => {
      asked.push(req.path)
      if (req.path.endsWith('/contents/deploy/Dockerfile?ref=main')) return { data: [{ type: 'file' }], status: 200 }
      if (req.path.includes('/contents/')) return { data: { type: 'file', encoding: 'base64', content: btoa('FROM x\n') }, status: 200 }
      return { data: { full_name: 'sink-owner/app' }, status: 200 }
    }
    expect(await github.readFile(send, REPO, { paths: ['deploy/Dockerfile', 'Dockerfile'], ref: 'main' }))
      .toEqual({ path: 'Dockerfile', content: 'FROM x\n' })
    expect(asked).toEqual(['/repos/sink-owner/app', '/repos/sink-owner/app/contents/deploy/Dockerfile?ref=main',
      '/repos/sink-owner/app/contents/Dockerfile?ref=main'])
  })

  test('a file read names Contents › Read-only, and an unseen repository is never a missing file', async () => {
    await expect(github.readFile(refused(403), REPO, { paths: ['Dockerfile'] })).rejects.toThrow('give it Contents › Read-only')
    await expect(github.readFile(refused(404), REPO, { paths: ['Dockerfile'] })).rejects.toThrow('was not found, or the token was not given it')
  })

  test('verify: a 4xx is a bad token, anything else is not knowing', async () => {
    expect(await github.verify(refused(401))).toBe(false)
    await expect(github.verify(refused(503))).rejects.toThrow('server_error')
  })
})

// ─── The seam ────────────────────────────────────────────────────────────

describe('a GitHub account', () => {
  test('is an account connector, and neither somewhere to make machines nor an edge', () => {
    expect(accountConnectorFor('github')?.label).toBe('GitHub')
    expect(connectorFor('github')).toBeNull()
    expect(edgeConnectorFor('github')).toBeNull()
  })

  test('registers as provider:github:<secretId>, carrying a ref, the pinned headers, and never the token', async () => {
    const target = await registerAtSink(account)
    expect(target).toBe(`provider:github:${account.id}`)
    const descriptor = await app.conduit.resolve(target)
    expect(descriptor.auth.ref).toBe(`secret:${account.id}#token`)
    expect(descriptor.headers['x-github-api-version']).toBe('2022-11-28')
    expect(JSON.stringify(descriptor)).not.toContain(GH_TOKEN)
  })

  test('verify: a working token verifies and a refused one does not', async () => {
    expect(await github.verify(sendVia(app, await registerAtSink(account)))).toBe(true)
    const revoked = await ghAccount('gh-revoked', 'github_pat_wrong')
    expect(await github.verify(sendVia(app, await registerAtSink(revoked)))).toBe(false)
  })

  test('a deploy key is written once: a second connect answers the same key', async () => {
    const send  = sendVia(app, await registerAtSink(account))
    const first = await github.setDeployKey(send, REPO, { title: 'basecamp:app:a1', key: KEY })
    expect(first).toMatchObject({ title: 'basecamp:app:a1', key: KEY, readOnly: true })
    expect(await github.setDeployKey(send, REPO, { title: 'basecamp:app:a1', key: KEY })).toEqual(first)
  })

  test('the same key on a second repository is refused by name', async () => {
    const send = sendVia(app, await registerAtSink(account))
    await expect(github.setDeployKey(send, { owner: 'sink-owner', name: 'other' }, { title: 't', key: KEY }))
      .rejects.toThrow('already on another repository')
  })

  test('a push hook is added once, and a second connect rewrites its secret rather than adding another', async () => {
    const send  = sendVia(app, await registerAtSink(account))
    const url   = 'https://basecamp.test/hooks/git/a1'
    const first = await github.setPushHook(send, REPO, { url, secret: 'one' })
    expect(first).toMatchObject({ url, events: ['push'], active: true })
    const again = await github.setPushHook(send, REPO, { url, secret: 'two' })
    expect(again.id).toBe(first.id)
    const stored = sink.hooksOf('sink-owner/app')
    expect(stored).toHaveLength(1)
    expect((stored[0].config as any)).toMatchObject({ url, secret: 'two', content_type: 'json' })
  })

  test('a token without Webhooks is refused by name at the hook, after the key it may write', async () => {
    const send = sendVia(app, await registerAtSink(await ghAccount('gh-nohooks', NO_HOOKS_TOKEN)))
    await expect(github.setPushHook(send, REPO, { url: 'https://basecamp.test/hooks/git/a2', secret: 's' }))
      .rejects.toThrow('give it Webhooks')
  })

  test('a repository the token cannot see is refused by name', async () => {
    const send = sendVia(app, await registerAtSink(account))
    await expect(github.setDeployKey(send, { owner: 'sink-owner', name: 'private' }, { title: 't', key: KEY }))
      .rejects.toThrow('sink-owner/private was not found')
  })

  test('a file is read at the forge, the first path it holds, and a path it lacks is null', async () => {
    const send = sendVia(app, await registerAtSink(account))
    expect(await github.readFile(send, REPO, { paths: ['deploy/Dockerfile', 'Dockerfile'], ref: 'main' }))
      .toEqual({ path: 'Dockerfile', content: 'FROM oven/bun:1\nEXPOSE 3000\n' })
    expect(await github.readFile(send, { owner: 'sink-owner', name: 'other' }, { paths: ['Dockerfile'] })).toBeNull()
    await expect(github.readFile(send, { owner: 'sink-owner', name: 'private' }, { paths: ['Dockerfile'] }))
      .rejects.toThrow('sink-owner/private was not found')
  })

  test('the secrets service accepts it as a provider key', async () => {
    const made = await env.as(owner).service('secrets').create({
      workspaceId: ws.id, name: 'gh-typed', kind: 'provider_key', providerKind: 'github', data: GH_TOKEN,
    }) as any
    expect(made.providerKind).toBe('github')
  })

  test('the machine wizard does not offer it', async () => {
    const answer = await env.as(owner).service('servers').call('providers', null, {}) as any
    expect(answer.providers.map((p: any) => p.kind)).not.toContain('github')
    expect(answer.accounts.map((a: any) => a.providerKind)).not.toContain('github')
  })
})

describe('the schema', () => {
  test('a Server cannot claim to run at GitHub (FJS-D1607)', async () => {
    await expect((env.system as any).server.create({ data: {
      workspaceId: ws.id, name: 'nope', slug: 'nope', providerKind: 'github',
    }})).rejects.toThrow()
    // The control: the same row at a cloud that makes machines is accepted, so
    // the refusal above is `ComputeProvider` and not a missing column.
    const ok = await (env.system as any).server.create({ data: {
      workspaceId: ws.id, name: 'fine', slug: 'fine', providerKind: 'hetzner',
    }})
    expect(ok.providerKind).toBe('hetzner')
  })
})
