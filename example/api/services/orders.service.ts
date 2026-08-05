import { createBaseService } from '@frontierjs/junction'
import type { ServiceContext } from '@frontierjs/junction'

// Orders declare @@transitions, and Litestone enforces the machine at the Data
// boundary. What this file adds is a way to ASK for a move by name.
//
// ─── Why these are actions and not four more columns to PATCH ─────────────
//
// `PATCH /api/orders/3 {"status":"paid"}` already works and is already refused
// when the move is illegal — the machine does not care how you arrive. But a
// PATCH says "set this field to this value" and a transition is not that: it is
// "run this named move, if it is legal from where the row is now". Litestone's
// `transition()` narrows the UPDATE with the expected state in the WHERE, so two
// callers racing the same move produce one winner and one
// TransitionConflictError rather than two silent successes. A PATCH cannot
// express that.
//
// Naming a move also means the gate can be per-move: `refund` wants level 5,
// `ship` does not, and no model-level @@gate can say that — a PATCH to `status`
// is one operation with one gate whatever value it carries.
//
// ─── How they are routed ──────────────────────────────────────────────────
//
// Any function on a service definition that is not a known option key becomes a
// custom action, dispatched as POST /{service}/{id} with an
// `X-Service-Method: {name}` header. The browser calls them through
// `resource.service.action(name, id)`. Nothing here registers a route.
//
// A custom action's ctx is a SERVICE context: `ctx.id` is the row and
// `ctx.locals.db` the per-request Litestone client that withLitestoneDb scoped
// to the caller — so the gate sees the real user, not a system bypass.

type ScopedDb = { order: { transition(id: unknown, name: string): Promise<unknown> } }

/** One move. Litestone owns every rule about it; this only names it. */
const move = (name: string) => async (ctx: ServiceContext) => {
  const db = (ctx.locals as { db?: ScopedDb } | undefined)?.db
  if (!db) throw new Error('no scoped db on ctx.locals — is withLitestoneDb installed?')
  // Which states this is legal from, what it moves to, and what level it needs
  // are all in db/schema.lite. An illegal move throws TransitionViolationError
  // (409), a lost race TransitionConflictError (409), too low a level
  // TransitionGateError (403) — each carries its own status.
  return db.order.transition((ctx as ServiceContext & { id?: unknown }).id, name)
}

export function createOrdersService() {
  return createBaseService({
    channel: 'orders',

    // The names match @@transitions in the schema. They are written twice —
    // once there, once here — which is the seam worth watching: an action
    // naming a move the schema does not declare answers 400
    // TransitionNotFoundError rather than inventing one.
    pay:    move('pay'),
    ship:   move('ship'),
    refund: move('refund'),
    cancel: move('cancel'),
  })
}
