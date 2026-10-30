# Sierra — package map

**UI meta-framework.** File-tree routing → a route table, a Vite build over the
Mesa compiler, `createResource` for talking to Junction, prerendering for the
`static` target, and a postbuild pipeline. Depends on Junction and Litestone
outputs; **nothing here may be imported by them** (Invariant 1).

`bun run test` — the runner is **vitest**. `bun run test:safety` is separate and
runs against a real Litestone client.

---

## Where things are

`docs/layout.md` is the file-by-file map; read it when a change touches a file
this list does not name. The owners that matter on most turns:

- `src/index.js` public entry — the router and the theme, nothing else · `src/scanner/` routes dir → route tree (`walk.js`, `classify.js`, `build-tree.js`, `generate-route-table.js` writes the committed `config/routes.js`).
- `src/router/index.js` is the runtime router and owns `page`; `match.js`, `prefetch.js`, `page-fields.js`, `memory-history.js` (the terminal's address).
- `src/resource/resource.js` is `createResource` — coerce → blankToNull → validate; `tethered.js` is the one door a screen lists rows through; `session.js` who the browser thinks you are; `field-rules.js` is a deliberate leaf; `index.js` is `connectApp()`.
- `src/build/index.js` is `createSierraViteConfig` — start there; `mesa-plugin.js`, `app-alias-plugin.js`, `auto-import-plugin.js`, `schema-plugin.js`, `prerender.js`, `static-safety.js`, `widget-build.js`, `mcp-build.js`.
- `src/postbuild/` is sitemap, redirects, llms.txt, 404, theme, `manifest.js`, `headers.js`, `hashed-asset.js`, `offline-shell.js`, `functions.js` + `function-handler.js`.
- Surfaces with their own origin: `src/site/` (`serve.js`), `src/widget/`, `src/mcp/`, `src/terminal/` (`loader.js`, `shell.js`, `Shell.mesa`); `src/serve/` is what the two static servers share; `src/tools/` is the `sierra` bin and `tui.js`.
- `bench/` is the byte measurer (`run.mjs`, `bench.baseline.json`, `fixtures/`), counted by `../cli/core/bench.js`.

## What bites here

The dozen-odd that bite most; the full catalog is `docs/hazards.md`, read it
before touching the router, a resource, the build, prerender or a surface.

- **Sierra's edge is three axes and a host** (`FJS-D649`): Navigation, Build, Resource, plus `virtual:sierra`. **Resource may import Navigation and never the reverse** (`FJS-D651`); a new `src/` directory fails `test/edge.test.js` until classified.
- **Route matching is CASE-SENSITIVE** (`FJS-D210`).
- **The router commits the navigation last STARTED, not the last to finish.**
- **`beforeNavigate` runs on the Back button** (`FJS-789`), and **a link's `href` resolves against the CURRENT page**.
- **Inside a watch on `page.*`, read `page.*`** — not a `$:` value derived from it.
- **`@` is the SURFACE's src/, and it is resolved twice** — once by Vite, once by the prerender outside it.
- **A patch carries what CHANGED against the row this screen READ**; `save({ mode: 'auto' })` asks whether the row EXISTS and the schema decides; **neither the baseline nor the `@version` moves on a push**.
- **A create and a patch are judged by DIFFERENT rule tables**, and `createResource` coerces, blank-strips and validates by default.
- **The URL's search string is `page.query` + `page.directives`**, split by the toolbelt table; **a tether means the query that filled it** (`matchesQuery`).
- **`find()` answers the list envelope; `findData()` is the rows.**
- **`session` is the UI half of auth; the wire half is `client.auth`.** `junction.cookieAuth` is declared on both sides or the app is signed out; a trailing `*` in `auth.publicRoutes` is a SEGMENT boundary; `sierraFetch` attaches the session to the app's OWN origin and nothing else.
- **Nothing a resource holds may outlive the person it was read for.**
- **`widgets/` and `site/` are Vite ROOTS of their own** (Invariant 3); a widget is N builds and `vite build` is not what makes them; `target: 'static'` is the SPA config plus a prerender pass; a prerendered route must prove its data is publishable.
- **In a terminal process `typeof window` is `'object'`** and nothing else of a browser is there.
- **The HMR boundary, its browser client and the inspector are MESA'S**; **a missing auto-import does not fail a build** — only the bundle separates *injected* from *silently skipped*.

## The contexts in this package

**Two, and only one of them is per-invocation** (`FJS-D03`).

**`page`** — the router's, in `router/index.js`. A plain object made reactive by
a `$:` path watch; there is no cross-package signal registry.

| | |
| --- | --- |
| Created per | **navigation** — mutated in place through the router's write handle so path watches fire |
| Carries | `pathname`, `search`, `hash`, `params`, `query`, `directives`, `meta`, `route`, `pending`, `data`, `error`, `slots` — **plus the route's frontmatter spread onto it**, so `{page.title}` works |
| Reserved | those twelve names. Frontmatter using one is shadowed and the scanner warns |

Two crossings with the API realm, both worth stating outright:

- **`page.params` is path captures — the same thing Junction calls `ctx.route`.**
  One word per realm, deliberately: `params` is what every router a person has
  used calls it, and in Junction that word carries Feathers' *whole context bag*
  meaning, which is how a role check reads `undefined` and passes.
- **`page.route` is the matched route NODE**, not captures. So `route` means
  different things in the two realms; `params`/`route` do not line up and are not
  meant to.

`page.query` and `page.directives` are split by the same `@frontierjs/toolbelt/directives`
table the API bridge uses, so `resource.tethered()` reading them is a
filtered, sorted, paged list that lives in its URL (Invariant 10).

**The resource hook context** — `createResource`'s pipeline, in
`resource/resource.js`. Per **operation**, and it deliberately mirrors the API
realm's phases (`before` / `after` / `around` / `error`). It carries `service`,
`model`, `method`, `id` and the call's own data — it is a *different object* from
a `ServiceContext` that answers the same shape, because it runs in a browser with
no principal and no transport.

**It has no `params`, and its scratch is `locals`.** Same noun and same rule as
Junction's: fresh `{}` per call, never sent, and it exists because `before` and
`after` are separate functions — anything one decides and the next needs has
nowhere else per-call to live. A closed-over variable is the wrong shape (two
`find()` in flight share it); an `around` hook and a signal is the right shape
for a whole-call concern like a loading flag.

**One word each.** `params` is path captures, `locals` is scratch, and the second
argument to `find`/`load`/`getOptions` — like the field on the hook context and
junction's own `QueryDirectives` (`FJS-290`) — is **`directives`** (Invariant 10).
`optionsQuery`, `detailQuery`, `tetheredQuery` and `offlineQuery` all take `{ query, directives }`, declared beside
the model rather than at every call site (`FJS-D114`) — and `tetheredQuery` reaches `tethered()` alone, never a
bare `find()`, because a default filter there would narrow every picker and job in silence. The write is
`save(data, { mode })`, the one owner of create-or-patch, which `<Form>` calls
rather than picking a service method.

---

## Proving a change

`bun run test` + `bun run test:safety`, then in `example/`: `verify` and
`verify:build` for router/resource/build; `verify:site` for anything touching
prerender, islands or static-safety. **`bun run test:widgets` for anything
touching `src/widget/` or `build/widget-build.js`**; `test/mcp-build.test.js` runs a
REAL build of one resource file for `build/mcp-build.js`, `test/mcp-relay.test.js`
the relay's tool table and the handshake against a stand-in parent window, and `example`'s `verify:mcp-view` runs a built view in ext-apps' reference host on a third origin. `test:widgets` builds the fixture and
drives a plain host page in Chrome (its strict-CSP page in Firefox too), which is the only place shadow isolation,
custom element upgrade and a delegated click inside a shadow root are decidable.
**`bun run test:connect-app` for `connectApp()` or a Resource built with `{ app }`** — a bundled page over a hosted app, and the socket at `url` + `/ws` through a forward that upgrades it; `test/connect-app.test.js` has no socket.
**`bun run test:installable` for `postbuild/manifest.js`** — the grader restates
Chrome's install rules, and only Chrome can say whether it still restates them.
The root `docs/TESTING.md` has the full map.

<!-- layout-named: the file names fli done grades a new module against, kept here because done.js reads this file by path. The map itself is docs/layout.md.
app-alias-plugin.js app-import.js ask-plugin.js attachments.js auto-import-plugin.js 
bench.baseline.json build-tree.js ChainRenderer.mesa classify.js cli.js cloudflare.js 
compile.js dev-overlay.js devline-plugin.js document-shell.js field-rules.js 
function-handler.js functions-plugin.js functions.js generate-route-table.js glob-expand.js 
hashed-asset.js headers.js host.js html.js http-answers.js index.html index.js index.mesa 
inject-analytics.js internals.js island-bundle.js list-cache.js loader.js local-db-open.js 
local-db-plugin.js local-db-worker.js local-db.js manifest.js match.js mcp-build.js 
memory-history.js mesa-check.js mesa-plugin.js Mode.mesa offline-shell.js offline.js 
page-fields.js palette-source.js parse-frontmatter.js pending.js plugin.js prefetch.js 
prerender.js prune-unreachable.js record.js redirects.js refusal.js resource.js RouterView.mesa 
routes-snapshot.js routes.js run.mjs scanner-plugin.js schema-plugin.js schema-registry.js 
script.js serve.js served-path.js session.js shell.js Shell.mesa sierra.config.js signals.js 
slot-rewrite.js static-data-plugin.js static-safety.js SupportBanner.mesa tag.js tethered.js 
tui.js ui.js vite.config.js walk.js warnings.js widget-build.js 
-->
