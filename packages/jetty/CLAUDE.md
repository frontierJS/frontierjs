# jetty — package map

**A browser-extension app container.** Mesa UI in the extension surfaces, a
service worker relaying to Junction. `bun run test` runs **plain node** over ten
phase files in order — not bun, not vitest.

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
                 browser-launcher (web-ext) · classifier · fjs-ports.js
  island/        runtime · registration · page-script (MAIN world) · unocss-mirror
  junction/      adapter contract · default-adapter (PLACEHOLDER) · auth ·
                 schema-cache
  browser/       cross-browser API shim · permissions · idb
  audit/         permission audit — scan source for chrome.* / browser.* use
  resources/     jetty's own copy of Sierra's resources layer
bin/             build-ext.js · dev-ext.js
test/            phase0 … phase8
```

**`src/dev/fjs-ports.js` documents the whole-repo port scheme** —
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
- **`resources/` is no longer a copy of Sierra's, and what is left is not one.**
  The pure halves are `@frontierjs/toolbelt` — `/jsonschema` and `/hooks`
  (`FJS-059`), `/match` (`FJS-493`) — and the orchestrator around them is
  deliberately separate:
  Sierra calls `client.service(name)`, this calls `harbor.request('service:call')`,
  which is two facts rather than one with two owners. **`createStore` is also
  jetty's own**: Sierra's is service-backed and stamps each request, this one
  takes no service at all, because Junction lives in Harbor. Do not "resync"
  either against Sierra.
- **`mergeHooks` answers a NEW map**, re-exported from `resources/index.js`. It
  merged in place before; toolbelt's license is purity, so both callers reassign.
- **A hook that breaks the chain throws `ResourceHookError` rather than
  answering `null`.** An `around` that forgets `next()`, one that catches the
  failure and does not rethrow, and an `error` hook that clears `ctx.error`
  without setting a result all end the pipeline with nothing having produced an
  answer — and `null` is what the context is born with, so a screen read it as
  one. The test is the ASSIGNMENT, not the value (`null` is a real answer for a
  missing row), which is why `ctx` comes from `hookContext` and not a literal.
  A deliberate short-circuit still works: set `ctx.result`.
- **The HMR algorithm is not duplicated either**: the DOM swap is Mesa's
  (`@frontierjs/mesa/vite/swap`, `FJS-259`) and only the registry and the two
  module shapes are jetty's.
- **A channel is not an event, and the separator is not decoration.** You join
  `posts` and RECEIVE `posts created` — space, past tense, Junction's own
  `AUTO_EVENT_MAP`. `resources/` used to subscribe to four composed names
  (`posts:created`, …): a colon is the IN-PROCESS BUS spelling, and there is no
  channel per event to subscribe to, so none of the four could ever match
  (`FJS-059`). One subscription now, and the event decides what to do with what
  arrives — `wireEventMethod()` splits it, and anything that does not split
  answers null rather than guessing. **The event name is carried the whole way**
  — adapter → `channel-registry.fanOut` → `channel:event` → `PagePort.subscribe`
  handler as `meta.event`; drop it at any hop and a remove reads as an upsert,
  which puts a deleted record back on screen until reload.
  `test/phase3.test.js` reads `AUTO_EVENT_MAP` out of Junction's source rather
  than restating it — a vocabulary asserted only against itself is how this
  drifted, and the old test PINNED the bug instead of catching it.
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
- **A pushed record is GRADED, and the store is what remembers the question.**
  A record is an announcement about a ROW; a live list is the answer to a QUERY,
  and nothing on the wire says a row has left a filter — there is no such event
  — so upserting whatever arrives put a shipped order back into the queue it had
  just left (`FJS-493`). `@frontierjs/toolbelt/match` decides: in the filter
  upsert, out of it REMOVE, undecidable RELOAD. Two things follow. **`store.set()`
  clears the remembered query** — rows put there by hand are not the answer to
  the last `populate()`'s question — and `null` is not `{}`, since an empty
  filter admits every row while *nobody has asked yet* can grade none. **The
  reload is coalesced onto a microtask**, because a burst of undecidable pushes
  arrives together and every answer but the last is thrown away by the next.
  The field table is `fieldShapes` off the schema the resource was GIVEN, and
  `{}` where it was given none — the same fallback Sierra takes on a registry
  miss, degrading one way: a string operand against a numeric column reads as no
  match.

## Proving a change

`bun run test` (every phase), plus `bun run build:fixture` and loading the
result — the failure above is exactly the kind a build that "succeeds" hides.

**And `example`: `verify:extension`**, which is the only place this package
talks to a real Junction and the only place an extension is loaded into a
browser profile. A fake Junction here is the mock that hid `FJS-279` for as long
as it existed, so the adapter's WIRE behavior is proved there and only its
shape is asserted in `test/phase2.test.js`.
