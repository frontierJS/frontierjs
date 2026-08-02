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

  it('prefixes custom actions', async () => {
    const { restore, mock: m } = mockFetch({})
    await createJunctionClient({ url: 'http://localhost:3000', apiPrefix: '/api' })
      .service('servers').action('reboot', 'srv_1')
    expect(pathOf(m)).toBe('/api/servers/srv_1')
    restore()
  })
})

describe('authPrefix', () => {

  const pathOf = (m: ReturnType<typeof mock>) =>
    new URL(m.mock.calls[0][0] as string).pathname

  it('authenticate() targets /auth/login — where @frontierjs/auth mounts it', async () => {
    const { restore, mock: m } = mockFetch({ token: 't', user: {}, workspaceId: null })
    await createJunctionClient({ url: 'http://localhost:3000' })
      .authenticate({ email: 'a@b.c', password: 'x' })
    expect(pathOf(m)).toBe('/auth/login')
    restore()
  })

  it('is independent of apiPrefix — the auth plugin is not moved by it', async () => {
    const { restore, mock: m } = mockFetch({ token: 't', user: {}, workspaceId: null })
    await createJunctionClient({ url: 'http://localhost:3000', apiPrefix: '/api' })
      .authenticate({ email: 'a@b.c', password: 'x' })
    expect(pathOf(m)).toBe('/auth/login')
    restore()
  })

  it('follows the plugin prefix when the app changes it', async () => {
    const { restore, mock: m } = mockFetch({ token: 't', user: {}, workspaceId: null })
    await createJunctionClient({ url: 'http://localhost:3000', authPrefix: '/account' })
      .authenticate({ email: 'a@b.c', password: 'x' })
    expect(pathOf(m)).toBe('/account/login')
    restore()
  })
})
