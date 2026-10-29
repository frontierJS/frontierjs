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

// Every Domain write also pushes its App's routes to the machines running it
// (`FJS-1610`), and none of these machines has an outpost. The stub answers
// for them, or every `domain:dns` job here would be a route push retrying.
process.env.BASECAMP_STUB_OUTPOST = '1'

const SCHEMA     = join(import.meta.dir, '..', '..', 'db', 'schema.lite')
const MIGRATIONS = join(import.meta.dir, '..', '..', 'db', 'migrations')
const ENC_KEY    = '0'.repeat(64)
const sink       = startCfSink(0)
const CF_SINK    = `http://localhost:${sink.port}/client/v4`
const CF_TOKEN   = 'cfat_devtoken'

const cloudflare: any = edgeConnectorFor('cloudflare')

let env: any, app: any, ws: any, account: any, owner: any

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
  owner   = session({ id: user.id, workspaceId: ws.id })
  account = await cfAccount('cf-main', CF_TOKEN)
})

afterAll(async () => { sink.stop(); await env?.close?.() })

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
  test('a Server cannot claim to run at Cloudflare (FJS-D1607)', async () => {
    await expect((env.system as any).server.create({ data: {
      workspaceId: ws.id, name: 'nope', slug: 'nope', providerKind: 'cloudflare',
    }})).rejects.toThrow()
    // The control: the same row at a cloud that makes machines is accepted, so
    // the refusal above is `ComputeProvider` and not a missing column.
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
    return session({ id: u.id, workspaceId })
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
    // …and why: no ingress zone is set, so no push could write it.
    expect(answer.missing[0].why).toBe('no-ingress')
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
    admin = session({ id: own.id, workspaceId: site.id })
    const dev = await sys.user.create({ data: { email: `dev-${tag()}@x.co`, accountId: acct.id } })
    await sys.workspaceMember.create({ data: { workspaceId: site.id, userId: dev.id, role: 'developer', capabilities: grantsFor('developer') } })
    developer = session({ id: dev.id, workspaceId: site.id })

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
    // Each move reaches `pushAppsOn` through a `$tapEvents` tap a tick later.
    // Run late, they would find the App placed below and queue a `domain:dns`
    // job per Domain, whose push races the sync tests' own and writes the
    // ingress A record twice (FJS-2890, FJS-3221).
    await new Promise(r => setImmediate(() => setImmediate(r)))

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
    const before = await edge(developer).call('records', null, { accountId: good.id, zoneId: 'zone-example' }) as any
    expect(before.missing.find((d: any) => d.id === api.id).why).toBe('no-ingress')
    await workspaces.patch(site.id, { ingressAccountId: good.id, ingressZoneId: 'zone-shop', version: await version() })
  })

  test('zones names the ingress zone, and a missing hostname a push would write carries no cause', async () => {
    expect((await edge(developer).call('zones', null, {}) as any).ingress).toEqual({ accountId: good.id, zoneId: 'zone-shop' })
    const { missing } = await edge(developer).call('records', null, { accountId: good.id, zoneId: 'zone-example' }) as any
    expect(missing.find((d: any) => d.id === api.id).why).toBeNull()
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

    // Proxied under a Flexible zone, Caddy's HTTPS redirect loops (FJS-D1422).
    const rules = await sendVia(app, `provider:cloudflare:${good.id}`)({ method: 'GET',
      path: '/zones/zone-example/rulesets/phases/http_config_settings/entrypoint' })
    expect((rules.data as any).result.rules).toMatchObject([{ expression: 'http.host eq "api.example.test"',
      description: `basecamp:domain:${api.id}`, action_parameters: { ssl: 'strict' } }])
  })

  test('a release landing on a second machine is drift until synced, and then it is not', async () => {
    const { markRunning } = await import('../src/domain/release/runtime.ts')
    await markRunning(app.db, web.id, online2.id)

    const name = `${web.id}.shop.test`
    expect((await shopRecords()).stale).toEqual([
      { appId: web.id, name, have: ['203.0.113.5'], want: ['203.0.113.5', '203.0.113.6'], down: false }])

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

  // FJS-1615: a redirect answers from Caddy on the machine the CNAME leads to,
  // so the zone side is the same push as any other Domain's.
  test('a redirecting Domain is pushed to the zone like any other', async () => {
    const out = await edge(admin).call('sync', moved.id, {}) as any
    expect(out.record).toMatchObject({ type: 'CNAME', name: 'go.example.test', content: `${web.id}.shop.test`,
      mark: { fleet: 'basecamp', domainId: moved.id } })
  })

  test('an app running nowhere, and a developer, are each refused', async () => {
    const quiet = await (env.system as any).domain.create({ data: { workspaceId: site.id, appId: idle.id, hostname: 'idle.example.test' } })
    await expect(edge(admin).call('sync', quiet.id, {}))
      .rejects.toMatchObject({ code: 409, message: expect.stringContaining('runs on no online server') })
    const { missing } = await edge(developer).call('records', null, { accountId: good.id, zoneId: 'zone-example' }) as any
    expect(missing.find((d: any) => d.id === quiet.id).why).toBe('no-machine')

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

  // ─── the machines' routes ────────────────────────────────────────────
  //
  // The same job sends the App's hostnames to Caddy on each machine running it
  // (`FJS-1610`), the set the ingress record names: a running placement on an
  // online server, never a draining one or one nothing has deployed to.

  test('a Domain\'s App is routed on every machine its ingress record names, with its live hostnames', async () => {
    const { routeDomainApp } = await import('../src/jobs/domain-dns.job.ts')
    const out = await routeDomainApp(app, api.id)
    expect(out.failed).toEqual([])
    expect(out.routed.map(r => r.serverId).sort()).toEqual([online1.id, online2.id].sort())
    // The redirect is not a host the app answers, and the deleted Domain dropped out.
    const hosts = out.routed[0].hosts.map(h => h.toLowerCase())
    expect(hosts).toContain('www.shop.test')
    expect(hosts).not.toContain('go.example.test')
    expect(hosts).not.toContain('shop.example.test')
    // The redirect goes to the machine beside them (FJS-1615).
    expect(out.routed[0].redirects).toEqual([{ host: 'go.example.test', to: 'https://api.example.test' }])
  })

  test('an inline App is routed to the static origin, not skipped (FJS-1615)', async () => {
    const { routeDomainApp } = await import('../src/jobs/domain-dns.job.ts')
    const sys    = env.system as any
    const inline = await sys.app.create({ data: { workspaceId: site.id, environmentId: web.environmentId, name: 'paste', slug: 'paste',
      source: { kind: 'inline', files: [] } } })
    await sys.appServer.create({ data: { appId: inline.id, serverId: online1.id, status: 'running' } })
    const d = await sys.domain.create({ data: { workspaceId: site.id, appId: inline.id, hostname: 'paste.example.test' } })
    const out = await routeDomainApp(app, d.id)
    expect(out.failed).toEqual([])
    expect(out.routed.map(r => r.hosts)).toEqual([['paste.example.test']])
  })

  test('a preview\'s thaw sends the redirects and paths beside the hosts, or Outpost removes them (FJS-2562)', async () => {
    const { thawPreview } = await import('../src/domain/workbench/workbench-preview.ts')
    const sys    = env.system as any
    const prev   = await sys.app.create({ data: { workspaceId: site.id, environmentId: web.environmentId, name: 'prev', slug: 'prev', port: 5173 } })
    const other  = await sys.app.create({ data: { workspaceId: site.id, environmentId: web.environmentId, name: 'other', slug: 'other' } })
    const d      = await sys.domain.create({ data: { workspaceId: site.id, appId: prev.id, hostname: 'try.preview.test' } })
    await sys.domain.create({ data: { workspaceId: site.id, appId: prev.id, hostname: 'old.preview.test', redirectTo: 'https://try.preview.test' } })
    await sys.domainRoute.create({ data: { workspaceId: site.id, domainId: d.id, appId: other.id, pathPrefix: '/api' } })

    const sent: any[] = []
    const conduit = { resolve: async () => ({ pinned_cert: true }), send: async (call: any) => { sent.push(call); return { data: {} } } }
    const via = new Proxy(app, { get: (t, k) => k === 'conduit' ? conduit : typeof t[k] === 'function' ? t[k].bind(t) : t[k] })

    const settings = { serverId: online1.id } as any
    const thaw = (appId: string) => app.runAs(admin.id,{ tenant: site.id }, () => thawPreview(via, settings, { appId } as any))
    const out = await thaw(prev.id)
    expect(out.ok).toBe(true)
    expect(sent.map(s => s.path)).toEqual(['/route'])
    expect(sent[0].body).toMatchObject({ app_id: prev.id, hosts: ['try.preview.test'], port: 5173,
      redirects: [{ host: 'old.preview.test', to: 'https://try.preview.test' }] })

    await sys.app.update({ where: { id: other.id }, data: { port: 5174 } })
    await thaw(other.id)
    expect(sent[1].body).toMatchObject({ app_id: other.id, hosts: [], paths: [{ host: 'try.preview.test', prefix: '/api' }] })
  })

  test('a path route pushes both Apps, the prefix to the one holding it and the host to the Domain\'s own (FJS-2647)', async () => {
    const { routeDomainApp } = await import('../src/jobs/domain-dns.job.ts')
    const { routedPaths }    = await import('../src/domain/release/runtime.ts')
    const sys    = env.system as any
    const front  = await sys.app.create({ data: { workspaceId: site.id, environmentId: web.environmentId, name: 'front', slug: 'front',
      source: { kind: 'inline', files: [] } } })
    const back   = await sys.app.create({ data: { workspaceId: site.id, environmentId: web.environmentId, name: 'back', slug: 'back' } })
    await sys.appServer.create({ data: { appId: front.id, serverId: online1.id, status: 'running' } })
    await sys.appServer.create({ data: { appId: back.id,  serverId: online1.id, status: 'running' } })
    const d = await sys.domain.create({ data: { workspaceId: site.id, appId: front.id, hostname: 'split.example.test' } })
    await sys.domainRoute.create({ data: { workspaceId: site.id, domainId: d.id, appId: back.id, pathPrefix: '/api' } })

    expect(await routedPaths(app.db, back.id)).toEqual([{ host: 'split.example.test', prefix: '/api' }])
    expect(await routedPaths(app.db, front.id)).toEqual([])

    const out = await routeDomainApp(app, d.id)
    expect(out.failed).toEqual([])
    const by = Object.fromEntries(out.routed.map(r => [r.appId, r]))
    expect(by[front.id]).toMatchObject({ hosts: ['split.example.test'], paths: [] })
    expect(by[back.id]).toMatchObject({ hosts: [], paths: [{ host: 'split.example.test', prefix: '/api' }] })

    // A deleted Domain takes its routes with it: a prefix of a host nobody answers is not routed.
    await sys.domain.delete({ where: { id: d.id } })
    expect(await routedPaths(app.db, back.id)).toEqual([])
  })

  test('a machine with no outpost to take its route is a failure naming it, so the job retries', async () => {
    const { routeDomainApp } = await import('../src/jobs/domain-dns.job.ts')
    delete process.env.BASECAMP_STUB_OUTPOST
    try {
      const out = await routeDomainApp(app, api.id)
      expect(out.routed).toEqual([])
      expect(out.failed.map(f => f.server).sort()).toEqual(['one', 'two'])
      expect(out.failed[0].error).toContain('No outpost is registered')
    } finally {
      process.env.BASECAMP_STUB_OUTPOST = '1'
    }
  })

  // ─── a machine moving ────────────────────────────────────────────────
  //
  // No release and no Domain write: the fleet moving is what makes the App's
  // ingress record wrong here (`FJS-1614`), and each push is dispatched as the
  // app — a sweep and a check-in have no caller to run as.

  const ingressAt = async () => (await zoneRecs('zone-shop'))
    .filter((r: any) => r.name === `${web.id}.shop.test` && r.type === 'A').map((r: any) => r.content).sort()
  const servers = () => env.as(admin).service('servers')

  test('a machine drained with no release leaves its App\'s record', async () => {
    expect(await ingressAt()).toEqual(['203.0.113.5', '203.0.113.6'])
    await servers().call('drain', online2.id)
    expect(await until(ingressAt, (v: string[]) => v.length === 1)).toEqual(['203.0.113.5'])
  })

  test('…and undrained, it is put back', async () => {
    await servers().call('undrain', online2.id)
    expect(await until(ingressAt, (v: string[]) => v.length === 2)).toEqual(['203.0.113.5', '203.0.113.6'])
  })

  test('an App left on no online machine keeps its record where it last ran, and drift names it down', async () => {
    const { sweepUnreachable } = await import('../src/jobs/server-reachability.job.ts')
    const sys   = env.system as any
    const quiet = new Date(Date.now() - 3_600_000).toISOString()
    const lose  = async (s: any) => {
      await sys.server.update({ where: { id: s.id }, data: { lastHeartbeatAt: quiet } })
      expect((await sweepUnreachable(app, { serverId: s.id, graceMs: 60_000 })).quiet).toBe(1)
    }

    await lose(online1)
    expect(await until(ingressAt, (v: string[]) => v.length === 1)).toEqual(['203.0.113.6'])

    // The last one. What its own job does is this call, answered as not-yet.
    await lose(online2)
    expect(await edge(developer).call('syncStep', api.id) as any)
      .toMatchObject({ skipped: expect.stringContaining('kept where it last ran') })
    expect(await ingressAt()).toEqual(['203.0.113.6'])
    expect((await shopRecords()).stale).toEqual([
      { appId: web.id, name: `${web.id}.shop.test`, have: ['203.0.113.6'], want: [], down: true }])
  })

  test('a check-in bringing a machine back puts it in the record — an update naming status, not a transition() call', async () => {
    const { generateSigningKeys, signRequest } = await import('@frontierjs/toolbelt/signature')
    const sys  = env.system as any
    // The pair an enrolled machine holds — a check-in is refused without one.
    const keys = await generateSigningKeys()
    await sys.server.update({ where: { id: online1.id }, data: { outpostPublicKey: keys.publicKey } })

    const body = { outpost_version: '0.4.1', health: { cpu: 3, memory: 10 } }
    const path = `/servers/${online1.id}`
    const headers = await signRequest({
      privateKey: keys.privateKey, method: 'POST', path, serviceMethod: 'heartbeat', query: '', body: JSON.stringify(body),
      timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID(),
    })
    const req = env.http.post(path).set('x-service-method', 'heartbeat')
    for (const [k, v] of Object.entries(headers)) req.set(k, v as string)
    expect((await req.send(body)).status).toBe(200)

    expect(await until(ingressAt, (v: string[]) => v[0] === '203.0.113.5')).toEqual(['203.0.113.5'])
  })
})
