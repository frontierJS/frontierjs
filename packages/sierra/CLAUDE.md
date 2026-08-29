# Sierra — package map

**UI meta-framework.** File-tree routing → a route table, a Vite build over the
Mesa compiler, `createResource` for talking to Junction, prerendering for the
`static` target, and a postbuild pipeline. Depends on Junction and Litestone
outputs; **nothing here may be imported by them** (Invariant 1).

`bun run test` — the runner is **vitest**. `bun run test:safety` is separate and
runs against a real Litestone client.

---

## Layout

```
src/
  index.js               — public entry

  scanner/               — routes dir → route tree
    walk.js              recursive directory walk
    classify.js          what each file is (page, layout, error, …)
    parse-frontmatter.js YAML frontmatter
    build-tree.js        the node tree
    generate-route-table.js  writes config/routes.js

  tools/                 — the `sierra` bin, never imported by app code
    cli.js               `sierra routes` / `sierra widgets` / `sierra site` —
                         dispatch, --check
    routes-snapshot.js   the committed routes.snapshot.md

  serve/                 — what the two static servers share
    hashed-asset.js      is this filename content-addressed? The only answer
                         both servers give the same way — every other cache
                         answer they give is deliberately different

  site/                  — the `site/` surface's origin
    serve.js             the static server that surface deploys with — a
                         directory index, a cache answer per file kind, and the
                         site's own 404.html served with a 404

  widget/                — the `widgets/` surface's runtime and its origin
    index.js             the embed runtime: a custom element (and a selector,
                         for host pages that cannot be edited), a shadow root,
                         `data-*` as props
    serve.js             the static server the surface deploys with — CORS, and
                         a cache answer per file kind

  router/                — the runtime router
    index.js, match.js, internals.js (used by RouterView.mesa),
    signals.js, prefetch.js, page-fields.js (the fields the router owns on `page`)

  build/                 — the Vite side
    index.js             createSierraViteConfig — start here
    app-alias-plugin.js  `@` → the surface's own src/, based on the VITE ROOT
    static-data-plugin.js  dev only — a prerendered route's load(), run in Node
    mesa-plugin.js       Mesa compilation + reactivity hints
    scanner-plugin.js    runs the scanner
    schema-plugin.js     .lite → client-side model schemas
    slot-rewrite.js      compile-time slot rewriting
    prerender.js         routes declaring `render: static` → HTML
    island-bundle.js     one chunk per island the static build needs
    widget-build.js      one self-contained IIFE per widget in src/Embeds/
    static-safety.js     proves a prerendered page is publishable
    warnings.js, dev-overlay.js, devtools-plugin.js

  junction/              — the API seam
    index.js             WebSocket client integration
    session.js           who the browser thinks you are — the reactive object,
                         the boot restore, signIn/signOut, and `ready`
    resource.js          createResource — coerce → blankToNull → validate
    field-rules.js       schema → field rules; the control table and the
                         registry over it; toFieldErrors. LEAF: no client import
    schema-registry.js   modelNameFor / schemaFor

  islands/loader.js      — find island markers in prerendered HTML and mount
  postbuild/             — sitemap, redirects, llms.txt, 404, theme, defer, markdown
  devtools/  presence/  theme/  analytics/  fetch/  virtual/
  components/            — RouterView.mesa, ChainRenderer.mesa
```

---

## What bites here

- **On a static target, dev shows the site with its data now — but the loader
  runs on the SERVER, and the server must be bun.** A `render: static` route's
  `load()` is build-time by definition and its companion may never enter the
  browser graph (`FJS-543`: following one there published a storefront's
  Litestone client, the DDL emitter and the migration engine as fetchable files
  on a public origin). That left `vite dev` rendering every page with
  `data: null` — correct, and identical to a query that found nothing.
  `static-data-plugin.js` runs the loader where the build already runs it: in
  Node, in the dev server, at `/__sierra/static-data`, and the browser gets JSON.
  What the client table emits for those routes is a **fetch shim, never an
  import** — that is the whole safety argument, and it is asserted on the shape
  in `tests/scanner-plugin.test.js` rather than trusted.
  **Two things about it are not obvious.** It imports the companion with a plain
  `import()` keyed on the file's mtime, NOT `server.ssrLoadModule`: Vite's SSR
  runner rewrites the module and does not provide Bun's `import.meta.dir`, so
  `example`'s own db module dies on `join(undefined, …)` before a query is made.
  And the dev server therefore has to be `bun --bun vite`, exactly as
  `build:site` always has been — under node it fails as *Only URLs with a scheme
  in: file, data, and node are supported — received protocol `bun:`*, which
  names nothing an app author did. `dev: { staticData: false }` is the way back.

- **`@` is the SURFACE's src/, and it is resolved twice.** A surface is a Vite
  root, so `@/api.js` in `web/` and in `site/` are different files;
  `app-alias-plugin.js` is the one definition and its base is the Vite root, not
  the cwd. It had been `resolve(process.cwd(), 'src')` for its whole life, which
  is the same directory only when a command is typed inside the surface —
  `build:site` does `cd site` and works, `vite -c web/config/vite.config.js`
  from the app root does not, and there `@` pointed at an `example/src` nothing
  ever created. Nothing said so: a missing alias TARGET is not an error, it just
  falls through to Node, which reports `Cannot find package '@'` and reads as a
  missing dependency. No app in this repo had ever written a `@/` import, so
  the alias shipped broken and unused.
  **The prerender is the second resolver** — it compiles a page and imports it
  under Node, which has no aliases at all — so `prerenderRoutes` hands the same
  table to `renderComponent({ alias })`. One base, two resolvers; a page that
  builds and runs in the browser dies in the static build without the second.
  It reaches the island bundle and the widget build too, since both are separate
  Vite builds handed their own `root`. What `@` cannot say is a sibling of
  `src/`: `extension/src/harbor/index.js` reaching `../../config/jetty.config.js`
  stays relative, because the alias is rooted at `src`.

- **Inside a watch on `page.*`, read `page.*` — not a `$:` value derived from
  it.** Both react to the same change and the order between them is not a
  guarantee, so a `load()` that reads the derivation sends the PREVIOUS query.
  Measured in basecamp's `/servers/`: the first click on a sortable header
  wrote `$orderBy=name` into the address bar and asked the server for no sort
  at all; the second click asked for the first one. The list trails the URL by
  one action, and it presents as a wrong sort DIRECTION rather than as a stale
  read.

- **The `@version` a patch carries is the one this screen READ, and a push does
  not move it.** Recorded off every call result and off a `load()` that was not
  superseded — never off the store. Recording off the store was the right answer
  to the wrong question: a WS push reaches it as an upsert and never passes
  through a call result, but it moves the number while moving nothing the person
  is looking at, so a save from a screen holding a DRAFT carried a revision
  nobody there had read and won the race optimistic locking exists to lose.
  Measured in basecamp — the other person's write erased, the guard in place, no
  error anywhere (`FJS-341`). `load()` carries its own stamp because a store
  notification has no provenance: a `set()` from a winning load and an `upsert()`
  from a push arrive as the same event, and junction's stamp (`FJS-082`) governs
  the store, not this. The cost is a 409 where a silent success used to be, and
  it is the correct answer; a caller who really has read the newer revision
  states it, which `<Form record={row}>` already does by editing the row whole.
  **`resource.conflict(err)` is what makes that 409 something a screen can act
  on** — `{ model, field, expected, actual }`, the numbers `fieldErrors()`
  deliberately replaces with a sentence, for a *reload* against *overwrite*
  prompt.

- **The route table is committed, because a naming convention leaves no other
  trace.** `sierra routes --config config/sierra.config.js` writes
  `routes.snapshot.md` — every URL with the file behind it, the layout the
  scanner resolved (or none, where the page declared `reset`), the meta a layout
  pushed onto every page under it, and on a `static` target `publishes:` in its
  own section ahead of the routes, because that is the line that turns the
  publish check off. `--check` is the CI half (`snapshots` phase). **Run it from
  the app's WEB ROOT** — `routesDir` is relative to Vite's root, never to where
  the config file sits (Invariant 3), and CI reruns the command from the
  snapshot's own directory. One config is one target, and the config's name
  carries into the snapshot's: `sierra.static.config.js` →
  `routes.static.snapshot.md`, so two targets cannot overwrite each other.
- **`createResource` coerces, blank-strips and validates by default.** A create
  that used to 400 at the server now throws `ResourceValidationError` in the
  browser with no request made, and an untouched text box writes NULL not `''`.
  Opt out with `{ validate: false }` — the test is `!== false`, so a
  threaded-through `undefined` does not disarm it.
- **The URL's search string is `page.query` + `page.directives`, and `page.params`
  is path captures alone.** The same split the API boundary makes, over the same
  table (`@frontierjs/toolbelt/directives`), so `resource.load(page.query,
  page.directives)` is a whole URL-driven list with nothing to translate. **The
  VALUES come from the sibling module** — `@frontierjs/toolbelt/query`, which
  Junction's transport and its client also read (`FJS-D125`). `parseQueryParams`
  used to have its own `coerce()` and inferred with `Number(value)`, so `?sku=007`
  was the number 7 — the guess this package's own widget props already refuse for
  `data-pid="007"` — while Junction's transport did not infer at all, so a filter
  typed into the URL bar and the same filter sent by the client meant different
  things and both answered a 200 (`FJS-450`). A string is a number only if
  `String(Number(v)) === v`; `?code="5"` is the escape. `buildUrl` writes with the
  same encoder, so a URL this package builds parses back as what was put in —
  dropping an EMPTY filter stays its own decision, because a filter box nobody
  typed in should not add a parameter. Both
  names are in `PAGE_RESERVED` — a route declaring `query:` in frontmatter is
  warned about rather than silently overwritten. They are only reassigned when
  the search actually changed, because a layout outlives a navigation and would
  otherwise re-ask the server on every one under it. Search params used to be
  merged into `params`, so `?id=99` on `/orders/7/` answered 99 to
  `page.params.id` (`FJS-083`).
- **A live store now means the query that filled it.** `matchesQuery(fields,
  record, query)` decides whether a pushed record is still in the list `load()`
  asked for; junction takes it as `resource(name, idField, { match })`. So a
  patch that moves a row out of the filter REMOVES it — there is no other event
  for leaving a filter, and the row used to stay, updated in place and wrong. It
  answers `true | false | null`, and `null` (a `select` that dropped the filtered
  column, a filter over a relation, `$search`, `$raw`) reloads rather than
  guessing. **A `changed` push is that same answer arrived at from the other
  end** — a bulk write or a `select: false` write announces a count and no row
  (`FJS-307`), so there is nothing for the matcher to judge and the store
  reloads. Sierra needs no wiring for it; `client.resource()` owns it. Its operators are the ones the server accepts and its null semantics
  are SQL's, not JavaScript's — that agreement is the whole reason it lives in
  the leaf module.
- **`field-rules.js` is deliberately a leaf** — no Junction-client import, so it
  runs in plain Node and can be *compared* against Junction's server rules rather
  than being a copy of them. Keep it that way. It is also why the **control
  table** lives there (`controlFor` / `formFieldList` / `labelFieldFor`): the UI
  kit peers only on mesa and css, so it asks the resource
  (`resource.formFields()`, `resource.options(fk)`) rather than importing this
  package, and `@frontierjs/ui`'s own form suite imports the real table by
  relative path instead of deciding for itself what a `Float` is.
- **A write drops the columns the server owns, and `@version` is the one that
  must survive it.** `stripReadOnly(fields, data, { keep })` runs FIRST in
  `_call`'s create/patch pipeline — before coerce, blank and validate, so nothing
  downstream judges a value that is not going to be sent. It exists because
  `readOnly` had two readers (a generated form does not offer the control,
  `make()` does not seed it) and neither covers an edit form: that is handed a
  row the SERVER wrote, carrying every column the caller could read, and it
  writes the whole record back. The Data boundary refuses `@system` **by name**,
  so the person saw a 403 about a column that is not on their screen
  (`FJS-526`). The keep list is not a special case bolted on — the `@version`
  column is marked `readOnly` and is the one the server REQUIRES back, which is
  exactly why the rule cannot be spelled *delete every readOnly key*. A key with
  no field rule behind it is left alone; a `@transient` and a custom method's own
  argument are both legitimate, and guessing there is how a strip becomes the
  thing that breaks a working app.
- **`schema-plugin.js` loads the `.lite` with `parseFile`, because a schema may
  import another one.** It read the root file and called `parse`, so a split
  schema reached the browser as a `$defs` table with the imported models missing
  — and every step after that DEGRADES rather than fails: `modelNameFor` misses
  and warns, `createResource` falls back to a bare `make()`, and a generated
  `<Form>` renders no fields against an app that built clean (`FJS-264`). `fli
  auth:install` now writes exactly that layout, so it is the shape apps have. An
  older Litestone with no `parseFile` still works for what it could always
  handle and says so **by name** for the one case it cannot; a silent fallback
  is the same bug wearing a version number.
- **A control is two registrations, and this package owns the half that names
  it** (`FJS-D17`). `registerControl(name, resolve)` is consulted before the
  built-in table — `resolve(rule, {field, model})` answers a control name, a
  whole descriptor, or null to decline — and the last registration is the first
  asked, so an app beats the kit it imported. What it may NOT answer is a
  component: this module has to run in plain Node, so a name is the only thing
  that can cross to `@frontierjs/ui/controls`, which binds it. `readOnly`
  columns are not offered to the registry (the Data boundary refuses the write,
  so the form could not submit) and `defaultControlFor(rule)` is the built-in
  table alone, for a resolver extending rather than restating it.
- **The theme is a CLASS on `<html>`, from a list the app declares.** It used
  to be `data-theme`, which `@frontierjs/css` reads nowhere — so `setTheme`
  changed an attribute and no pixel, both apps wrote their own applier, and
  `@frontierjs/ui` shipped a second dead switcher (`FJS-308`, now deleted).
  `theme: { themes, default, system, persist, key, apply }`; `setTheme` refuses
  a name the app did not declare and prints the list. **The element is not a
  knob**: the no-flash script runs in `<head>`, where `<body>` does not exist
  yet, so a `target: 'body'` would only bring the flash back. `apply:
  'attribute'` keeps the old spelling for an app that wants it.
- **`format: date-time` answers `datetime`, not `input`.** A `Date` has no zone
  so `<input type="date">` round-trips it and a type attribute is the whole
  answer; a `DateTime` is an instant and `datetime-local` is a wall clock, so
  the value has to be converted at each edge — that is a control, and
  `@frontierjs/ui` binds the name to `DateTimeInput` (`FJS-079`). The row used
  to answer a bare text box with a comment saying why.
- **A field the table has no control for comes back with `control: null` and a
  reason** — an array, a `Json` column, a `readOnly` field, a name the model does
  not have. Filtering those out here would make a column added to `.lite`
  disappear from a form with nothing saying so, which is the bug the generated
  list exists to end.
- **`find()` answers the list envelope; `findData()` is the rows.** And the FIRST
  argument to `find` is the filter — `find({ limit: 100 })` filters on a column
  named `limit`, which matches nothing and says nothing (`FJS-109`).
- **`session` is the UI half of auth; the wire half is `client.auth`.**
  `login(token)` and `logout()` are gone — both were token plumbing wearing the
  names of the operations, and `logout()` never told the server, so a sign-out
  left the session row alive until it expired (`FJS-D20`). What stays here is
  what a wire client cannot know: a reactive object on the same contract as
  `status`, a boot restore, and `ready` — which the navigation guard AWAITS
  rather than judging on token presence, the guess that let an expired token
  render a protected page and 401 afterwards. `session.level` is the server's
  grading and is null unless the app configured `services: { level }` on the
  auth plugin.
- **A prefetch runs `load()` with `sierraFetch`, the same fetch a navigation
  uses, and its cache is dropped whenever the identity changes.** It used to use
  `window.fetch`, so a protected route prefetched signed-out and the 401 was
  cached and then served (`FJS-041`). Two rules follow for anything touching
  this file: one fetch path, and `invalidatePrefetch()` on any new place a token
  is set or cleared — payloads go, the per-URL gate goes with them, chunks stay.
- **A widget lives in its own SURFACE, `widgets/`, not in `web/`.** A peer of
  `api/` and `web/` at the app root, with the same six folders and its own Vite
  root — every path in `widgets/config/sierra.config.js` is relative to it, and
  `sierra widgets` is run from there. The separation is not tidiness: the config
  is a different target, the tests are host pages rather than routes, and the
  release is static files on an origin a stranger's page links to, shipped when
  the pages embedding it are ready. An app may have this surface and no `web/`.
  `fli make:widget <Name>` creates it; `core/widget-surface.js` in the CLI owns
  its shape.
- **A widget is N builds, not one, and `vite build` is not what makes them.**
  A widget is loaded by a `<script src>` on a page with no bundler, so each one
  must be a complete IIFE with its runtime and its CSS inside it — and Vite's
  library mode takes one entry. `sierra widgets` runs the loop; the `widget`
  vite config is what a widget is COMPILED with and what `vite dev` serves.
  Two traps, both measured, both now asserted:
  - **A `.mesa` beside a widget's `index.mesa` is a part, not a widget.**
    Discovery is per directory, not a glob, or a form with four components
    ships as five scripts and nobody notices the four.
  - **The CSS placeholder must not appear in the runtime.** The stylesheet is
    swapped into the entry chunk at `generateBundle`; the runtime is bundled
    into that same chunk, so a runtime holding the whole marker gets replaced
    too and then compares its stylesheet against itself and drops it. It holds
    a PREFIX (`CSS_MARK`); the build derives the full marker. And the entry
    passes the placeholder as a BARE literal — any comparison there is a
    constant one the bundler folds away before the swap can happen.
  - **The drive loads the widgets CROSS-ORIGIN, through `widget/serve.js`.**
    Same-origin is the one arrangement no customer of a widget has, and it
    hides every CORS answer the deployment depends on. Serving them from the
    module that ships is what makes those headers testable at all.
- **A prerendered site lives in its own SURFACE, `site/`, not in `web/`.** A peer
  of `api/` and `web/` with the same six folders and its own Vite root. Three
  answers differ from the SPA's — the build prerenders and checks what it may
  publish, the tests run against FILES rather than a running app, the release is
  a bucket with no server behind it — and a fourth decides it: **one Vite root is
  one `dist/`, and `vite build` empties `outDir`**, so a static target folded into
  `web/` is deleted by the next SPA build with nothing said. That is how this
  repo's own example shipped for months (`FJS-451`, `FJS-D127`). `fli make:site`
  creates it; `core/site-surface.js` in the CLI owns its shape.
- **`target: 'static'` is the SPA's Vite config plus a prerender pass, so `vite
  dev` on a site surface serves an SPA.** Dev is client-routed and the build is
  files. Everything that makes the target what it is — the publish check, one
  chunk per island, one HTML file per route, the refusal when a route declaring
  `render: static` produced no page — happens in `closeBundle` and nowhere else,
  so a change to a `load()` or to frontmatter is proved by building. A page that
  works in dev and fails in the build is the normal case, not a surprise.
- **`site/serve.js` is what a prerendered site is served BY, and a hand-rolled
  file server in a harness gets three things wrong.** A directory index, or every
  URL but the root 404s under `trailingSlash: 'always'`; a cache answer per file
  kind, or HTML is served from cache for as long as an asset should be; and the
  site's own `404.html` with a 404 status, since a soft 404 is a page a crawler
  indexes. It sends **no CORS**, deliberately — this origin serves documents a
  browser navigates to, and the API is what a page's islands call. That is the
  opposite of `widget/serve.js`, whose whole job is the cross-origin case.
- **In a Vite plugin here, `command` off `configResolved` is what says build or
  dev — never `this.environment.mode`.** Vite 8 reports `dev` there for a dev
  server, so a `!== 'serve'` test is true in both and the build-only branch runs
  on every dev boot (`FJS-473`). Two more from the same function, both worth
  carrying: `this.error` THROWS, so a refusal raised inside a `try` is caught by
  that try and downgraded to whatever the catch reports; and a test that
  restates what a plugin does — scan the tree, import the companion, build the
  message by hand — passes forever against a hook nothing calls.

- **A prerendered route must prove its data is publishable.** Reads are tapped
  around `load()` and compared to `@@gate`, fail-closed; the escape is per-route
  `publishes: N` (FJS-081).
- **A mounted ancestor is authoritative** for nested islands — test a marker with
  `isConnected`, not `parentNode`.
- **Sierra exports no module-level signal, and the `externalSignals` map is
  gone** (`FJS-060`). State is plain objects — `page`, `status`, `theme` — that a
  component makes reactive with a `$:` path watch. A module-level signal would be
  reactive nowhere: a bare template read of one is only rewritten if the
  consuming build names it, by hand, in another package, and omitting an entry
  is silent. `tests/no-module-signals.test.js` asserts the absence. `signal()`
  survives for `presence(channelId)`, which returns one from a call.
- **The plugin passes `externalReactivityHints: 'strict'`.** An uncovered member
  read on an imported object is reported — Mesa's default only reports it when
  the file already watches some other path on the same import, which says nothing
  about the component that watches nothing, and that is the component that
  shipped the bug. Measured free: 0 warnings over all 218 `.mesa` in this repo.
  A deliberate one-time read says `var`.
- **The HMR boundary and its browser client are MESA'S.** This package
  reimplements the plugin — frontmatter, the fence preprocessor, slot rewriting,
  auto-imports — and used to reimplement the boundary with it; `FJS-D16` ended
  that. Both are loaded through `findMesaFile`, off the filesystem, for the same
  reason the compiler is: a bare `@frontierjs/mesa/vite/hmr` resolves to the
  node_modules COPY bun leaves for a workspace dep, which is the last install's
  snapshot. **A miss is not fatal** — HMR turns off and edits full-reload, the
  same thing `canInject` does for a shape it cannot wrap — which means the wiring
  breaks QUIETLY and no unit test would notice. `tests/hmr-boundary.test.js`
  boots a real dev server and asks the two questions that wiring answers: did a
  `.mesa` come back with a boundary, and does `/@frontierjs/sierra/hmr-client`
  serve Mesa's client (checked on a line only Mesa's copy has).
- **So is the inspector.** `data-fjs-loc` is stamped by Mesa's compiler and read
  by `mesa-vite/inspect-client.js`; this package serves that source at
  `/@frontierjs/sierra/inspect-client` and injects the script into the shell,
  dev only. `mesaPlugin({ inspect: false })` turns off both ends at once — the
  client is the attribute's only reader. What proves it is Mesa's Vite drive:
  the source served here is the source run there.
- **A missing auto-import does not fail a build.** Mesa compiles a reference to
  an undefined name without complaint, so the symptom is a component that
  renders as nothing. Only what reached the bundle separates *injected* from
  *silently skipped* — `tests/auto-import-build.test.js` asserts on chunk
  content for that reason, and its assertions were checked against a negative
  control rather than trusted for passing.

## The contexts in this package

**Two, and only one of them is per-invocation** (`FJS-D03`).

**`page`** — the router's, in `router/index.js`. A plain object made reactive by
a `$:` path watch; there is no cross-package signal registry.

| | |
| --- | --- |
| Created per | **navigation** — mutated in place through the router's write handle so path watches fire |
| Carries | `path`, `params`, `query`, `directives`, `meta`, `route`, `pending`, `data`, `error`, `slots` — **plus the route's frontmatter spread onto it**, so `{page.title}` works |
| Reserved | those ten names. Frontmatter using one is shadowed and the scanner warns |

Two crossings with the API realm, both worth stating outright:

- **`page.params` is path captures — the same thing Junction calls `ctx.route`.**
  One word per realm, deliberately: `params` is what every router a person has
  used calls it, and in Junction that word carries Feathers' *whole context bag*
  meaning, which is how a role check reads `undefined` and passes.
- **`page.route` is the matched route NODE**, not captures. So `route` means
  different things in the two realms; `params`/`route` do not line up and are not
  meant to.

`page.query` and `page.directives` are split by the same `@frontierjs/toolbelt/directives`
table the API bridge uses, so `resource.load(page.query, page.directives)` is a
filtered, sorted, paged list that lives in its URL (Invariant 10).

**The resource hook context** — `createResource`'s pipeline, in
`junction/resource.js`. Per **operation**, and it deliberately mirrors the API
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

It was called `params`, which put **three** different things in this package
behind one word — path captures, the wire's directives, and this.

**One word each now.** `params` is path captures. `locals` is scratch. The
second argument to `find`/`load`/`getOptions` and the field on the hook context
are both **`directives`** — the word `page.directives`, `ctx.directives` at the
API boundary and `@frontierjs/toolbelt/directives` all already used, so a view
no longer receives `page.directives` and has to pass them as `params`
(Invariant 10). `optionsQuery` and `detailQuery` both take `{ query, directives }` — the picker's read and the detail view's, declared beside the model rather than at every call site (`FJS-D114`). The write is `save(data, { mode })`, the one owner of create-or-patch: `auto` reads the MODEL's id field, `upsert` is an alias of it, and `<Form>` calls it rather than picking a service method.

Junction's browser client moved with it (`FJS-290`): its second argument is a
`QueryDirectives`, declared once in `junction/src/core/directives.ts` and read
by the bridge, the client and — through `page.directives` — this package. So the
object a router hands a view is the object the resource takes and the object the
client sends, under one name, with no translation between them.

---

## Proving a change

`bun run test` + `bun run test:safety`, then in `example/`: `verify` and
`verify:build` for router/resource/build; `verify:public` for anything touching
prerender, islands or static-safety. **`bun run test:widgets` for anything
touching `src/widget/` or `build/widget-build.js`** — it builds the fixture and
drives a plain host page in Chrome, which is the only place shadow isolation,
custom element upgrade and a delegated click inside a shadow root are decidable.
Root `CLAUDE.md` §Running things has the full map.
