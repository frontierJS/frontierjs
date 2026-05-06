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

// ─── Types ────────────────────────────────────────────────────────────────

export interface JunctionClientOptions {
  url?: string // base URL, default = window.location.origin
  token?: string // pre-set token (e.g. from localStorage)
  workspaceId?: string // pre-set workspace
  timeout?: number // request timeout ms, default 30_000
  reconnectDelay?: number // initial WS reconnect delay ms, default 1_000
  reconnectMax?: number // max reconnect delay ms, default 30_000
}

export interface FindParams {
  query?: Record<string, unknown>
  offset?: number
  limit?: number
  orderBy?: string | Record<string, 'asc' | 'desc'> | Record<string, 'asc' | 'desc'>[]
  select?: string | string[]
}

export interface PaginatedResult<T = unknown> {
  total: number
  limit: number
  offset: number
  data: T[]
}

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

  // ── CRUD ────────────────────────────────────────────────────────────
  // Prefer WS when connected. Files always use HTTP.

  // find(query?, params?) → T[]
  async find(query?: Record<string, unknown>, params?: FindParams): Promise<T[]> {
    const merged: FindParams = {
      ...params,
      query: { ...(params?.query ?? {}), ...(query ?? {}) }
    }
    if (this._client._wsReady) {
      const res = (await this._client._wsCall(this.name, 'find', null, query ?? null)) as
        | { data: T[] }
        | T[]
        | null
      if (!res) return []
      return (res as { data: T[] }).data ?? (res as T[])
    }
    const qs = buildQueryString(merged)
    const res = (await this._client._request('GET', `/api/${this.name}${qs}`)) as
      | { data: T[] }
      | T[]
      | null
    if (!res) return []
    // Server returns list envelope { object:'list', data:[], ... } — unwrap data
    return (res as { data: T[] }).data ?? (res as T[])
  }

  // get(id, params?) → T   /   get(query, params?) → T (findFirst via $first)
  async get(
    idOrQuery: string | number | Record<string, unknown>,
    params?: FindParams
  ): Promise<T> {
    if (typeof idOrQuery === 'object') {
      // findFirst — pass $first=true
      const qs = buildQueryString({ ...params, query: { ...idOrQuery, $first: 'true' } })
      return this._client._request('GET', `/api/${this.name}${qs}`) as Promise<T>
    }
    if (this._client._wsReady) {
      return this._client._wsCall(this.name, 'get', idOrQuery, null) as Promise<T>
    }
    return this._client._request('GET', `/api/${this.name}/${idOrQuery}`) as Promise<T>
  }

  // create(data, params?) → T
  async create(data: Partial<T> & Record<string, unknown>, params?: FindParams): Promise<T> {
    if (this._client._wsReady && !_hasFiles(data)) {
      return this._client._wsCall(this.name, 'create', null, data) as Promise<T>
    }
    return this._client._request('POST', `/api/${this.name}`, data) as Promise<T>
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
      return this._client._request('PATCH', `/api/${this.name}${qs}`, data) as Promise<T[]>
    }
    if (this._client._wsReady && !_hasFiles(data)) {
      return this._client._wsCall(this.name, 'patch', idOrQuery, data) as Promise<T>
    }
    return this._client._request(
      'PATCH',
      `/api/${this.name}/${idOrQuery}`,
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
      return this._client._request('DELETE', `/api/${this.name}${qs}`) as Promise<string[]>
    }
    if (this._client._wsReady) {
      return this._client._wsCall(this.name, 'remove', idOrQuery, null) as Promise<T>
    }
    return this._client._request('DELETE', `/api/${this.name}/${idOrQuery}`) as Promise<T>
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
      return this._client._request('PUT', `/api/${this.name}${qs}`, undefined, {
        header: { 'x-service-method': 'restore' }
      }) as Promise<T[]>
    }
    return this._client._request('PUT', `/api/${this.name}/${idOrQuery}`, undefined, {
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
  // Custom actions are dispatched via X-Service-Method header on POST /{id}.
  // WS calls use service_call with method = name (no URL involved).

  async action(
    name: string,
    id: string | number,
    data?: Record<string, unknown> | null
  ): Promise<unknown> {
    return this._client._request(
      'POST',
      `/api/${this.name}/${id}`,
      data ?? {},
      { 'X-Service-Method': name }
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
    this.token = opts.token ?? null
    this.workspaceId = opts.workspaceId ?? null
  }

  // ── Auth ────────────────────────────────────────────────────────────

  async authenticate(credentials: {
    email: string
    password: string
  }): Promise<{ token: string; user: unknown; workspaceId: string | null }> {
    const result = await this._request('POST', '/api/auth/login', credentials, {
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

    // Wire WS push events → store mutations
    // Push events carry ctx.result — the ServiceResult envelope { object, data, ... }.
    // Unwrap to get the actual record before passing to the store.
    const unwrap = (raw: unknown): T => {
      if (raw && typeof raw === 'object' && 'data' in (raw as object)) {
        return (raw as { data: T }).data
      }
      return raw as T
    }

    svc.on('create',  (raw: unknown) => store.upsert(unwrap(raw), idField))
    svc.on('patch',   (raw: unknown) => store.upsert(unwrap(raw), idField))
    svc.on('remove',  (raw: unknown) => store.remove(unwrap(raw)[idField], idField))

    // Custom action events (e.g. 'move', 'archive') — treat as upserts.
    // The server publishes them with the updated record, same as patch.
    svc.on('*', (method: unknown, raw: unknown) => {
      if (method === 'create' || method === 'patch' || method === 'remove') return
      store.upsert(unwrap(raw), idField)
    })

    const load = async (
      query: Record<string, unknown> = {},
      params: FindParams = {}
    ): Promise<T[]> => {
      const result = await svc.find(query, params)
      store.set(result)
      return result
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
    data: Record<string, unknown> | null
  ): Promise<unknown> {
    // Fall back to HTTP if WS is not ready
    if (!this._wsReady || !this._ws) {
      return this._httpFallback(service, method, id, data)
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

      this._ws!.send(
        JSON.stringify({
          type: 'service_call',
          id: callId,
          service,
          method,
          ...(id != null ? { params: { id } } : {}),
          ...(data != null ? { data } : {})
        })
      )
    })
  }

  private _httpFallback(
    service: string,
    method: string,
    id: string | number | null,
    data: Record<string, unknown> | null
  ): Promise<unknown> {
    const svc = this.service(service)
    switch (method) {
      case 'find':
        return svc.find()
      case 'get':
        return svc.get(id!)
      case 'create':
        return svc.create(data ?? {})
      case 'patch':
        return svc.patch(id!, data ?? {})
      case 'remove':
        return svc.remove(id!)
      default:
        return svc.call(method, id!, data)
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
      const r = (await this._request('GET', '/api/setup/probe', undefined, {
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

  const qs = new URLSearchParams(p).toString()
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
