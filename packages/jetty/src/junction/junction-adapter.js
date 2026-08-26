// The real Junction adapter — Harbor's side of the wire.
//
// `default-adapter.js` beside this one is a placeholder and says so, and the
// gap was wider than that word: its envelope is `{ kind: 'call' | 'subscribe' |
// 'event' }` and Junction's is `{ type: 'event', event, data }` / `service_call`.
// So nothing here could talk to a real Junction at all (`FJS-279`) and jetty's
// only proof of the channel layer was a mock that spelled its own event names.
//
// This wraps `@frontierjs/junction/client`, which is the browser client every
// Sierra app already uses — one implementation of the transport, the token, the
// reconnect and the result envelope, rather than a second one written to the
// same protocol. Junction is an OPTIONAL peer of this package, so the import is
// dynamic: an extension that talks to something else never resolves it.
//
// ── What is not obvious ───────────────────────────────────────────────────
//
//   · **`url` may be written either way.** jetty's config field has always been
//     spelled `wss://…` and Junction's client takes an HTTP origin and derives
//     the socket from it. Both are accepted here; sending an app's `wss://` URL
//     to `createJunctionClient` gives `wsss://` and a socket that never opens.
//
//   · **There is no `subscribe(channel)` on the client, and there does not need
//     to be.** Junction pushes `{ type: 'event', event: 'orders created' }` and
//     the client re-emits it as `client.on('event', (name, data) => …)`. A
//     channel is the first half of that name, so a subscription is a filter.
//     Membership is the SERVER's decision — `app.channel(name).join(…)` — which
//     is why there is nothing to send.
//
//   · **`isConnected()` is about the client, not the socket.** Every call falls
//     back to HTTP when the socket is down, so answering `false` while the
//     socket reconnects would stop Harbor hydrating a session it can perfectly
//     well hydrate. The socket's own state is on the `connect`/`disconnect`
//     lifecycle events.
//
//   · **Auth is `adapter.auth`, not `call('auth', …)`.** Junction has no service
//     by that name — `@frontierjs/auth` registers `account`, `sessions` and
//     `api-keys`, and sign-in is a ROUTE (`FJS-D20`) — so a pseudo-service would
//     collide with any app that has one. See `makeAuthFlow`, which prefers this
//     block and falls back to the old call for the placeholder adapter.

/** `wss://host/path` → `https://host/path`; an http(s) URL is returned as-is. */
export function httpOrigin(url) {
  if (typeof url !== 'string') return url
  if (url.startsWith('wss://')) return 'https://' + url.slice(6)
  if (url.startsWith('ws://'))  return 'http://'  + url.slice(5)
  return url
}

/**
 * Build an adapter over the real Junction browser client.
 *
 * Handed the whole `junction` block from jetty.config.js, the same as every
 * other adapter factory — so `url`, `apiPrefix`, `authPrefix` and `callHeaders`
 * are read from there and anything else is passed through to the client.
 */
export function createJunctionAdapter(config = {}) {
  const { url, tokenKey, adapter: _ignored, ...clientOptions } = config

  let client    = null
  let connected = false

  // Junction's own `on()` hands back an off function; these are the ones we
  // registered on the caller's behalf and have to release on disconnect.
  const offs = []

  function need() {
    if (!client) throw new Error('[jetty] junction adapter: call connect() first')
    return client
  }

  function svc(name) { return need().service(name) }

  return {
    // ── Connection ────────────────────────────────────────────────────
    async connect(opts = {}) {
      const target = httpOrigin(opts.url ?? url)
      if (!target) throw new Error('[jetty] junction adapter: no url')

      if (!client) {
        const { createJunctionClient } = await import('@frontierjs/junction/client')
        client = createJunctionClient({
          ...clientOptions,
          url:   target,
          token: opts.token ?? null,
          // Harbor owns the token — it persists it under `tokenKey` in
          // extension storage, which a service worker has and `localStorage`
          // is not. Letting the client store it too gives two copies with no
          // rule about which one a cold wake trusts.
          tokenStorage: null,
        })
      } else if (opts.token !== undefined) {
        client.setToken(opts.token ?? null)
      }

      connected = true

      // The socket is opened eagerly rather than on first call: a channel
      // subscription is a filter over pushed frames, so a Harbor that never
      // calls anything still has to be listening.
      client.connect()
      return
    },

    async disconnect() {
      for (const off of offs.splice(0)) { try { off() } catch {} }
      client?.disconnect()
      connected = false
    },

    isConnected() { return connected },

    async setToken(token) {
      need().setToken(token ?? null)
    },

    // ── Calls ─────────────────────────────────────────────────────────
    //
    // `args` is the envelope `resources/resource.js` builds, and the mapping is
    // one line each. `params` is Junction's FindParams — kept structured on the
    // way here, flattened to `$limit`/`$orderBy` by the client, which is the one
    // owner of that spelling (Invariant 10).
    async call(service, method, args = {}) {
      const s = svc(service)
      switch (method) {
        case 'find':   return s.find(args.query ?? {}, args.params)
        case 'get':    return s.get(args.id, args.params)
        case 'create': return s.create(args.data, args.params)
        case 'patch':  return s.patch(args.id, args.data, args.params)
        case 'remove': return s.remove(args.id, args.params)
        // Everything else is a custom method, `restore` included: it is a
        // Litestone capability rather than one of the six, and it reaches a
        // service under its own name like any other.
        default:       return s.invoke(method, args.id ?? null, args.data ?? {}, args.query)
      }
    },

    // ── Auth ──────────────────────────────────────────────────────────
    auth: {
      async login(credentials = {}) {
        const c = need()
        const r = await c.auth.signIn(credentials.email, credentials.password)
        // `signIn` has already adopted the token onto the client; Harbor still
        // needs it back, because Harbor is what survives the page.
        return { token: r?.token ?? c.token, user: r?.user ?? null, expiresAt: null }
      },

      async logout() {
        await need().auth.signOut()
        return { ok: true }
      },

      /**
       * Is this stored token still a session?
       *
       * The token is put on the client BEFORE asking, because `me()` is an
       * ordinary authenticated service call and there is no other way to ask
       * on behalf of a token the client is not already holding.
       */
      async verify(token) {
        const c = need()
        c.setToken(token ?? null)
        try {
          const user = await c.auth.me()
          return user ? { user, expiresAt: null } : null
        } catch (e) {
          c.setToken(null)
          throw e
        }
      },
    },

    // ── Channels ──────────────────────────────────────────────────────
    async subscribe(channel, handler) {
      const c = need()
      // `orders created` → channel `orders`, event `orders created`. The whole
      // name is handed on: a channel carries many events, and a subscriber
      // given only the data cannot tell a create from a remove (`FJS-059`).
      const off = c.on('event', (name, data) => {
        if (typeof name !== 'string') return
        if (name.slice(0, name.indexOf(' ')) !== channel) return
        handler(data, name)
      })
      offs.push(off)
      return () => {
        const i = offs.indexOf(off)
        if (i !== -1) offs.splice(i, 1)
        off()
      }
    },

    on(event, fn) {
      const off = need().on(event, fn)
      offs.push(off)
      return off
    },

    // ── Schema ────────────────────────────────────────────────────────
    //
    // Null rather than a guess. A Sierra app gets its JSON Schema at BUILD time
    // (`registerSchemas`, off `db/schema.lite`) and Junction serves `/manifest`
    // only in development, so there is no runtime endpoint to ask. An extension
    // that wants `make()` and client-side field rules registers the schema the
    // same way a page does, at build time — see `example/extension/`.
    async fetchSchema() { return null },
    async getServerSchemaVersion() { return null },
  }
}
