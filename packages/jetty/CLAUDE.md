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
  (`FJS-059`) — and the orchestrator around them is deliberately separate:
  Sierra calls `client.service(name)`, this calls `harbor.request('service:call')`,
  which is two facts rather than one with two owners. **`createStore` is also
  jetty's own**: Sierra's is service-backed and stamps each request, this one
  takes no service at all, because Junction lives in Harbor. Do not "resync"
  either against Sierra.
- **`mergeHooks` answers a NEW map**, re-exported from `resources/index.js`. It
  merged in place before; toolbelt's licence is purity, so both callers reassign.
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
- **Nothing here can talk to a real Junction yet** (`FJS-279`). `default-adapter.js`
  says it is a placeholder, and the gap is wider than that: its envelope
  (`{ kind: 'call' | 'subscribe' | 'event' }`) is not Junction's
  (`{ type: 'event', event, data }` / `service_call`), and Junction's browser
  client exposes no `subscribe(channel)` for `adapter.js`'s contract to bind to.
  So the event-name fix above is correct and still unobservable end to end.

## Proving a change

`bun run test` (all ten phases), plus `bun run build:fixture` and loading the
result — the failure above is exactly the kind a build that "succeeds" hides.
