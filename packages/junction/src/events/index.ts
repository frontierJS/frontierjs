// events/index.ts
// In-process event bus — typed, async, ordered delivery.
// Interface designed to swap Redis pub/sub in Phase 2
// without changing a single line of application code.

// ─── IEventBus interface ─────────────────────────────────────────────────
// This is the contract. App code imports this type only.

export type EventHandler<T = unknown> = (data: T) => Promise<void> | void

export interface IEventBus {
  emit<T = unknown>(event: string, data?: T):                    Promise<void>
  on<T = unknown>(event: string, handler: EventHandler<T>):      () => void   // returns unsubscribe fn
  once<T = unknown>(event: string, handler: EventHandler<T>):    () => void
  off(event: string, handler: EventHandler):                     void
  clear(event?: string):                                         void
  /** Subscribe to ALL events, receiving the event name and data.
   *  Unlike on('*', ...), the handler receives the actual event name,
   *  making it suitable for logging, auditing, and webhook fan-out. */
  onAny(handler: (event: string, data: unknown) => void):        () => void
  /** True if anything is listening — for `event` specifically, or via
   *  '*' / onAny wildcards. With no argument: true if ANY listener exists.
   *  Lets hot paths skip event-object allocation entirely when nobody
   *  is subscribed (the common case for telemetry). */
  hasListeners(event?: string):                                  boolean
  /** How many are listening, and to what.
   *
   *  `hasListeners` answers a yes/no, which is the wrong question for anyone
   *  looking at a missing announcement: *the bus is idle* and *four things are
   *  subscribed to three events* are the same answer. The handler map is
   *  closure-private, so an operations screen could not count them (`FJS-143`).
   *
   *  The two wildcard channels are reported under their own keys rather than
   *  spread across the event names they would receive, because a subscriber to
   *  everything is a different fact from a subscriber to one thing. */
  stats():                                                       EventBusStats
}

export interface EventBusStats {
  /** Subscriber count per event name, including `'*'` and `'__any__'`. */
  events: Record<string, number>
  /** Every subscriber on the bus, wildcards included. */
  total:  number
}

// ─── In-process implementation ────────────────────────────────────────────

export function createEventBus(): IEventBus {

  // Map of event → Set of handlers
  // Using Set preserves registration order and makes removal O(1)
  const handlers   = new Map<string, Set<EventHandler>>()
  const onceSet    = new WeakSet<EventHandler>()

  function getOrCreate(event: string): Set<EventHandler> {
    let set = handlers.get(event)
    if (!set) {
      set = new Set()
      handlers.set(event, set)
    }
    return set
  }

  return {

    // ── emit ─────────────────────────────────────────────────────
    // Delivers to all handlers concurrently, then '*' wildcard handlers.
    // Errors in handlers are caught and logged — never crash the emitter.

    async emit<T = unknown>(event: string, data?: T): Promise<void> {

      // Deliver to event-specific handlers then wildcard — avoid array alloc
      // by processing each set directly
      for (const key of [event, '*']) {
        const set = handlers.get(key)
        if (!set?.size) continue

        let toRemove: EventHandler[] | null = null
        const promises: Promise<void>[] = []

        for (const handler of set) {
          const result = (() => {
            try { return handler(data) } catch (err) {
              console.error(`[EventBus] Error in handler for "${event}":`, err)
              return undefined
            }
          })()
          if (result && typeof (result as Promise<void>).then === 'function') {
            promises.push(
              (result as Promise<void>).catch(err =>
                console.error(`[EventBus] Error in handler for "${event}":`, err)
              )
            )
          }
          if (onceSet.has(handler)) {
            if (!toRemove) toRemove = []
            toRemove.push(handler)
          }
        }

        if (promises.length) await Promise.all(promises)

        if (toRemove) {
          for (const h of toRemove) { set.delete(h); onceSet.delete(h) }
        }
      }

      // Notify onAny() subscribers — only allocate envelope if listeners exist
      const anyHandlers = handlers.get('__any__')
      if (!anyHandlers?.size) return

      const envelope = { __event: event, __data: data }
      const anyPromises: Promise<void>[] = []
      for (const handler of anyHandlers) {
        const result = (() => {
          try { return handler(envelope) } catch (err) {
            console.error(`[EventBus] Error in onAny handler for "${event}":`, err)
            return undefined
          }
        })()
        if (result && typeof (result as Promise<void>).then === 'function') {
          anyPromises.push(
            (result as Promise<void>).catch(err =>
              console.error(`[EventBus] Error in onAny handler for "${event}":`, err)
            )
          )
        }
      }
      if (anyPromises.length) await Promise.all(anyPromises)
    },

    // ── on ───────────────────────────────────────────────────────
    // Returns an unsubscribe function — clean, no magic strings needed.

    on<T = unknown>(event: string, handler: EventHandler<T>): () => void {
      getOrCreate(event).add(handler as EventHandler)
      return () => this.off(event, handler as EventHandler)
    },

    // ── once ─────────────────────────────────────────────────────

    once<T = unknown>(event: string, handler: EventHandler<T>): () => void {
      const h = handler as EventHandler
      onceSet.add(h)
      getOrCreate(event).add(h)
      return () => this.off(event, h)
    },

    // ── off ──────────────────────────────────────────────────────

    off(event: string, handler: EventHandler): void {
      handlers.get(event)?.delete(handler)
    },

    // ── clear ────────────────────────────────────────────────────

    clear(event?: string): void {
      if (event)
        handlers.delete(event)
      else
        handlers.clear()
    },

    // ── onAny ────────────────────────────────────────────────────
    // Calls handler with (eventName, data) for every emitted event.
    // Implemented by wrapping on() with a typed '*' listener that
    // receives an { __event, __data } envelope from emit().
    // We achieve this cleanly by subscribing to the internal _any channel.

    onAny(handler: (event: string, data: unknown) => void): () => void {
      const wrapped: EventHandler = (payload) => {
        const p = payload as { __event: string; __data: unknown }
        handler(p.__event, p.__data)
      }
      return this.on('__any__', wrapped)
    },

    // ── hasListeners ─────────────────────────────────────────────

    hasListeners(event?: string): boolean {
      if (handlers.get('__any__')?.size) return true
      if (handlers.get('*')?.size)       return true
      if (event !== undefined) return !!handlers.get(event)?.size
      for (const set of handlers.values()) {
        if (set.size) return true
      }
      return false
    },

    // ── stats ────────────────────────────────────────────────────

    stats(): EventBusStats {
      const events: Record<string, number> = {}
      let total = 0
      for (const [event, set] of handlers) {
        // An event whose last handler unsubscribed keeps an empty Set — off()
        // deletes the handler, not the key. Reporting it would say something
        // is subscribed to an event nothing is subscribed to.
        if (!set.size) continue
        events[event] = set.size
        total += set.size
      }
      return { events, total }
    }
  }
}
