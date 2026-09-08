// api/test/compute.test.ts
// The cloud boundary: a token becomes an account, an account becomes an
// address, and the address answers in this app's own vocabulary.
//
// Two tiers, and they answer different questions.
//
// **The dialect** is graded against a hand-written `send`. No app, no conduit,
// no socket — just *given these bytes from DigitalOcean, what does this app
// believe*. Every one of these is a claim about a vendor's JSON and would be
// untestable through a mock that returned the app's own shapes.
//
// **The seam** is graded through the REAL app: conduit resolves the credential
// out of an `@encrypted` column, writes an `Authorization` header, and a real
// listener on a real port checks it. That is the half a fake cannot reach —
// a descriptor whose ref is wrong fails there and nowhere else, which is
// exactly how every outbound call to an Outpost was broken for two phases
// (`FJS-349`).
//
// Where the stand-in is comes from `registerAccount(…, { address })` and NOT
// from an environment variable. `core/env.ts` snapshots `process.env` when it
// first loads, so a variable set inside `beforeAll` is invisible the moment any
// other test file has imported the app first — the connector then points at the
// REAL DigitalOcean, which is where three of these tests sent their reads until
// the address became a parameter. The descriptor carries it, so nothing about
// import order can change what a send reaches.

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { createTestEnv, session } from '@frontierjs/testing'
import { GatePlugin }    from '@frontierjs/litestone'
import { basecampGateLevel }       from '../src/core/gate.ts'
import { buildBasecampApp }        from '../src/app.ts'
import { startDoSink }             from '../src/providers/compute/sink.ts'
import { connectorFor, targetFor } from '../src/providers/compute/index.ts'
import { registerAccount, sendVia } from '../src/providers/compute/accounts.ts'

const SCHEMA     = join(import.meta.dir, '..', '..', 'db', 'schema.lite')
const MIGRATIONS = join(import.meta.dir, '..', '..', 'db', 'migrations')
const ENC_KEY    = '0'.repeat(64)
const SINK_PORT  = 7123
const SINK       = `http://localhost:${SINK_PORT}`

const digitalOcean: any = connectorFor('digitalocean')

/** Register this account against the STAND-IN. Every seam test goes through
 *  here, so no assertion below can reach a real vendor by accident.
 *
 *  It THROWS on a null rather than answering one: a null means the row named a
 *  cloud with no connector, and every caller below would then send to a target
 *  that does not exist and read the failure as the thing it was asserting. */
const registerAtSink = async (secret: any): Promise<string> => {
  const target = await registerAccount(app, secret, { address: SINK })
  if (!target) throw new Error(`registerAtSink: ${secret.name} registered nothing`)
  return target
}

let env: any, app: any, sink: any, ws: any, account: any, owner: any

beforeAll(async () => {
  sink = startDoSink(SINK_PORT)

  env = await createTestEnv({
    schema: SCHEMA, migrations: MIGRATIONS, encryptionKey: ENC_KEY,
    plugins: [new GatePlugin({ getLevel: basecampGateLevel })],
    api: ({ db, path }: any) => buildBasecampApp({ db, dbPath: path }),
  })
  app = env.app

  const sys  = env.system as any
  const uniq = Math.random().toString(36).slice(2, 8)
  const acct = await sys.account.create({ data: { slug: `do-${uniq}`, displayName: 'DO' } })
  owner = await sys.user.create({ data: { email: `o-${uniq}@x.co`, accountId: acct.id } })
  ws = await sys.workspace.create({
    data: { accountId: acct.id, name: 'Fleet', slug: `fleet-${uniq}`, ownerId: owner.id },
  })
  // A membership, because a standing here is per WORKSPACE and read off this
  // row — without it the owner is an authenticated stranger to their own fleet.
  const { grantsFor } = await import('../src/core/capabilities.ts')
  await sys.workspaceMember.create({ data: {
    workspaceId: ws.id, userId: owner.id, role: 'owner', capabilities: grantsFor('owner'),
  }})

  // The workspace rides on the SESSION. A principal with no workspace is
  // refused by the tenant claim guard before any service runs — which is the
  // declaration working, not a fixture detail to route around.
  owner = session({ userId: owner.id, workspaceId: ws.id })
  account = await sys.secret.create({ data: {
    workspaceId: ws.id, name: 'do-main', kind: 'provider_key',
    providerKind: 'digitalocean', data: JSON.stringify({ token: 'dop_v1_devtoken' }),
  }})
})

afterAll(async () => { sink?.stop(); await env?.close?.() })

// ─── The dialect ─────────────────────────────────────────────────────────

/** A `send` that answers whatever the test hands it. No transport. */
const canned = (answers: Record<string, unknown>, status = 200) =>
  async (req: { path: string }) => {
    const key = Object.keys(answers).find(k => req.path.startsWith(k))
    return key
      ? { data: answers[key], status }
      : { data: null, status: 404, error: { kind: 'client_error' } }
  }

describe('the DigitalOcean dialect', () => {
  test('a price of dollars crosses as minor units and a currency', async () => {
    const cat = await digitalOcean.catalog(canned({
      '/v2/regions': { regions: [] },
      '/v2/sizes':   { sizes: [{ slug: 's', description: 'S', vcpus: 1, memory: 1024, disk: 25,
                                 price_monthly: 24, regions: ['nyc3'] }] },
      '/v2/images':  { images: [] },
    }))
    expect(cat.sizes[0].priceMinor).toBe(2400)
    expect(cat.sizes[0].currency).toBe('USD')
  })

  test('a price that is not a whole cent ROUNDS rather than truncating', async () => {
    // The negative control for the line above: `24` passes under a `* 100` that
    // drops the fraction, under `Math.floor`, and under `Math.round`. Only a
    // value with a fraction of a cent separates them.
    const cat = await digitalOcean.catalog(canned({
      '/v2/regions': { regions: [] },
      '/v2/sizes':   { sizes: [{ slug: 'c-4', price_monthly: 84.005, vcpus: 4, memory: 8192,
                                 disk: 50, regions: [] }] },
      '/v2/images':  { images: [] },
    }))
    expect(cat.sizes[0].priceMinor).toBe(8401)
  })

  test("DO's four words are normalized, and a fifth is `unknown` rather than a guess", async () => {
    const state = async (s: string) => (await digitalOcean.machine(
      canned({ '/v2/droplets/': { droplet: { id: 1, status: s, networks: { v4: [] } } } }), '1'
    ))!.status

    expect(await state('active')).toBe('running')
    expect(await state('new')).toBe('starting')
    expect(await state('off')).toBe('off')
    expect(await state('archive')).toBe('deleting')
    // The one that matters: a word this app has never seen must NOT land on the
    // nearest thing, because every one of those words drives a state machine.
    expect(await state('migrating')).toBe('unknown')
  })

  test('the PUBLIC address is chosen, never the private one', async () => {
    const m = await digitalOcean.machine(canned({ '/v2/droplets/': { droplet: {
      id: 1, status: 'active',
      networks: { v4: [{ ip_address: '10.0.0.9', type: 'private' },
                       { ip_address: '203.0.113.9', type: 'public' }] },
    }}}), '1')
    expect(m!.ipAddress).toBe('203.0.113.9')
  })

  test('a machine still building has no address, and that is not an error', async () => {
    const m = await digitalOcean.machine(canned({ '/v2/droplets/': { droplet: {
      id: 1, status: 'new', networks: { v4: [] },
    }}}), '1')
    expect(m!.ipAddress).toBeNull()
    expect(m!.status).toBe('starting')
  })

  test('a 404 is *the vendor no longer has it*; any other failure is not knowing', async () => {
    // The distinction the caller turns into a `reportDestroyed` move, so
    // collapsing them destroys a machine's row over a bad request.
    const gone = await digitalOcean.machine(
      async () => ({ data: null, status: 404, error: { kind: 'client_error' } }), '1')
    expect(gone).toBeNull()

    await expect(digitalOcean.machine(
      async () => ({ data: null, status: 400, error: { kind: 'client_error' } }), '1'
    )).rejects.toThrow(/400/)

    // And a transport that never reached the vendor must not read as *gone*
    // either — conduit answers this shape with no status at all.
    await expect(digitalOcean.machine(
      async () => ({ data: null, error: { kind: 'timeout' } }), '1'
    )).rejects.toThrow(/timeout/)
  })

  test('one failed call in a catalog fails the catalog, rather than half of one', async () => {
    // A picker rendering regions with an empty size list looks like an account
    // with no sizes, which is a sentence nobody wrote.
    await expect(digitalOcean.catalog(async (req: { path: string }) =>
      req.path.startsWith('/v2/sizes')
        ? { data: null, status: 401, error: { kind: 'auth_failed' } }
        : { data: { regions: [], images: [] }, status: 200 }
    )).rejects.toThrow(/auth_failed/)
  })
})

// ─── The seam ────────────────────────────────────────────────────────────

describe('an account is an address', () => {
  test('the target names the ACCOUNT, not the vendor', async () => {
    const target = await registerAtSink(account)
    expect(target).toBe(`provider:digitalocean:${account.id}`)
  })

  test('two accounts at one cloud are two addresses', async () => {
    // `FJS-1020` in one assertion: keyed on the vendor alone, the second
    // registration overwrites the first and one workspace spends the other's
    // token.
    const second = await (env.system as any).secret.create({ data: {
      workspaceId: ws.id, name: 'do-second', kind: 'provider_key',
      providerKind: 'digitalocean', data: JSON.stringify({ token: 'dop_v1_other' }),
    }})
    const a = await registerAtSink(account)
    const b = await registerAtSink(second)
    expect(a).not.toBe(b)
    expect(await app.conduit.resolve(a)).toBeTruthy()
    expect(await app.conduit.resolve(b)).toBeTruthy()
  })

  test('the descriptor carries a REF and the material is nowhere in it', async () => {
    const target     = await registerAtSink(account)
    const descriptor = await app.conduit.resolve(target)
    expect(descriptor.auth.ref).toBe(`secret:${account.id}#token`)
    expect(JSON.stringify(descriptor)).not.toContain('dop_v1_devtoken')
  })

  test('the token is resolved out of an @encrypted column and reaches the vendor', async () => {
    // The whole seam in one call: conduit reads `secret:<id>#token`, decrypts,
    // writes `Authorization: Bearer …`, and a real listener checks it.
    const target = await registerAtSink(account)
    const cat    = await digitalOcean.catalog(sendVia(app, target))
    expect(cat.regions.length).toBeGreaterThan(0)
    expect(cat.sizes.find((s: any) => s.slug === 's-2vcpu-4gb').priceMinor).toBe(2400)
  })

  test('an unavailable region is carried through as unavailable', async () => {
    const target = await registerAtSink(account)
    const cat    = await digitalOcean.catalog(sendVia(app, target))
    expect(cat.regions.find((r: any) => r.slug === 'ams2').available).toBe(false)
  })

  test('verify ASKS the vendor — and a token it rejects does not verify', async () => {
    // Paired, because a verify that answered false for everything would satisfy
    // any test that only checked the refusal.
    const good = await registerAtSink(account)
    expect(await digitalOcean.verify(sendVia(app, good))).toBe(true)

    const bad = await (env.system as any).secret.create({ data: {
      workspaceId: ws.id, name: 'do-revoked', kind: 'provider_key',
      providerKind: 'digitalocean', data: JSON.stringify({ token: 'dop_v1_wrong' }),
    }})
    expect(await digitalOcean.verify(sendVia(app, await registerAtSink(bad)))).toBe(false)
  })

  test('a cloud with no connector registers nothing, and is not an error', async () => {
    // A workspace may hold a key for something Basecamp cannot speak to. That
    // is a fact about the fleet, not a startup failure.
    const hetzner = await (env.system as any).secret.create({ data: {
      workspaceId: ws.id, name: 'hz', kind: 'provider_key',
      providerKind: 'hetzner', data: JSON.stringify({ token: 'x' }),
    }})
    // The raw call, not the throwing helper: a null IS the assertion here.
    expect(await registerAccount(app, hetzner, { address: SINK })).toBeNull()
  })

  test('a secret that is not a provider key is not an account', async () => {
    const key = await (env.system as any).secret.create({ data: {
      workspaceId: ws.id, name: 'deploy-key', kind: 'ssh_key',
      data: JSON.stringify({ private: 'x' }),
    }})
    expect(await registerAccount(app, key, { address: SINK })).toBeNull()
  })
})

describe('the schema refuses an account that names no cloud', () => {
  test('a provider key without a providerKind is refused at the Data boundary', async () => {
    // Not a service check — the table itself. `asSystem()` cannot get past it
    // either, which is what makes it a rule rather than a convention.
    await expect((env.system as any).secret.create({ data: {
      workspaceId: ws.id, name: `nameless-${Math.random()}`, kind: 'provider_key',
      data: JSON.stringify({ token: 'x' }),
    }})).rejects.toThrow(/names the cloud/)
  })

  test('every other kind may leave it null', async () => {
    const row = await (env.system as any).secret.create({ data: {
      workspaceId: ws.id, name: `generic-${Math.random()}`, kind: 'generic',
      data: JSON.stringify({ v: 1 }),
    }})
    expect(row.providerKind).toBeNull()
  })
})

// ─── The guard ───────────────────────────────────────────────────────────

describe('spending money is refused by default', () => {
  test('a GET at a real vendor address is fine — a read costs no money', async () => {
    // The pair that makes the guard a guard rather than a blanket refusal. If
    // reads were blocked too, every assertion below would pass against a
    // mechanism that simply broke the connector.
    const target = await registerAccount(app, account, { address: 'https://api.digitalocean.com' })
    const send   = sendVia(app, target!)
    // It will fail at DigitalOcean — the token is not real — but it must fail
    // THERE, having been sent, rather than being refused here.
    const res = await send({ method: 'GET', path: '/v2/account' })
    expect(res.error?.kind).toBe('auth_failed')
  })

  test('a POST at a real vendor address is REFUSED before anything is sent', async () => {
    const target = await registerAccount(app, account, { address: 'https://api.digitalocean.com' })
    await expect(sendVia(app, target!)({ method: 'POST', path: '/v2/droplets', body: {} }))
      .rejects.toThrow(/has not said it means to/)
  })

  test('and so is a DELETE', async () => {
    const target = await registerAccount(app, account, { address: 'https://api.digitalocean.com' })
    await expect(sendVia(app, target!)({ method: 'DELETE', path: '/v2/droplets/1' }))
      .rejects.toThrow(/refusing to DELETE/)
  })

  test('a POST at a stand-in on localhost is allowed', async () => {
    // The other half of the pair: the guard must not make the sink unusable,
    // or every provisioning test would have to disable it and it would be
    // testing nothing.
    const target = await registerAtSink(account)
    const made   = await digitalOcean.create(sendVia(app, target!), {
      name: 'guard-ok', region: 'nyc3', size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64',
      userData: '#!/bin/bash\ntrue', tags: ['basecamp:server:guard'],
    })
    expect(made.providerServerId).toBeTruthy()
  })

  test('the refusal names an address that is not loopback, whatever the host', async () => {
    // Fail-closed: the test is *is this a stand-in on my machine*, never *is
    // this one of the vendor origins I remembered to list*. A host nobody
    // recognizes is treated as real.
    const target = await registerAccount(app, account, { address: 'https://cloud.example.internal' })
    await expect(sendVia(app, target!)({ method: 'POST', path: '/v2/droplets', body: {} }))
      .rejects.toThrow(/cloud\.example\.internal/)
  })
})

// ─── Making and unmaking a machine ───────────────────────────────────────

describe('a machine is made, and can be unmade', () => {
  const spec = (over: Record<string, unknown> = {}) => ({
    name: 'prod-web-01', region: 'nyc3', size: 's-2vcpu-4gb', image: 'ubuntu-24-04-x64',
    userData: '#!/bin/bash\ntrue', tags: ['basecamp:server:abc'], ...over,
  })

  test('a create sends the spec and answers the vendor id', async () => {
    const { resetSink, CREATED } = await import('../src/providers/compute/sink.ts')
    resetSink()
    const send = sendVia(app, await registerAtSink(account))

    const made = await digitalOcean.create(send, spec())
    expect(made.providerServerId).toBeTruthy()
    expect(CREATED).toHaveLength(1)
    expect(CREATED[0]).toMatchObject({ region: 'nyc3', size: 's-2vcpu-4gb' })
  })

  test('the user_data crosses whole — it is the entire install', async () => {
    const { resetSink, CREATED } = await import('../src/providers/compute/sink.ts')
    resetSink()
    const send = sendVia(app, await registerAtSink(account))
    await digitalOcean.create(send, spec({ userData: '#!/bin/bash\necho hello' }))
    expect((CREATED[0] as any).user_data).toContain('echo hello')
  })

  test('the TAG crosses, and it is the only thread back to an orphan', async () => {
    const { resetSink, CREATED } = await import('../src/providers/compute/sink.ts')
    resetSink()
    const send = sendVia(app, await registerAtSink(account))
    await digitalOcean.create(send, spec({ tags: ['basecamp:server:xyz'] }))
    expect((CREATED[0] as any).tags).toEqual(['basecamp:server:xyz'])
  })

  test('a new machine is `starting` and has no address — never `running`', async () => {
    // A create answers before the machine is up at every cloud. A caller that
    // read the create response as *ready* would work against a fake and fail
    // against every real vendor.
    const { resetSink } = await import('../src/providers/compute/sink.ts')
    resetSink()
    const send = sendVia(app, await registerAtSink(account))
    const made = await digitalOcean.create(send, spec())
    const seen = await digitalOcean.machine(send, made.providerServerId)
    expect(seen!.status).toBe('starting')
    expect(seen!.ipAddress).toBeNull()
  })

  test('once the cloud brings it up it is `running` WITH an address', async () => {
    const { resetSink, sinkBoot } = await import('../src/providers/compute/sink.ts')
    resetSink()
    const send = sendVia(app, await registerAtSink(account))
    const made = await digitalOcean.create(send, spec())
    sinkBoot(made.providerServerId, '203.0.113.77')
    const seen = await digitalOcean.machine(send, made.providerServerId)
    expect(seen!.status).toBe('running')
    expect(seen!.ipAddress).toBe('203.0.113.77')
  })

  test('a size the region does not offer is refused BY THE VENDOR', async () => {
    // The picker filters sizes by region; this is what happens when something
    // gets past it. It must be an error, not a machine of the wrong shape.
    const { resetSink } = await import('../src/providers/compute/sink.ts')
    resetSink()
    const send = sendVia(app, await registerAtSink(account))
    await expect(digitalOcean.create(send, spec({ size: 'c-4', region: 'fra1' })))
      .rejects.toThrow(/refused the create/)
  })

  test('an unavailable region is refused too', async () => {
    const send = sendVia(app, await registerAtSink(account))
    await expect(digitalOcean.create(send, spec({ region: 'ams2' })))
      .rejects.toThrow(/refused the create/)
  })

  test('a destroy removes it, and running it AGAIN still answers true', async () => {
    // Idempotent on purpose: every path into a destroy is a job that may be
    // redelivered, and a destroy that throws the second time is one that cannot
    // be retried to completion.
    const { resetSink } = await import('../src/providers/compute/sink.ts')
    resetSink()
    const send = sendVia(app, await registerAtSink(account))
    const made = await digitalOcean.create(send, spec())

    expect(await digitalOcean.destroy(send, made.providerServerId)).toBe(true)
    expect(await digitalOcean.machine(send, made.providerServerId)).toBeNull()
    expect(await digitalOcean.destroy(send, made.providerServerId)).toBe(true)
  })

  test('reconciliation finds a machine by tag — the orphan case', async () => {
    // The only question that can find what nothing on this side recorded, which
    // is why it is a LIST and not a lookup.
    const { resetSink } = await import('../src/providers/compute/sink.ts')
    resetSink()
    const send = sendVia(app, await registerAtSink(account))
    await digitalOcean.create(send, spec({ tags: ['basecamp:server:orphan'] }))

    const found = await digitalOcean.tagged(send, 'basecamp:server:orphan')
    expect(found).toHaveLength(1)

    // And the negative control: the seeded droplet carries no tag, so a search
    // that ignored the filter would return it too.
    expect(await digitalOcean.tagged(send, 'basecamp:server:nobody')).toHaveLength(0)
  })
})

// ─── Enrollment ──────────────────────────────────────────────────────────

describe('a machine claims its own credential', () => {
  test('a token matches its hash inside the window', async () => {
    const { mintEnrollToken, enrollTokenMatches } = await import('../src/providers/compute/enrollment.ts')
    const t = mintEnrollToken()
    expect(enrollTokenMatches(t.token, t.hash, t.expiresAt)).toBe(true)
  })

  test('a wrong token, an expired window and a missing hash all refuse', async () => {
    const { mintEnrollToken, enrollTokenMatches } = await import('../src/providers/compute/enrollment.ts')
    const t = mintEnrollToken()
    expect(enrollTokenMatches('bcen_wrong', t.hash, t.expiresAt)).toBe(false)
    expect(enrollTokenMatches(t.token, t.hash, new Date(Date.now() - 1))).toBe(false)
    expect(enrollTokenMatches(t.token, null, t.expiresAt)).toBe(false)
    expect(enrollTokenMatches(null, t.hash, t.expiresAt)).toBe(false)
  })

  test('the cloud-init carries the TOKEN and no credential', async () => {
    const { mintEnrollToken, cloudInit } = await import('../src/providers/compute/enrollment.ts')
    const t  = mintEnrollToken()
    const ci = cloudInit({ serverId: 's1', basecampUrl: 'http://basecamp', token: t.token, outpostPort: 8180 })

    // What must be in it: the one-time token and where to spend it.
    expect(ci).toContain(t.token)
    expect(ci).toContain('/servers/s1/enroll')
    // What must NOT be: the fleet secret. Metadata is readable by anything on
    // the box, so baking it in hands every machine the key to forge every
    // other machine's check-in.
    expect(ci).not.toContain(process.env.OUTPOST_SECRET ?? 'outpost-dev-secret')
    // And the hash is not in there either — it is what the DATABASE keeps.
    expect(ci).not.toContain(t.hash)
  })
})

// ─── The whole chain ─────────────────────────────────────────────────────

describe('a machine is provisioned, enrolls itself, and can be destroyed', () => {
  test('provision writes the row BEFORE the vendor is called', async () => {
    // The order is the design. A create that called the cloud first and crashed
    // before writing leaves a machine nobody here can name — and the row is
    // what the enrollment token, the tag and every later step hang off.
    const { resetSink } = await import('../src/providers/compute/sink.ts')
    resetSink()
    await registerAtSink(account)

    const server = await env.as(owner).service('servers').call('provision', null, {
      name: 'prod-web-01', role: 'general', accountId: account.id,
      region: 'nyc3', size: 's-2vcpu-4gb', image: 'ubuntu-24-04-x64',
    }) as any

    expect(server.status).toBe('provisioning')
    expect(server.providerId).toBe(account.id)
    expect(server.registerMethod).toBe('provisioned')
    // Nothing has been created yet — the job has not run.
    expect(server.providerServerId).toBeNull()
  })

  test("the VENDOR's price is copied onto the row, not the caller's", async () => {
    // `/cloud-spend/` reports what a fleet costs. A client that posted
    // `priceMinor` would be reporting its own arithmetic back to the person
    // paying the bill, so the number is read from the catalog here and the
    // caller sends only a size slug.
    const row = await (env.system as any).server.findFirst({ where: { name: 'prod-web-01' } })
    const plan = typeof row.plan === 'string' ? JSON.parse(row.plan) : row.plan

    expect(plan.priceMinor).toBe(2400)     // s-2vcpu-4gb, $24.00 at the sink
    expect(plan.currency).toBe('USD')
    // The two `view fleetByProvider` sums. Without these the report groups
    // every machine under zero vCPU and nothing says so.
    expect(plan.vcpu).toBe(2)
    expect(plan.ramGb).toBe(4)
    expect(plan.diskGb).toBe(80)
  })

  test('a size the vendor does not offer is refused HERE, before anything is written', async () => {
    // Paired with the provision above, which is the same call one slug over.
    // Refusing inside the job leaves a row stuck at `provisioning` and the
    // vendor's own wording in a log nobody reads.
    await expect(env.as(owner).service('servers').call('provision', null, {
      name: 'imaginary', role: 'general', accountId: account.id,
      region: 'nyc3', size: 's-99vcpu-1tb', image: 'ubuntu-24-04-x64',
    })).rejects.toThrow(/not a size/)

    const row = await (env.system as any).server.findFirst({ where: { name: 'imaginary' } })
    expect(row).toBeNull()
  })

  test('a size the vendor does not offer IN THAT REGION is refused too', async () => {
    await expect(env.as(owner).service('servers').call('provision', null, {
      name: 'wrong-place', role: 'general', accountId: account.id,
      region: 'ams2', size: 's-2vcpu-4gb', image: 'ubuntu-24-04-x64',
    })).rejects.toThrow(/does not offer/)
  })

  test('the enrollment token is minted as a HASH, and the row never holds the token', async () => {
    const row = await (env.system as any).server.findFirst({ where: { name: 'prod-web-01' } })
    expect(row.enrollTokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.enrollExpiresAt).toBeTruthy()
    // A `Server` is readable by every member of the workspace, so a column
    // holding the live token would let any of them enroll as the machine.
    expect(JSON.stringify(row)).not.toContain('bcen_')
  })

  test('the create step tags the machine with its own row id', async () => {
    const { CREATED } = await import('../src/providers/compute/sink.ts')
    const row = await (env.system as any).server.findFirst({ where: { name: 'prod-web-01' } })

    await env.as(owner).service('servers').call('provisionStep', row.id, {
      step: 'create', enrollToken: 'bcen_test',
    })

    expect(CREATED).toHaveLength(1)
    // Two tags: the fleet one a sweep can search for, and the identity one that
    // turns a found machine back into this row. A vendor's tag filter is an
    // exact match, so the first is what makes reconciliation possible at all.
    expect((CREATED[0] as any).tags).toEqual(['basecamp', `basecamp:server:${row.id}`])
    // And the vendor's id is recorded — the window an orphan is born in.
    const after = await (env.system as any).server.findFirst({ where: { id: row.id } })
    expect(after.providerServerId).toBeTruthy()
  })

  test('polling does NOT move the row while the machine has no address', async () => {
    // Running-with-no-address cannot have enrolled, so moving on it would
    // report an install that has not started. Paired with the row below.
    const row = await (env.system as any).server.findFirst({ where: { name: 'prod-web-01' } })
    const seen = await env.as(owner).service('servers').call('provisionStep', row.id, { step: 'poll' }) as any
    expect(seen.status).toBe('provisioning')
  })

  test('…and DOES once the cloud brings it up with one', async () => {
    const { sinkBoot } = await import('../src/providers/compute/sink.ts')
    const row = await (env.system as any).server.findFirst({ where: { name: 'prod-web-01' } })
    sinkBoot(String(row.providerServerId), '203.0.113.90')

    const seen = await env.as(owner).service('servers').call('provisionStep', row.id, { step: 'poll' }) as any
    expect(seen.status).toBe('installing')
    expect(seen.ipAddress).toBe('203.0.113.90')
  })

  test('a destroy without the typed name is REFUSED', async () => {
    // `docs/VISION.md` constraint 5. The friction is the feature, and the thing
    // typed is the thing destroyed — so a stale screen cannot confirm the wrong
    // row.
    const row = await (env.system as any).server.findFirst({ where: { name: 'prod-web-01' } })
    await expect(env.as(owner).service('servers').call('destroy', row.id, {}))
      .rejects.toThrow(/Type the machine's name/)
    await expect(env.as(owner).service('servers').call('destroy', row.id, { confirm: 'wrong' }))
      .rejects.toThrow(/Type the machine's name/)

    // Still standing. A refusal that had moved the row would be worse than none.
    const after = await (env.system as any).server.findFirst({ where: { id: row.id } })
    expect(after.status).toBe('installing')
  })

  test('with the name it moves to `destroying` — and only the vendor lands `destroyed`', async () => {
    const row = await (env.system as any).server.findFirst({ where: { name: 'prod-web-01' } })
    const asked = await env.as(owner).service('servers').call('destroy', row.id, {
      confirm: 'prod-web-01',
    }) as any
    // Not `destroyed`. A machine this app believes is gone is one the cloud has
    // confirmed is gone, never one a button claimed.
    expect(asked.status).toBe('destroying')

    const done = await env.as(owner).service('servers').call('destroyStep', row.id) as any
    expect(done.status).toBe('destroyed')
  })

  test('reconcile finds a machine at the vendor that this app does not know', async () => {
    // The orphan case, and the only question a lookup cannot ask.
    const { resetSink } = await import('../src/providers/compute/sink.ts')
    resetSink()
    const send = sendVia(app, await registerAtSink(account))
    await digitalOcean.create(send, {
      name: 'ghost', region: 'nyc3', size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64',
      userData: '#!/bin/bash\ntrue', tags: ['basecamp', 'basecamp:server:never-recorded'],
    })

    const report = await env.as(owner).service('servers').call('reconcile', null, {
      accountId: account.id,
    }) as any

    expect(report.orphans).toHaveLength(1)
    expect(report.orphans[0].providerServerId).toBeTruthy()
    // It REPORTS and never deletes: a machine it cannot account for might be a
    // create still in flight, and a sweep that destroyed what it did not
    // recognize would eventually destroy something real.
    expect(await digitalOcean.machine(send, report.orphans[0].providerServerId)).not.toBeNull()
  })

  test('…and a machine this app knows that the vendor no longer has', async () => {
    // The other direction: somebody destroyed it in the provider's own console.
    // One count alone says nothing about whether the comparison runs both ways.
    const server = await env.as(owner).service('servers').call('provision', null, {
      name: 'vanished', role: 'general', accountId: account.id,
      region: 'nyc3', size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64',
    }) as any
    await (env.system as any).server.update({
      where: { id: server.id }, data: { providerServerId: '999999' },
    })

    const report = await env.as(owner).service('servers').call('reconcile', null, {
      accountId: account.id,
    }) as any
    expect(report.missing.some((m: any) => m.name === 'vanished')).toBe(true)
  })
})

// ─── The enrollment route, over HTTP ─────────────────────────────────────

/**
 * The pure half of enrollment is graded above — a token matches its hash inside
 * the window, and does not outside it. This is the OTHER half, and it is the
 * one that matters: `FJS-349` was a route whose comment claimed a credential
 * check that existed nowhere, and every function it called was correct.
 *
 * So every row here goes down real HTTP, at a route with no session, no
 * signature and no principal — which is what this door is and is why it is the
 * only one in the app shaped like it.
 *
 * **What this does NOT prove**: the secret handed back is verified by nothing
 * yet. `requireOutpostSignature` still reads the fleet-wide `OUTPOST_SECRET`,
 * so a per-machine credential is minted, stored, and unused until P3 narrows
 * that read. Stated here rather than left for a reader to infer from a test
 * that looks complete.
 */
describe('a machine enrolls itself, over HTTP, holding nothing else', () => {
  let target: any, minted: string

  test('a provisioned machine is handed a token that is not in its own row', async () => {
    const { resetSink } = await import('../src/providers/compute/sink.ts')
    resetSink()
    await registerAtSink(account)

    const server = await env.as(owner).service('servers').call('provision', null, {
      name: 'enrollee', role: 'general', accountId: account.id,
      region: 'nyc3', size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64',
    }) as any

    // The token exists only in the return of the mint, which the provision job
    // carries into cloud-init. Re-derive it here the way the job does, so this
    // file is presenting a token a machine could actually be holding.
    const { mintEnrollToken, hashEnrollToken } = await import('../src/providers/compute/enrollment.ts')
    minted = mintEnrollToken().token
    await (env.system as any).server.update({
      where: { id: server.id },
      data:  { enrollTokenHash: hashEnrollToken(minted), enrollExpiresAt: new Date(Date.now() + 60_000) },
    })
    // The vendor said where it came up. `publicUrl` is the second thing the
    // exchange answers and it is read off this.
    await (env.system as any).server.update({
      where: { id: server.id }, data: { ipAddress: '203.0.113.7' },
    })
    target = await (env.system as any).server.findFirst({ where: { id: server.id } })

    expect(target.enrollTokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(target)).not.toContain(minted)
  })

  test('the exchange answers a secret and the address the world reaches it at', async () => {
    const res = await env.http.post(`/servers/${target.id}/enroll`).send({ token: minted })

    expect(res.status).toBe(200)
    const body = res.body as any
    expect(body.secret).toMatch(/^[0-9a-f]{64}$/)
    // Not the token back. A route that echoed what it was given would satisfy
    // every other assertion here.
    expect(body.secret).not.toBe(minted)
    expect(body.publicUrl).toBe('http://203.0.113.7:8180')
    expect(body.serverId).toBe(target.id)
  })

  test('the secret is kept as a Secret row, and the machine points at it', async () => {
    const row = await (env.system as any).server.findFirst({ where: { id: target.id } })
    expect(row.outpostSecretId).toBeTruthy()

    const kept = await (env.system as any).secret.findFirst({ where: { id: row.outpostSecretId } })
    expect(kept.workspaceId).toBe(target.workspaceId)
    expect(kept.name).toBe(`outpost:${target.slug}`)
  })

  test('the token is BURNED — the same request a second time is refused', async () => {
    // The claim the conditional update exists for. Paired with the 200 above:
    // a route that refused everybody would pass this row alone.
    const res = await env.http.post(`/servers/${target.id}/enroll`).send({ token: minted })
    expect(res.status).toBe(401)
  })

  test('two machines presenting one token: exactly one is enrolled', async () => {
    // The race the burn is written for, and the only arrangement that can see
    // it. A read-then-write passes every row above and fails this one.
    const { mintEnrollToken, hashEnrollToken } = await import('../src/providers/compute/enrollment.ts')
    const server = await env.as(owner).service('servers').call('provision', null, {
      name: 'raced', role: 'general', accountId: account.id,
      region: 'nyc3', size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64',
    }) as any
    const token = mintEnrollToken().token
    await (env.system as any).server.update({
      where: { id: server.id },
      data:  { enrollTokenHash: hashEnrollToken(token), enrollExpiresAt: new Date(Date.now() + 60_000) },
    })

    const both = await Promise.all([
      env.http.post(`/servers/${server.id}/enroll`).send({ token }),
      env.http.post(`/servers/${server.id}/enroll`).send({ token }),
    ])
    const ok = both.filter(r => r.status === 200)
    expect(ok).toHaveLength(1)
    expect(both.filter(r => r.status === 401)).toHaveLength(1)

    // And one credential, not two. A second Secret row would mean the loser
    // also minted before losing, which is a machine holding a key nothing
    // recognizes.
    const kept = await (env.system as any).secret.findMany({
      where: { name: `outpost:${server.slug}` },
    })
    expect(kept).toHaveLength(1)
  })

  test('a wrong token, an unknown id and an expired window are ONE answer', async () => {
    // The disclosure claim, and it can only be made as a comparison. Each of
    // these refuses for a different reason and an unauthenticated caller must
    // not be able to tell which — a distinguishable *no such server* tells them
    // every id they guessed that WAS real.
    const { mintEnrollToken, hashEnrollToken } = await import('../src/providers/compute/enrollment.ts')

    const expired = await env.as(owner).service('servers').call('provision', null, {
      name: 'too-late', role: 'general', accountId: account.id,
      region: 'nyc3', size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64',
    }) as any
    const stale = mintEnrollToken().token
    await (env.system as any).server.update({
      where: { id: expired.id },
      data:  { enrollTokenHash: hashEnrollToken(stale), enrollExpiresAt: new Date(Date.now() - 1_000) },
    })

    const answers = await Promise.all([
      env.http.post(`/servers/${target.id}/enroll`).send({ token: 'bcen_wrong' }),
      env.http.post('/servers/00000000-0000-0000-0000-000000000000/enroll').send({ token: 'bcen_wrong' }),
      env.http.post(`/servers/${expired.id}/enroll`).send({ token: stale }),
      env.http.post(`/servers/${target.id}/enroll`).send({}),
    ])

    const shapes = new Set(answers.map(r => `${r.status} ${JSON.stringify(r.body)}`))
    expect(shapes.size).toBe(1)
    expect([...shapes][0]).toContain('401')
  })

  test('an expired token does not enroll — the window is not decoration', async () => {
    // The row above proves the four answers are INDISTINGUISHABLE, which a
    // route answering 401 to everything would also satisfy. This one asks
    // whether the expired one was actually refused: its hash is still there.
    const row = await (env.system as any).server.findFirst({ where: { name: 'too-late' } })
    expect(row.enrollTokenHash).toBeTruthy()
    expect(row.outpostSecretId).toBeNull()
  })
})

// ─── The grant table against the schema ──────────────────────────────────

/**
 * Every capability name the SCHEMA implies, read off the parse.
 *
 * The shape matters and is the reason the first version of this file passed
 * while grading nothing: an attribute is `{ kind }`, never `{ name }`, and
 * moves hang off `attributes[].transitions` rather than off the model. Reading
 * the wrong key found zero moves, so *every move is granted* was vacuously true
 * — a tripwire that fires on nothing, which is the exact failure it exists to
 * catch, one level up.
 */
async function schemaCapabilities() {
  const { parseFile } = await import('@frontierjs/litestone')
  const { schema }    = parseFile(SCHEMA) as any

  const human = new Set<string>()   // what a role must be able to hold
  const all   = new Set<string>()   // every name the schema can justify

  for (const model of schema.models) {
    const attrs    = (model.attributes ?? []) as any[]
    const isCapped = attrs.some(a => a.kind === 'capabilities')

    for (const verb of ['create', 'update', 'delete']) all.add(`${model.name}.${verb}`)
    for (const f of model.fields ?? [])
      if ((f.attributes ?? []).some((a: any) => a.kind === 'capability'))
        all.add(`${model.name}.${f.name}`)

    for (const attr of attrs) {
      if (attr.kind !== 'transitions') continue
      for (const [name, move] of Object.entries(attr.transitions ?? {}) as [string, any][]) {
        all.add(`${model.name}.${name}`)
        // `@system` moves are the machine reporting on itself. A move nobody
        // asks for is nobody's grant — `core/capabilities.ts` says so, and
        // granting them would put eleven entries in a role editor of which
        // eight are noise.
        if (isCapped && !move.system) human.add(`${model.name}.${name}`)
      }
    }
    if (isCapped) for (const verb of ['create', 'update', 'delete']) human.add(`${model.name}.${verb}`)
  }
  return { human, all }
}

describe('the grant table and the schema are one vocabulary', () => {
  test('the parse actually finds moves — the tripwire is armed', async () => {
    // The control for the two rows below, and it is not ceremony: both of them
    // pass against an empty set, which is what a wrong key silently produces.
    const { human } = await schemaCapabilities()
    expect(human.has('Server.provision')).toBe(true)
    expect(human.has('Server.drain')).toBe(true)
    // …and a machine's own move is NOT in it.
    expect(human.has('Server.checkIn')).toBe(false)
  })

  test('every human move on a capability model is somebody\'s grant', async () => {
    // `ROLE_GRANTS` is a hand-kept table and `@@transitions` is the schema, and
    // nothing held them together. Adding `provision` and `destroy` was the
    // measurement: both landed, both were gated, and every caller was refused
    // by name — an OWNER included — because the grid had never heard of them.
    const { human }     = await schemaCapabilities()
    const { grantsFor } = await import('../src/core/capabilities.ts')
    const held = new Set(grantsFor('owner'))
    expect([...human].filter(g => !held.has(g))).toEqual([])
  })

  test('and the reverse — the table names no capability the schema cannot justify', async () => {
    // A grant for a move that was renamed or deleted is dead weight in a role
    // editor forever, and reads as a capability somebody has.
    const { all }       = await schemaCapabilities()
    const { grantsFor } = await import('../src/core/capabilities.ts')
    expect(grantsFor('owner').filter(g => !all.has(g))).toEqual([])
  })
})
