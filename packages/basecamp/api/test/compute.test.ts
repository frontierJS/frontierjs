// api/test/compute.test.ts
// The cloud boundary: a token becomes an account, an account becomes an
// address, and the address answers in this app's own vocabulary.
//
// Two tiers, and they answer different questions.
//
// **The dialect** is graded against a hand-written `send`. No app, no conduit,
// no socket — just *given these bytes from the vendor, what does this app
// believe*. Every one of these is a claim about a vendor's JSON and would be
// untestable through a mock that returned the app's own shapes. There are two
// vendors here, and the second one is the point: one connector cannot show a
// boundary is generic, it can only show a boundary is consistent with itself
// (`docs/PROVISIONING.md` § P4).
//
// **The seam** is graded through the REAL app: conduit resolves the credential
// out of an `@encrypted` column, writes an `Authorization` header, and a real
// listener on a real port checks it. That is the half a fake cannot reach —
// a descriptor whose ref is wrong fails there and nowhere else, which is
// exactly how every outbound call to an Outpost was broken for two phases
// (`FJS-349`).
//
// **And the two are graded TOGETHER** — the last describe runs one script
// against both clouds and asserts they answer in the same words. Two dialect
// tiers side by side prove each connector agrees with its own stand-in; only
// the pair can say whether `ComputeConnector` is a translation layer or a
// second spelling of DigitalOcean.
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
import { startDoSink }             from '../src/providers/compute/digitalocean-sink.ts'
import { startHzSink }             from '../src/providers/compute/hetzner-sink.ts'
import { connectorFor, targetFor, markFor, fleetMark, priceIn } from '../src/providers/compute/index.ts'
import { registerAccount, sendVia } from '../src/providers/compute/accounts.ts'
import type { ProviderKind }       from '../../db/schema.d.ts'

const SCHEMA     = join(import.meta.dir, '..', '..', 'db', 'schema.lite')
const MIGRATIONS = join(import.meta.dir, '..', '..', 'db', 'migrations')
const ENC_KEY    = '0'.repeat(64)
const SINK_PORT  = 7123
const SINK       = `http://localhost:${SINK_PORT}`
const HZ_PORT    = 7125
const HZ_SINK    = `http://localhost:${HZ_PORT}`
/** The stand-in's token, which is 64 characters and carries no prefix — DO's
 *  starts `dop_v1_` and Hetzner's does not, which is itself a difference a
 *  screen validating one vendor's shape would get wrong. */
const HZ_TOKEN   = 'hz'.padEnd(64, '0')

const digitalOcean: any = connectorFor('digitalocean')
const hetzner: any      = connectorFor('hetzner')

/** Register this account against the STAND-IN. Every seam test goes through
 *  here, so no assertion below can reach a real vendor by accident.
 *
 *  It THROWS on a null rather than answering one: a null means the row named a
 *  cloud with no connector, and every caller below would then send to a target
 *  that does not exist and read the failure as the thing it was asserting. */
const registerAt = async (secret: any, address: string): Promise<string> => {
  const target = await registerAccount(app, secret, { address })
  if (!target) throw new Error(`registerAt: ${secret.name} registered nothing`)
  return target
}
const registerAtSink = (secret: any) => registerAt(secret, SINK)
const registerAtHz   = (secret: any) => registerAt(secret, HZ_SINK)

let env: any, app: any, sink: any, hzSink: any, ws: any, account: any, hzAccount: any, owner: any

beforeAll(async () => {
  sink   = startDoSink(SINK_PORT)
  hzSink = startHzSink(HZ_PORT)

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
  hzAccount = await sys.secret.create({ data: {
    workspaceId: ws.id, name: 'hz-main', kind: 'provider_key',
    providerKind: 'hetzner', data: JSON.stringify({ token: HZ_TOKEN }),
  }})
})

afterAll(async () => { sink?.stop(); hzSink?.stop(); await env?.close?.() })

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
    // The map's KEYS are the availability list — DO states one price and the
    // regions that have the size, so the entry is filled per region.
    expect(cat.sizes[0].prices).toEqual({ nyc3: 2400 })
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
    // No regions on this size, so the price is nowhere — and that is the
    // rounding still being asserted, through `priceIn` on a size that has one.
    const priced = await digitalOcean.catalog(canned({
      '/v2/regions': { regions: [] },
      '/v2/sizes':   { sizes: [{ slug: 'c-4', price_monthly: 84.005, vcpus: 4, memory: 8192,
                                 disk: 50, regions: ['nyc3'] }] },
      '/v2/images':  { images: [] },
    }))
    expect(cat.sizes[0].prices).toEqual({})
    expect(priceIn(priced.sizes[0], 'nyc3')).toBe(8401)
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
    expect(priceIn(cat.sizes.find((s: any) => s.slug === 's-2vcpu-4gb'), 'nyc3')).toBe(2400)
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
    //
    // The subject used to be `hetzner`, which had no connector until there was
    // one. `custom` is what the enum has left, and it is not a stand-in for a
    // missing case: it is the value meaning *no cloud*, which is the same
    // question asked of the one member that can never have an answer.
    const nowhere = await (env.system as any).secret.create({ data: {
      workspaceId: ws.id, name: 'somewhere-else', kind: 'provider_key',
      providerKind: 'custom', data: JSON.stringify({ token: 'x' }),
    }})
    // The raw call, not the throwing helper: a null IS the assertion here.
    expect(await registerAccount(app, nowhere, { address: SINK })).toBeNull()

    // The control, and it is what stops the row above passing for the wrong
    // reason: a `registerAccount` that answered null for everything would
    // satisfy it, and it is exactly what a mis-registered CONNECTORS map looks
    // like. The second cloud is asked, because the first one is asked
    // everywhere else in this file.
    const hz = await (env.system as any).secret.create({ data: {
      workspaceId: ws.id, name: 'hz', kind: 'provider_key',
      providerKind: 'hetzner', data: JSON.stringify({ token: 'x' }),
    }})
    expect(await registerAccount(app, hz, { address: SINK }))
      .toBe(`provider:hetzner:${hz.id}`)
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
      userData: '#!/bin/bash\ntrue', mark: markFor('guard'),
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
    userData: '#!/bin/bash\ntrue', mark: markFor('abc'), ...over,
  })

  test('a create sends the spec and answers the vendor id', async () => {
    const { resetSink, CREATED } = await import('../src/providers/compute/digitalocean-sink.ts')
    resetSink()
    const send = sendVia(app, await registerAtSink(account))

    const made = await digitalOcean.create(send, spec())
    expect(made.providerServerId).toBeTruthy()
    expect(CREATED).toHaveLength(1)
    expect(CREATED[0]).toMatchObject({ region: 'nyc3', size: 's-2vcpu-4gb' })
  })

  test('the user_data crosses whole — it is the entire install', async () => {
    const { resetSink, CREATED } = await import('../src/providers/compute/digitalocean-sink.ts')
    resetSink()
    const send = sendVia(app, await registerAtSink(account))
    await digitalOcean.create(send, spec({ userData: '#!/bin/bash\necho hello' }))
    expect((CREATED[0] as any).user_data).toContain('echo hello')
  })

  test('the MARK crosses as DO spells it, and it is the only thread back to an orphan', async () => {
    const { resetSink, CREATED } = await import('../src/providers/compute/digitalocean-sink.ts')
    resetSink()
    const send = sendVia(app, await registerAtSink(account))
    await digitalOcean.create(send, spec({ mark: markFor('xyz') }))
    // Flat colon-joined strings, which is DO's spelling and not the caller's:
    // the caller stated `{ fleet, serverId }` and never a tag.
    expect((CREATED[0] as any).tags).toEqual(['basecamp', 'basecamp:server:xyz'])
  })

  test('and it comes back OUT of the machine, which is what makes an orphan nameable', async () => {
    // The round trip, and the half that had no reader at all: the identity tag
    // was written and nothing ever read it, so a reconciliation sweep answered
    // a vendor id and a person had to go and look.
    const { resetSink } = await import('../src/providers/compute/digitalocean-sink.ts')
    resetSink()
    const send = sendVia(app, await registerAtSink(account))
    const made = await digitalOcean.create(send, spec({ mark: markFor('round-trip') }))

    expect((await digitalOcean.machine(send, made.providerServerId))!.serverId).toBe('round-trip')
    // The control: the seeded droplet carries no tags, so a reader that
    // answered something for everything would report one here too.
    expect((await digitalOcean.machine(send, '901'))!.serverId).toBeNull()
  })

  test('a new machine is `starting` and has no address — never `running`', async () => {
    // A create answers before the machine is up at every cloud. A caller that
    // read the create response as *ready* would work against a fake and fail
    // against every real vendor.
    const { resetSink } = await import('../src/providers/compute/digitalocean-sink.ts')
    resetSink()
    const send = sendVia(app, await registerAtSink(account))
    const made = await digitalOcean.create(send, spec())
    const seen = await digitalOcean.machine(send, made.providerServerId)
    expect(seen!.status).toBe('starting')
    expect(seen!.ipAddress).toBeNull()
  })

  test('once the cloud brings it up it is `running` WITH an address', async () => {
    const { resetSink, sinkBoot } = await import('../src/providers/compute/digitalocean-sink.ts')
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
    const { resetSink } = await import('../src/providers/compute/digitalocean-sink.ts')
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
    const { resetSink } = await import('../src/providers/compute/digitalocean-sink.ts')
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
    const { resetSink } = await import('../src/providers/compute/digitalocean-sink.ts')
    resetSink()
    const send = sendVia(app, await registerAtSink(account))
    await digitalOcean.create(send, spec({ mark: markFor('orphan') }))

    const found = await digitalOcean.marked(send, markFor('orphan'))
    expect(found).toHaveLength(1)

    // And the negative control: the seeded droplet carries no tag, so a search
    // that ignored the filter would return it too.
    expect(await digitalOcean.marked(send, markFor('nobody'))).toHaveLength(0)

    // The fleet mark is the OTHER question and it must answer differently: one
    // sweep covers every machine this app made, which is what reconciliation
    // has instead of the id it is trying to discover.
    expect(await digitalOcean.marked(send, fleetMark())).toHaveLength(1)
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

    // What must be in it: the one-time token and where to spend it. The URL is
    // assembled from variables now, because the same script is what a person
    // pastes on an imported machine — so the four inputs are set at the top
    // rather than baked through the body.
    expect(ci).toContain(t.token)
    expect(ci).toContain('SERVER_ID="s1"')
    expect(ci).toContain('BASECAMP_URL="http://basecamp"')
    expect(ci).toContain('"$BASECAMP_URL/servers/$SERVER_ID/enroll"')
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
    const { resetSink } = await import('../src/providers/compute/digitalocean-sink.ts')
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
    const { CREATED } = await import('../src/providers/compute/digitalocean-sink.ts')
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
    const { sinkBoot } = await import('../src/providers/compute/digitalocean-sink.ts')
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
    const { resetSink } = await import('../src/providers/compute/digitalocean-sink.ts')
    resetSink()
    const send = sendVia(app, await registerAtSink(account))
    await digitalOcean.create(send, {
      name: 'ghost', region: 'nyc3', size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64',
      userData: '#!/bin/bash\ntrue', mark: markFor('never-recorded'),
    })

    const report = await env.as(owner).service('servers').call('reconcile', null, {
      accountId: account.id,
    }) as any

    expect(report.orphans).toHaveLength(1)
    expect(report.orphans[0].providerServerId).toBeTruthy()
    // And it says WHICH row it thinks it is, which separates a machine whose
    // row was deleted on this side from one something else marked.
    expect(report.orphans[0].claimsServerId).toBe('never-recorded')
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
 * **What this does NOT prove** is that the secret handed back WORKS. That is the
 * describe below — for a while it was nobody's, and the gap was total: the
 * credential was minted, written to the machine and read by nothing.
 */
describe('a machine enrolls itself, over HTTP, holding nothing else', () => {
  let target: any, minted: string

  test('a provisioned machine is handed a token that is not in its own row', async () => {
    const { resetSink } = await import('../src/providers/compute/digitalocean-sink.ts')
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

// ─── Which key a machine signs with ──────────────────────────────────────

/**
 * The half enrollment was missing.
 *
 * A secret was minted, written into cloud-init, handed to the machine — and
 * read by nothing: `requireOutpostSignature` compared every check-in against
 * the fleet-wide `OUTPOST_SECRET`. Measured before the fix: a provisioned
 * machine signing with its own key answered 401, the fleet key answered 200,
 * and the row sat at `installing` forever. **A machine Basecamp bought could
 * never come online.**
 *
 * Every row here is a PAIR and none of them is provable alone. A fix that
 * refused everybody passes *the fleet key is refused*; a fix that changed
 * nothing passes *an imported machine still works*. Only the three together
 * say the key is chosen per machine.
 */
describe('a machine signs with its OWN key, and only its own', () => {
  const FLEET = 'outpost-dev-secret'   // core/env.ts's default, which the test env runs on

  /** A heartbeat, signed the way an outpost signs one. */
  async function heartbeat(serverId: string, secret: string) {
    const { signRequest } = await import('@frontierjs/toolbelt/signature')
    const body = JSON.stringify({ outpost_version: '0.4.1', health: { cpu: 3, memory: 10 } })
    const path = `/servers/${serverId}`
    const headers = await signRequest({
      secret, method: 'POST', path, query: '', body,
      // The kit is pure — the clock and the nonce belong to the caller. A fresh
      // nonce per call, or the second heartbeat in a row is refused as a replay
      // and every assertion below reads as a key that did not work.
      timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID(),
    })
    const req = env.http.post(path).set('x-service-method', 'heartbeat')
    for (const [k, v] of Object.entries(headers)) req.set(k, v as string)
    return req.send(JSON.parse(body))
  }

  /** A machine that enrolled, and the secret it went away holding. */
  async function enrolled(name: string) {
    const { mintEnrollToken, hashEnrollToken } =
      await import('../src/providers/compute/enrollment.ts')
    const sys = env.system as any
    const row = await sys.server.create({ data: {
      workspaceId: ws.id, name, slug: `${name}-${Math.random().toString(36).slice(2, 7)}`,
      status: 'installing', role: 'general', providerKind: 'digitalocean',
      registerMethod: 'provisioned', ipAddress: '203.0.113.5',
    }})
    const token = mintEnrollToken().token
    await sys.server.update({ where: { id: row.id }, data: {
      enrollTokenHash: hashEnrollToken(token), enrollExpiresAt: new Date(Date.now() + 60_000),
    }})
    const res = await env.http.post(`/servers/${row.id}/enroll`).send({ token })
    return { id: row.id as string, secret: (res.body as any).secret as string }
  }

  test('an enrolled machine is accepted on the secret it was handed', async () => {
    const m = await enrolled('own-key')
    const res = await heartbeat(m.id, m.secret)
    expect(res.status).toBe(200)

    // And it MOVES. The point of the key is the machine coming online; a 200
    // that left the row at `installing` would be the door opening onto nothing.
    const after = await (env.system as any).server.findFirst({ where: { id: m.id } })
    expect(after.status).toBe('online')
  })

  test('…and REFUSED on the fleet key, which is the whole security property', async () => {
    // The fleet secret is one string every machine holds. Accepting it here
    // would leave any compromised box able to forge this machine's check-in —
    // which is the thing per-machine credentials exist to stop, and would be
    // stopped nowhere if the old key kept working beside the new one.
    const m = await enrolled('fleet-key-refused')
    const res = await heartbeat(m.id, FLEET)
    expect(res.status).toBe(401)

    const after = await (env.system as any).server.findFirst({ where: { id: m.id } })
    expect(after.status).toBe('installing')
  })

  test('a machine with NO credential is refused, fleet key and all', async () => {
    // The fleet key is not an authentication input any more. It was accepted
    // only while an imported machine had no way to get a credential of its own;
    // `issueEnrollment` is that way, so one string that opens every machine no
    // longer opens any.
    //
    // This is a machine an operator has not finished installing, which is a
    // different thing from one that is broken — the screen for it says so and
    // prints the command. Paired with that same machine working the moment it
    // enrolls, two rows down.
    const sys = env.system as any
    const row = await sys.server.create({ data: {
      workspaceId: ws.id, name: 'imported', slug: `imported-${Math.random().toString(36).slice(2, 7)}`,
      status: 'pending', role: 'general', providerKind: 'custom',
      registerMethod: 'manual', ipAddress: '10.0.1.9',
    }})
    expect(row.outpostSecretId ?? null).toBeNull()
    expect((await heartbeat(row.id as string, FLEET)).status).toBe(401)
  })

  test('a machine that does not exist is refused, not rescued by the fleet key', async () => {
    const res = await heartbeat('00000000-0000-0000-0000-000000000000', FLEET)
    expect(res.status).toBe(401)
  })

  test("a machine whose secret row is GONE is refused rather than falling back", async () => {
    // The branch that would silently re-open the hole for exactly the machine
    // that had been closed.
    const m = await enrolled('secret-deleted')
    const sys = env.system as any
    const row = await sys.server.findFirst({ where: { id: m.id } })
    await sys.secret.delete({ where: { id: row.outpostSecretId } })

    expect((await heartbeat(m.id, m.secret)).status).toBe(401)
    expect((await heartbeat(m.id, FLEET)).status).toBe(401)
  })

  test('and the OUTBOUND target is keyed to that machine too, not to the fleet', async () => {
    // The same defect in the other direction. Basecamp signs its calls TO a
    // machine — `/exec`, `/deploy`, `/system/prune` — and the outpost on the far
    // side verifies with the secret cloud-init wrote, which is the machine's
    // own. A target signed with the fleet key is refused by every machine that
    // enrolled, so fixing the inbound half alone leaves the app able to hear a
    // machine and unable to speak to it.
    const m = await enrolled('outbound-key')
    const row = await (env.system as any).server.findFirst({ where: { id: m.id } })

    // The heartbeat is what registers the target, and it carries the URL.
    const { signRequest } = await import('@frontierjs/toolbelt/signature')
    const body = JSON.stringify({
      outpost_version: '0.4.1', health: { cpu: 1, memory: 1 },
      outpost_url: 'http://203.0.113.5:8180',
    })
    const path = `/servers/${m.id}`
    const headers = await signRequest({
      secret: m.secret, method: 'POST', path, query: '', body,
      timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID(),
    })
    const req = env.http.post(path).set('x-service-method', 'heartbeat')
    for (const [k, v] of Object.entries(headers)) req.set(k, v as string)
    expect((await req.send(JSON.parse(body))).status).toBe(200)

    const target = await app.conduit.resolve(`outpost:${m.id}`)
    // A REF, never the material — and the ref names this machine's Secret row.
    expect(target.auth.ref).toBe(`secret:${row.outpostSecretId}#secret`)
    expect(target.auth.ref).not.toContain('env:')
  })

  test('there is no outbound fleet-key branch left to take', async () => {
    // The control for the row above, and the claim is an absence: a target is
    // registered by `heartbeat` and nowhere else, heartbeat is behind the
    // signature guard, and that guard refuses a machine with no credential. So
    // a machine that could take a fleet-key branch cannot reach the code that
    // would offer one.
    //
    // Asserted by DOING it: a machine with no credential is refused, and no
    // target exists for it afterwards. Without this row, deleting the branch is
    // a claim about reachability that nothing checks.
    const sys = env.system as any
    const row = await sys.server.create({ data: {
      workspaceId: ws.id, name: 'no-target',
      slug: `no-target-${Math.random().toString(36).slice(2, 7)}`,
      status: 'pending', role: 'general', providerKind: 'custom',
      registerMethod: 'manual', ipAddress: '10.0.1.11',
    }})
    expect((await heartbeat(row.id as string, FLEET)).status).toBe(401)
    expect(await app.conduit.resolve(`outpost:${row.id}`).catch(() => null)).toBeNull()
  })

  test('every refusal is the SAME sentence, whatever the reason', async () => {
    // The caller here is unauthenticated by definition. *No such machine* and
    // *that signature is wrong* must not be distinguishable, or a stranger
    // learns which server ids are real by reading the difference.
    const m = await enrolled('one-sentence')
    const answers = await Promise.all([
      heartbeat('00000000-0000-0000-0000-000000000000', FLEET),
      heartbeat(m.id, FLEET),
      heartbeat(m.id, 'not-the-right-secret-at-all'),
    ])
    const shapes = new Set(answers.map(r => `${r.status} ${JSON.stringify(r.body)}`))
    expect(shapes.size).toBe(1)
    expect([...shapes][0]).toContain('401')
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

// ─── The Hetzner dialect ─────────────────────────────────────────────────
//
// The same tier as `the DigitalOcean dialect` above, over a vendor that
// disagrees in every way a connector can. Each of these is one of the
// disagreements, and each of them reached the boundary.

describe('the Hetzner dialect', () => {
  const catalogOf = (types: unknown[], locations: unknown[] = [], images: unknown[] = []) =>
    hetzner.catalog(canned({
      '/v1/locations':    { locations },
      '/v1/server_types': { server_types: types },
      '/v1/images':       { images },
    }))

  const priceRow = (net: number) => ({ net: net.toFixed(10), gross: (net * 1.19).toFixed(10) })

  test('a price is a STRING, and it is per location', async () => {
    // DigitalOcean states one number for a size and lists the regions that have
    // it. Hetzner states a price per location, so one number would have had to
    // be chosen here — and whichever was chosen is the figure quoted on the
    // wizard's cost line and copied onto `Server.plan`.
    const cat = await catalogOf([{
      name: 'cpx11', description: 'CPX 11', cores: 2, memory: 2, disk: 40,
      prices: [
        { location: 'nbg1', price_monthly: priceRow(4.35) },
        { location: 'hel1', price_monthly: priceRow(4.85) },
      ],
    }])
    expect(cat.sizes[0].prices).toEqual({ nbg1: 518, hel1: 577 })
    expect(cat.sizes[0].currency).toBe('EUR')
  })

  test('the price read is GROSS, which is what this account is billed', async () => {
    // Paired with the row above by being the same call read the other way: net
    // and gross differ by the account's own VAT, so a connector reading the
    // wrong one is off by nineteen percent and still looks like a price.
    const cat = await catalogOf([{
      name: 'cpx11', cores: 2, memory: 2, disk: 40,
      prices: [{ location: 'nbg1', price_monthly: { net: '4.3500000000', gross: '5.1765000000' } }],
    }])
    expect(cat.sizes[0].prices.nbg1).toBe(518)   // gross
    expect(cat.sizes[0].prices.nbg1).not.toBe(435)  // net, the other plausible read
  })

  test('EUR is not USD, and the divisor is the currency’s', async () => {
    // The first non-dollar currency to cross this boundary, which is what
    // `minorUnits(currency)` was always for. Both are 2 here — the assertion is
    // that the CODE travels, so a screen dividing by a hundred is dividing by
    // the euro’s exponent and not by a constant that happens to match.
    const cat = await catalogOf([{
      name: 'cax11', cores: 2, memory: 1.9, disk: 40,
      prices: [{ location: 'fsn1', price_monthly: priceRow(3.79) }],
    }])
    expect(cat.sizes[0].currency).toBe('EUR')
    expect(cat.sizes[0].prices.fsn1).toBe(451)
  })

  test('memory is GIGABYTES AS A FLOAT, where DigitalOcean sends whole megabytes', async () => {
    // `1.9` is a value Hetzner really sends. A connector copying DO’s read
    // would carry 1.9 MB into a picker rendering `0 GB`, which is a size nobody
    // would choose and nothing would report as broken.
    const cat = await catalogOf([{
      name: 'cax11', cores: 2, memory: 1.9, disk: 40,
      prices: [{ location: 'fsn1', price_monthly: priceRow(3.79) }],
    }])
    expect(cat.sizes[0].memoryMb).toBe(1946)
    expect(Math.round(cat.sizes[0].memoryMb / 1024)).toBe(2)
  })

  test('a type priced nowhere is not offered, because it cannot be quoted', async () => {
    // The keys of `prices` are the availability list, so a type with an empty
    // one is a size the picker would offer and the cost line could not fill.
    const cat = await catalogOf([
      { name: 'ghost', cores: 1, memory: 1, disk: 20, prices: [] },
      { name: 'cpx11', cores: 2, memory: 2, disk: 40,
        prices: [{ location: 'nbg1', price_monthly: priceRow(4.35) }] },
    ])
    expect(cat.sizes.map((s: any) => s.slug)).toEqual(['cpx11'])
  })

  test('a location is a region, and every one Hetzner lists is available', async () => {
    // Not a stub: Hetzner publishes no per-location availability flag, because
    // what can be created where is per server TYPE. That availability is the
    // price map, and this field is the vendor saying the location exists.
    const cat = await catalogOf([], [
      { name: 'nbg1', description: 'Nuremberg DC Park 1' },
      { name: 'hel1', description: 'Helsinki DC Park 1' },
    ])
    expect(cat.regions.map((r: any) => r.slug)).toEqual(['nbg1', 'hel1'])
    expect(cat.regions.every((r: any) => r.available)).toBe(true)
    expect(cat.regions[0].label).toBe('Nuremberg DC Park 1')
  })

  test('nine state words are normalized, and `migrating` is not `running`', async () => {
    const state = async (st: string) => (await hetzner.machine(
      canned({ '/v1/servers/': { server: { id: 1, status: st, public_net: { ipv4: null } } } }), '1',
    ))!.status

    expect(await state('initializing')).toBe('starting')
    expect(await state('starting')).toBe('starting')
    expect(await state('running')).toBe('running')
    expect(await state('stopping')).toBe('stopping')
    expect(await state('off')).toBe('off')
    expect(await state('deleting')).toBe('deleting')
    expect(await state('rebuilding')).toBe('rebuilding')
    // A machine being moved between hosts is reachable and must not be given
    // work, which is the distinction the state exists for.
    expect(await state('migrating')).toBe('rebuilding')
    // Hetzner has an `unknown` of its own, and a word nobody has seen lands in
    // the same place — recorded as unrecognized rather than guessed at.
    expect(await state('unknown')).toBe('unknown')
    expect(await state('teleporting')).toBe('unknown')
  })

  test('the address is one nested object, not a list filtered by type', async () => {
    const withIp = await hetzner.machine(canned({ '/v1/servers/': { server: {
      id: 7, status: 'running',
      public_net: { ipv4: { id: 1, ip: '198.51.100.7' } },
      datacenter: { name: 'nbg1-dc3', location: { name: 'nbg1' } },
    } } }), '7')
    expect(withIp!.ipAddress).toBe('198.51.100.7')
    // Nested one deeper than DO's too: a datacenter is IN a location, and the
    // location is what a catalog names.
    expect(withIp!.region).toBe('nbg1')

    // Still building. Paired, because a reader that answered null for both
    // would satisfy any test that only asked about the empty case.
    const building = await hetzner.machine(canned({ '/v1/servers/': { server: {
      id: 8, status: 'initializing', public_net: { ipv4: null },
    } } }), '8')
    expect(building!.ipAddress).toBeNull()
  })

  test('a 404 is `it is gone`, and any other failure is `we could not ask`', async () => {
    const gone = canned({}, 404)
    expect(await hetzner.machine(gone, '1')).toBeNull()

    // The pair: a 500 must NEVER read as gone, because the caller turns a null
    // into a `reportDestroyed` move on a machine that is still running.
    const broken = async () => ({ data: null, status: 500, error: { kind: 'server_error' } })
    await expect(hetzner.machine(broken as any, '1')).rejects.toThrow(/Hetzner/)
  })

  test('only available system images are asked for', async () => {
    // A deprecated image is a create the vendor refuses. Asserted on the PATH,
    // because the stand-in would have to be trusted to filter otherwise and
    // the real vendor is the thing being asked.
    const paths: string[] = []
    await hetzner.catalog(async (req: any) => {
      paths.push(req.path)
      return { data: { locations: [], server_types: [], images: [] }, status: 200 }
    })
    const images = paths.find(p => p.startsWith('/v1/images'))!
    expect(images).toContain('type=system')
    expect(images).toContain('status=available')
    // And Hetzner's page maximum is 50, a quarter of DigitalOcean's. A page
    // size copied from the other connector is accepted and silently clamped,
    // which is a list that looks complete and is not.
    expect(paths.every(p => p.includes('per_page=50'))).toBe(true)
  })
})

// ─── Hetzner, through the real seam ──────────────────────────────────────

describe('Hetzner answers through conduit, and is marked with LABELS', () => {
  const hzSpec = (over: Record<string, unknown> = {}) => ({
    name: 'hz-web-01', region: 'nbg1', size: 'cpx11', image: 'ubuntu-24.04',
    userData: '#!/bin/bash\ntrue', mark: markFor('hz-abc'), ...over,
  })

  test('the token is resolved out of an @encrypted column and reaches the vendor', async () => {
    const cat = await hetzner.catalog(sendVia(app, await registerAtHz(hzAccount)))
    expect(cat.regions.map((r: any) => r.slug)).toContain('nbg1')
    // Priced differently in two locations at the stand-in, which is the whole
    // reason `prices` is a map.
    const cpx11 = cat.sizes.find((s: any) => s.slug === 'cpx11')
    expect(priceIn(cpx11, 'nbg1')).toBe(518)
    expect(priceIn(cpx11, 'hel1')).toBe(577)
    // And a type sold in one location only, which is what makes *a size this
    // region does not have* answerable without arranging anything.
    expect(priceIn(cat.sizes.find((s: any) => s.slug === 'cax11'), 'nbg1')).toBeNull()
  })

  test('the mark crosses as a LABEL MAP, and DO’s spelling would be refused', async () => {
    // The finding this whole phase exists for. `basecamp:server:<id>` is a
    // legal DigitalOcean tag and is NOT a legal Hetzner label key, so a
    // `MachineSpec` carrying a flat list of tag strings could not be written
    // here at all — which is why the caller states a mark and each connector
    // states the spelling.
    const { resetHzSink, HZ_CREATED } = await import('../src/providers/compute/hetzner-sink.ts')
    resetHzSink()
    const send = sendVia(app, await registerAtHz(hzAccount))

    await hetzner.create(send, hzSpec({ mark: markFor('hz-xyz') }))
    expect((HZ_CREATED[0] as any).labels).toEqual({ basecamp: '', 'basecamp.server': 'hz-xyz' })

    // The negative control, and it is the vendor's own refusal rather than
    // this repo's opinion of it: the stand-in applies Hetzner's key grammar,
    // so the spelling the other connector uses is a 400 here.
    await expect(send({ method: 'POST', path: '/v1/servers', body: {
      name: 'bad-label', server_type: 'cpx11', image: 'ubuntu-24.04', location: 'nbg1',
      labels: { 'basecamp:server:abc': '' },
    }})).resolves.toMatchObject({ status: 400 })
  })

  test('the mark comes back OUT, so an orphan at Hetzner names itself too', async () => {
    const { resetHzSink } = await import('../src/providers/compute/hetzner-sink.ts')
    resetHzSink()
    const send = sendVia(app, await registerAtHz(hzAccount))
    const made = await hetzner.create(send, hzSpec({ mark: markFor('hz-round') }))

    expect((await hetzner.machine(send, made.providerServerId))!.serverId).toBe('hz-round')
    // The control: the seeded machine carries no labels, so a reader answering
    // something for everything would report one here.
    expect((await hetzner.machine(send, '7701'))!.serverId).toBeNull()
  })

  test('a sweep selects on EXISTENCE and a lookup on EQUALITY', async () => {
    // Hetzner's selector grammar, which is not DO's exact-match tag filter —
    // and the two questions have to stay different: a sweep has no id, which is
    // the whole reason it is a list.
    const { resetHzSink } = await import('../src/providers/compute/hetzner-sink.ts')
    resetHzSink()
    const send = sendVia(app, await registerAtHz(hzAccount))
    await hetzner.create(send, hzSpec({ mark: markFor('hz-one') }))
    await hetzner.create(send, hzSpec({ name: 'hz-web-02', mark: markFor('hz-two') }))

    expect(await hetzner.marked(send, fleetMark())).toHaveLength(2)
    expect(await hetzner.marked(send, markFor('hz-one'))).toHaveLength(1)
    // The seeded machine has no labels at all, so a selector that was ignored
    // would return three.
    expect(await hetzner.marked(send, markFor('nobody'))).toHaveLength(0)
  })

  test('a create names a type the location does not sell and is refused BY THE VENDOR', async () => {
    const send = sendVia(app, await registerAtHz(hzAccount))
    await expect(hetzner.create(send, hzSpec({ size: 'cax11', region: 'nbg1' })))
      .rejects.toThrow(/refused the create/)
    // Paired with the same call one location over, which the vendor accepts.
    await expect(hetzner.create(send, hzSpec({ size: 'cax11', region: 'fsn1' })))
      .resolves.toMatchObject({ providerServerId: expect.any(String) })
  })

  test('a destroy answers 200 WITH A BODY, where DigitalOcean answers 204 with none', async () => {
    // A connector reading a body unconditionally works against one vendor and
    // throws against the other, and neither dialect tier can see it.
    const { resetHzSink } = await import('../src/providers/compute/hetzner-sink.ts')
    resetHzSink()
    const send = sendVia(app, await registerAtHz(hzAccount))
    const made = await hetzner.create(send, hzSpec())

    expect(await hetzner.destroy(send, made.providerServerId)).toBe(true)
    expect(await hetzner.machine(send, made.providerServerId)).toBeNull()
    // Idempotent, for DigitalOcean's reason: every path in is a job that may be
    // redelivered.
    expect(await hetzner.destroy(send, made.providerServerId)).toBe(true)
  })

  test('verify ASKS the vendor, and a token it rejects does not verify', async () => {
    expect(await hetzner.verify(sendVia(app, await registerAtHz(hzAccount)))).toBe(true)

    const bad = await (env.system as any).secret.create({ data: {
      workspaceId: ws.id, name: 'hz-bad', kind: 'provider_key',
      providerKind: 'hetzner', data: JSON.stringify({ token: 'nope' }),
    }})
    expect(await hetzner.verify(sendVia(app, await registerAtHz(bad)))).toBe(false)
  })

  test('the spend guard covers the second cloud without knowing there was one', async () => {
    // It is on the TRANSPORT, so a vendor added later is guarded by a rule
    // nobody remembered to apply to it. The pair is that the stand-in still
    // works — a guard that refused loopback too would look identical from every
    // test that only asked about the refusal.
    const real = await registerAccount(app, hzAccount, { address: 'https://api.hetzner.cloud' })
    await expect(sendVia(app, real!)({ method: 'POST', path: '/v1/servers', body: {} }))
      .rejects.toThrow(/refusing to POST/)
    await expect(hetzner.create(sendVia(app, await registerAtHz(hzAccount)), hzSpec()))
      .resolves.toMatchObject({ providerServerId: expect.any(String) })
  })
})

// ─── Two clouds, one vocabulary ──────────────────────────────────────────
//
// The oracle, and the reason a second cloud was built at all. Everything above
// grades a connector against its own stand-in, which can only ever say that a
// connector is consistent with itself. This runs ONE script against both and
// asserts they answer in the same words — which is the difference between
// `ComputeConnector` being a translation layer and being a second spelling of
// DigitalOcean.
//
// Table-driven with a `test` per cloud rather than a loop inside one test, so a
// failure names the vendor instead of the iteration that got there first.

describe('two clouds, one vocabulary', () => {
  // The accounts are read through a FUNCTION: the table is built when the
  // describe is defined, which is before `beforeAll` has created either row.
  const clouds = () => [
    { kind: 'digitalocean' as ProviderKind, connector: digitalOcean, account: () => account, address: SINK,
      region: 'nyc3', size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64', currency: 'USD',
      reset: async () => (await import('../src/providers/compute/digitalocean-sink.ts')).resetSink() },
    { kind: 'hetzner' as ProviderKind, connector: hetzner, account: () => hzAccount, address: HZ_SINK,
      region: 'nbg1', size: 'cpx11', image: 'ubuntu-24.04', currency: 'EUR',
      reset: async () => (await import('../src/providers/compute/hetzner-sink.ts')).resetHzSink() },
  ]

  for (const c of clouds()) {
    test(`${c.kind}: the registry answers the connector this account's kind names`, () => {
      // A mis-keyed `CONNECTORS` map is invisible until something provisions:
      // every read would be routed to the wrong dialect and answer plausibly
      // shaped nonsense.
      expect(connectorFor(c.kind)).toBe(c.connector)
      expect(c.connector.kind).toBe(c.kind)
      expect(c.connector.label.length).toBeGreaterThan(0)
    })

    test(`${c.kind}: a descriptor carries a REF and never the material`, async () => {
      const secret = c.account()
      const d = c.connector.descriptor({
        accountId: secret.id, ref: `secret:${secret.id}#token`, address: c.address,
      })
      expect(d.id).toBe(targetFor(c.kind, secret.id))
      expect((d.auth as any).type).toBe('bearer')
      expect((d.auth as any).ref).toBe(`secret:${secret.id}#token`)
      // The material is resolved at send time. A descriptor holding it is what
      // `GET /conduit-targets` would then hand out.
      expect(JSON.stringify(d)).not.toContain('dop_v1_devtoken')
      expect(JSON.stringify(d)).not.toContain(HZ_TOKEN)
    })

    test(`${c.kind}: a catalog is regions, sizes and images in this app's shapes`, async () => {
      const cat = await c.connector.catalog(sendVia(app, await registerAt(c.account(), c.address)))

      expect(cat.regions.length).toBeGreaterThan(0)
      expect(cat.sizes.length).toBeGreaterThan(0)
      expect(cat.images.length).toBeGreaterThan(0)

      for (const r of cat.regions) {
        expect(typeof r.slug).toBe('string')
        expect(r.slug.length).toBeGreaterThan(0)
        expect(typeof r.label).toBe('string')
        expect(typeof r.available).toBe('boolean')
      }

      const listed = new Set(cat.regions.map((r: any) => r.slug))
      for (const s of cat.sizes) {
        expect(s.currency).toMatch(/^[A-Z]{3}$/)
        expect(s.vcpu).toBeGreaterThan(0)
        expect(s.memoryMb).toBeGreaterThan(0)
        expect(s.diskGb).toBeGreaterThan(0)
        // The cross-field invariant, and the one an oracle is for: a price map
        // keyed by anything but a region slug is a size the wizard offers and
        // cannot filter, and every assertion inside one connector passes with
        // the keys wrong.
        expect(Object.keys(s.prices).length).toBeGreaterThan(0)
        for (const [region, minor] of Object.entries(s.prices)) {
          expect(listed.has(region)).toBe(true)
          expect(Number.isInteger(minor)).toBe(true)
          expect(minor as number).toBeGreaterThan(0)
        }
      }

      for (const i of cat.images) {
        expect(i.slug.length).toBeGreaterThan(0)
        expect(typeof i.label).toBe('string')
      }
    })

    test(`${c.kind}: a machine is made, named by its mark, and unmade`, async () => {
      // The whole lifecycle in this app's own words, with nothing in it naming
      // a vendor. If the boundary is a layer, this test does not know which
      // cloud it is running against — and it does not.
      await c.reset()
      const send   = sendVia(app, await registerAt(c.account(), c.address))
      const serial = `parity-${c.kind}`

      const made = await c.connector.create(send, {
        name: `parity-01`, region: c.region, size: c.size, image: c.image,
        userData: '#!/bin/bash\ntrue', mark: markFor(serial),
      })
      expect(made.providerServerId).toBeTruthy()

      // A create returns before the machine is up, at both vendors. A caller
      // treating the create response as *ready* would work against neither.
      const fresh = await c.connector.machine(send, made.providerServerId)
      expect(fresh!.status).toBe('starting')
      expect(fresh!.ipAddress).toBeNull()
      expect(fresh!.region).toBe(c.region)
      // The mark, read back out of whatever the vendor stores it in.
      expect(fresh!.serverId).toBe(serial)

      // Both questions, at both clouds: the sweep and the lookup.
      expect((await c.connector.marked(send, fleetMark()))
        .map((m: any) => m.providerServerId)).toContain(made.providerServerId)
      expect(await c.connector.marked(send, markFor(serial))).toHaveLength(1)

      expect(await c.connector.destroy(send, made.providerServerId)).toBe(true)
      expect(await c.connector.machine(send, made.providerServerId)).toBeNull()
      expect((await c.connector.marked(send, fleetMark()))
        .map((m: any) => m.providerServerId)).not.toContain(made.providerServerId)
    })
  }

  test('and the two are NOT the same vendor answering twice', async () => {
    // The control the whole describe needs. Every assertion above is satisfied
    // by two connectors pointed at one dialect, which is exactly what a
    // copy-pasted second vendor would be — so the differences have to be
    // asserted as differences, in the places the vocabulary deliberately keeps.
    const doCat = await digitalOcean.catalog(sendVia(app, await registerAtSink(account)))
    const hzCat = await hetzner.catalog(sendVia(app, await registerAtHz(hzAccount)))

    expect(doCat.sizes[0].currency).toBe('USD')
    expect(hzCat.sizes[0].currency).toBe('EUR')
    // Disjoint region names, disjoint size slugs: two real price lists.
    const doRegions = new Set(doCat.regions.map((r: any) => r.slug))
    expect(hzCat.regions.every((r: any) => !doRegions.has(r.slug))).toBe(true)
    // And the availability flag means something at one vendor and is a constant
    // at the other, which is a difference the boundary carries rather than hides.
    expect(doCat.regions.some((r: any) => !r.available)).toBe(true)
    expect(hzCat.regions.every((r: any) => r.available)).toBe(true)
  })
})
