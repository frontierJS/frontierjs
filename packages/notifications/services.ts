// services.ts
// createPushSubscriptionsService(db, name, opts): the door a browser subscribes by.
//
//   push-subscriptions  GET  /push-subscriptions        this person's devices, no keys
//                       GET  /push-subscriptions/key    the VAPID public key (`FJS-D1626`)
//                       POST /push-subscriptions        subscription.toJSON(), upserted by endpoint
//                       DEL  /push-subscriptions/{id}   retire one
//
// Registered by the plugin at boot when the app's schema installs
// `PushSubscription` (`db/notification.lite`). Every method is the caller's
// OWN: ownership goes into the WHERE, and no method takes a user id.
//
// The writes go through asSystem() for two reasons the row policy cannot
// express: a retired row is restored by the same endpoint, and a browser
// profile that signs in as somebody else moves its one subscription to them —
// the push service hands one profile one endpoint, so the previous owner's row
// is the same device and would otherwise refuse the new owner as a duplicate.

import { createService, BadRequest, NotFound, Unauthorized, LEVELS, refuseDelegated } from '@frontierjs/junction'
import { assertPublicUrl } from '@frontierjs/junction/public-url'
import type { ServiceContext, ServiceDefinition } from '@frontierjs/junction'
import { subscriptionKeyProblem } from './drivers/webpush.ts'

export const DEFAULT_SERVICE_NAMES = {
  pushSubscriptions: 'push-subscriptions',
} as const

type Row = { id: number, endpoint: string, userAgent: string | null, lastSeenAt: Date | null, createdAt: Date, deletedAt?: Date | null }

type Rows = {
  findFirst(opts: Record<string, unknown>): Promise<Row | null>
  findMany(opts: Record<string, unknown>): Promise<Row[]>
  create(opts: Record<string, unknown>): Promise<Row>
  update(opts: Record<string, unknown>): Promise<Row>
  restore(opts: Record<string, unknown>): Promise<Row[]>
  removeMany(opts: Record<string, unknown>): Promise<{ count: number }>
}

// The keys never leave: whoever holds them and the endpoint can put a
// notification on that screen.
const PUBLIC = { id: true, endpoint: true, userAgent: true, lastSeenAt: true, createdAt: true } as const

export interface PushSubscriptionsServiceOptions {
  /** The registered `webPush()` driver's public key; absent when the app pushes through ntfy or nothing. */
  vapidPublicKey?: string
}

export function createPushSubscriptionsService(
  db: unknown,
  name: string = DEFAULT_SERVICE_NAMES.pushSubscriptions,
  { vapidPublicKey }: PushSubscriptionsServiceOptions = {},
): ServiceDefinition {
  const rows = () => (db as { asSystem(): { pushSubscription: Rows } }).asSystem().pushSubscription

  const me = (ctx: ServiceContext): string => {
    const id = (ctx.user as { id?: unknown } | null)?.id
    if (id == null) throw new Unauthorized('Sign in to manage push subscriptions')
    return String(id)
  }

  return createService({
    name,
    model: null,
    methods: ['find', 'get', 'create', 'remove'].map(method => ({ method, gate: LEVELS.VISITOR })),

    async find(ctx: ServiceContext) {
      const userId = me(ctx)
      const endpoint = (ctx.query as { endpoint?: unknown } | undefined)?.endpoint
      return rows().findMany({
        where:   { userId, ...(typeof endpoint === 'string' ? { endpoint } : {}) },
        select:  PUBLIC,
        orderBy: { createdAt: 'asc' },
      })
    },

    // Served by the API rather than inlined by the web build, so a rotated key
    // reaches the next page load with no rebuild. `key` is the only id: a row
    // is read through find, which already scopes to the caller.
    async get(ctx: ServiceContext) {
      me(ctx)
      if (String(ctx.id) !== 'key') throw new NotFound(`No push subscription ${String(ctx.id)} — list your own with GET /${name}`)
      if (!vapidPublicKey) {
        throw new NotFound('This app has no VAPID key: register webPush({ vapid }) under transports.push in notifications(...)')
      }
      return { publicKey: vapidPublicKey }
    },

    async create(ctx: ServiceContext) {
      const userId = me(ctx)
      refuseDelegated(ctx, ctx.user as { support?: unknown }, "subscribe a browser to this account's notifications")

      const body = (ctx.data ?? {}) as { endpoint?: unknown, keys?: { p256dh?: unknown, auth?: unknown } }
      if (typeof body.endpoint !== 'string') throw new BadRequest('endpoint is required — post subscription.toJSON()')
      const keys = body.keys ?? {}
      const problem = subscriptionKeyProblem(keys)
      if (problem) throw new BadRequest(problem)

      // The driver POSTs to this URL from inside the network, so it is graded
      // as any URL a stranger chose (`FJS-681`).
      try { await assertPublicUrl(body.endpoint) }
      catch (err) { throw new BadRequest(`endpoint refused: ${(err as Error).message}`) }

      const data = {
        userId,
        p256dh:     keys.p256dh as string,
        auth:       keys.auth as string,
        userAgent:  ctx.caller?.userAgent ?? null,
        lastSeenAt: new Date(),
      }
      const held = await rows().findFirst({ where: { endpoint: body.endpoint }, withDeleted: true })
      if (held?.deletedAt) await rows().restore({ where: { id: held.id } })
      const row = held
        ? await rows().update({ where: { id: held.id }, data })
        : await rows().create({ data: { ...data, endpoint: body.endpoint } })
      return { id: row.id, endpoint: row.endpoint, userAgent: row.userAgent, lastSeenAt: row.lastSeenAt, createdAt: row.createdAt }
    },

    async remove(ctx: ServiceContext) {
      const userId = me(ctx)
      refuseDelegated(ctx, ctx.user as { support?: unknown }, "retire one of this account's push subscriptions")
      const id = Number(ctx.id)
      const { count } = Number.isInteger(id)
        ? await rows().removeMany({ where: { id, userId } })
        : { count: 0 }
      if (!count) throw new NotFound(`No push subscription ${String(ctx.id)}`)
      return { id }
    },
  })
}
