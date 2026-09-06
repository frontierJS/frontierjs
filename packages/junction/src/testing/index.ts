// testing/index.ts
// First-class testing utilities for Junction apps.
//
// createTestApp()    — boots a full app with :memory: DB + stub auth
// request(app)       — chainable HTTP helper, no real server needed
// createStubAuth()   — IAuth implementation backed by a plain Map
//
// Philosophy:
//   Tests should call service methods and make HTTP assertions without
//   spinning up ports, touching the filesystem, or hitting the network.
//   All state lives in memory; each test gets a fresh app.
//
// Usage:
//   const app = await createTestApp({ services: [createUsersService] })
//
//   // Direct service call
//   const ctx = testCtx('users', 'create', { name: 'Alice', email: 'a@b.com' })
//   await callService(app.services.get('users')!, ctx)
//   expect(ctx.result.name).toBe('Alice')
//
//   // HTTP-style assertion (no real server)
//   const res = await request(app).post('/users').send({ name: 'Alice' })
//   expect(res.status).toBe(201)
//   expect((res.body as { name: string }).name).toBe('Alice')

import { createApp, type App, type AppOptions } from '../core/app.ts'
import { createInMemoryDatabase }               from '../storage/database/index.ts'
import { bridge, enterRequest, type ServiceContext }          from '../transport/bridge.ts'
import { defaultConfig, deepMerge }               from '../config/index.ts'
import type { IAuth, SessionContext }            from '../auth/types.ts'
import type { Service }                          from '../core/service.ts'
import type { HookMap }                          from '../core/hooks.ts'

// ─── Stub auth ────────────────────────────────────────────────────────────
// A minimal IAuth backed by a plain Map.
// Pre-seed users with createStubAuth({ users: [{ id:'u1', role:'admin' }] })

export interface StubUser {
  id:           string
  role?:        string
  workspaceId?: string
  accountId?:  string
  scopes?:      string[]
  // The standing `sessionGateLevel` actually reads. `role` is an app's own
  // column and the ladder does not consult it, so a stub user carrying
  // `role: 'admin'` grades 4 — a test that needs 5 says `isAdmin: true`.
  isAdmin?:       boolean
  isOwner?:       boolean
  isSystemAdmin?: boolean
  verifiedAt?:    string
  activatedAt?:   string
}

export function createStubAuth(opts: { users?: StubUser[] } = {}): IAuth & {
  addUser: (user: StubUser) => string
} {
  const users  = new Map<string, StubUser>()
  const tokens = new Map<string, string>()  // token → userId

  for (const u of (opts.users ?? [])) {
    users.set(u.id, u)
    tokens.set(`test-token-${u.id}`, u.id)
  }

  function toSession(user: StubUser, method: 'session' | 'apiKey' = 'session'): SessionContext {
    return {
      userId:      user.id,
      userType:    user.role ?? 'user',
      accountId:   user.accountId,
      workspaceId: user.workspaceId,
      role:         user.role ?? 'user',
      scopes:       user.scopes ?? [],
      authMethod:  method,
      // Only when stated: `sessionGateLevel` reads an ABSENT lifecycle field as
      // "this app does not model that stage" and only `null` grades down, so
      // defaulting these here would change every existing test's standing.
      ...(user.isAdmin       !== undefined && { isAdmin:       user.isAdmin }),
      ...(user.isOwner       !== undefined && { isOwner:       user.isOwner }),
      ...(user.isSystemAdmin !== undefined && { isSystemAdmin: user.isSystemAdmin }),
      ...(user.verifiedAt    !== undefined && { verifiedAt:    user.verifiedAt }),
      ...(user.activatedAt   !== undefined && { activatedAt:   user.activatedAt }),
    }
  }

  const auth = {
    async verifySession(token: string): Promise<SessionContext | null> {
      const userId = tokens.get(token)
      if (!userId) return null
      const user = users.get(userId)
      return user ? toSession(user) : null
    },

    async login(email: string): Promise<{ token: string; user: SessionContext }> {
      const user = [...users.values()].find(u => u.id === email)
      if (!user) throw Object.assign(new Error('Invalid credentials'), { code: 401 })
      const token = `test-token-${user.id}`
      return { token, user: toSession(user) }
    },

    async logout(): Promise<void> {},

    // `app.runAs` re-resolves a principal through this rather than replaying a
    // stored session, so nothing that defers work — a job, a webhook delivery —
    // can be driven against a stub without it. A user removed since answers
    // `null`, which is the case deferred work has to handle.
    async sessionFor(userId: string): Promise<SessionContext | null> {
      const user = users.get(String(userId))
      return user ? toSession(user) : null
    },

    async createUser(data: { email?: string; name?: string; role?: string }): Promise<SessionContext> {
      const id   = `user-${crypto.randomUUID().slice(0, 8)}`
      const user: StubUser = { id, role: data.role ?? 'user' }
      users.set(id, user)
      tokens.set(`test-token-${id}`, id)
      return toSession(user)
    },

    async deleteUser(userId: string): Promise<void> {
      users.delete(userId)
    },

    async createApiKey(userId: string): Promise<{ key: string; id: string }> {
      const key = `test-apikey-${userId}`
      tokens.set(key, userId)
      return { key, id: `key-${userId}` }
    },

    async revokeApiKey(): Promise<void> {},

    async verifyApiKey(key: string): Promise<SessionContext | null> {
      const userId = tokens.get(key)
      if (!userId) return null
      const user = users.get(userId)
      return user ? toSession(user, 'apiKey') : null
    },

    // Convenience: add a user and get back the token to use in tests
    addUser(user: StubUser): string {
      users.set(user.id, user)
      const token = `test-token-${user.id}`
      tokens.set(token, user.id)
      return token
    },
  }

  return auth
}

// ─── createTestApp ────────────────────────────────────────────────────────

export interface TestAppOptions {
  // Services to register (factories receive the app)
  services?:   Array<(app: App) => Service>

  // App-level hooks to apply
  hooks?:      HookMap

  // Override the stub auth with your own
  auth?:       IAuth

  // The principal the app's own background work runs as — see AppOptions.system.
  // Forwarded because a job dispatched by nobody resolves to it, and a test
  // that cannot declare one cannot tell that answer apart from "no principal".
  system?:     import('../auth/types.ts').SessionContext

  // Pre-seeded test users (shorthand for createStubAuth)
  users?:      StubUser[]

  // SQL to run after DB is created (seed data, extra tables)
  seed?:       string | ((db: import('bun:sqlite').Database) => void)

  // Auto-discover services from a directory
  autoload?:   string

  // Extra config overrides. Deep — `http: { helmet: false }` keeps the rest of
  // the http block, the same as createApp. It used to be a shallow spread, so
  // naming one key of a section silently dropped every other key in it.
  config?:     AppOptions['config']
}

export interface TestApp extends App {
  auth:    ReturnType<typeof createStubAuth>
  db:      Awaited<ReturnType<typeof createInMemoryDatabase>>
  // Convenience: the token for a pre-seeded user
  tokenFor: (userId: string) => string
}

export async function createTestApp(opts: TestAppOptions = {}): Promise<TestApp> {

  const auth = (opts.auth as ReturnType<typeof createStubAuth>) ??
    createStubAuth({ users: opts.users })

  const config = deepMerge(
    {
      ...defaultConfig,
      name:     'test',
      debug:    false,
      // Force :memory: so createApp opens the right database.
      // createTestApp does NOT create a second database — it uses app.db directly.
      database: { url: ':memory:', log: false },
    },
    opts.config ?? {}
  )

  const app = createApp({ config, auth, system: opts.system, autoload: opts.autoload }) as TestApp

  // app.db isn't set by createApp — Junction core doesn't know about Litestone.
  // For test ergonomics, wire an in-memory database here so tests that read
  // app.db (e.g. for seeding, direct queries) have something to use.
  const db = await createInMemoryDatabase()
  ;(app as TestApp).db = db

  // ── Seed data ──────────────────────────────────────────────────────
  if (opts.seed) {
    if (typeof opts.seed === 'string') {
      db.db.run(opts.seed)
    } else {
      opts.seed(db.db)
    }
  }

  // ── Register services ──────────────────────────────────────────────
  for (const factory of (opts.services ?? [])) {
    app.services.register(factory(app))
  }

  // ── App-level hooks ────────────────────────────────────────────────
  if (opts.hooks) app.hooks(opts.hooks)

  // ── Attach helpers ─────────────────────────────────────────────────
  // NOTE: we do NOT call _startForTest() here — tests may call
  // app.configure(middleware) after createTestApp() returns, and those
  // plugins must run before registerServiceRoutes so middleware wraps
  // the service routes correctly. _startForTest() is called lazily by
  // request() on the first call, after all configure() calls are done.
  app.auth = auth
  app.tokenFor = (userId: string) => `test-token-${userId}`

  return app
}

// ─── request() ────────────────────────────────────────────────────────────
// Chainable HTTP test helper. No real server — calls the framework's
// route handler directly via the app's HttpTransport.
//
// Usage:
//   const res = await request(app)
//     .post('/notes')
//     .auth('test-token-u1')
//     .workspace('ws-1')
//     .send({ title: 'Hello', body: 'World' })
//
//   expect(res.status).toBe(200)
//   expect((res.body as { title: string }).title).toBe('Hello')

export interface TestResponse {
  status:  number
  headers: Record<string, string>
  // Parsed JSON, or null. `unknown` because it came off the wire and nothing
  // here knows its shape — an assertion on a field states the shape it expects.
  body:    unknown
  text:    string           // raw body text
}

export interface TestRequest {
  // HTTP method shortcuts
  get:    (path: string) => TestRequest
  post:   (path: string) => TestRequest
  patch:  (path: string) => TestRequest
  put:    (path: string) => TestRequest
  delete:  (path: string) => TestRequest
  options: (path: string) => TestRequest

  // Request modifiers
  send:        (body: unknown) => TestRequest
  set:         (header: string, value: string) => TestRequest
  auth:        (token: string) => TestRequest          // sets Authorization: Bearer
  workspace:   (id: string) => TestRequest             // sets X-Workspace-Id
  query:       (params: Record<string, string>) => TestRequest

  // Execute — returns a promise resolving to the response
  then:   Promise<TestResponse>['then']
  catch:  Promise<TestResponse>['catch']
}

export function request(app: App): Pick<TestRequest, 'get' | 'post' | 'patch' | 'put' | 'delete' | 'options'> {

  function builder(method: string, path: string): TestRequest {

    let _body:    unknown = null
    const _headers: Record<string, string> = { 'content-type': 'application/json' }
    let _query:   Record<string, string> = {}

    const execute = async (): Promise<TestResponse> => {
      // Build URL with query params
      const qs = Object.keys(_query).length
        ? '?' + new URLSearchParams(_query).toString()
        : ''
      const url = `http://localhost${path}${qs}`

      // Build the Request
      const reqInit: RequestInit = {
        method:  method.toUpperCase(),
        headers: new Headers(_headers),
      }

      if (_body !== null && method !== 'GET' && method !== 'DELETE') {
        (reqInit.headers as Headers).set('content-type', 'application/json')
        reqInit.body = JSON.stringify(_body)
      }

      const req = new Request(url, reqInit)

      // Use HttpTransport.fetch() — public method that exercises the full
      // middleware → router → bridge → service pipeline without a real port.
      // _startForTest() runs plugin register(), service route registration,
      // and pipeline compilation — exactly what app.start() does, minus
      // binding a port. It is idempotent so calling it once is enough.
      if (!app.http.router.isBuilt) {
        await app._startForTest()
        app.http.router.build()
      }

      let response: Response
      try {
        response = await app.http.fetch(req)
      } catch (err: unknown) {
        response = new Response(
          JSON.stringify({ error: (err as Error).message }),
          { status: 500, headers: { 'content-type': 'application/json' } }
        )
      }

      const rawText = await response.text()
      let parsed: unknown = null
      try {
        parsed = rawText ? JSON.parse(rawText) : null
      } catch {
        parsed = null
      }

      const headers: Record<string, string> = {}
      response.headers.forEach((v, k) => { headers[k] = v })

      return {
        status:  response.status,
        headers,
        body:    parsed,
        text:    rawText,
      }
    }

    // LAZY, and this is load-bearing. It used to be
    // `Promise.resolve().then(execute)`, which schedules the request on the
    // microtask queue the moment the builder is made — so any `await` between
    // `.post(path)` and `.send(body)` let it fire first, and the call went out
    // with no body and none of the headers set after that point. Nothing said
    // so: the request succeeded, the service saw `null`, and the test asserted
    // against whatever that produced. Found signing a request in a test, where
    // computing the signature is itself an await (`FJS-350`).
    let promise: Promise<TestResponse> | null = null
    const run = () => (promise ??= execute())

    const req: TestRequest = {
      get:     (p) => builder('GET',     p),
      post:    (p) => builder('POST',    p),
      patch:   (p) => builder('PATCH',   p),
      put:     (p) => builder('PUT',     p),
      delete:  (p) => builder('DELETE',  p),
      options: (p) => builder('OPTIONS', p),

      send(body: unknown) { _body = body; return req },
      set(k: string, v: string) { _headers[k.toLowerCase()] = v; return req },
      auth(token: string) { _headers['authorization'] = `Bearer ${token}`; return req },
      workspace(id: string) { _headers['x-workspace-id'] = id; return req },
      query(params: Record<string, string>) { _query = { ..._query, ...params }; return req },

      then:  (...args) => run().then(...args),
      catch: (...args) => run().catch(...args),
    }

    return req
  }

  return {
    get:     (p) => builder('GET',     p),
    post:    (p) => builder('POST',    p),
    patch:   (p) => builder('PATCH',   p),
    put:     (p) => builder('PUT',     p),
    delete:  (p) => builder('DELETE',  p),
    options: (p) => builder('OPTIONS', p),
  }
}

// ─── testCtx ──────────────────────────────────────────────────────────────
// Build a ServiceContext for direct service testing, without HTTP.
// Shorthand for bridge.internal() with pre-populated auth + locals.

export function testCtx(
  service: string,
  method:  ServiceContext['method'],
  data?:   Record<string, unknown> | null,
  opts?: {
    user?:         Partial<SessionContext>
    workspaceId?: string
    query?:        Record<string, string>
    id?:           string | null
    locals?:       Record<string, unknown>
  }
): ServiceContext {

  const ctx = bridge.internal(service, method as 'create', data ?? null, {
    auth: opts?.user
      ? {
          user: {
            userId:     opts.user.userId ?? 'test-user',
            userType:   opts.user.userType ?? 'user',
            authMethod: opts.user.authMethod ?? 'session',
            role:        opts.user.role ?? 'admin',
            ...opts.user,
          } as SessionContext,
        }
      : undefined,
    locals: {
      ...(opts?.workspaceId ? { workspaceId: opts.workspaceId } : {}),
      ...(opts?.locals ?? {}),
    },
  })

  if (opts?.query)      ctx.query = opts.query as Record<string, unknown>
  if (opts?.id != null) ctx.id = opts.id

  return ctx
}

// Re-exported here because `testCtx` is the thing that produces the context
// `enterCall` needs: a hand-built context calls a service method directly,
// which is the one path `callService` does not cover, so a method reading `$`
// throws unless the test opens the scope itself.
export { enterCall } from '../core/context.ts'

// Run fn inside a request scope, for tests asserting on requestMeta().
// Goes through the same enterRequest() every transport does, which is the
// point: this used to build the meta itself and forward four of its six
// fields, so `user` and `client` were silently dropped and propagation
// behaved one way under test and another in production.
export function withTestMeta<T>(
  meta: Partial<import('../transport/bridge.ts').RequestMeta>,
  fn: () => T
): T {
  return enterRequest({
    origin:         meta.origin ?? 'internal',
    correlationId:  meta.correlationId ?? 'test-correlation',
    idempotencyKey: meta.idempotencyKey,
    locale:         meta.locale,
    user:           meta.user,
    client:         meta.client,
  }, fn)
}
