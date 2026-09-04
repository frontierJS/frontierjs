// tests/webhook-targets.test.ts
//
// Who may register a webhook, where it may point, and what stops.
//
// A registration is a URL somebody else chose that this app then makes an
// authenticated POST to from inside the network — which is the SSRF primitive,
// and every bound on it was missing (`FJS-681`). Measured before any of it was
// written: a `role: 'user'` shopper POSTed a `*` subscription and got 201 with
// the signing secret in the body; `169.254.169.254`, `localhost:8503` (the
// devtools job runner), `file:///etc/passwd` and the literal string
// `not-a-url` were all accepted as destinations; a 307 was followed with the
// signature re-sent to the new host; and a registration whose deliveries all
// dead-lettered stayed active for ever.
//
// Every refusal here is PAIRED with the acceptance of an otherwise identical
// request (`FJS-351`) — a guard that refuses everything satisfies any test that
// only checks the refusal.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createTestApp, request } from '../src/testing/index.ts'
import { webhooks } from '../src/plugins/webhooks/index.ts'
import { assertDeliverableTarget, WebhookTargetError } from '../src/plugins/webhooks/url.ts'

// ─── a receiver that can also redirect ────────────────────────────────────

type Hit = { path: string; headers: Record<string, string> }
const hits: Hit[] = []
let server: ReturnType<typeof Bun.serve>
let redirectTo = ''

beforeAll(() => {
  server = Bun.serve({ port: 0, async fetch(req) {
    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => { headers[k] = v })
    const path = new URL(req.url).pathname
    hits.push({ path, headers })
    await req.text()
    if (path === '/redirect') return new Response(null, { status: 307, headers: { location: redirectTo } })
    return new Response('ok')
  }})
})
afterAll(() => server.stop(true))

const local = (p = '/hook') => `http://localhost:${server.port}${p}`

// The delivery tests need the guard off, because the receiver above is exactly
// what it refuses. Anything asserting the guard leaves it on.
const OPEN = { allowHttp: true, allowPrivate: true }

async function makeApp(opts: Record<string, unknown> = {}, users = [{ id: 'admin', isAdmin: true }, { id: 'member' }]) {
  const app = await createTestApp({ users })
  app.configure(webhooks({ events: ['*'], retryInterval: 3_600_000, ...opts }))
  await app._startForTest()
  return app as typeof app & { webhooks: NonNullable<typeof app.webhooks> }
}

// ─── who may register ─────────────────────────────────────────────────────

describe('managing registrations needs a standing, not just a session', () => {
  it('refuses a signed-in caller below the level, and accepts the identical request above it', async () => {
    const app  = await makeApp({ targets: OPEN })
    const body = { url: local(), events: ['*'] }

    const member = await request(app).post('/webhooks').auth(app.tokenFor('member')).send(body)
    const admin  = await request(app).post('/webhooks').auth(app.tokenFor('admin')).send(body)

    expect(member.status).toBe(403)
    expect(admin.status).toBe(201)
  })

  it('is 401 for a stranger and 403 for a caller who is merely too junior', async () => {
    // Two different facts, and a client acts on them differently: one is worth
    // signing in for and the other is not.
    const app = await makeApp({ targets: OPEN })
    const anon = await request(app).post('/webhooks').send({ url: local(), events: ['*'] })
    expect(anon.status).toBe(401)
  })

  it('never hands the signing secret to a caller who may not manage', async () => {
    const app = await makeApp({ targets: OPEN })
    const res = await request(app).post('/webhooks').auth(app.tokenFor('member')).send({ url: local(), events: ['*'] })
    expect(JSON.stringify(res.body)).not.toContain('secret')
  })

  it('every by-id route is behind the same bar, not only create', async () => {
    const app  = await makeApp({ targets: OPEN })
    const hook = await app.webhooks.register(local(), ['*'])
    const tok  = app.tokenFor('member')

    expect((await request(app).get('/webhooks').auth(tok)).status).toBe(403)
    expect((await request(app).get(`/webhooks/${hook.id}`).auth(tok)).status).toBe(403)
    expect((await request(app).delete(`/webhooks/${hook.id}`).auth(tok)).status).toBe(403)
    expect((await request(app).post(`/webhooks/${hook.id}/test`).auth(tok)).status).toBe(403)
    // The control: the same four with a standing.
    expect((await request(app).get('/webhooks').auth(app.tokenFor('admin'))).status).toBe(200)
  })

  it('the level is the app’s to set', async () => {
    const app = await makeApp({ targets: OPEN, manage: 4 })
    const res = await request(app).post('/webhooks').auth(app.tokenFor('member')).send({ url: local(), events: ['*'] })
    expect(res.status).toBe(201)
  })
})

// ─── where it may point ───────────────────────────────────────────────────

describe('a destination is graded before anything is sent', () => {
  const REFUSED = [
    ['the cloud metadata service', 'http://169.254.169.254/latest/meta-data/'],
    ['loopback by name',           'http://localhost:8503/api/jobs/1/retry'],
    ['loopback by address',        'https://127.0.0.1/x'],
    ['loopback as IPv6',           'https://[::1]/x'],
    ['loopback mapped into IPv6',  'https://[::ffff:127.0.0.1]/x'],
    ['a private range',            'https://10.0.0.1/x'],
    ['a link-local IPv6',          'https://[fe80::1]/x'],
    ['a scheme that is not http',  'file:///etc/passwd'],
    ['plaintext http',             'http://example.com/hook'],
    ['a string that is not a URL', 'not-a-url'],
  ] as const

  for (const [what, url] of REFUSED) {
    it(`refuses ${what}`, async () => {
      await expect(assertDeliverableTarget(url)).rejects.toBeInstanceOf(WebhookTargetError)
    })
  }

  // An ADDRESS rather than a name: `assertDeliverableTarget` resolves a
  // hostname, and a suite that needs DNS to assert its control is a suite that
  // goes red on a machine with no network. `localhost` below is the one name
  // used here, and it resolves out of /etc/hosts.
  const PUBLIC = 'https://93.184.216.34/hook'

  it('accepts an ordinary public https destination — the control for all ten', async () => {
    // Without this row a guard that refused everything would pass every case
    // above.
    await expect(assertDeliverableTarget(PUBLIC)).resolves.toBeInstanceOf(URL)
  })

  it('refuses a name that resolves to a private address as well as a literal one', async () => {
    // The literal is easy; the NAME is the case an allow-list of strings misses.
    await expect(assertDeliverableTarget('https://localhost/x')).rejects.toThrow(/non-public address/)
  })

  it('each relaxation opens only its own half', async () => {
    await expect(assertDeliverableTarget('http://93.184.216.34/h', { allowHttp: true })).resolves.toBeTruthy()
    await expect(assertDeliverableTarget('http://127.0.0.1/h', { allowHttp: true })).rejects.toThrow(/non-public/)
    await expect(assertDeliverableTarget('http://127.0.0.1/h', { allowPrivate: true })).rejects.toThrow(/must be https/)
    await expect(assertDeliverableTarget('https://127.0.0.1/h', { allowPrivate: true })).resolves.toBeTruthy()
  })

  it('answers 400 over HTTP rather than 500, and 201 for a destination that passes', async () => {
    const app = await makeApp({ targets: { allowHttp: true } })
    const tok = app.tokenFor('admin')
    const bad  = await request(app).post('/webhooks').auth(tok).send({ url: 'http://169.254.169.254/', events: ['*'] })
    const good = await request(app).post('/webhooks').auth(tok).send({ url: 'http://93.184.216.34/h', events: ['*'] })
    expect(bad.status).toBe(400)
    expect(good.status).toBe(201)
  })

  it('the manager refuses too, so a store is never reached with an ungraded url', async () => {
    const app = await makeApp()
    await expect(app.webhooks.register('http://169.254.169.254/', ['*'])).rejects.toThrow(WebhookTargetError)
    expect(await app.webhooks.list()).toHaveLength(0)
  })

  it('is re-graded before every attempt, not only at registration', async () => {
    // The case is a row that is already in the table — registered before the
    // guard existed, or under a name that has since started resolving inside
    // the network. Nothing delivers to it, and the refusal is the delivery's
    // recorded error rather than a throw nobody sees.
    const app  = await makeApp()                       // guard ON
    const hook = await app.webhooks._store.register(local(), ['*'])   // straight past the manager
    hits.length = 0

    await app.webhooks.deliver('e', { a: 1 })

    expect(hits).toHaveLength(0)
    const [d] = await app.webhooks.deliveries(hook.id)
    expect(d.status).toBe('failed')
    expect(d.lastError).toMatch(/must be https|non-public/)
  })
})

// ─── a redirect is a destination nobody graded ────────────────────────────

describe('a redirect is not followed', () => {
  it('stops at the 3xx and does not carry the signature to the new host', async () => {
    const app = await makeApp({ targets: OPEN })
    redirectTo = local('/elsewhere')
    const hook = await app.webhooks.register(local('/redirect'), ['*'])
    hits.length = 0

    await app.webhooks.deliver('e', { a: 1 })

    expect(hits.map(h => h.path)).toEqual(['/redirect'])
    const [d] = await app.webhooks.deliveries(hook.id)
    expect(d.status).toBe('failed')
    expect(d.lastError).toMatch(/redirect refused/)
  })

  it('an ordinary 200 to the same receiver still delivers — the control', async () => {
    const app  = await makeApp({ targets: OPEN })
    const hook = await app.webhooks.register(local('/hook'), ['*'])
    hits.length = 0

    await app.webhooks.deliver('e', { a: 1 })

    const [d] = await app.webhooks.deliveries(hook.id)
    expect(d.status).toBe('delivered')
  })
})

// ─── a subscriber that has gone away ──────────────────────────────────────

describe('a registration whose deliveries all die is turned off', () => {
  // Dead-lettering is per EVENT, so a receiver that has gone away keeps costing
  // seven attempts of every event for ever unless something says stop.
  async function killDelivery(app: Awaited<ReturnType<typeof makeApp>>, hook: { id: string }) {
    const d = await app.webhooks._store.createDelivery(hook.id, 'e', {})
    // Six attempts already spent, so the next one exhausts the ladder — driving
    // seven real attempts per delivery would make this test about the schedule.
    await app.webhooks._store.updateDelivery(d.id, { attempts: 6, status: 'failed' })
    const reg = await app.webhooks._store.getRegistration(hook.id)
    await app.webhooks._attemptAndRecord(reg!, { ...d, attempts: 6 })
  }

  it('deactivates after the declared number of consecutive dead deliveries', async () => {
    const app  = await makeApp({ targets: OPEN, deactivateAfterDead: 2 })
    const hook = await app.webhooks.register(local('/gone'), ['*'])
    // Point it somewhere nothing answers, without going through the manager.
    await app.webhooks._store.unregister(hook.id)
    const dead = await app.webhooks._store.register('http://127.0.0.1:9/gone', ['*'])

    await killDelivery(app, dead)
    expect((await app.webhooks._store.getRegistration(dead.id))!.active).toBe(true)   // one is not enough
    await killDelivery(app, dead)
    expect((await app.webhooks._store.getRegistration(dead.id))!.active).toBe(false)
  })

  it('a receiver that answers stays active however many events it gets — the control', async () => {
    const app  = await makeApp({ targets: OPEN, deactivateAfterDead: 2 })
    const hook = await app.webhooks.register(local('/hook'), ['*'])
    for (let i = 0; i < 4; i++) await app.webhooks.deliver('e', { i })
    expect((await app.webhooks._store.getRegistration(hook.id))!.active).toBe(true)
  })

  it('0 never deactivates, which is the way an app opts out', async () => {
    const app  = await makeApp({ targets: OPEN, deactivateAfterDead: 0 })
    const dead = await app.webhooks._store.register('http://127.0.0.1:9/gone', ['*'])
    await killDelivery(app, dead)
    await killDelivery(app, dead)
    expect((await app.webhooks._store.getRegistration(dead.id))!.active).toBe(true)
  })

  it('a deactivated registration is skipped by the fan-out but still readable', async () => {
    const app  = await makeApp({ targets: OPEN, deactivateAfterDead: 1 })
    const dead = await app.webhooks._store.register('http://127.0.0.1:9/gone', ['*'])
    await killDelivery(app, dead)
    hits.length = 0
    await app.webhooks.deliver('e', {})
    expect(await app.webhooks._store.findForEvent('e')).toHaveLength(0)
    expect(await app.webhooks._store.getRegistration(dead.id)).toBeTruthy()
  })
})

// ─── the guard's own cost ─────────────────────────────────────────────────

describe('the lookup is bounded', () => {
  // This runs before EVERY attempt, and `dns.lookup` has no timeout of its own:
  // it holds a libuv thread pool slot until the resolver answers, and the pool
  // is four threads, so a hung resolver would stall unrelated file I/O across
  // the process rather than only this delivery.
  it('refuses rather than hanging when a name does not resolve in time', async () => {
    const started = Date.now()
    await expect(assertDeliverableTarget('https://a.b.c.invalid/x', { lookupTimeoutMs: 50 }))
      .rejects.toThrow(WebhookTargetError)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('an address literal does no lookup at all — the control', async () => {
    // With a 1ms budget this could only pass by never resolving.
    await expect(assertDeliverableTarget('https://93.184.216.34/x', { lookupTimeoutMs: 1 })).resolves.toBeTruthy()
  })
})
