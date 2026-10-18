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
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server'
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { createClient }  from '@frontierjs/litestone'
import { parse } from '@frontierjs/litestone/parser'
import { generateJsonSchema } from '@frontierjs/litestone/jsonschema'
import { createApp, createService, $ } from '@frontierjs/junction'
import { createStubAuth } from '@frontierjs/junction/testing'
import { mcp } from '../src/plugin.ts'
import type { McpOptions } from '../src/plugin.ts'
import { projectTools, schemaViews } from '../src/projection.ts'
import type { ServiceShape } from '../src/projection.ts'
import { answersOneRow } from '../src/breadcrumbs.ts'

const SCHEMA = readFileSync(new URL('./fixtures/shop.lite', import.meta.url), 'utf8')

// What `fli mcp:build` would have written: a document per model that has a view.
// Credential has one-row tools and no file, which is the silent half of 1.5.
const VIEWS = mkdtempSync(join(tmpdir(), 'mcp-views-'))
const ORDER_HTML = '<!doctype html><html><body><form data-model="Order"></form></body></html>'
writeFileSync(join(VIEWS, 'Order.html'),    ORDER_HTML)
writeFileSync(join(VIEWS, 'Customer.html'), '<!doctype html><html><body>Customer</body></html>')

let app:  { stop?: () => Promise<void>; http: { port?: number } } & Record<string, never>
let base: string
// What the app's `narrow` answers, swapped per test. Absent is every tool, so
// every other describe here grades the list with the guard allowing all.
let narrowBy: McpOptions['narrow'] | null = null
// What a `customers.find` hook last saw as the call's transport.
let seenTransport: string | null = null
// What an `orders.patch` hook last saw as the call's `base`.
let seenBase: unknown = undefined

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
      { id: 'reader',  isAdmin: true, scopes: ['orders:read'] },   // staff's standing, a key's reach
      // The other rungs a session can stand on, for the ladder the views are swept over.
      { id: 'unverified',  verifiedAt: null },        // VISITOR — 1
      { id: 'unactivated', activatedAt: null },       // READER — 2
      { id: 'roleless',    role: '' },                // CREATOR — 3
      { id: 'owner',       isOwner: true },           // OWNER — 6
      { id: 'sysadmin',    isSystemAdmin: true },     // SYSADMIN — 7
    ],
  })

  app = createApp({
    db, auth,
    config:   { port: 0 },
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
    scope:   { read: 'orders:read', write: 'orders:write' },
    // Taken off once seen: Order declares no `@@sync(field)`, so the Data
    // boundary would refuse the base by name, and what is asked here is only
    // whether it crossed.
    hooks: { before: { patch: [(c: { base?: unknown }) => { seenBase = c.base ?? null; delete c.base }] } },
  }))
  // `mint` is FJS-1221's shape: a system write, returned as it came back.
  type Creds = { asSystem(): { credential: { create(a: unknown): Promise<unknown> } } }
  app.services.register(createService({
    name: 'credentials', model: 'Credential',
    mint: async () => ($.db as unknown as Creds).asSystem().credential.create({
      data: { label: 'minted', value: 'hunter2-minted', privilege: 'privilege-minted' },
    }),
    // `tally` answers a NUMBER: the one shape a tool answer cannot carry as an object.
    tally: async (ctx: { dispatch: boolean }) => { ctx.dispatch = false; return 3 },
    methods: ['find', 'get', 'create', { method: 'mint', gate: 5 }, { method: 'tally', gate: 5 }],
  }))
  app.services.register(createService({
    name: 'customers', model: 'Customer',
    methods: ['find', 'get'],
    hooks: { before: { find: [(c: { transport: string }) => { seenTransport = c.transport }] } },
  }))

  app.configure(mcp({ name: 'shop', ui: { root: VIEWS }, narrow: (t, u) => narrowBy ? narrowBy(t, u) : true }))
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

type ListedTool = { name: string; inputSchema?: unknown; description?: string; _meta?: Record<string, unknown> & { ui?: { resourceUri?: string; visibility?: string[] } } }
const list = async (token?: string, meta?: Record<string, unknown>) => {
  const r = await rpc('tools/list', meta ? { _meta: meta } : {}, token)
  return ((r.body as { result?: { tools?: ListedTool[] } }).result?.tools ?? [])
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

// ─── a @system move ──────────────────────────────────────────────────────────

// FJS-1925's shape, both halves, in an app of its own so the services here do
// not appear in the breadcrumbs the app above is graded on. `purchases` writes
// no method, so junction derives each move Order declares, and `lapse` is
// `@system`. `settlements` writes the method that lifts it, as `example`'s
// `invoices.settle` does.
describe('a @system move is offered only where a method lifts it (FJS-1925)', () => {
  let own:   { stop?: () => Promise<void>; http: { port?: number } } & Record<string, never>
  let url:   string
  let store: Record<string, { create(a: unknown): Promise<unknown>; findFirst(a: unknown): Promise<{ status: string }> }>

  beforeAll(async () => {
    const db = await createClient({ db: ':memory:', schema: SCHEMA, encryptionKey: '0'.repeat(64) }) as Record<string, never>
    own = createApp({
      db, auth: createStubAuth({ users: [{ id: 'staff', isAdmin: true }, { id: 'shopper' }] }),
      config:   { port: 0, database: { url: '', log: false } },
      logLevel: 'silent',
    }) as never
    own.services.register(createService({ name: 'purchases', model: 'Order' }))
    type Lapsing = { order: { transition(id: unknown, name: string, o: { system: true }): Promise<unknown> } }
    own.services.register(createService({
      name: 'settlements', model: 'Order',
      lapse: async () => ($.db as unknown as Lapsing).order.transition(Number($.id), 'lapse', { system: true }),
      methods: ['get', 'lapse'],
    }))
    own.configure(mcp({ name: 'shop' }))
    await own.start()
    url   = `http://localhost:${own.http.port}/mcp`
    store = (db as unknown as { asSystem(): typeof store }).asSystem()
    for (const id of [61, 62]) await store.order!.create({ data: { id, reference: `ORD-${id}`, total: 100 } })
  })
  afterAll(async () => { await own?.stop?.() })

  const speak = async (method: string, params: unknown, token: string) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
                 authorization: `Bearer test-token-${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    return JSON.parse(await res.text()) as { result?: { isError?: boolean; tools?: Array<{ name: string }> }; error?: unknown }
  }
  const names  = async (who: string) => ((await speak('tools/list', {}, who)).result?.tools ?? []).map(t => t.name)
  const call   = (name: string, id: number, who: string) => speak('tools/call', { name, arguments: { id } }, who)
  const status = async (id: number) => (await store.order!.findFirst({ where: { id } })).status

  test('a generated service does not offer lapse at any level a person holds, while its other moves are', async () => {
    for (const who of ['shopper', 'staff']) {
      const offered = await names(who)
      expect(offered, who).toContain('purchases_pay')
      expect(offered, who).not.toContain('purchases_lapse')
    }
  })

  test('the written method is offered from the update level, and moves the row', async () => {
    expect(await names('shopper')).toContain('settlements_lapse')
    expect(await status(61)).toBe('pending')
    expect((await call('settlements_lapse', 61, 'shopper')).result?.isError ?? false).toBe(false)
    expect(await status(61)).toBe('cancelled')
  })

  test('naming the derived tool anyway is refused and the row stays', async () => {
    const r = await call('purchases_lapse', 62, 'staff')
    expect(r.result?.isError === true || r.error !== undefined).toBe(true)
    expect(await status(62)).toBe('pending')
    // The paired control: the same row moves by a tool that is offered.
    expect((await call('purchases_pay', 62, 'staff')).result?.isError ?? false).toBe(false)
    expect(await status(62)).toBe('paid')
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

// ─── a key's declared scopes ─────────────────────────────────────────────────

describe('a scoped key is offered what its scopes reach, with no narrow (FJS-D916)', () => {

  test('the list is the reads of the one service its scope names, and the call refuses the rest', async () => {
    const names = (await list('reader')).map(t => t.name).sort()
    expect(names).toEqual(['orders_find', 'orders_get'])
    // Staff stands where reader stands and is held to nothing.
    expect((await list('staff')).map(t => t.name)).toContain('orders_refund')
    expect((await callTool('orders_refund', { id: 51 }, 'reader')).text).toMatch(/not found/i)
    const got = (await callTool('orders_get', { id: 51 }, 'reader')).body as { result?: { isError?: boolean } }
    expect(got.result?.isError).toBeFalsy()
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

// ─── the answer is structured ────────────────────────────────────────────────

describe('the answer is structured: the object a view reads is the text an agent reads', () => {

  const result = (r: { body: Record<string, never> }) =>
    (r.body as { result?: { content?: Array<{ text: string }>; structuredContent?: Record<string, unknown> } }).result ?? {}

  test('a get carries the row, and it is the first text block parsed', async () => {
    const r = result(await callTool('orders_get', { id: 51 }, 'staff'))
    expect(r.structuredContent?.reference).toBe('ORD-51')
    expect(r.structuredContent).toEqual(JSON.parse(r.content![0].text))
  })

  test('a find carries the list envelope whole, kind and data, as the socket hands it', async () => {
    const r = result(await callTool('orders_find', { query: { customerId: 50 } }, 'staff'))
    expect(r.structuredContent?.kind).toBe('list')
    expect((r.structuredContent?.data as Array<{ id: number }> | undefined)?.map(o => o.id)).toEqual([51])
    expect(r.structuredContent).toEqual(JSON.parse(r.content![0].text))
  })

  test('a refusal carries the body HTTP answers the same call with, so a view rebuilds code and data', async () => {
    // A unique collision: the Data boundary's refusal, with the column in `data`.
    const row  = { reference: 'ORD-51', total: 100 }
    const http = await fetch(base.replace(/\/mcp$/, '/orders'), {
      method:  'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token-staff' },
      body:    JSON.stringify(row),
    })
    const wire = await http.json() as Record<string, unknown>
    const r    = (await callTool('orders_create', row, 'staff')).body as { result?: { isError?: boolean; content?: Array<{ text: string }>; structuredContent?: Record<string, unknown> } }
    expect(r.result?.isError).toBe(true)
    expect(r.result?.structuredContent).toEqual(wire)
    expect(r.result?.structuredContent?.code).toBe(http.status)
    expect(r.result?.content?.[0].text).toBe(wire.message)
    // The half `toFieldErrors` reads: without it the message lands on the form, not under the field.
    expect(r.result?.structuredContent?.data).toEqual([expect.objectContaining({ path: ['reference'] })])
  })

  test('a scalar answer rides in the text alone, and nothing fails', async () => {
    const r = result(await callTool('credentials_tally', {}, 'staff'))
    expect(r.content![0].text).toBe('3')
    expect(r.structuredContent).toBeUndefined()
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
  // read `privilege` one comparison at a time (FJS-1816).
  const smuggled = {
    'a top-level $raw':        (like: string) => ({ $raw: `privilege LIKE '${like}%'` }),
    'a $raw under NOT':        (like: string) => ({ NOT: { $raw: `privilege NOT LIKE '${like}%'` } }),
    'a $raw under OR':         (like: string) => ({ OR: [{ id: -1 }, { $raw: `privilege LIKE '${like}%'` }] }),
    'a forged tag under NOT':  (like: string) => ({ NOT: { $raw: { _litestoneRaw: true, sql: `privilege NOT LIKE '${like}%'`, params: [] } } }),
  }
  for (const [label, where] of Object.entries(smuggled)) {
    test(`${label} is refused, never answered`, async () => {
      const r = await callTool('credentials_find', { query: where('privilege') }, 'shopper')
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
    expect(text).not.toContain('privilege')
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
    // The whole body, so `structuredContent` is held to the same absence.
    expect(res.text).not.toContain('hunter2')
    expect(res.text).not.toContain('privilege-minted')
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

// ─── the views (MCP Apps) ─────────────────────────────────────────────────────

describe('a one-row tool\'s model is offered as a view, from the same list as the tools', () => {
  type Listed = { uri: string; name: string; mimeType?: string; _meta?: { ui?: { csp?: { connectDomains?: string[] } } } }
  const views = async (token?: string, meta?: Record<string, unknown>) => {
    const r = await rpc('resources/list', meta ? { _meta: meta } : {}, token)
    return { error: (r.body as { error?: unknown }).error, list: (r.body as { result?: { resources?: Listed[] } }).result?.resources }
  }
  const uris = async (token?: string) => ((await views(token)).list ?? []).map(v => v.uri)

  test('staff are offered Order and Customer, with the extension\'s mime type and no network of its own', async () => {
    const { list } = await views('staff')
    expect(list!.map(v => v.uri)).toEqual(expect.arrayContaining(['ui://shop/Order', 'ui://shop/Customer']))
    for (const v of list!) {
      expect(v.mimeType).toBe(RESOURCE_MIME_TYPE)
      expect(v._meta?.ui?.csp?.connectDomains).toEqual([])
    }
  })

  test('a model with one-row tools and no document is offered no view, and nothing fails', async () => {
    const staff = await list('staff')
    expect(staff.map(t => t.name)).toContain('credentials_get')     // the tool is there…
    expect(await uris('staff')).not.toContain('ui://shop/Credential') // …its screen is not
  })

  test('the pair: Order reads at 1, so a stranger is a server with no resources and a shopper is offered it', async () => {
    // Not an empty list: the SDK installs the resources handlers with the first
    // registration, so a caller offered none sees no capability and -32601.
    const stranger = await views()
    expect((stranger.error as { code?: number })?.code).toBe(-32601)
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    const caps = (r: typeof init) => (r.body as { result?: { capabilities?: { resources?: unknown } } }).result?.capabilities?.resources
    expect(caps(init)).toBeUndefined()
    expect(caps(await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }, 'staff'))).toBeDefined()
    expect(await uris('shopper')).toContain('ui://shop/Order')
  })

  test('resources/read answers the document to a caller offered it, and refuses one who is not', async () => {
    const staff = await rpc('resources/read', { uri: 'ui://shop/Order' }, 'staff')
    const got   = (staff.body as { result?: { contents?: Array<{ uri: string; mimeType?: string; text?: string }> } }).result?.contents?.[0]
    expect(got?.uri).toBe('ui://shop/Order')
    expect(got?.mimeType).toBe(RESOURCE_MIME_TYPE)
    expect(got?.text).toBe(ORDER_HTML)

    const stranger = await rpc('resources/read', { uri: 'ui://shop/Order' })
    expect((stranger.body as { error?: unknown }).error).toBeDefined()
    expect(stranger.text).not.toContain('data-model')
  })

  test('a tool narrow withholds takes its view with it — the view follows the tool list, not the schema', async () => {
    narrowBy = t => t.service !== 'orders'
    try {
      const staff = await uris('staff')
      expect(staff).not.toContain('ui://shop/Order')
      expect(staff).toContain('ui://shop/Customer')
    } finally { narrowBy = null }
  })

  test('a host that declares its capabilities and names no view is offered none; one naming the mime type is', async () => {
    // The 2026-07-28 era puts the client's capabilities on every request. A
    // declared envelope without the extension is read as asked; silence (every
    // test above) is unknown and permissive, as `x-gate` is in the browser.
    const silent = await views('staff', { [CLIENT_CAPABILITIES_META_KEY]: {} })
    expect(silent.error).toBeDefined()
    expect(silent.list).toBeUndefined()

    const speaking = await views('staff', { [CLIENT_CAPABILITIES_META_KEY]: { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } } })
    expect(speaking.error).toBeUndefined()
    expect(speaking.list!.map(v => v.uri)).toContain('ui://shop/Order')
  })

  // ─── the tool points at it ──────────────────────────────────────────────────

  const pointer = (t: ListedTool) => t._meta?.ui?.resourceUri
  const stamped = async (token?: string, meta?: Record<string, unknown>) =>
    Object.fromEntries((await list(token, meta)).filter(t => pointer(t)).map(t => [t.name, pointer(t)]))

  test('every one-row tool of a viewed model carries its view, in both spellings; a find and a viewless model carry none', async () => {
    const staff = await list('staff')
    const by    = Object.fromEntries(staff.map(t => [t.name, t]))
    for (const name of ['orders_get', 'orders_patch', 'orders_refund']) {
      expect(pointer(by[name]), name).toBe('ui://shop/Order')
      expect(by[name]._meta?.['ui/resourceUri'], name).toBe('ui://shop/Order')
      expect(by[name]._meta?.ui?.visibility, name).toBeUndefined()
    }
    expect(pointer(by.orders_find)).toBeUndefined()
    expect(by.orders_find._meta?.ui).toBeUndefined()
    expect(pointer(by.credentials_get)).toBeUndefined()
  })

  test('the stamps and the resource list are one answer: no pointer names a view the caller is not offered, and every view is pointed at', async () => {
    for (const token of ['staff', 'shopper']) {
      const pointed = new Set(Object.values(await stamped(token)))
      const offered = new Set(await uris(token))
      expect(pointed, token).toEqual(offered)
    }
  })

  test('a withheld tool loses its stamp with its view, and the pair over the host envelope: declared-no-ui is text-only', async () => {
    narrowBy = t => t.service !== 'orders'
    try {
      const staff = await stamped('staff')
      expect(staff.orders_get).toBeUndefined()
      expect(staff.customers_get).toBe('ui://shop/Customer')
    } finally { narrowBy = null }

    const silent = await stamped('staff', { [CLIENT_CAPABILITIES_META_KEY]: {} })
    expect(silent).toEqual({})
    const speaking = await stamped('staff', { [CLIENT_CAPABILITIES_META_KEY]: { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } } })
    expect(speaking.orders_get).toBe('ui://shop/Order')
  })
})

// ─── the views, over every standing ───────────────────────────────────────────
//
// The pairs above are two callers a rung apart. This is the claim they sample,
// at every rung a session can stand on and for the scoped key: a standing that
// cannot call a model's one-row tool cannot load its screen, and one that can
// is offered it. SYSTEM is no session's standing, so it is the levels route's.

describe('every fixture standing is offered the views of exactly the one-row tools it is offered', () => {

  // Read off what the plugin reads — the app's services and its parsed schema —
  // so the expected set is the projection's answer, not a list written here.
  const parsed = parse(SCHEMA)
  const views  = schemaViews(parsed.schema, generateJsonSchema as never)
  const shapes = () => {
    const services = (app as unknown as { services: { list(): string[]; get(n: string): { describe(): ServiceShape } } }).services
    return services.list().map(n => services.get(n).describe())
  }
  const documented = new Set(readdirSync(VIEWS).map(f => f.replace(/\.html$/, '')))

  // Where the answer changes: Order reads at 1, Customer at 4, and the key's
  // scope reaches orders alone. A sweep that answered one list at every rung
  // passes the equality below and fails this.
  const RUNGS: Array<[label: string, token: string | undefined, level: number, models: string[]]> = [
    ['stranger',    undefined,     0, []],
    ['unverified',  'unverified',  1, ['Order']],
    ['unactivated', 'unactivated', 2, ['Order']],
    ['roleless',    'roleless',    3, ['Order']],
    ['shopper',     'shopper',     4, ['Customer', 'Order']],
    ['staff',       'staff',       5, ['Customer', 'Order']],
    ['owner',       'owner',       6, ['Customer', 'Order']],
    ['sysadmin',    'sysadmin',    7, ['Customer', 'Order']],
    ['reader',      'reader',      5, ['Order']],
  ]

  const listed = async (token?: string) => {
    const r = await rpc('resources/list', {}, token)
    return ((r.body as { result?: { resources?: Array<{ uri: string }> } }).result?.resources ?? []).map(v => v.uri).sort()
  }
  const uri = (model: string) => `ui://shop/${model}`

  for (const [label, token, level, models] of RUNGS) {
    test(`${label}: the resource list is the documented models of its one-row tools, and no other view reads`, async () => {
      const offered = new Set((await list(token)).map(t => t.name))
      const graded  = projectTools(shapes(), views, level).tools
      // Every listed tool is one the projection graded in at this level, so the
      // models below are read off the real list rather than a level's guess.
      expect([...offered].filter(n => !graded.some(t => t.name === n)), label).toEqual([])

      const expected = new Set(graded
        .filter(t => offered.has(t.name) && answersOneRow(t) && documented.has(t.model as string))
        .map(t => t.model as string))
      expect(await listed(token), label).toEqual([...expected].map(uri).sort())
      expect([...expected].sort(), label).toEqual(models)

      for (const model of documented) {
        if (expected.has(model)) continue
        const read = await rpc('resources/read', { uri: uri(model) }, token)
        expect((read.body as { error?: unknown }).error, `${label} reads ${model}`).toBeDefined()
        expect(read.text, `${label} reads ${model}`).not.toContain('<!doctype html>')
      }
    })
  }
})

describe('a declared ui.root that cannot be read refuses the boot (FJS-D955)', () => {
  const boot = async (root: string) => {
    const db  = await createClient({ db: ':memory:', schema: SCHEMA, encryptionKey: '0'.repeat(64) }) as Record<string, never>
    const own = createApp({
      db, auth: createStubAuth({ users: [] }),
      config:   { port: 0, database: { url: '', log: false } },
      logLevel: 'silent',
    }) as never as { configure(p: unknown): void; start(): Promise<void>; stop?(): Promise<void> }
    own.configure(mcp({ ui: { root } }))
    try { await own.start(); await own.stop?.(); return null }
    catch (err) { return (err as Error).message }
  }

  test('a directory that is not there is named, with the command that writes it', async () => {
    const missing = join(VIEWS, 'never-built')
    const message = await boot(missing)
    expect(message).toContain(missing)
    expect(message).toContain('fli mcp:build')
  })

  test('a relative root is refused rather than resolved from the cwd', async () => {
    const message = await boot('dist/mcp')
    expect(message).toContain('absolute')
  })
})

// ─── a call option beside the arguments ───────────────────────────────────────

describe('the base a view read rides _meta', () => {

  const patch = (meta?: Record<string, unknown>) => rpc('tools/call', {
    name: 'orders_patch', arguments: { id: 1, data: { reference: 'ORD-1' } },
    ...(meta ? { _meta: meta } : {}),
  }, 'staff')

  test('a base in _meta reaches the call as ctx.base, and its absence is absence', async () => {
    // `@@sync(field)`'s merge input, which no tool argument spells: sent by
    // `@frontierjs/sierra/mcp`'s relay under this key, which it restates.
    const row = { id: 1, reference: 'ORD-1', total: 2500 }
    seenBase = undefined
    expect((await patch({ 'frontierjs/base': row })).text).not.toContain('"isError":true')
    expect(seenBase).toEqual(row)

    seenBase = undefined
    expect((await patch()).text).not.toContain('"isError":true')
    expect(seenBase).toBeNull()
  })

  test('a base that is not a row is refused by name before the service runs', async () => {
    seenBase = undefined
    const r = await patch({ 'frontierjs/base': [1, 2] })
    expect(r.text).toContain('"isError":true')
    expect(r.text).toContain("frontierjs/base")
    expect(r.text).toContain('a list')
    expect(seenBase).toBeUndefined()
  })
})
