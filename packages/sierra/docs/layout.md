# Sierra — layout

The file-by-file map of the package, moved verbatim from `CLAUDE.md`; the short map is there.

```
src/
  index.js               — public entry: the router and the theme, nothing else

  scanner/               — routes dir → route tree
    walk.js              recursive directory walk; follows a symlink, and a
                         `*.mount.js` into the directory it names (`FJS-D282`)
    classify.js          what each file is (page, layout, error, …)
    parse-frontmatter.js frontmatter, via @frontierjs/toolbelt/frontmatter
    build-tree.js        the node tree
    generate-route-table.js  writes config/routes.js (a build: routes.build.js); routeTablePath() owns the path

  tools/                 — the `sierra` bin, never imported by app code
    cli.js               `sierra routes` / `sierra widgets` / `sierra mcp` /
                         `sierra site` — dispatch, --check. `mcp` refuses a
                         missing or relative `--out`: the views belong to
                         `api/`, and only `fli mcp:build` knows where it is
    routes-snapshot.js   the committed routes.snapshot.md
    tui.js               `@frontierjs/sierra/tui`, what `fli dev:tui` runs —
                         under BUN, from the web root: --list, --frame, --api,
                         --side, --open. Interactive, it runs the shell in a
                         CHILD of itself and starts another at the url the
                         router's `reload()` named, so an edit is imported fresh

  terminal/              — the terminal target of `web/` (`FJS-D809`): the same
                           routes, compiled with `target: 'terminal'`
    loader.js            a Bun plugin — `.mesa` through `prepareForCompile`,
                         `@/` through `appSrcDir`, `sierra/router` rewritten to
                         `router/index.js` (`FJS-2271`) — and `lowers(file)`,
                         which compiles a route and its `.mesa` imports WITHOUT
                         running them, since a route's module runs its
                         resources at import
    shell.js             the boot (`virtual:sierra`'s Junction + schemas half),
                         the route list, and Sierra's own router over a memory
                         History: a route mounts where the router lands, a
                         link is `followLink`. No layout or autoImport yet
    Shell.mesa           the heading, a note and the list, compiled by the same
                         loader; `state` is a signal's read, since a prop's `$:`
                         watch is local and would not hear the shell. Also the
                         keys' mode (`FJS-D987`): a text field is INSERT, Esc
                         is NORMAL, where `i` or `a` types again. shell.js renames
                         h/j/k/l to the arrows in NORMAL before any mount sees
                         the key; a j/k the page does not prevent moves focus.
                         Ctrl+P is the jump: a `<dialog>` over any screen,
                         the listed routes ranked by toolbelt's `rank`, its
                         field INSERT and its keys stopped there (a scene
                         walks on window keys); from a route it `goto`s, so
                         Esc comes back. `side` (`--side`) is a component in
                         mesa's `sideOf`, mounted on the first Ctrl+\ and
                         kept while hidden; Ctrl+O crosses, and where the page
                         would keep under 120 columns an open side is ZOOMED:
                         one pane drawn full width, the one holding focus, and
                         Ctrl+O swaps. A page's own
                         command shows it through mesa's `sideToggle()` (`true` only shows),
                         which the shell fills. Both keys are
                         taken before any mount, since a field binds most Ctrl
                         letters, and in the side Esc and h/j/k/l are its own.
                         Every key the shell takes is a toolbelt keymap stepped
                         where it is taken (`FJS-D1396`), and `?` in NORMAL is
                         a `<dialog>` of `bindings()` over the ones active now,
                         the page's `keys()` hosts first (`keymapsAt`).
                         `<C-p>`, `?`, `i a /` and the h/j/k/l rename are
                         mesa's `setShellKeys` step: AFTER every keymap the
                         page declares and before the keydown, so a page's
                         pending `f` takes the `a` after it (`IDEAS/keys.md`
                         3.5); NORMAL is `text()` false there. A focused
                         control whose `keys()` answers a mode (ui's
                         Textbox) is followed (`kept`, mesa's `modeAt`), and
                         `i a /`, Esc and the letter guard are its own
                         (`FJS-D1411`)
    Mode.mesa            the mode line, mounted in mesa's `footerOf` so a page
                         taller than the screen does not scroll it away

  serve/                 — what the two static servers share
    http-answers.js      what HTTP itself requires of any origin handing back
                         bytes — a wrong verb, a range, an encoding — shared by
                         site/serve.js and widget/serve.js, which answer almost
                         everything else differently on purpose
    served-path.js       what file a URL names, and whether it is inside the
                         root — one question, two servers, written twice with a
                         hole in each copy before this

  site/                  — the `site/` surface's origin
    serve.js             the static server that surface deploys with — a
                         directory index, a cache answer per file kind, the
                         site's own 404.html served with a 404, and the
                         `_redirects` the build wrote — read at start and again
                         when its mtime changes (a rebuild in place), parsed by
                         `postbuild/redirects.js`, and refused there at start
                         for a rule shape it cannot answer
                         Takes `functions` (the entry `postbuild/functions.js`
                         wrote, as a path or as the imported module) and
                         mounts it BEFORE the verb check, since a function
                         answers POST
    compile.js           a built site and serve.js as ONE executable, the
                         `functions` entry imported statically so it embeds
                         (`sierra site --compile`, `fli site:build --binary`).
                         Bun's embedded filesystem has no directories and
                         renames every file with a hash, so serve.js takes a
                         `files` map and judges headers by the PUBLISHED name;
                         `test/site-compile.test.js` asserts the binary answers
                         what the directory does
    cloudflare.js        the Cloudflare adapter, the one file naming Cloudflare,
                         and `deploySite()`, the one caller of wrangler (`FJS-D1684`):
                         `.sierra/wrangler.json` derived from `siteUrl` and the
                         build (`FJS-D1213`), and `.sierra/worker.js` when there
                         are functions — `run_worker_first` lists their paths
                         only, since Workers otherwise serves a same-path page
                         before the script. Reads a finished build, and refuses
                         the other kind: a dist carrying `data-fjs-loc` is a
                         `preview: true` build and ships only as a preview
                         version, aliased by `previewAlias` (`FJS-D1221`)

  widget/                — the `widgets/` surface's runtime and its origin
    index.js             the embed runtime: a custom element (and a selector,
                         for host pages that cannot be edited), a shadow root,
                         `data-*` as props
    serve.js             the static server the surface deploys with — CORS, and
                         a cache answer per file kind

  mcp/                   — the runtime inside an MCP App view (`@frontierjs/sierra/mcp`)
    index.js             `startView(View, { name, module })`, what every built
                         entry calls: `ui/initialize` (its `hostContext` to the
                         theme), `initialized`, then the first `tool-result`'s
                         row read through the file's Resource — the relay
                         answers that one `get` from the row in hand, whatever
                         the file's `detailQuery` asks (3.7), so
                         `_call` still records the read and a save diffs
                         against it — and mounted as `record`; size reported
                         on a ResizeObserver; teardown unmounts. A refusal, a
                         cancel or an unspellable read is said IN THE PAGE,
                         since a sandbox shows no console. `submitInPlace()`
                         dispatches a form's submit itself: a frame without
                         `allow-forms` drops the browser's before `<Form>`
                         hears it, and says so only in Chrome's own log
                         (`FJS-2849`).
                         `mountView`, the mount it ends in; `resourceIn(module, name)`, the file's
                         Resource picked off its exports for the generated form
                         (known by `save` + `formFields`, two objects refused);
                         `applyHostContext(ctx)`, the host's `theme` handed to
                         the switch as a scheme — a key absent from a
                         `host-context-changed` is a key unchanged;
                         and `mcpApp()` — the PAGE's client installed through
                         `initJunction({ relay })`, each call a `tools/call`
                         built by `toolCall()`, the plugin's `invoke()` read
                         backwards. What no tool spells (a call option, a
                         directive on a by-id call, an unknown `$` key) is refused by name,
                         never dropped; `base` alone rides, as `_meta`. A view
                         holds no write — `isRelayed()` (session.js) turns the
                         device machinery off, as `connectApp()` does — and
                         a `@@sync(field)` save still carries the row it read
                         (plan 3.6). A view opens NO socket — a host
                         relays results, never a push — so its tether is its
                         own calls' answers and its `stale` count stays 0.
                         `toolAnswer()` throws a refusal as HTTP does —
                         `code` the status, `data` the plugin's
                         `structuredContent` — so `toFieldErrors` reads it
    host.js              JSON-RPC 2.0 to `window.parent` over postMessage —
                         `'*'` out, only the host's `event.source` read back;
                         `on(method)` answers the host's requests (`-32601`
                         for one with no handler) and hears its notifications

  router/                — the runtime router
    index.js, match.js, internals.js (used by RouterView.mesa),
    signals.js, prefetch.js, page-fields.js (the fields the router owns on `page`),
    memory-history.js    `createMemoryHistory` — the address `initRouter({ history })`
                         reads and writes where there is no window (the terminal)

  build/                 — the Vite side
    index.js             createSierraViteConfig — start here
    app-alias-plugin.js  `@` → the surface's own src/, based on the VITE ROOT
    auto-import-plugin.js  components and named bindings available in every
                         .mesa file with no import statement, from configured
                         directories and packages
    glob-expand.js       an eager `import.meta.glob` as the static imports it
                         stands for — the prerender's, which runs outside Vite
                         (`FJS-1521`)
    app-import.js        importing the app's own modules at BUILD time — the
                         Litestone client `config.db` names, and a route's
                         `.meta.js` companion (`FJS-551`)
    static-data-plugin.js  dev only — a prerendered route's load(), run in Node
    mesa-plugin.js       Mesa compilation + reactivity hints; `prepareMesaSource`
                         is what a .mesa becomes before Mesa sees it
    functions-plugin.js  dev only, `static` target with `functions:` — the
                         directory read per request and answered ahead of
                         Vite's SPA fallback; each file `importFresh`ed, not
                         `ssrLoadModule`d
    devline-plugin.js    dev only, under `fli dev` (`FLI_DEV`) — Vite's boot banner
                         replaced by the ready line `fli dev` lays out; INFO is
                         held until `printUrls()` would have printed, a warning
                         never is. `mesa-plugin.js` prints its hints as marked
                         warnings under the same variable
    ask-plugin.js        dev only — turns on `@frontierjs/cli`'s ask panel when
                         the app has the cli, resolved from the Vite root
    mesa-check.js        `@frontierjs/sierra/check` — compile without building,
                         for `fli check`'s `mesa-compiles` (`FJS-1228`)
    scanner-plugin.js    runs the scanner
    schema-plugin.js     .lite → client-side model schemas, and the DEVICE
                         schema litestone's `deviceSchema()` filters out of the
                         same parse result
    local-db-plugin.js   the bytes a local database needs: the app's own
                         `@sqlite.org/sqlite-wasm` copied into the output and
                         the device schema emitted beside it. The entry is
                         copied as `.js` — a dynamic `import()` of a `.mjs` a
                         host serves as anything but JavaScript is refused
                         outright, with nothing said. `localDbWorkerPlugins`
                         is what the WORKER is built with, and it stubs
                         litestone's parser out of it (`FJS-2318`)
    slot-rewrite.js      named slots only (`page.slots`); the default `<slot />` is Mesa's to lower
    prerender.js         routes declaring `render: static` → HTML
    document-shell.js    a static app's `document` applied to index.html, dev and build
    island-bundle.js     one chunk per island the static build needs
    prune-unreachable.js what a static build may publish: the emitted pages walked;
                         `bundleUnreachable` says so from the tree BEFORE the
                         bundle, and the postbuild plugin's `config` hook then
                         skips JS minify and the gzip report — a third of a
                         site's build, spent on chunks the prune deletes. The
                         prune refuses if that prediction kept a chunk.
    widget-build.js      one self-contained IIFE per widget in src/Embeds/
    mcp-build.js         one HTML document per resource file in src/resources/ —
                         an MCP App view, the widget loop one host over: a boot
                         (schemas + relay client) imported FIRST by a generated
                         entry, the stylesheet and the script folded into the
                         document at generateBundle, the output pruned to agree
                         with src/resources/ (`IDEAS/agent-client-ui.md` § The
                         plan, 2.1; `FJS-D955` for where it lands). A file
                         with no markup half gets a generated `.mesa` — the
                         kit's `<Form>` over the file's own Resource — mounted
                         in its place; `hasMarkupHalf` asks Mesa's parser, not
                         a regex, since a `'</script>'` literal in a script
                         reads as the end of it and the rest as markup.
                         `buildViewsFor(config)` is `sierra mcp`'s body: the
                         plugin list, schema, `<html>` class and theme read off
                         the config by the SPA's own functions
    static-safety.js     proves a prerendered page is publishable
    refusal.js           an error that prints as its message alone — for a
                         build verdict about the APP, where a stack is noise
    warnings.js, dev-overlay.js

  resource/              — the Resource: a screen bound to a service
    index.js             WebSocket client integration; `connectApp()`, the
                         handle a Resource over ANOTHER app is built from
    session.js           who the browser thinks you are — the reactive object,
                         the boot restore, the client's own verbs (signIn /
                         completeSignIn / signUp / verifyEmail / signOut,
                         `FJS-D1315`), and `ready`.
                         A RELAYED page (an MCP view) has a principal and no
                         credential, so its level is null, never STRANGER
    resource.js          createResource — coerce → blankToNull → validate
    tethered.js          resource.tethered() — the one door a screen lists rows
                         through (`FJS-D1318`): where a list's state lives, its
                         load and re-run, and the window. Imports the router.
                         The tether, `load`, `more` and `stale` it is built
                         from are not resource keys; this package's suites
                         reach them through `tetherOf(resource)` in resource.js
    SupportBanner.mesa   `@frontierjs/sierra/components/SupportBanner` — the
                         "acting as another user" banner, drawn from
                         `session.user.support` alone, Stop = `endSupport` then
                         `refresh()`. Plain css classes, since the kit is above
                         this package; lives here, not in `components/`,
                         because it reads the session (Navigation may not)
    record.js            resource.record() as a component reads it — `value`,
                         `loaded` and `error()` tracked; released by a ROOT,
                         because a `$:` re-run disposes the effects it made and
                         a view kept across re-runs would go deaf
    palette-source.js    `paletteSource` — junction's `search` hits as
                         `CommandPalette` rows; a link defaults to
                         `/<service>/<id>` lowercased, as the scanner
                         serves it, and may answer a promise, because a
                         hit carries no column a parent route could be read off
    field-rules.js       schema → field rules; the control table and the
                         registry over it; toFieldErrors. LEAF: no client import
    schema-registry.js   modelNameFor / schemaFor, over `createSchemaRegistry()` —
                         the page's own app is the default instance, and
                         `connectApp()` (index.js) makes one per other app
    pending.js           the writes this device made and the server has not
                         confirmed — queue-first, cleared on an ACK and never on
                         a send, drained on the socket's `connect`. Held only for
                         a model that declares `@@sync`. Owns `unreachable`, the
                         question *did the server hear this*
    list-cache.js        what a screen last saw, so an outage is not an empty
                         page. Answers on SILENCE and never on a refusal, keyed
                         by the QUESTION rather than the model, and only for a
                         model that declared `@@sync` — rows on a disk outlive
                         the session, so it is the app's word
    local-db.js          the device's own SQLite as the read store, when the
                         app says `offline: { db: true }` (`FJS-D307`). Writes
                         through on a successful load and answers the catch
                         BEFORE the list cache, because SQL can answer a
                         question this screen never asked — but an EMPTY
                         answer defers to the cache, which may hold the server's
                         own answer to the same question, where a device holds
                         nothing until a write-through has landed. Read through
                         `asSystem()`: a cache replays what the server already
                         gave this caller and does not re-decide it (`FJS-D309`).
                         **`orderBy` and `select` are translated by junction and
                         may not be spelled here** — SQLite throws on the wire's
                         `-id`, and the throw fell through to the cache, so the
                         whole feature was off and green (`FJS-1179`).
                         **A write lands the row the DEVICE can hold, not the
                         one the server answered** (`FJS-2249`): `@from` and the
                         other server-owned columns are left off, and a
                         `select`ed slice is merged over the held row (one it
                         does not hold is skipped); a slice with no key takes
                         nothing off
    local-db-open.js     one line, its own module — `new Worker(new URL(…))` is
                         a STATIC signal, so written inline it put the whole
                         litestone client in every app. The build stubs this
                         out when no database was asked for
    local-db-worker.js   the worker body: litestone's, under a relative path a
                         bundler can resolve
    offline.js           the reads a screen must already HOLD — a resource's
                         `offlineQuery`, warmed at boot and on every `connect`
                         (`FJS-D307`). Writes through `find` and never `load`,
                         because a warm runs under a question nobody is looking
                         at and `load` sets the tether the screen is rendering.
                         Keyed by `listKey`, the cache's own function: a second
                         derivation would fill a slot nothing reads and say
                         nothing until the outage. **The same rows go into the
                         device's tables when an app has them, and that is the
                         whole of hydration** — no second option, because the
                         rows and the model are already in scope. `kept` is in
                         the report because the cache answers the declared
                         question whether or not a row ever reached the device
    attachments.js       the BYTES, which are not a row (`FJS-D301`) — its own
                         IndexedDB DATABASE, so a quota failure cannot take the
                         writes down with it. Drains AFTER pending.js, as an
                         ordinary patch naming the row, which is why it only
                         works on a key the browser minted. Imported dynamically
                         by pending.js (so the dependency stays one-way) AND by
                         resource.js — a static import in either puts the blob
                         queue in every app's main chunk (`FJS-2752`)

  islands/loader.js      — find island markers in prerendered HTML and mount
  postbuild/             — sitemap, redirects, llms.txt, 404, theme, defer, markdown,
                           inject-analytics.js: the vendor tag on a static page,
                           read from analytics/tag.js, which the runtime reads too,
                           manifest.js: can a browser INSTALL the build, and
                           functions.js: the host-function directory → one entry
                           (`.sierra/functions.js`), its routes, and the
                           requestFrom/sendResponse, the node-to-web bridge (`FJS-D919`),
                           function-handler.js: the handler a host mounts,
                           importing NOTHING, because the Worker bundles it,
                           headers.js: `cacheFor`, the site's cache rule, which
                           serveSite sends and a static build writes as
                           `_headers`; each rule after `/*` detaches before it
                           states, since Cloudflare joins two matches with a
                           comma. A `preview: true` build adds `noindex` to `/*`. `headerUnder` reads it as Cloudflare does,
                           hashed-asset.js: is this name content-addressed —
                           the one answer both servers and `_headers` share,
                           here because the build may not import `serve/`,
                           offline-shell.js: sw.js + a precache list derived
                           from what this build emitted (`offline: true`);
                           `push: true` adds the push + notificationclick
                           handlers, and alone writes it with no precache and
                           no fetch handler (`FJS-D1442`).
                           Sierra writes that one because only the build knows
                           its own hashes; the app writes its manifest because
                           a manifest is a declaration
  devtools/              — the dev toolbar; plugin.js is what `devtools:` installs
  presence/  theme/  analytics/  fetch/  virtual/
  components/            — RouterView.mesa, ChainRenderer.mesa

bench/                   — `bun run bench`: brotli bytes per target, the last step
  run.mjs                of `test`. Counted by `../cli/core/bench.js`, the one byte
  bench.baseline.json    measurer for a built surface (`FJS-D1070`). Ratchets down:
  fixtures/              --update, --adopt. floor-spa · floor-static (its index.html
                         is a page with no island, so `static.firstLoadJsBrotli`
                         is 0) · floor-widget. Built in `bench/dist/`, since the
                         scanner writes into the Vite root
```
