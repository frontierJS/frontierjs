# jetty — package map

**A browser-extension app container.** Mesa UI in the extension surfaces, a
service worker relaying to Junction. `bun run test` runs the eleven phase files
in order under **plain node** — not vitest — except phase 3, which runs under bun
because it boots a real Junction app.

Its vocabulary is its own: **Harbor** (service worker), **Dock** (popup),
**Island** (content script), **Pier** (unlisted page), Options.
**jetty's "islands" are not Sierra's islands** — same word, different mechanism.

---

## Layout

```
src/
  define/        the five entrypoints — harbor · dock · island · pier · options
  build/         index.js (discovery → auto-gen → manifest → Vite) ·
                 discover · auto-gen · manifest · vite-config · config-loader ·
                 mesa-plugin · uno-plugin
  dev/           orchestrator · server (dev WS) · dev-client · dev-plugin ·
                 browser-launcher (web-ext) · classifier · watch (fs.watch,
                 settled per path) · fjs-ports.js
  island/        runtime · registration · page-script (MAIN world) · unocss-mirror
  junction/      adapter contract · junction-adapter (the real one) ·
                 default-adapter (PLACEHOLDER) · auth · schema-cache
  browser/       cross-browser API shim · permissions · idb
  audit/         permission audit — scan source for chrome.* / browser.* use
  resources/     harbor-app (the handle sierra's createResource takes as
                 `app`) · active-port (the page's port and Harbor's session)
                 · mesa-bridge (that session as Mesa signals)
  peer.js        loadPeer — vite and ws are the APP's, not jetty's
bin/             build-ext.js · dev-ext.js
test/            phase0 … phase9 (11 files, incl. phase2.5)
```

**`packages/cli/core/ports.js` owns the whole-repo port scheme**;
`src/dev/fjs-ports.js` documents this package's own slice of it —
`[env][category][project][service]`, extensions at 8400–8499 dev / 7400–7499 test.
It is the only place that scheme is written down.

---

## What bites here

- **An app gets this package as the `extension/` surface** — a sub-project at the
  app root beside `api/`, `web/` and `widgets/`, with the same six folders
  (Invariant 3). `fli make:extension` writes it; `fli extension:{dev,build,audit}`
  wrap the `jetty-*` binaries with `--root` pointed at it. That layout is the
  reason **the Mesa compiler lookup walks UP from both roots**: an app has one
  `package.json`, at its root, so the install is never at
  `extension/node_modules` and the two fixed guesses this used to make found
  nothing. The failure was silent and then misleading — stub mode passes the
  `.mesa` through as JavaScript and Vite reports `Unexpected JSX expression` at
  line 1 of the component.
- **The fixture's dock is real Mesa, and must stay that way.** It was plain
  JavaScript in a `.mesa` file, which built only because the compiler was never
  found — so the suite's only Mesa surface proved that Mesa never ran, and the
  lookup bug lived under it. If a change here makes that file "simpler", the
  compiler path is untested again.
- **An island is built in LIB MODE, and that is not cosmetic.** Vite injects its
  preload helper into any client build that is not a lib or a worker, and the
  helper is written with `import.meta`. A content script is a *classic* script,
  so V8 rejects the whole bundle at parse time and nothing at build time says
  so. Lib mode is the only supported way off it (`FJS-030`).
- **`codeSplitting` is a rollup OUTPUT option.** `build.codeSplitting` is read
  by nothing — set it under `rollupOptions.output` or the island silently
  splits into a chunk Chrome will not load.
- **`default-adapter.js` is a placeholder**, and says so. Do not build on it as
  though it were the contract; `adapter.js` is.
- **`uno-plugin.js` and `unocss-mirror.js` predate Invariant 13** (no UnoCSS
  anywhere). Removing them is in scope; adding to them is not.
- **A page's Resource is SIERRA's, over a client that relays** (`FJS-D650`).
  `createResource(name, { app: harborApp() })`. `harborApp()` is a Junction
  client created with `relay`, so each call leaves as the `service_call` frame
  the socket would have carried, `service:call` hands it to Harbor, and Harbor's
  own client makes it with `forward()`. The live store, query matching, `stale`
  and the patch baseline are therefore sierra's and junction's, with nothing
  here to reload. Three things are not obvious. **A service's channel is joined
  on its first call, BEFORE the call leaves**, so a push between the answer and
  the join cannot fall in the gap. **Every return to connected is a `connected`
  frame**, and every one after the first emits `reconnected`, because Harbor's
  worker may have been stopped in between. **A call only HTTP can carry** (a
  file, a filtered bulk write, a findFirst) is refused by the client by name.
  Sign-in stays `login()`/`logout()` here, because Harbor owns the token.
- **A refusal crosses the port as `_error`, `_code` and `_data`**, and
  `PagePort.request` rebuilds `err.code` and `err.data`. A chrome port carries
  JSON, so an Error arrives as `{}`, and the message alone left a page unable to
  tell a 409 from a 400 or to put a field's message under its box.
- **The build installs sierra's `localDbPlugin` on pages and islands** whenever
  sierra resolves. The Resource reaches the device database through a
  `new Worker(new URL(…))`, which is a static signal: without the stub the
  litestone browser client (1.1 MB) is emitted, and an inlined island carries an
  `import.meta.url` that a classic content script refuses at parse.
- **The HMR algorithm is not duplicated**: the DOM swap is Mesa's
  (`@frontierjs/mesa/vite/swap`, `FJS-259`) and only the registry and the two
  module shapes are jetty's.
- **A channel is not an event, and the separator is not decoration.** You join
  `posts` and RECEIVE `posts created` — space, past tense, Junction's own
  `AUTO_EVENT_MAP`. A colon is the IN-PROCESS BUS spelling (`FJS-059`). **The
  event name is carried the whole way** — adapter → `channel-registry.fanOut` →
  `channel:event` → `PagePort.subscribe` handler as `meta.event` →
  `client.receive()`, which splits it as the socket's own handler does. Drop it
  at any hop and nothing reaches the store at all.
- **The real adapter is `junction-adapter.js`, and `default-adapter.js` is still
  a placeholder.** `createJunctionAdapter` (`@frontierjs/jetty/junction`) wraps
  `@frontierjs/junction/client`, so there is one implementation of the
  transport, the token, the reconnect and the result envelope rather than a
  second written to the same protocol. Junction is an OPTIONAL peer, so the
  import is dynamic. Three things about it are not obvious: **`url` is spelled
  differently by the two packages** (jetty's config field has always been
  `wss://`, the client takes an http origin and derives the socket, and handing
  one over unchanged builds `wsss://`); **a subscription is a FILTER**, because
  membership is the server's and what arrives is `client.on('event', name)`;
  and **`isConnected()` is about the client, not the socket** — every call falls
  back to HTTP, so answering `false` mid-reconnect would stop Harbor hydrating a
  session it can hydrate. `fetchSchema()` answers null and says why.
- **Sign-in is `adapter.auth`, not `call('auth', …)`.** Junction has no service
  by that name — `@frontierjs/auth` registers `account`, `sessions` and
  `api-keys`, and establishing a session is a ROUTE (`FJS-D20`) — so the
  pseudo-service the placeholder invented would shadow the methods of an app
  that has one. `makeAuthFlow` prefers the block and falls back to the call.

## Proving a change

`bun run test` (every phase), plus `bun run build:fixture` and loading the
result — the failure above is exactly the kind a build that "succeeds" hides.
`test/phase3.test.js` is the relay end to end: a PagePort, Harbor's real router,
`createJunctionAdapter` and a real Junction app, with the port serializing
through JSON.

**And `example`: `verify:extension`**, the only place an extension is loaded
into a browser profile. A fake Junction here is the mock that hid `FJS-279` for as long
as it existed, so the adapter's behavior in a browser is proved there.
