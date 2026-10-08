// ─── the broadcast vocabulary ────────────────────────────────────────────────
//
// What a mutation's event is CALLED, and which hooks announce one. Two facts,
// both of which the service layer and the transport layer have to agree on —
// and both of which used to live on the far side of the wall from one of their
// readers, so `core/service.ts` and `transport/channels.ts` imported each other
// at runtime and could not be loaded apart (`FJS-1181`).
//
// Nothing here imports anything. That is the whole point: a fact two layers
// share belongs below both of them, not in whichever one happened to need it
// first.

/**
 * Auto-event names for the CRUD write methods.
 *
 * Read by BOTH emitters. It has to be: this map produced `posts:created` on
 * `app.events` while `announce()` derived its own name straight from
 * `ctx.method` and put `posts create` on the wire. The browser client listens
 * for the past-tense form, so every WS consumer was matching names the server
 * never sent.
 */
export const AUTO_EVENT_MAP: Record<string, string> = {
  create:  'created',
  update:  'updated',
  patch:   'patched',
  remove:  'removed',
  restore: 'restored',
}

/**
 * The events whose whole meaning is *this row is gone from your store*.
 *
 * Derived from the map above rather than spelled again, so a rename moves both.
 * Read by the fan-out's window carve: an `@@expires` row may suppress a frame
 * about a row that has stopped counting, and it may never suppress one of
 * these — a subscriber holding the row has no other way to learn it is gone,
 * and a suppressed removal strands it there for ever.
 */
export const REMOVAL_EVENTS: ReadonlySet<string> = new Set([AUTO_EVENT_MAP.remove])

// Every hook `announce()` ever produced. A service that declares `channel:` is
// already announced by callService, so a announce hook on the same service sends
// the frame a second time — and a name check cannot tell the two apart, because
// an app is free to call its own hook `announce`. Marking is what makes the
// conflict detectable (`FJS-045`).
const announceHooks = new WeakSet<Function>()

/** Mark a hook as one `announce()` made. Returns it, so it can wrap the return. */
export function markAnnounceHook<T extends Function>(hook: T): T {
  announceHooks.add(hook)
  return hook
}

/** Did `announce()` make this hook? */
export function isAnnounceHook(fn: unknown): boolean {
  return typeof fn === 'function' && announceHooks.has(fn as Function)
}
