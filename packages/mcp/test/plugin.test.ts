/*
 * test/plugin.test.ts — the surface, inside a real app, over real HTTP.
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
import type { McpOptions } from '../src/plugin.ts'

const SCHEMA = readFileSync(new URL('./fixtures/shop.lite', import.meta.url), 'utf8')

let app:  { stop?: () => Promise<void>; http: { port?: number } } & Record<string, never>
let base: string
// What the app's `narrow` answers, swapped per test. Absent is every tool, so
// every other describe here grades the list with the guard allowing all.
let narrowBy: McpOptions['narrow'] | null = null
// What a `customers.find` hook last saw as the call's transport.
let seenTransport: string | null = null

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
    config:   { port: 0, services: { dir: '/nonexistent' } },
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
  // `mint` is FJS-1221's shape: a system write, returned as it came back.
  type Creds = { asSystem(): { credential: { create(a: unknown): Promise<unknown> } } }
  app.services.register(createService({
    name: 'credentials', model: 'Credential',
    mint: async () => ($.db as unknown as Creds).asSystem().credential.create({
      data: { label: 'minted', value: 'hunter2-minted', scope: 'scope-minted' },
    }),
    methods: ['find', 'get', 'create', { method: 'mint', gate: 5 }],
  }))
  app.services.register(createService({
    name: 'customers', model: 'Customer',
    methods: ['find', 'get'],
    hooks: { before: { find: [(c: { transport: string }) => { seenTransport = c.transport }] } },
  }))

  app.configure(mcpPlugin({ name: 'shop', narrow: (t, u) => narrowBy ? narrowBy(t, u) : true }))
  await app.start()
  // `apiPrefix` defaults to empty, and `app.post` applies whatever it is — so
  // the path here is the plugin's own, with no prefix of this test's invention.
  base = `http://localhost:${app.http.port}/mcp`

  const system = (db as unknown as { asSystem(): Record<string, { create(a: unknown): Promise<unknown>; transition(id: number, move: string): Promise<unknown> }> }).asSystem()
  await system.order!.create({ data: { id: 1, reference: 'ORD-1', total: 2500, status: 'pending' } })
  await system.customer!.create({ data: { id: 50, name: 'Ada' } })
  // A row starts at its @default (FJS-D470), so the paid order is walked there.
  await system.order!.create({ data: { id: 51, reference: 'ORD-51', total: 900, customerId: 50 } })
  await system.order!.transition(51, 'pay')
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
    // and a spent Request handed on makes the transport answer `400 Parse error:
    // Invalid JSON`, a message about JSON that has nothing to do with the JSON.
    // This asserting 200 is the proof that `ctx.$raw.$req` still carries the
    // bytes (`FJS-1180`).
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

// ─── an app's own narrowing ──────────────────────────────────────────────────

describe('narrow withholds what a standing cannot say (FJS-D407)', () => {

  // A read-only credential for staff alone — the shape of an API key's scopes.
  const readOnlyStaff: McpOptions['narrow'] = (t, u) =>
    (u as { userId?: string } | null)?.userId !== 'staff' || t.method === 'find' || t.method === 'get'

  test('it only removes: the narrowed list is the graded list less the writes, and another caller is untouched', async () => {
    const graded   = (await list('staff')).map(t => t.name)
    const shopper  = (await list('shopper')).map(t => t.name)
    narrowBy = readOnlyStaff
    try {
      const narrowed = (await list('staff')).map(t => t.name)
      expect(narrowed.length).toBeGreaterThan(0)
      expect(narrowed.every(n => graded.includes(n))).toBe(true)
      expect(narrowed).not.toContain('orders_refund')
      expect(graded).toContain('orders_refund')
      expect((await list('shopper')).map(t => t.name)).toEqual(shopper)
    } finally { narrowBy = null }
  })

  test('a withheld tool cannot be called here, and a breadcrumb never names one', async () => {
    narrowBy = readOnlyStaff
    try {
      const refused = await callTool('orders_refund', { id: 51 }, 'staff')
      expect(refused.text).toMatch(/not found/i)
      const got = (await callTool('orders_get', { id: 51 }, 'staff')).body as { result?: { _meta?: Record<string, any> } }
      expect(got.result?._meta?.['frontierjs/breadcrumbs'].map((b: { tool: string }) => b.tool)).toEqual(['customers_get'])
    } finally { narrowBy = null }
    // The order did not move.
    const after = (await callTool('orders_get', { id: 51 }, 'staff')).body as { result?: { content?: Array<{ text: string }> } }
    expect(JSON.parse(after.result!.content![0].text).status).toBe('paid')
  })

  test('a guard that throws fails the list rather than answering one', async () => {
    narrowBy = () => { throw new Error('scope lookup failed') }
    try {
      const r = await rpc('tools/list', {}, 'staff')
      expect((r.body as { result?: unknown }).result).toBeUndefined()
    } finally { narrowBy = null }
  })
})

// ─── what a one-row answer offers next ───────────────────────────────────────

describe('a one-row answer carries its breadcrumbs', () => {

  const result = (r: { body: Record<string, never> }) =>
    (r.body as { result?: { content?: Array<{ text: string }>; _meta?: Record<string, any> } }).result ?? {}

  test('in _meta, and as a second text block — the moves the row allows at THIS caller, and the row it points at', async () => {
    // A pair a rung apart: order 51 is paid, and refund needs 5.
    const staff   = result(await callTool('orders_get', { id: 51 }, 'staff'))
    const shopper = result(await callTool('orders_get', { id: 51 }, 'shopper'))
    const tools   = (r: typeof staff) => (r._meta?.['frontierjs/breadcrumbs'] ?? []).map((b: { tool: string }) => b.tool).sort()

    expect(tools(staff)).toEqual(['customers_get', 'orders_refund'])
    expect(tools(shopper)).toEqual(['customers_get'])
    expect(staff._meta?.['frontierjs/breadcrumbs']).toContainEqual({ kind: 'belongsTo', tool: 'customers_get', args: { id: 50 }, relation: 'customer' })
    // The row is still the first block, so a reader of content[0] is unchanged.
    expect(JSON.parse(staff.content![0].text).reference).toBe('ORD-51')
    expect(staff.content![1].text).toContain('orders_refund {"id":51}')
  })

  test('the other side of the relation is the find that lists it', async () => {
    const r = result(await callTool('customers_get', { id: 50 }, 'staff'))
    expect(r._meta?.['frontierjs/breadcrumbs']).toEqual([
      { kind: 'hasMany', tool: 'orders_find', args: { query: { customerId: 50 } }, relation: 'orders' },
    ])
    const listed = result(await callTool('orders_find', { query: { customerId: 50 } }, 'staff'))
    expect(JSON.parse(listed.content![0].text).data.map((o: { id: number }) => o.id)).toEqual([51])
  })

  test('a find answers many rows and carries none', async () => {
    const r = result(await callTool('orders_find', {}, 'staff'))
    expect(r._meta?.['frontierjs/breadcrumbs']).toBeUndefined()
    expect(r.content).toHaveLength(1)
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

describe('a tool call is a call from outside (FJS-D609, FJS-D613)', () => {

  test('it is stamped mcp, so an is-this-from-inside check refuses it', async () => {
    // `'internal'` here opened every internalOnly() method to whoever the tool
    // list offered it (FJS-1817).
    seenTransport = null
    await callTool('customers_find', {}, 'shopper')
    expect(seenTransport).toBe('mcp')
  })

  // A hit/miss pair over a @guarded column: answered at all, the two counts
  // read `scope` one comparison at a time (FJS-1816).
  const smuggled = {
    'a top-level $raw':        (like: string) => ({ $raw: `scope LIKE '${like}%'` }),
    'a $raw under NOT':        (like: string) => ({ NOT: { $raw: `scope NOT LIKE '${like}%'` } }),
    'a $raw under OR':         (like: string) => ({ OR: [{ id: -1 }, { $raw: `scope LIKE '${like}%'` }] }),
    'a forged tag under NOT':  (like: string) => ({ NOT: { $raw: { _litestoneRaw: true, sql: `scope NOT LIKE '${like}%'`, params: [] } } }),
  }
  for (const [label, where] of Object.entries(smuggled)) {
    test(`${label} is refused, never answered`, async () => {
      const r = await callTool('credentials_find', { query: where('scope') }, 'shopper')
      expect(r.body.result?.isError).toBe(true)
      expect(JSON.stringify(r.body)).toMatch(/\$raw/)
    })
  }

  test('the control: the same caller\'s plain find is answered', async () => {
    const r = await callTool('credentials_find', {}, 'shopper')
    expect(r.body.result?.isError ?? false).toBe(false)
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

describe('a protected column reaches no tool RESULT (FJS-D473)', () => {

  test('a method returning a system write answers the row without its @secret or @guarded', async () => {
    const res  = await callTool('credentials_mint', {}, 'staff')
    // The control: an answer that was refused satisfies every absence below.
    expect(res.body.result?.isError ?? false).toBe(false)
    expect(res.text).toContain('minted')
    expect(res.text).not.toContain('hunter2')
    expect(res.text).not.toContain('scope-minted')
  })
})

describe('GET /mcp/levels — what each level is offered, for an operator', () => {

  type Row = { name: string; verdict: string; needs: number | null }
  type Levels = { standing: number; levels: Array<{ level: number; tools: Row[]; withheld: Row[] }> }

  const levels = async (token?: string) => {
    const res = await fetch(`${base}/levels`, {
      headers: token ? { authorization: `Bearer test-token-${token}` } : {},
    })
    return { status: res.status, body: await res.json() as Levels }
  }
  const names = (rows: Array<{ name: string }>) => rows.map(r => r.name).sort()

  test('an administrator is answered every level from STRANGER to SYSTEM; a user and a stranger are refused', async () => {
    const staff = await levels('staff')
    expect(staff.status).toBe(200)
    expect(staff.body.standing).toBe(5)
    expect(staff.body.levels.map(l => l.level)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])

    expect((await levels('shopper')).status).toBe(403)
    expect((await levels()).status).toBe(403)
  })

  test('a level’s tools are the list tools/list answers a caller standing there', async () => {
    const { body } = await levels('staff')
    // A pair a rung apart, so a route that answered one list for every level fails.
    expect(names(body.levels[5]!.tools)).toEqual(names(await list('staff')))
    expect(names(body.levels[4]!.tools)).toEqual(names(await list('shopper')))
    expect(names(body.levels[4]!.tools)).not.toEqual(names(body.levels[5]!.tools))
  })

  test('a custom method’s declared gate and a move’s floor are graded, each with the rule that decided', async () => {
    const { body } = await levels('staff')
    const at = (level: number, name: string) => ({
      offered:  body.levels[level]!.tools.find(t => t.name === name),
      withheld: body.levels[level]!.withheld.find(t => t.name === name),
    })

    // `mint` is declared `{ method: 'mint', gate: 5 }` in the service, not the schema.
    expect(at(4, 'credentials_mint').withheld).toMatchObject({ verdict: 'method-gate', needs: 5 })
    expect(at(5, 'credentials_mint').offered).toMatchObject({ verdict: 'method-gate', needs: 5 })

    // `refund` is @gate(5) on a model a USER updates: the move's own floor decides.
    expect(at(4, 'orders_refund').withheld).toMatchObject({ verdict: 'move-floor', needs: 5 })
    expect(at(5, 'orders_refund').offered).toMatchObject({ verdict: 'move-floor', needs: 5 })
  })
})
