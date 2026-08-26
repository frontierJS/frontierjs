// webhooks/index.ts
// At-least-once webhook delivery for Junction.
//
// Architecture:
//   Event bus fires  →  delivery engine writes pending row  →  attempts delivery
//   On failure:  increments attempts, sets next_retry_at
//   Scheduler:   every 60s, picks up overdue failed rows and retries
//   After max attempts: marks dead — stays in table, never retried again
//
// Signing:
//   Every request carries:
//     X-Webhook-Id:        delivery row id
//     X-Webhook-Timestamp: unix seconds
//     X-Webhook-Nonce:     one per delivery — the row id
//     X-Webhook-Event:     event name  e.g. 'orders:created'
//     X-Webhook-Signature: sha256=<hmac>
//   HMAC input: @frontierjs/toolbelt/signature's canonical string —
//     METHOD \n path \n timestamp \n nonce \n sha256(body), newline-joined.
//   A receiver verifies with verifyRequest({ prefix: 'X-Webhook', … }) rather
//   than reimplementing it.
//   Secret is per-registration, shown once on creation.
//
// Usage:
//   app.configure(webhooks({
//     events: ['orders:created', 'orders:patched', 'users:created'],
//     // or:
//     events: ['*'],
//   }))
//
//   // Register a subscriber
//   await app.webhooks.register('https://partner.com/hooks', ['orders:created'])
//
//   // Manually deliver an event outside the auto-fire path
//   await app.webhooks.deliver('orders:created', { id: 'ord_1', total: 99 })

import type { App, Plugin }    from '../../core/app.ts'
import type { IEventBus }      from '../../events/index.ts'
import type { DatabaseClient } from '../../storage/database/index.ts'
import { signRequest }         from '@frontierjs/toolbelt/signature'

// ─── Retry schedule ────────────────────────────────────────────────────────
// Delays in ms after each failed attempt.
// 6 attempts total before a delivery is marked 'dead'.

const RETRY_DELAYS = [
  60_000,        // 1 min
  300_000,       // 5 min
  1_800_000,     // 30 min
  7_200_000,     // 2 h
  28_800_000,    // 8 h
  86_400_000,    // 24 h
]

const MAX_ATTEMPTS = RETRY_DELAYS.length + 1  // 7 total (1 initial + 6 retries)

// ─── Types ─────────────────────────────────────────────────────────────────

export interface WebhookRegistration {
  id:        string
  url:       string
  events:    string[]        // ['orders:created'] or ['*']
  secret:    string          // shown once on creation; HMAC key
  active:    boolean
  createdAt: number          // unix ms
}

export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead'

export interface WebhookDelivery {
  id:          string
  webhookId:   string
  event:       string
  payload:     unknown
  status:      DeliveryStatus
  attempts:    number
  nextRetryAt: number | null   // unix ms
  deliveredAt: number | null   // unix ms
  lastError:   string | null
  createdAt:   number          // unix ms
}

// ─── IWebhookStore ─────────────────────────────────────────────────────────

export interface IWebhookStore {
  // Registration
  register(url: string, events: string[], secret?: string): Promise<WebhookRegistration>
  unregister(id: string): Promise<void>
  list(): Promise<WebhookRegistration[]>
  getRegistration(id: string): Promise<WebhookRegistration | null>
  findForEvent(event: string): Promise<WebhookRegistration[]>

  // Delivery tracking
  createDelivery(webhookId: string, event: string, payload: unknown): Promise<WebhookDelivery>
  updateDelivery(id: string, updates: Partial<Pick<WebhookDelivery,
    'status' | 'attempts' | 'nextRetryAt' | 'deliveredAt' | 'lastError'>>): Promise<void>
  pendingRetries(now: number, limit?: number): Promise<WebhookDelivery[]>
  getDeliveries(webhookId?: string, limit?: number): Promise<WebhookDelivery[]>
  getDelivery(id: string): Promise<WebhookDelivery | null>
}

// ─── SQLite store ──────────────────────────────────────────────────────────

export function createSqliteWebhookStore(dbClient: DatabaseClient): IWebhookStore {

  const db = dbClient.db

  // Schema — idempotent
  db.run(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id         TEXT    PRIMARY KEY,
      url        TEXT    NOT NULL,
      events     TEXT    NOT NULL,
      secret     TEXT    NOT NULL,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id            TEXT    PRIMARY KEY,
      webhook_id    TEXT    NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
      event         TEXT    NOT NULL,
      payload       TEXT    NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'pending',
      attempts      INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER,
      delivered_at  INTEGER,
      last_error    TEXT,
      created_at    INTEGER NOT NULL
    )
  `)

  db.run(`CREATE INDEX IF NOT EXISTS wh_del_status ON webhook_deliveries(status, next_retry_at)`)
  db.run(`CREATE INDEX IF NOT EXISTS wh_del_webhook ON webhook_deliveries(webhook_id)`)

  // Prepared statements
  const stmtInsertHook = db.prepare(
    `INSERT INTO webhooks (id, url, events, secret, active, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`
  )
  const stmtDeleteHook = db.prepare(`DELETE FROM webhooks WHERE id = ?`)
  const stmtListHooks     = db.prepare(`SELECT * FROM webhooks WHERE active = 1 ORDER BY created_at DESC`)
  // Find hooks subscribed to this event, or to the wildcard '*'.
  //
  // Uses json_each() for EXACT element equality. This was a LIKE built from
  // the event name — `events LIKE ('%"' || ? || '"%')` — which made the event
  // name a SQL pattern, so its metacharacters matched other subscriptions:
  //
  //   event 'user_created' → '_' matched any char → delivered to a hook
  //                          subscribed only to 'userXcreated'
  //   event '%'            → matched EVERY registration
  //
  // That is a payload leak: a partner receives, HMAC-signed, an event they
  // never subscribed to. Equality has no metacharacters to escape.
  const stmtFindForEvent  = db.prepare(`
    SELECT * FROM webhooks
    WHERE active = 1
      AND EXISTS (
        SELECT 1 FROM json_each(webhooks.events)
        WHERE json_each.value = ? OR json_each.value = '*'
      )
    ORDER BY created_at DESC
  `)
  const stmtGetHook    = db.prepare(`SELECT * FROM webhooks WHERE id = ?`)

  const stmtInsertDel  = db.prepare(
    `INSERT INTO webhook_deliveries (id, webhook_id, event, payload, status, attempts, next_retry_at, delivered_at, last_error, created_at)
     VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?)`
  )
  const stmtUpdateDel  = db.prepare(
    `UPDATE webhook_deliveries
     SET status = ?, attempts = ?, next_retry_at = ?, delivered_at = ?, last_error = ?
     WHERE id = ?`
  )
  const stmtPendingRetries = db.prepare(
    `SELECT * FROM webhook_deliveries
     WHERE status = 'failed' AND next_retry_at <= ?
     ORDER BY next_retry_at ASC
     LIMIT ?`
  )
  const stmtGetDeliveries = db.prepare(
    `SELECT * FROM webhook_deliveries
     WHERE webhook_id = ?
     ORDER BY created_at DESC
     LIMIT ?`
  )
  const stmtAllDeliveries = db.prepare(
    `SELECT * FROM webhook_deliveries
     ORDER BY created_at DESC
     LIMIT ?`
  )
  const stmtGetDelivery = db.prepare(`SELECT * FROM webhook_deliveries WHERE id = ?`)

  // Row → object helpers
  type HookRow = {
    id: string; url: string; events: string; secret: string
    active: number; created_at: number
  }
  type DelRow = {
    id: string; webhook_id: string; event: string; payload: string
    status: string; attempts: number; next_retry_at: number | null
    delivered_at: number | null; last_error: string | null; created_at: number
  }

  function rowToHook(r: HookRow): WebhookRegistration {
    return {
      id:        r.id,
      url:       r.url,
      events:    JSON.parse(r.events) as string[],
      secret:    r.secret,
      active:    r.active === 1,
      createdAt: r.created_at,
    }
  }

  function rowToDelivery(r: DelRow): WebhookDelivery {
    return {
      id:          r.id,
      webhookId:   r.webhook_id,
      event:       r.event,
      payload:     JSON.parse(r.payload),
      status:      r.status as DeliveryStatus,
      attempts:    r.attempts,
      nextRetryAt: r.next_retry_at,
      deliveredAt: r.delivered_at,
      lastError:   r.last_error,
      createdAt:   r.created_at,
    }
  }

  return {

    async register(url, events, secret?): Promise<WebhookRegistration> {
      const id  = crypto.randomUUID()
      const sec = secret ?? generateSecret()
      const now = Date.now()
      stmtInsertHook.run(id, url, JSON.stringify(events), sec, now)
      return { id, url, events, secret: sec, active: true, createdAt: now }
    },

    async unregister(id) {
      stmtDeleteHook.run(id)
    },

    async list(): Promise<WebhookRegistration[]> {
      return (stmtListHooks.all() as HookRow[]).map(rowToHook)
    },

    async getRegistration(id): Promise<WebhookRegistration | null> {
      const r = stmtGetHook.get(id) as HookRow | null
      return r ? rowToHook(r) : null
    },

    async findForEvent(event): Promise<WebhookRegistration[]> {
      // SQL-level filter: only loads webhooks that subscribe to this event
      // or the wildcard '*'. Avoids full table scan in JavaScript.
      return (stmtFindForEvent.all(event) as HookRow[]).map(rowToHook)
    },

    async createDelivery(webhookId, event, payload): Promise<WebhookDelivery> {
      const id  = crypto.randomUUID()
      const now = Date.now()
      stmtInsertDel.run(id, webhookId, event, JSON.stringify(payload), now)
      return {
        id, webhookId, event, payload, status: 'pending',
        attempts: 0, nextRetryAt: null, deliveredAt: null,
        lastError: null, createdAt: now,
      }
    },

    async updateDelivery(id, updates) {
      const existing = stmtGetDelivery.get(id) as DelRow | null
      if (!existing) return

      // Key presence, not `??`. With `??` an explicit null meant "leave it
      // alone", so a nullable column could never be CLEARED — a delivery that
      // succeeded on retry kept its stale lastError and next_retry_at, and the
      // history showed a 'delivered' row still carrying "HTTP 500".
      type Bindable = string | number | null
      const pick = <K extends keyof typeof updates>(key: K, current: Bindable): Bindable =>
        (key in updates ? updates[key] : current) as Bindable

      stmtUpdateDel.run(
        pick('status',      existing.status),
        pick('attempts',    existing.attempts),
        pick('nextRetryAt', existing.next_retry_at),
        pick('deliveredAt', existing.delivered_at),
        pick('lastError',   existing.last_error),
        id
      )
    },

    async pendingRetries(now, limit = 100): Promise<WebhookDelivery[]> {
      return (stmtPendingRetries.all(now, limit) as DelRow[]).map(rowToDelivery)
    },

    async getDeliveries(webhookId?, limit = 50): Promise<WebhookDelivery[]> {
      if (webhookId) {
        return (stmtGetDeliveries.all(webhookId, limit) as DelRow[]).map(rowToDelivery)
      }
      return (stmtAllDeliveries.all(limit) as DelRow[]).map(rowToDelivery)
    },

    async getDelivery(id): Promise<WebhookDelivery | null> {
      const r = stmtGetDelivery.get(id) as DelRow | null
      return r ? rowToDelivery(r) : null
    },
  }
}

// ─── HMAC signing ──────────────────────────────────────────────────────────
//
// `@frontierjs/toolbelt/signature` is the one definition of what a signed
// machine-to-machine request is, and that file's own header names this delivery
// path as one of the three signers it exists to unify. It signed
// `${timestamp}.${body}`, which binds neither the METHOD nor the PATH — so a
// captured signature replays against any other endpoint on the same receiver
// that trusts the same secret, and there is no nonce for a receiver to reject a
// repeat with. Both are things a subscriber has no way to add from its side.
//
// The prefix keeps this plugin's own header names (`X-Webhook-*`), which is what
// the prefix parameter is for: the canonical string is shared, the spelling on
// the wire stays the product's.

function generateSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// ─── Delivery engine ───────────────────────────────────────────────────────

export interface WebhookDeliveryResult {
  ok:         boolean
  statusCode: number | null
  error:      string | null
  ms:         number
}

async function attemptDelivery(
  registration: WebhookRegistration,
  delivery:     WebhookDelivery,
): Promise<WebhookDeliveryResult> {

  const body      = JSON.stringify({
    id:        delivery.id,
    event:     delivery.event,
    timestamp: Math.floor(Date.now() / 1000),
    data:      delivery.payload,
  })

  const timestamp = Math.floor(Date.now() / 1000)
  // The path alone, not the whole URL: a receiver behind a proxy recomputes from
  // the request it was handed, which carries no origin.
  const path   = (() => { try { return new URL(registration.url).pathname } catch { return registration.url } })()
  const signed = await signRequest({
    secret: registration.secret,
    method: 'POST',
    path,
    body,
    prefix: 'X-Webhook',
    timestamp,
    // Per ATTEMPT, not per delivery. A nonce is what a receiver refuses a REPLAY
    // by, and this plugin retries the same delivery up to six times — reusing
    // the id would make every legitimate retry indistinguishable from an attack
    // and dead-letter it against any receiver that keeps a nonce store. The
    // identity of the EVENT is `x-webhook-id`, which is stable across attempts
    // and is what a receiver deduplicates on. Two mechanisms, two lifetimes.
    nonce:  crypto.randomUUID()
  })

  const start = Date.now()

  try {
    const res = await fetch(registration.url, {
      method:  'POST',
      headers: {
        'content-type':        'application/json',
        'x-webhook-id':        delivery.id,
        'x-webhook-event':     delivery.event,
        ...signed,
      },
      body,
      signal: AbortSignal.timeout(10_000),   // 10s timeout per attempt
    })

    return {
      ok:         res.ok,
      statusCode: res.status,
      error:      res.ok ? null : `HTTP ${res.status}`,
      ms:         Date.now() - start,
    }
  } catch (err) {
    return {
      ok:         false,
      statusCode: null,
      error:      (err as Error).message,
      ms:         Date.now() - start,
    }
  }
}

// ─── WebhookManager — public API attached to app.webhooks ─────────────────

export interface WebhookManager {
  // Registration
  register:   (url: string, events: string[], secret?: string) => Promise<WebhookRegistration>
  unregister: (id: string)  => Promise<void>
  list:       ()            => Promise<WebhookRegistration[]>

  // Manual delivery — bypasses the event listener, useful for testing
  deliver: (event: string, payload: unknown) => Promise<void>

  // Retry a specific dead delivery
  retry: (deliveryId: string) => Promise<WebhookDeliveryResult | null>

  // Delivery history
  deliveries: (webhookId?: string, limit?: number) => Promise<WebhookDelivery[]>
  getDelivery: (id: string) => Promise<WebhookDelivery | null>

  // Internal — used by the retry scheduler job
  _store: IWebhookStore
  _attemptAndRecord: (registration: WebhookRegistration, delivery: WebhookDelivery) => Promise<void>
}

// ─── Plugin options ────────────────────────────────────────────────────────

export interface WebhookOptions {
  // Which events to fan out. Use ['*'] for everything.
  events: string[]

  // Provide your own store implementation (e.g. Postgres-backed).
  // If omitted, a SQLite store is created from app.db automatically.
  // app.db must be configured if no store is provided.
  store?: IWebhookStore

  // How often to poll for overdue retries (ms). Default 60 000.
  retryInterval?: number
}

// ─── webhooks() plugin ─────────────────────────────────────────────────────

export function webhooks(opts: WebhookOptions): Plugin {

  return {
    name: 'webhooks',

    // Synchronous: every await below lives inside a nested handler, not here.
    register(app: App): void {

      // ── Resolve store ──────────────────────────────────────────────
      let store: IWebhookStore

      if (opts.store) {
        store = opts.store
      } else {
        if (!app.db) {
          throw new Error(
            '[webhooks] No database configured. ' +
            'Either pass a custom store option via webhooks({ store: ... }).'
          )
        }
        store = createSqliteWebhookStore(app.db as DatabaseClient)
      }

      // ── Delivery helper ────────────────────────────────────────────

      /**
       * Records the outcome of ONE attempt: status, attempt count, retry
       * schedule, dead-lettering, and the matching event.
       *
       * Split out so manual retry() shares it. retry() used to write its own
       * status updates and got them wrong — no exhaustion check, so a delivery
       * retried by hand ran past MAX_ATTEMPTS and never dead-lettered, and no
       * nextRetryAt, so it kept its stale one.
       */
      async function recordResult(
        registration: WebhookRegistration,
        delivery:     WebhookDelivery,
        result:       WebhookDeliveryResult
      ): Promise<void> {

        const now = Date.now()

        if (result.ok) {
          await store.updateDelivery(delivery.id, {
            status:      'delivered',
            attempts:    delivery.attempts + 1,
            deliveredAt: now,
            nextRetryAt: null,
            lastError:   null,
          })
          app.events.emit('webhook:delivered', { delivery, result })
          return
        }

        const attempts    = delivery.attempts + 1
        const retryDelay  = RETRY_DELAYS[attempts - 1]
        const isExhausted = attempts >= MAX_ATTEMPTS

        await store.updateDelivery(delivery.id, {
          status:      isExhausted ? 'dead' : 'failed',
          attempts,
          nextRetryAt: isExhausted ? null : now + retryDelay,
          lastError:   result.error,
        })

        app.events.emit(
          isExhausted ? 'webhook:dead' : 'webhook:failed',
          { delivery: { ...delivery, attempts }, result }
        )
      }

      async function attemptAndRecord(
        registration: WebhookRegistration,
        delivery:     WebhookDelivery
      ): Promise<void> {
        await recordResult(registration, delivery, await attemptDelivery(registration, delivery))
      }

      // ── Fan-out on event bus ───────────────────────────────────────

      const listenEvents = opts.events

      /**
       * @param waitForDelivery await the HTTP attempts before resolving.
       *
       * The event-bus path passes false: a slow partner must never block the
       * emitter, and failures are tracked in the table for the retry scheduler.
       * manager.deliver() passes true — it is documented as "useful for
       * testing", and it used to resolve BEFORE anything was sent, so a caller
       * could not observe the outcome it was calling the method to observe.
       */
      async function handleEvent(
        eventName:       string,
        payload:         unknown,
        waitForDelivery = false,
      ): Promise<void> {
        const registrations = await store.findForEvent(eventName)
        const inFlight: Promise<void>[] = []

        for (const reg of registrations) {
          try {
            const delivery = await store.createDelivery(reg.id, eventName, payload)
            const attempt  = attemptAndRecord(reg, delivery)
            if (waitForDelivery) inFlight.push(attempt.catch(() => {}))
            else                 attempt.catch(() => {})
          } catch (err) {
            app.events.emit('webhook:error', { event: eventName, error: err })
          }
        }

        if (waitForDelivery) await Promise.all(inFlight)
      }

      // Subscribe to declared events
      if (listenEvents.includes('*')) {
        // Wildcard — use onAny() so we receive the actual event name
        // without monkey-patching emit. Skips internal webhook: events
        // to avoid infinite loops.
        app.events.onAny((event, data) => {
          if (!event.startsWith('webhook:') && !event.startsWith('__')) {
            handleEvent(event, data).catch(() => {})
          }
        })
      } else {
        for (const event of listenEvents) {
          app.events.on(event, (data) => {
            handleEvent(event, data).catch(() => {})
          })
        }
      }

      // ── Retry scheduler ────────────────────────────────────────────

      const retryInterval = opts.retryInterval ?? 60_000

      app.scheduler.every(
        `${Math.floor(retryInterval / 1000)} seconds`,
        async () => {
          const overdue = await store.pendingRetries(Date.now())
          if (!overdue.length) return
          // Batch registration lookups: one query per DISTINCT webhook, not
          // one per delivery (the old N+1 did up to `limit` sequential round
          // trips per tick even when every delivery shared one registration).
          const regCache = new Map<string, WebhookRegistration | null>()
          for (const delivery of overdue) {
            let reg = regCache.get(delivery.webhookId)
            if (reg === undefined) {
              reg = await store.getRegistration(delivery.webhookId)
              regCache.set(delivery.webhookId, reg)
            }
            if (!reg || !reg.active) continue
            attemptAndRecord(reg, delivery).catch(() => {})
          }
        }
      )
      // ── Build WebhookManager public API ──────────────────────────

      const manager: WebhookManager = {

        async register(url, events, secret) {
          return store.register(url, events, secret)
        },

        async unregister(id) {
          return store.unregister(id)
        },

        async list() {
          return store.list()
        },

        async deliver(event, payload) {
          await handleEvent(event, payload, true)
        },

        async retry(deliveryId) {
          const delivery = await store.getDelivery(deliveryId)
          if (!delivery) return null
          const reg = await store.getRegistration(delivery.webhookId)
          if (!reg) return null
          const result = await attemptDelivery(reg, delivery)
          // Shares the recording path, so a manual retry dead-letters and
          // reschedules exactly like a scheduled one.
          await recordResult(reg, delivery, result)
          return result
        },

        async deliveries(webhookId, limit) {
          return store.getDeliveries(webhookId, limit)
        },

        async getDelivery(id) {
          return store.getDelivery(id)
        },

        _store:            store,
        _attemptAndRecord: attemptAndRecord,
      }

      // claim() rather than a plain assignment: two plugins claiming one
      // name used to be a silent last-write-wins, leaving the loser dead with
      // no error anywhere.
      app.claim('webhooks', manager)

      // ── HTTP routes ─────────────────────────────────────────────
      // Powers REPL commands and any management UI the app builds.
      //
      // SECURITY: these routes manage HMAC signing credentials and delivery
      // payloads. They require an authenticated session. Fail-closed rule:
      // if the app has no auth configured, the routes respond 401 in
      // production (never open) and remain open only in development.

      // These sit alongside the service routes wherever the app put them:
      // app.get/post/delete apply apiPrefix themselves (core/app.ts). This
      // used to hand-resolve it here, one of four copies of the same read.
      type RouteCtx = Parameters<Parameters<typeof app.get>[1]>[0]
      const guard = (ctx: RouteCtx): ReturnType<RouteCtx['json']> | null => {
        if (ctx.user) return null                                    // authenticated session
        const isProd = process.env.NODE_ENV === 'production'
        if (!app.auth && !isProd) return null                        // dev convenience only
        return ctx.json({ error: 'Unauthorized' }, 401)
      }

      // The HMAC secret is shown exactly once — in the POST /webhooks
      // response that created the registration. Every other read path
      // strips it so a leaked session or logged response can't be used
      // to forge signed deliveries.
      const redact = ({ secret: _secret, ...rest }: WebhookRegistration) => rest

      // Registration
      app.get(`/webhooks`, async (ctx) => {
        const denied = guard(ctx); if (denied) return denied
        const hooks = await store.list()
        return ctx.json(hooks.map(redact))
      })

      app.post(`/webhooks`, async (ctx) => {
        const denied = guard(ctx); if (denied) return denied
        const body = ctx.body as { url?: string; events?: string[]; secret?: string }
        if (!body?.url)           return ctx.json({ error: 'url required' }, 400)
        if (!body?.events?.length) return ctx.json({ error: 'events required' }, 400)
        const hook = await store.register(body.url, body.events, body.secret)
        return ctx.json(hook, 201)   // includes secret — the one and only time
      })

      app.get(`/webhooks/{id}`, async (ctx) => {
        const denied = guard(ctx); if (denied) return denied
        const hook = await store.getRegistration(ctx.route.id)
        if (!hook) return ctx.json({ error: 'Not found' }, 404)
        return ctx.json(redact(hook))
      })

      app.delete(`/webhooks/{id}`, async (ctx) => {
        const denied = guard(ctx); if (denied) return denied
        const hook = await store.getRegistration(ctx.route.id)
        if (!hook) return ctx.json({ error: 'Not found' }, 404)
        await store.unregister(ctx.route.id)
        return ctx.empty()
      })

      // Test ping
      app.post(`/webhooks/{id}/test`, async (ctx) => {
        const denied = guard(ctx); if (denied) return denied
        const hook = await store.getRegistration(ctx.route.id)
        if (!hook) return ctx.json({ error: 'Not found' }, 404)
        const delivery = await store.createDelivery(hook.id, 'webhook:test', { test: true, ts: Date.now() })
        const result   = await attemptDelivery(hook, delivery)
        // A test ping is one-shot and never enters the retry pipeline, so a
        // failure is terminal ('dead'), not 'failed'. Marking it 'failed' with
        // a null next_retry_at left a row that pendingRetries could never
        // select and nothing would ever resolve — neither retried nor final.
        await store.updateDelivery(delivery.id, {
          status:      result.ok ? 'delivered' : 'dead',
          attempts:    1,
          deliveredAt: result.ok ? Date.now() : null,
          nextRetryAt: null,
          lastError:   result.error,
        })
        return ctx.json(result)
      })

      // Delivery history
      app.get(`/webhook-deliveries`, async (ctx) => {
        const denied = guard(ctx); if (denied) return denied
        // A raw route reads the parsed query (`FJS-D125`), so a numeric-looking
        // id arrives as a number and a limit arrives as one already. Both are
        // named rather than assumed: an id is text whatever it looks like.
        const raw        = ctx.query.webhookId
        const webhookId  = raw === undefined || raw === null ? undefined : String(raw)
        const limit      = Number(ctx.query.limit ?? 50) || 50
        const deliveries = await store.getDeliveries(webhookId, limit)
        return ctx.json(deliveries)
      })

      app.get(`/webhook-deliveries/{id}`, async (ctx) => {
        const denied = guard(ctx); if (denied) return denied
        const d = await store.getDelivery(ctx.route.id)
        if (!d) return ctx.json({ error: 'Not found' }, 404)
        return ctx.json(d)
      })

      // Manual retry
      app.post(`/webhook-deliveries/{id}/retry`, async (ctx) => {
        const denied = guard(ctx); if (denied) return denied
        const result = await manager.retry(ctx.route.id)
        if (!result) return ctx.json({ error: 'Not found' }, 404)
        return ctx.json(result)
      })
    },
  }
}

// ─── Note on typing app.webhooks ───────────────────────────────────────────
// Nothing to do: `App.webhooks?: WebhookManager` is already declared in
// core/app.ts, because this plugin ships inside Junction.
//
// This file used to advise users to write
//
//   declare module '@frontierjs/junction' { interface App { webhooks: WebhookManager } }
//
// which is the redeclaration anti-pattern. Declaration merging requires every
// declaration of a property to have an identical type, so redeclaring `webhooks`
// against the existing optional one is TS2717 and the augmentation loses
// silently — exactly what used to happen to `app.conduit`. Out-of-tree plugins
// should augment an empty interface Junction exports (AppConduit / AppJobs /
// AppNotify), never redeclare the property.
