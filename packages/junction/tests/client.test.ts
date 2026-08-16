// tests/client.test.ts
// JunctionClient test suite — Bun test runner.
// Tests cover: URL normalisation, Store, ServiceProxy, resource(),
// _hasFiles / _toFormData, and WS routing logic.
//
// No real network calls — _request is intercepted via fetch mock.
// Run: bun test tests/client.test.ts

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import {
  createJunctionClient,
  JunctionClient,
  ResultShapeError,
  ServiceProxy,
  Store,
} from '../src/client/index.ts'
import type { PaginatedResult } from '../src/client/index.ts'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeClient(url = 'http://localhost:3000', token?: string) {
  return createJunctionClient({ url, token, timeout: 5_000 })
}

// Intercept fetch so tests never hit the network.
// Returns a factory that lets each test configure the response.
function mockFetch(body: unknown, status = 200) {
  const original = globalThis.fetch
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  ) as typeof fetch
  return {
    restore: () => { globalThis.fetch = original },
    mock:    globalThis.fetch as ReturnType<typeof mock>,
  }
}

// ─── URL normalisation ────────────────────────────────────────────────────────

describe('createJunctionClient — URL normalisation', () => {

  it('accepts http:// URL', () => {
    const c = makeClient('http://localhost:3000')
    expect((c as unknown as { _url: string })._url).toBe('http://localhost:3000')
  })

  it('strips trailing slash', () => {
    const c = makeClient('http://localhost:3000/')
    expect((c as unknown as { _url: string })._url).toBe('http://localhost:3000')
  })

  it('converts ws:// to http://', () => {
    const c = makeClient('ws://localhost:3000')
    expect((c as unknown as { _url: string })._url).toBe('http://localhost:3000')
  })

  it('converts wss:// to https://', () => {
    const c = makeClient('wss://example.com')
    expect((c as unknown as { _url: string })._url).toBe('https://example.com')
  })

  it('sets token from options', () => {
    const c = makeClient('http://localhost:3000', 'my-token')
    expect(c.token).toBe('my-token')
  })

  it('setToken() updates the token', () => {
    const c = makeClient()
    c.setToken('new-token')
    expect(c.token).toBe('new-token')
  })

})

// ─── service() ────────────────────────────────────────────────────────────────

describe('client.service()', () => {

  it('returns a ServiceProxy', () => {
    const c = makeClient()
    expect(c.service('users')).toBeInstanceOf(ServiceProxy)
  })

  it('returns the same instance on repeated calls', () => {
    const c = makeClient()
    expect(c.service('users')).toBe(c.service('users'))
  })

  it('returns different instances for different service names', () => {
    const c = makeClient()
    expect(c.service('users')).not.toBe(c.service('posts'))
  })

  it('ServiceProxy has the correct name', () => {
    const c = makeClient()
    expect(c.service('leads').name).toBe('leads')
  })

})

// ─── _request — HTTP behaviour ────────────────────────────────────────────────

describe('_request', () => {

  it('sends GET with correct URL', async () => {
    const { restore, mock: m } = mockFetch([])
    const c = makeClient()
    await c.service('items').find()
    const call = (m as ReturnType<typeof mock>).mock.calls[0]
    expect(new URL(call[0] as string).pathname).toBe('/items')
    restore()
  })

  it('sends Authorization header when token is set', async () => {
    const { restore, mock: m } = mockFetch({})
    const c = makeClient('http://localhost:3000', 'tok-abc')
    await (c as unknown as { _request: Function })._request('GET', '/api/test')
    const headers = (m.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer tok-abc')
    restore()
  })

  it('does not send Authorization header when no token', async () => {
    const { restore, mock: m } = mockFetch({})
    const c = makeClient()
    await (c as unknown as { _request: Function })._request('GET', '/api/test')
    const headers = (m.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
    restore()
  })

  it('sends Content-Type: application/json for JSON body', async () => {
    const { restore, mock: m } = mockFetch({ id: 1 }, 201)
    const c = makeClient()
    await (c as unknown as { _request: Function })._request('POST', '/api/items', { name: 'x' })
    const headers = (m.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    restore()
  })

  it('does NOT set Content-Type for FormData body', async () => {
    const { restore, mock: m } = mockFetch({ id: 1 }, 201)
    const c = makeClient()
    const file = new File(['hello'], 'avatar.jpg', { type: 'image/jpeg' })
    await (c as unknown as { _request: Function })._request('POST', '/api/items', { name: 'x', avatar: file })
    const headers = (m.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    // Browser sets Content-Type with boundary when body is FormData
    expect(headers['Content-Type']).toBeUndefined()
    restore()
  })

  it('sends FormData when body contains a File', async () => {
    const { restore, mock: m } = mockFetch({ id: 1 }, 201)
    const c = makeClient()
    const file = new File(['bytes'], 'photo.jpg', { type: 'image/jpeg' })
    await (c as unknown as { _request: Function })._request('POST', '/api/users', { name: 'Alice', avatar: file })
    const body = (m.mock.calls[0][1] as RequestInit).body
    expect(body).toBeInstanceOf(FormData)
    restore()
  })

  it('sends JSON string when body has no File', async () => {
    const { restore, mock: m } = mockFetch({ id: 1 }, 201)
    const c = makeClient()
    await (c as unknown as { _request: Function })._request('POST', '/api/users', { name: 'Alice' })
    const body = (m.mock.calls[0][1] as RequestInit).body
    expect(typeof body).toBe('string')
    expect(JSON.parse(body as string)).toEqual({ name: 'Alice' })
    restore()
  })

  it('throws on 401 and emits unauthorized', async () => {
    const { restore } = mockFetch({ message: 'Unauthorized' }, 401)
    const c = makeClient()
    let emitted = false
    c.on('unauthorized', () => { emitted = true })
    await expect(
      (c as unknown as { _request: Function })._request('GET', '/api/secret')
    ).rejects.toMatchObject({ code: 401 })
    expect(emitted).toBe(true)
    restore()
  })

  it('throws with correct code on non-401 error', async () => {
    const { restore } = mockFetch({ message: 'Not found' }, 404)
    const c = makeClient()
    await expect(
      (c as unknown as { _request: Function })._request('GET', '/api/missing')
    ).rejects.toMatchObject({ code: 404 })
    restore()
  })

})

// ─── _hasFiles helper ─────────────────────────────────────────────────────────

describe('_hasFiles', () => {
  // Access the module-level helper via a client that uses it
  // by checking what fetch body type is sent

  it('returns false for plain object', async () => {
    const { restore, mock: m } = mockFetch({ id: 1 }, 201)
    const c = makeClient()
    await (c as unknown as { _request: Function })._request('POST', '/test', { name: 'x' })
    expect(typeof (m.mock.calls[0][1] as RequestInit).body).toBe('string')
    restore()
  })

  it('returns true when value is a File', async () => {
    const { restore, mock: m } = mockFetch({ id: 1 }, 201)
    const c = makeClient()
    const file = new File(['data'], 'f.txt')
    await (c as unknown as { _request: Function })._request('POST', '/test', { file })
    expect((m.mock.calls[0][1] as RequestInit).body).toBeInstanceOf(FormData)
    restore()
  })

  it('returns true when value is a Blob', async () => {
    const { restore, mock: m } = mockFetch({ id: 1 }, 201)
    const c = makeClient()
    const blob = new Blob(['data'], { type: 'text/plain' })
    await (c as unknown as { _request: Function })._request('POST', '/test', { blob })
    expect((m.mock.calls[0][1] as RequestInit).body).toBeInstanceOf(FormData)
    restore()
  })

  it('returns false for null', async () => {
    const { restore, mock: m } = mockFetch({})
    const c = makeClient()
    await (c as unknown as { _request: Function })._request('GET', '/test')
    // no body sent
    expect((m.mock.calls[0][1] as RequestInit).body).toBeUndefined()
    restore()
  })

})

// ─── _toFormData helper ───────────────────────────────────────────────────────

describe('_toFormData (via _request)', () => {

  it('includes non-file fields as strings in FormData', async () => {
    const { restore, mock: m } = mockFetch({ id: 1 }, 201)
    const c = makeClient()
    const file = new File(['data'], 'avatar.jpg', { type: 'image/jpeg' })
    await (c as unknown as { _request: Function })._request('POST', '/test', {
      name: 'Alice',
      avatar: file,
    })
    const fd = (m.mock.calls[0][1] as RequestInit).body as FormData
    expect(fd.get('name')).toBe('Alice')
    restore()
  })

  it('includes File with original filename in FormData', async () => {
    const { restore, mock: m } = mockFetch({ id: 1 }, 201)
    const c = makeClient()
    const file = new File(['data'], 'photo.png', { type: 'image/png' })
    await (c as unknown as { _request: Function })._request('POST', '/test', { avatar: file })
    const fd  = (m.mock.calls[0][1] as RequestInit).body as FormData
    const got = fd.get('avatar') as File
    expect(got).toBeInstanceOf(File)
    expect(got.name).toBe('photo.png')
    restore()
  })

})

// ─── ServiceProxy CRUD routing ────────────────────────────────────────────────

describe('ServiceProxy CRUD routing', () => {

  it('find() uses HTTP when WS not connected', async () => {
    const { restore, mock: m } = mockFetch({ total: 0, limit: 20, skip: 0, data: [] })
    const c = makeClient()
    // _wsReady is false by default
    await c.service('items').find()
    expect(m.mock.calls.length).toBe(1)
    expect(new URL(m.mock.calls[0][0] as string).pathname).toBe('/items')
    restore()
  })

  it('create() uses HTTP when WS not connected', async () => {
    const { restore, mock: m } = mockFetch({ id: 1 }, 201)
    const c = makeClient()
    await c.service('items').create({ name: 'x' })
    expect(m.mock.calls.length).toBe(1)
    restore()
  })

  it('create() uses HTTP when body has files even if WS connected', async () => {
    const { restore, mock: m } = mockFetch({ id: 1 }, 201)
    const c = makeClient()
    // Simulate WS connected
    ;(c as unknown as { _wsReady: boolean })._wsReady = true
    const file = new File(['data'], 'avatar.jpg')
    await c.service('users').create({ name: 'Alice', avatar: file })
    // Should have gone HTTP (fetch called), not WS
    expect(m.mock.calls.length).toBe(1)
    const body = (m.mock.calls[0][1] as RequestInit).body
    expect(body).toBeInstanceOf(FormData)
    restore()
  })

  it('patch() uses HTTP when body has files even if WS connected', async () => {
    const { restore, mock: m } = mockFetch({ id: 1 })
    const c = makeClient()
    ;(c as unknown as { _wsReady: boolean })._wsReady = true
    const file = new File(['data'], 'avatar.jpg')
    await c.service('users').patch(1, { avatar: file })
    expect(m.mock.calls.length).toBe(1)
    restore()
  })

  it('remove() uses HTTP when WS not connected', async () => {
    const { restore, mock: m } = mockFetch({ id: 1 })
    const c = makeClient()
    await c.service('items').remove(1)
    expect(m.mock.calls.length).toBe(1)
    restore()
  })

})

// ─── Store ────────────────────────────────────────────────────────────────────

describe('Store', () => {

  it('starts empty by default', () => {
    const s = new Store()
    expect(s.get()).toEqual([])
  })

  it('accepts initial data', () => {
    const s = new Store([{ id: '1', name: 'Alice' }])
    expect(s.get()).toHaveLength(1)
  })

  it('subscribe() emits current value immediately', () => {
    const s    = new Store([{ id: '1' }])
    const seen: unknown[][] = []
    s.subscribe(v => seen.push(v))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toHaveLength(1)
  })

  it('subscribe() emits on set()', () => {
    const s    = new Store<{ id: string }>()
    const seen: unknown[][] = []
    s.subscribe(v => seen.push([...v]))
    s.set([{ id: '1' }, { id: '2' }])
    expect(seen).toHaveLength(2)
    expect(seen[1]).toHaveLength(2)
  })

  it('unsubscribe stops receiving updates', () => {
    const s   = new Store<{ id: string }>()
    const seen: unknown[][] = []
    const unsub = s.subscribe(v => seen.push([...v]))
    unsub()
    s.set([{ id: '1' }])
    expect(seen).toHaveLength(1) // only the initial emit
  })

  it('upsert() adds new record', () => {
    const s = new Store<{ id: string; name: string }>()
    s.upsert({ id: '1', name: 'Alice' })
    expect(s.get()).toHaveLength(1)
    expect(s.get()[0].name).toBe('Alice')
  })

  it('upsert() updates existing record by id', () => {
    const s = new Store([{ id: '1', name: 'Alice' }])
    s.upsert({ id: '1', name: 'Alicia' })
    expect(s.get()).toHaveLength(1)
    expect(s.get()[0].name).toBe('Alicia')
  })

  it('upsert() refuses a record with no id rather than appending a phantom', () => {
    // `findIndex` on undefined matches nothing, so this used to be pushed on as
    // a new row: a heartbeat answering { ok, server_id, status } put junk in
    // every subscriber's list, silently (FJS-020).
    const s = new Store([{ id: '1', name: 'Alice' }])
    const warn = console.warn
    const said: string[] = []
    console.warn = (...a: unknown[]) => { said.push(a.join(' ')) }
    s.upsert({ ok: true, server_id: '1', status: 'online' } as never)
    console.warn = warn

    expect(s.get()).toHaveLength(1)
    expect(said[0]).toContain('cannot be matched to a row')
  })

  it('upsert() with custom idField', () => {
    const s = new Store([{ uid: 'abc', name: 'Alice' }])
    s.upsert({ uid: 'abc', name: 'Alicia' }, 'uid')
    expect(s.get()).toHaveLength(1)
    expect(s.get()[0].name).toBe('Alicia')
  })

  it('remove() removes record by id', () => {
    const s = new Store([{ id: '1' }, { id: '2' }, { id: '3' }])
    s.remove('2')
    expect(s.get().map(r => r.id)).toEqual(['1', '3'])
  })

  it('remove() is a no-op when id not found', () => {
    const s = new Store([{ id: '1' }])
    s.remove('999')
    expect(s.get()).toHaveLength(1)
  })

  it('notifies multiple subscribers', () => {
    const s    = new Store<{ id: string }>()
    const a: number[] = []
    const b: number[] = []
    s.subscribe(v => a.push(v.length))
    s.subscribe(v => b.push(v.length))
    s.set([{ id: '1' }])
    expect(a).toEqual([0, 1])
    expect(b).toEqual([0, 1])
  })

})

// ─── resource() ───────────────────────────────────────────────────────────────

// ─── find() shape normalisation ───────────────────────────────────────────────
// find() accepts three shapes and refuses a fourth. The refusal is the test
// that matters: every non-list answer used to become an empty list, so a
// service answering ONE object (a rollup, a settings blob, a health snapshot)
// gave a 200 with zero rows while the API was correct throughout — invisible
// outside a browser, and it cost two sessions before FJS-144 named it.

describe('ServiceProxy.find() — shape', () => {

  it('keeps a real list envelope whole', async () => {
    const { restore } = mockFetch({ kind: 'list', object: 'items', data: [{ id: '1' }], errors: [], total: 7 })
    const res = await makeClient().service('items').find()
    expect(res.data).toHaveLength(1)
    expect(res.total).toBe(7)
    restore()
  })

  it('wraps a bare array', async () => {
    const { restore } = mockFetch([{ id: '1' }, { id: '2' }])
    const res = await makeClient().service('items').find()
    expect(res.kind).toBe('list')
    expect(res.data).toHaveLength(2)
    restore()
  })

  it('wraps a paginated shape, keeping total and skip-as-offset', async () => {
    const { restore } = mockFetch({ total: 9, limit: 20, skip: 40, data: [{ id: '1' }] })
    const res = await makeClient().service('items').find()
    expect(res.total).toBe(9)
    expect(res.offset).toBe(40)
    restore()
  })

  it('throws on a single object rather than answering an empty list', async () => {
    const { restore } = mockFetch({ runtime: 'ok', servers: 3 })
    const err = await makeClient().service('hub').find().catch((e: Error) => e)
    expect(err).toBeInstanceOf(ResultShapeError)
    // The message has to name the service and what arrived — the whole failure
    // was that neither was anywhere to be read.
    expect((err as Error).message).toContain('hub.find()')
    expect((err as Error).message).toContain('runtime, servers')
    expect((err as ResultShapeError).received).toEqual({ runtime: 'ok', servers: 3 })
    restore()
  })

  // An empty body lands here too — _request parses one to null.
  it('throws on null — no rows and no list are different answers', async () => {
    const { restore } = mockFetch(null)
    const err = await makeClient().service('items').find().catch((e: Error) => e)
    expect(err).toBeInstanceOf(ResultShapeError)
    expect((err as Error).message).toContain('answered null')
    restore()
  })

  it('throws over WebSocket too — one rule, both transports', async () => {
    const c = makeClient() as unknown as {
      _wsReady: boolean
      _wsCall: (...a: unknown[]) => Promise<unknown>
      service(name: string): { find(): Promise<unknown> }
    }
    c._wsReady = true
    c._wsCall  = async () => ({ ok: true })
    const err = await c.service('items').find().catch((e: Error) => e)
    expect(err).toBeInstanceOf(ResultShapeError)
  })

})

describe('client.resource()', () => {

  it('returns { service, store, load }', () => {
    const c = makeClient()
    const r = c.resource('items')
    expect(r.service).toBeInstanceOf(ServiceProxy)
    expect(r.store).toBeInstanceOf(Store)
    expect(typeof r.load).toBe('function')
  })

  it('store starts empty', () => {
    const c = makeClient()
    expect(c.resource('items').store.get()).toEqual([])
  })

  it('load() populates the store from the server', async () => {
    const { restore } = mockFetch({ total: 2, limit: 20, skip: 0, data: [{ id: '1' }, { id: '2' }] })
    const c = makeClient()
    const { store, load } = c.resource('items')
    await load()
    expect(store.get()).toHaveLength(2)
    restore()
  })

  it('load() returns the data array', async () => {
    const { restore } = mockFetch({ total: 1, limit: 20, skip: 0, data: [{ id: '1', name: 'x' }] })
    const c = makeClient()
    const { load } = c.resource('items')
    const data = await load()
    expect(data).toHaveLength(1)
    expect(data[0].name).toBe('x')
    restore()
  })

  it('WS created event upserts into store', () => {
    const c = makeClient()
    const { service, store } = c.resource('items')
    store.set([{ id: '1', name: 'Alice' }])
    // Simulate a WS push event
    service._receive('created', { id: '2', name: 'Bob' })
    expect(store.get()).toHaveLength(2)
  })

  it('WS patched event updates existing record in store', () => {
    const c = makeClient()
    const { service, store } = c.resource('items')
    store.set([{ id: '1', name: 'Alice' }])
    service._receive('patched', { id: '1', name: 'Alicia' })
    expect(store.get()).toHaveLength(1)
    expect(store.get()[0].name).toBe('Alicia')
  })

  it('WS removed event removes record from store', () => {
    const c = makeClient()
    const { service, store } = c.resource('items')
    store.set([{ id: '1' }, { id: '2' }])
    service._receive('removed', { id: '1' })
    expect(store.get()).toHaveLength(1)
    expect(store.get()[0].id).toBe('2')
  })

  // ── the store is scoped to the query that filled it (FJS-011) ─────────────
  // Without `match` every event applies, which is what put a row outside the
  // filter in the list and — the one that reads as an update rather than as
  // junk — kept a row that had just left it.

  // Stands in for Sierra's schema-derived matcher: `undefined` for a query key
  // the record does not carry, so "cannot decide" is exercised too.
  const matchStatus = (record: Record<string, unknown>, query: Record<string, unknown>) =>
    !('status' in query) ? true
      : !('status' in record) ? null
      : record.status === query.status

  function loaded(rows: Array<Record<string, unknown>>, query: Record<string, unknown>) {
    const { restore } = mockFetch({ kind: 'list', object: 'items', data: rows, total: rows.length })
    const r = makeClient().resource('items', 'id', { match: matchStatus })
    return { ...r, ready: r.load(query).then(() => restore()) }
  }

  it('a created row outside the query is not added', async () => {
    const { service, store, ready } = loaded([{ id: '1', status: 'active' }], { status: 'active' })
    await ready
    service._receive('created', { id: '2', status: 'draft' })
    expect(store.get()).toEqual([{ id: '1', status: 'active' }])
  })

  it('a created row inside the query is added', async () => {
    const { service, store, ready } = loaded([{ id: '1', status: 'active' }], { status: 'active' })
    await ready
    service._receive('created', { id: '2', status: 'active' })
    expect(store.get()).toHaveLength(2)
  })

  it('a patch that moves a row out of the query removes it', async () => {
    const { service, store, ready } = loaded([{ id: '1', status: 'active' }], { status: 'active' })
    await ready
    service._receive('patched', { id: '1', status: 'archived' })
    expect(store.get()).toEqual([])
  })

  it('a custom method event leaves by the same door', async () => {
    const { service, store, ready } = loaded([{ id: '1', status: 'active' }], { status: 'active' })
    await ready
    service._receive('archived', { id: '1', status: 'archived' })
    expect(store.get()).toEqual([])
  })

  it('nothing is filtered before a load — the store has no query to mean', () => {
    const { service, store } = makeClient().resource('items', 'id', { match: matchStatus })
    service._receive('created', { id: '2', status: 'draft' })
    expect(store.get()).toHaveLength(1)
  })

  it('an undecidable record reloads instead of being guessed at', async () => {
    const { service, store, ready } = loaded([{ id: '1', status: 'active' }], { status: 'active' })
    await ready

    const { restore } = mockFetch({
      kind: 'list', object: 'items', total: 1,
      data: [{ id: '1', status: 'active' }, { id: '3', status: 'active' }],
    })
    // No `status` on the record — a projected push the matcher cannot judge.
    service._receive('patched', { id: '3', name: 'Bob' })
    expect(store.get()).toHaveLength(1)          // not applied on the strength of a guess

    await new Promise((r) => setTimeout(r, 5))
    expect(store.get()).toHaveLength(2)          // the server answered instead
    restore()
  })

  it('a burst of undecidable pushes is one reload', async () => {
    const { service, store, ready } = loaded([{ id: '1', status: 'active' }], { status: 'active' })
    await ready

    let calls = 0
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      calls++
      return new Response(
        JSON.stringify({ kind: 'list', object: 'items', data: [{ id: '1', status: 'active' }], total: 1 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }) as typeof fetch

    for (const id of ['3', '4', '5']) service._receive('patched', { id })
    await new Promise((r) => setTimeout(r, 5))

    expect(calls).toBe(1)
    expect(store.get()).toHaveLength(1)
    globalThis.fetch = original
  })

  it('with no match every event applies, as before', async () => {
    const { restore } = mockFetch({ kind: 'list', object: 'items', data: [{ id: '1', status: 'active' }], total: 1 })
    const { service, store, load } = makeClient().resource('items')
    await load({ status: 'active' })
    restore()
    service._receive('created', { id: '2', status: 'draft' })
    expect(store.get()).toHaveLength(2)
  })

  // ── `changed` — a push that names no row (FJS-307) ─────────────────────────
  // Every other event carries a record. `changed` is what the server sends for
  // a write that could not build one — a bulk statement, or a `select: false`
  // write — and it carries a count instead. The store's only honest answer is
  // the one it already gives an undecidable record: ask the server again.

  it('a changed event reloads the list', async () => {
    const { service, store, ready } = loaded([{ id: '1', status: 'active' }], { status: 'active' })
    await ready

    const { restore } = mockFetch({
      kind: 'list', object: 'items', total: 2,
      data: [{ id: '1', status: 'active' }, { id: '9', status: 'active' }],
    })
    service._receive('changed', { model: 'Item', operation: 'createMany', count: 4 })
    expect(store.get()).toHaveLength(1)          // nothing applied from a count

    await new Promise((r) => setTimeout(r, 5))
    expect(store.get()).toHaveLength(2)          // the server answered instead
    restore()
  })

  // The payload is a count, not a record. Reaching the catch-all handler would
  // upsert `{model, operation, count}` into the store as if it were a row.
  it('the count never lands in the store as a row', async () => {
    const { service, store, ready } = loaded([{ id: '1', status: 'active' }], { status: 'active' })
    await ready
    const { restore } = mockFetch({ kind: 'list', object: 'items', data: [{ id: '1', status: 'active' }], total: 1 })

    service._receive('changed', { model: 'Item', operation: 'deleteMany', count: 12 })
    await new Promise((r) => setTimeout(r, 5))

    expect(store.get()).toEqual([{ id: '1', status: 'active' }])
    restore()
  })

  // Same coalescing every other reload gets: a job doing three bulk writes is
  // one question, not three.
  it('a burst of changed events is one reload', async () => {
    const { service, store, ready } = loaded([{ id: '1', status: 'active' }], { status: 'active' })
    await ready

    let calls = 0
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      calls++
      return new Response(
        JSON.stringify({ kind: 'list', object: 'items', data: [{ id: '1', status: 'active' }], total: 1 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    for (const op of ['createMany', 'updateMany', 'deleteMany'])
      service._receive('changed', { model: 'Item', operation: op, count: 2 })
    await new Promise((r) => setTimeout(r, 5))

    expect(calls).toBe(1)
    expect(store.get()).toHaveLength(1)
    globalThis.fetch = original
  })

  // The store has no query to re-ask with, so there is nothing to reload — and
  // an invented `load({})` would fetch a list nobody asked for.
  it('a changed event before the first load does nothing', async () => {
    let calls = 0
    const original = globalThis.fetch
    globalThis.fetch = (async () => { calls++; return new Response('[]', { status: 200 }) }) as unknown as typeof fetch

    const { service, store } = makeClient().resource('items', 'id', { match: matchStatus })
    service._receive('changed', { model: 'Item', operation: 'createMany', count: 3 })
    await new Promise((r) => setTimeout(r, 5))

    expect(calls).toBe(0)
    expect(store.get()).toEqual([])
    globalThis.fetch = original
  })

  // ── load() staleness (FJS-082) ────────────────────────────────────────────
  // The store is shared; the returned rows belong to one caller. A load that
  // has been superseded may still answer its own caller and may NOT write the
  // store, whichever order the two responses arrive in.

  // Answers each request with the rows it was configured with, after the delay
  // it was configured with — the only way to make the earlier request the
  // slower one, which is the failing case.
  function mockSlowFetch(plan: Array<{ delay: number; rows: unknown[] }>) {
    const original = globalThis.fetch
    let call = 0
    globalThis.fetch = (async () => {
      const { delay, rows } = plan[call++]!
      await new Promise((r) => setTimeout(r, delay))
      return new Response(
        JSON.stringify({ kind: 'list', object: 'items', data: rows, errors: [], total: rows.length }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }) as typeof fetch
    return { restore: () => { globalThis.fetch = original } }
  }

  it('an earlier load landing last does not overwrite the newer rows', async () => {
    const { restore } = mockSlowFetch([
      { delay: 30, rows: [{ id: 'ac' }] },     // typed `ac`  — slower
      { delay: 1,  rows: [{ id: 'acme' }] },   // typed `acme` — lands first
    ])
    const { store, load } = makeClient().resource('items')
    const [stale, fresh] = await Promise.all([load({ q: 'ac' }), load({ q: 'acme' })])

    expect(store.get()).toEqual([{ id: 'acme' }])
    // Each caller still gets what it asked for — the request is not cancelled.
    expect(stale).toEqual([{ id: 'ac' }])
    expect(fresh).toEqual([{ id: 'acme' }])
    restore()
  })

  it('the newest load still writes the store when it lands last', async () => {
    const { restore } = mockSlowFetch([
      { delay: 1,  rows: [{ id: 'ac' }] },
      { delay: 30, rows: [{ id: 'acme' }] },
    ])
    const { store, load } = makeClient().resource('items')
    await Promise.all([load({ q: 'ac' }), load({ q: 'acme' })])
    expect(store.get()).toEqual([{ id: 'acme' }])
    restore()
  })

  it('stamps are per resource() call — two stores do not supersede each other', async () => {
    const { restore } = mockSlowFetch([
      { delay: 20, rows: [{ id: 'a' }] },
      { delay: 1,  rows: [{ id: 'b' }] },
    ])
    const c = makeClient()
    const one = c.resource('items')
    const two = c.resource('items')
    await Promise.all([one.load(), two.load()])
    expect(one.store.get()).toEqual([{ id: 'a' }])
    expect(two.store.get()).toEqual([{ id: 'b' }])
    restore()
  })

  it('service() returns the same proxy as resource().service', () => {
    const c = makeClient()
    const r = c.resource('items')
    expect(r.service).toBe(c.service('items'))
  })

})

// ─── EventEmitter on ServiceProxy ────────────────────────────────────────────

describe('ServiceProxy events', () => {

  it('on() registers a listener', () => {
    const c    = makeClient()
    const svc  = c.service('items')
    const seen: unknown[] = []
    svc.on('created', (d: unknown) => seen.push(d))
    svc._receive('created', { id: '1' })
    expect(seen).toHaveLength(1)
  })

  it('off() removes a listener', () => {
    const c    = makeClient()
    const svc  = c.service('items')
    const seen: unknown[] = []
    const handler = (d: unknown) => seen.push(d)
    svc.on('created', handler)
    svc.off('created', handler)
    svc._receive('created', { id: '1' })
    expect(seen).toHaveLength(0)
  })

  it('on() returns an unsubscribe function', () => {
    const c    = makeClient()
    const svc  = c.service('items')
    const seen: unknown[] = []
    const unsub = svc.on('created', (d: unknown) => seen.push(d))
    unsub()
    svc._receive('created', { id: '1' })
    expect(seen).toHaveLength(0)
  })

})

// ─── apiPrefix / authPrefix ───────────────────────────────────────────────────
// The client used to hardcode '/api' into every service path, which only ever
// matched an app that set `apiPrefix: '/api'`. Junction's server default is ''
// (registerServiceRoutes in core/app.ts), so against a default app every one of
// those requests 404'd. These pin the client to the server's default and to the
// same normalisation the server applies.

describe('apiPrefix', () => {

  const pathOf = (m: ReturnType<typeof mock>) =>
    new URL(m.mock.calls[0][0] as string).pathname

  it('defaults to no prefix — matches the server default', async () => {
    const { restore, mock: m } = mockFetch([])
    await createJunctionClient({ url: 'http://localhost:3000' }).service('items').find()
    expect(pathOf(m)).toBe('/items')
    restore()
  })

  it('applies a configured prefix to collection routes', async () => {
    const { restore, mock: m } = mockFetch([])
    await createJunctionClient({ url: 'http://localhost:3000', apiPrefix: '/api' })
      .service('items').find()
    expect(pathOf(m)).toBe('/api/items')
    restore()
  })

  it('applies a configured prefix to item routes', async () => {
    const { restore, mock: m } = mockFetch({ id: '1' })
    await createJunctionClient({ url: 'http://localhost:3000', apiPrefix: '/api/v1' })
      .service('items').get('1')
    expect(pathOf(m)).toBe('/api/v1/items/1')
    restore()
  })

  it('normalises a prefix the way the server does', async () => {
    for (const prefix of ['api', '/api', 'api/', '/api/']) {
      const { restore, mock: m } = mockFetch({ id: '1' })
      await createJunctionClient({ url: 'http://localhost:3000', apiPrefix: prefix })
        .service('items').create({ name: 'x' })
      expect(pathOf(m)).toBe('/api/items')
      restore()
    }
  })

  it('treats an empty prefix as no prefix', async () => {
    const { restore, mock: m } = mockFetch([])
    await createJunctionClient({ url: 'http://localhost:3000', apiPrefix: '/' })
      .service('items').find()
    expect(pathOf(m)).toBe('/items')
    restore()
  })

  it('prefixes remove and restore too', async () => {
    const { restore, mock: m } = mockFetch({ id: '1' })
    await createJunctionClient({ url: 'http://localhost:3000', apiPrefix: '/api' })
      .service('items').restore('1')
    expect(pathOf(m)).toBe('/api/items/1')
    restore()
  })

  it('prefixes custom methods', async () => {
    const { restore, mock: m } = mockFetch({})
    await createJunctionClient({ url: 'http://localhost:3000', apiPrefix: '/api' })
      .service('servers').invoke('reboot', 'srv_1')
    expect(pathOf(m)).toBe('/api/servers/srv_1')
    restore()
  })
})

describe('authPrefix', () => {

  const pathOf = (m: ReturnType<typeof mock>) =>
    new URL(m.mock.calls[0][0] as string).pathname

  it('auth.signIn() targets /auth/login — where @frontierjs/auth mounts it', async () => {
    const { restore, mock: m } = mockFetch({ token: 't', user: {}, workspaceId: null })
    await createJunctionClient({ url: 'http://localhost:3000' })
      .auth.signIn('a@b.c', 'x')
    expect(pathOf(m)).toBe('/auth/login')
    restore()
  })

  it('composes with apiPrefix — the plugin registers with app.post(), which applies it', async () => {
    // FJS-012: apiPrefix used to move the service routes and nothing else, so
    // an app under /api served its login at /auth. Every route an app
    // registers is now mounted under apiPrefix, auth's included, and this side
    // has to agree or the two defaults never meet.
    const { restore, mock: m } = mockFetch({ token: 't', user: {}, workspaceId: null })
    await createJunctionClient({ url: 'http://localhost:3000', apiPrefix: '/api' })
      .auth.signIn('a@b.c', 'x')
    expect(pathOf(m)).toBe('/api/auth/login')
    restore()
  })

  it('the plugin prefix stays relative to apiPrefix when both are set', async () => {
    const { restore, mock: m } = mockFetch({ token: 't', user: {}, workspaceId: null })
    await createJunctionClient({
      url: 'http://localhost:3000', apiPrefix: '/api', authPrefix: '/account',
    }).auth.signIn('a@b.c', 'x')
    expect(pathOf(m)).toBe('/api/account/login')
    restore()
  })

  it('follows the plugin prefix when the app changes it', async () => {
    const { restore, mock: m } = mockFetch({ token: 't', user: {}, workspaceId: null })
    await createJunctionClient({ url: 'http://localhost:3000', authPrefix: '/account' })
      .auth.signIn('a@b.c', 'x')
    expect(pathOf(m)).toBe('/account/login')
    restore()
  })
})

// ─── config.http.cors installs the middleware ─────────────────────────────────
// This config key was inert: typed in config/index.ts, given a documented
// default ("must be set explicitly — '*' never applied by default"), and even
// merged from junction.config.js's middleware.cors by loadConfig — but never
// read back out. Setting it produced no header and a 404 preflight, so every
// browser app had to know to call app.configure(cors({...})) by hand. In a
// browser the symptom is an opaque "TypeError: Failed to fetch".

describe('config.http.cors', () => {

  async function appWith(cors?: unknown) {
    const { createTestApp } = await import('../src/testing/index.ts')
    const { createService } = await import('../src/core/service.ts')
    return createTestApp({
      config: cors ? { http: { cors } } : {},
      services: [() => createService({ name: 'items', find: async () => [] })],
    } as never)
  }

  const hdr = async (app: never, method: 'get' | 'options', origin = 'https://app.test') => {
    const { request } = await import('../src/testing/index.ts')
    const res = await request(app as never)[method]('/items')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'GET')
    return res
  }

  it('sends Access-Control-Allow-Origin for a configured origin', async () => {
    const res = await hdr(await appWith({ origins: ['https://app.test'] }) as never, 'get')
    expect(res.headers['access-control-allow-origin']).toBe('https://app.test')
  })

  it('answers the preflight instead of 404ing it', async () => {
    const res = await hdr(await appWith({ origins: ['https://app.test'] }) as never, 'options')
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-methods']).toContain('GET')
  })

  it('honours methods/headers overrides from config', async () => {
    const app = await appWith({ origins: ['https://app.test'], methods: ['GET'], headers: ['X-Custom'] })
    const res = await hdr(app as never, 'options')
    expect(res.headers['access-control-allow-methods']).toBe('GET')
    expect(res.headers['access-control-allow-headers']).toBe('X-Custom')
  })

  it('installs nothing when cors is absent — the secure default', async () => {
    const res = await hdr(await appWith() as never, 'get')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('installs nothing for an empty origins list', async () => {
    const app = await appWith({ origins: [] })
    expect((await hdr(app as never, 'get')).headers['access-control-allow-origin']).toBeUndefined()
    expect((await hdr(app as never, 'options')).status).toBe(404)
  })

  it('does not echo an origin that is not allowed', async () => {
    const res = await hdr(await appWith({ origins: ['https://app.test'] }) as never, 'get', 'https://evil.test')
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.test')
  })
})
