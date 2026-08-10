// src/components/widgets/live.js
// One place that answers "was that a read?" for a widget.
//
// Every screen in this app filters service events so a reload does not answer
// its own refetch forever. A dashboard holds up to sixty cards over eight
// different services, so the filter is here rather than copied into each widget
// — a read method missing from one copy is a card that reloads in a loop, and
// the symptom is a page that never settles rather than an error.
//
// The set is method names across every service a widget reads. `find` and `get`
// are junction's; the rest are this app's read-shaped custom actions, which
// already set `ctx.dispatch = false` server-side — this is the browser's half of
// the same fact, for the events that do arrive.

const READS = new Set([
  'find', 'get',
  'usage', 'feed', 'events', 'members', 'resolve', 'kinds', 'scopes',
])

export function isRead(method) {
  return READS.has(method)
}

/**
 * Reload when something WRITES through this service.
 *
 * Returns the unsubscribe function, which the caller hands to $onDestroy — a
 * widget removed from a board that kept listening would reload data for a card
 * nobody can see.
 */
export function onWrite(service, reload) {
  return service.on('*', (method) => {
    if (isRead(method)) return
    reload()
  })
}
