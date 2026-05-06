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
//     X-Webhook-Event:     event name  e.g. 'orders:created'
//     X-Webhook-Signature: sha256=<hmac>
//   HMAC input: `${timestamp}.${rawBodyString}`
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

// Singleton — avoids allocating TextEncoder on every HMAC sign
const ENCODER = new TextEncoder()

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
  // Find hooks matching a specific event name or the wildcard '*'.
  // Uses JSON contains check via LIKE — much faster than loading all rows
  // into JS and filtering. The events field stores a JSON array like
  // '["orders:created","*"]' so we check for both the literal value and '*'.
  const stmtFindForEvent  = db.prepare(`
    SELECT * FROM webhooks
    WHERE active = 1
      AND (
        events LIKE '%"*"%'
        OR events LIKE ('%"' || ? || '"%')
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
      stmtUpdateDel.run(
        updates.status      ?? existing.status,
        updates.attempts    ?? existing.attempts,
        updates.nextRetryAt ?? existing.next_retry_at,
        updates.deliveredAt ?? existing.delivered_at,
        updates.lastError   ?? existing.last_error,
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

async function sign(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    ENCODER.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const data = ENCODER.encode(`${timestamp}.${body}`)
  const sig  = await crypto.subtle.sign('HMAC', key, data)
  return 'sha256=' + Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

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
  const signature = await sign(registration.secret, timestamp, body)

  const start = Date.now()

  try {
    const res = await fetch(registration.url, {
      method:  'POST',
      headers: {
        'content-type':        'application/json',
        'x-webhook-id':        delivery.id,
        'x-webhook-event':     delivery.event,
        'x-webhook-timestamp': String(timestamp),
        'x-webhook-signature': signature,
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

    async register(app: App): Promise<void> {

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
        store = createSqliteWebhookStore(app.db)
      }

      // ── Delivery helper ────────────────────────────────────────────

      async function attemptAndRecord(
        registration: WebhookRegistration,
        delivery:     WebhookDelivery
      ): Promise<void> {

        const result = await attemptDelivery(registration, delivery)
        const now    = Date.now()

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

      // ── Fan-out on event bus ───────────────────────────────────────

      const listenEvents = opts.events

      async function handleEvent(eventName: string, payload: unknown): Promise<void> {
        const registrations = await store.findForEvent(eventName)
        for (const reg of registrations) {
          try {
            const delivery = await store.createDelivery(reg.id, eventName, payload)
            // Fire and don't await — delivery failures are tracked in the table
            // and picked up by the retry scheduler. We never block the event handler.
            attemptAndRecord(reg, delivery).catch(() => {})
          } catch (err) {
            app.events.emit('webhook:error', { event: eventName, error: err })
          }
        }
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
          for (const delivery of overdue) {
            const reg = await store.getRegistration(delivery.webhookId)
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
          await handleEvent(event, payload)
        },

        async retry(deliveryId) {
          const delivery = await store.getDelivery(deliveryId)
          if (!delivery) return null
          const reg = await store.getRegistration(delivery.webhookId)
          if (!reg) return null
          const result = await attemptDelivery(reg, delivery)
          const now = Date.now()
          if (result.ok) {
            await store.updateDelivery(deliveryId, {
              status:      'delivered',
              attempts:    delivery.attempts + 1,
              deliveredAt: now,
              lastError:   null,
            })
          } else {
            await store.updateDelivery(deliveryId, {
              attempts:  delivery.attempts + 1,
              lastError: result.error,
            })
          }
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

      // Attach to app
      ;(app as unknown as Record<string, unknown>).webhooks = manager

      // ── HTTP routes ─────────────────────────────────────────────
      // Powers REPL commands and any management UI the app builds.

      const apiPrefix = (app.config as import('../../config/index.ts').AppConfig).apiPrefix ?? '/api'

      // Registration
      app.get(`${apiPrefix}/webhooks`, async (ctx) => {
        const hooks = await store.list()
        return ctx.json(hooks)
      })

      app.post(`${apiPrefix}/webhooks`, async (ctx) => {
        const body = ctx.body as { url?: string; events?: string[]; secret?: string }
        if (!body?.url)           return ctx.json({ error: 'url required' }, 400)
        if (!body?.events?.length) return ctx.json({ error: 'events required' }, 400)
        const hook = await store.register(body.url, body.events, body.secret)
        return ctx.json(hook, 201)
      })

      app.get(`${apiPrefix}/webhooks/{id}`, async (ctx) => {
        const hook = await store.getRegistration(ctx.params.id)
        if (!hook) return ctx.json({ error: 'Not found' }, 404)
        return ctx.json(hook)
      })

      app.delete(`${apiPrefix}/webhooks/{id}`, async (ctx) => {
        const hook = await store.getRegistration(ctx.params.id)
        if (!hook) return ctx.json({ error: 'Not found' }, 404)
        await store.unregister(ctx.params.id)
        return ctx.empty()
      })

      // Test ping
      app.post(`${apiPrefix}/webhooks/{id}/test`, async (ctx) => {
        const hook = await store.getRegistration(ctx.params.id)
        if (!hook) return ctx.json({ error: 'Not found' }, 404)
        const delivery = await store.createDelivery(hook.id, 'webhook:test', { test: true, ts: Date.now() })
        const result   = await attemptDelivery(hook, delivery)
        await store.updateDelivery(delivery.id, {
          status:      result.ok ? 'delivered' : 'failed',
          attempts:    1,
          deliveredAt: result.ok ? Date.now() : null,
          lastError:   result.error,
        })
        return ctx.json(result)
      })

      // Delivery history
      app.get(`${apiPrefix}/webhook-deliveries`, async (ctx) => {
        const webhookId  = ctx.query.webhookId
        const limit      = parseInt(ctx.query.limit ?? '50', 10)
        const deliveries = await store.getDeliveries(webhookId, limit)
        return ctx.json(deliveries)
      })

      app.get(`${apiPrefix}/webhook-deliveries/{id}`, async (ctx) => {
        const d = await store.getDelivery(ctx.params.id)
        if (!d) return ctx.json({ error: 'Not found' }, 404)
        return ctx.json(d)
      })

      // Manual retry
      app.post(`${apiPrefix}/webhook-deliveries/{id}/retry`, async (ctx) => {
        const result = await manager.retry(ctx.params.id)
        if (!result) return ctx.json({ error: 'Not found' }, 404)
        return ctx.json(result)
      })
    },
  }
}

// ─── Type augmentation hint ────────────────────────────────────────────────
// TypeScript users can extend the App interface in their own code:
//
//   declare module '@frontierjs/junction' {
//     interface App { webhooks: WebhookManager }
//   }
