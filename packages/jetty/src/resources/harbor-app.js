// harbor-app.js — the app a page reaches through Harbor, as sierra's Resource
// takes it.
//
//   import { createResource } from '@frontierjs/sierra/resource'
//   import { harborApp }      from '@frontierjs/jetty/resources'
//   export const orders = createResource('orders', { app: harborApp() })
//
// A page holds no connection — MV3 keeps it in the service worker — so the
// client here RELAYS (`@frontierjs/junction/client`'s `relay`): each call goes
// to Harbor as the frame the socket would have carried, Harbor's own client
// makes it with `forward()`, and pushes come back through `receive()`. That is
// what lets the page run sierra's Resource itself — the live store, matching,
// `stale`, the patch baseline — rather than a copy of it that drifts
// (`FJS-D650`). Anything only HTTP can carry is refused by the client by name.
//
// One handle per realm: a page, a pier and each island is its own JS realm with
// one active port, so module state is the right scope.

import { createJunctionClient } from '@frontierjs/junction/client'
import { createSchemaRegistry } from '@frontierjs/sierra/resource'
import { getActivePort, onConnectionChange, getConnectionState } from './active-port.js'

let _handle = null

/**
 * The handle `createResource(name, { app })` takes — `{ client, registry, user }`.
 *
 * `registry` starts empty, so a resource is given its schema or names none:
 * `createResource('orders', { app, schema })`, or `harborApp().registry.register(…)`
 * once with what `generateSchemas()` emits. `user` is whoever Harbor's session
 * says, read at the moment a create seeds an `auth()` column.
 */
export function harborApp() {
  if (_handle) return _handle

  // Which channels each port has been asked for. A port is replaced when an
  // island remounts, and the new one has joined nothing.
  const watched = new WeakMap()

  const client = createJunctionClient({
    relay(call) {
      const port = getActivePort()
      if (!port) {
        return Promise.reject(new Error(
          `[jetty] ${call.service}.${call.method}: no active port — call a resource after the page mounts`))
      }
      watch(port, call.service)
      const { service, method, ...args } = call
      return port.request('service:call', { service, method, args })
    },
  })

  // The channel is joined BEFORE the call that loads the list leaves, so a
  // push between the answer and the join cannot fall in the gap. A port
  // re-joins its channels itself after a reconnect.
  function watch(port, service) {
    let set = watched.get(port)
    if (!set) watched.set(port, set = new Set())
    if (set.has(service)) return
    set.add(service)
    port.subscribe(service, (data, meta) => client.receive({ type: 'event', event: meta?.event, data }))
  }

  // Every return to connected is a `connected` frame, and every one after the
  // first emits `reconnected`: Harbor's worker may have been stopped in between,
  // and a live list reloads rather than trusting it heard everything.
  let up = false
  onConnectionChange((state) => {
    if (state.connected && !up) client.receive({ type: 'connected' })
    up = !!state.connected
  })

  _handle = {
    client,
    registry: createSchemaRegistry(),
    get user() { return getConnectionState().user },
  }
  return _handle
}
