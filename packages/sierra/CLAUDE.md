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
    prune-unreachable.js what a static build may publish: the emitted pages walked
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

- **A shadow root on the host element is not necessarily OURS.** `el.shadowRoot
  ?? el.attachShadow()` reads a root the host page attached as one to move into,
  which puts the widget's stylesheet in their `adoptedStyleSheets` and scopes
  delegation to their content. `Symbol.for('sierra.widget.ownsShadowRoot')` is
  what separates them and it deliberately outlives the marks map, which
  `unmount` deletes. A foreign root gets a nested one; our own is reused
  unchanged, because an extra wrapper would move every `:host > *` rule.
- **`isHashedAsset` matches a REPEATED extension.** `…-C_TQPJ-f.js.map` is
  hashed and a pattern anchored on the last segment says otherwise, so a
  sourcemap was revalidated forever beside a file cached for a year.
- **`/__sierra/static-data` refuses three ways, and `Sec-Fetch-Site` is the one
  a verb check cannot cover.** `<img src>`, `<script src>` and a top-level form
  GET are all simple GETs sending no `Origin`. The check allows an ABSENT header
  (not a browser) and `none` (a typed URL) — narrowing it to `same-origin` alone
  breaks every test and every curl. It also refuses a route that does not
  declare `render: static`, and lets a throwing `head()` fail the request,
  because the build skips the page for one and a skipped page fails the build.
- **A `Sitemap:` line takes an ABSOLUTE URL.** A relative one is discarded by
  every crawler rather than fetched and failed, so it looks in the output
  exactly like a site that advertised its sitemap. With no `siteUrl` the line is
  omitted deliberately.
- **Route matching is CASE-SENSITIVE** (`FJS-D210`). It was not, and it was the
  only one of four readers of *which route is this* that was not — `isActive`,
  the prefetch cache key, `page.path` and the filename a static build writes are
  all case-sensitive, so `/ADMIN/` rendered in the SPA and 404'd on the static
  host. A case-only miss is NAMED rather than merely refused, at both entrances:
  the quiet one is an app with a catch-all, where the match is truthy and
  nothing warned at all.
- **An SVG `<a>` is a link and neither obvious spelling finds it.** `tagName` is
  `'a'` in its own case, and `.href` is a truthy `SVGAnimatedString` rather than
  a string — so `=== 'A'` misses it and `if (!a.href)` passes it through as an
  object. `linkHrefOf` (`router/internals.js`) is the one owner; the click
  handler and all three prefetch readers go through it.
- **A hook that breaks the chain throws `ResourceHookError`; it does not answer
  `null`.** An `around` that returns without calling `next()`, one that catches
  the failure and does not rethrow, and an `error` hook that clears `ctx.error`
  without setting a result all end `_call` with nothing having produced an
  answer. `null` is what the context is born with, so a screen read it as one and
  `(await r.service.find()).data` threw in the app's own code. `null` is also a
  legitimate answer for a missing row, so the test is whether anything ASSIGNED
  it — `ctx` comes from `hookContext` (`@frontierjs/toolbelt/hooks`) and
  `answered(ctx)` reports it. **Short-circuiting is still supported and is the
  point of the phase**: set `ctx.result`, `null` included. The error-phase form
  carries the discarded failure on `cause`.
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
  the cwd. `resolve(process.cwd(), 'src')` is the same directory only when a
  command is typed inside the surface —
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
- **The router commits the navigation last STARTED, not the last to finish.**
  `_navigate` has four await points, so a slow `load()` from a route the reader
  had already left overwrote the page they were on and pushed its own URL into the
  address bar (`FJS-791`). A sequence stamp is checked after the guards and again
  immediately before the history write, which is the first irreversible line.
  Three refusals live in the same function: a redirect target — a guard's or a
  `meta.redirect` — must be a path on this origin, since `//evil` and `/\evil` are
  refused by pushState itself and left `page.pending` set forever; ten redirects
  without landing is a reported loop rather than unbounded recursion (two guards
  redirecting to each other made 501 calls in 7 ms and said nothing); and a route
  registering no component is refused HERE, the last frame that still knows which
  FILE it was, rather than in `ChainRenderer` naming an internal expression.
- **`beforeNavigate` runs on the Back button** (`FJS-789`). It did not, inside the
  same fence as the scroll save, while `meta.redirect` three lines below it did —
  one kind of routing refusal survived Back and the other did not, where the README
  promises the opposite and `FJS-D06` files `beforeNavigate` under Hook, the tier
  that may halt the operation. A refusal on popstate puts the address bar back with
  `history.go`: the browser has already moved, and a URL naming the page the guard
  just declined is the same lie as not guarding at all.
- **A link's `href` resolves against the CURRENT page, and the route table is
  consulted BEFORE `preventDefault`.** `new URL(href, location.origin)` carries no
  path, so `#comments`, `./`, `../other/`, `?draft=1` and `edit/` all navigated to
  the site root (`FJS-790`). And cancelling above the match ate every same-origin
  URL the table does not cover — a file the app serves at `/downloads/report.csv`,
  a link into a sibling surface — into the catch-all, or in an app without one into
  nothing at all. A fragment on the page already showing is a pushState and a
  `scrollIntoView`, never a re-navigation. `initRouter` binds its click and
  popstate listeners ONCE, keyed on the window rather than a flag so a swapped
  `globalThis.window` still gets them, or three boots mean one click running three
  concurrent navigations (Invariant 11).

- **A patch carries what CHANGED against the row this screen READ.** `save()` is
  record-shaped — `<Form record={row}>` hands back the whole row, and sending it
  whole makes a PATCH a PUT: a column the screen never showed rides along at the
  value it held when the form opened and overwrites whoever wrote to it in the
  meantime, with nothing said (`FJS-809`). The baseline is `_read`, one entry per
  row this resource FETCHED, capped at 200 and evicted oldest-first; a miss sends
  the whole record, which is what every patch did before, so the failure mode is
  the old behavior and never a lost value. Keys are compared with `!==`, so
  Invariant 9 holds — a diff OMITS a key and never substitutes one, and an
  explicit `null` differs from a non-null baseline, travels, and clears.
  `service.patch(id, data)` is the escape and sends what it is handed: this verb
  takes a record, that one takes a payload.
- **Neither the baseline nor the `@version` moves on a push.** Both are recorded
  off a call result and off a `load()` that was not superseded, never off the
  store: a WS push arrives as an upsert without passing through a call result, so
  a save from a screen holding a DRAFT would carry a revision nobody there had
  read and win the race optimistic locking exists to lose — measured in basecamp,
  the other person's write erased, the guard in place, no error anywhere
  (`FJS-341`). The cost is a 409 where a silent success used to be.
  **`resource.conflict(err)` is what makes that 409 something a screen can act
  on** — `{ model, field, expected, actual }`, the numbers `fieldErrors()`
  deliberately replaces with a sentence, for a *reload* against *overwrite*
  prompt.
- **`save({ mode: 'auto' })` asks whether the row EXISTS, and the schema decides
  how.** A server-assigned key answers by presence, as it always did. A
  caller-supplied `@id` is in the CREATE schema deliberately (`FJS-608`), so
  presence there is the value the person just typed: a generated create form over
  `Sku { code String @id }` issued a patch and threw *Unknown field 'id' in
  where*, and left blank it was worse — `make()` seeds `''`, so the form patched
  the whole COLLECTION (`FJS-808`). For those models the question is *has this
  resource read that id*, and a miss creates, where the key's own uniqueness
  refuses loudly. `mode: 'patch'` with a blank id is now refused by name rather
  than sent. `service.upsert` reads the same `_writeMode`, so the two cannot
  drift.

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
  Junction's transport and its client also read (`FJS-D125`): a string is a number
  only if `String(Number(v)) === v`, so `?sku=007` is the string it looks like and
  `?code="5"` is the escape, and a filter typed into the URL bar means what the
  same filter sent by the client means (`FJS-450`). `buildUrl` writes with that
  encoder, so a URL this package builds parses back as what was put in — dropping
  an EMPTY filter stays its own decision, because a filter box nobody typed in
  should not add a parameter. Both names are in `PAGE_RESERVED` — a route declaring `query:` in frontmatter is
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
  reloads. Sierra needs no wiring for it; `client.resource()` owns it. Its
  operators are the server's and its null semantics are SQL's, not JavaScript's,
  which is the whole reason it lives in the leaf module.
- **`field-rules.js` is deliberately a leaf** — no Junction-client import, so it
  runs in plain Node and can be *compared* against Junction's server rules rather
  than being a copy of them. Keep it that way. It is also why the **control
  table** lives there (`controlFor` / `formFieldList` / `labelFieldFor`): the UI
  kit peers only on mesa and css, so it asks the resource
  (`resource.formFields()`, `resource.options(fk)`) rather than importing this
  package, and `@frontierjs/ui`'s own form suite imports the real table by
  relative path instead of deciding for itself what a `Float` is.
- **A write drops the columns the server owns, and `@version` is the one that
  must survive it.** `stripReadOnly(rules, data, { keep })` runs FIRST in
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
- **A create and a patch are judged by DIFFERENT rule tables, and the build ships
  both.** `@immutable` is writable on a create and `readOnly` on an update, a
  sealing `@immutable` carries `x-litestone-seal` instead, and the `@version`
  column exists in the update schema alone — so `_call` picks the table off the
  method (`rulesFor`) for strip, coerce, blank and validate alike. Judged by the
  wrong one, a create over an `@immutable` column has no box to type into and a
  patch sends a column the Data boundary refuses BY NAME (`FJS-807`).
  `formFields()` stays on the CREATE table: one resource serves both screens and
  the field SET is the same question for each. What an edit form needs beyond it
  is `sealedFields(record)`, which answered `[]` for every row of every model
  while only the create schema crossed.
- **The browser is handed the schema's shape and none of its PROSE**
  (`FJS-D204`). `stripProse` drops `description` as a JSON Schema ANNOTATION at
  every depth and never as a NAME — `properties`, `$defs`, `definitions`,
  `patternProperties` and `dependentSchemas` are keyed by columns somebody
  declared, and a walk that filtered by key name alone deleted
  `Product.description` from every generated form on a build that says nothing.
  Measured on `example`: the emitted payload went 29.7 KB → 6.7 KB gzipped and
  the app's entry chunk 79.52 KB → 56.17 KB, so 23.35 KB — 29% of everything it
  ships — with no feature behind it. Every build logs the emitted size, because a
  refusal that hides its own price gets reversed. A PROJECTION over the model set
  was refused in the same ruling: a build-time scan of `createResource` sites is a
  second and weaker statement of which models an app uses, and a miss renders an
  empty form on a green build.
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
- **The theme is a CLASS on `<html>`, from a list the app declares.**
  `theme: { themes, default, system, persist, key, apply }`; `setTheme` refuses a
  name the app did not declare and prints the list. A `data-theme` attribute is
  what `@frontierjs/css` reads nowhere, so that spelling changed an attribute and
  no pixel (`FJS-308`); `apply: 'attribute'` keeps it for an app that wants it.
  **The element is not a knob**: the no-flash script runs in `<head>`, where
  `<body>` does not exist yet, so `target: 'body'` would only bring the flash
  back.
- **A field the table has no control for comes back with `control: null` and a
  reason** — an array, a `Json` column, a `readOnly` field, a name the model does
  not have. Filtering those out here would make a column added to `.lite`
  disappear from a form with nothing saying so, which is the bug the generated
  list exists to end. **`@money` and `@scale` are on that list**, and they are the
  ones that look answerable: the integer row returns `{ control: 'input', step: 1 }`,
  which is right for a count and out by a factor of a hundred here — 42 typed into
  a `@money` box is forty-two CENTS and no layer refuses it, because 42 is a legal
  value of the column. What the control IS stays the app's (`FJS-D17`): the
  symbol, whether the box is in major units, and for `@scale` what the number even
  measures.
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
  auth plugin. `signOut()` clears in a `finally`, so a refusal still propagates
  and cannot leave a person looking at a signed-in UI with no session.
- **`junction.cookieAuth` is declared on both sides or the app is signed out.**
  The browser cannot see the server's source and there is nothing to derive it
  from, so `createAuthPlugin(auth, { cookieAuth: true })` has a twin in
  `sierra.config.js`. Left off, the client answers `hasCredential === !!token`,
  which is false for a signed-in cookie-mode caller: no boot restore, no socket,
  and a sign-out that never reaches the server while telling the person it did
  (`FJS-787`).
- **A trailing `*` in `auth.publicRoutes` is a SEGMENT boundary.** It was a string
  prefix, so `/blog*` covered `/blogadmin`, and the guard's public branch returns
  before the boot restore is awaited — a route that merely shared a prefix skipped
  the whole guard. `isPublicRoute(rule, path)` is the one owner; `'/docs*'` still
  covers `/docs` itself. Invariant 6 caps what that cost, but a list whose only
  job is to name exceptions must not widen itself.
- **`sierraFetch` attaches the session to the app's OWN origin and to nothing
  else.** `load()` is handed it and the docs tell a page to use it, so a page
  geocoding a postcode or reading a vendor's JSON was handing that vendor a
  replayable session (`FJS-788`). A relative URL is ours by construction; an
  absolute one is checked against the page's origin, the client's, and the
  configured `baseUrl`, and anything unresolvable answers no. It is handed the
  CLIENT rather than a storage key, because storage is a second owner of the token
  and cannot answer cookie mode at all — where there is no token and the
  credential rides a cookie, this sends `credentials: 'include'` to that same
  audience.
- **`status.stale` is where the `x-fjs-build` channel ends.** `{ client, server }`
  once the server states a build this bundle is not, then never again — a banner
  that reappears on every request is one nobody reads. Recorded rather than acted
  on: whether that is a banner, a prompt or a silent reload is the app's answer
  (`FJS-812`).
- **Nothing a resource holds may outlive the person it was read for.** A Resource
  is created once at import (Invariant 18), so its live store, its read baselines
  and its picker lists live for the TAB while the principal is a thing that changes
  inside it. A token change in either direction clears all three, beside the
  prefetch cache this package already dropped for the same reason (`FJS-041`,
  `FJS-786`). The picker cache was the worst of them and not a race at all: it
  never asks again, so the second caller was offered rows their own row policy
  hides, by id and by label. The epoch is bumped on identity and on nothing else,
  so a second render inside one session is still a hit.
- **`presence()` works, and what it CANNOT do is the half to know** (`FJS-811`).
  It bound five channel-suffixed event names junction has never emitted, so the
  module heard nothing for its whole life; frames arrive under their own names —
  `presence:sync`, `:join`, `:diff`, `:leave`, `:update` — with the channel inside
  the payload. **Membership is the APP's**, decided in its `channels(setup)`: what
  `client.presence.announce()` sends is *here is my meta, send me the roster*, and
  a channel this connection was never joined to answers nothing, in SILENCE, which
  is the shape to expect from a misspelt channel or presence not enabled for it.
  An anonymous connection is never tracked — junction's tracker returns early
  without a `userId` — so it neither appears in a roster nor receives one. `self`
  is the server's statement (`you`, on the sync frame, the only frame sent to one
  connection) and is the only thing that can split the roster, so until the first
  sync every member is an *other*, which is the safe way round for an avatar
  strip. Two views of one channel on a page are refcounted here, because the first
  to unmount used to release the channel the second was still showing (`FJS-824`).
- **A prefetch runs `load()` with `sierraFetch`, the same fetch a navigation
  uses, and its cache is dropped whenever the identity changes.** It used to use
  `window.fetch`, so a protected route prefetched signed-out and the 401 was
  cached and then served (`FJS-041`). Two rules follow for anything touching
  this file: one fetch path, and `invalidatePrefetch()` on any new place a token
  is set or cleared — payloads go, the per-URL gate goes with them, chunks stay.
  **A node carrying `meta.redirect` or `meta.spread` is skipped**: the router will
  never render it at that URL, so the prefetch is spent on an answer nothing uses.
  Guards are deliberately NOT run — they are app functions that may await,
  redirect and have side effects, which costs more on hover than the round trip
  it saves.
- **`widgets/` and `site/` are Vite ROOTS of their own** (Invariant 3), which is
  the fact that reaches this package: every path in
  `widgets/config/sierra.config.js` is relative to that directory, `sierra widgets`
  and `sierra site` are run from there, and `@` resolves per root. `fli make:widget`
  and `fli make:site` create them; `core/widget-surface.js` and
  `core/site-surface.js` in the CLI own their shape.
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
- **The build refuses five shapes it used to emit, each naming its file.** A
  `getStaticPaths()` param that is empty, a path, `.`/`..` or carrying a NUL, and
  two entries that fill one output file; a `<slot name>` that is not an identifier;
  two route files mapping to one URL; a frontmatter alias bomb (10,000 values,
  counted by a walk that aborts at the budget — 205 MB in 1576 ms became a refusal
  in 5 ms); and a widget tag that is not a legal custom element name. They are
  refusals rather than warnings for one reason: every one of them BUILT, and what
  shipped was a page silently overwritten, a component that renders as nothing, or
  a script nobody notices is missing.
- **The devtools panels compose markup through `src/devtools/html.js` and may not
  interpolate a raw string.** A tagged template that escapes every `${}` by
  default — five characters, where the four hand copies of the old `esc()` did
  three and were therefore unsafe in an attribute even at the six sites they had
  reached. The two they had not reached were a `class=""` attribute and a text
  position, in different files, written by whoever last copied the helper, so the
  fix that makes the omission unwritable is the one this disease needs
  (`FJS-820`). A nested `html` result passes through raw, so markup still
  composes.
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
  breaks QUIETLY and no unit test would notice, so `tests/hmr-boundary.test.js`
  boots a real dev server and asks both halves of it.
- **So is the inspector.** This package serves Mesa's own
  `inspect-client.js` at `/@frontierjs/sierra/inspect-client` and injects it into
  the shell, dev only; `mesaPlugin({ inspect: false })` turns off both ends, since
  that client is the only reader of the `data-fjs-loc` the compiler stamps.
- **A missing auto-import does not fail a build.** Mesa compiles a reference to
  an undefined name without complaint, so the symptom is a component that renders
  as nothing, and only what reached the BUNDLE separates *injected* from *silently
  skipped* — which is why `tests/auto-import-build.test.js` asserts on chunk
  content.

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

**One word each.** `params` is path captures, `locals` is scratch, and the second
argument to `find`/`load`/`getOptions` — like the field on the hook context and
junction's own `QueryDirectives` (`FJS-290`) — is **`directives`** (Invariant 10).
`optionsQuery` and `detailQuery` both take `{ query, directives }`, declared beside
the model rather than at every call site (`FJS-D114`). The write is
`save(data, { mode })`, the one owner of create-or-patch, which `<Form>` calls
rather than picking a service method.

---

## Proving a change

`bun run test` + `bun run test:safety`, then in `example/`: `verify` and
`verify:build` for router/resource/build; `verify:site` for anything touching
prerender, islands or static-safety. **`bun run test:widgets` for anything
touching `src/widget/` or `build/widget-build.js`** — it builds the fixture and
drives a plain host page in Chrome, which is the only place shadow isolation,
custom element upgrade and a delegated click inside a shadow root are decidable.
Root `CLAUDE.md` §Running things has the full map.
