// tests/webhook-payload.test.ts
//
// What a webhook subscriber actually receives (`FJS-724`, ruled `FJS-D193`).
//
// A delivery used to carry the row as the WRITER saw it — `ctx.result` for a
// service event, the row itself for a litestone tap — with nothing between
// there and the wire. `FJS-631` is the same class one layer down, and the
// mechanism that closed it there does not apply unchanged, because a URL is not
// a principal. What makes it apply is that a REGISTRATION had one.
//
// Every refusal below is PAIRED with the acceptance of the same payload by an
// audience one field apart. A grader that delivers to nobody passes any test
// that only asserts the refusal (`FJS-351`).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { createTestApp, request } from '../src/testing/index.ts'
import { webhooks, createSqliteWebhookStore } from '../src/plugins/webhooks/index.ts'
import type { IWebhookStore, WebhookRegistration } from '../src/plugins/webhooks/index.ts'
import { _resetWebhookWarnings } from '../src/plugins/webhooks/payload.ts'

// ─── A real receiver ──────────────────────────────────────────────────────

type Hit = { body: string }
let hits: Hit[] = []
let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) { hits.push({ body: await req.text() }); return new Response('ok') },
  })
})
afterAll(() => server.stop(true))
beforeEach(() => { hits = []; _resetWebhookWarnings() })

const url  = (p = '/hook') => `http://localhost:${server.port}${p}`
const sent = () => hits.map(h => (JSON.parse(h.body) as { data: unknown }).data)

// ─── A stub Data boundary ─────────────────────────────────────────────────
//
// The rule is litestone's and is not restated here: what these tests assert is
// which principal it is asked ABOUT, how often, and what happens to each of the
// three answers. `$readAs` below is the smallest rule that can tell two
// audiences apart — the row's owner reads it and nobody else does.

function boundary(opts: { open?: string[]; throwOn?: string } = {}) {
  const asked: Array<{ accessor: string; principal: { id?: unknown } | null }> = []
  return {
    asked,
    db: {
      $schema:          { models: [{ name: 'Order' }, { name: 'User' }] },
      $readGrading:     (a: string) => (opts.open?.includes(a) ? 'open' : 'graded'),
      $protectedFields: (a: string) => (a === 'user' ? { password: 'hashed' } : {}),
      $readAs: async (accessor: string, row: Record<string, unknown>, principal: { id?: unknown } | null) => {
        asked.push({ accessor, principal })
        if (opts.throwOn === accessor) throw new Error('a policy could not be answered')
        if (row.ownerId !== (principal?.id ?? null)) return null
        // A real boundary strips a protected column for any non-system reader,
        // and a recipient is never system. Stubbing that away would make the
        // test agree with a grader that returns the writer's row untouched.
        const { password: _p, ...visible } = row
        return visible
      },
    },
  }
}

async function makeApp(opts: {
  db?:    unknown
  store?: IWebhookStore
  users?: Array<Record<string, unknown>>
} = {}) {
  const app = await createTestApp({
    users: (opts.users ?? [
      { id: 'alice', isAdmin: true },
      { id: 'bob',   isAdmin: true },
    ]) as never,
  })
  // The real store, so the audience column is exercised rather than mocked.
  const store = opts.store ?? createSqliteWebhookStore(app.db as never)
  if ('db' in opts) (app as { db?: unknown }).db = opts.db
  app.configure(webhooks({
    events:        ['*'],
    store,
    retryInterval: 3_600_000,
    targets:       { allowHttp: true, allowPrivate: true },
  }))
  await app._startForTest()
  return app as typeof app & { webhooks: NonNullable<typeof app.webhooks> }
}

const ORDER = { id: 'o1', ownerId: 'alice', total: 100 }

// ─── The defect, and its control ──────────────────────────────────────────

describe('a delivery is graded as the audience that registered it', () => {
  it('delivers the row to an audience who may read it', async () => {
    const b   = boundary()
    const app = await makeApp({ db: b.db })
    await app.webhooks.register(url(), ['orders:created'], undefined, 'alice')

    await app.webhooks.deliver('orders:created', ORDER)

    expect(sent()).toEqual([ORDER])
    expect(b.asked[0]?.principal?.id).toBe('alice')
  })

  it('delivers NOTHING to an audience who may not — same payload, other person', async () => {
    const b   = boundary()
    const app = await makeApp({ db: b.db })
    await app.webhooks.register(url(), ['orders:created'], undefined, 'bob')

    const refused: unknown[] = []
    app.events.on('webhook:refused', (e) => refused.push(e))

    await app.webhooks.deliver('orders:created', ORDER)

    expect(hits.length).toBe(0)
    expect(refused.length).toBe(1)
    expect(b.asked[0]?.principal?.id).toBe('bob')
  })

  it('does not leave the refused delivery in the retry table', async () => {
    // A payload nobody may read must not sit there for a day being retried —
    // and a row recorded as pending is also a copy of it, in the app's own
    // database, which is half of what this is here to stop.
    const b   = boundary()
    const app = await makeApp({ db: b.db })
    await app.webhooks.register(url(), ['orders:created'], undefined, 'bob')
    await app.webhooks.deliver('orders:created', ORDER)

    expect(await app.webhooks.deliveries()).toEqual([])
  })

  it('stores what was SENT, so a retry re-sends the graded payload', async () => {
    const b   = boundary()
    const app = await makeApp({ db: b.db })
    await app.webhooks.register(url(), ['users:created'], undefined, 'alice')
    await app.webhooks.deliver('users:created', { id: 'u1', ownerId: 'alice', password: 'hunter2' })

    const [d] = await app.webhooks.deliveries()
    expect(d?.payload).toBeDefined()
    expect(JSON.stringify(d?.payload)).not.toContain('hunter2')
  })
})

// ─── The audience is read, never stated ───────────────────────────────────

describe('who a registration speaks for', () => {
  it('is the principal in scope, not a value the caller sent', async () => {
    const b   = boundary()
    const app = await makeApp({ db: b.db })

    // `IAuth.sessionFor` must never be wired to anything a request can name. A
    // caller who may register (level 5) would otherwise be a caller who may
    // receive anything, by naming somebody else in the body.
    const res = await request(app).post('/webhooks').auth('test-token-alice')
      .send({ url: url(), events: ['orders:created'], subscriber: 'bob' })
    expect(res.status).toBe(201)
    expect((res.body as WebhookRegistration).subscriber).toBe('alice')
  })

  it('is nobody for app code at boot, and that is graded as a stranger', async () => {
    const b   = boundary()
    const app = await makeApp({ db: b.db })
    await app.webhooks.register(url(), ['orders:created'])   // no principal in scope

    await app.webhooks.deliver('orders:created', ORDER)

    expect(hits.length).toBe(0)
    expect(b.asked[0]?.principal).toBe(null)
  })

  it('says so out loud, and only where there is a rule to ask', async () => {
    const said: string[] = []
    const warn = console.warn
    console.warn = (m: string) => { said.push(String(m)) }
    try {
      const app = await makeApp({ db: boundary().db })
      await app.webhooks.register(url(), ['orders:created'])
      expect(said.some(m => m.includes('speaks for NOBODY'))).toBe(true)

      // The pair: an app with no Data boundary grades nothing, so the same
      // registration costs it nothing and the line would be advice with no
      // action behind it.
      said.length = 0
      const plain = await makeApp()
      await plain.webhooks.register(url(), ['orders:created'])
      expect(said.some(m => m.includes('speaks for NOBODY'))).toBe(false)
    } finally { console.warn = warn }
  })
})

// ─── One grading per audience ─────────────────────────────────────────────

describe('the unit is the audience, not the registration', () => {
  it('asks once for two destinations one person registered', async () => {
    const b   = boundary()
    const app = await makeApp({ db: b.db })
    await app.webhooks.register(url('/a'), ['orders:created'], undefined, 'alice')
    await app.webhooks.register(url('/b'), ['orders:created'], undefined, 'alice')

    await app.webhooks.deliver('orders:created', ORDER)

    expect(b.asked.length).toBe(1)
    expect(hits.length).toBe(2)
  })

  it('asks twice for two people, and each gets their own answer', async () => {
    const b   = boundary()
    const app = await makeApp({ db: b.db })
    await app.webhooks.register(url('/a'), ['orders:created'], undefined, 'alice')
    await app.webhooks.register(url('/b'), ['orders:created'], undefined, 'bob')

    await app.webhooks.deliver('orders:created', ORDER)

    expect(b.asked.map(a => a.principal?.id).sort()).toEqual(['alice', 'bob'])
    expect(hits.length).toBe(1)
  })
})

// ─── Ungraded is not refused, and refused is not ungraded ─────────────────

describe('the three answers, and the line between the last two', () => {
  it('delivers ungraded where no model resolves — and grades where one does', async () => {
    const b   = boundary()
    const app = await makeApp({ db: b.db })
    await app.webhooks.register(url(), ['*'], undefined, 'bob')

    // `bob` may read no order, so a graded event reaches nobody.
    await app.webhooks.deliver('orders:created', ORDER)
    expect(hits.length).toBe(0)

    // The same subscriber, an event that names no model: grading was never
    // applicable, so the delivery is made rather than refused.
    await app.webhooks.deliver('anything:happened', { hello: 'world' })
    expect(sent()).toEqual([{ hello: 'world' }])
  })

  it('delivers a model that can only ever say yes without asking', async () => {
    const b   = boundary({ open: ['order'] })
    const app = await makeApp({ db: b.db })
    await app.webhooks.register(url(), ['orders:created'], undefined, 'bob')

    await app.webhooks.deliver('orders:created', ORDER)

    expect(sent()).toEqual([ORDER])
    expect(b.asked.length).toBe(0)
  })

  it('REFUSES where the rule was applicable and could not be answered', async () => {
    // A boundary that throws is undecidable, which is a different thing from a
    // question that was never asked. Conflating them is how a fail-closed check
    // becomes fail-open at the first odd shape.
    const bad = await makeApp({ db: boundary({ throwOn: 'order' }).db })
    await bad.webhooks.register(url(), ['orders:created'], undefined, 'alice')
    await bad.webhooks.deliver('orders:created', ORDER)
    expect(hits.length).toBe(0)

    // The pair: the identical call against a boundary that answers.
    const ok = await makeApp({ db: boundary().db })
    await ok.webhooks.register(url(), ['orders:created'], undefined, 'alice')
    await ok.webhooks.deliver('orders:created', ORDER)
    expect(hits.length).toBe(1)
  })

  it('REFUSES where the audience cannot be re-resolved', async () => {
    // A registrant deleted since. The principal is re-resolved at delivery and
    // never replayed from a snapshot, so this is the case that says so.
    const gone = await makeApp({ db: boundary().db })
    await gone.webhooks.register(url(), ['orders:created'], undefined, 'nobody-at-all')
    await gone.webhooks.deliver('orders:created', ORDER)
    expect(hits.length).toBe(0)

    const still = await makeApp({ db: boundary().db })
    await still.webhooks.register(url(), ['orders:created'], undefined, 'alice')
    await still.webhooks.deliver('orders:created', ORDER)
    expect(hits.length).toBe(1)
  })
})

// ─── The floor ────────────────────────────────────────────────────────────

describe('a protected column is never written down, graded or not', () => {
  it('strips a protected name from an UNGRADED payload, at any depth', async () => {
    const app = await makeApp({ db: boundary().db })
    await app.webhooks.register(url(), ['*'], undefined, 'alice')

    await app.webhooks.deliver('anything:happened', {
      id:     'x',
      password: 'hunter2',
      nested: { password: 'hunter2', keep: 1 },
      list:   [{ password: 'hunter2', keep: 2 }],
    })

    expect(sent()).toEqual([{ id: 'x', nested: { keep: 1 }, list: [{ keep: 2 }] }])
  })

  it('leaves an ordinary column alone — the strip is by the schema, not by shape', async () => {
    const app = await makeApp({ db: boundary().db })
    await app.webhooks.register(url(), ['*'], undefined, 'alice')
    await app.webhooks.deliver('anything:happened', { secretSauce: 'keep me', total: 7 })
    expect(sent()).toEqual([{ secretSauce: 'keep me', total: 7 }])
  })

  it('has nothing to strip where there is no schema, and delivers anyway', async () => {
    const app = await makeApp()            // no Data boundary at all
    await app.webhooks.register(url(), ['*'])
    await app.webhooks.deliver('anything:happened', { a: 1 })
    expect(sent()).toEqual([{ a: 1 }])
  })
})

// ─── A store that cannot answer ───────────────────────────────────────────

describe('a custom store that does not record an audience', () => {
  // ABSENT is not `null`. A store written before this existed cannot say who a
  // registration speaks for, and treating that as *nobody* would stop every
  // delivery in an app that upgraded — while treating it as *anybody* is the
  // hole. It is neither: the payload goes out ungraded and says so.
  function forgetfulStore(real: IWebhookStore): IWebhookStore {
    return {
      ...real,
      async findForEvent(event) {
        const rows = await real.findForEvent(event)
        return rows.map(({ subscriber: _s, ...rest }) => rest as WebhookRegistration)
      },
    }
  }

  it('delivers ungraded rather than refusing', async () => {
    const app0  = await createTestApp({ users: [{ id: 'alice', isAdmin: true }] as never })
    const store = forgetfulStore(createSqliteWebhookStore(app0.db as never))
    const app   = await makeApp({ db: boundary().db, store })

    await app.webhooks.register(url(), ['orders:created'], undefined, 'bob')
    await app.webhooks.deliver('orders:created', ORDER)

    // `bob` may not read it; the store cannot say the registration is bob's, so
    // no rule was applicable and the delivery is made with the floor applied.
    expect(sent()).toEqual([ORDER])
  })

  it('and the same store recording one grades it', async () => {
    const b   = boundary()
    const app = await makeApp({ db: b.db })
    await app.webhooks.register(url(), ['orders:created'], undefined, 'bob')
    await app.webhooks.deliver('orders:created', ORDER)
    expect(hits.length).toBe(0)
  })
})
