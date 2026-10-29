// The plugin's own state on the app object.
//
// It used to be two enumerable `_db` / `_drivers` properties, under a comment
// claiming they were symbol-keyed to stay off the app surface. They were not:
// they enumerated, they serialized, and `app.notify` on an app that never
// configured the plugin read `undefined._drivers` and threw a TypeError about
// a property nobody had heard of.

import type { App, NotificationDriver } from './types.ts'

/**
 * `Symbol.for`, not `Symbol` — two copies of this package in one dependency
 * tree must find one state, or the second plugin's drivers are invisible to
 * the first one's `notify`.
 */
export const STATE = Symbol.for('frontierjs.notifications.state')

export interface NotificationsState {
  db:      unknown                          // Litestone client, duck-typed
  drivers: Map<string, NotificationDriver>  // by transport name
}

export type NotifyingApp = App & { [STATE]?: NotificationsState }

export function setState(app: App, state: NotificationsState): void {
  (app as NotifyingApp)[STATE] = state
}

/** Read the plugin's state, or say which plugin is missing. */
export function stateOf(app: App): NotificationsState {
  const state = (app as NotifyingApp)[STATE]
  if (!state) {
    throw new Error(
      '[notifications] this app has no notifications state — ' +
      'app.configure(notifications({ db })) has not run on it.'
    )
  }
  return state
}

/** Whether a driver is registered under `transport` -- for an app deciding
 *  WHO to address before it sends. `false` on an app the plugin never ran on:
 *  the question is "can this leave on push", and on that app nothing can. */
export function hasTransport(app: App, transport: string): boolean {
  return (app as NotifyingApp)[STATE]?.drivers.has(transport) ?? false
}
