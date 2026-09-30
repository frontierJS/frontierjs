// api/test/edge.test.ts
// The edge boundary: a Cloudflare token becomes a workspace ACCOUNT (`FJS-D558`),
// the account an address, and the address answers zones and records in this
// app's own shapes.
//
// compute.test.ts's two tiers. **The dialect** is graded against a hand-written
// `send` — given these bytes from Cloudflare, what does this app believe — and
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
import { startCfSink, EMPTY_TOKEN, BROKEN_ZONE } from '../src/providers/edge/cloudflare-sink.ts'
import { edgeConnectorFor, domainMark } from '../src/providers/edge/index.ts'
import { connectorFor }            from '../src/providers/compute/index.ts'
import { registerAccount, sendVia, accountConnectorFor } from '../src/providers/compute/accounts.ts'

const SCHEMA     = join(import.meta.dir, '..', '..', 'db', 'schema.lite')
const MIGRATIONS = join(import.meta.dir, '..', '..', 'db', 'migrations')
const ENC_KEY    = '0'.repeat(64)
const CF_PORT    = 7127
const CF_SINK    = `http://localhost:${CF_PORT}/client/v4`
const CF_TOKEN   = 'cfat_devtoken'

const cloudflare: any = edgeConnectorFor('cloudflare')

let env: any, app: any, sink: any, ws: any, account: any, owner: any

const registerAtSink = async (secret: any): Promise<string> => {
  const target = await registerAccount(app, secret, { address: CF_SINK })
  if (!target) throw new Error(`registerAtSink: ${secret.name} registered nothing`)
  return target
}

const cfAccount = (name: string, token: string) => (env.system as any).secret.create({ data: {
  workspaceId: ws.id, name, kind: 'provider_key', providerKind: 'cloudflare',
  data: JSON.stringify({ token }),
}})

beforeAll(async () => {
  sink = startCfSink(CF_PORT)

  env = await createTestEnv({
    schema: SCHEMA, migrations: MIGRATIONS, encryptionKey: ENC_KEY,
    plugins: [new GatePlugin({ getLevel: basecampGateLevel })],
    api: ({ db, path }: any) => buildBasecampApp({ db, dbPath: path }),
  })
  app = env.app

  const sys  = env.system as any
  const uniq = Math.random().toString(36).slice(2, 8)
  const acct = await sys.account.create({ data: { slug: `cf-${uniq}`, displayName: 'CF' } })
  const user = await sys.user.create({ data: { email: `o-${uniq}@x.co`, accountId: acct.id } })
  ws = await sys.workspace.create({
    data: { accountId: acct.id, name: 'Edge', slug: `edge-${uniq}`, ownerId: user.id },
  })
  const { grantsFor } = await import('../src/core/capabilities.ts')
  await sys.workspaceMember.create({ data: {
    workspaceId: ws.id, userId: user.id, role: 'owner', capabilities: grantsFor('owner'),
  }})
  owner   = session({ userId: user.id, workspaceId: ws.id })
  account = await cfAccount('cf-main', CF_TOKEN)
})

afterAll(async () => { sink?.stop(); await env?.close?.() })

// ─── The dialect ─────────────────────────────────────────────────────────

describe('Cloudflare dialect', () => {
  const answer = (body: unknown) => async () => ({ data: body, status: 200 })

  test('a 200 whose envelope says it failed is refused, not read as empty', async () => {
    const send = answer({ success: false, errors: [{ code: 1000, message: 'Invalid zone' }], result: [] })
    await expect(cloudflare.records(send, 'z')).rejects.toThrow('Invalid zone')
  })

  test('a record keeps its comment, and a missing one is null rather than empty', async () => {
    const send = answer({ success: true, result: [
      { id: 'a', type: 'A', name: 'x.test', content: '1.2.3.4', proxied: true, ttl: 1, comment: 'basecamp:domain:d' },
      { id: 'b', type: 'MX', name: 'x.test', content: 'mx.test', proxied: false, ttl: 300 },
    ], result_info: { total_pages: 1 } })
    const [a, b] = await cloudflare.records(send, 'z')
    expect(a).toEqual({ id: 'a', type: 'A', name: 'x.test', content: '1.2.3.4', proxied: true, ttl: 1,
      comment: 'basecamp:domain:d', mark: { fleet: 'basecamp', domainId: 'd' } })
    expect(b.comment).toBeNull()
    expect(b.mark).toBeNull()
    expect(b.proxied).toBe(false)
  })

  test('the mark is read off the comment, and a comment that only looks like one is not ours', async () => {
    const comments = ['basecamp', 'basecamp:domain:d7', 'basecamp-ish', 'basecamp:server:s1', 'added by hand']
    const send = answer({ success: true, result_info: { total_pages: 1 }, result: comments.map((comment, i) =>
      ({ id: `r${i}`, type: 'TXT', name: 'x.test', content: '"x"', ttl: 1, comment })) })
    expect((await cloudflare.records(send, 'z')).map((r: any) => r.mark)).toEqual([
      { fleet: 'basecamp' }, { fleet: 'basecamp', domainId: 'd7' }, null, null, null,
    ])
  })

  test('a list walks every page total_pages names', async () => {
    const asked: string[] = []
    const send = async (req: any) => {
      asked.push(req.path)
      const page = Number(new URL(req.path, 'http://x').searchParams.get('page'))
      return { data: { success: true, result: [{ id: `z${page}`, name: `${page}.test`, status: 'active' }],
        result_info: { page, total_pages: 3 } }, status: 200 }
    }
    expect((await cloudflare.zones(send)).map((z: any) => z.id)).toEqual(['z1', 'z2', 'z3'])
    expect(asked).toHaveLength(3)
  })

  test('verify: a 4xx is a bad token, anything else is not knowing', async () => {
    expect(await cloudflare.verify(async () => ({ data: null, status: 403, error: { kind: 'client_error' } }))).toBe(false)
    await expect(cloudflare.verify(async () => ({ data: null, status: 503, error: { kind: 'server_error' } })))
      .rejects.toThrow('server_error')
  })
})

// ─── The seam ────────────────────────────────────────────────────────────

describe('a Cloudflare account', () => {
  test('is an account connector, and not somewhere to make machines', () => {
    expect(accountConnectorFor('cloudflare')?.label).toBe('Cloudflare')
    expect(connectorFor('cloudflare')).toBeNull()
  })

  test('registers as provider:cloudflare:<secretId>, carrying a ref and never the token', async () => {
    const target = await registerAtSink(account)
    expect(target).toBe(`provider:cloudflare:${account.id}`)
    const descriptor = await app.conduit.resolve(target)
    expect(descriptor.auth.ref).toBe(`secret:${account.id}#token`)
    expect(JSON.stringify(descriptor)).not.toContain(CF_TOKEN)
  })

  test('reads every zone through the sink, across its pages', async () => {
    // The sink pages at 2, so four zones is two requests — the walk is taken.
    const zones = await cloudflare.zones(sendVia(app, await registerAtSink(account)))
    expect(zones.map((z: any) => z.name).sort()).toEqual(['broken.test', 'example.test', 'pending.test', 'shop.test'])
    expect(zones.find((z: any) => z.name === 'pending.test').status).toBe('pending')
  })

  test('reads a zone\'s records, and a broken envelope over HTTP is refused', async () => {
    const send = sendVia(app, await registerAtSink(account))
    const recs = await cloudflare.records(send, 'zone-example')
    expect(recs.map((r: any) => r.type).sort()).toEqual(['CNAME', 'MX', 'TXT'])
    expect(recs.find((r: any) => r.type === 'CNAME').comment).toBe('basecamp:domain:dom-1')
    await expect(cloudflare.records(send, BROKEN_ZONE)).rejects.toThrow('Invalid zone configuration')
  })

  test('verify: a working token verifies; one it refuses, or one that opens no zone, does not', async () => {
    // Paired, because a verify that answered false for everything would pass
    // the two refusals on its own.
    expect(await cloudflare.verify(sendVia(app, await registerAtSink(account)))).toBe(true)
    const revoked = await cfAccount('cf-revoked', 'cfat_wrong')
    expect(await cloudflare.verify(sendVia(app, await registerAtSink(revoked)))).toBe(false)
    const empty = await cfAccount('cf-empty', EMPTY_TOKEN)
    expect(await cloudflare.verify(sendVia(app, await registerAtSink(empty)))).toBe(false)
  })

  test('the secrets service accepts it as a provider key', async () => {
    const made = await env.as(owner).service('secrets').create({
      workspaceId: ws.id, name: 'cf-typed', kind: 'provider_key', providerKind: 'cloudflare', data: CF_TOKEN,
    }) as any
    expect(made.providerKind).toBe('cloudflare')
  })

  test('the machine wizard does not offer it', async () => {
    const answer = await env.as(owner).service('servers').call('providers', null, {}) as any
    expect(answer.providers.map((p: any) => p.kind)).not.toContain('cloudflare')
    expect(answer.accounts.map((a: any) => a.providerKind)).not.toContain('cloudflare')
  })
})

describe('the schema', () => {
  test('a Server cannot claim to run at Cloudflare (FJS-D559)', async () => {
    await expect((env.system as any).server.create({ data: {
      workspaceId: ws.id, name: 'nope', slug: 'nope', providerKind: 'cloudflare',
    }})).rejects.toThrow()
    // The control: the same row at a cloud that makes machines is accepted, so
    // the refusal above is the check and not a missing column.
    const ok = await (env.system as any).server.create({ data: {
      workspaceId: ws.id, name: 'fine', slug: 'fine', providerKind: 'hetzner',
    }})
    expect(ok.providerKind).toBe('hetzner')
  })
})

// ─── The service ─────────────────────────────────────────────────────────
//
// A workspace of its own, so the accounts the tests above made — one of them
// registered at the REAL Cloudflare by the secrets service — are not asked.

describe('the edge service', () => {
  let site: any, developer: any, good: any, revoked: any, stranger: any, bare: any
  const tag = () => Math.random().toString(36).slice(2, 8)

  const member = async (sys: any, workspaceId: string, accountId: string, role: string) => {
    const { grantsFor } = await import('../src/core/capabilities.ts')
    const u = await sys.user.create({ data: { email: `${role}-${tag()}@x.co`, accountId } })
    await sys.workspaceMember.create({ data: { workspaceId, userId: u.id, role, capabilities: grantsFor(role) } })
    return session({ userId: u.id, workspaceId })
  }

  beforeAll(async () => {
    const sys  = env.system as any
    const acct = await sys.account.create({ data: { slug: `dns-${tag()}`, displayName: 'DNS' } })
    const own  = await sys.user.create({ data: { email: `dns-${tag()}@x.co`, accountId: acct.id } })
    site = await sys.workspace.create({ data: { accountId: acct.id, name: 'DNS', slug: `dns-${tag()}`, ownerId: own.id } })
    // A developer is 4, below the Secret's read gate of 5 — the level the
    // service must NOT borrow, or the screen tells a developer no account exists.
    developer = await member(sys, site.id, acct.id, 'developer')

    const mk = async (workspaceId: string, name: string, token: string) => {
      const s = await sys.secret.create({ data: {
        workspaceId, name, kind: 'provider_key', providerKind: 'cloudflare', data: JSON.stringify({ token }),
      }})
      await registerAtSink(s)
      return s
    }
    good    = await mk(site.id, 'cf-a-good', CF_TOKEN)
    revoked = await mk(site.id, 'cf-b-revoked', 'cfat_wrong')
    stranger = await mk(ws.id, `cf-elsewhere-${tag()}`, CF_TOKEN)

    const project = await sys.project.create({ data: { workspaceId: site.id, name: 'P', slug: `p-${tag()}` } })
    const e       = await sys.environment.create({ data: { workspaceId: site.id, projectId: project.id, name: 'E', slug: `e-${tag()}` } })
    const web     = await sys.app.create({ data: { workspaceId: site.id, environmentId: e.id, name: 'web', slug: `web-${tag()}`,
      source: { kind: 'image', image: 'nginx:alpine' } } })
    for (const hostname of ['Example.test', 'www.example.test', 'elsewhere.test'])
      await sys.domain.create({ data: { workspaceId: site.id, appId: web.id, hostname } })

    const other = await sys.workspace.create({ data: { accountId: acct.id, name: 'Bare', slug: `bare-${tag()}`, ownerId: own.id } })
    bare = await member(sys, other.id, acct.id, 'developer')
  })

  const edge = (who: any) => env.as(who).service('edge')

  test('lists every account with its zones, at a developer\'s standing, and never the token', async () => {
    const { accounts } = await edge(developer).call('zones', null, {}) as any
    expect(accounts.map((a: any) => a.name)).toEqual(['cf-a-good', 'cf-b-revoked'])
    expect(accounts[0].zones.map((z: any) => z.name).sort()).toEqual(['broken.test', 'example.test', 'pending.test', 'shop.test'])
    expect(JSON.stringify(accounts)).not.toContain(CF_TOKEN)
  })

  test('a refused account carries its error and no zones, and does not blank the other', async () => {
    const { accounts } = await edge(developer).call('zones', null, {}) as any
    const bad = accounts.find((a: any) => a.id === revoked.id)
    expect(bad.zones).toBeNull()
    expect(bad.error).toContain('Cloudflare')
    expect(accounts.find((a: any) => a.id === good.id).error).toBeNull()
  })

  test('records sit beside the workspace\'s Domains: matched, and missing', async () => {
    const answer = await edge(developer).call('records', null, { accountId: good.id, zoneId: 'zone-example' }) as any
    expect(answer.zone.name).toBe('example.test')

    const byType = Object.fromEntries(answer.records.map((r: any) => [r.type, r]))
    // The apex CNAME serves `Example.test` — matched regardless of case.
    expect(byType.CNAME.domainId).not.toBeNull()
    // An MX at the same name serves no hostname, so it matches no Domain.
    expect(byType.MX.domainId).toBeNull()
    // www has a Domain and no record; elsewhere.test is not in this zone at all.
    expect(answer.missing.map((d: any) => d.hostname)).toEqual(['www.example.test'])
  })

  test('a vendor refusal is a 502 with the vendor\'s message', async () => {
    await expect(edge(developer).call('records', null, { accountId: good.id, zoneId: BROKEN_ZONE }))
      .rejects.toMatchObject({ code: 502, message: expect.stringContaining('Invalid zone configuration') })
  })

  test('another workspace\'s account is not found, before any vendor is asked', async () => {
    await expect(edge(developer).call('records', null, { accountId: stranger.id, zoneId: 'zone-example' }))
      .rejects.toMatchObject({ code: 404 })
  })

  test('the portal reports the accounts: configured, named, and degraded by the revoked one', async () => {
    const portal = env.as(developer).service('portal')
    const listed = (await portal.find({}) as any).data.find((e: any) => e.id === 'edge')
    expect(listed).toMatchObject({ configured: true, adapter: 'Cloudflare', status: 'healthy', hosted: true })
    expect((await portal.get('edge') as any).status).toBe('degraded')
  })

  test('a workspace with no edge account reports unconfigured and lists nothing', async () => {
    expect((await env.as(bare).service('portal').get('edge') as any)).toMatchObject({ configured: false, status: 'unconfigured' })
    expect((await edge(bare).call('zones', null, {}) as any).accounts).toEqual([])
  })
})

// ─── The writes (FJS-D562) ───────────────────────────────────────────────
//
// Against `zone-shop`, which starts holding somebody else's records only: an MX
// at the apex and an A at www. The listener is this file's own, so a write here
// is a record in no other suite.

describe('the writes', () => {
  const ZONE   = 'zone-shop'
  const mark   = domainMark('dom-shop')
  let send: any, sent: any[]

  // Every request the connector made, so *nothing was sent* is a reading
  // rather than an inference from the zone looking unchanged.
  beforeAll(async () => {
    const real = sendVia(app, await registerAtSink(account))
    send = async (req: any) => { sent.push(req); return real(req) }
  })
  const posts = () => sent.filter(r => r.method === 'POST')
  const zone  = () => cloudflare.records(send, ZONE)
  const at    = async (name: string, type: string) => (await zone()).filter((r: any) => r.name === name && r.type === type)

  test('append adds marked records and touches nothing already there', async () => {
    sent = []
    const made = await cloudflare.appendRecords(send, ZONE, mark,
      [{ type: 'CNAME', name: 'App.Shop.Test.', content: 'ingress.fleet.test', proxied: true }])
    expect(made).toHaveLength(1)
    expect(made[0]).toMatchObject({ name: 'app.shop.test', proxied: true, ttl: 1,
      comment: 'basecamp:domain:dom-shop', mark: { fleet: 'basecamp', domainId: 'dom-shop' } })
    expect(posts()).toHaveLength(1)
    expect((await zone()).map((r: any) => r.id).sort()).toEqual([made[0].id, 'rec-shop-mx', 'rec-shop-www'].sort())
  })

  test('a set at the apex leaves the MX beside it, and a second set replaces rather than adds', async () => {
    // The ruling's artefact: an unmarked SIBLING — same name, another type — survives.
    await cloudflare.setRecords(send, ZONE, mark, [{ type: 'CNAME', name: 'shop.test', content: 'one.fleet.test' }])
    const [second] = await cloudflare.setRecords(send, ZONE, mark, [{ type: 'CNAME', name: 'shop.test', content: 'two.fleet.test' }])
    expect(second.content).toBe('two.fleet.test')
    expect((await at('shop.test', 'CNAME')).map((r: any) => r.content)).toEqual(['two.fleet.test'])
    expect((await at('shop.test', 'MX'))).toMatchObject([{ id: 'rec-shop-mx', content: 'mx.mail.test', comment: null }])
  })

  test('a set already true is no write at all, and one whose ttl moved is a patch that keeps the record', async () => {
    const [before] = await at('shop.test', 'CNAME')
    sent = []
    await cloudflare.setRecords(send, ZONE, mark, [{ type: 'CNAME', name: 'shop.test', content: 'TWO.fleet.test.' }])
    expect(posts()).toHaveLength(0)

    const [after] = await cloudflare.setRecords(send, ZONE, mark, [{ type: 'CNAME', name: 'shop.test', content: 'two.fleet.test', ttl: 300 }])
    expect(after).toMatchObject({ id: before.id, ttl: 300 })
    expect(posts()[0].body).toMatchObject({ deletes: [], posts: [], patches: [{ id: before.id, ttl: 300 }] })
  })

  test('a set of several values keeps the one it still wants and drops the other', async () => {
    const name = 'lb.shop.test'
    const two  = await cloudflare.setRecords(send, ZONE, mark, [
      { type: 'A', name, content: '198.51.100.1' }, { type: 'A', name, content: '198.51.100.2' }])
    const keep = two.find((r: any) => r.content === '198.51.100.2')
    await cloudflare.setRecords(send, ZONE, mark, [{ type: 'A', name, content: '198.51.100.2' }])
    expect(await at(name, 'A')).toMatchObject([{ id: keep.id, content: '198.51.100.2' }])
  })

  test('a delete naming a mark removes only the records that mark wrote', async () => {
    // Two owners in one set — the case a Domain's removal replayed after its
    // hostname moved to another Domain is.
    const name = 'pair.shop.test'
    await cloudflare.appendRecords(send, ZONE, domainMark('first'),  [{ type: 'A', name, content: '198.51.100.21' }])
    await cloudflare.appendRecords(send, ZONE, domainMark('second'), [{ type: 'A', name, content: '198.51.100.22' }])
    const gone = await cloudflare.deleteRecords(send, ZONE, [{ type: 'A', name, mark: domainMark('first') }])
    expect(gone.map((r: any) => r.content)).toEqual(['198.51.100.21'])
    expect(await at(name, 'A')).toMatchObject([{ content: '198.51.100.22', mark: { domainId: 'second' } }])
  })

  test('a set holding a record basecamp did not write is refused, and so is every other set in the call', async () => {
    sent = []
    await expect(cloudflare.setRecords(send, ZONE, mark, [
      { type: 'A', name: 'fresh.shop.test', content: '198.51.100.9' },
      { type: 'A', name: 'www.shop.test',   content: '198.51.100.9' },
    ])).rejects.toThrow(/A www\.shop\.test holds a record basecamp did not write \(rec-shop-www/)
    expect(posts()).toHaveLength(0)
    expect(await at('fresh.shop.test', 'A')).toEqual([])
    expect(await at('www.shop.test', 'A')).toMatchObject([{ id: 'rec-shop-www', content: '192.0.2.10' }])
  })

  test('a delete removes marked records, answers them, and refuses a foreign set', async () => {
    const gone = await cloudflare.deleteRecords(send, ZONE, [{ type: 'A', name: 'lb.shop.test' }])
    expect(gone.map((r: any) => r.content)).toEqual(['198.51.100.2'])
    expect(await at('lb.shop.test', 'A')).toEqual([])

    await expect(cloudflare.deleteRecords(send, ZONE, [{ type: 'MX', name: 'shop.test' }]))
      .rejects.toThrow('did not write')
    expect(await at('shop.test', 'MX')).toHaveLength(1)
  })

  test('a batch Cloudflare refuses applies none of itself', async () => {
    // Two sets, one call: an A and a CNAME at one name is Cloudflare's refusal,
    // and the A — the half that was fine — must not be left behind.
    await expect(cloudflare.setRecords(send, ZONE, mark, [
      { type: 'A',     name: 'mix.shop.test', content: '198.51.100.3' },
      { type: 'CNAME', name: 'mix.shop.test', content: 'ingress.fleet.test' },
    ])).rejects.toThrow('An A, AAAA, or CNAME record with that host already exists')
    expect((await zone()).filter((r: any) => r.name === 'mix.shop.test')).toEqual([])
  })

  test('a write at the real Cloudflare is refused from a process that has not said it means to', async () => {
    const real = await cfAccount('cf-real', CF_TOKEN)
    const target = await registerAccount(app, real, { address: 'https://api.cloudflare.com/client/v4' })
    await expect(cloudflare.appendRecords(sendVia(app, target!), ZONE, mark,
      [{ type: 'TXT', name: 'shop.test', content: '"x"' }])).rejects.toThrow(/refusing to POST .* live DNS/)
  })
})

// ─── sync: a Domain pushed (IDEAS/cloudflare-edge.md Phase 4) ─────────────
//
// The ingress zone is `zone-shop` and the Domains live in `zone-example`, so
// the two writes land in two zones, the case a single-zone test cannot see.

describe('sync', () => {
  let site: any, admin: any, developer: any, web: any, idle: any, api: any, taken: any, moved: any
  let online1: any, online2: any
  const tag = () => Math.random().toString(36).slice(2, 8)
  const edge = (who: any) => env.as(who).service('edge')
  const shopRecords = async () => await edge(admin).call('records', null, { accountId: good.id, zoneId: 'zone-shop' }) as any
  let good: any

  beforeAll(async () => {
    const sys  = env.system as any
    const { grantsFor } = await import('../src/core/capabilities.ts')
    const acct = await sys.account.create({ data: { slug: `sync-${tag()}`, displayName: 'Sync' } })
    const own  = await sys.user.create({ data: { email: `sync-${tag()}@x.co`, accountId: acct.id } })
    site = await sys.workspace.create({ data: { accountId: acct.id, name: 'Sync', slug: `sync-${tag()}`, ownerId: own.id } })
    await sys.workspaceMember.create({ data: { workspaceId: site.id, userId: own.id, role: 'owner', capabilities: grantsFor('owner') } })
    admin = session({ userId: own.id, workspaceId: site.id })
    const dev = await sys.user.create({ data: { email: `dev-${tag()}@x.co`, accountId: acct.id } })
    await sys.workspaceMember.create({ data: { workspaceId: site.id, userId: dev.id, role: 'developer', capabilities: grantsFor('developer') } })
    developer = session({ userId: dev.id, workspaceId: site.id })

    good = await sys.secret.create({ data: {
      workspaceId: site.id, name: 'cf-sync', kind: 'provider_key', providerKind: 'cloudflare', data: JSON.stringify({ token: CF_TOKEN }),
    }})
    await registerAtSink(good)

    // A Server is born `pending` and reaches `online` by its moves, as
    // services.test.ts walks it.
    const WALK: Record<string, string[]> = { online: ['checkIn'], draining: ['checkIn', 'drain'] }
    const server = async (name: string, status: string, ipAddress: string) => {
      let row = await sys.server.create({ data: { workspaceId: site.id, name, slug: `${name}-${tag()}`, ipAddress, providerKind: 'custom' } })
      for (const move of WALK[status]) row = await sys.server.transition(row.id, move)
      return row
    }
    online1       = await server('one',   'online',   '203.0.113.5')
    online2       = await server('two',   'online',   '203.0.113.6')
    const drained = await server('three', 'draining', '203.0.113.7')

    const project = await sys.project.create({ data: { workspaceId: site.id, name: 'P', slug: `p-${tag()}` } })
    const e       = await sys.environment.create({ data: { workspaceId: site.id, projectId: project.id, name: 'E', slug: `e-${tag()}` } })
    const mkApp   = (name: string) => sys.app.create({ data: { workspaceId: site.id, environmentId: e.id, name, slug: `${name}-${tag()}`,
      source: { kind: 'image', image: 'nginx:alpine' } } })
    web  = await mkApp('web')
    idle = await mkApp('idle')

    // Released to one machine; placed-but-never-released on the second; and
    // running on a draining one, which a release would no longer be sent to.
    await sys.appServer.create({ data: { appId: web.id, serverId: online1.id, status: 'running' } })
    await sys.appServer.create({ data: { appId: web.id, serverId: online2.id } })
    await sys.appServer.create({ data: { appId: web.id, serverId: drained.id, status: 'running' } })
    await sys.appServer.create({ data: { appId: idle.id, serverId: online1.id } })

    const domain = (appId: string, hostname: string, extra = {}) =>
      sys.domain.create({ data: { workspaceId: site.id, appId, hostname, ...extra } })
    api   = await domain(web.id, 'API.example.test', { proxied: true })
    taken = await domain(web.id, 'www.shop.test')
    moved = await domain(web.id, 'go.example.test', { redirectTo: 'https://api.example.test' })
  })

  test('with no ingress zone it refuses, and says what to set', async () => {
    await expect(edge(admin).call('sync', api.id, {}))
      .rejects.toMatchObject({ code: 409, message: expect.stringContaining('no ingress zone') })
  })

  test('…and the job SKIPS it, because a workspace with no edge writes Domains too', async () => {
    expect(await edge(developer).call('syncStep', api.id) as any)
      .toMatchObject({ domainId: api.id, skipped: expect.stringContaining('no ingress zone') })
  })

  test('the ingress zone is an account and a zone together, or neither', async () => {
    const version = async () => (await (env.system as any).workspace.findFirst({ where: { id: site.id } })).version
    const workspaces = env.as(admin).service('workspaces')
    await expect(workspaces.patch(site.id, { ingressZoneId: 'zone-shop', version: await version() }))
      .rejects.toThrow(/an ingress zone names its account and its zone together/)
    await workspaces.patch(site.id, { ingressAccountId: good.id, ingressZoneId: 'zone-shop', version: await version() })
  })

  test('pushes the ingress record, then the CNAME to it, each marked, carrying proxied', async () => {
    const out = await edge(admin).call('sync', api.id, {}) as any
    const name = `${web.id}.shop.test`
    // Only the online machine the release landed on — not the placement no
    // release reached, and not the draining one.
    expect(out.ingress).toMatchObject({ name, addresses: ['203.0.113.5'] })
    expect(out.record).toMatchObject({ type: 'CNAME', name: 'api.example.test', content: name, proxied: true,
      mark: { fleet: 'basecamp', domainId: api.id } })

    const ingress = (await cloudflare.records(sendVia(app, `provider:cloudflare:${good.id}`), 'zone-shop'))
      .filter((r: any) => r.name === name)
    expect(ingress).toMatchObject([{ type: 'A', content: '203.0.113.5', mark: { fleet: 'basecamp', appId: web.id } }])
    expect((await shopRecords()).stale).toEqual([])
  })

  test('a release landing on a second machine is drift until synced, and then it is not', async () => {
    const { markRunning } = await import('../src/core/runtime.ts')
    await markRunning(app.db, web.id, online2.id)

    const name = `${web.id}.shop.test`
    expect((await shopRecords()).stale).toEqual([
      { appId: web.id, name, have: ['203.0.113.5'], want: ['203.0.113.5', '203.0.113.6'] }])

    const out = await edge(admin).call('sync', api.id, {}) as any
    expect(out.ingress.records.map((r: any) => r.content).sort()).toEqual(['203.0.113.5', '203.0.113.6'])
    expect((await shopRecords()).stale).toEqual([])
  })

  test('a hostname holding a record basecamp did not write is refused, nothing written, and named in drift', async () => {
    const before = (await shopRecords()).records.length
    await expect(edge(admin).call('sync', taken.id, {}))
      .rejects.toMatchObject({ code: 409, message: expect.stringContaining('A 192.0.2.10') })
    const after = await shopRecords()
    expect(after.records.length).toBe(before)
    expect(after.conflicts.map((d: any) => d.hostname)).toEqual(['www.shop.test'])
  })

  test('a redirect, an app running nowhere, and a developer are each refused', async () => {
    await expect(edge(admin).call('sync', moved.id, {}))
      .rejects.toMatchObject({ code: 409, message: expect.stringContaining('FJS-1610') })

    const quiet = await (env.system as any).domain.create({ data: { workspaceId: site.id, appId: idle.id, hostname: 'idle.example.test' } })
    await expect(edge(admin).call('sync', quiet.id, {}))
      .rejects.toMatchObject({ code: 409, message: expect.stringContaining('runs on no online server') })

    await expect(edge(developer).call('sync', api.id, {})).rejects.toMatchObject({ code: 403 })
  })

  // ─── the job ─────────────────────────────────────────────────────────
  //
  // Everything above called `sync`. From here nobody does: a Domain written
  // through `domains` reaches the zone on its own, so each assertion waits on
  // what Cloudflare holds rather than on an answer from this app.

  const zoneRecs = (zoneId: string) => cloudflare.records(sendVia(app, `provider:cloudflare:${good.id}`), zoneId)
  const until = async <T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 10_000): Promise<T> => {
    const end = Date.now() + ms
    for (;;) {
      const v = await read()
      if (done(v) || Date.now() > end) return v
      await Bun.sleep(50)
    }
  }
  const cnameAt = async (host: string) => (await zoneRecs('zone-example')).find((r: any) => r.name === host && r.type === 'CNAME')
  let made: any

  test('a Domain added through `domains` reaches its zone with nobody pressing sync', async () => {
    made = await env.as(admin).service('domains').create({ appId: web.id, hostname: 'shop.example.test' })
    const record = await until(() => cnameAt('shop.example.test'), Boolean)
    expect(record).toMatchObject({ content: `${web.id}.shop.test`, proxied: false, mark: { domainId: made.id } })
  })

  test('a change to it is pushed as well', async () => {
    const fresh = await (env.system as any).domain.findFirst({ where: { id: made.id } })
    await env.as(admin).service('domains').patch(made.id, { proxied: true, version: fresh.version })
    expect(await until(() => cnameAt('shop.example.test'), (r: any) => r?.proxied === true))
      .toMatchObject({ proxied: true })
  })

  test('a hostname is fixed once added, and the same one resent is not a change', async () => {
    const fresh = await (env.system as any).domain.findFirst({ where: { id: made.id } })
    await expect(env.as(admin).service('domains').patch(made.id, { hostname: 'moved.example.test', version: fresh.version }))
      .rejects.toMatchObject({ code: 400, message: expect.stringContaining('fixed once added') })
    await env.as(admin).service('domains').patch(made.id, { hostname: 'shop.example.test', port: 8443, version: fresh.version })
  })

  test('a deleted Domain takes its CNAME with it, and leaves the App\'s ingress record', async () => {
    await env.as(admin).service('domains').remove(made.id)
    expect(await until(() => cnameAt('shop.example.test'), (r: any) => !r)).toBeUndefined()
    const ingress = (await zoneRecs('zone-shop')).filter((r: any) => r.name === `${web.id}.shop.test`)
    expect(ingress.length).toBeGreaterThan(0)
  })

  test('…and removes only its OWN: a hostname another Domain holds keeps that Domain\'s record', async () => {
    // A workspace keeps a deleted hostname in the trash, so the newcomer is a
    // Domain elsewhere writing the same zone — and a replay of the first
    // Domain's removal must find no record of its own and delete nothing.
    await cloudflare.setRecords(sendVia(app, `provider:cloudflare:${good.id}`), 'zone-example', domainMark('elsewhere'),
      [{ type: 'CNAME', name: 'shop.example.test', content: `${web.id}.shop.test` }])
    expect(await edge(admin).call('syncStep', made.id) as any).toMatchObject({ removed: [] })
    expect(await cnameAt('shop.example.test')).toMatchObject({ mark: { domainId: 'elsewhere' } })
  })

  test('a job refused by a record somebody else made is a 409, not a skip', async () => {
    await expect(edge(admin).call('syncStep', taken.id))
      .rejects.toMatchObject({ code: 409, message: expect.stringContaining('A 192.0.2.10') })
  })

  test('a record marked for a Domain that does not exist is an orphan', async () => {
    await cloudflare.appendRecords(sendVia(app, `provider:cloudflare:${good.id}`), 'zone-example', domainMark('no-such-domain'),
      [{ type: 'CNAME', name: 'ghost.example.test', content: `${web.id}.shop.test` }])
    const answer = await edge(admin).call('records', null, { accountId: good.id, zoneId: 'zone-example' }) as any
    expect(answer.orphans.map((r: any) => r.name)).toContain('ghost.example.test')
  })
})
