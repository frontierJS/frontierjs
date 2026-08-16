// framework/client/index.ts
// ─────────────────────────────────────────────────────────────────────────
// Junction Browser Client
//
// Works in the browser with no bundler — import as ESM or compile to a
// single file with `bun build framework/client/index.ts --outfile hub/ui/public/junction-client.js`
//
// Usage:
//   const client = createJunctionClient({ url: 'http://localhost:3001' })
//   await client.auth.signIn('admin@acme.com', 'secret')
//
//   const servers = client.service('servers')
//   const list    = await servers.find({ query: { status: 'online' } })
//   await servers.patch('srv_1', { role: 'build' })
//
//   servers.on('created', s => console.log('new server', s))
//   servers.on('patched', s => updateRow(s))
//
// ─────────────────────────────────────────────────────────────────────────

// Two imports, and both are here for one reason: what the server means is
// shared with it rather than re-described here, and both modules are pure and
// dependency-free, so they bundle into the browser build without pulling
// anything else in. The envelope is the shape the server sends — re-describing
// it is precisely how the two ends drifted before. `orderBy` is the same story
// one field along: the client places a pushed row in a list it cannot re-query,
// so it must read the caller's `-createdAt` the way the server compiles it.
import { isListResult, wrapResult, ResultShapeError, type ListResult, type ServiceResult } from '../core/envelope.ts'
import type { QueryDirectives } from '../core/directives.ts'
import { comparatorFor } from '../core/sort.ts'
export type { ListResult, ServiceResult }
export { ResultShapeError }

// ─── Types ────────────────────────────────────────────────────────────────

export interface JunctionClientOptions {
  url?: string // base URL, default = window.location.origin
  token?: string // pre-set token (e.g. from localStorage)
  workspaceId?: string // pre-set workspace
  timeout?: number // request timeout ms, default 30_000
  reconnectDelay?: number // initial WS reconnect delay ms, default 1_000
  reconnectMax?: number // max reconnect delay ms, default 30_000
  // URL prefix for service routes. MUST match the server's `apiPrefix` config.
  // Default '' — the server default, which registers services at /{service}.
  // Set to '/api' or '/api/v1' only when the app sets apiPrefix to the same.
  apiPrefix?: string
  // The auth plugin's own prefix, default '/auth' — RELATIVE to apiPrefix, the
  // same way the plugin's `prefix` option is, because every route an app
  // registers is mounted under apiPrefix. Match the plugin's option and leave
  // apiPrefix to say where the app lives.
  authPrefix?: string
  // Where the session token is kept between page loads. Absent = nowhere, and
  // the token lives for the life of the object.
  //
  // This is here rather than in the UI layer because the token has one owner:
  // Sierra used to write localStorage in its own login() while the client held
  // the token in memory, so signing in through the client left storage empty
  // and writing storage by hand left the socket unauthenticated. Both halves
  // now hang off setToken().
  tokenStorage?: TokenStore
  // The names the auth plugin registered its three services under. Only needed
  // when the server renamed them — see AuthPluginOptions.services.
  authServices?: AuthServiceNames
}

/**
 * Somewhere to keep the session token between page loads.
 *
 * `clear()` rather than `set(null)`: a store backed by a cookie or a keychain
 * deletes differently from how it writes, and every implementation of this has
 * had to say so.
 */
export interface TokenStore {
  get():   string | null
  set(token: string): void
  clear(): void
}

/** localStorage, guarded — a server render and a locked-down browser both answer null. */
export function localTokenStore(key: string = 'junction_token'): TokenStore {
  const ls = () => (typeof localStorage !== 'undefined' ? localStorage : null)
  return {
    get()      { try { return ls()?.getItem(key) ?? null } catch { return null } },
    set(token) { try { ls()?.setItem(key, token) } catch {} },
    clear()    { try { ls()?.removeItem(key) } catch {} },
  }
}

/** What the auth plugin's three services are called. Defaults match its own. */
export interface AuthServiceNames {
  account?:  string
  sessions?: string
  apiKeys?:  string
}

/**
 * How to SHAPE the answer — never which records. The second argument to every
 * read on this client, and the same fields `ctx.directives` carries on the
 * server, from the same declaration (`core/directives.ts`).
 *
 * It used to be a `QueryDirectives` that also held `query`, which made the container
 * both halves of a split the rest of the framework keeps apart (Invariant 10) —
 * and it declared five of them, so `$search`, `$withDeleted` and
 * `$onlyDeleted` had a server that read them, a URL grammar that carried them
 * and no way for a caller here to ask (`FJS-290`). A `.lite` declaring
 * `@@softDelete` gave an app a restore flow it could not build a list screen
 * for.
 *
 *   servers.find({ status: 'online' }, { limit: 20, orderBy: '-name' })
 *   servers.find({}, { onlyDeleted: true })          // the restore screen
 *   servers.find({}, { onlyTemplates: true })        // the template screen
 *   servers.find({}, { search: 'acme' })             // FTS5
 *
 * Filters are the FIRST argument. Always.
 */
export type { QueryDirectives } from '../core/directives.ts'

/**
 * @deprecated Use `ListResult<T>` — the actual shape find() returns.
 *
 * This described the server's list envelope but omitted `kind`, `object` and
 * `errors`, and no method ever returned it: find() unwrapped to `T[]` and threw
 * the metadata away. It was a type describing a value that did not exist.
 */
export type PaginatedResult<T = unknown> = ListResult<T>


export type ServiceEvent = 'created' | 'patched' | 'removed' | 'find' | 'get' | string

// ─── EventEmitter ─────────────────────────────────────────────────────────

class EventEmitter {
  private _handlers: Map<string, Set<Function>> = new Map()

  on(event: string, handler: Function): () => void {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set())
    this._handlers.get(event)!.add(handler)
    return () => this.off(event, handler)
  }

  off(event: string, handler: Function): void {
    this._handlers.get(event)?.delete(handler)
  }

  once(event: string, handler: Function): () => void {
    const wrapper = (...args: unknown[]) => {
      handler(...args)
      this.off(event, wrapper)
    }
    return this.on(event, wrapper)
  }

  emit(event: string, ...args: unknown[]): void {
    this._handlers.get(event)?.forEach((h) => {
      try { h(...args) } catch {}
    })
    // Synthetic 'connection' event — fires on any connection state change
    if (event === 'connect' || event === 'disconnect' || event === 'reconnecting') {
      this._handlers.get('connection')?.forEach((h) => {
        try { h(event, ...args) } catch {}
      })
    }
    // Wildcard '*' listeners
    if (event !== '*') {
      this._handlers.get('*')?.forEach((h) => {
        try { h(event, ...args) } catch {}
      })
    }
  }

  removeAllListeners(event?: string): void {
    if (event) this._handlers.delete(event)
    else this._handlers.clear()
  }
}

// ─── ServiceProxy ─────────────────────────────────────────────────────────
// Generic T = the model type. Defaults to Record<string,unknown> for JS users.
// Usage: client.service<Lead>('leads')

export class ServiceProxy<
  T extends Record<string, unknown> = Record<string, unknown>
> extends EventEmitter {
  readonly name: string
  private _client: JunctionClient

  constructor(name: string, client: JunctionClient) {
    super()
    this.name = name
    this._client = client
  }

  /**
   * Collection path for this service.
   *
   * Every route below used to hardcode an `/api` prefix, which matches the
   * server only when the app sets `apiPrefix: '/api'`. Junction's default is ''
   * (see registerServiceRoutes in core/app.ts) — so against a default app every
   * one of these requests 404'd. The prefix is now the client's, supplied once
   * at construction and normalised the same way the server normalises its own.
   */
  private get _base(): string {
    return `${this._client._apiPrefix}/${this.name}`
  }

  // ── CRUD ────────────────────────────────────────────────────────────
  // Prefer WS when connected. Files always use HTTP.

  /**
   * find(query?, params?) → the LIST ENVELOPE, not a bare array.
   *
   *   const res = await client.service('posts').find()
   *   res.data      // the rows
   *   res.total     // ← was unreachable: this used to return res.data and
   *                 //   throw away total/limit/offset, so no browser caller
   *                 //   could build a paginated table. PaginatedResult was
   *                 //   declared in this file and used by nothing.
   *
   * Matches HTTP and app.service() exactly: a list keeps its envelope, a
   * single unwraps to the record.
   *
   * Throws `ResultShapeError` if the server answered anything that is not a list.
   */
  async find(query?: Record<string, unknown>, directives?: QueryDirectives): Promise<ListResult<T>> {
    // Normalise whatever arrived into one shape, so callers see one shape:
    // an envelope passes through, and everything else goes to the SAME
    // wrapResult the service layer uses, asked as `find`. This used to be a
    // hand-copy of that rule — array, then { total, data }, then an invented
    // empty list for anything else — which is how "no rows" and "not a list at
    // all" became one answer (FJS-144) and how a list carrying a summary lost
    // it at both ends rather than one (FJS-140). One rule, one function, both
    // sides of the wire; wrapResult throws ResultShapeError for the rest.
    const asEnvelope = (res: unknown): ListResult<T> =>
      isListResult<T>(res) ? res : wrapResult(res, this.name, 'find') as ListResult<T>

    if (this._client._wsReady) {
      // Filters AND directives, flattened into one bag on ctx.query — the same
      // shape the HTTP query string produces, because the bridge splits both
      // the same way. Previously only the raw filter object was sent (as the
      // DATA field, not the query), so pagination, ordering and select were
      // silently dropped over WebSocket.
      return asEnvelope(await this._client._wsCall(
        this.name, 'find', null, null, buildWsQuery(query, directives)
      ))
    }

    const qs = buildQueryString(query, directives)
    return asEnvelope(await this._client._request('GET', `${this._base}${qs}`))
  }

  /** find() but just the rows — for callers that don't need total/limit/offset. */
  async findData(query?: Record<string, unknown>, directives?: QueryDirectives): Promise<T[]> {
    return (await this.find(query, directives)).data
  }

  // get(id, params?) → T   /   get(query, params?) → T (findFirst via $first)
  async get(
    idOrQuery: string | number | Record<string, unknown>,
    params?: QueryDirectives,
    /**
     * Already-`$`-spelled wire parameters, forwarded verbatim.
     *
     * One caller: the WebSocket→HTTP fallback, whose frame carries directives
     * in wire spelling because that is how they arrived. Parsing them back into
     * a QueryDirectives so this method could re-emit them would be a second
     * translation of the `$` convention on the client, where the whole point of
     * `@frontierjs/toolbelt/directives` is that there is one per boundary.
     */
    _wire?: Record<string, unknown>
  ): Promise<T> {
    if (typeof idOrQuery === 'object') {
      // findFirst — pass $first=true
      const qs = buildQueryString(idOrQuery, params, { $first: 'true' })
      return this._client._request('GET', `${this._base}${qs}`) as Promise<T>
    }
    // params travels on a by-id get too. It used to be accepted and dropped on
    // both transports, so `get(id, { populate: 'customer' })` — the shape a
    // detail page wants most — silently answered the bare row.
    if (this._client._wsReady) {
      return this._client._wsCall(
        this.name, 'get', idOrQuery, null, params ? buildWsQuery(null, params) : undefined
      ) as Promise<T>
    }
    const qs = (params || _wire) ? buildQueryString(_wire, params) : ''
    return this._client._request('GET', `${this._base}/${idOrQuery}${qs}`) as Promise<T>
  }

  // create(data, params?) → T
  async create(data: Partial<T> & Record<string, unknown>, params?: QueryDirectives): Promise<T> {
    if (this._client._wsReady && !_hasFiles(data)) {
      return this._client._wsCall(this.name, 'create', null, data) as Promise<T>
    }
    return this._client._request('POST', this._base, data) as Promise<T>
  }

  // patch(id, data, params?)    → T
  // patch(query, data, params?)  → ListResult<T>, `errors` per rejected row
  //
  // A filtered patch is a BULK write and answers the bulk envelope — the rows
  // it wrote in `data`, and one `{ data, error }` per row it could not, because
  // it writes them individually so that `@@transitions` and `@version` apply.
  // These overloads used to promise `T[]` against a server that answered
  // `{ count }`, so the declared type described a shape nothing ever sent.
  async patch(
    id: string | number,
    data: Partial<T> & Record<string, unknown>,
    params?: QueryDirectives
  ): Promise<T>
  async patch(
    query: Record<string, unknown>,
    data: Partial<T> & Record<string, unknown>,
    params?: QueryDirectives
  ): Promise<ListResult<T>>
  async patch(
    idOrQuery: string | number | Record<string, unknown>,
    data: Partial<T> & Record<string, unknown>,
    params?: QueryDirectives
  ): Promise<T | ListResult<T>> {
    if (typeof idOrQuery === 'object') {
      const qs = buildQueryString(idOrQuery, params)
      return this._client._request('PATCH', `${this._base}${qs}`, data) as Promise<ListResult<T>>
    }
    if (this._client._wsReady && !_hasFiles(data)) {
      return this._client._wsCall(this.name, 'patch', idOrQuery, data) as Promise<T>
    }
    return this._client._request(
      'PATCH',
      `${this._base}/${idOrQuery}`,
      data
    ) as Promise<T>
  }

  // remove(id, params?)    → T
  // remove(query, params?)  → ListResult<T>, the removed ROWS
  //
  // Rows, not ids: a filtered remove deletes one row at a time and each one
  // answers itself, so a subscriber has the record it lost rather than a key to
  // go and look one up that is no longer there.
  async remove(id: string | number, params?: QueryDirectives): Promise<T>
  async remove(query: Record<string, unknown>, params?: QueryDirectives): Promise<ListResult<T>>
  async remove(
    idOrQuery: string | number | Record<string, unknown>,
    params?: QueryDirectives
  ): Promise<T | ListResult<T>> {
    if (typeof idOrQuery === 'object') {
      const qs = buildQueryString(idOrQuery, params)
      return this._client._request('DELETE', `${this._base}${qs}`) as Promise<ListResult<T>>
    }
    if (this._client._wsReady) {
      return this._client._wsCall(this.name, 'remove', idOrQuery, null) as Promise<T>
    }
    return this._client._request('DELETE', `${this._base}/${idOrQuery}`) as Promise<T>
  }

  // restore(id, params?) → T
  // restore(query, params?) → T[]
  async restore(id: string | number, params?: QueryDirectives): Promise<T>
  async restore(query: Record<string, unknown>, params?: QueryDirectives): Promise<T[]>
  async restore(
    idOrQuery: string | number | Record<string, unknown>,
    params?: QueryDirectives
  ): Promise<T | T[]> {
    if (typeof idOrQuery === 'object') {
      const qs = buildQueryString(idOrQuery, params)
      return this._client._request('PUT', `${this._base}${qs}`, undefined, {
        header: { 'x-service-method': 'restore' }
      }) as Promise<T[]>
    }
    // Prefer the socket, like find/get/create/patch/remove. This was the one
    // CRUD method that always used HTTP, contradicting the documented rule —
    // "CRUD methods prefer WebSocket when connected, fall back to HTTP
    // automatically" (README). The bulk form above stays HTTP: a query-shaped
    // restore travels in the URL.
    if (this._client._wsReady) {
      return this._client._wsCall(this.name, 'restore', idOrQuery, null) as Promise<T>
    }
    return this._client._request('PUT', `${this._base}/${idOrQuery}`, undefined, {
      header: { 'x-service-method': 'restore' }
    }) as Promise<T>
  }

  // upsert — client-side convenience: data.id != null → patch, else → create
  async upsert(data: Partial<T> & Record<string, unknown>, params?: QueryDirectives): Promise<T> {
    if (data.id != null) {
      return this.patch(data.id as string | number, data, params) as Promise<T>
    }
    return this.create(data as T & Record<string, unknown>, params)
  }

  // ── Custom methods ──────────────────────────────────────────────────
  // Same transport rule as CRUD: the socket when one is connected, HTTP when it
  // is not. Over WS that is a service_call frame naming the method (no URL
  // involved); over HTTP it is POST /{id} with an X-Service-Method header,
  // which keeps the URL space flat.
  //
  // Named for what it does rather than for a category: a service has methods,
  // and this calls one the client has no typed shortcut for.

  async invoke(
    name: string,
    id?: string | number | null,
    data?: Record<string, unknown> | null,
    query?: Record<string, unknown>
  ): Promise<unknown> {
    // Same rule as CRUD: the socket when it is there, HTTP when it is not.
    // This used to be unconditionally HTTP, which made a custom method the only
    // service call that ignored a live connection — and the WS path dispatches
    // any method name generically, so there was never a reason for it.
    //
    // Files are the documented exception: multipart cannot travel over the
    // socket, so a payload carrying one goes over HTTP exactly as create and
    // patch do.
    if (this._client._wsReady && !_hasFiles(data ?? {})) {
      return this._client._wsCall(this.name, name, id ?? null, data ?? null, query)
    }
    // A COLLECTION-level call — `id` omitted or null — posts to the service
    // root. The server has always supported it: the bridge dispatches on the
    // X-Service-Method header before it looks at `params.id`, so a method that
    // is about the whole collection needs no id and never did. This client
    // interpolated `id` unconditionally, so the only way to reach one was to
    // invent a throwaway id and post to `/{service}/null` — found writing
    // basecamp's fleet-wide event feed, where there IS no subject row.
    const path = id == null ? this._base : `${this._base}/${id}`
    // A plain filter map, NOT QueryDirectives — so it is serialised plainly rather
    // than through buildQueryString, which exists to turn {limit, orderBy, …}
    // into the `$`-prefixed directive syntax. A custom method declares its own query
    // vocabulary; the bridge still splits `$` keys off as directives if the
    // caller uses them.
    return this._client._request(
      'POST',
      `${path}${_plainQuery(query)}`,
      data ?? {},
      { header: { 'X-Service-Method': name } }
    )
  }

  // ── Explicit WS call ─────────────────────────────────────────────────

  call(
    method: string,
    id?: string | number | null,
    data?: Record<string, unknown> | null
  ): Promise<unknown> {
    return this._client._wsCall(this.name, method, id ?? null, data ?? null)
  }

  // ── Internal: receive push events from WS ────────────────────────────

  _receive(method: string, data: unknown): void {
    this.emit(method, data)
  }
}

// ─── AuthClient — client.auth ───────────────────────────────────────────────
//
// The browser half of `@frontierjs/auth`, and the reason it lives here rather
// than there: this is the client that holds the token, opens the socket and
// knows both prefixes, and an app that wrote its own sign-in against `fetch`
// had to reproduce all three. Both dogfood apps did, differently, and neither
// ever called POST /auth/logout — so a sign-out dropped the token locally and
// left the session row alive until it expired.
//
// The split it speaks is the server's own (DECISIONS.md § API design):
// establishing a session is a ROUTE under /auth, everything the caller does to
// their own credentials afterwards is a SERVICE. Both halves are here because
// to the person signing in that is one subject.

export class AuthClient {
  constructor(
    private _c:      JunctionClient,
    private _prefix: string,
    private _names:  Required<AuthServiceNames>
  ) {}

  // ── Establishing a session — the routes ────────────────────────────

  /** Sign in. Stores the token, opens the socket, emits 'authenticated'. */
  async signIn(email: string, password: string): Promise<AuthResult> {
    return this._adopt(
      await this._c._request('POST', `${this._prefix}/login`, { email, password }, { skipAuth: true })
    )
  }

  /** Register and sign in — the plugin's /register does both in one call. */
  async signUp(data: { email: string; password: string; name?: string }): Promise<AuthResult> {
    return this._adopt(
      await this._c._request('POST', `${this._prefix}/register`, data, { skipAuth: true })
    )
  }

  /**
   * Sign out — at the server first, then here.
   *
   * The server call is what actually ends the session: dropping the token
   * locally leaves the row valid until it expires, so a token that leaked is
   * still a session. A failure to reach the server does NOT keep the caller
   * signed in — the local half runs regardless, and the error is reported on
   * the returned object rather than thrown, because the thing the person
   * asked for (be signed out here) did happen.
   */
  async signOut(): Promise<{ revoked: boolean; error?: Error }> {
    let error: Error | undefined
    if (this._c.token) {
      try {
        await this._c._request('POST', `${this._prefix}/logout`, {})
      } catch (err) {
        error = err as Error
      }
    }
    this._c.setToken(null)
    this._c.emit('logout')
    return error ? { revoked: false, error } : { revoked: true }
  }

  // ── Recovery — routes, because none of them can hold a session ──────

  async requestPasswordReset(email: string): Promise<void> {
    await this._c._request('POST', `${this._prefix}/password-reset/request`, { email }, { skipAuth: true })
  }

  async confirmPasswordReset(token: string, password: string): Promise<void> {
    await this._c._request('POST', `${this._prefix}/password-reset/confirm`, { token, password }, { skipAuth: true })
  }

  /** Send the verification mail again. Needs a session — it is the caller's own address. */
  async requestEmailVerification(): Promise<void> {
    await this._c._request('POST', `${this._prefix}/email/verify/request`, {})
  }

  /** Confirm an address from the link. No session: the link is the proof. */
  async verifyEmail(token: string): Promise<unknown> {
    return this._c._request('GET', `${this._prefix}/email/verify?token=${encodeURIComponent(token)}`, undefined, { skipAuth: true })
  }

  // ── The caller's own account — services ────────────────────────────

  /** Who this token is. Answers the SessionContext the server built, not a User row. */
  async me(): Promise<Record<string, unknown>> {
    return this._c.service(this._names.account).get('me') as Promise<Record<string, unknown>>
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await this._c.service(this._names.account).invoke('changePassword', 'me', { currentPassword, newPassword })
  }

  /** Every live session of this caller's, the one making the request marked `current`. */
  async sessions(): Promise<AuthSessionInfo[]> {
    const list = await this._c.service(this._names.sessions).find()
    return (list.data ?? []) as unknown as AuthSessionInfo[]
  }

  async revokeSession(id: string): Promise<void> {
    await this._c.service(this._names.sessions).remove(id)
  }

  /** Sign out everywhere else, keeping this one. */
  async revokeOtherSessions(): Promise<{ revoked: number }> {
    return this._c.service(this._names.sessions).invoke('revokeOthers') as Promise<{ revoked: number }>
  }

  async apiKeys(): Promise<ApiKeyInfo[]> {
    const list = await this._c.service(this._names.apiKeys).find()
    return (list.data ?? []) as unknown as ApiKeyInfo[]
  }

  /** The raw key comes back ONCE, here. Nothing can read it afterwards. */
  async createApiKey(opts: { name?: string; scopes?: string[]; expiresAt?: string | Date } = {}): Promise<{ id: string; key: string }> {
    return this._c.service(this._names.apiKeys).create(opts as Record<string, unknown>) as Promise<{ id: string; key: string }>
  }

  async revokeApiKey(id: string): Promise<void> {
    await this._c.service(this._names.apiKeys).remove(id)
  }

  // ── Internal ───────────────────────────────────────────────────────

  private _adopt(raw: unknown): AuthResult {
    const r = raw as AuthResult
    // cookieAuth mode answers no token — the browser holds an httpOnly cookie
    // it cannot read, and setToken(null) would close a socket that is
    // authenticated by that cookie at upgrade.
    if (r?.token) this._c.setToken(r.token)
    if (r?.workspaceId && !this._c.workspaceId) this._c.workspaceId = r.workspaceId
    this._c.emit('authenticated', r)
    return r
  }
}

export interface AuthResult {
  token?:       string
  user:         Record<string, unknown>
  workspaceId?: string | null
}

// Re-declared rather than imported from ../auth/types.ts: this file is the
// BROWSER bundle and that module is the server's IAuth contract, which pulls
// in ServiceContext and the transport types behind it. The two shapes are
// pinned against each other in tests/client-auth.test.ts.
export interface AuthSessionInfo {
  id:         string
  createdAt?: string | null
  expiresAt?: string | null
  current:    boolean
}

export interface ApiKeyInfo {
  id:         string
  name:       string | null
  scopes:     string[]
  createdAt?: string | null
  expiresAt?: string | null
}

// ─── JunctionClient ─────────────────────────────────────────────────────────

export class JunctionClient extends EventEmitter {
  // Public state
  token: string | null = null
  workspaceId: string | null = null
  connected: boolean = false

  private _url: string
  private _timeout: number
  private _reconnectDelay: number
  private _reconnectMax: number
  // Read by ServiceProxy._base. Normalised at construction, never re-derived.
  _apiPrefix: string
  private _authPrefix: string
  private _tokens: TokenStore | null
  private _auth: AuthClient | null = null
  private _authNames: Required<AuthServiceNames>

  private _services: Map<string, ServiceProxy<Record<string, unknown>>> = new Map()
  private _ws: WebSocket | null = null
  _wsReady: boolean = false
  private _wsCallMap: Map<string, { resolve: Function; reject: Function }> = new Map()
  private _wsCallSeq: number = 0
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _reconnectAttempts: number = 0
  private _intentionalClose: boolean = false

  constructor(opts: JunctionClientOptions = {}) {
    super()
    const raw = (
      opts.url ??
      (typeof location !== 'undefined' ? location.origin : 'http://localhost:3001')
    ).replace(/\/$/, '')
    // Normalize to http(s):// so HTTP requests always work.
    // Callers may pass ws:// or wss:// — convert those too.
    this._url = raw.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://')
    this._timeout = opts.timeout ?? 30_000
    this._reconnectDelay = opts.reconnectDelay ?? 1_000
    this._reconnectMax = opts.reconnectMax ?? 30_000
    this._apiPrefix = _normalizePrefix(opts.apiPrefix, '')
    // Auth routes are registered with app.post(), which applies apiPrefix like
    // every other route — so the two prefixes compose here rather than the auth
    // one standing alone (FJS-012).
    this._authPrefix = this._apiPrefix + _normalizePrefix(opts.authPrefix, '/auth')
    this._tokens = opts.tokenStorage ?? null
    this._authNames = {
      account:  opts.authServices?.account  ?? 'account',
      sessions: opts.authServices?.sessions ?? 'sessions',
      apiKeys:  opts.authServices?.apiKeys  ?? 'api-keys',
    }
    // A stated token wins over a stored one: a caller passing `token` is saying
    // who this client is, and reading storage over the top would answer with
    // whoever used this browser last.
    this.token = opts.token ?? this._tokens?.get() ?? null
    this.workspaceId = opts.workspaceId ?? null
  }

  // ── Auth ────────────────────────────────────────────────────────────
  //
  // Everything sign-in shaped is on `client.auth` — see AuthClient above.
  // Lazy, so a client that never authenticates never builds one.

  get auth(): AuthClient {
    if (!this._auth) this._auth = new AuthClient(this, this._authPrefix, this._authNames)
    return this._auth
  }

  setToken(token: string | null): void {
    const changed = token !== this.token
    this.token = token
    // Persisted here rather than at the call sites, because there are four of
    // them (sign in, sign up, an app restoring by hand, a 401 clearing) and a
    // stored token that outlives the client's is a session the socket cannot
    // open and the next boot trusts.
    if (this._tokens) token ? this._tokens.set(token) : this._tokens.clear()
    if (!changed) return
    // Who this client is has changed. Anything cached as the previous caller
    // — Sierra's prefetch, an app's own store — is now somebody else's data.
    this.emit('token', token)
    if (this._ws && this._ws.readyState < 2) {
      // Cycle existing socket so upgrade carries the new token
      this._disconnect()
      this._openWs()
    } else if (token) {
      // No socket open yet — open one now (e.g. first login with no stored token)
      this._openWs()
    }
  }

  setWorkspace(id: string): void {
    this.workspaceId = id
    this.emit('workspace', id)
  }

  // ── Service proxy ────────────────────────────────────────────────────

  service<T extends Record<string, unknown> = Record<string, unknown>>(
    name: string
  ): ServiceProxy<T> {
    if (!this._services.has(name)) {
      this._services.set(name, new ServiceProxy<Record<string, unknown>>(name, this))
    }
    return this._services.get(name) as ServiceProxy<T>
  }

  // ── Resource ─────────────────────────────────────────────────────────
  // Convenience wrapper that returns a service proxy, a reactive Store,
  // and a load() function together. The store wires up to real-time WS
  // events automatically — created → upsert, patched → upsert, removed → remove.
  //
  // The store is scoped to the query its last load() ran with: given a `match`
  // (see ResourceOptions) a record outside that query is not added, and one that
  // has just left it is removed. Without a match every event applies, which is
  // the old behaviour and still what a caller passing nothing gets.
  //
  // Usage:
  //   const { service, store, load } = client.resource('leads')
  //   await load()                          // populate from server
  //   store.subscribe(leads => render(leads))
  //   await service.create({ name: 'Acme' }) // store updates via WS

  resource<T extends Record<string, unknown> = Record<string, unknown>>(
    name: string,
    idField: string = 'id',
    opts: ResourceOptions<T> = {}
  ): ResourceResult<T> {
    const svc = this.service<T>(name)
    const store = new Store<T>()

    // Open the socket. Everything below wires push events into the store, and
    // none of it fires unless the socket exists — resource() promised "the
    // store wires up to real-time WS events automatically" while leaving
    // connect() to the caller, and the usage example above never calls it. The
    // result was a store that populated once via load() and then went stale
    // in silence, with no error to notice.
    //
    // connect() is idempotent (returns early if the socket is open or opening),
    // so calling resource() for several services opens exactly one socket.
    this.connect()

    // Wire WS push events → store mutations.
    // A push carries the record (events are about one row), but normalise
    // anyway so a server that sends an envelope still works. The old version
    // took `.data` off ANY object that had it — including a record with a
    // column named `data`, which it would silently replace with that column.
    const unwrap = (raw: unknown): T =>
      (isListResult(raw) || (raw as ServiceResult)?.kind === 'single')
        ? (raw as ServiceResult<T>).data
        : raw as T

    // ── The query the store means ──────────────────────────────────────────
    // A push is an announcement about a ROW; the store is the answer to a
    // QUERY. Applying every event to it unconditionally is what put a draft in
    // a list loaded `{ status: 'active' }`, and — worse, because it looks like
    // an update — left a row that had just been patched OUT of the filter
    // sitting in the list with its new values (`FJS-011`).
    //
    // `match` decides; without one nothing has changed. It answers `null` for a
    // record it cannot judge — a `select` dropped the filtered column, the
    // filter names a relation — and the only honest response to that is to ask
    // the server the same question again.
    //
    // Set with the rows rather than when the load is issued, so the store's
    // contents and the query they answer move together: a superseded load must
    // not leave its query behind any more than it leaves its rows.
    let lastQuery: Record<string, unknown> | null = null
    let lastParams: QueryDirectives = {}

    const verdict = (record: T): boolean | null => {
      if (!opts.match || lastQuery === null) return true
      try {
        return opts.match(record, lastQuery, lastParams)
      } catch {
        return null
      }
    }

    // One refetch per burst — each answers the whole list, so N events landing
    // together are one question, not N.
    let refetchQueued = false
    const refetch = (): void => {
      if (refetchQueued || lastQuery === null) return
      refetchQueued = true
      setTimeout(() => {
        refetchQueued = false
        void load(lastQuery ?? {}, lastParams).catch(() => {})
      }, 0)
    }

    // ── Where in the list, and whether this list can say ────────────────────
    // Membership is only half the question (`FJS-011`); a row also has a
    // POSITION, and appending ignored it — a list loaded `orderBy: '-createdAt'`
    // received new rows at the bottom, and one loaded `limit: 20` grew past 20
    // (`FJS-270`). The row was genuinely in the query; it was in the wrong place
    // in it, which is the same silent-wrong-data class one step along.
    //
    // Sorting is answerable here: `orderBy` is the caller's own, and
    // `core/sort.ts` reads it the way the server does. **Paging is not.**
    // Nothing in a browser can know whether a new row belongs on page 3 without
    // asking, so a list past the first page does not guess: the row is refused
    // and `stale` counts it, for a view to render as *3 new — refresh*. A list
    // that is quietly wrong past the fold is the outcome this exists to avoid.
    //
    // Read off the ENVELOPE rather than the params, because the effective limit
    // is the server's — a caller that named none still got one.
    let limit:  number | null = null
    let offset = 0
    let total:  number | null = null

    const stale = new Stale()

    const orderOf = (): ((a: T, b: T) => number) | null =>
      comparatorFor(lastParams.orderBy as Parameters<typeof comparatorFor>[0]) as ((a: T, b: T) => number) | null

    // `total` is the query's row count as of the last load, kept in step with
    // the store so `hasMore()` keeps meaning what it meant then. Two of the
    // adjustments are exact — a row that left the query, a row that entered it
    // — and one is not: a row arriving into page 1 may be new to the query or
    // may have moved up from page 2, and nothing here can tell. It counts as
    // new, which errs towards reporting a gap that is not there rather than
    // hiding one that is. An offered refresh is cheap; a list that looks
    // complete and is not is the whole defect.
    const hasMore = (): boolean =>
      total !== null && total > offset + store.get().length

    const insert = (record: T): void => {
      if (total !== null) total++

      // Not the first page: this row may belong before it, and putting it here
      // would push a row off the end that belongs here.
      if (offset > 0) return stale.bump()

      const cmp = orderOf()
      if (!cmp) {
        // No order to place it by. Appending is what this did before there was
        // a comparator and is still the only defensible move — but the list can
        // now be longer than the page it claims to be, so say so rather than
        // trimming a row chosen at random. Dropping the row the user just
        // created, to honour a page size, is the worse of the two.
        store.upsert(record, idField)
        if (limit !== null && store.get().length > limit) stale.bump()
        return
      }

      // Sorted insertion, and the overflow row genuinely moved to the next
      // page — page 1 of an ordered list IS its first `limit` rows.
      store.place(record, idField, cmp, limit ?? undefined)
    }

    const drop = (record: T | null, id: unknown): void => {
      const had = store.get().length
      store.remove(id, idField)

      if (store.get().length === had) {
        // Not one of this page's rows. Page 1's contents do not depend on a row
        // further down the query, but a later page's window does — every row
        // behind it shifts by one.
        if (offset > 0 && record && verdict(record) === true) {
          if (total !== null) total--
          stale.bump()
        }
        return
      }

      if (total !== null) total--
      // A row left a page with rows behind it, so one should slide up and only
      // the server knows which.
      if (hasMore()) stale.bump()
    }

    const apply = (raw: unknown): void => {
      const record = unwrap(raw)
      const answer = verdict(record)
      if (answer === false) {
        // Out of the filter: not "do not add it" but "take it out" — a patch is
        // how a row leaves a list, and there is no removal event for that.
        return drop(record, record?.[idField])
      }
      if (answer !== true) return refetch()

      const present = store.get().some((r) => r[idField] === record?.[idField])
      // A row already on this page is this page's row whatever the paging says;
      // reposition it, since the patch may have moved its sort key.
      if (present) {
        const cmp = orderOf()
        return cmp ? store.place(record, idField, cmp) : store.upsert(record, idField)
      }
      insert(record)
    }

    // Server auto-events use past-tense names: created / patched / removed
    // (see AUTO_EVENT_MAP server-side). Match those exactly.
    svc.on('created',  apply)
    svc.on('patched',  apply)
    svc.on('removed',  (raw: unknown) => {
      const record = unwrap(raw)
      drop(record, record?.[idField])
    })

    // ── A change with no record ────────────────────────────────────────────
    // Every other event names a row. `changed` cannot: it is what a bulk write
    // or a `select: false` write announces, and it carries a count instead
    // (FJS-307). That is the same position `verdict` reports as `null` — the
    // list cannot decide from what it was given — so it takes the same answer,
    // and `refetch` already collapses a burst into one request.
    //
    // Not `stale`: a counter is for a gap this list knows the shape of. This is
    // *some unknown rows moved*, which a number on a banner cannot describe.
    svc.on('changed', () => refetch())

    // Custom method events (e.g. 'moved', 'archived') — treat as patches. The
    // server publishes them with the updated record, and a row can leave the
    // filter through one exactly as it can through a patch.
    svc.on('*', (method: unknown, raw: unknown) => {
      if (method === 'created' || method === 'patched' || method === 'removed') return
      // Handled above, and it carries a count rather than a record — applying
      // it would upsert the count object into the store as a row.
      if (method === 'changed') return
      apply(raw)
    })

    // load() keeps returning rows — the store holds records, not envelopes,
    // and a view subscribing to it wants something it can map over.
    // Pagination metadata is reachable via service.find() when a caller needs it.
    //
    // A load is stamped when it is ISSUED, and only the newest stamp may write
    // the store. Without that, two overlapping loads landed in arrival order: a
    // search box typed `ac` then `acme` showed the results for `ac` whenever the
    // first request was the slower one, and stayed wrong until the next
    // keystroke, with nothing thrown and nothing logged (`FJS-082`).
    //
    // The superseded request is not cancelled — its caller awaited those rows
    // and still receives them. Only the SHARED store has an ordering problem.
    let issued = 0
    const load = async (
      query: Record<string, unknown> = {},
      params: QueryDirectives = {}
    ): Promise<T[]> => {
      const stamp = ++issued
      const res  = await svc.find(query, params)
      const rows = res.data
      if (stamp === issued) {
        lastQuery  = query
        lastParams = params
        // The envelope's, not the params': the effective limit is the server's
        // — a caller naming none still got one — and a service that answers no
        // pagination metadata leaves `limit` unknown, which turns the trimming
        // off rather than inventing a page size.
        limit  = typeof res.limit  === 'number' ? res.limit  : (params.limit ?? null)
        offset = typeof res.offset === 'number' ? res.offset : (params.offset ?? 0)
        total  = typeof res.total  === 'number' ? res.total  : null
        store.set(rows)
        // This answer is current by definition; whatever the list could not
        // account for before it has just been accounted for.
        stale.reset()
      }
      return rows
    }

    return { service: svc, store, load, stale }
  }

  // ── HTTP request ─────────────────────────────────────────────────────

  async _request(
    method: string,
    path: string,
    body?: unknown,
    opts: { skipAuth?: boolean; header?: Record<string, string> } = {}
  ): Promise<unknown> {
    const url = this._url + path
    const fileUpload = body !== undefined && _hasFiles(body)

    // Don't set Content-Type for multipart — the browser sets it automatically
    // with the correct boundary. JSON requests always get application/json.
    const headers: Record<string, string> = fileUpload
      ? {}
      : { 'Content-Type': 'application/json' }

    if (this.token && !opts.skipAuth) {
      headers['Authorization'] = `Bearer ${this.token}`
    }
    if (this.workspaceId) {
      headers['X-Workspace-Id'] = this.workspaceId
    }
    if (opts.header) {
      Object.assign(headers, opts.header)
    }

    // File values → multipart/form-data so they cross the wire correctly.
    // JSON.stringify({ avatar: File }) silently drops the file — FormData doesn't.
    const fetchBody =
      body === undefined
        ? undefined
        : fileUpload
        ? _toFormData(body as Record<string, unknown>)
        : JSON.stringify(body)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this._timeout)

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: fetchBody,
        signal: controller.signal
      })

      clearTimeout(timer)

      const text = await res.text()
      let data: unknown
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = text
      }

      if (res.status === 401) {
        this.emit('unauthorized')
        // The server's own sentence, not the word "Unauthorized". This threw
        // before reading the body at all, so every app that wanted to tell a
        // person "wrong email or password" had to re-map the status itself —
        // which is most of what a hand-written sign-in page was.
        const msg = (data as Record<string, unknown>)?.message ?? 'Unauthorized'
        throw Object.assign(new Error(String(msg)), { code: 401, data })
      }

      if (!res.ok) {
        const msg =
          (data as Record<string, unknown>)?.message ??
          (data as Record<string, unknown>)?.error ??
          `HTTP ${res.status}`
        throw Object.assign(new Error(String(msg)), { code: res.status, data })
      }

      return data
    } catch (err: unknown) {
      clearTimeout(timer)
      if ((err as Error).name === 'AbortError') {
        throw Object.assign(new Error(`Request timed out: ${method} ${path}`), { code: 408 })
      }
      throw err
    }
  }

  // ── WebSocket ────────────────────────────────────────────────────────

  connect(): void {
    if (this._ws && this._ws.readyState < 2) return // already open or connecting
    this._openWs()
  }

  disconnect(): void {
    this._disconnect()
  }

  private _openWs(): void {
    this._intentionalClose = false
    const proto = this._url.startsWith('https') ? 'wss' : 'ws'
    const host = this._url.replace(/^https?/, '')
    const url = `${proto}${host}/ws?token=${encodeURIComponent(this.token ?? '')}`

    const ws = new WebSocket(url)
    this._ws = ws

    ws.onopen = () => {
      // TCP/WS handshake complete, but the server's open handler is still running
      // (it awaits verifySession + registers the connection in connMap).
      // Don't set _wsReady yet — wait for the server's 'connected' message so
      // service calls don't fire before auth is resolved on the server side.
      this._reconnectAttempts = 0
      this.connected          = true
    }

    ws.onclose = (e) => {
      // If a newer socket has already been opened, this is a stale close event.
      // Don't touch shared state or schedule a reconnect — the new socket owns everything now.
      if (this._ws !== null && this._ws !== ws) return

      this._wsReady = false
      this._ws = null
      this.connected = false
      this.emit('disconnect', e.code)

      // Reject any pending WS calls
      for (const [, { reject }] of this._wsCallMap) {
        reject(new Error('WebSocket closed'))
      }
      this._wsCallMap.clear()

      if (this._intentionalClose) return
      if (e.code === 4001) {
        // auth failed — don't reconnect
        this.emit('unauthorized')
        return
      }

      // Exponential backoff reconnect
      const delay = Math.min(
        this._reconnectDelay * Math.pow(1.5, this._reconnectAttempts),
        this._reconnectMax
      )
      this._reconnectAttempts++
      this.emit('reconnecting', { attempt: this._reconnectAttempts, delay })
      this._reconnectTimer = setTimeout(() => this._openWs(), delay)
    }

    ws.onerror = () => {
      this.emit('error', new Error('WebSocket error'))
    }

    ws.onmessage = (e) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(e.data))
      } catch {
        return
      }

      const type = msg.type as string

      // ── Server ready ──────────────────────────────────────────────
      // Sent by the server at the end of _wsOpen, after verifySession and
      // connMap registration are complete. Only now is it safe to send
      // service calls — the server has the auth context for this socket.
      if (type === 'connected') {
        this._wsReady = true
        this.emit('connect')
        return
      }

      // ── Pong ──────────────────────────────────────────────────────
      if (type === 'pong') return

      // ── Auth error ────────────────────────────────────────────────
      if (type === 'error' && msg.code === 401) {
        this.emit('unauthorized')
        return
      }

      // ── WS service call response ──────────────────────────────────
      if (type === 'service_result' || type === 'service_error') {
        const id = msg.id as string
        const pending = this._wsCallMap.get(id)
        if (pending) {
          this._wsCallMap.delete(id)
          if (type === 'service_result') {
            pending.resolve(msg.result)
          } else {
            // `msg.error` is FrameworkError.toJSON() — { name, message, code,
            // data } — and `data` is where a validation failure's per-field
            // list lives. Taking only message + code dropped it, so the same
            // 400 carried field errors over HTTP and nothing but a joined
            // sentence over the socket. WebSocket is the DEFAULT transport, so
            // that is the shape a form sees in production while the HTTP
            // fallback it was built against looked fine.
            //
            // Shaped to match the HTTP path exactly (see _request): the parsed
            // error body goes on `.data`, so `err.data.data` is the list in
            // both, and one unwrapper serves both transports.
            const err = msg.error as Record<string, unknown>
            pending.reject(
              Object.assign(new Error(String(err?.message ?? 'Service error')), {
                code: err?.code,
                data: err
              })
            )
          }
        }
        return
      }

      // ── Push event from server ────────────────────────────────────
      // Format: { type: 'event', event: 'servers patched', data: {...} }
      if (type === 'event') {
        const eventName = msg.event as string // e.g. 'servers patched'
        const data = msg.data

        // Emit on the client globally
        this.emit('event', eventName, data)

        // Also emit on the specific service proxy
        const parts = eventName.split(' ')
        if (parts.length === 2) {
          const [serviceName, method] = parts
          this._services.get(serviceName)?._receive(method, data)
        }
        return
      }
    }
  }

  private _disconnect(): void {
    this._intentionalClose = true
    clearTimeout(this._reconnectTimer ?? undefined)
    this._ws?.close()
    this._ws = null
    this._wsReady = false
    this.connected = false
  }

  // ── WS service call ──────────────────────────────────────────────────
  // Calls a service method over the socket. Falls back to HTTP if socket
  // is not connected.

  _wsCall(
    service: string,
    method: string,
    id: string | number | null,
    data: Record<string, unknown> | null,
    query?: Record<string, unknown> | null
  ): Promise<unknown> {
    // Fall back to HTTP if WS is not ready
    if (!this._wsReady || !this._ws) {
      return this._httpFallback(service, method, id, data, query ?? null)
    }

    return new Promise((resolve, reject) => {
      const callId = String(++this._wsCallSeq)

      const timer = setTimeout(() => {
        this._wsCallMap.delete(callId)
        reject(
          Object.assign(new Error(`WS call timed out: ${service}.${method}`), { code: 408 })
        )
      }, this._timeout)

      this._wsCallMap.set(callId, {
        resolve: (v: unknown) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e: unknown) => {
          clearTimeout(timer)
          reject(e)
        }
      })

      // Extras ride `meta` — that is the field WSMessage declares and the only
      // one the server reads. This used to send `params`, which the server
      // never looked at, so ctx.id was always null and every patch/remove was
      // treated as a bulk operation.
      const meta: Record<string, unknown> = {}
      if (id != null)                                meta.id    = id
      if (query && Object.keys(query).length > 0)    meta.query = query

      // The workspace travels per CALL, not per connection.
      //
      // Over HTTP it is the X-Workspace-Id header on every request. Over the
      // socket there is no per-call header — the server sees only the headers
      // of the upgrade request — so without this the workspace silently
      // disappears the moment the socket connects, and setWorkspace() stops
      // having any effect on anything. An app that scopes by header then works
      // until it goes live and breaks with 'workspace_id required', which
      // points at the app rather than at the transport that dropped it.
      //
      // Only the workspace rides here. The caller's identity stays with the
      // connection (authenticated at upgrade), because a client that could put
      // arbitrary headers on a frame could put Authorization on one.
      if (this.workspaceId)                          meta.workspaceId = this.workspaceId

      this._ws!.send(
        JSON.stringify({
          type: 'service_call',
          id: callId,
          service,
          method,
          ...(Object.keys(meta).length > 0 ? { meta } : {}),
          ...(data != null ? { data } : {})
        })
      )
    })
  }

  private _httpFallback(
    service: string,
    method: string,
    id: string | number | null,
    data: Record<string, unknown> | null,
    query: Record<string, unknown> | null = null
  ): Promise<unknown> {
    const svc = this.service(service)
    switch (method) {
      case 'find':
        // Thread the caller's query through — previously the fallback
        // fetched the entire unfiltered collection.
        return svc.find(query ?? undefined)
      case 'get':
        // Same thread-through as find above. The frame's query holds the
        // directives ($populate, $select) already in WIRE spelling, so it is
        // forwarded verbatim rather than parsed back and re-emitted.
        return svc.get(id!, undefined, query ?? undefined)
      case 'create':
        return svc.create(data ?? {})
      case 'patch':
        return svc.patch(id!, data ?? {})
      case 'remove':
        return svc.remove(id!)
      case 'restore':
        return svc.restore(id!)
      default:
        // Anything else is a custom method, and invoke() is the HTTP form of
        // one. This used to call svc.call(), which is _wsCall() — and _wsCall
        // routes here when the socket is down, so a custom method with no
        // connection recursed between the two forever. Async recursion, so no
        // stack overflow to tell you: the call simply never settled.
        return svc.invoke(method, id!, data)
    }
  }

  // ── Heartbeat ────────────────────────────────────────────────────────

  startHeartbeat(intervalMs = 30_000): () => void {
    const timer = setInterval(() => {
      if (this._wsReady && this._ws) {
        this._ws.send(JSON.stringify({ type: 'ping' }))
      }
    }, intervalMs)
    return () => clearInterval(timer)
  }

  // ── Convenience: check if Hub needs first-run setup ──────────────────

  async needsSetup(): Promise<boolean> {
    try {
      const r = (await this._request('GET', `${this._apiPrefix}/setup/probe`, undefined, {
        skipAuth: true
      })) as { needs_setup: boolean }
      return r.needs_setup
    } catch {
      return false
    }
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────

export function createJunctionClient(opts: JunctionClientOptions = {}): JunctionClient {
  return new JunctionClient(opts)
}

// ─── Helpers ─────────────────────────────────────────────────────────────

// Normalise a URL prefix to '' or '/segment[/segment…]'.
//
// This is deliberately the same transform registerServiceRoutes() applies to
// `apiPrefix` server-side (core/app.ts): strip any surrounding slashes, re-add
// a single leading one. So 'api', '/api', '/api/' and 'api/' all reach the same
// place the server put the route, and '' stays '' — Junction's default, which
// registers services at /{service}.
function _normalizePrefix(value: string | undefined, fallback: string): string {
  const raw = value ?? fallback
  const stripped = raw.replace(/^\/|\/$/g, '')
  return stripped ? `/${stripped}` : ''
}

// Flatten QueryDirectives into the wire query shape the server expects on
// ctx.query — same keys the HTTP query string uses ($limit, $offset,
// $orderBy, $select + raw filters). Used for the WebSocket path.
/**
 * Every directive → its `$` name on the wire.
 *
 * One table, read by both builders. The client prefers the socket whenever one
 * is up, so a directive emitted on one path only is a difference nothing can
 * see from the call site — `$populate` was exactly that once. Values stay in
 * their own types here; the HTTP builder stringifies, the WS builder does not.
 */
function directiveParams(d: QueryDirectives | null | undefined): Record<string, unknown> {
  const p: Record<string, unknown> = {}
  if (!d) return p
  if (d.limit       != null) p['$limit']       = d.limit
  if (d.offset      != null) p['$offset']      = d.offset
  if (d.orderBy     != null) p['$orderBy']     = typeof d.orderBy === 'string' ? d.orderBy : JSON.stringify(d.orderBy)
  if (d.select      != null) p['$select']      = Array.isArray(d.select)   ? d.select.join(',')   : d.select
  if (d.populate    != null) p['$populate']    = Array.isArray(d.populate) ? d.populate.join(',') : d.populate
  if (d.search      != null) p['$search']      = d.search
  if (d.withDeleted != null) p['$withDeleted'] = d.withDeleted
  if (d.onlyDeleted != null) p['$onlyDeleted'] = d.onlyDeleted
  if (d.withTemplates != null) p['$withTemplates'] = d.withTemplates
  if (d.onlyTemplates != null) p['$onlyTemplates'] = d.onlyTemplates
  return p
}

function buildWsQuery(
  query: Record<string, unknown> | null | undefined,
  d: QueryDirectives | null | undefined,
): Record<string, unknown> {
  const q: Record<string, unknown> = { ...(query ?? {}) }
  for (const [key, value] of Object.entries(directiveParams(d))) q[key] = value
  return q
}

/** A filter map → `?a=1&b=2`, or '' when there is nothing to say. Values that
 *  are null/undefined are dropped rather than sent as the strings "null" and
 *  "undefined", which is what an unset optional filter would otherwise become. */
function _plainQuery(query?: Record<string, unknown> | null): string {
  if (!query) return ''
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v == null) continue
    p.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
  }
  const qs = p.toString()
  return qs ? `?${qs}` : ''
}

function buildQueryString(
  query?: Record<string, unknown> | null,
  d?: QueryDirectives | null,
  extra?: Record<string, string>,
): string {
  const p: Record<string, string> = {}

  for (const [key, value] of Object.entries(directiveParams(d))) p[key] = String(value)

  if (query) {
    for (const [key, val] of Object.entries(query)) {
      if (val == null) continue
      p[key] = typeof val === 'object' ? JSON.stringify(val) : String(val)
    }
  }

  // Transport-only, with no structured form — $first, $wrap. Stated by the
  // call site rather than living on QueryDirectives, which is the set that HAS
  // a structured form on the other side.
  if (extra) for (const [key, value] of Object.entries(extra)) p[key] = value

  // URLSearchParams encodes '$' as '%24'. Junction uses $-prefixed params as a
  // documented convention, and '$' is a valid query character (RFC 3986
  // sub-delim). Decode it back — servers decode %24 to $ anyway, so this is
  // cosmetic, but it keeps URLs matching the documented syntax.
  const qs = new URLSearchParams(p).toString().replace(/%24/g, '$')
  return qs ? `?${qs}` : ''
}

// ─── Store<T> ─────────────────────────────────────────────────────────────
// A minimal observable array store. Holds the current list of records and
// notifies subscribers on every change.
//
// Compatible with any reactive system:
//   Svelte:  leadsStore.subscribe(v => leads = v)  /  useStore(leadsStore)
//   Plain:   leadsStore.subscribe(list => render(list))

export class Store<T extends Record<string, unknown> = Record<string, unknown>> {
  private _data: T[]
  private _subs: Set<(data: T[]) => void> = new Set()

  constructor(initial: T[] = []) {
    this._data = initial
  }

  /** Current snapshot — safe to call outside a reactive context. */
  get(): T[] {
    return this._data
  }

  /** Subscribe to changes. Emits current value immediately. Returns unsubscribe fn. */
  subscribe(fn: (data: T[]) => void): () => void {
    this._subs.add(fn)
    fn(this._data)
    return () => this._subs.delete(fn)
  }

  /** Replace the entire list. */
  set(data: T[]): void {
    this._data = data
    this._notify()
  }

  /**
   * Upsert a single record by id field.
   *
   * A record with no id is REFUSED. `findIndex` on `undefined` matches nothing,
   * so an id-less payload used to be appended as a phantom row — a heartbeat
   * answering `{ ok, server_id, status }` put junk in every subscriber's list
   * and nothing said so (`FJS-020`). The server now announces the row instead,
   * but this is the last line before a store: a payload from `channel.send()`
   * never passed through that check at all.
   */
  upsert(record: T, idField = 'id'): void {
    if (record == null || (record as Record<string, unknown>)[idField] == null) {
      console.warn(
        `[Junction] ignored an update with no ${idField} — it cannot be matched to a row. ` +
        `An announcement carries the record it is about.`
      )
      return
    }
    const idx = this._data.findIndex((r) => r[idField] === record[idField])
    if (idx === -1) {
      this._data = [...this._data, record]
    } else {
      this._data = [...this._data.slice(0, idx), record, ...this._data.slice(idx + 1)]
    }
    this._notify()
  }

  /**
   * Put a record at the position `cmp` gives it, moving it if it was already
   * here — a patch can change a sort key, and leaving the row where it was is
   * as wrong as never adding it.
   *
   * `max` trims the tail afterwards. That is only correct for an ORDERED list,
   * where the row pushed off the end genuinely belongs to the next page, so the
   * caller decides; this does what it is told, in one notification.
   */
  place(
    record: T,
    idField = 'id',
    cmp: (a: T, b: T) => number,
    max?: number
  ): void {
    if (record == null || (record as Record<string, unknown>)[idField] == null) {
      console.warn(
        `[Junction] ignored an update with no ${idField} — it cannot be matched to a row. ` +
        `An announcement carries the record it is about.`
      )
      return
    }
    const rest = this._data.filter((r) => r[idField] !== record[idField])
    let at = rest.findIndex((r) => cmp(record, r) < 0)
    if (at === -1) at = rest.length
    rest.splice(at, 0, record)
    this._data = max !== undefined && rest.length > max ? rest.slice(0, max) : rest
    this._notify()
  }

  /** Remove a record by its id value. */
  remove(id: unknown, idField = 'id'): void {
    this._data = this._data.filter((r) => r[idField] !== id)
    this._notify()
  }

  private _notify(): void {
    for (const fn of this._subs) fn(this._data)
  }
}

// ─── Stale ───────────────────────────────────────────────────────────────────
// How many changes this list could not account for.
//
// A live list can answer *is this row in the query* and *where does it go*; it
// cannot answer *which row from page 2 slides up now*, or *does this new row
// belong on page 1 at all* — those need the server. Guessing produces a list
// that is quietly wrong past the fold, which is the failure the whole live path
// exists to avoid, so the count is surfaced instead and a view renders it:
//
//   const { store, stale, load } = client.resource('orders')
//   stale.subscribe(n => { banner.hidden = n === 0; banner.textContent = `${n} new — refresh` })
//   refresh.onclick = () => load(query, params)   // clears it
//
// Same `{ get, subscribe }` shape as Store, so anything that bridges one to a
// UI signal bridges this one unchanged.

export class Stale {
  private _n = 0
  private _subs: Set<(n: number) => void> = new Set()

  get(): number { return this._n }

  subscribe(fn: (n: number) => void): () => void {
    this._subs.add(fn)
    fn(this._n)
    return () => this._subs.delete(fn)
  }

  bump(by = 1): void {
    this._n += by
    this._notify()
  }

  reset(): void {
    if (this._n === 0) return
    this._n = 0
    this._notify()
  }

  private _notify(): void {
    for (const fn of this._subs) fn(this._n)
  }
}

export interface ResourceOptions<T extends Record<string, unknown> = Record<string, unknown>> {
  /**
   * Does this pushed record belong in what the last `load()` asked for?
   *
   * `true` → upsert, `false` → take it out of the list, `null` → cannot be
   * decided from the record alone, so the store reloads instead of guessing.
   * Without one every event is applied, which is the pre-`FJS-011` behaviour.
   *
   * Sierra supplies `matchesQuery(fields, …)` from the model's own schema; this
   * package holds no schema, which is why the decision is passed in.
   */
  match?: (
    record: T,
    query: Record<string, unknown>,
    params: QueryDirectives
  ) => boolean | null
}

export interface ResourceResult<T extends Record<string, unknown> = Record<string, unknown>> {
  /** ServiceProxy for CRUD calls */
  service: ServiceProxy
  /** Reactive store — auto-synced via real-time WS events */
  store: Store<T>
  /** Fetch current list from the server and populate the store */
  load: (query?: Record<string, unknown>, params?: QueryDirectives) => Promise<T[]>
  /**
   * Changes the list could not account for on its own — a row that may belong
   * on an earlier page, a gap left where a row was removed from a full one.
   * `0` means the list is as current as a push can make it. Cleared by `load()`.
   */
  stale: Stale
}

// ─── File upload helpers ──────────────────────────────────────────────────────
// Used by _request to transparently switch to multipart/form-data when any
// value in the request body is a File or Blob.
//
// Mesa component usage — nothing special needed:
//   userService.create({ name: 'Jordan', avatar: loadedFile })
//   // loadedFile is a native browser File from a file input — just pass it.

function _hasFiles(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  return Object.values(body as Record<string, unknown>).some(
    (v) => v instanceof File || v instanceof Blob
  )
}

function _toFormData(body: Record<string, unknown>): FormData {
  const fd = new FormData()
  for (const [key, val] of Object.entries(body)) {
    if (val instanceof File) {
      // Preserve the original filename so Junction's body parser surfaces it correctly
      fd.append(key, val, val.name)
    } else if (val instanceof Blob) {
      fd.append(key, val)
    } else if (val !== undefined && val !== null) {
      // Non-file fields are stringified — Junction will parse them from the form
      fd.append(key, typeof val === 'object' ? JSON.stringify(val) : String(val))
    }
  }
  return fd
}

// ─── Browser global ──────────────────────────────────────────────────────
// When loaded as a <script> tag, exposes JunctionClient on window.

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).JunctionClient = JunctionClient
  ;(window as unknown as Record<string, unknown>).createJunctionClient = createJunctionClient
}

export default createJunctionClient
