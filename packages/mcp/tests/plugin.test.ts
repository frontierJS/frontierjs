/*
 * tests/plugin.test.ts — the surface, inside a real app, over real HTTP.
 *
 * The projection has unit tests and they cannot see the half that broke twice
 * while this was being built: junction consumes the request body before a route
 * handler runs, and the level a plugin route reads is not the level the boundary
 * grades with. Both are crossings, and a test on either side alone passes with
 * the crossing broken.
 *
 * So this boots a REAL Junction app over a REAL Litestone client on a REAL port
 * and speaks JSON-RPC to it. Every visibility row is a PAIR — the same call by
 * two callers a rung apart — because a surface that answered nobody satisfies
 * every assertion about a refusal, and one that answered everybody satisfies
 * every assertion about an affordance.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createClient }  from '@frontierjs/litestone'
import { createApp, createService, $ } from '@frontierjs/junction'
import { createStubAuth } from '@frontierjs/junction/testing'
import { mcpPlugin } from '../src/plugin.ts'

const SCHEMA = readFileSync(new URL('./fixtures/shop.lite', import.meta.url), 'utf8')

let app:  { stop?: () => Promise<void>; http: { port?: number } } & Record<string, never>
let base: string

beforeAll(async () => {
  // `Credential.value` is `@encrypted`, so the client refuses to open without a
  // key. A fixed one here rather than an env read: the test owns its database.
  const db = await createClient({
    db: ':memory:', schema: SCHEMA,
    encryptionKey: '0'.repeat(64),
  }) as Record<string, never>

  const auth = createStubAuth({
    users: [
      { id: 'staff',   isAdmin: true },   // ADMINISTRATOR — 5
      { id: 'shopper' },                  // USER — 4
    ],
  })

  app = createApp({
    db, auth,
    config:   { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
    logLevel: 'silent',
  }) as never

  // The two moves are real methods that drive the real transition, because the
  // point of a move tool is the row moving — a stub would pass every assertion
  // about dispatch and none about what dispatch is for.
  type Orders = { order: { transition(id: unknown, name: string): Promise<unknown> } }
  const move = (name: string) => async () =>
    ($.db as unknown as Orders).order.transition(Number($.id), name)

  app.services.register(createService({
    name: 'orders', model: 'Order',
    pay:    move('pay'),
    refund: move('refund'),
    methods: ['find', 'get', 'create', 'patch', 'remove', 'pay', 'refund'],
  }))
  app.services.register(createService({
    name: 'credentials', model: 'Credential',
    methods: ['find', 'get', 'create'],
  }))

  app.configure(mcpPlugin({ name: 'shop' }))
  await app.start()
  // `apiPrefix` defaults to empty, and `app.post` applies whatever it is — so
  // the path here is the plugin's own, with no prefix of this test's invention.
  base = `http://localhost:${app.http.port}/mcp`

  await (db as unknown as { asSystem(): Record<string, { create(a: unknown): Promise<unknown> }> })
    .asSystem().order!.create({ data: { id: 1, reference: 'ORD-1', total: 2500, status: 'pending' } })
})

afterAll(async () => { await app?.stop?.() })

// ─── speaking to it ───────────────────────────────────────────────────────────

async function rpc(method: string, params: unknown, token?: string) {
  const res = await fetch(base, {
    method:  'POST',
    headers: {
      'content-type': 'application/json',
      accept:         'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer test-token-${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = await res.text()
  let body: Record<string, never> = {} as never
  try { body = JSON.parse(text) } catch { /* left empty; the status is the finding */ }
  return { status: res.status, text, body }
}

const list = async (token?: string) => {
  const r = await rpc('tools/list', {}, token)
  return ((r.body as { result?: { tools?: Array<{ name: string; inputSchema?: unknown; description?: string }> } })
    .result?.tools ?? [])
}

const callTool = (name: string, args: unknown, token?: string) =>
  rpc('tools/call', { name, arguments: args }, token)

// ─── the transport, inside junction ───────────────────────────────────────────

describe('the endpoint answers at all', () => {

  test('initialize is answered — which means the body survived junction reading it', () => {
    // junction parses the body of every matched request BEFORE the handler runs,
    // with no clone, so the Request a route hands on is spent. Handed over as-is
    // the transport answers `400 Parse error: Invalid JSON`, a message about
    // JSON that has nothing to do with the JSON. This asserting 200 is the whole
    // proof that `replayBody` put the bytes back.
    return rpc('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' },
    }).then(r => {
      expect(r.status).toBe(200)
      expect(r.text).toContain('serverInfo')
      expect(r.text).toContain('shop')
    })
  })

  test('a malformed body is refused rather than crashing the route', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{ not json',
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })
})

// ─── who sees what ────────────────────────────────────────────────────────────

describe('the tool list is the caller\'s, not the app\'s', () => {

  test('a stranger sees fewer tools than staff, and neither list is empty', async () => {
    const stranger = await list()
    const staff    = await list('staff')
    // Both halves stated: a surface that answered nobody passes every refusal
    // assertion below on its own, and one that answered everybody passes every
    // affordance assertion.
    expect(stranger.length).toBeGreaterThan(0)
    expect(staff.length).toBeGreaterThan(stranger.length)
  })

  test('Order reads at 1, so the stranger is refused the list and a shopper is not', async () => {
    const names = (ts: Array<{ name: string }>) => ts.map(t => t.name)
    expect(names(await list())).not.toContain('orders_find')
    expect(names(await list('shopper'))).toContain('orders_find')
  })

  test('the refund move needs 5, so a shopper does not see it and staff do', async () => {
    // `@gate 5` over an update of 4 — the floor. The pair one rung apart is the
    // only shape that separates *the gate works* from *this caller sees nothing*.
    const shopper = (await list('shopper')).map(t => t.name)
    const staff   = (await list('staff')).map(t => t.name)
    expect(shopper).not.toContain('orders_refund')
    expect(staff).toContain('orders_refund')
    expect(shopper).toContain('orders_pay')      // update 4 — the control
  })

  test('every name a client is offered is one a client will accept', async () => {
    const legal = /^[a-zA-Z0-9_-]{1,128}$/
    for (const t of await list('staff')) expect(legal.test(t.name), t.name).toBe(true)
  })
})

// ─── what a tool call actually does ───────────────────────────────────────────

describe('a call goes through the service, as the caller', () => {

  test('a read answers the row', async () => {
    const r    = await callTool('orders_get', { id: 1 }, 'shopper')
    const text = JSON.stringify(r.body)
    expect(text).toContain('ORD-1')
  })

  test('a write reaches the database', async () => {
    const before = await callTool('orders_get', { id: 1 }, 'staff')
    expect(JSON.stringify(before.body)).toContain('pending')

    await callTool('orders_patch', { id: 1, data: { note: 'by an agent' } }, 'staff')

    const after = await callTool('orders_get', { id: 1 }, 'staff')
    expect(JSON.stringify(after.body)).toContain('by an agent')
  })

  test('a move takes the id the tool asked for, and moves the row', async () => {
    // The move half carried no argument schema at all until this build, so
    // `orders_pay` was listed, correctly graded, and uncallable.
    const r = await callTool('orders_pay', { id: 1 }, 'staff')
    expect(r.body.result?.isError ?? false).toBe(false)
    const after = await callTool('orders_get', { id: 1 }, 'staff')
    expect(JSON.stringify(after.body)).toContain('paid')
  })

  test('a withheld tool is not registered for that caller, so calling it fails closed', async () => {
    // What actually happens, rather than what is comfortable to claim: the
    // shopper's server has no `orders_refund` on it at all, so the refusal is
    // the protocol's *unknown tool* and not Litestone's. That is fail-closed and
    // it is NOT the boundary — which is the row below. Measured against
    // `example`, where the same call answers `Tool orders_refund not found`.
    const refused = await callTool('orders_refund', { id: 1 }, 'shopper')
    const text = JSON.stringify(refused.body)
    expect(refused.body.result?.isError ?? refused.body.error != null).toBe(true)
    expect(text).toContain('not found')

    // The pair: staff have it, and their call is not refused by name.
    const allowed = await callTool('orders_refund', { id: 1 }, 'staff')
    expect(JSON.stringify(allowed.body)).not.toContain('not found')
  })

  test('and the BOUNDARY refuses a tool it did offer — the affordance is not the gate', async () => {
    // Invariant 6, asked the only way it can be: a tool the caller IS offered,
    // whose call the Data boundary still refuses. `refund` moves `paid → refunded`,
    // so a pending order is a legal call by a legal caller on an illegal
    // transition — nothing about the gate, everything about the row.
    const made = await callTool('orders_create', { reference: 'ORD-PEND', total: 100, status: 'pending' }, 'staff')
    const id = JSON.parse(JSON.parse(made.text).result.content[0].text).id as number

    expect((await list('staff')).map(t => t.name)).toContain('orders_refund')
    const refused = await callTool('orders_refund', { id }, 'staff')
    expect(refused.body.result?.isError).toBe(true)
    expect(JSON.stringify(refused.body)).not.toContain('not found')

    // The control, so the row is not satisfied by a surface that refuses every
    // move: the same tool on a row in the state it accepts.
    await callTool('orders_pay', { id }, 'staff')
    const ok = await callTool('orders_refund', { id }, 'staff')
    expect(ok.body.result?.isError ?? false).toBe(false)
  })
})

// ─── what is never in a tool description ──────────────────────────────────────

describe('a credential column reaches no tool schema', () => {

  test('the protected columns are absent and the ordinary one is present', async () => {
    // `audience: 'system'` would put `value` — a stored secret — into a tool
    // DESCRIPTION, read before any call is made. The pair is `label`: a surface
    // that emitted no Credential schema at all satisfies the absence on its own,
    // which is `FJS-976`'s own lesson one realm over.
    const tools = await list('staff')
    const create = tools.find(t => t.name === 'credentials_create')
    const text   = JSON.stringify(create?.inputSchema ?? {})
    expect(text).toContain('label')
    expect(text).not.toContain('value')
    expect(text).not.toContain('scope')
  })

  test('and no schema anywhere in the list names one, on a list this test did not write', async () => {
    // The protected set is DERIVED — it is exactly what the two audiences
    // disagree about — so a column the seed grows arrives here without this
    // file being opened. Naming columns instead is how the assertion goes stale
    // the moment the fixture does.
    const { generateJsonSchema } = await import('@frontierjs/litestone')
    const { parse }              = await import('@frontierjs/litestone/parser')
    const schema = parse(SCHEMA).schema
    const defs = (audience: string) =>
      ((generateJsonSchema(schema as never, { mode: 'full', audience } as never) as { $defs?: Record<string, { properties?: object }> }).$defs ?? {})

    const client = defs('client')
    const system = defs('system')
    const guarded: string[] = []
    for (const [model, def] of Object.entries(system)) {
      const open = (client[model]?.properties ?? {}) as Record<string, unknown>
      for (const key of Object.keys(def.properties ?? {})) if (!(key in open)) guarded.push(key)
    }
    // The control: a derivation that found nothing would pass the loop below
    // vacuously, which is the same shape as a projection that leaked everything.
    expect(guarded.length).toBeGreaterThan(0)

    const all = JSON.stringify(await list('staff'))
    for (const key of guarded) expect(all, key).not.toContain(`"${key}"`)
  })
})
