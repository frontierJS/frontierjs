// framework/client/index.ts
// ─────────────────────────────────────────────────────────────────────────
// Junction Browser Client
//
// Works in the browser with no bundler — import as ESM or compile to a
// single file with `bun build framework/client/index.ts --outfile hub/ui/public/junction-client.js`
//
// Usage:
//   const client = createJunctionClient({ url: 'http://localhost:3001' })
//   await client.authenticate({ email: 'admin@acme.com', password: 'secret' })
//
//   const servers = client.service('servers')
//   const list    = await servers.find({ query: { status: 'online' } })
//   await servers.patch('srv_1', { role: 'build' })
//
//   servers.on('created', s => console.log('new server', s))
//   servers.on('patched', s => updateRow(s))
//
// ─────────────────────────────────────────────────────────────────────────

// The only import in this file, and deliberately so: the envelope is shared
// with the server rather than re-described here. core/envelope.ts is pure and
// dependency-free, so it bundles into the browser build without pulling
// anything else in — and it means the client cannot drift from the shape the
// server actually sends, which is precisely what happened before.
import { isListResult, list, type ListResult, type ServiceResult } from '../core/envelope.ts'
export type { ListResult, ServiceResult }

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
  // URL prefix for the auth plugin's routes, default '/auth'. Independent of
  // apiPrefix: @frontierjs/auth mounts its routes with app.post() directly, so
  // they are not moved by apiPrefix. Match the plugin's own `prefix` option.
  authPrefix?: string
}

export interface FindParams {
  query?: Record<string, unknown>
  offset?: number
  limit?: number
  orderBy?: string | Record<string, 'asc' | 'desc'> | Record<string, 'asc' | 'desc'>[]
  select?: string | string[]
}

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
   */
  async find(query?: Record<string, unknown>, params?: FindParams): Promise<ListResult<T>> {
    const merged: FindParams = {
      ...params,
      query: { ...(params?.query ?? {}), ...(query ?? {}) }
    }
    // Normalise whatever the server sent into one shape, so callers see one
    // shape. Three inputs are legitimate:
    //   • a proper list envelope             (current server)
    //   • a bare array                       ($wrap=false, or a custom find)
    //   • { total, limit, offset|skip, data } (older server, or a service
    //                                          returning a paginated shape)
    // The third case is why this is not a two-liner: dropping it would turn a
    // perfectly good paginated response into an empty list, silently.
    const asEnvelope = (res: unknown): ListResult<T> => {
      if (isListResult<T>(res)) return res
      if (Array.isArray(res))   return list(this.name, res as T[])

      const r = res as { data?: unknown; total?: number; limit?: number; offset?: number; skip?: number } | null
      if (r && typeof r === 'object' && Array.isArray(r.data)) {
        return list(this.name, r.data as T[], {
          total:  r.total,
          limit:  r.limit,
          offset: r.offset ?? r.skip,
        })
      }
      return list(this.name, [])
    }

    if (this._client._wsReady) {
      // Send the FULL merged query (filters + $limit/$offset/$orderBy/$select)
      // as params.query so the server puts it on ctx.query — the same shape
      // the HTTP query string produces. Previously only the raw filter object
      // was sent (as the DATA field, not the query), so pagination/ordering/
      // select were silently dropped over WebSocket.
      return asEnvelope(await this._client._wsCall(
        this.name, 'find', null, null, buildWsQuery(merged)
      ))
    }

    const qs = buildQueryString(merged)
    return asEnvelope(await this._client._request('GET', `${this._base}${qs}`))
  }

  /** find() but just the rows — for callers that don't need total/limit/offset. */
  async findData(query?: Record<string, unknown>, params?: FindParams): Promise<T[]> {
    return (await this.find(query, params)).data
  }

  // get(id, params?) → T   /   get(query, params?) → T (findFirst via $first)
  async get(
    idOrQuery: string | number | Record<string, unknown>,
    params?: FindParams
  ): Promise<T> {
    if (typeof idOrQuery === 'object') {
      // findFirst — pass $first=true
      const qs = buildQueryString({ ...params, query: { ...idOrQuery, $first: 'true' } })
      return this._client._request('GET', `${this._base}${qs}`) as Promise<T>
    }
    if (this._client._wsReady) {
      return this._client._wsCall(this.name, 'get', idOrQuery, null) as Promise<T>
    }
    return this._client._request('GET', `${this._base}/${idOrQuery}`) as Promise<T>
  }

  // create(data, params?) → T
  async create(data: Partial<T> & Record<string, unknown>, params?: FindParams): Promise<T> {
    if (this._client._wsReady && !_hasFiles(data)) {
      return this._client._wsCall(this.name, 'create', null, data) as Promise<T>
    }
    return this._client._request('POST', this._base, data) as Promise<T>
  }

  // patch(id, data, params?) → T
  // patch(query, data, params?) → T[]
  async patch(
    id: string | number,
    data: Partial<T> & Record<string, unknown>,
    params?: FindParams
  ): Promise<T>
  async patch(
    query: Record<string, unknown>,
    data: Partial<T> & Record<string, unknown>,
    params?: FindParams
  ): Promise<T[]>
  async patch(
    idOrQuery: string | number | Record<string, unknown>,
    data: Partial<T> & Record<string, unknown>,
    params?: FindParams
  ): Promise<T | T[]> {
    if (typeof idOrQuery === 'object') {
      const qs = buildQueryString({ ...params, query: idOrQuery })
      return this._client._request('PATCH', `${this._base}${qs}`, data) as Promise<T[]>
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

  // remove(id, params?) → T
  // remove(query, params?) → string[]  (ids)
  async remove(id: string | number, params?: FindParams): Promise<T>
  async remove(query: Record<string, unknown>, params?: FindParams): Promise<string[]>
  async remove(
    idOrQuery: string | number | Record<string, unknown>,
    params?: FindParams
  ): Promise<T | string[]> {
    if (typeof idOrQuery === 'object') {
      const qs = buildQueryString({ ...params, query: idOrQuery })
      return this._client._request('DELETE', `${this._base}${qs}`) as Promise<string[]>
    }
    if (this._client._wsReady) {
      return this._client._wsCall(this.name, 'remove', idOrQuery, null) as Promise<T>
    }
    return this._client._request('DELETE', `${this._base}/${idOrQuery}`) as Promise<T>
  }

  // restore(id, params?) → T
  // restore(query, params?) → T[]
  async restore(id: string | number, params?: FindParams): Promise<T>
  async restore(query: Record<string, unknown>, params?: FindParams): Promise<T[]>
  async restore(
    idOrQuery: string | number | Record<string, unknown>,
    params?: FindParams
  ): Promise<T | T[]> {
    if (typeof idOrQuery === 'object') {
      const qs = buildQueryString({ ...params, query: idOrQuery })
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
  async upsert(data: Partial<T> & Record<string, unknown>, params?: FindParams): Promise<T> {
    if (data.id != null) {
      return this.patch(data.id as string | number, data, params) as Promise<T>
    }
    return this.create(data as T & Record<string, unknown>, params)
  }

  // ── Actions ─────────────────────────────────────────────────────────
  // Same transport rule as CRUD: the socket when one is connected, HTTP when it
  // is not. Over WS that is a service_call frame with method = the action name
  // (no URL involved); over HTTP it is POST /{id} with an X-Service-Method
  // header, which keeps the URL space flat.

  async action(
    name: string,
    id: string | number,
    data?: Record<string, unknown> | null
  ): Promise<unknown> {
    // Same rule as CRUD: the socket when it is there, HTTP when it is not.
    // This used to be unconditionally HTTP, which made a custom action the only
    // service call that ignored a live connection — and the WS path dispatches
    // any method name generically, so there was never a reason for it.
    //
    // Files are the documented exception: multipart cannot travel over the
    // socket, so a payload carrying one goes over HTTP exactly as create and
    // patch do.
    if (this._client._wsReady && !_hasFiles(data ?? {})) {
      return this._client._wsCall(this.name, name, id, data ?? null)
    }
    return this._client._request(
      'POST',
      `${this._base}/${id}`,
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
    this._authPrefix = _normalizePrefix(opts.authPrefix, '/auth')
    this.token = opts.token ?? null
    this.workspaceId = opts.workspaceId ?? null
  }

  // ── Auth ────────────────────────────────────────────────────────────

  async authenticate(credentials: {
    email: string
    password: string
  }): Promise<{ token: string; user: unknown; workspaceId: string | null }> {
    // The auth plugin's own prefix, not apiPrefix — @frontierjs/auth registers
    // these with app.post() directly, so apiPrefix does not move them. This
    // used to point at '/api/auth/login', which the plugin has never served.
    const result = await this._request('POST', `${this._authPrefix}/login`, credentials, {
      skipAuth: true
    })
    const r = result as { token: string; user: unknown; workspaceId: string | null }
    this.setToken(r.token)
    if (r.workspaceId && !this.workspaceId) this.workspaceId = r.workspaceId
    this.emit('authenticated', r)
    return r
  }

  async logout(): Promise<void> {
    this.setToken(null)
    this.emit('logout')
  }

  setToken(token: string | null): void {
    const changed = token !== this.token
    this.token = token
    if (!changed) return
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
  // Usage:
  //   const { service, store, load } = client.resource('leads')
  //   await load()                          // populate from server
  //   store.subscribe(leads => render(leads))
  //   await service.create({ name: 'Acme' }) // store updates via WS

  resource<T extends Record<string, unknown> = Record<string, unknown>>(
    name: string,
    idField: string = 'id'
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

    // Server auto-events use past-tense names: created / patched / removed
    // (see AUTO_EVENT_MAP server-side). Match those exactly.
    svc.on('created',  (raw: unknown) => store.upsert(unwrap(raw), idField))
    svc.on('patched',  (raw: unknown) => store.upsert(unwrap(raw), idField))
    svc.on('removed',  (raw: unknown) => store.remove(unwrap(raw)[idField], idField))

    // Custom action events (e.g. 'moved', 'archived') — treat as upserts.
    // The server publishes them with the updated record, same as patch.
    svc.on('*', (method: unknown, raw: unknown) => {
      if (method === 'created' || method === 'patched' || method === 'removed') return
      store.upsert(unwrap(raw), idField)
    })

    // load() keeps returning rows — the store holds records, not envelopes,
    // and a view subscribing to it wants something it can map over.
    // Pagination metadata is reachable via service.find() when a caller needs it.
    const load = async (
      query: Record<string, unknown> = {},
      params: FindParams = {}
    ): Promise<T[]> => {
      const rows = (await svc.find(query, params)).data
      store.set(rows)
      return rows
    }

    return { service: svc, store, load }
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

      if (res.status === 401) {
        this.emit('unauthorized')
        throw Object.assign(new Error('Unauthorized'), { code: 401 })
      }

      const text = await res.text()
      let data: unknown
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = text
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
            const err = msg.error as Record<string, unknown>
            pending.reject(
              Object.assign(new Error(String(err?.message ?? 'Service error')), {
                code: err?.code
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
        return svc.get(id!)
      case 'create':
        return svc.create(data ?? {})
      case 'patch':
        return svc.patch(id!, data ?? {})
      case 'remove':
        return svc.remove(id!)
      case 'restore':
        return svc.restore(id!)
      default:
        // Anything else is a custom action, and action() is the HTTP form of
        // one. This used to call svc.call(), which is _wsCall() — and _wsCall
        // routes here when the socket is down, so a custom action with no
        // connection recursed between the two forever. Async recursion, so no
        // stack overflow to tell you: the call simply never settled.
        return svc.action(method, id!, data)
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

// Flatten FindParams into the wire query shape the server expects on
// ctx.query — same keys the HTTP query string uses ($limit, $offset,
// $orderBy, $select + raw filters). Used for the WebSocket path.
function buildWsQuery(params: FindParams): Record<string, unknown> {
  const q: Record<string, unknown> = { ...(params.query ?? {}) }
  if (params.limit  != null) q['$limit']  = params.limit
  if (params.offset != null) q['$offset'] = params.offset
  if (params.orderBy != null) {
    q['$orderBy'] =
      typeof params.orderBy === 'string' ? params.orderBy : JSON.stringify(params.orderBy)
  }
  if (params.select != null) {
    q['$select'] = Array.isArray(params.select) ? params.select.join(',') : params.select
  }
  return q
}

function buildQueryString(params: FindParams): string {
  const p: Record<string, string> = {}

  if (params.offset != null) p['$offset'] = String(params.offset)
  if (params.limit != null) p['$limit'] = String(params.limit)

  if (params.orderBy != null) {
    p['$orderBy'] =
      typeof params.orderBy === 'string' ? params.orderBy : JSON.stringify(params.orderBy)
  }

  if (params.select != null) {
    p['$select'] = Array.isArray(params.select) ? params.select.join(',') : params.select
  }

  if (params.query) {
    for (const [key, val] of Object.entries(params.query)) {
      if (val == null) continue
      if (typeof val === 'object') {
        p[key] = JSON.stringify(val)
      } else {
        p[key] = String(val)
      }
    }
  }

  // URLSearchParams encodes '$' as '%24'. Junction uses $-prefixed params
  // ($limit, $offset, $first, $select, …) as a documented convention, and '$'
  // is a valid query character (RFC 3986 sub-delim). Decode it back for
  // readability — servers decode %24 to $ anyway, so this is purely cosmetic
  // but keeps URLs clean and matches the documented query syntax.
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

  /** Upsert a single record by id field. */
  upsert(record: T, idField = 'id'): void {
    const idx = this._data.findIndex((r) => r[idField] === record[idField])
    if (idx === -1) {
      this._data = [...this._data, record]
    } else {
      this._data = [...this._data.slice(0, idx), record, ...this._data.slice(idx + 1)]
    }
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

export interface ResourceResult<T extends Record<string, unknown> = Record<string, unknown>> {
  /** ServiceProxy for CRUD calls */
  service: ServiceProxy
  /** Reactive store — auto-synced via real-time WS events */
  store: Store<T>
  /** Fetch current list from the server and populate the store */
  load: (query?: Record<string, unknown>, params?: FindParams) => Promise<T[]>
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
