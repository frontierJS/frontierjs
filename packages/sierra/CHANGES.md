# Changes — @frontierjs/sierra

## 2026-10-05 — a model declared `@@sync(read)` is kept and warmed on a device and its writes are not held (`FJS-1280`)

`offlineQuery` over a `read` model registers and warms like any syncable one, and `load()` answers it from the device with no network. `createResource` splits what the declaration means: `syncPolicy` still gates the read path, and a `writePolicy` that is null for `read` gates everything about a held write — the queue, the boot drain, the per-policy handling — so a write to such a model goes live and fails offline the way a model with no `@@sync` does. The refusal for a missing declaration names `@@sync(read)`. `test/sync-policies.test.js` § *read* (the held-write cases fail with the split removed) and `test/offline-query.test.js`.

## 2026-10-05 — an app can read what the offline warm found (`FJS-1374`)

`_armWarm` discarded `warmOffline()`'s answer, so an app could not tell a device holding its window from one holding nothing; `offlineServices()` only names what was declared. `offlineStatus()` (`FJS-D484`) is a status object beside `pendingQueue()`: `report()` is the last warm's per-service `{rows, kept, error}` (null until one finishes), `ranAt()` is when, `services()` is the declared names, and `subscribe(fn)` hears each warm. `warmOffline` records its own report, so the warms Sierra arms and one an app awaits land the same way. `test/offline-query.test.js` drives the unarmed, armed-by-socket and subscribed cases.

## 2026-10-05 — a screen's write-through lands whatever order its rows arrive in (`FJS-1373`)

`load()` writes through fire-and-forget, in the order responses arrive, and a child ahead of its parent — or naming a parent outside the parent's window — was refused whole by the device's foreign key. The fix is in litestone: the device's connection no longer enforces them (`FJS-D485`), so `writeRows` needs no ordering and no per-row fallback. The comments in `local-db.js` and `offline.js` that said the device keeps its keys now say it does not, and the warm's passes retry other refusals only.

## 2026-10-05 — a generated list names the workspace's declared custom fields (`FJS-1388`)

The JSON Schema is shared by every tenant and stopped naming the `@@extensible` slot columns (`FJS-1387`), so nothing offered `fields.<key>` and a workspace's own `severity` was neither a column nor a filter. `resource.declaredFields()` asks the service's built-in `declaredFields` once per identity (`FJS-D487`), only for a model whose schema carries `x-extensible`, and `columns()`/`filters()` merge what it loaded as `fields.<key>`. A slotted key filters through its slot (`queryKey`, since the boundary takes no where on a key inside a Json column), a key with no slot is returned with the reason, and none sorts. A failed ask is not remembered and an identity change drops the list. `test/declared-fields.test.js` drives it, paired with a model that declares nothing. A screen awaits `declaredFields()` once; `columns()` stays synchronous and names nothing before it resolves.

## 2026-10-05 — the dev server regenerates the client schema after `db/schema.lite` is recreated (`FJS-1470`)

`schemaPlugin.configureServer` watched the schema FILE and listened for `change` alone. The watcher goes deaf to a path after it is unlinked and recreated (`git stash`, `git checkout`, a pull), so the dev server served the last schema it saw: models added since had no client schema, `make()` was bare and a generated `<Form>` rendered no fields, with only a console warning. It now watches `dirname(schemaPath)` and regenerates on `add` as well as `change`, filtered by path, which is what Vite's watcher reports for a recreate. `test/schema-generation.test.js` drives the plugin against a fake server: the directory is watched, `add` regenerates and reloads, and a neighbour file in the same directory does not.

## 2026-10-04 — a patch never carries a composed key (`FJS-1576`)

`save()` kept a key whenever it was absent from the last read or a different reference from it, so a form opened on `record(id, { composed: true })` sent the child list (`params`) the service refuses on a patch — or did not, depending on which read the resource last recorded. `_changed` now drops a composed key (a relation, or an object under a name the model does not declare) before it compares anything, and does so with no baseline too. A declared `Json` column is a column and still travels when it changed. `test/resource-save-composed.test.js` asserts the patch for a re-created list, for no baseline, and for a changed `Json` column.

## 2026-10-04 — `data-fjs-loc` names the file's line again (`FJS-1710`)

`prepareForCompile` strips a `.mesa` route's frontmatter and inserts auto-imports and slot props, and Mesa stamped `data-fjs-loc` from what it was handed. So alt-click opened a line or more off in any file that went through a rewrite: on `website/site`, the layout's skip link stamped `:20` when it is written on `:19`. **`locLines(original, prepared)`** in `src/build/mesa-plugin.js` maps each prepared line to the line of the file it came from, aligning the two line by line. An inserted line maps to the line before it, and a line rewritten in place maps to itself. The transform passes the map to the compiler as `locLines` in dev, and never for a `.md` (`FJS-1711`). `test/prepare-for-compile.test.js` covers an insertion after the script tag, a stripped frontmatter block and a synthesized script block.

## 2026-10-04 — leaving an `[id]` screen no longer mounts it again with the next screen's id (`FJS-1684`)

`apps/[id]` → `deployments/[id]` called `apps.get` with a deployment's id, and leaving for a list ran the
old screen with no id at all. The router's commit order was innocent: `ChainRenderer` derived `Component`
from an `entry` memo, one derived layer below the remount key that reads `entry` as well, so when the
route and its params moved together the key block re-ran first and mounted the screen being left — still
the stale `Component` — under the new params. `Component` and the key now both read `chain[depth]`
directly, one layer, which is the only shape the flush orders correctly. `test/screen-leave-router.test.js`
mounts the real router, `RouterView` and `ChainRenderer` and is red without the change in both the
`[id]` → `[id]` and `[id]` → list rows; a hand-written commit of `params` then `route` does not reproduce it.

## 2026-10-04 — every dev server has the ask panel

**`src/build/ask-plugin.js` turns on `@frontierjs/cli`'s ask panel** (shift+alt-click an element, ask Claude to change it) in every Sierra dev server, beside the inspector whose pick it answers. Site-kit wired it on its own first; that line is gone, so the website, `example/web`, basecamp and a scaffolded app all get it from here. Sierra does not depend on the cli: `@frontierjs/cli/core/vite-ask.js` is resolved from the Vite root at `configResolved`, and the cli plugin's hooks are forwarded once it loads. An app without the cli gets no panel and no warning; one whose cli fails to load gets a warning. `mesa: { inspect: false }` turns it off with the inspector, read through the new `inspectOn()` so the two cannot disagree. Proved by `test/ask-plugin.test.js` (against a stub cli in a temp root) and `website`'s `verify:ask`, which goes red naming the missing plugin and client when the line is removed.

## 2026-10-04 — the device keeps an append-only model insert-only rather than nothing (`FJS-1700`)

`writeRows` mirrors server rows with `asSystem().upsertMany`, and litestone now grades that call's conflict half as an update. Example's `InventoryMovement` is `@@gate("5.5.9.9")`, and a 9 refuses the system client too, so the offline warm kept nothing of `inventory` and `example verify` failed on the console warning. A refusal naming `update` at 9 is retried with `update: []`. Such a row never changes on the server, so insert-only replay loses nothing. Any other refusal is still reported. `test/local-db.test.js` has both halves.

## 2026-10-03 — a build no longer empties the dev server's route table (`FJS-1695`)

A build writes its route table to `routes.build.js` beside `routes.js`, where it used to overwrite the file a running dev server imports. That replaced dev's `/__sierra/static-data` shims with the static build's empty `loaders`, and every `render: static` page rendered with `data: null` until the dev server restarted. `routeTablePath(config, command)` in `src/scanner/generate-route-table.js` is the one place both the scanner plugin and `virtual:sierra` read the path from; it was spelled twice. `routes.build.js` is gitignored repo-wide and in the `fli new` scaffold.

## 2026-10-03 — `@syntax(lang)` reaches a code editor (`FJS-1657`)

`buildFieldRules` carries `x-syntax` and no longer carries `contentMediaType`. `controlFor` answers `textarea` for `x-syntax: 'md'` and `{ control: 'code', task: 'text', language }` for every other language; `displayFor` answers `markdown` and `{ display: 'code', language }`, which `filterOpFor` filters with `contains`. A column holding `.lite` or a Mesa template was a one-line input that stripped its newlines.

## 2026-10-03 — a generated create form no longer asks for a column the policy determines (`FJS-1229`)

A column in the model's `x-determined` is marked `determined` and no longer `required` by `buildFieldRules`, `formFieldList` leaves it out of the generated set (`only` still names it), and `_call` fills it from `session.user` on a create when the payload leaves it blank — `auth().id` is the session's `userId`, any other claim is read by name, and one the session lacks is left unset for the Data boundary to refuse. The two halves an app used to write by hand per column (`record` and `except` together) are one rule, and the scaffolded `before.create` hook it defeated is redundant. `test/determined-fields.test.js`.

## 2026-10-03 — a generated form grades the value the Data boundary will store (`FJS-401`)

`buildFieldRules` carries `x-transforms` and `validateAgainstFields` runs it before the enum, length, pattern and format checks. A person typing `W` into a `@lower` field with a lowercase `@regex` could not save it and was told the format was wrong, with no request sent; `@trim @length` on `' ab '` is the same case. `test/field-messages.test.js`.

## 2026-10-03 — the offline-shell budget refusal prints as its message

Vite 8 prints a failed build with `util.inspect(err)`, so the over-budget refusal arrived as its message, then a dozen rolldown frames, then `{ code, plugin, hook }`, and the fix command was lost in the middle. `src/build/refusal.js` gives an error a custom inspect that returns its message alone. It is only for a verdict about the app: an error meaning Sierra itself broke keeps its stack. The message now puts the update command on its own line and names the baseline file relative to the cwd. Proof: `test/offline-shell.test.js` › *the refusal prints as its message*, and a forced over-budget `example` build printing the message and nothing else.

## 2026-10-03 — a found schema.lite that produced no client schema says why, in the dev log and in the page (`FJS-1649`)

`loadLitestone` caught the error a found litestone subpath threw and dropped it, then warned *Add it as a devDependency* — the wrong cure for a package that was there (Transit hit it as an `ERR_UNSUPPORTED_ESM_URL_SCHEME` when `./jsonschema` briefly reached `bun:sqlite`). The first error from a found package is now kept and named in the warning, and the devDependency advice is given only when nothing was found. The plugin keeps what it warned on `sierraContext.schemaFailure` whenever a schema path resolved and generation returned nothing, and `virtual:sierra` emits it as a `console.error` at boot: the app still runs, as `generateSchemas` intends, but an empty form and a `can()` answering yes from no declaration now come with a line in the browser console naming the cause. `test/schema-generation.test.js` § *a found litestone that will not load* drives a fake package whose `./jsonschema` throws, through `generateSchemas`, the plugin's own `configResolved`, and the emitted line run.

## 2026-10-03 — two suite fixes

`test/resource-schema-modes.test.js` § *a column is marked only where something declared it* compared basecamp against a hardcoded `['Flow.ownerId']`, which went stale when basecamp froze ten columns with `@immutable`. It now asserts every marked column is one the schema declares `@immutable`, for both apps. `test/fs-allow-plugin.test.js` imported `bun:test` in a vitest package and collected zero tests; it imports `vitest`.

## 2026-09-30 — a `robots: noindex` page beside a one-segment dynamic route stays out of the sitemap

`isIndexable` tested a prerendered URL against every dynamic pattern in `indexable`, so `/:pkg/` matched `/splash-tune/` and overruled that page's own `noindex`. frontierjs.com advertised its tuner page. Now a URL that is itself a route is decided by that route alone. Proof: `test/postbuild.test.js` › *a noindex route beside a one-segment dynamic route stays out*, which failed before the fix.

## 2026-09-30 — the dev watcher ignores dotfiles, so `.sierra-fresh-*` copies no longer feed back into it

`classify` reads a `.sierra-fresh-<pid>-<n>-x.meta.js` copy as a `companion`, so the scanner plugin's `add`/`unlink` handlers ran a scan for each one. Each scan writes a fresh copy of every companion, and each copy triggered another scan. One `bun run dev` in `website/` wrote 44,550 files into `site/src/routes/` in 35 seconds before it was killed. `roleOf` now answers `ignored` for a dotfile, which matches `walk.js`. Proof: `test/scanner-plugin.test.js` › *the dev watcher*, red with the check removed.

## 2026-09-30 — the browser drives open Chrome through `@frontierjs/mesa/drive` (`FJS-1588`)

`test/browser/installable.mjs` and `test/fixtures/widget-site/test/verify.mjs` run on `openChrome()`. The widget drive's profile at `/tmp/fjs-widget-<pid>` was never removed, and now the driver removes it. `test/fixtures/island-site/verify.mjs` stays on `--dump-dom` and takes its binary from `findChrome()`, so `$FJS_CHROME` means the same thing there as in every other drive. installable 26/26, widgets 46/46, islands green.

## 2026-09-29 — a linked checkout's local-db worker loads in dev (`FJS-1601`)

In dev, `createSierraViteConfig` now adds the workspace root, sierra's real directory and litestone's real directory to `server.fs.allow`. Before this, an app linked with `--source local` got "outside of Vite serving allow list" for `local-db-worker.js`, and the device database never started.

## 2026-09-29 — a per-row currency offers no range filter (`FJS-D556`)

`resource.filters()` answers `op: null` with a reason for a
`@money(field: …)` column. Its amounts are in each row's own currency and
share no scale, so a range over them compared cents with yen. The new test in
`resource-schema-modes.test.js` pairs it with a stated-currency column, which
keeps its range.

## 2026-09-29 — `@money` answers the `money` control (`FJS-1582`, `FJS-D555`)

`controlFor` answers `{ control: 'money', task: 'quantify', currency, currencyField }` for a column carrying `x-money`, where it answered `control: null` and a reason telling the app to register one. The currency is on the answer in `displayFor`'s spelling, so a form never parses `x-money`'s three shapes. `@scale` still answers `null`. `field-control-scaled.test.js` asserts all three shapes, and `control-task.test.js` lists `money`.

## 2026-09-29 — `readEvents` reads a `ctx.sse()` stream (`FJS-1581`)

`readEvents(response)` from `@frontierjs/sierra/fetch` is an async generator over a `text/event-stream` response: `for await (const { event, data, id } of readEvents(await sierraFetch(url)))`. `EventSource` cannot send a bearer token, so a page reading an authenticated stream had to write the fetch, the body reader and the frame parser itself, as portal did in about 40 lines. The frame is toolbelt's `/sse`, which junction writes with. Leaving the loop cancels the body, so the server's `onDisconnect` fires. A non-2xx throws with `status`, `body` and the server's `message`, and a response that is not an event stream throws a `TypeError`, where either would otherwise have been read as a stream with nothing in it. Nothing reconnects. Proved in `test/event-stream.test.js` against a real junction app, and with `reader.cancel()` removed the hang-up test fails.

## 2026-09-29 — AGENTS.md answers offline (`FJS-1550`)

*Offline — held writes and kept reads* is new: `@@sync` as the switch, the two
`offline:` config shapes, a held write throwing with `queued` rather than
resolving, the browser-minted key an offline parent needs, `pendingQueue()`'s
surface, `cachedAt()`, and why an `offlineQuery` resource is imported from
`main.js`. An app agent had been reading `pending.js`, `local-db.js` and
`offline.js` for it. The checklist gains the `err.queued` line.

## 2026-09-29 — a package's `.mesa`, a Vite alias and a root glob all reach a static page (`FJS-1551`, `FJS-1552`, `FJS-1553`)

Three things a component in a package needs to render the app's content worked in `vite dev` and nowhere after it. The Mesa transform skipped every `.mesa` under `node_modules/` outside `@frontierjs/`, so a component library installed from a tarball served a blank page; it now compiles every `.mesa` and `.md`, since nothing else can read one. The prerender resolved only `@` and the router, so an alias the app or a package adds to Vite (`@content/…`) failed as *Cannot find package*, or for a `.md` as a path beside the importer; the resolved Vite config's string aliases that name a path are now handed to the render, under `@` and the router. And a prerendered `import.meta.glob` had to be file-relative; a leading `/` now resolves against the Vite root and is keyed `/…`, as Vite keys it. `test/node-modules-allowance.test.js`, `test/glob-expand.test.js` and `test/prerender-vite-alias.test.js`, a static build naming an alias and a root glob; the ksite stressor's `vite build` prerenders all four routes.

## 2026-09-28 — a prerendered layout reads `page` (`FJS-1530`)

A layout importing `page` from `@frontierjs/sierra/router` failed every static page with *Unexpected #key*. The router re-exported RouterView.mesa and ChainRenderer.mesa, and the prerender loads the router natively. Had the import loaded, `page` would still have been at its initial `/` with an empty `meta` on every built page. **`sierra/router` now resolves to `src/router/entry.js`**, which is `router/index.js` plus the two components, so an app's imports are unchanged. `router/index.js` itself loads under Bun or Node. The prerender aliases `sierra/router` to it, and the synthetic wrapper calls `_setStaticPage({ node, pathname, params, data })` through that same import before any layout renders, committing what a navigation commits. `test/static-layout-page.test.js` builds three routes under a layout reading `page.pathname` and `page.meta`: each page gets its own path and title, a parent layout's frontmatter merges in, and no route sees the one rendered before it.

## 2026-09-28 — a `plugins` entry's `closeBundle` runs once, after the pages (`FJS-1535`)

A user plugin was handed to Vite whole, so Vite called its `closeBundle` first with no context, and a post-build hook written as the README shows it, `closeBundle({ outDir })`, failed the build. The copy Vite sees now carries every hook except that one, which only the post-build pipeline calls, with `{ outDir, root, config, routeTable }`. The README config row says so, and the `llms` row now gives the default the code has always had, `false` (`FJS-1536`).

## 2026-09-28 — a route declaring `redirect:` is a `_redirects` line and not a page (`FJS-1534`)

A static build prerendered a `redirect:` route like any other, so `dist/old-about/index.html` held the old body beside the `_redirects` line moving it, and on Netlify, where a file shadows an unforced redirect, the move never fired. The route table's `indexed` and `indexable` never dropped a redirect either, so sitemap.xml and llms.txt listed the old URL. `prerenderRoutes` now leaves a redirect route (and a draft, `FJS-1533`) out of `staticNodes` and returns it in `omitted`, which the build prints under *Not prerendered, by their frontmatter*. Both route-table lists filter `meta.redirect`, and llms.txt reads the same `indexed` the sitemap does. `test/static-omit.test.js` builds a site with one redirect route and checks all four outputs.

## 2026-09-28 — an eager `import.meta.glob` is prerendered (`FJS-1521`)

Bun has no `import.meta.glob`, and the prerender imports what Mesa's `renderComponent` compiled, so a block listing `content/collections/*.md` rendered in `vite dev` and failed `site:build`. `build/glob-expand.js` (`expandGlobs`) runs in the prerender's `transformSource` after `prepareForCompile`. It rewrites an eager glob into one `import * as` per match, or `import { name }` under `import:`, plus an object literal keyed and ordered as Vite's glob: the key relative to the importer, sorted, with the importer itself left out. `renderComponent` then compiles each match. The Vite transform keeps Vite's own glob, which watches the directory, so a file added to a collection still reaches `vite dev` without a restart. A lazy glob becomes a call that throws naming `{ eager: true }` if the render evaluates it. An option other than `eager`/`import`, or a pattern that is not relative, is refused. `test/glob-expand.test.js`, including a static build of a page listing a collection by its frontmatter.

## 2026-09-28 — a resource over an `@@expires` model drops a lapsed row at its edge (`FJS-1274`)

`createResource` hands junction `until: leavesAt(x-effective, …)` when the model's window is imposed, so a live list loses an expired row when the clock passes it rather than at the next reload. `leavesAt` is re-exported beside `matchesQuery`.

## 2026-09-28 — `markdownLayouts`: which component a `.md` file's `layout:` names (`FJS-1493`)

`markdownLayouts: ['src/layouts', 'content/layouts']` makes each `.mesa`/`.md` file directly in those directories a layout name, by basename, with a later directory winning a name. That order is how a site cut from a template replaces one layout without copying the rest. The map (`sierraContext.markdownLayouts`, from `build/markdown-layouts.js`) is handed to Mesa as `layouts` by the Vite transform and by the prerender, and Mesa does the wrap. Layout names are their own namespace, apart from `autoImport`, so a block `Trust.md` can say `layout: Trust`. Unset, `layout:` wraps nothing, as before. `test/markdown-layouts.test.js`, and `test/static-autoimport-build.test.js` now builds a block with a layout.

## 2026-09-28 — a static build compiles each page the way the dev server does (`FJS-1491`, `FJS-1492`, `FJS-1499`)

`autoImport` was the Vite transform's alone. The `static` prerender compiles through Mesa's `renderComponent`, which reads each file from disk, so a page naming `<Hero />` from `autoImport.components` rendered in `vite dev` and failed `site:build` with *Hero is not defined*. `prepareForCompile(source, id, autoImportMap)` in `mesa-plugin.js` is now the one preparation: the Vite transform calls it, the prerender hands it to `renderComponent` as `transformSource`, and `checkMesaFiles` uses it too. The prerender also compiles with the app's `mesa` options, which it never received before. A `.md` file keeps its frontmatter. The transform used to strip it, so `compileMd` exported no props in dev while the prerender, which never stripped it, did. The injected `<script>` goes directly after the block, and a `.md` file's fences are left to `compileMd`. The tag scan in `injectAutoImports` now skips HTML comments and never imports a file into itself. A component whose doc comment showed its own tag had imported itself, and died on *"Image" has already been declared*. `test/static-autoimport-build.test.js` is a real static build of a Markdown page that imports nothing. `test/prepare-for-compile.test.js` covers the rest, and `test/auto-import.test.js` gains the comment and self cases. Once the prerender prepared layouts as dev does, a `_module.mesa`'s `<slot />` became `{@render children?.()}`, and the element children `composeWrapper` also passed made Mesa warn *was given children and renders no <slot />* on every build. `composeWrapper(page, chain, { elementChildren: false })` now passes the prop alone, and the prerender uses it whenever it prepares sources.

## 2026-09-28 — a held write and a held attachment replay with the moment they were made (`FJS-1278`, `FJS-D469`)

The pending queue's `_send` and the attachment queue's `_send` now pass the entry's `createdAt` as `madeAt`. `createdAt` is the device's clock when the button was pressed. The junction client adds its clock at the send, and the server corrects the first by the second. So a clock-in drained eight hours late is stamped when it was made. Pinned by `test/pending-queue.test.js` § *a held write replays with the moment it was made*.

## 2026-09-28 — a row on screen keeps its read `@version`, and a patch with none is refused on the device (`FJS-1309`, `FJS-D468`)

A resource kept the read version of the last 200 rows in insertion order, so a board of 300 rows forgot its first 100, and a row that reached the screen by push was never read at all. A patch of either went up with no version and the server refused it with a sentence about `asSystem()`, or, held offline, at the drain where nobody hears it. `_remember` now evicts only rows whose node no view holds (`client.nodes.peek(model, id).held`), so the cap bounds `find()` rows in plain arrays and nothing on screen. The first sight of a row in a held view counts as its read: the resource store's subscription and `record()` over a node another view already holds remember the committed row when this resource has no read of it, and never replace one, so a push after a read still does not move the version. Whatever still misses, such as an evicted `find()` row or an id nothing showed, is refused before the hook pipeline reaches the queue, with `code: 'VERSION_UNREAD'` and a message that asks the person to reload the row. `resource-version.test.js`'s *nothing read* test now expects that refusal. Proved in `test/resource-read-versions.test.js`: a 300-row list's first row, a pushed row, `record()` over a held node, and the refusal with nothing sent.

## 2026-09-28 — `publishes:` names columns per model, and a gate level is refused (`FJS-1222`, `FJS-D496`)

`publishes: 4` covered every column of every model gated at 4 or below, including a column added after the line was written. A page declared for a host's name could then add the host's email to the same read and ship it, with no new refusal and nothing in the frontmatter diff. `publishes:` is now `{ Model: [columns] }`. The recorder collects every column read by model: `collectColumns` walks `select`/`include`, a read with no `select` counts as every column (`client.$schema` fields minus `@omit(all)`), and `aggregate`/`groupBy` count their `by` and value keys. `checkRoute` refuses any column of a gated model that the list does not name, and prints the declaration covering what was read. A model gated at 0 needs no entry, and a count is `Model: []`. A number, `true` or a bare list is refused by type, and so is a misspelt model or column. `formatReport` drops the `max` column, and `routes.snapshot.md` prints the column lists. Proved in `test/static-safety-real.mjs` § FJS-1222 and `test/static-safety.test.js`.

## 2026-09-28 — a static page that reads through raw SQL fails the build (`FJS-1471`)

A raw `db.sql` read taps with `model: null`, and `createReadRecorder` returned on a null model, so a route reading `asSystem().sql` was graded for nothing — no gate, no protected column, and not even the observed-nothing warning. The recorder now adds each `operation: 'sql'` event to `unresolved` as `sql: <query>`, which `checkRoute` already refuses whatever `publishes:` says: SQL names no model, so there is nothing to grade it against. Proved in `test/static-safety.test.js` § createReadRecorder.

## 2026-09-28 — a static page that reads a protected column through `asSystem()` fails the build (`FJS-1411`, `FJS-D504`)

The gate check graded models and never columns, and `asSystem()` — the flavor a gated catalog is built through — returns `@guarded` and `@encrypted` values. A system read of `Account` gated at 0 handed `token` to the page with nothing on the path looking. `createReadRecorder` now collects `exposed`: for each read whose event states `system`, `collectExposed` walks the `select`/`include` tree against `db.$protectedFields()`. No `select` counts as every column, `true` on a relation as the whole child row, and `aggregate`/`groupBy` count their `by` and `_min`/`_max`/`_sum`/`_avg` keys. `checkRoute` refuses any hit whatever `publishes:` says, naming each `Model.column (@kind)` and asking for a `select`. Bare and `$setAuth` reads are not graded, because both strip the values. Proved in `test/static-safety-real.mjs` § FJS-1411 against a real client.

## 2026-09-27 — `@frontierjs/sierra/check` compiles `.mesa` files the way the build does (`FJS-1228`)

`checkMesaFiles(files, { root })` answers which files fail to compile and with
which Mesa errors, for `fli check`'s `mesa-compiles`. What the plugin does to a
file before Mesa sees it — frontmatter, fenced blocks, slot rewriting, the
redirect-only no-op — moved into `prepareMesaSource(source, id)` in
`mesa-plugin.js`, which both callers use, so the gate cannot judge a file the
build would not. Auto-imports are not applied: an undefined name compiles.

## 2026-09-27 — held bytes drain in the workspace they were saved in (`FJS-1372`)

`attachmentQueue().add` now records the call headers of the save — the same set the held row carries — and `_send` states them on both the version read and the patch, so a photograph queued in Acme and drained after its author opened Globex lands in Acme. Proved in `test/attachment-queue.test.js`.

## 2026-09-26 — a nullable `@system` date gets no control on a generated form (`FJS-1259`)

`buildFieldRules` carried `readOnly` off the deref'd branch, and for an `anyOf`
the flag was on the wrapper, so `decidedAt DateTime? @system` rendered a
datetime box that answered 403 while `decidedById String? @system` got none.
The fix is in toolbelt's `derefFieldSchema`, which now keeps the wrapper's
keywords; the same lift reaches `stripReadOnly`, `x-labels`, `x-values`,
`x-sortable` and the tenancy kind on a nullable column. Proof:
`test/field-rules-nullable.test.js`, schema generated from `.lite` source.

## 2026-09-26 — the example's `/login` no longer says `$req` is spent (`FJS-1180`)

junction now rebuilds `ctx.$raw.$req` from the bytes it read, so the comment in
`example/api/src/app.ts` that re-reading it yields nothing was false; the route
still reads `ctx.body`, which is the parsed one.

## 2026-09-26 — the warm writes parents before children, and says what it could not keep (`FJS-1279`)

The device keeps the foreign keys between `@@sync` models, and `warmOffline()`
wrote one `upsertMany` per model in declaration order — the order modules
happened to evaluate — so a child declared before its parent was refused as a
whole batch with `SQLITE_CONSTRAINT_FOREIGNKEY`. A refusal warned once per
document under one key, so a second model failing said nothing, and the report
carried no error for a write. The warm now makes every read first and writes in
passes: a batch the device refused is written again after the others land,
until a pass lands nothing, which is the device schema's own parent-first order
found by the device rather than a second derivation of the graph. What never
lands is on the report as `error` and warned once per service; `writeThrough()`
warns once per MODEL. `local-db.js` exports `writeRows()`, the write that
throws, which the warm uses so a batch refused on the first pass and accepted
on the second is not reported as a failure. `test/local-db.test.js` declares a
child before its parent and asserts both land, a child naming a parent the
device never holds is on the report with its error, and two models failing are
two warnings. `example`'s `main.js` now imports `InventoryMovement` before
`ProductVariant`, and its comment claiming the order mattered is gone.

## 2026-09-26 — a reopened device sends what the last session held (`FJS-1277`)

The drain was armed by constructing the pending queue, and only the resource
write path constructed it — so a document that opened after an outage and made
no write registered no `connect` listener, and what the last session held sat
`pending` with `attempts` unmoved until somebody wrote again (connectteam
measured it). `createResource` now builds the queue for a model that declares
`@@sync`, the way an `offlineQuery` arms the warm: the declaration arms it, not
the write. `_armDrain` also sets its flag only once it has found a client,
which `_armWarm` already did, so a queue built before `initJunction` no longer
marks the app armed against nothing. The export half the row asked for was
already there — `pendingQueue` is exported from `@frontierjs/sierra/junction`
(`FJS-D300`). `test/sync-policies.test.js` asserts a `@@sync` resource
registers the listener before any write and that firing it sends a held entry,
and that a model with no `@@sync` arms nothing.

## 2026-09-26 — the first held write of a document is stored, not only remembered (`FJS-1276`)

The pending queue opens IndexedDB when it is created and `write()` put an
entry only `if (db)`, without waiting for the handle. A write made in the
first moments of a document — pressing *Clock in* on noticing there is no
signal — landed in memory only, told `durable: false`, and a closed tab lost
it; connectteam and linear both measured it. `write()` now awaits `ready`
first, as `list-cache.js`'s `remember()` already did.
`test/pending-queue.test.js` adds a write against an IndexedDB whose open
answers late and asserts the row is in the store and `durable` is true.

## 2026-09-26 — a held write replays in the workspace it was made in (`FJS-1300`)

A pending entry held `key, service, model, method, id, data` and no
workspace, and `_send()` went through the client, which put the CURRENT
workspace on the call. Linear measured it: an issue made offline in Acme,
drained after switching to Globex, was refused as Globex; a model whose
policy does not reach a tenant-scoped parent would have been written there.
The resource now records `client.callHeaders()` on the entry when it holds a
write, the live call states that same set under the same key, and `_send()`
states the entry's set on replay (junction's `CallOptions.callHeaders`).
`test/pending-queue.test.js` drains an Acme entry through a Globex client;
`test/sync-policies.test.js` asserts the resource records the set and the live
call states it.

## 2026-09-26 — an offline `$search` is the device's search, never its whole table (`FJS-1311`)

`readLocal` built `{ where, limit, offset, orderBy, select }` out of the
directives and dropped `search`, so a `load()` that could not reach the server
answered a search with every row of the model and stored it as the screen's
rows with a `cachedAt`. A `search` directive now goes to the device engine's
own `search(term, args)`, the call the server's derived find makes; a device
schema with no `@@fts` refuses it by name, which is the throw the file's comment
already read as *cannot answer*, so the load falls through to the list cache
rather than rendering the table. `test/local-db.test.js` pins both halves at the
seam and through an offline `load()`.

## 2026-09-26 — a save moves the writer's own screen on its answer (`FJS-1317`)

The live store took a write only from the server's announcement, so wherever
that did not come back to the writer (a graded refusal, `channel: false`, a
model they may write but not read, a write over HTTP while the socket is down)
their own save answered 200 to a screen that never moved. `_call` now writes
the row a `create`, `patch` or `update` was answered with into its node
(`client.nodes.write`), next to `_rememberRows`, so the broadcast confirms the
write instead of carrying it. An answer whose `@version` is older than the row
already held is skipped, because that is a push that overtook the answer on the
wire. An answer with no id writes nothing. `remove` is left to its broadcast.
`test/resource-record.test.js` § a save moves the writer's own row.

## 2026-09-26 — the attachment queue carries a version on a `@version` model (`FJS-1298`)

The bytes queue drained as `patch(id, { [field]: blob })`, and litestone refuses a
patch on a `@version` model that carries no version, so a photograph taken
offline on a `@@sync(field)` or `refuse` model was parked `rejected` on exactly
the models two people edit. D301's one drive, `StocktakeCount`, has no
`@version`, which is why nothing caught it.

The version is not knowable when the entry is written — the write queue drains
first and every held patch moves it — so `attachments.js` now records the
model's `@version` column on the entry and reads the row at the first send,
pinning the version it read (`pin(key, version)`). A re-send reuses the pin
rather than reading again, because a send whose answer was lost may have landed
and junction refuses the same idempotency key under a different payload `422`.
A stale-write `409` forgets the pin and sends once more, since the bytes do not
depend on what the other writer changed. A model with no `@version` is sent
exactly as before, without the read. `test/attachment-queue.test.js`.

## 2026-09-26 — a composed list reads offline (`FJS-1281`)

`composed: true` read through `resource.find()`, and only `load()` falls back to the device and the list cache, so the word about a response envelope also opted a screen out of offline: an outage rendered a roster as empty. `list.js` `run()` now sends an unreachable composed find to `load()`, the owner of that fallback; the rows are the device's, bare of what the find composed onto them, and `cachedAt()` says so. A refusal still refuses. `test/list-cache.test.js` § a composed list.

## 2026-09-26 — a write refused at replay is told, and can be retried (`FJS-1302`)

`FJS-D300` ruled that a mutation refused at replay is *surfaced as a rejected
item somebody can see and retry*, and none of the three was true: the drain
parked it in `fjs-pending` and said nothing, the queue was not exported, and
the only verb on a rejected entry was `forget`. Now:

- `pendingQueue` is exported from `@frontierjs/sierra/junction`.
- The queue has `subscribe(fn)`, called with the list after every change and
  answering the unsubscribe; the `onChange` constructor option is gone.
- `retry(key)` puts a rejected entry back to `pending` under the same key and,
  on the app queue, drains at once when the socket is up.
- `forget(key)` is `discard(key)`, the name `FJS-D335` gives it, and the blob
  queue has the same `subscribe` and `discard`, so the two queues read alike.
- A refusal at replay logs `[sierra] held write refused at replay: <service>.<method> — <message>`.

## 2026-09-26 — the test-runner map is `docs/TESTING.md`

`CLAUDE.md` pointed at the root `CLAUDE.md` § Running things for the full map of
runners, and that table moved to `docs/TESTING.md`. No behavior change.

## 2026-09-25 — `bytes` is an interaction task

`controlFor` answers `task: 'bytes'` for a `File` column, where it answered
`select`, and `INTERACTION_TASKS` is five long (`FJS-D387`). A file is picked the
way a select is, but its technique carries size, type and progress, which a
registered select control cannot, so grouping the two by task put a file input
among the choosers. `test/control-task.test.js` pins `photo → bytes`.

## 2026-09-25 — `controlFor` answers a `task`

Each answer now carries `task` next to `control`. The task is what the person
does to the value: `select`, `quantify`, `text` or `position` (Foley, Wallace &
Chan 1984). The control is one technique for doing it. The task comes from the
column, so an `input` over a count is `quantify` and over a name is `text`.
`@money` and `@scale` answer `quantify` with no control. A registered control
may claim a task in its descriptor. Otherwise it inherits the table's, and a
claim outside `INTERACTION_TASKS` is replaced with a warning. A read-only column
answers no task. `test/control-task.test.js` visits every control the table can
name. The descriptors pinned in three suites now include the field
(`IDEAS/ui-ontology.md` § 7 step 3).

## 2026-09-24 — every route renders inside a boundary

`FJS-D376`, for [`FJS-1326`](../../ISSUES_ARCHIVE.md#fjs-1326). `ChainRenderer` wraps each level of the chain
in a `<mesa:boundary>`, so a page or a layout that throws while rendering is replaced by `failed` and
the levels above it stay standing, where it used to leave a half-drawn page and a console line. The
three boundaries share one global `failed` snippet; it renders the app's own when `RouterView` was
given `failed={…}` and a plain message with a *Try again* button otherwise. They read no async value,
so they wait on nothing (`FJS-D378`). `test/outlet-boundary.test.js` mounts the real `ChainRenderer`
and is red against the previous one.

## 2026-09-23 — a killed process's `.sierra-fresh-*` copies are swept

`importFresh` copies a companion beside itself to get past bun's module cache
and unlinks the copy in a `finally`, which a process killed mid-import never
reaches — eight copies of `automations.mount.js` were found untracked in
`example/web/src/routes/`, all from one dead pid. The first import into a
directory now removes every copy whose pid is not alive. A live pid's copy is
left, since two servers can share a routes directory and deleting a copy under
a pending import fails it. Proof: `test/scanner-refusals.test.js`, one row,
red with the sweep removed.

## 2026-09-23 — `resource.commitments(row)`: the moves no button makes, as a date

`commitmentsAt(spec, row, { target })` beside `transitionsAt`, and
`resource.commitments(row, opts)` beside `resource.transitions()`. A `@system`
move is left off a screen's buttons; this is where it comes back —
`[{ name, transition, via, target, dueAt, kind }]` for every `@@commitment`
still owed. The date is `@frontierjs/toolbelt/datetime`'s `dueAt`, the function
litestone's `due()` answers with. Whether it is still owed is graded off what
the row carries: the move's from-state on the row it moves, and `while:` through
the evaluator `requiredFor` already runs. **Across a relation the target is the
caller's to pass** — `{ target: sub }` for the row it holds, `{ target: null }`
for *there is none*, which owes nothing as `due()` does; a target nobody read is
not graded, the permissive answer every `x-*` affordance gives. Proof:
`test/resource-commitments.test.js`, 13, where removing the from-state check
turns four red.

## 2026-09-22 — `@unit` reaches a form

`FJS-D348`. `_CARRIED` is an allowlist, so a keyword litestone emits and this
file does not name is dropped between the schema and `$context.form` — the
declaration would then exist, be emitted, and reach nobody, which is the whole
failure `@unit` was added to remove. `x-unit` is carried.

**It does not join `@money` and `@scale` in refusing a control**, and the
difference is the point. Those answer `control: null` because the box and the
column disagree: a person types 42 and the column holds 4200. A `@unit(s)`
column has no such gap — 300 typed is 300 stored — so the ordinary number input
is the right answer, and the keyword is carried for what RENDERS the value
rather than for what picks the input.

## 2026-09-21 — the declared window is the DEVICE's

`FJS-D337`, and the half phase 5 carried. `warmOffline()` filled two stores with one answer —
the device's tables and a list-cache slot keyed by the declared question — and with SQL
underneath, the slot is a second answer to a question the tables answer anyway, and a narrower
one: it replays the exact query it was given and nothing else. So the warm now writes the slot
only where the rows did NOT reach the device.

**The condition is the write-through having landed, never the config.** `localDb()` answers null
on any failure by design — no OPFS, a worker that will not start, a device out of quota — so
reading `offline: { db: true }` as *the device holds this* would leave such a device with an
empty screen and nothing said. `kept` was already computed and reported; it now decides.

`load()` is unchanged and says why: its write-through is deliberately not awaited, so the fact
the warm skips on is not available while a screen is rendering.

`test/local-db.test.js` grades both halves — a kept model gets no slot, and one the device
refused falls back to the slot and is read back through a real `load()` with the network down.

## 2026-09-21 — the suite directory is `test/`

**`tests/` is a surface, not a suite.** In an FJS app it sits beside `api/` and `web/` and holds
what belongs to no single surface, while a surface's own tests are its `test/` (Invariant 3). A
package is not an app — it has one `src/` — so its suite is `test/`, and this one moved. Eight
packages spelled it plural and eleven singular with nothing in the tree deciding between them,
which made the directory name a coin flip on every file added.

`test:safety`, `test:widgets` and `test:installable` name the new path.

## 2026-09-21 — `mesa:slot` is named once

`MESA_SLOT_TAG` in `build/slot-rewrite.js` holds the one name Sierra adds to Mesa's `mesa:`
namespace. Mesa's own `MESA_ELEMENTS` cannot carry it — the rewrite runs before the compiler sees
the tag — so a reader of that list alone is one word short, and the tag was previously a string
inside two regexes and a call.

## 2026-09-20 — the TLA control flipped, which is the control doing its job

`app-import.js` records a build's first real import failure because a module
whose top-level await threw used to report its error exactly ONCE: every import
after that resolved to a half-built namespace, so the next reader got
`Cannot access 'X' before initialization` naming whichever binding it touched,
and the cause was gone. Four messages of that shape once hid a schema parse
error naming a file and a line.

`test/build-imports.test.js` carried a spawned NEGATIVE control asserting the
runtime really does lose it, with a comment saying that if this ever stops being
true the recording has stopped being load-bearing and this is the test that
should say so. **It just said so.** The pinned runtime re-throws the original
every time now, the way node always has.

So the control is rewritten to assert what is true rather than flipped quietly,
and the recording is KEPT and marked dormant in both the test and the file's own
header. It is not deleted: `firstRealFailure()` still has a live reader in
`warnings.js`, and a runtime property that changed once can change back — this
control is the only thing here that would notice.


## 2026-09-20 — a held write carries the row it was made against

`FJS-1202`. The `NO_BASE_CARRIED` guard added yesterday comes out: `@@sync(field)`
is reachable now, over both transports (`FJS-D338`).

**The base is DERIVED, not declared.** Nothing a caller writes says what they
were looking at — the resource does, in the `_read` map it already reads a
`@version` out of — so `resource.js` takes it from there at the call site. Only
a write against an existing row has one; a create was made against nothing.

**It rides the live call as well as the held one.** A write made with the network
up can still lose a race, and the merge is the same comparison either way —
otherwise `field` would only ever resolve for a device that had been offline,
which is not what the declaration says.

**`pendingQueue().add()` builds its entry BY NAME and dropped it first time
round.** The base reached the call site, was passed to the queue, and vanished —
the entry is assembled field by field rather than spread, so anything a caller
passes that `add` does not list is silently gone. Worth knowing for the next
thing that needs to survive a replay.

## 2026-09-20 — a point column resolves to a point control

`controlFor` asks `x-geo` ahead of the type switch, for the reason a `File` column is asked
there: the TYPE is not what separates them. A point and an ordinary `Json` column are both
`{}` in the schema — no `type` at all — so a table branching on the type cannot tell them
apart and both got the document editor.

It answers `geo` and carries `latKey`/`lngKey` through to the control, so a form writes the
pair under the keys the model declared rather than a spelling it assumed. `displayFor`
answers `geo` too, instead of printing the document's punctuation into a table cell.

**The kit's answer is replaceable and the test says so**: `FJS-D327` keeps a tile vendor out
of this repo, so an app that wants a map registers its own resolver over the same `x-geo` —
the ordinary `registerControl` route, last registered asked first, no fork.

## 2026-09-20 — `@@sync(field)` is refused here rather than silently behaving as `refuse`

Phase 5 of `IDEAS/homestead.md`. The merge itself is built at the Data boundary
(`FJS-D334`, litestone's `core/three-way.js`), and nothing in this package can
reach it yet: `field` compares a held write against the row it was made against,
so the held write has to CARRY that row — and a base is a ROW, so it cannot ride
a header the way `idempotencyKey` does, while a write's body already is its data.

Left alone, a held `field` write would go up with its revision and no base and be
refused on the revision alone, which is `@@sync(refuse)` behaving correctly under
a declaration promising that two people editing different columns both win. So a
held patch, remove or restore against a `field` model is refused by name —
`NO_BASE_CARRIED`, naming the model, the method and what to declare instead. A
create is still held: it was made against no row.

The same rule `append` already follows, for the same reason `FJS-D298` closed
the set — a policy that parses and resolves nothing reads exactly like one that
works. The guard comes out when the transport lands.

## 2026-09-20 — a nearest-first list is URL-driven, both halves

The screen a proximity search produces is the one that gets bookmarked and shared, so the
center, the radius and the ordering all have to survive a paste. `page-query` now pins that
`?site[near][lat]=…&site[near][within]=5mi&$orderBy[site][near][lat]=…` lands as
`page.query` plus `page.directives` with nothing to translate (`FJS-D323`), and that a
fixed-precision coordinate — what `toFixed(6)` writes — arrives as TEXT, which is the query
kit being correct with no model in the room and Litestone's `@point` being the thing that
reads it back. Router unchanged.

**And one stale control, found by running the suite around it.** `resource-schema-modes`
measured that `example` marks `@immutable` columns in the update schema and `basecamp` marks
none — a real control until orion's `db/orion.lite`, which basecamp imports, stamped
`Flow.ownerId @immutable` as an access grant (`FJS-D276`). The control is now the NAMES
rather than the count, so a change that marks columns wholesale still reds it and the app
that declares nothing is still measured against that.

## 2026-09-19 — both static origins read the shared type table

`TYPES` in `site/serve.js` and `widget/serve.js`, and `COMPRESSIBLE` in `serve/http-answers.js`, are
`@frontierjs/toolbelt/mime` (`FJS-1186`). The charset is now asked for — `contentTypeFor(file, {
charset: true })` — rather than baked into the table, so a binary type cannot acquire one by a
caller passing the flag for its text files.

**`site/serve.js` gains `.wasm`**, which is the defect the row was filed for: `FJS-825` added it to
`widget/serve.js` for a stated reason and the file beside it gained `.avif` in the same pass and
never gained this. It also gains `.heic`, `.bmp`, `.mp4`, `.mp3` and `.pdf`; the widget origin gains
`.jpeg` (it had `.jpg` alone), `.txt`, `.xml` and `.html`.

## 2026-09-16 — hydration: the warm fills the device, not only the cache

Phase 4's last owing (`IDEAS/homestead.md`). The device was only as full as what
a screen HAPPENED to read, so somebody who signed in and walked into a basement
without opening the right screen had an empty database — and `@@sync`'s read
direction was a claim with nothing behind it.

**`warmOffline()` writes its rows through to the tables.** No new option and no
new noun: `offlineQuery` already declares exactly the rows a device must hold,
and the model is in scope where the declaration is made. The alternative —
a model→service map emitted at build time and a `hydrate:` bound in config —
would have been a second reader of `src/resources/` beside `fli check`'s and a
second declaration beside the one that already says what to hold.

The report gains `kept`, because *hydrated* and *hydrated nothing* are otherwise
one answer: the cache holds the declared question either way, so a screen asking
exactly that question renders identically with the tables empty.

**Nothing re-warms on sign-in**, and the gap that looks like is not one:
`setToken` cycles the socket, so `connect` fires and the warm armed on it runs as
the person who just signed in. A call in the token handler was written, measured
to be redundant by deleting it, and left deleted. What it was papering over moved
to where it belongs — `localDb()` waits on a clear in flight, because emptying
the tables closes the worker holding the OPFS pool and two over one pool kill the
renderer (`FJS-1179`).

## 2026-09-16 — the local database answers, and `example` turns it on

`FJS-1179`. `offline: { db: true }` was built and off; it is on, and three things had to be true
first that no unit test could see.

**`readLocal` asks junction what a directive VALUE means.** A screen states `orderBy: '-id'` because
that is the wire's spelling; SQLite takes `[{ id: 'desc' }]` and throws on the other. Spelled here it
was a second answer to a settled question — and the throw fell through to the list cache underneath,
which answers the same question with the same rows, so every sorted list offline was served by the
cache and the whole feature was off and green. `normalizeOrderBy` and `normalizeSelect` come from
`@frontierjs/junction/client`, the same functions the server compiles its own SQL from.

**An EMPTY device defers; a device that cannot answer at all still defers.** `[]` is a table with no
rows for this question, which is what a device looks like before a write-through has landed, and on
screen it is indistinguishable from a list that is genuinely empty. The cache below may hold the
server's own answer, so it is asked before nothing is rendered as the answer — and when neither has
anything, an empty table still beats a throw.

**The engine opens at `configureLocalDb()`, not on the first read that needs it.** A write-through is
a side effect of a load and is deliberately not awaited, so a page opened and left inside the second
the worker takes to compile SQLite kept nothing at all.

`example` pays **278 → 880 kB** over the wire for it — 138 kB engine, 341 kB wasm, 123 kB litestone
client — a deliberate `FJS-D302` ratchet. An app that leaves it off pays 1 kB.

## 2026-09-16 — `offline: { db: true }`: the device's own SQLite as the read store

`FJS-D307`'s storage swap, built and **off**. `list-cache.js` answers the exact
question it was given; this is a query engine, so any question on a `@@sync`
model is answerable with no server. `example` does not turn it on yet — with the
engine live `verify:shell` hangs, which is `FJS-1179`.

**The seam.** `build/local-db-plugin.js` copies SQLite's wasm out of the APP's
own `@sqlite.org/sqlite-wasm` and emits the device schema litestone's
`deviceSchema()` makes; `junction/local-db.js` opens the client lazily, writes
through on a successful `load()` and answers the catch before the list cache
does; `junction/local-db-worker.js` is the worker body. The app owns the
dependency because the app pays for it; the build owns the output because only
the build knows its own layout — the division `postbuild/offline-shell.js`
already makes for the precache.

**A cache does not re-grade what it was given** (`FJS-D309`). Every row arrived
in an answer the server gave this caller, so it is read back through
`asSystem()` and dropped when the identity changes. Re-grading would be done by
the wrong grader: a local client auto-installs `FrontierGateGetLevel` and an
app's own resolver is a different function — measured on `example`, 3 against 4
on one account, with `Order` at `@@gate("0.4.4.5")`.

**Three things were paid for by measuring, and each is now a comment where it
bites.**

A bundler rewrites `new Worker(new URL(…, import.meta.url))` **and nothing
else**, so handing `createBrowserClient` a bare URL to construct for itself left
the built app fetching a file beside its hashed entry chunk that nothing wrote —
silently, with every read falling through to the list cache, which looks exactly
like the feature working.

The wasm entry is copied as **`.js`, not `.mjs`**. It is reached by a dynamic
`import()`, which a browser refuses outright when the response is not a
JavaScript media type, and `.mjs` is the extension static hosts most often have
no row for. The `.wasm` beside it travels unrenamed, because the module fetches
that one itself, by name.

And **that same static signal put the worker in every app**. A bundler emits the
chunk wherever it sees the pattern, reachable or not, and the service worker
precaches every `.js` a build emits — so `example` with the database turned OFF
went 277 → 401 kB. `local-db-open.js` exists to hold that one line, and the
plugin resolves it to a stub when the app did not ask for a database. With the
stub the seam costs **1 kB**, which is the baseline's new 278.

**Turned on, it is 880 kB over the wire** — 138 kB engine, 341 kB wasm, 123 kB
litestone client — against 278. That is `FJS-D302`'s ratchet doing its job: a
number to agree to rather than inherit.

`test/local-db.test.js` (15) grades the seam against a stand-in client, in
pairings: the database answering beside the database declining, since `null`
means *cannot answer* and must fall through rather than render as an empty list.
The engine itself is litestone's and is driven in a real browser by that
package's own `test:browser`.

`verify-shell.mjs` also stopped assuming it was signed out — a session outlives
the browser profile, so a second run of the drive found no sign-in button and
reported it as the app being broken.


## 2026-09-16 — `offlineQuery`: the read a screen must already hold

`FJS-D307` picked C — the cache in `list-cache.js` plus a DECLARATION. B alone
only ever answers a question somebody happened to ask earlier, and *which screens
did I visit before I lost signal* is not a thing a person in a basement can have
planned.

```js
export const movements = createResource('inventory', {
  model:        'InventoryMovement',
  offlineQuery: { directives: { limit: 40, orderBy: '-id' } },
})
```

**It joins `detailQuery` / `optionsQuery` / `listQuery`** — the same
`{ query, directives }` shape, declared once beside the model. Not called
`prefetch`: sierra already has one, and it means a speculative preload on a link
hover. One name for two things is the trap, so the word was rejected rather than
overloaded.

**Warmed at boot and on every reconnect**, armed exactly as `pending.js` arms its
drain — `connect` rather than `navigator.onLine`, because the socket says this
client can talk to that server where the browser only says the interface is up.
Re-warming on reconnect is what stops what is held being a copy of last Tuesday.

**A warm may not touch a store.** `resource.load()` writes the rows into the store
the screen is rendering; a warm runs in the background under a question nobody is
looking at, so routing it through `load()` would swap a visible list — the feature
breaking the screen it exists to protect. It calls `find` and remembers the
answer, which is `load()`'s other half and nothing else.

**It writes under `listKey`, the same function the read uses**, and that is the
whole of how this feature fails: a warm keyed even slightly differently fills a
slot nothing looks under, and nothing about the app looks wrong until the outage.
So every test in `test/offline-query.test.js` is *warmed, then offline, then
read* rather than *the warm ran* — probed by breaking the key, which turns 6 of
the 13 red, and by routing the warm through `load()`, which turns exactly the
store case red.

**The honest bound gets its own test.** It is keyed by the QUESTION, so the
declared one is answerable offline and a different one is not. It is a cache with
a schedule and not a replica.

**`offlineQuery` on a model with no `@@sync` is refused by name and registered
nowhere.** Rows on a device outlive the session, so which models may be written
there is the schema's word (`FJS-D298`) — a warm on a model that never said so
would fill nothing, and the outage is where that would be discovered. Warned
rather than thrown, which is what the ten other refusals in `resource.js` do: a
throw in a `<script module>` is a white screen.

Two ordering bugs came out of writing the tests, both of which would have shipped
the feature doing nothing. The arm flag latched when no client had been built yet,
so a declaration made before `initJunction` marked the app armed against a client
that did not exist and nothing ever warmed. And `FJS-1178` is the half that
remains: a declaration only exists once its module does, and a route's modules are
code-split, so the screen nobody opened declares nothing until somebody opens it —
`example` answers it with one import in `web/src/main.js`, which is a real answer
rather than a workaround, since which resources are worth the entry chunk is the
app's decision.


## 2026-09-16 — what `@@sync`'s argument does to a HELD write

`FJS-D304`. All three policies are identical on a reachable network — the argument decides what happens
to a write nobody is standing over when it lands — and each now differs from the others in a way a test
can see (`test/sync-policies.test.js`; 4 of its rows go red with the change reverted).

**`server` now DROPS the revision from a held write, and that is a fix.** The resource stamps the
`@version` onto every patch so a stale edit is refused, which is right for a write somebody is standing
over and wrong for a held one: `server` means *replay this against whatever the row holds by then*, and
a carried revision turns that into a refusal the person who made the write walked away from an hour ago.
`example`'s ledger says exactly this in its own schema comment and had no way to mean it.

**`refuse` keeps it**, which is the only difference between the two and the reason it is a word.

**`append` refuses to HOLD a `patch`, `remove` or `restore`, by name**, with the model and the method on
the error and `code: 'APPEND_ONLY'`. Each of those three unambiguously names a row that already exists,
which the declaration says does not happen.

**A CUSTOM method is not refused, and the drive is what settled that.** The first version refused
everything that was not a `create`, and `verify:offline` went red on `InventoryMovement.adjust()` —
the app's own verb, which computes a delta and APPENDS a movement — on the very model whose schema says
`append` is a statement of fact. Sierra cannot read a custom method; a rule over one is a rule about
something this layer does not know. The built-in verbs are the ones whose meaning is fixed.

The attachment queue is untouched: it patches through the raw client, because the bytes of a row THIS
device created arriving late are not a second writer. Pinned, because routing that drain through the
resource "for consistency" would silently stop an append-only model accepting its own photographs.

## 2026-09-16 — the offline shell has a budget, and it ratchets down only

`FJS-D302`, and the first act of phase 4 rather than the last. The build already printed what the shell
cost; a number nothing enforces is a number nobody reads, which is why there had never been a budget.

**What is graded is what goes over the WIRE.** Brotli, per file and summed the way a CDN compresses
each response — a concatenation compresses better than the thing it stands for, by the exact amount
nobody would notice. Gzip and raw are printed beside it for reading a build.

```
sw.js — 89 file(s) precached · 276 kB over the wire (317 kB gzip, 982 kB raw) · baseline adopted at 276 kB
```

**A ceiling this framework picked would be wrong for every app**, so the app adopts whatever it costs
today: no baseline writes one, under it passes, over it FAILS the build with both numbers and the path
to the file. `FJS_OFFLINE_BASELINE=update` is the deliberate act — lowering after a win, raising after
a feature somebody chose to pay for. Invariant 14's mechanism on a second axis.

**It does not rewrite itself when a build shrinks.** A file that changes on every build is a diff
nobody reads, and the lowering is somebody's decision to record.

**The baseline lives in the surface ROOT and not in `outDir`** — a build empties its own output, so the
first version adopted a new baseline on every single run and graded nothing.

## 2026-09-16 — the app opens with no network, and has something in it

Phase 3 of the Homestead work (`IDEAS/homestead.md`). Phases 1 and 2 made a WRITE survive an outage;
this is the other half of the same promise, and it was false until now — a page navigated to with the
network down landed on Chrome's error screen, and from there every queue on the device is unreachable.

**`postbuild/offline-shell.js` writes `sw.js` from what the build emitted.** Opt-in: `offline: true` in
`sierra.config.js`, because a service worker is the longest-lived thing a build can leave on somebody's
device. Sierra writes this one where the app writes its manifest, and the difference is the reason: a
manifest is a DECLARATION, a precache list is a DERIVATION — only the build knows this build's hashes,
and an app maintaining one by hand ships a shell pointing at assets that no longer exist.

**It answers for two things and touches nothing else.** A file it precached, and a navigation
(network-first, the last shell as the fallback). Everything else falls through without `respondWith`
being called at all, so `/api`, `/ws` and every upload are not in its path. No runtime caching — a
cache in front of a read would eventually answer with a row the live layer believes it has corrected,
and `verify:shell` asserts that against the SOURCE as well as against behavior.

**`skipWaiting`, and the drive is why.** The first version left it out, reasoning that a running page
holds module references into the cache activating would sweep. `verify:shell` refuted it: without it a
new worker waits for every tab it would replace to CLOSE, and a navigation in the same tab does not
release control — so a phone with the app open for a week never sees a release. The hazard it was
guarding against is not new either: a page asking for a chunk the deploy removed fails with or without
a worker, and `x-fjs-build` is already the mechanism for that.

**`junction/list-cache.js` — what a screen last saw.** A working shell over empty tables reads to a
person as *the data is gone*. A load that cannot reach the server answers with the last list instead
of throwing, keyed by the QUESTION (service + query + directives, key-sorted) rather than by the model.
Three refusals: only a model that declared `@@sync` is kept at all, because putting rows a gate let this
caller read onto a disk outlives the session and is the app's word rather than a default; it answers on
SILENCE and never on a refusal, since a 403 means this caller may not read these rows now; and it never
speaks while the network works, so the online path is unchanged.

**And the session survives.** `refresh()` asked the server who the token is, and with no server it
answered *nobody* — so an app that opened offline opened SIGNED OUT and hid every gated screen from the
person holding the device. The last resolved session is kept in `localStorage` and restored when the
question could not be asked. Safe because a client-side level was never the enforcement (Invariant 6):
the device gets exactly the refusals it would get without one. Cleared by `clear()`, which both a 401
and a sign-out go through.

## 2026-09-16 — two queues: the bytes are not a row

`FJS-D301`, and the second half of phase 2. `junction/attachments.js` is a queue of its own — its own
IndexedDB **database**, its own retry, objects immutable once named — and `resource.js` splits a
write that could not be sent into the row and its files.

**Three reasons it is not one queue.** A 4MB photograph in front of a 200-byte correction in one FIFO
makes the small write wait on exactly the connection that cannot carry the large one. A refused row is
news for a person and a half-sent upload is a retry, so sharing `attempts`, `state` and a drain rule
would give one of them the wrong one. And a blob store is what fills a device's quota, so a separate
database is what stops a quota failure taking the write queue down with it.

**Nothing new crosses the wire.** An entry drains as an ordinary `patch` carrying the Blob, which the
client already turns into multipart and `FileStorage` already turns into an object plus a ref. No
upload endpoint, no pending-file value in the column, no second answer to who may write — the same
argument phase 1 made for having no sync protocol.

**The online path is still ONE call.** The bytes travel on the create as they always did; the entry is
written before it goes out and settled by the same acknowledgement. The split only happens when the
send could not arrive.

**The bytes go after the rows**, because an attachment names a row that has to exist. The drain chain
is one handler, and `attachments.js` is imported dynamically there — which keeps the two modules a
one-way dependency (attachments asks `pending.js` what `unreachable` means) and means an app that never
queues a photograph never loads the blob queue.

**A model whose key only the server assigns queues NEITHER half.** There would be nothing for the patch
to name, so failing is the honest answer; the schema advisor says so ahead of time.

## 2026-09-16 — the browser states the key, so a child can name an unsent parent

Phase 2 of the Homestead work (`IDEAS/homestead.md`). Phase 1 held one flat write; this is the shape
that breaks — a parent and its children written in the same minute with nothing reachable, where the
child has to name a parent whose id does not exist because the INSERT has not happened.

`resource.js` mints the key off `x-mint` — `{ field, kind }`, crossed only for a model that declares
`@@sync` and whose single `@id` has a generated default — through `@frontierjs/toolbelt/ids`.

**It mints on every create, not only on one that turns out to be held.** A screen cannot know whether
its parent reached the server before it needs the parent's id, and an id whose origin depends on the
network is an id that is sometimes there and sometimes not. A key the caller stated is kept, which is
the rule the server already follows.

**A generator this bundle does not have is not an error.** `mintId` answers null and the create goes
without a key, exactly as it does for a model with no `x-mint` — a schema emitted by a newer litestone
than the bundle reading it degrades to the old behavior rather than throwing.

**The queued error now carries `data`.** For a create on a minting model that is the ROW, and it is the
only copy anywhere, since the server has never seen it. A screen whose next act references the row had
nowhere else to read the key from.

## 2026-09-16 — a write the network could not carry is held, not lost

Phase 1 of the Homestead work (`IDEAS/homestead.md`), and the first thing in this framework that
holds a write the network could not carry. `junction/pending.js` is the queue; `resource.js`'s one
write funnel is where it hooks in; a model opts in with `@@sync(server)` and nothing else changes.

**Queue-first, one path.** The entry is written BEFORE the call goes out, not in a catch after it
fails — what PowerSync does, and for the reason it does it (`IDEAS/review-prior-art.md` § 4): a catch-based
queue has two routes to the server with a seam between them, and the seam is where a write goes
twice or not at all. What is stored is what the resource's hooks produced — coerced, blank-stripped,
validated, version-stamped — because that is what a replay has to send.

**An entry clears on an acknowledgement and never on a send.** This is the rule `example`'s
`verify:offline` paid for: Chrome's offline mode carries frames on a socket that is already open, so
a call can leave on a socket that has not noticed the network is gone and arrive minutes later with
the screen never told. `settle()` is called from the success path and nowhere else.

**`code` is what separates a refusal from silence.** The client attaches one when the server
answered, so no code at all is a request that never got a reply — and 408 is deliberately on the
unreachable side, because a timeout is the one answer that cannot say whether the write arrived,
which is exactly the ambiguity the idempotency key makes safe to resolve by sending again. Not
`retryable`, which is the SERVER saying *the row moved under you* — a different question that would
eventually share a branch if it shared a word.

**A held write throws rather than resolving**, carrying `queued: true` and `durable`. Resolving
successfully would claim the server has a row it may not have; a screen that reads the flag can say
*held on this device* and one that ignores it shows a failure, which is the safe default. Where
IndexedDB is unavailable the queue still runs in memory and reports `durable: false`, because an
in-memory queue survives the outages a page lives through — but a screen promising *will sync* on
one is promising something a reload breaks.

**Every method but `find` and `get` is held**, custom verbs included. The client cannot tell a
custom read from a custom write — only the server's method policy knows — and including them is the
lesser wrong: most of what a real app writes is a custom verb, so excluding them would leave the
queue covering the part of an app that needs it least, and a queued custom READ costs one wasted
call on reconnect against a custom WRITE left out costing the row.

**A write carrying a `File` is sent straight through, not queued** — a blob has to outlive the tab
in a store of its own and the multipart request has to be built at drain, which is phase 2 and the
`FJS-D298`-shaped ruling it still needs.

**The queue is the resource layer's, and the raw client is the escape hatch.** That is a capability
line and not a preference: a replay must send the post-hook payload, and `getClient().service(x)`
has no hooks, no field rules and no version knowledge to produce one. `example`'s own inventory
screen was on the wrong side of it and moved.

## 2026-09-15 — a resource's `make()` is handed the create-mode `required`

[`FJS-1162`](../../ISSUES_ARCHIVE.md#fjs-1162). `createMakeFromSchema` takes it as a fifth argument and
the resource passes the model definition's own, so toolbelt's `make()` can tell a column the
caller leaves blank from one the server fills. Found by orion's create-flow drawer, whose form
could not submit.

## 2026-09-15 — a package's routes, mounted by one file

`FJS-D282`. `automations.mount.js` in an app's routes directory default-exports a directory — in
practice re-exported from the package that owns it, `export { default } from '@frontierjs/orion/routes'`
— and the files there become routes under `/automations/`, inside the app's own layouts and the
package's. The mount is visible in the host's tree and removed by deleting it. **`walk` reports the
path a file appears at and records where it is**, because a URL, a layout chain and a conflict are
all computed from the first, and `build-tree` stores the second relative to the root — so the route
table, the prerender and the dev static-data endpoint all resolve a mounted file unchanged. A mount
naming no directory is refused by name rather than producing a section with no routes, a URL the app
already has is still a conflict, and the dev server watches every mounted directory, so a route added
to a package appears without a restart. `test/scanner-mount.test.js`.

## 2026-09-13 — `AGENTS.md` ships

A compressed reference for an agent writing routes, resources and prerendered pages in an installed
app (`FJS-D163`): file roles, `page`, `list()` and `record(id)`, `save()`, the publish check, the
silent failures, and the `fli check` rules that grade them. It points at mesa's for the language.
`files:` carries it, and a scaffolded app's `AGENTS.md` points at it. The pass found `FJS-1113` and
`FJS-1114`.

## 2026-09-12 — the build says whether a browser will install the app

**`postbuild/manifest.js` grades the manifest `index.html` links** (`FJS-D263`'s floor under a
desktop surface). The app writes the file; the build prints `manifest.webmanifest — installable` or
a warning naming the rule and Chrome's own error id, since an app a browser will not install says so
nowhere — the page loads and the install button never appears. A `public/manifest.webmanifest`
nothing links is reported too. The rules were measured against Chrome 150 rather than taken from
memory, which corrected two: no service worker and no 512px icon are required, and an icon's REAL
size is read, so a 32px file declaring `512x512` is refused. `test/browser/installable.mjs`
(`bun run test:installable`) grades 26 cases against `Page.getInstallabilityErrors` and fails on
any disagreement; with the icon floor dropped to 100px it reds exactly the 143px case.

## 2026-09-12 — a composed list

**`list({ composed: true })` is `record(id, { composed: true })` for a list.** Where a service's
`find()` answers more than the rows — an `include:`, a per-row count — a push carries the row alone and
the store's `upsert` replaces what was held, so a store-backed list blanks every relation cell at the
first announcement. A composed list holds its rows itself and never writes them to the store, since a
node holding one screen's includes would hand them to every other list over the model. Any announcement
on the service, or a reconnect (jittered up to 2s), re-reads the window; a burst during a read is ONE
more read. Growing the window widens the limit instead of resuming from a cursor, because the next push
re-reads all of it anyway. The other answer — merge the push over the held row — was refused: it is free
and goes stale in silence once a push moves a key an include was read through. `test/resource-list.test.js`
carries six rows, with the push paired against a store-backed control that loses the relation; every
mutant tried reds at least one.

**An omitted flag is named, in dev.** A `list()` or `record()` read that answered a declared RELATION key
(an include, null included) or an object or array under a key the model does not declare (a child list)
warns once per view, naming the keys and the call that fixes it. A bare scalar under an undeclared key is
deliberately not flagged: `createdAt` and `updatedAt` are in no schema mode the build emits, so reading
those as composed would warn on every list. Gated on `import.meta.env?.DEV` — measured in basecamp's
production bundle, the warning text is absent while an ungated warning from the same file is present, and
removing the gate puts it back. Every other mutant reds a row of `test/resource-list.test.js`.

## 2026-09-12 — a page served from a custom scheme keeps its router

**Links are intercepted on any scheme the page itself is served from** (`FJS-1085`). The click handler
allowed `http:` and `https:` only and compared `url.origin`, which is `"null"` for a non-special scheme,
so inside a native shell — Tauri's `tauri://localhost`, Capacitor's `capacitor://localhost` — every link
was a full page load and prefetch warmed nothing. `isSameDocumentOrigin(url)` in `router/internals.js`
compares scheme and host against the page's own and is the one check both readers call. A `mailto:`, a
`tel:` and another host still keep their click, since each differs in one of the two.

## 2026-09-12 — `resource.list()`, and the URL in the browser's own words

**A list is one call now.** `resource.list()` owns the five wirings every list page restated — the
store subscription, where the filters live, the load, its re-run on a change, and the window through
`more()`/`hasMore()` — and hands back `rows`, `query`, `directives`, `loading`, `error`, `hasMore`,
`apply`, `sort`, `more`, `reload` and `destroy`. It owns no markup. `state: 'url'` is the default and
makes the address bar the list, with nothing held here; `state: 'local'` is the embedded list that must
not navigate, and `where` scopes it OVER the filters so a bar can neither see nor widen the scope.
`IDEAS/list-controller.md` carries the argument; `test/resource-list.test.js` drives it through the
real router and Junction's real client, and every mutant tried reds at least one row — the route guard,
replace-versus-merge, `where` under the filters, the local re-run, the debounce, a default filter
merged under the URL, and the `columns:` default.

**Two findings are in the design rather than the tests.** The router commits `query` BEFORE `route`,
so a list that answered every change to `page.query` re-asked the server with the NEXT route's filters
on the way out — the list answers only while its own route is on screen. And `<FilterBar>` hands back
the whole bag it holds and clears a value by leaving its key out, so `apply` REPLACES each half; the
first draft merged, and a search box that had been emptied went on searching.

**`listQuery` and `columns:` are declared in the resource file**, beside `detailQuery` and
`optionsQuery`. `listQuery` reaches `list()` and never a bare `find()` or `load()`, because a default
filter reaching every read narrows pickers, jobs and live stores with nothing saying so. Its filters
apply only while the state carries none, since merged under the URL key for key a default could never
be cleared from a bar. `columns:` defaults `columns()` and therefore `filters()`, key for key under the
call's own — and NOT `summary()`, which asks what a form cannot show rather than what a table
shows, so a ledger's six columns narrowing a detail screen would drop columns from it in silence.

**`page.path` is gone; `page.pathname` and `page.search` replace it**, borrowed exactly from
`window.location`. `path` was `pathname + search` under a name that reads like the first, and the one
caller that did not split it by hand was the public-route guard, so an exact `publicRoutes` rule stopped
matching `/login/?returnTo=…` (`FJS-1083`); analytics sent a reset token under `path` for the same
reason. `goto(path, query, { directives })` joins the two halves the router splits, so no page spells a
`$` name in either direction. `page.search` is the whole query STRING and `page.directives.search` the
`$search` term — one level apart, and they mean different things.

## 2026-09-12 — a sign-in that owes a code

`session.awaitingCode` holds the instant a half-finished attempt lapses at, and `submitCode(code)`
finishes it (`FJS-D261`). Reactive for `session.error`'s reason: a form awaits the promise, a shell
renders off the object, and neither should have to write the other's half.

**The defect this was written to prevent is the refresh.** `signIn` loads the session after the call,
and a challenge has no session to load — so without the branch, `account.me` is asked with no
credential, the 401 reads as a dead session, `clear()` runs, and a correct sign-in is reported to the
person as a failure.

`retryable: false` on the refusal is the server saying the attempt is finished — spent, lapsed, or
never there — and it closes the box, which is what sends somebody back to the password instead of
typing into something that will refuse every code. A retryable one leaves it open. Both directions are
asserted, because a box closed on a typo and a box left open for a spent ticket are opposite failures
one line apart.

## 2026-09-10 — a column the caller was not allowed to read

`withheldFields(fields, record)` reads `x-litestone-read-policy`, and
`resource.withheld(record)` is how `<Form>` asks. A field `@allow('read', …)` is
enforced by STRIPPING the key, so the flag was emitted and read by nothing, and
a generated form offered an ordinary empty box for a note it could not see.

Measured through a real litestone client against `example`'s `Customer.notes`:
an admin reading a row with a note gets the text, an admin reading one without
gets `null`, and everybody else gets no key — both times. So the reader tests
key PRESENCE, and the empty-but-permitted row is the control that decides the
mechanism: keyed off the value, it would tell an admin they lack a permission
they have. The limit comes with it — a row narrowed by `$select` is missing keys
for a different reason, so the answer is sound over a full row, which is what a
form is handed.

The reason it is not cosmetic is the write. A read policy is not a write policy:
the same probe confirmed a caller who cannot read `notes` can overwrite it, so
an empty box that saves destroys a note nobody on the screen has seen.

**`requiredFor` was wrong and this found it.** It tested `evaluate(...) === true`,
but `evaluate` is an EXPRESSION evaluator — a bare column predicate
(`@required(where: active)`, which is what anyone writes for a boolean) answers
the stored value, and SQLite stores a boolean as 1. The SQL half compiles to
`"active"` and treats 1 as true, so the CHECK fired while the form called the
column optional. `truth()` is the fix, which is what litestone's own policy layer
has always wrapped predicates in (`allowHolds`/`denyFires`). Found by putting the
first real `@required(where:)` into `example` rather than by a test.

## 2026-09-10 — `requiredFor` — a column that needs a value for THIS row

`FJS-D259`. `@required(where: …)` is required in the rows a predicate admits, so
the field is not in the schema's `required` list and carries the predicate
instead. `_CARRIED` carries it and `requiredFor(rule, record)` reads it —
`sealedFor`'s opposite number, one attribute over: that one answers which
columns a row has frozen, this one which it has made necessary.

**The evaluator is not sierra's.** `@frontierjs/toolbelt/predicate` IS
litestone's own `evalJs` with a different environment passed in, so this is not
a second reading of the rule that could drift from the boundary's — it is the
boundary's reading, run against the record on screen.

Two answers are deliberately permissive and both match what the CHECK does:
UNKNOWN is not required, and no record is not required. An affordance stricter
than the boundary is a control nobody can satisfy over a write the server would
have accepted, which is the one direction a form must not be wrong in.

`resource.requiredFields(record)` is the list, and it is graded against the
record being ASSEMBLED where `sealedFields` is graded against the row that was
read — the opposite, and on purpose: this is what the CHECK will see.
## 2026-09-10 — `canAtLevel` moved to `@frontierjs/toolbelt/gate`

`FJS-D258`. It was a fifth hand copy of the ladder in waiting: the API realm
needs the same answer and Invariant 1 forbids it from importing Sierra to get
one. `field-rules.js` re-exports the kit's binding, so nothing about Sierra's own
surface moved.

`buildGate` stayed. It reads `schema['x-gate']` — a fact about the document
Litestone's generator emits, not about the ladder — and the ruling that moved its
neighbor is amended to say so.

**Two operations are graded now that were not** (`FJS-1080`): `aggregate` and `upsert` were
absent from the local map and fell through to permissive, so `resource.can()`
offered them at every level. They map to `read` and `update`. An affordance
narrows; the boundary is unchanged.

## 2026-09-10 — `declinedFields` — the write that succeeded and kept a column

`FJS-1071`. A field `@allow('write', …)` is a predicate over the caller AND the
row, so the Data boundary answers it by keeping the stored value: the write
succeeds, every other column lands, nothing throws. Litestone now emits
`x-litestone-write-policy` for such a column; `_CARRIED` carries it, because a
keyword the generator emits and the rule builder drops is a flag nobody
downstream can see.

`declinedFields(fields, sent, saved)` is the reader and it sits beside
`sealedFor` — the same question on the other side of the write, and it has to be
on the other side: *may I write this* needs the predicate and a row, and the flag
is not the predicate. So it compares what went out against what came back, **for
flagged columns only**, which is what keeps `@lower`, `@trim`, `@slug` and a
server-side stamp from reporting as refusals. Primitives only: an object comes
back re-serialized and would report on every save. A column ABSENT from the
answer is `@allow('read', …)` or a narrow select and is not a decline.

`resource.declined(sent, saved)` reaches it the way `sealedFields` reaches
`sealedFor` — through the resource, because `@frontierjs/ui` peers only on mesa
and css.

**Nothing is disabled and that is deliberate**: a control switched off by the
flag is switched off for every caller the predicate ADMITS, which is most of
them. `IDEAS/declared-field-state.md` carries the half that would answer it
before the write.

## 2026-09-10 — the README stops calling the payload pipeline default-off

`coerce`, `blankToNull` and `validate` read as `!== false` and have been on
since; the README documented all three as **Default off** and showed each being
switched on, which is documentation that argues against the code. Each section
now says on-by-default and names its `false`, and the example resource is
`createResource('leads')` with nothing else in it.

## 2026-09-08 — the derived table meets two real apps

The table, the cells and the bar had no caller outside the generator and their
own fixtures. Pointing `example`'s invoice ledger and basecamp's deployments
list at them found four defects in a day, and three of them are the same shape:
a fact the schema already carried that this package re-derived and got wrong.

**A tenancy stamp is not a column** (`FJS-1054`). The Data boundary scopes a
read by it, so every row that comes back holds the same value — and it ranked
`rest`, which puts it on any table whose model declares few enough columns.
Litestone emits `x-litestone-kind: 'tenancy'` and `buildFieldRules` was dropping
it before anything could read it. It is carried now and `columnList` OMITS the
column with a reason; `only:` still names it, for a cross-workspace screen
reading through `asSystem()`. Only a row-tenanted app can see this: `example`
runs `strategy database` and has no such column anywhere.

**The `quantity` tier is *money and time* and was catching almost no time**
(`FJS-1055`). `x-time` is the `@time` ATTRIBUTE, so an ordinary `DateTime`
carries `format: 'date-time'` and none of it. `tierOf` now asks
`defaultDisplayFor` — the owner of *what kind is this column* — instead of
re-deriving it. The BUILT-IN table, not `displayFor`: a contributed display
changes how a column renders and must not change which columns a table picks.

**A relation's header is humanized like every other** (`FJS-1056`). The relation
branch skipped the humanizer, so a foreign key was the one lowercase header on
the table. `@label` is still taken verbatim — it is already a reader's words.

**The display registry is reachable** (`FJS-1057`). `FJS-D242` ruled it into
existence and `src/junction/index.js` forwarded only the control half, so an app
could name a column's control and had no way to name its renderer. Measured
before the fix: `registerFormControl` had one caller in this repo and
`registerDisplayComponent` had none. `displayFor`, `defaultDisplayFor`,
`columnList`, `filterOpFor` and the three registry functions now cross beside
their control-side mirrors.

## 2026-09-08 — the other three surfaces: a table, a detail view, a filter bar

`IDEAS/tables-from-the-seed.md` is shipped. Four rulings and the pieces behind
them.

**`displayFor(rule, ctx)` is a second registry** (`FJS-D242`), not a mode on
`controlFor`: the two disagree at their first branch, since a control is a thing
that WRITES and refuses by name every column a table most wants — `@computed`,
`@generated`, `@from`, `@system`, the `@version`. `registerDisplay(name, resolve)`
contributes to it and the kit binds the name.

**`columnList(fields, opts)` ranks a table's columns from the schema**
(`FJS-D243`) — five tiers, declaration order as the tie-break, `only` to pin.
`resource.columns()`, `summary()` and `children()` are the detail view
(`FJS-D244`): what a form cannot show, defined AGAINST `formFields()` so the two
cannot drift, and children one level deep as links.

**`filterOpFor(display)` is a table, not a third resolver** (`FJS-D246`). Every
display name a table renders is a column a `where` can name, so a filter resolver
would maintain the same list twice. `resource.filters()` asks `x-filterable`
whether the boundary takes a `where` at all before asking the table what to ask
with, and returns a refused column WITH its reason rather than dropping it. It
answers `search` beside the column filters, off `x-search`.

**Read mode reached the browser with it.** The build ships create, an update
delta and now a read delta, so a `@computed` column exists on a screen at all —
without it a table and a detail view could rank and render only what may be
WRITTEN.

Two defects closed under it. `x-sortable` and `x-filterable` were not in
`_CARRIED`, so neither reached a field rule and `!rule['x-sortable']` answered
TRUE for every column including the ones the boundary throws on (`FJS-1043`) —
the exception-only emit is what made it invisible, since absent reads as
permitted. And `displayFor` carried only one of `x-money`'s three shapes, so a
currency held per ROW arrived as `currency: undefined` with nothing naming the
column that has the answer (`FJS-1052`).

## 2026-09-08 — `back(fallback)`

`back()` was `window.history.back()` and nothing else, so on the entry a user
ARRIVED at — a deep link, a fresh tab, a link from mail — it walked them out of
the app. It now takes an optional fallback and uses it only there
([`FJS-D251`](../../DECISIONS.md#fjs-d251)).

Where back goes is DERIVED: the router already stamps `index` on entries it
owns, so nothing is stored, no page declares anything, and there is no
`data-return` attribute — navigation is not the kit's, and the kit depends on no
router. A `?return=` was refused for being a caller-supplied path followed
without checking, which is the open redirect `verify:oauth` already tests.

*Which of three callers* a form returns to is still real history's answer. A page
that must not be returned to is `goto(..., { replace: true })`.

## 2026-09-08 — the js-yaml floor is stated

`FJS-1038`. `js-yaml` is a declared RUNTIME dependency here — `.mesa` frontmatter
is parsed with it — so an advisory against it reaches every app that installs
sierra, which is what the `advisories` phase grades and what turned it red on a
tree nobody had changed.

The range was both the fix and the bug: `^4.1.0` already admitted the patched
4.3.2, so nothing was pinned to a vulnerable copy deliberately — the lockfile had
simply resolved 4.3.1, and a caret says nothing about a floor somebody has a
reason for. `^4.3.2` states it.

## 2026-09-07 — the router still drops an unknown `$` name, on purpose

Junction's bridge refuses one with a 400; this router does not, and the call site
now says why (`FJS-D237`). A typo in a request costs the correctness of the
answer and a refusal costs a retry; a typo in a URL is already a navigation, and
there is nowhere to put an error a person could act on — a half-loaded page is
worse than a missing `$limit`. The comment names the line that changes if a
router ever grows an error channel. No behaviour change here; 1486 passing.

## 2026-09-07 — a view is addressable as a resource

`FJS-999`. The build's model list was `schema.models` alone, so a projection's
definition sat in `$defs` reachable by `$ref` and by nothing else: `createResource`
over a view resolved no schema at all, and every affordance it offers — `can()`
most of all — answered from no declaration.

**Views join the list and enums still do not**, which is the line: a `view` is
something a resource READS, an enum is something a field refers to. The plural
rules cannot reach a service named `revenue` over a projection named
`revenueByStatus`, and that is the case the registry already answers by hand —
`createResource('revenue', { model: 'revenueByStatus' })`, the same escape
`createResource('lenses', { model: 'Lens' })` takes.

Costs the bundle one definition per view and no second one: litestone emits a
projection identically in both modes, so `diffSchemaModes` writes no patch.

## 2026-09-07 — a picker offers what you reached for last, first

`recentHead` resolves a set's declared `recent(Model.column, clock)` into the
first entries of the list, each marked `recent: true` so a control can draw a
separator (`FJS-964`).

**Two bounded queries, not a re-sort.** A picker's list is capped, so ranking
the whole thing by recency would change WHICH rows are offered rather than only
their order — the property this axis was separated from strength to keep. The
rank is an `aggregate` over the binding's own model, the rows come back through
the SET's own filter (scope and the dependent narrowing included, or a retired
value returns at the top of the list it was retired out of), and the page
beneath drops whatever the head showed. The total is the list's and does not
grow.

**Nothing is stored and nothing is per-app.** The rank reads through the
caller's own service, so what a person sees at the top is what their own `find`
would answer. A head is skipped for a search and for stated `directives` — both
are the caller saying what they want — and an unreachable rank leaves the plain
list with one warning naming the set.

## 2026-09-07 — one owner for the order a picker offers

`optionsOrder(order, shown)` — the declared `x-values.order` when the set states
one, the display column ascending when it does not (`FJS-D121`). Three call
sites answered that separately with the same literal, which is why a set could
not state its own order anywhere.

**`optionsQuery` reads like the place and is not.** `options(field)` asks the
field's SOURCE model, whose resource is minted inside `relatedResource` carrying
nobody's declaration — so an app had no way to change a picker's order at all,
and the suite could not see it: it asserts `getOptions()`, which an app calls
directly, and never the `options()` crossing. `test/options-order.test.js` is
that crossing, and every row is asserted beside the default, because a mechanism
that sent the declared order and one that sent nothing are the same observation
from a test that only asks about the declared case.

A literal set is unchanged and needed no work: its members travel in the order
they were written, which is now stated as the rule rather than left as an
accident of array order.

## 2026-09-06 — `resource.aggregate()`

`orders.aggregate({ by: ['status'], _count: true })` — counts, sums and groups
from the client (`FJS-D226`), through `invoke` so it takes the socket when there
is one and HTTP when there is not, like every other service call. Collection
level, so no id.

**Uncached, deliberately.** `options()` caches because a picker's list is
stable; a total is the opposite, and every caller of this wants the number as it
is now.

## 2026-09-06 — a stored value the list cannot offer is pinned, not dropped

Three ways a column's value falls out of its own list — the row was retired by
the set's `@@scope`, the row is soft-deleted, or a controlling field narrowed it
out — and one behavior for all three (`FJS-D225`). A native `<select>` bound to
a value it does not contain shows the FIRST option instead: the wrong value,
silently, and saving writes it.

`options()` appends the held value as `{ disabled: true, unavailable: true }`,
pinned to the front. It costs nothing on every render but the one it exists for:
the extra read happens only when the value is missing from the list, and it is
still the caller's own read, so a row policy that refuses it simply does not
answer. The label falls back to `humanize()` — `dark_blue` reads as English
beside the other options, and an id falls through to itself, since
`17 (unavailable)` is worse than the bug.

**The held value is part of the options cache key**, or two records asking about
one field read each other's pinned entry.

Covers declared sets and relations alike, marks per element for a bound array,
and the word is generic: the seam cannot know whether the cause was a retirement
or a narrowing, and *archived* over a value that is merely not-in-France is a
word that half-fits.

## 2026-09-06 — a dependent picker narrows itself, and says what it is waiting for

`resource.options()` takes the draft `record` and, for a column whose set
declares `dependsOn`, adds the controlling value as an ordinary column filter —
the same narrowing the Data boundary grades the pair by, so what is offered is
what is accepted (`FJS-D122`). It goes into `query` before the cache key is
built, so changing the controlling field re-asks with no invalidation of its own.

**With no controlling value it answers EMPTY and asks nobody**, carrying
`awaiting: '<field>'`. The unnarrowed list would put values on screen that the
boundary refuses — the break this closes, one screen earlier — and *choose a
country first* is then derived rather than written.

`<Form>` passes its own `record` into `optionsFor`, so a control asks for its
options exactly as before.

## 2026-09-05 — a static build published 205 KB no page could load (`FJS-904`)

`target: 'static'` runs the SPA client build and then prerenders over the top of
it, so the client entry, the route table and one chunk per route were produced
and referenced by nothing — `dist/index.html` is overwritten by the prerendered
home page, and a prerendered page loads its islands and nothing else. Measured
on `example/site`: 12 files and 205 KB of the 313 KB published, the entry alone
125 KB. Not dead weight a host skips; published, fetchable and cached.

`build/prune-unreachable.js` walks reachability from the emitted pages and
deletes what nothing can load. Derived rather than listed: a static site has one
way to start a fetch, so the pages ARE the specification of what may be
published, and a list of what the bundler is known to emit would be a second
statement of its chunking.

Removal rather than a narrower build, because the stylesheet comes out of that
same graph — an app's entry imports `@frontierjs/css` and `cssCodeSplit: false`
collects the routes' CSS with it — so cutting the graph takes the CSS too. It is
the step `removeOrphanIslandChunks` already occupies, one line further down.

**Strict about the walk, permissive about files.** Removing a chunk a page needs
is a broken site and leaving one nothing loads is wasted bytes, so anything
named anywhere is kept and the refusal is on the root set: scripts with no HTML
beside them throws rather than emptying `assets/`. An SPA shell that survived
prerendering keeps its whole graph with nothing special-cased, which is what
stops the pass assuming what the prerenderer wrote.

`test/prune-unreachable.test.js`, 7 tests, **5 red with the pass stubbed to a
no-op and the refusal red on its own with the root check removed**. Drives:
`example` `verify:site` 45/45, `verify:shop` 13/13, `verify:account` 32/32, and
the island fixture in a real browser.


## 2026-09-05 — the sitemap advertised a URL that answers 404 (`FJS-456`)

`move404` RENAMES `404/index.html` to `404.html`, so by the time the sitemap is
written `/404/` is not a not-found page being indexed — it is a URL that answers
404. `NOT_FOUND_URL` is exported from `move-404.js` and filtered out where
`indexed` is computed, which is one variable every downstream step reads;
putting the exclusion inside `generateSitemap` would have left `generateLlms`
and `generateMarkdownPages` each needing their own.

The rename also left `404/` behind, empty — a published URL nobody meant to
publish, and a directory listing on a host that serves one. `rmdir` follows it
now and ignores failure, because a non-empty directory is somebody else's file.

The row's headline — dynamic pages missing from the sitemap — was fixed earlier
and never closed. Measured on `example/site`: 17 URLs including all twelve
products, where the filing measured 3.

Its third part is split out as `FJS-904` rather than closed with it: a
`target: static` build ships the whole SPA client, and walking reachability from
the prerendered HTML puts **204 KB of 312 KB — 65% — unreachable from any page
the build emitted**, the SPA entry alone being 124 KB. `test/tools/reach.mjs`
is the probe.

## 2026-09-05 — a shadow root the host owns, and a sourcemap cached for a year (`FJS-825`)

**`el.shadowRoot ?? el.attachShadow()` cannot tell our root from theirs.** A
host page that had already attached an open root to the element got the widget's
stylesheet in its own `adoptedStyleSheets` and Mesa's delegation scoped to its
content — the isolation a shadow root is FOR, running in neither direction. The
widget nests now: a wrapper inside their root, carrying a root of its own,
removed whole on unmount through `entry.wrapper`, because the existing sweep
walks the root we mounted INTO and cannot reach a node one level up.

Refusing the element was the other option and is worse — a widget that silently
does not appear on a page where it could. Nesting keeps it working and makes the
teardown exact.

**The reparent path had to keep its exact shape.** Reusing our own root is what
`FJS-817` fixed, and an extra wrapper there would change what every `:host > *`
rule selects. So `Symbol.for('sierra.widget.ownsShadowRoot')` marks a root this
widget attached, and it outlives the marks map — `unmount` deletes that, and on
a remount the marker is the only thing left that separates our own empty root
from one the host page attached and filled.

**`isHashedAsset` anchored on the final extension**, so
`island-CatalogList-C_TQPJ-f.js.map` read as unhashed: the eight characters
before `.map` are `3d4.js`, which holds a `.`. A sourcemap for a
content-addressed file was revalidated on every load while the file beside it
was cached for a year. The extension segment repeats now, and the refusal is
unchanged — `my-file-name.js.map` still fails on the same eight.

Stub-measured: moving into the host's root fails 4 of the drive's 46, removing
the ownership marker 2, the single-extension pattern 1 of `widget-serve`, and
dropping the leading `-` anchor 2 there and 1 in `site-serve`. Two things worth
recording. The drive's new section first dereferenced a null under the stub and
aborted the whole probe — 34 failures for a defect in one section; it is
null-safe now. And a comment in it carried a backtick inside the probe's
template literal, which is the trap the root `CLAUDE.md` names: the file failed
to PARSE, at a line well past the comment.

## 2026-09-05 — the dev data endpoint, and a robots.txt line every crawler discarded (`FJS-822`)

**Three refusals, and two of them are the half a verb check cannot make.** A
cross-site GET is refused by `Sec-Fetch-Site`: `<img src>`, `<script src>` and a
top-level form GET are all simple GETs and none sends an `Origin` to read, while
the browser sets this one and a page can neither forge nor suppress it. Absent
means a caller that is not a browser, `none` is a typed URL — both allowed,
which is the whole of why the check is not `!== 'same-origin'`. What is
protected is not the response, unreadable cross-origin already, but the side
effect: `load()` is by design where an app reads its own database.

A route that does not declare `render: static` is refused too. This endpoint
exists because a static route's companion never enters the browser graph; any
other route's loader is in the graph already, so running it here was a second
way into code the route table imports differently.

**A throwing `head()` now fails the request.** The build skips the page for it
and a skipped page fails the build (`FJS-439`); dev answered `head: null`, so
one question had two answers and the dev one hid the failure until deploy.

**robots.txt's `Sitemap:` is absolute.** A relative one is not a sitemap a
crawler tries and fails to fetch — it is a line every crawler discards, so the
default advertised nothing while looking in the output exactly like a site that
had. With no `siteUrl` the line is omitted and the postbuild line says which
happened, because the two are worth the same to a crawler and only one of them
admits it.

Stub-measured, each beside a control: the cross-site check removed fails 1 of
14, a check refusing anything but `same-origin` fails **11**, the route-kind
check 1, the swallowed `head()` 1. The robots fix needed a second row and the
measurement is why — with `siteUrl` dropped at the CALL SITE, every unit case
for it still passed. That is `FJS-473`'s lesson, which `postbuild.test.js`
already names for `generateSitemap`, reproduced one function along.

## 2026-09-05 — an island mounted over now stops running (`FJS-890`)

Mesa's `mount()` owns a reactive root, so `handle.destroy()` disposes the component's effects
as well as removing its nodes. `islands/loader.js`'s `disposeWithin` gets that for free and its
comment — which explained in writing that the effects survive, as a runtime limitation this
file could not fix — is gone.

The widget runtime's sweep in `unmount` STAYS. It is answering a different question: what the
element held BEFORE the mount, which Mesa has no way to know, and which is what keeps a
reparented host from remounting beside whatever the first pass left.

## 2026-09-05 — the router: an SVG link, a scroll map that never emptied, and case (`FJS-820`, `FJS-D210`)

**The SVG link was two facts and only one was reported.** An SVG `<a>` reports
`tagName` `'a'` in its own case, so `=== 'A'` walked past it and the click fell
through to a full page load. Measured in Chrome rather than inferred — and the
same probe turned up the second: its `.href` is a truthy `SVGAnimatedString`,
not a string, so `prefetch.js`'s three readers each passed a `!a.href` guard and
handed `[object SVGAnimatedString]` to the fetcher. `linkHrefOf` in
`router/internals.js` is now the one owner of *is this a link, and where does it
point*, and `absoluteHrefOf` folds the three prefetch readers into one — fixing
the entrance the bug was found at would have left two.

**`_scrollPositions` never emptied.** `_rememberScroll` evicts on two axes that
answer different halves: a pushState destroys forward history, so every entry
above the current index is unreachable and deleting it is exact; the cap of 50 is
for depth alone, chosen because browsers cap session history around there, so an
entry it evicts is one the Back button can no longer reach either.

**Matching is now case-sensitive (`FJS-D210`).** It was the only one of four
readers of *which route is this* that was not — `isActive`, the prefetch cache
key, `page.path` and the filename a static build writes are all case-sensitive,
so `/ADMIN/` rendered in the SPA, reported itself as not active, cached under its
own key, and 404'd on the static host. The refusal alone was not enough: a
case-only miss is NAMED at both entrances, and the second is the one that
mattered — an app with a catch-all has a truthy match, so nothing warned and the
reader got Not Found for a route that exists.

Stub-measured, each beside a control that must not move. Worth recording: the
control for the scroll cap **passed the stub the first time** — a map cleared on
every navigation still holds the entry just written, so the control had to span
more than one navigation before it could see the difference.

## 2026-09-05 — a hook that breaks the chain is refused by name (`FJS-823`)

An `around` hook that returns without calling `next()`, one that catches the
failure and does not rethrow, and an `error` hook that clears `ctx.error` and
sets nothing all ended `_call` with no result — and it resolved to the `null`
the context was born with. A screen reads that as an answer:
`(await r.service.find()).data` throws a TypeError in the app's own code, one
hop from the mistake.

`null` is a legitimate answer as well (a `get` for a row that is not there), so
the fix tracks the ASSIGNMENT rather than the value — `hookContext` and
`answered` from `@frontierjs/toolbelt/hooks`, shared with jetty, which had both
lines hand-copied. `ResourceHookError` names the phase and says the two ways
out, and the error-phase form carries the discarded failure on `cause`: the
original is gone by then, and without it the report is only "your hook is wrong"
while the outage is invisible.

Every refusal in `test/resource-hook-chain.test.js` is paired with the
legitimate hook one line away — an `around` that short-circuits WITH an answer,
one that answers `null` on purpose, an `error` hook that recovers with a
fallback — because a guard that refused both would make the phase useless for
what it is for. Stub-measured: the around check removed fails 3 of 12 and the
controls hold, the error check 1, and `hookContext` swapped for a plain object
(the guard that refuses everything) fails 7 — which only the controls can see.

## 2026-09-05 — `save()` patches what CHANGED

`FJS-809`, `FJS-808`. 81 files / 1409 tests, green.

`save()` is a record-shaped verb — `<Form record={row}>` hands back the whole row — and it
sent that row whole, which makes a PATCH a PUT. A column the screen never rendered
(`formFields({ except })`, a hand-written form, a column added to the `.lite` after the
screen was written) rode along at the value it held when the form opened and overwrote
whatever somebody else had written to it meanwhile. The other person's change went with
nothing said.

`@version` catches that and is the right answer where it is declared, but it is opt-in: the
correctness of every generated edit form depended on the model author having declared a
column, and nothing checked it.

**The baseline is the row this resource READ**, which `_read` already holds for the version
stamp — so the fix is derived rather than declared, and needs no new option, no new noun and
no argument at the call site. Three proposals were on the table and the other two both
restated something: `save(data, { only })` puts *which columns this form writes* beside the
rendered list where a disagreement is silent, and a dirty diff inside `<Form>` fixes one
instance of the class and cannot reach a hand-written `resource.save(row)` at all.

Invariant 9 holds and is the reason the comparison is `!==` rather than a truthiness test: a
diff OMITS a key and never substitutes one, so an explicit `null` against a non-null
baseline differs, travels, and clears. With no baseline the whole record goes up, which is
what every patch did before — a miss is the old behavior and never a lost value.
`service.patch(id, data)` is unchanged and is the escape: **this verb takes a record, that
one takes a payload.**

**`auto` now asks whether the row exists rather than whether an id is present.** Presence is
a sound proxy only where the SERVER assigns the key, and litestone deliberately emits a
caller-supplied `@id` in the create schema so a generated form has a box to type it into
(`FJS-608`). Reading presence there routed what the person had just typed into a patch, so a
create form over `Sku { code String @id }` could never make a row — it threw *Unknown field
'id' in where* — and left EMPTY it was worse, because `make()` seeds `''` and `'' != null`,
so the form issued a patch over the whole COLLECTION. For those models the question is
whether this resource has read that id; a miss creates, and a create over a key already
taken is refused loudly by the layer that owns uniqueness. `mode: 'patch'` with a blank id is
refused by name rather than sent. `service.upsert` reads the same `_writeMode`, so the two
verbs cannot drift, and it no longer tests the id for TRUTHINESS, which additionally read `0`
as absent.

## 2026-09-05 — the browser gets the schema's shape and none of its prose

`FJS-785`, ruled `FJS-D204`. `FJS-807` in the same pass.

A doc comment is not an affordance. `description` was 78% of the compressed schema bundle —
130 strings, 22 124 characters on models and 34 411 on fields — shipped to an anonymous
visitor in a static file before authentication, read by nothing.

Measured through a real `bun run build` of `example`, against the same build with the strip
stubbed to the identity: the emitted payload went 29.7 KB → **6.7 KB** gzipped, and the app's
own entry chunk 79.52 KB → **56.17 KB**. **23.35 KB gzipped, 29% of everything the app
ships, with no feature behind it.**

`stripProse` is a schema-AWARE walk, and the version that was not is now the negative
control. Filtering by key name alone deletes `Product.description` — a real column of
`example` and of four models in basecamp — from every generated form on a build that says
nothing, which is the finding's own disease reproduced by its fix. `_NAME_KEYED`
(`properties`, `$defs`, `definitions`, `patternProperties`, `dependentSchemas`) marks the
maps whose keys are columns somebody declared; everywhere else `description` is an
annotation and goes. Stubbed to the identity, 5 of the 12 tests fail; stubbed to the naive
walk, 3 fail and all three are the control.

**Every build now logs the emitted size beside the model count.** A refusal that hides its
own price gets reversed.

A PROJECTION over the model set was refused in the same ruling and the refusal is the part
worth keeping: a build-time scan of `createResource` sites is a second and weaker statement
of which models an app uses, `createResource('anything')` would start depending on how the
call site spelled it, and a miss renders an EMPTY FORM on a green build. It would also prune
`createResource`'s own *Known models:* diagnostic, so the error message would lie about what
the schema declares.

**Both write modes cross now** (`FJS-807`). A create schema and an update schema are
different documents in three ways that matter to a form: `@immutable` is writable on a create
and `readOnly` on an update, a sealing `@immutable` carries `x-litestone-seal` instead, and
the `@version` column exists in the update schema alone. Only the create table shipped, so
`sealedFields(record)` answered `[]` for every row of every model, and `_call` judged a patch
by create rules — sending a column the Data boundary refuses BY NAME, telling the person to
leave out a field they never assembled. `_call` picks the table off the method now;
`formFields()` stays on the create table, because one resource serves both screens and the
field SET is the same question for each.

## 2026-09-05 — `presence()` speaks to the client that exists

`FJS-811`, `FJS-824`.

`@frontierjs/sierra/presence` threw `TypeError: client.send is not a function` on its first
line for its whole life, and its test suite passed throughout, because that suite invented
the client it graded — including an `emit` that dispatched `presence:sync:workspace:1`, one
of five channel-suffixed names junction has never emitted. Frames arrive under their own
names (`presence:sync`, `:join`, `:diff`, `:leave`, `:update`) with the channel inside the
payload, so the module heard nothing at all.

The file is rebuilt against the real `createJunctionClient`, in two halves: a real Junction
app in a bun subprocess with **two real sockets on one channel**, which is the only
arrangement that can say whether presence works, and the diff/leave/dedupe reducers driven by
pushing the frame shapes the first half proves the server sends.

**What it cannot do is documented rather than worked around.** Channel membership is the
app's, decided in its own `channels(setup)`; nothing a browser sends joins a channel, so
`client.presence.announce()` means *here is my meta, send me the roster* and a channel this
connection was never joined to answers nothing, in silence — which is what a misspelt channel
id looks like. An anonymous connection is never tracked. Junction gained `client.presence`
(`announce` / `release`, deliberately not the wire's `subscribe`/`unsubscribe`, which do not
subscribe) and states `you` on the sync frame, the only frame sent to exactly one connection
and therefore the only one that can carry it — without it nothing can split a roster into
self and others, because a browser is never told its connection id. Until the first sync
lands every member is an *other*, which is the safe way round for an avatar strip.

The announcement is unconditional and re-sent on every connect. It was gated on
`client.token || client.connected`, which is false for every cookie-mode app and for the
ordinary case of a component mounting before the socket is up; a reconnect is a new
connection with no meta and no roster, so the client re-announces every channel it holds.

**Two views of one channel are refcounted** (`FJS-824`). An avatar strip in the header and a
list in the sidebar are one connection's one meta, and the first to unmount used to send the
release for the channel the other was still showing.

## 2026-09-05 — nothing a resource holds outlives the person it was read for

`FJS-786`.

A Resource is created once, at import, in a resource file's `<script module>` (Invariant 18),
so everything it caches lives for the life of the TAB while the principal is a thing that
changes inside it — a sign-out, a switch-account button, a shared terminal, a support agent.
Three caches were on the wrong side of that line and all three are read before anything asks
the server again: the live store, so a mounted list renders the previous person's rows until
their own `load()` resolves; `_read`, so `version(id)` answers a revision the current caller
never read; and `_options`, which is worse than a window because a picker never asks again —
the second caller is offered a row their own row policy hides, by id and by label, which for
a `Customer` is a person's name.

This package had already learned the rule and wired half of it: `_tokenChanged` calls
`invalidatePrefetch()` for `FJS-041`. The three siblings are joined to it now. The cache
stays useful WITHIN a session, which is the half a fix that simply deleted it would fail —
the epoch is bumped on a change of identity and on nothing else.

## 2026-09-05 — a credential has one audience

`FJS-788`, `FJS-787`, plus the public-route wildcard and `signOut`.

**`sierraFetch` attached the session token to whatever URL it was handed.** `load()` is given
it and the docs tell a page to use it, so a page geocoding a postcode or reading a CDN's JSON
handed that vendor a replayable session. A relative URL cannot leave this origin; an absolute
one is now checked against the page's own origin, the API's and the configured `baseUrl`, and
anything unresolvable answers no.

It is handed the CLIENT rather than a storage key. Reading `localStorage` here was a second
owner of the token — the same bug the client's own `tokenStorage` exists to end — and it is
the half that cannot answer cookie mode, where there is no token and the credential rides a
cookie. In that mode the request now carries `credentials: 'include'`, scoped to the same
audience: without it every `load()` was anonymous the moment the API was a separate origin,
which is the deployed arrangement, and for a list that is a 200 with an empty array rather
than a refusal anybody notices.

**`junction.cookieAuth` is forwarded to the client** (`FJS-787`). The browser cannot see the
server's source and there is nothing to derive it from, so `createAuthPlugin(auth, {
cookieAuth: true })` has a twin in `sierra.config.js`. Left off, the client answers
`hasCredential === !!token` — false for a signed-in cookie-mode caller — so there was no boot
restore, no socket, and a sign-out that skipped the one call that ends the session while
answering `{ revoked: true }`.

**A trailing `*` in `auth.publicRoutes` is a segment boundary**, not a string prefix. It was
the latter, so `/blog*` covered `/blogadmin` and `/blog-internal`, and the guard's public
branch returns before the boot restore is awaited — a route that merely shared a prefix
skipped the whole guard. Invariant 6 caps what that costs, but a list whose only job is to
name exceptions must not widen itself.

**`signOut()` clears in a `finally`.** It held only because junction's own `signOut` catches
internally; an app supplying its own auth surface would leave a person looking at a signed-in
UI with no session. The refusal still propagates, which is the half a `catch` would have
eaten.

## 2026-09-05 — `status.stale`

`FJS-812`.

The whole `x-fjs-build` channel — the CLI's stamp, the response header, the socket's
`connected` frame — exists so a browser left open across a deploy can be told, and it ended
here: `build:` was passed to the client so `stale` COULD fire and nothing listened.
`status.stale` is `null` until the server states a build this bundle is not, then
`{ client, server }`, and a shell renders it the way it renders `connected`. Set at most once
per page, because a banner that reappears on every request is one nobody reads. Recorded
rather than acted on: whether that is a banner, a prompt or a silent reload is the app's
answer and not this module's.

## 2026-09-05 — the router commits the navigation last STARTED

`FJS-791`, `FJS-789`, `FJS-790`, `FJS-820`.

`_navigate` has four await points, so the last navigation to FINISH committed rather than the
last one started: a slow `load()` from a route the reader had already left overwrote the page
they were on and pushed its own URL into the address bar. A sequence stamp — the same shape
`createResource` applies to its own loads (`FJS-082`) and junction's store applies to a push
— is checked after the guards and again immediately before the history write, which is the
first irreversible line.

**`beforeNavigate` runs on the Back button** (`FJS-789`). It did not, sitting inside the same
condition as the scroll save, while `meta.redirect` three lines below it did — one kind of
routing refusal survived Back and the other did not, where the README promises the opposite
and `FJS-D06` files `beforeNavigate` under Hook, the tier that may halt the operation. A
refusal on popstate puts the address bar back with `history.go`, because the browser has
already moved and a URL naming the page the guard just declined is the same lie as not
guarding at all; the return trip's own popstate lands on the page the reader is already on,
so a guard that refuses everything settles rather than looping.

**An `href` resolves against the current page** (`FJS-790`). `new URL(href,
window.location.origin)` carries no path, so `<a href="#comments">` clicked on
`/blog/my-post/` navigated to `/`, and so did `./`, `../other/`, `?draft=1` and `edit/`. A
fragment on the page already showing is now a pushState and a `scrollIntoView` rather than a
re-import and a re-run of `load()`.

**The route is matched BEFORE the browser's navigation is cancelled.** `preventDefault` ran
above the match, so a click on any same-origin URL the route table does not cover — a file
the app serves at `/downloads/report.csv`, a link into a sibling surface — was eaten: the
catch-all rendered, or in an app without one nothing happened and the console said *No route
found*. The catch-all deliberately does not count as cover here; it is the answer for a URL
somebody typed, not for a link the app itself wrote to a URL it does not route.

Three more in the same file. A redirect target must be a path on this origin — `//evil` and
`/\evil` are refused by pushState itself, which left `page.pending` set (RouterView's loading
snippet, forever) and rejected `goto` with nothing catching it; ten redirects without landing
is a reported loop rather than unbounded recursion, where two guards redirecting to each
other made 501 calls in 7 ms and said nothing; and a route registering no component is
refused in `_navigate`, the last frame that still knows which FILE it was, rather than in
`ChainRenderer` naming an internal expression. `isActive` matches on a segment boundary, so
`/leads` no longer highlights on `/leads-archive`. And `initRouter` binds its click and
popstate listeners once per window rather than once per call, or three boots — an HMR of the
boot module, a re-mounted micro-frontend, a suite that boots twice — meant one click running
three concurrent navigations (Invariant 11).

## 2026-09-05 — five shapes the build used to emit and now refuses

`FJS-796` … `FJS-801`, `FJS-819`, `FJS-821`.

Each names its file. A `getStaticPaths()` param that is empty, a path, `.`/`..` or carrying a
NUL, and two entries that fill one output file (the empty one collapses onto the parent page
and overwrites it; a URL that walks out of the tree writes a file anywhere the build can
reach). A `<slot name>` that is not an identifier. Two route files mapping to one URL. A
frontmatter alias bomb — 10 000 values, counted by a walk that aborts at the budget, because
stringifying to measure has already paid the cost: 205 MB in 1576 ms became a refusal in
5 ms. And a widget tag that is not a legal custom element name, checked before the first Vite
call and again in `fli make:widget`.

They are refusals rather than warnings for one reason: every one of them BUILT, and what
shipped was a page silently overwritten, a component that renders as nothing, or a script
nobody notices is missing.

Two more from the same pass. The scanner stats a symlink and keys visited directories by
REALPATH, so `loop -> .` is skipped and named rather than hanging, and `matchRoute` defines
its param instead of assigning it, so `[__proto__].mesa` yields a readable param. Minify is
decided by the build rather than by `NODE_ENV`, so a dev-flavored environment no longer ships
an unminified widget.

## 2026-09-05 — the toolbar renders text somebody else wrote

`FJS-820`.

Every value in the devtools panels arrives over an unauthenticated WebSocket, and the toolbar
sits at `z-index: 2147483647` on the page where the app's own tokens live. Four hand copies
of an `esc()` helper had been applied to six of the eight interpolations that needed one, and
the two misses were not the same miss: `transport` reached a `class=""` attribute and
`log.level` reached a text position, in different files, written by whoever last copied the
helper. The helper also escaped three characters, so even the six covered sites were unsafe
inside an attribute.

`src/devtools/html.js` is a tagged template that escapes every `${}` by default — five
characters — with `classSuffix()` and `num()` beside it; a nested `html` result carries a
marker and passes through raw, so markup composes without an opt-out a plain string could
reach. A default-escaping tag makes the omission unwritable rather than merely fixed, which
is what the disease needs. 13 of the 15 new tests fail with it stubbed; the two that hold are
the negative controls, because a renderer that dropped the field would satisfy any assertion
that only checks for the absence of the injected element. The dev overlay's own four `data-*`
attributes were escaping nothing at all and are escaped now.

Sibling defects in the same files: `waterfall.js` threw on a string duration, and
`requests.js` put a raw `durationMs` into both a text position and `style="width:"`.

## 2026-09-05 — both static origins answer like servers

`FJS-753`'s shape, and the widget half beside it.

`src/serve/http-answers.js` is what the two share — `methodAnswer`, `byteRange`, `compressed`,
`bodyAnswer` — and what they do NOT share stays deliberate: `site/serve.js` sends no CORS
because it serves documents a browser navigates to, and `widget/serve.js` exists for the
cross-origin case.

Both gzip a compressible body of 1 KB or more with `Vary: Accept-Encoding`. Measured on
`example`'s own built widget: 25 282 → 10 437 bytes, 41%, at 0.47 ms per response. Not
cached, because these servers already read the file per request and a cache would be the only
state in either. `site/serve.js` gained real single-range support (206 and 416, suffix and
open-ended forms); a range and an encoding never combine, since a range's offsets are into
the identity representation. `OPTIONS` is 204, a wrong verb is 405 **with `Allow`**, and
`widget/serve.js` answers `Access-Control-Max-Age`.

## 2026-09-05 — a widget's mount mark belongs to the element

`FJS-814`, `FJS-818`, `FJS-815`, `FJS-817`, `FJS-825`. `test:widgets` 25 → 36 assertions,
green.

The mark that says *this element is mounted* was a module-scoped `WeakMap`, so two copies of
the runtime on one page each believed they owned the element. It is on the ELEMENT now, under
`Symbol.for('sierra.widget')`, keyed by tag.

`mountGuarded` wraps each element's mount in a try/catch, reports the failure and marks the
element failed, so the observer does not retry it on every mutation — one hostile or broken
element used to take the whole page's widgets down with it (24 of 36 assertions fail with the
guard removed). `adoptCss` prefers a constructable stylesheet and falls back to `<style>`,
which is what makes the kit work under a strict CSP. `unmount(el, tag)` sweeps the root back
to the snapshot it held before the mount, so a host's pre-attached content survives, and drops
the adopted sheet. An element holding a widget's tag that this runtime did not stamp is warned
about; a stamped one stays silent, which is the double-load control.

Props are read ONCE, at mount, and that is now stated in the module header and in the
scaffold's own comment rather than being folklore.

## 2026-09-04 — a screen's gate verdict is the boundary's function

`canAtLevel` and `transitionsAt` compared with `level >= need`, which is not what
the Data boundary does: 8 and 9 are SENTINELS, so `>=` renders a button for a
LOCKED operation and hides one from the system context. Both use
`levelPasses` from `@frontierjs/toolbelt/gate` now — the same binding Litestone
enforces with, reachable because the kit is substrate below the dependency graph
and this module still imports no client (`FJS-520`, ruled `FJS-D197`).

Unreachable today, since every resolver clamps a caller to 0–7, which is what
made a hand-spelled `>=` look like a style choice.

## 2026-09-03 — `resource.sealedFields(record)`

`FJS-628`. 1146 passing.

Which columns are frozen for a given row — the `@immutable` ones on a model that
seals, once the row has reached a sealed state. `sealedFor` was the owner and
had no caller; this is how a form reaches it, alongside `formFields` and
`options`, because `@frontierjs/ui` peers only on mesa and css and may not
import sierra.

It answers a LIST rather than a predicate, which keeps it one call per render
instead of one per field, and no record answers `[]` — a create form is making a
draft.

## 2026-09-03 — the presence store understands a batched frame

`FJS-703`. 1146 tests, 0 fail. Typecheck clean.

Junction now coalesces presence join and leave into one `presence:diff` per
channel per window, because a join used to send a frame to every existing member
and N connections cost N x (N-1) frames — 251 500 of them for 500 users. A
client that only knows `presence:join` and `presence:leave` sees presence
silently stop updating, so `onDiff` is not optional.

**Leaves are applied BEFORE joins.** A connection that left and rejoined inside
one window is in both lists, and the other order removes the row it had just
added. Joins are deduplicated against what is already held, since a reconnect
can put a connection in a batch that a `presence:sync` already reported.

The unbatched events are still handled: `presenceFlushMs: 0` is a supported mode
for an app that wants presence instantly, so neither spelling is legacy.

## 2026-08-30 — a service with no model can say so

`createResource(name, { model: null })`. 1141 tests, 0 fail.

A resource over a service with no model — a status read over configuration, a
cross-tenant tier, a projection assembled from several tables — resolved
nothing in the schema registry and warned about it on every boot. The warning is
right about the ordinary case (a misspelt model name is silent otherwise) and
wrong about this one, and there was no way to tell them apart: basecamp has
three such resources, so its console carried three of these warnings forever and
every reader learned to skim past the one that means something.

`model: null` is the declaration rather than a mute — the resolver is skipped
and the warning with it. Everything else is unchanged: no schema means no field
rules, so coerce, blank-strip and validate stay inert exactly as before.

## 2026-08-29 — `record()` takes options, and honors `detailQuery`

1141 tests, 0 fail. Two changes behind
[`FJS-D161`](../../DECISIONS.md#fjs-d161).

`resource.record(id, { composed })` passes the declaration through to junction's
record view, for a service whose `get()` answers more than the row.

And the read behind it is now the same read `service.get(id)` makes — the
resource's own `detailQuery`, which `record()` had silently ignored for its
whole life. A resource that declares the include shape a detail view needs
declares it once, and a record view is a detail view.

## 2026-08-30 — the bundle knows which build it is

`initJunction` passes `import.meta.env.VITE_FJS_BUILD` to the client as `build`,
so a browser can tell it is running the previous deploy's code. The deploy stamps
it (`03-build-web`), vite inlines it, and it travels INSIDE the bundle rather
than being fetched — which is what makes it true for a browser still holding the
old one. The server states its own on every response and on the socket's
`connected` frame, and the client compares
([`FJS-D160`](../../DECISIONS.md#fjs-d160)).

Read through a guarded function, because the same module is imported by the
prerender, which runs in Node where `import.meta.env` does not exist. Absent in
dev and in any build nobody deployed, and the client is inert on that.

## 2026-08-29 — a picker that could not ask says so

`resource.options()` answers `error` where the fetch failed, a declared value set
would not load, or the field is neither an enum nor a foreign key. *There are
none* and *I could not reach the service* used to be the same empty list, which
is how a service nobody could resolve looked like a shop with no variants in it
(`FJS-570`). The kit does not render it yet — `FJS-587`.

## 2026-08-29 — the prerender is bounded, and the shape that used to hang is pinned

`FJS-549` and `FJS-550` were one failure wearing two descriptions — a layout
holding an island, and that island's graph reaching `@frontierjs/sierra/junction`
through a store. Neither reproduces. Every documented shape was run against a
real build under `bun --bun`, including the composite nobody had tried, and all
of them built and exited 0. What closes them is `test/fixtures/layout-island/`
and the prerender test over it, with a negative control that fails when the
store is not really reached; the cause of the fix was not bisected and is not
claimed.

### the clock — the prerender is bounded

A prerender that hangs writes nothing and says nothing, forever — the client
bundle finishes, prints its chunk table, and then silence, which reads as a
compiler that stopped rather than a build that will never finish. Both known
causes (`FJS-549`, `FJS-550`) were found in one afternoon by one feature, and
every diagnosis cost a full build cycle with no output to go on.

Each unit of per-route work — `getStaticPaths()`, `load()`, `render` — is now
raced against a clock. `prerender: { timeout }` in `sierra.config.js`, 30s by
default, `0` to turn it off. A route that stops answering fails the build naming
the route, the phase and the two shapes anybody has hit so far, so the failure
can be reported by somebody who has not read this file.

It diagnoses nothing and is not meant to: what it converts is silence into a
message. **A synchronous spin is still not covered** — the timer needs the event
loop, the same limit caravan's job timeout states about a handler that never
awaits.

## 2026-08-29 — the build keeps the one true error

`FJS-551`. A module whose top-level `await` throws reports its real error
exactly once; every import after that resolves to a partially-initialized
namespace, so the next reader gets `Cannot access 'X' before initialization`
naming whichever binding it touched, and the cause is gone from the process.
That is the runtime's and cannot be fixed here. What was Sierra's is that it
threw the one truthful error away — `resolveBuildDb` and `importCompanion` both
read `catch { return null }` — so a schema parse error naming a file and a line
came out as four TDZs and cost two people the same wrong diagnosis in a day.

`src/build/app-import.js` is the one owner of *import a module the app wrote*.
It records the first failure that is not itself a TDZ, refuses to import a
module that already failed — re-importing is what manufactures the lie — and
**touches every binding of a namespace it just imported**, because a half-built
module does not throw on import: it throws when somebody reads a binding, which
without this happens in whichever caller reached for `.db` or `.load`, outside
anything that could explain it. `explainModuleInitFailure` now prints the
recorded cause instead of advice to go and reproduce it.

The two answers are separated at both doors. A db module that is ABSENT or
wrong-shaped still warns and continues, because a page that cannot be observed
is refused by `checkRoute` anyway; one that THREW fails the build. A companion
that is not there is still `null`; one that would not load throws naming the
route — the same fail-open shape `FJS-439` closed for a render that threw.

## 2026-08-29 — `x-money` and `x-scale` reach a field rule

1126 tests, 0 fail.

`buildFieldRules` carries a fixed list of keys onto a rule, and neither of
these was on it — so `@money` and `@scale` reached the JSON Schema and stopped
there. Nothing downstream could tell a scaled integer from an ordinary one: a
generated form offered a spinner stepping by 1, and a person editing a price
typed the number on the label and stored a hundredth of it.

They are carried for the reason `x-time` is — the keyword decides a CONTROL and
nothing else on the rule can answer — and the effect is that the contributed
control the docs have always shown can be resolved off the DECLARATION:

    registerControl('money', (rule) => rule['x-money'] ? 'money' : null)

which is what both docstrings now say. They used to match a column name ending
in `Cents`, a convention no schema in this repo uses. What the control IS stays
an app's decision — the currency's symbol, whether the box is in major units,
what a blank means — and `example/web/src/money-control.js` is the first one.

## 2026-08-28 — a static surface's dev server shows its data

1126 tests, 0 fail. Typecheck clean.

`vite dev` on a `site/` surface rendered every page empty. Correctly empty:
a `render: static` route's `load()` runs in Node at build time, its companion
may never enter the browser graph, and so the client route table has no loader
for it. Sierra said so once per route — at `info`, among thirty lines of Vite
output — and the page underneath was indistinguishable from one whose query
found nothing. `example/site/`'s catalog read *0 products, prerendered*.

The dev server is a Node process. So the loader runs there, at
`/__sierra/static-data` (`build/static-data-plugin.js`), and the browser gets
JSON. `example`'s catalog now reads *12 products* in dev, and the page's own
`head()` comes back on the same round trip because the router asks for it after
the data.

**What the client table emits is a fetch shim, never an import**, and that is
the whole safety argument rather than a detail: an import is what pulled a
storefront's Litestone client, DDL emitter and migration engine into a published
directory as fetchable files (`FJS-543`). A fetch cannot, whatever the companion
reaches for. It is asserted on the shape — the build's table must contain no
`import('…meta.js')` and no shim — because that property is invisible until the
day it is not.

**It does NOT use `server.ssrLoadModule`**, which was the obvious choice and does
not work. Vite's SSR runner rewrites the module and does not provide Bun's
`import.meta.dir`, so `example`'s own db module dies on `join(undefined, …)`
before a query is made. The companion is imported the way the BUILD imports it —
a plain dynamic `import()` of the file on disk, exactly what `importCompanion`
does — keyed on the file's mtime, so editing a `load()` is picked up on the next
navigation while the modules it imports stay cached and the database client is
not rebuilt per page view.

**The dev server must therefore run under bun**, which is what `build:site` has
always needed and for the same reason. `siteScripts()` writes `bun --bun vite`
for both now; under node it fails as *Only URLs with a scheme in: file, data,
and node are supported — received protocol `bun:`*, which names nothing an app
author did.

`dev: { staticData: false }` is the way back to the old behavior. Default true,
because a dev server you cannot see the site on is not much of one.

## 2026-08-27 — the build only ever showed the second error

`FJS-551`. 1122 tests, 0 fail.

A half-written `@@transitions` block in `example/db/schema.lite` made
`bun run build:site` print four messages — `static safety: could not load
'../api/src/core/db.ts': Cannot access 'db' before initialization.` and three
routes failing with `load() threw: Cannot access 'sys' before initialization.`
None of them names a schema, a line or a parse. The real error is
`@@transitions(status): expected '->' after 'pending', got 'ship' (line 837,
col 3)` and it was printed nowhere. Two people read it as a broken build on the
same day; it was a broken file.

**The mechanism is not Sierra's.** `api/src/core/db.ts` ends in
`export const db = await openShop(…)` — a top-level await. Import it three times
in one Bun process with the schema broken and the first throws the parse error,
the second and third throw `Cannot access 'DEFAULT_SHOP' before initialization`.
A failed TLA module re-imports as a partially-initialized namespace instead of
re-throwing, so every reader after the first gets a TDZ on whichever binding it
touched and the cause is gone.

**What is Sierra's is that a build imports that module from several places, so
what it holds is almost always the second kind.** `explainModuleInitFailure`
annotates a `before initialization` message with what it actually means and the
one line that shows the cause (`bun -e "await import('<the module>')"`). Applied
where `resolveBuildDb` warns and where a route is skipped for `load() threw`,
`getStaticPaths() threw` or `render failed`.

Additive on purpose — the original message is kept in front, because it is still
the only thing that names where the read happened, and any other message is
returned untouched. What it does NOT do is fail the build: the comment above
`resolveBuildDb` is right that a missing or wrong-shaped db must stay a warning,
since an unobservable route is refused by `checkRoute` anyway. Separating *the
module threw* from *the module is not there* is the open half of the issue.

## 2026-08-27 — `@` resolved against the cwd, so it never worked

1122 tests, 0 fail.

`@` is the surface's own `src/` — the alias that turns `../../money.js` into
`@/money.js` in a route three directories down. It had been in the config object
`createSierraViteConfig` returns, as `resolve(process.cwd(), 'src')`, since the
config was written. That is the same directory only when the command was typed
INSIDE the surface: `build:site` does `cd site` and would have worked,
`vite build -c web/config/vite.config.js` from the app root — which is every
`dev` and `build` script this repo scaffolds — resolved `@` to an `example/src`
that has never existed.

Nothing could see it. A missing alias TARGET is not an error; Vite falls through
to Node, which reports `Cannot find package '@'`, and that reads as a missing
dependency rather than as a broken alias. And no app in this repo had ever
written a `@/` import — the feature shipped, was never used, and was wrong.

The base is the **Vite root** now, and it comes from a plugin
(`build/app-alias-plugin.js`) rather than from the returned object, because the
app's own `vite.config.js` spreads that object and sets `root` afterwards — at
the moment it is built there is nothing to resolve against. A plugin's `config()`
hook is handed the user's config with `root` already on it, and its return wins
over the same key in that config (measured, not assumed). It is in the island
bundle's and the widget build's plugin lists too, since both are separate Vite
builds handed their own `root`.

**The prerender is a second resolver and had to be told separately.** It compiles
a page and imports it under Node, which has no aliases at all, so a page that
built and ran in the browser would have died in the static build. `prerenderRoutes`
passes the same table to `renderComponent({ alias })` — one base (`appSrcDir`),
two resolvers.

Proven by conversion rather than by assertion alone: `example`'s six site
islands, eleven SPA routes and one widget now import `@/api.js`, `@/money.js`
and `@/cart.js`. The negative control is the same builds with the cwd base put
back — four unresolved imports in the SPA, which is what had been shipping.

What `@` cannot say is a sibling of `src/`. `extension/src/harbor/index.js`
reaches `../../config/jetty.config.js` and stays relative.

## 2026-08-26 — dev on a static surface ran the build-time loader

`FJS-543`. 1114 tests, 0 fail.

A `render: static` route's `load()` runs in Node at build time and is where an
app reads its own database. The client route table kept its import anyway, and
the comment beside the omission asserted that this was fine — *dev is untouched,
`vite dev` on a static target IS a client-routed app and calls `load()` in the
browser*. True of a client-routed page; false of a prerendered one.

So the dev router imported the companion, called it, and got `Module "fs" has
been externalized for browser compatibility` — caught, downgraded to a
`console.warn`, and rendered as a page with nothing on it. Vite followed the
same import into the browser graph on the way and reported eight un-analyzable
dynamic imports out of litestone's migration runner and junction's config
loader, service autoloader and database storage.

The rule is per ROUTE now and not per target: a prerendered route's loader is
build-time by definition, and a route on a static target that is NOT prerendered
is an ordinary client-routed page whose `load()` does run in the browser and
keeps its loader. That is more precise than the whole-table switch the static
build sets, and the switch is untouched — this narrows what dev ships and
nothing about the built output changes.

The router says the rest, once per route, in dev: `data` is null here because
this page's data is baked at build time. *Empty and correct* and *empty and
broken* are otherwise the same screen.


## 2026-08-26 — a `File` column has a control

`FJS-409`. 1114 tests, 0 fail.

`controlFor` answered `{ control: null, reason: 'file — a stored file reference
needs an upload path a form does not have' }`, which was honest and was not a
control. The upload path turned out to be built and unused: the junction client
switches a request to `multipart/form-data` the moment any value in it is a
File, the bridge merges those files back into `ctx.data`, and `FileStorage`
stores the bytes and writes the ref.

So the bytes go **with the record**, through the service the form already calls
— which is also the only route carrying the gate, the row policies and
`@accept`. A signed URL or an upload endpoint would be a second door with its own
answer to who may write.

`x-litestone-accept` is carried now, so the file dialog offers the same list the
Data boundary enforces. The refusal is real either way; a person who has already
chosen a 4MB file and waited for it to upload is being told something the dialog
could have said first.

Nothing else changed: a browser `File` already passed through strip, coerce,
blank and validate untouched, which is why there is no pending state to
reconcile and no upload to resume.


## 2026-08-26 — a wall-clock column gets a time input

`@time` reaches the schema as a `pattern` plus `x-time: { seconds }` (litestone,
same date). `x-time` is carried into the field rules and the control table answers
`<input type="time">` for it — the same argument `date` already wins: a wall clock
has no zone, so the element round-trips it and a type attribute is the whole
answer, where `date-time` needs a control because `datetime-local` carries no zone
and the value has to be converted at each edge.

`step: 1` where the column accepts seconds. The element shows HH:MM unless the
step is not a whole number of minutes, so without it a person cannot type a value
the boundary would take. `Input` already forwards both `type` and `step`, so
`@frontierjs/ui` needed no change.

The `pattern` is what refuses a bad value, on both sides — it is the Data
boundary's own regex, so `validateAgainstFields` and the write agree by
construction rather than by a copy. `FJS-522`.

## 2026-08-26 — `matchesQuery` moved to the substrate

`@frontierjs/toolbelt/match` owns it; `field-rules.js` re-exports it, so every
caller here is unchanged and `resource.js` still hands it to junction built over
the model it resolved.

It moved because there were two live stores and one implementation between them:
jetty's upserted whatever its channel delivered, so a row that had LEFT the
loaded filter stayed in the list (`FJS-493`), and jetty may not import this
package. Same shape as `FJS-059`, same answer.

`buildFieldRules` now reads type and nullability through the toolbelt's
`fieldShape`, so there is one owner of *what type is this field* — the matcher
needs exactly that much of a field and nothing more.

`test/live-filter.test.js` keeps the SEAM, which is the half only this side can
answer, plus one line asserting the re-export IS the toolbelt function rather
than a copy made here to fix an import. Its 31 behavioral cases are in
`toolbelt/test/specs/match.spec.js`. sierra 1114 pass.

## 2026-08-26 — `transitionsAt` knows the third refusal, and it is the certain one

`x-transitions` now carries `system` beside `gate`, so a `@system` move —
declared as the APPLICATION's rather than any caller's (`FJS-D150`) — reports
`allowed: false, refusedBy: 'system'` at every level, `undefined` included.

It is the only verdict this module gives that is not permissive-when-unknown. A
gate is an affordance and a policy is invisible from a browser, so both degrade
to *offer the button and let the boundary refuse*; a browser is never the
application, so this one is decidable here with certainty. A screen renders no
button for it rather than a disabled one, which is the difference between saying
nothing and telling somebody to go and ask an administrator who also cannot do
it.


## 2026-08-26 — `resource.more()` — the live list's answer to paging (`FJS-D145`)

`more()` grows the window and `hasMore()` says whether there is anything past
it. A keyset scan resuming from the edge of what the list already holds, so it
cannot skip a row or serve one twice the way an offset does under a list that
is being written to. The versions of what it read are remembered exactly as a
`load()`'s are.

Growing is not a chance to ask a different question: the query and the
directives are the last `load()`'s. A different filter or a different sort is a
`load()`, because a cursor minted under one ordering names no position in
another.

`offset` is untouched — a numbered page is a legitimate UI and
`Pagination.mesa` renders one. Offset is what you ASK for; the window is what a
live resource GETS.

## 2026-08-26 — an edit form was sending the server its own columns back (`FJS-526`)

`@system`, `@generated`, `@computed`, `@from`, `@version` and a tenancy stamp
reach the browser as `readOnly`. Two things read that already: a generated form
does not offer the control, and `make()` does not seed the value. Neither covers
an EDIT form — it is handed a row the SERVER wrote, carrying every column the
caller could read, and writes the whole record back. The Data boundary then
refuses `@system` **by name**, correctly, and the person is shown a 403 about a
column that is not on their screen.

`stripReadOnly(fields, data, { keep })` runs first in `_call`'s create/patch
pipeline, so nothing downstream coerces, blanks or validates a value that is not
going to be sent. **It takes a keep list rather than dropping every read-only
key**, because the `@version` column is `readOnly` and is the one the server
requires back — that is the reason the rule cannot be spelled *delete every
readOnly key*. A key with no rule behind it is left alone.

Three of the thirteen tests go through `createResource().save()` rather than the
pure function: a refactor that dropped the call would leave the other ten green
and put the 403 straight back.

## 2026-08-25 — `resource.record(id)`, and what a live row must NOT move (`FJS-518`, `FJS-D138`)

A row is live now: `record(id)` is a view of ONE over the nodes a list is a
view over, so a detail screen moves when anybody else writes the row. The
resource passes its `model` to `client.resource()` — Junction cannot derive it,
and without it two services over one model are two rows.

**The first read goes through this resource's own `_call('get')`**, so its
hooks run, its coercion applies and the `@version` it returns is remembered;
Junction keeps only the rule about *when* to read, which is *when nothing has
read this row yet*. A list that already loaded the row costs the detail screen
no request at all.

**A push moves the value and does not move the remembered version.** That is
`FJS-341` restated: a live store answering with a revision nobody on the screen
had read won the race `@version` exists to lose, and making the row live is
exactly the change that could bring it back. The node is the synced truth; the
view is what this screen READ; a draft is in neither. `test/resource-record.test.js`
asserts it against Junction's real client rather than a stand-in — a fake would
not have nodes at all.

**`resource.mutate(id, intent, run)`** is the optimistic write, and
`save(data, { optimistic: true })` delegates to it — one mechanism, two doors.
`run` defaults to a patch of the intent through this resource's own pipeline,
so the second argument is for a transition or a custom method, where the call
is not a patch and the intent is what the caller knows the move will do.

**A create is refused by name**: there is no id, so there is no row to show the
change against, and inventing a temporary one is a different feature with its
own question — what every view holding that id does when the real one arrives.

The version rule holds through it: an overlay is a submitted intent, not a
read, so nothing about an optimistic value reaches `_versions`. That is
`FJS-341` in the one place it could plausibly come back.

Green: 1140 tests, typecheck clean.

## 2026-08-25 — `transitionsAt` is the gate half, and now says so

`db.<model>.transitions(row)` grades a row policy as well as the gate
(`FJS-495`). Nothing here can: `x-transitions` carries a gate and not a
predicate, and a browser has no policy engine — so this half answers
`allowed: true` for a move an `@@allow('update', …)` refuses, and the boundary
403s when it is pressed.

That is the affordance contract rather than a gap — unknown is permissive, the
server refuses regardless, and a button that gets refused is the better failure
than one that is missing when it would have worked. What changed is that the
docblock said *mirrors litestone's `transitions(row)` field for field*, which
stopped being true. `refusedBy` is carried so the shapes still match, `'gate'`
or `null` where the server may also say `'policy'`, and a test asserts this half
never claims the other one.

## 2026-08-25 — a page that cannot state what it is no longer just disappears

`FJS-509`. 1116 tests, 0 fail.

`parseFrontmatter` caught a YAML error and returned `{}` under a comment saying
*Sierra will emit a build warning separately*. Nothing did. `build-tree` then
wrapped the same call in `.catch(() => ({}))`, so there were two swallows on one
path.

On a static target `{}` means no `render: static`, so the route is not
prerendered — and it does not reach `skipped` either, because it never claimed
to be static. The page is absent, the count looks plausible, the build exits 0.

An unquoted colon is enough:

    description: Laravel is the framework FrontierJS most resembles: what maps

Two of five pages vanished that way porting the website, and the only symptom
was two missing directories.

`parseFrontmatter` returns the error beside the frontmatter now, and
`readFrontmatter` throws with the file, the YAML message and its line. Thrown
rather than warned, on `FJS-439`'s precedent: frontmatter is how a route says
what it IS, so a block that will not parse has no correct reading — and a
warning about a missing page scrolls past in the one build where it matters.

## 2026-08-25 — a prerendered site's sitemap knows what it prerendered

`FJS-508`. 1113 tests, 0 fail.

`runPostBuild` fed the sitemap and the Speculation Rules `routeTable.indexed`,
which excludes dynamic routes. That is right for an SPA — `/products/:slug/`
stands for a set nothing can enumerate — and wrong for a static build, where
`getStaticPaths()` named the set and the files are on disk.

`example`'s storefront emitted 14 pages and wrote `sitemap.xml (4 URLs)`, with
every product page missing: a catalog invisible to the crawler it was
prerendered for, and the build's own log calling it a success.

`prerenderRoutes` reports the URLs it emitted — it is the only thing that knows
them — and `runPostBuild` takes them as a fifth argument, `null` on an SPA.

**The filter needed a second list, not a cleverer match.** `indexed` has already
dropped the dynamic PATTERN, so asking whether `/products/:slug/` is indexed
answers no for every page it produced, and the first attempt excluded exactly
what it was meant to include. `routeTable.indexable` is the same draft and
`robots: noindex` decision with only the dynamic exclusion left off — so a
noindex page stays out whether it was prerendered or not, which is the half a
looser match would have lost.

`example`: 4 → 16 URLs.

## 2026-08-25 — a static site's theme switcher actually switches

`FJS-501`. 1109 tests, 0 fail. Three faults in one feature, each hiding the next,
all of them silent.

**The config never reached the browser.** `initTheme(config)` is called by
`virtual:sierra`, which a prerendered page never loads — it ships HTML plus one
chunk per island and nothing else. So the theme module kept `normalize({})`:
`DEFAULT_THEMES` and key `theme`. An app declaring six themes had four refused
by name, and the two that worked persisted under a key that the
flash-prevention script *the same config block generated* does not read, so
every reload reverted. The block is carried into the generated island entry
now, which is the one place a static build can tell the browser what the app
declared.

**The script reached one page.** `injectThemeScript` wrote
`join(outDir, 'index.html')` — the whole output of an SPA, and one page out of N
on a target that emits one HTML file per route. It walks the directory.

**The baked class was on the wrong element, and this is the one that made the
feature useless.** `wrapDocument` could only put a class on `<body>` while the
switcher writes `<html>`, so `<html class="theme-elite">` sat over
`<body class="theme-default">` and every token both of them defined resolved to
the baked one for the whole page. Measured: `--color-primary` moved on `<html>`
and stayed `#0d83dd` on every element inside `<body>`, for all six themes, with
no error anywhere — which is why the first two fixes read as *still broken*
rather than as progress.

`wrapDocument` takes `htmlClass`; the static build derives it from
`theme.default` rather than asking an author for it, because an author writing
it by hand writes it onto `<body>`, which is the one place it does not work.
`default: 'system'` derives nothing on purpose — which half a visitor gets is
the injected script's question, and baking either one is a guess a CDN caches.
A `theme-*` class in `document.bodyClass` is warned about by name at build.

`example/site` declares no theme block and its output is byte-identical.

## 2026-08-24 — a hash with a hyphen in it is still a hash

1099 tests, 0 fail. `FJS-484`. Both static servers decided *may this be cached
forever* with `/-[A-Za-z0-9_]{8,}\.[a-z0-9]+$/`. Vite's hash is base64url and
may contain a `-`, so `island-CatalogList-C_TQPJ-f.js` — a file `example`'s site
build emitted — was read as an unhashed name and served `must-revalidate`.

Quiet, and on the files a site is mostly made of. It surfaced only because
`verify:site` reads the FIRST `.js` in the assets directory, and directory order
changes when the files do, so which asset it graded was luck.

Anchored on LENGTH now: a `-` exactly eight allowed characters before the
extension. `my-file-name.js` is still refused, which is the direction that
matters — a name wrongly called hashed is cached for a year and the only way
back is to rename the file — and a build with a longer hash falls out and is
revalidated, which is the safe way to be wrong.

**It was written twice**, and both copies had it. `src/serve/hashed-asset.js` is
the one owner, and it is the only thing the two servers share: a site's HTML
revalidates and a widget's entry is `max-age=300`, because a host page's
`<script src>` is written once and can never be updated.

## 2026-08-24 — an OAuth refusal arrives in words, not as a token

1101 tests, 0 fail (+4).

`session.oauthError` has carried the code since the flow shipped, and a code is
not something a person can read. The route that emits it is coarse on purpose —
it refuses to say whether a state existed or an exchange failed, because that is
an oracle for anyone who can reach the URL — so what reaches the browser is five
tokens, and without a table here every app writes the same switch. This module
exists because `example` and `basecamp` each wrote their own `session.js`, and
five untranslated codes is where the next divergence starts.

`session.oauthMessage` is the sentence; `OAUTH_ERRORS` is the table and
`oauthErrorMessage(code)` the lookup. A code this build has never heard of gets
a generic sentence rather than null: the API deploys separately from the app, so
a code added on one side reaches a browser running the other, and *nothing at
all on screen* is the failure this whole channel exists to fix.

**Both fields, because `link_required` is not a failure.** The flow worked — an
account already holds that address and a confirmation link has gone out — and an
app rendering all five codes in one red alert tells that person their sign-in
broke when the next step is in their inbox. The code stays beside the sentence
so a screen can branch on it.


## 2026-08-23 — the scanner plugin, run rather than restated

1088 tests, 0 fail. Three defects in `checkStaticPaths` and its caller
(`FJS-473`), one of which stopped `bun run dev:site` from starting at all.

`buildStart` asked `this.environment?.mode !== 'serve'` whether it was a build.
Vite 8 reports `dev` there for a dev server, so the test was true in both and
every dev boot ran a check written for production only. It reads `command` off
`configResolved` now — `serve` or `build`, which is the question.

The check itself then threw `ReferenceError: warn is not defined`, because
`warn` is a parameter of `runScan` and not of `checkStaticPaths`. And the
refusal it exists to raise sat inside the `try` guarding the companion import:
`error` is rollup's `this.error`, which throws, so the refusal was caught by its
own guard and reported as *could not import companion* on a green build — the
shape `FJS-439` had already found once. Only the import is guarded now, and the
warning carries the cause, since a companion that will not import is almost
always its own imports throwing rather than the file being absent.

All three survived because `test/static-paths.test.js` restates what the plugin
does — scan, import, build the message by hand — so every assertion passed
against a function nothing called. `test/scanner-plugin.test.js` calls
`buildStart` through a context that behaves like rollup's and asserts the three
outcomes.

## 2026-08-23 — the tab says which page you are on

1085 tests, 0 fail. An SPA route's `title:` reaches `document.title`
(`FJS-389`). `document.title` appeared nowhere in `src/` outside the
prerenderer, so every route showed whatever `index.html` hardcoded — one string
for all of `example`, one for all of basecamp — and a bookmark, a history entry
and what a screen reader announces on arrival all named the app instead of the
page. The worst shape is an app that prerenders AND hydrates, where the title is
right on first paint and stale from the first client navigation.

The router reads the SAME two sources the static target reads, in the same
order: `head({ params, data, url })` off the route's companion, then
frontmatter. Two decisions came with it and both are stated rather than
defaulted. **No template and no site name is appended** — the static half
composes neither, and two halves of one feature disagreeing about where a title
comes from would be worse than the original bug; an app wanting `Page · Acme`
says so in `head()`, the one place that can see both. **`title` stays an
ordinary frontmatter key** rather than joining `PAGE_RESERVED`: every example in
the docs renders `{page.title}` in a heading, and claiming the name would empty
them.

A route declaring none puts the DOCUMENT's own title back, not the previous
page's. A `head()` that throws falls back to frontmatter and warns in dev, where
the static build refuses to emit the page — here the page is already on screen,
so refusing is not available and silence is not honest.

## 2026-08-23 — the router reads the same query syntax Junction does

1073 tests, 0 fail. Typecheck clean.

`parseQueryParams` had its own `coerce()`, and it inferred with `Number(value)` —
so `?sku=007` became the number 7, which is the guess this package's own widget
props already refuse for `data-pid="007"`. Junction's transport meanwhile did not
infer at all, so a filter typed into the URL bar and the same filter sent by the
client meant different things and both answered a 200 (`FJS-450`, ruled as
`FJS-D125`).

Both boundaries read `@frontierjs/toolbelt/query` now. `buildUrl` writes with the
same encoder, so a URL Sierra builds parses back as what was put in — `{ code:
'5' }` is `?code="5"` and comes home a string, where `String(value)` made it the
number 5. Brackets are left readable rather than percent-encoded, which is what
every bracket-notation parser emits.

Dropping an empty filter stays `buildUrl`'s own decision: a filter box nobody
typed in should not add a parameter, which is not the same question as whether
`null` can be sent.


## 2026-08-23 — a prerendered site has an origin to be served from

1073 tests, 17 of them new, 0 fail.

`FJS-D127` made `site/` a surface. `sierra site --serve` and
`@frontierjs/sierra/site/serve` are its origin — the module the generated
`site/deploy/` runs and the one a drive points a browser at, so what is tested
locally is what ships.

Three answers a static host gives for free are the three a hand-rolled
`createServer` in a harness forgets, and then the harness proves the site works
under rules nothing in production applies:

- **A directory index.** `trailingSlash: 'always'` emits `about/index.html` and
  every link says `/about/`. Without it, every URL but the root is a 404 and the
  build looks broken when it is not. A URL missing its slash resolves too.
- **A cache answer per file kind.** HTML is revalidated — its URL is permanent
  and its bytes are a build artefact — and only hashed assets are immutable.
  Backwards, and a visitor is served last week's page for a year.
- **The site's own `404.html`, with a 404 status.** A soft 404 is a page a
  crawler indexes.

It sends **no CORS**, which is deliberate and the opposite of `widget/serve.js`:
this origin serves documents a browser navigates to, and the API is what a page's
islands call.

## 2026-08-23 — a widget's imported CSS reached its shadow root

1056 tests, 0 fail. 25 browser assertions, 0 fail.

`FJS-448`. `widgetCssPlugin` deletes Vite's `style.css` asset and swaps its text
into the entry at a placeholder, so a widget ships as one file. `generateBundle`
runs after minification and the matcher knew `"` and `'`; **esbuild writes
backticks when it minifies**, which is the default and what every app ships. The
asset was deleted, the swap missed, and the widget carried the literal
`@sierra-widget-css` into its shadow root as a stylesheet.

Only IMPORTED css was affected — a widget's own scoped `<style>` blocks go
through Mesa's runtime, which is shadow-aware — so the widget looked styled and
nothing said otherwise. It survived because the fixture builds with
`minify: false`, for a good reason, which left the one working case as the only
one under test.

Three quote characters now, and the swap is **asserted**: the entry always
carries the placeholder, so not finding one throws rather than shipping a widget
whose stylesheet is a placeholder — the asset is already gone by then.

## 2026-08-23 — the URL fragment survives

1056 tests, 0 fail.

Two defects in one parse, and the second was hiding behind the first.

`FJS-447`: the boot navigation passed `pathname + search` and rewrote the
address bar with `replace: true`, so **the fragment was erased on every direct
load and every refresh**. `/docs/#install` became `/docs/`, did not scroll, and
left the reader holding a URL that no longer says where they were. Clicking the
same link inside the app carried it, so it failed only for the person who pasted
one — and `scrollRestoration = 'manual'` is what makes it total, since the
router has taken the browser's own handling of a fragment away.

`FJS-446`: `_navigate` split the whole URL on `?` to find the search, so a
fragment landed INSIDE it — `/leads/?status=open#top` was rewritten
`?status=open#top#top`, and `page.query.status` came out as `open#top`, a filter
with an anchor glued to it. Unreachable while the boot path dropped the hash.

Found in `example`, by a widget handing a basket to the shop through
`#h=<code>`: the code was gone before the screen could read it and the symptom
was an empty basket with no error anywhere.

## 2026-08-23 — every narrowing a value set applies now travels

`FJS-430`. `options()` sent `$scope` for a declared scope and nothing for a
declared `where`, and warned once per field that the picker was over-offering.
A `where` mints a scope of its own in litestone now, so both arrive as names in
`x-values.scopes` and go out as one `$scope` array. The warning is gone with the
case it described.

## 2026-08-23 — a prerender that threw fails the build

1046 tests, 0 fail.

`prerender` puts every reason a route produced no page on one `skipped` list:
*route file not found*, *no paths to emit*, `load() threw`, `render failed`.
Two of those are a page opting out and two are a broken build, and the caller
printed them all as warnings and carried on — so a deploy shipped with a page
missing and nothing red anywhere.

Worse when it was the only static route: `written.length === 0` then fired the
*no route declares `render: static`* message, blaming the frontmatter of a page
that plainly declares it. The failing kinds throw now, naming every route and
its reason (`FJS-439`).

## 2026-08-23 — `toFieldErrors` is reachable

1041 tests, 0 fail.

`resource.js` re-exports it with the comment "so `sierra/junction` stays the
one import for resource work", and `index.js`'s own export list dropped it
along with `isStaleWrite`, `toConflict`, `STALE_WRITE_MESSAGE`, `buildVersion`
and `matchesQuery`. `resource.fieldErrors(err)` reaches the same function,
which is what hid it: the gap only shows for a screen with no resource to reach
through — a form over a CUSTOM METHOD, which is most checkouts, and which
`validateInput`'s `input:` exists to make possible. An app holding a 400 from
one had to re-implement the unwrapping, three shapes deep because each hop
wraps once (`FJS-429`).

## 2026-08-23 — a litestone refusal reaches the control it names

`FJS-436`. Two boundaries write a per-field refusal and they spell the field
differently: junction's validator says `field`, litestone's `ValidationError`
says `path: ['color']`. `toFieldErrors` read the first only, so every entry
from the second fell to the form-level message — a banner, away from the box it
is about, with `<Form>` unable to mark it invalid.

That is the wrong half to lose. Litestone carries every rule a browser cannot
pre-check, because the check needs a query or a stored row: a value set, a
`@@transitions` move, a soft-deleted `@unique`. The rules sierra CAN check
itself are the ones that never reach this function.

`_fieldOf` reads `field` first, then `path` — joined when nested, since no form
field is named `address.city` and saying so beats reporting none. An empty path
stays a whole-payload failure. 5 cases in `test/field-errors-writer.test.js`,
built against the real class rather than a literal.

Found in a real browser: `example` refusing a value-set save through
`resource.save()`, with the message arriving and the field gone.



## 2026-08-22 — a `@values` column renders from its set

1039 tests, 0 fail. 12 in `test/value-sets.test.js`.

The client half of `FJS-412`. `x-values` arrives on the rule as `rule.values`,
and two branches read it.

**`controlFor` asks the set before the foreign key.** A bound FK is both, and
the set is the narrower answer — it carries the scope the list is narrowed by
and the column a person reads, where the relation carries neither. Answered as a
plain relation it would fetch the whole related table and offer rows the set
excludes.

The strength picks the control and the two weak ones pick the same one:
`required` is a picker, `open` and `suggested` are a combobox with `allowNew`,
because what separates those two is what the SERVER does with a new value and
not what a caller may type. A bound array is a multiselect where an unbound one
is still `json` — the schema stops describing an unbound array, and a bound one
has a list behind it.

**`resource.options()` sends the declared `@@scope` as a filter.** `$checkWhere`
validates a `$scope`, so it survives junction's autoFilter and litestone applies
it — which is what makes the offered list the same list the Data boundary will
accept. A declared `where` cannot cross: it is SQL, and a browser may never send
SQL. That set over-offers and says so once per field (`FJS-430`) rather than
being discovered on save.

## 2026-08-22 — the toolbar follows junction's console to 8503

1039 tests, 0 fail.

The devtools toolbar connects to junction's `devtools()` plugin, which moved off
4000 and into the framework's reserved tooling block (`FJS-431`). Both defaults
here follow it — the build plugin's injected config and `initToolbar`'s own
fallback.

The number is restated rather than imported: sierra cannot import junction, and
neither depends on the CLI that assigns it. A toolbar pointed at the wrong port
is ten failed WebSocket retries the browser writes itself and no page can
suppress (`FJS-353`), so both sides name where the number comes from.


## 2026-08-22 — a picker's display column is declared, and a guess says so

1026 tests, 0 fail. 21 new across `test/label-field.test.js` and
`test/resource-no-client.test.js`.

`labelFieldFor` guessed from eight conventional column names, then the first
plain string, then the id — and every step down that ladder was a worse answer
given in silence. A `Person` with `firstName`/`lastName` labels every option
*Ada, Ada, Ada* and looks like it worked (`FJS-392`).

Two halves, separable. **The schema can say it** — `@@label(field)` arrives as
`x-label-field` and is resolved once per resource onto `resource.labelField`, so
a hand-written picker and a generated one ask the same owner. **And a guess says
that it guessed** — `labelFieldInfo` answers `{field, source}` where
`labelFieldFor` answered a bare name, and the two guessing tiers warn once per
field, naming the model and the fix. The two upper tiers stay silent: a message
that fires on every correct `name` column teaches everyone to skip it.

**A declaration is not checked against the field rules, and must not be.** The
case it exists for is a `@generated` full name, which is `readOnly` — the scan
skips those by design — and absent from a create-mode registry altogether, while
a picker reads `row[shown]` off a fetched row.

Found while wiring it: `_emptyResource.options()` still answered a bare array
after the envelope change, so the no-client fallback threw inside the render it
exists to prevent.

## 2026-08-22 — the control table answers `json` where the schema stops describing

1005 tests, 0 fail.

`controlFor` answered `{ control: null, reason: 'object — a Json column has no
single control' }`, so `<Form>` warned about the column by name and left it off —
the column existed, the API accepted it, and there was no way to edit it in an
app that had not written a control of its own. It now answers
`{ control: 'json' }`, which `@frontierjs/ui` binds to its new `JsonInput`.

**A `Json` column is not `type: 'object'`, which is how the first cut of this
shipped not working for the one column it was written for.** Litestone emits a
`Json` field as `{}` — the empty schema, no `type` at all, because a JSON
document may be any of the seven things JSON can hold — so a table waiting for
`type: 'object'` never sees it. Every fixture in `form-fields.test.js` is typed
out by hand and every one of them said `type: 'object'`, which is why the tests
were green against a table that did nothing. There is now a case that derives
its rules from litestone's own parser and emitter, and it is the one that
matters.

Two shapes are carved out of *no type*, because both look identical from the
table and neither is a document:

- **A `File` column.** It `$ref`s FileRef, which derefs to an ordinary object
  with eight properties, so the json control briefly offered a textarea over a
  storage key and a bucket. `x-litestone-file` is carried through
  `buildFieldRules` and answers `control: null` with a reason (`FJS-409`).
- **A `$ref` nothing resolved.** It leaves no type behind either, so an
  unpopulated `$defs` registry would turn every enum and every relation on a
  form into a JSON textarea, silently. `buildFieldRules` is the only place still
  holding the raw schema, so it records `unresolvedRef` and the table refuses
  rather than guesses.

A `Json` column and a `String[]` have no field list under them, so there is
nothing to generate a row of controls from and the only editor that covers every
value they may hold is the document's own syntax. An app that wants something
better — chips for a `String[]`, a structured tree — registers it, and the
registry is asked before this table, so that is one line rather than a fork
(`FJS-D17`).

`control: null` still means what it meant, for the cases that are really it: a
`readOnly` column, and a type this table has never heard of. Both still carry a
reason.

## 2026-08-22 — the Resource owns the write, and the reads it is asked for (`FJS-D114`)

994 tests, 0 fail.

`save(data, { mode })` is new and it is the one owner of create-or-patch. `auto`
— the default — creates when the model's OWN id field is absent and patches when
it is present; `create` and `patch` force one; `upsert` is an ALIAS of `auto`
rather than a fourth thing, because the two ask the same question and a separate
word for it says the server has an upsert method it does not have.

Nothing about the pipeline changed, because `save` goes through `_call`: a
payload is still coerced, blank-stripped and validated, the `@version` this
screen read is still stamped on the patch, and the resource's own hooks still
run. What changed is who decides, and that was measured as a defect before it was
a ruling — `<Form method="auto">` fell through to the client's `upsert`, which is
hardcoded to `id`, so editing a row on a model keyed by anything else created a
duplicate (`FJS-316`). The id field is the schema's, and only the resource knows
it.

`detailQuery` is the read half: `{ query, directives }`, what `get(id)` asks for
when the caller states none. Sibling of `optionsQuery`, which already existed and
which **nothing in this repo passed** — no generator, no app. Both are declared
beside the model instead of at every call site, which is the whole of the
argument: in the app this was read from, the convention was followed 6 times in
36 resource files while 80 route files hand-wrote their own include shape.

Named `detailQuery` rather than the plain `query` the convention came from,
because `query` means FILTERS at every other boundary here (Invariant 10).

## 2026-08-19 — click an element in a running app, open the line that wrote it

Mesa's inspector, served through Sierra's plugin. Hold Alt over any element in
the dev server and it is outlined with `src/routes/index.mesa:100:1`; click and
the editor opens there. The compiler stamps the location, `mesa-vite/inspect-client.js`
is the browser half, and this package serves that same source at
`/@frontierjs/sierra/inspect-client` and injects the script into the HTML shell —
the arrangement the HMR client already had (`FJS-D16`), for the same reason: one
implementation, an id per plugin.

`mesaPlugin({ inspect: false })` turns off the injection and the attribute
together. A build stamps nothing and injects nothing.

## 2026-08-19 — an installed sierra was a blank screen, and the toolbar shouted at a port nobody held (`FJS-356`, `FJS-353`)

980 tests, 0 fail.

`optimizeDeps.exclude` said `'sierra'`. The package is `@frontierjs/sierra`, so
the exclusion matched nothing and Vite pre-bundled the package the comment above
it explains cannot be pre-bundled: esbuild's scan meets a `.mesa`, dies, and the
entries are dropped from `_metadata.json`. Vite still rewrites `virtual:sierra`'s
imports to the `.vite/deps/` paths — which now 200 with the SPA fallback's HTML
and an empty content type. The browser refuses that as a module, so the router
never initializes and the page is blank behind one MIME-type line.

**Every app that installed sierra from npm.** Nothing in this repo could see it:
an app here resolves sierra to `packages/`, and Vite does not pre-bundle a linked
dependency at all — the same blind spot `FJS-251` and `FJS-252` were written
about, and the reason the `scaffold` and `deploy` CI phases exist. It was found
by scaffolding through `create-frontier` and opening the result in a browser,
which is the one thing neither phase does.

The devtools toolbar is opt-in now. Its only source of data is junction's
`devtools()` plugin, which is itself opt-in, so injecting by default gave every
app that had not configured one a toolbar retrying `ws://localhost:4000` ten
times — each failure a red console line the browser writes itself and no page can
suppress, on the front page of an app that was working. Declaring the `devtools`
block in `sierra.config.js` is the opt-in; `enabled: false` still silences an app
that has one.


## 2026-08-18 — the version a patch carries is the one this screen read (`FJS-341`)

980 tests, 7 of them new, 0 fail. `test:safety` 5/5. Typecheck clean.

`createResource` recorded a `@version` off the STORE. That was the right answer
to the wrong question: a WS push reaches the store as an upsert and never passes
through a call result, so without it the row a second tab patched left a
pre-patch number behind and the next patch 409'd on something nobody read.

The other half of it is the defect. A push moves the number and moves nothing
the person is looking at, so a save from a screen holding a DRAFT carried a
revision nobody there had read and **won the race the column exists to lose** —
measured in basecamp, the other person's write erased with the guard declared,
the server enforcing it, and no error anywhere.

The version is now recorded from READS this resource performed: every call
result, and a `load()` that was not superseded. `load()` carries its own stamp
for that, because a store notification has no provenance — a `set()` from a
winning load and an `upsert()` from a push arrive as the same event, and
junction's stamp (`FJS-082`) governs the store rather than this.

The cost is a 409 where a silent success used to be, and that 409 is the correct
answer: the screen is submitting values from an older revision. A caller who has
genuinely read the newer one states it, which `<Form record={row}>` already does
by editing the row whole.

**`resource.conflict(err)` / `toConflict(err)`** answer the two revisions —
`{ model, field, expected, actual }` — where `fieldErrors()` answers the
sentence. A screen offering *reload* against *overwrite* needs the numbers, and
neither the status nor `retryable` can carry them.

Four mutants killed across the three packages: restore the subscription (3 red),
drop the load stamp (1), drop junction's adoption (3), drop litestone's payload
(2).

## 2026-08-17 — a `@transient` field reaches the browser (`FJS-D23`)

973 tests + 3 new, 0 fail.

`writeOnly` is carried through `buildFieldRules`, so a field the caller sends and
no read answers is a rule a view can recognize. Nothing else was needed and that
is the point: sierra registers the CREATE-mode schema, which is where litestone
emits a transient field, so `<Form>` renders a control for it and
`createResource` coerces and validates it like any other column — where a
wire-only field known to a server hook alone was stripped in the browser before
the request was ever made.

## 2026-08-17 — the resource's pure halves move to the substrate (`FJS-059`)

`createMakeFromSchema`, `derefFieldSchema` and the four-phase hook pipeline are
`@frontierjs/toolbelt`'s now — `/jsonschema` and `/hooks`. They were copied into
jetty by hand and had drifted two versions there; one implementation is what
stops that recurring, and no new package was needed for it (`FJS-D16`).

Nothing about this package's surface changes. `createMakeFromSchema` keeps its
positional signature and its `resolve = resolveRef` default, because the kit
takes an options object and no default resolver — jetty may have no definition
table at all. `derefFieldSchema` is re-exported from `field-rules.js`, where
every caller here already looks for it.

**One internal change**: `mergeHooks` answers a new map rather than merging in
place, so `_hooks` is reassigned. Toolbelt's license is purity, and this was the
only one of the three that mutated an argument.

`createStore` stays here: it is service-backed and stamps each request, jetty's
takes no service at all, and a store is state rather than a pure function.

970 tests, `test:safety` 5, typecheck clean, and `example` `verify` 37 +
`verify:build` 37.

## 2026-08-16 — the theme switch drives the design system (`FJS-308`)

`setTheme('dark')` set `data-theme` on `<html>`. **`@frontierjs/css` reads that
nowhere** — a theme there is one of eleven `theme-*` classes, each a block of
inheriting custom properties — so the call changed an attribute and not one
pixel. `@frontierjs/ui` shipped a second switcher that added a `.dark` class,
which the package also does not define. Neither had a caller, and `example`
had written its own applier, which is the symptom that says a mechanism was
never real.

    theme: {
      themes:  ['theme-default', 'theme-dark', 'theme-forest'],
      default: 'system',
      system:  { light: 'theme-default', dark: 'theme-dark' },
      key:     'theme',
      apply:   'class',        // 'attribute' keeps the old spelling
    }

The app declares which themes it offers; `setTheme` refuses a name that is not
among them **and prints the list**, because returning quietly reads as a broken
stylesheet rather than as a typo. `toggleTheme` cycles — *the other one* is not
a question eleven themes can answer, and with two it is the toggle it always
was. A persisted theme the app has since dropped is ignored rather than applied
as a class with no stylesheet behind it, in the module and in the inline script
alike.

**The element is `<html>` and that is deliberately not a knob.** A `<head>`
script is the only thing that beats first paint, and `<body>` has not been
parsed when it runs — so a `target: 'body'` would be a setting whose only
effect is to bring the flash back. Nothing is lost: a theme is inheriting
tokens. Theming a subtree (`<nav class="sidebar theme-dark">`) is a class in
the markup and not this switcher's job.

`@frontierjs/ui/stores/themeStore.js` is **deleted**, not fixed — beating first
paint needs a build step, so the kit could only ever have been a second answer.

## 2026-08-16 — a `DateTime` column names a control (`FJS-079`)

The control table answered `{ control: 'input' }` for `format: date-time`, with
a comment beside it explaining that it could not do better: Litestone stores an
instant, `<input type="datetime-local">` reads and writes a wall clock with no
zone, and wiring the two together truncates the offset going in and hands back
a zoneless string that is parsed as UTC. Two shifts, opposite directions,
different sizes — so the column fell through to a text box and nothing said so.

    format: 'date'      → { control: 'input', type: 'date' }   // no zone to lose
    format: 'date-time' → { control: 'datetime' }              // converted at both edges

The conversion cannot live in a type attribute, so the row names a control and
`@frontierjs/ui` binds it (`FJS-D17`'s two registrations, the same path a
contributed control takes). Nothing else in this package changed.

## 2026-08-16 — the route table is called a route table (`FJS-284`)

`FJS-D06` cedes *Manifest* to MV3, where it names a real file jetty emits for
the `extension/` surface. What sierra generates is the route table — the name
`routes.snapshot.md` and this package's own docs already used — so the code now
says it too:

| was | is |
| --- | --- |
| `generateManifest` / `renderManifest` | `generateRouteTable` / `renderRouteTable` |
| `scanner/generate-manifest.js` | `scanner/generate-route-table.js` |
| `config.manifest.output` | `config.routeTable.output` |
| `runPostBuild(config, manifest, …)` | `runPostBuild(config, routeTable, …)` |
| `plugin.closeBundle({ …, manifest })` | `plugin.closeBundle({ …, routeTable })` |

The last two are the app-facing half: a post-build plugin reads the table off
its `closeBundle` argument. **No alias for the old config key** — nothing in the
tree sets it, and a key that configures nothing is quieter than one that half
works.

`manifest.environments` went with it: it was declared in the `SierraConfig`
typedef and read nowhere.

Two neighbors keep the word and are not a lapse. Junction's `/manifest` is a
manifest of services, and an HTTP path is not vocabulary. A `package.json` read
by `schema-plugin.js`, `virtual-sierra.js` and `vitest.config.js` is npm's
manifest, not this repo's.

962 tests, unchanged, plus `example`: `verify`, `verify:build` and
`verify:public` — the last because the pipeline consuming the table is what
writes the sitemap, `_redirects` and `llms.txt`.

## 2026-08-16 — the live-store matcher reads the wire's own directive table (`FJS-306`)

`matchesQuery` carried two hand-written lists of `$` keys: the directives to skip
(not filters) and the ones whose answer is not in the record. The first restated
`DIRECTIVE_PARAMS` and had drifted from it — a directive it did not name was
graded as a filter on a column nobody declared, which removes every pushed row
from the store. It now derives from `@frontierjs/toolbelt/directives`, leaving
only the question this module is the one that can answer: `$onlyDeleted` and
`$onlyTemplates` are undecidable from a record (the marker column can be renamed
and this side holds no schema), so they stay opaque and reload rather than guess.

## 2026-08-16 — one word each: `params`, `locals`, `directives`

962 tests, unchanged — the rename is covered by the suite that already existed
(`test/resource-directives.test.js`, was `resource-params.test.js`).

This package had **three** different things behind the word `params`:

| was | is | means |
| --- | --- | --- |
| `page.params` | unchanged | path captures. `/leads/[leadId].mesa` at `/leads/24` → `{ leadId: '24' }`, always a string |
| hook `ctx.params` | **`ctx.locals`** | per-call scratch |
| `ctx.findParams`, and the 2nd argument to `find`/`load`/`getOptions` | **`ctx.directives`** | how to shape the answer |

The third was the one that read worst: the router in this same package hands a
view `page.directives`, and the resource next to it made that view pass them as
`params`. `ctx.directives` is what the API boundary calls it and what
`@frontierjs/toolbelt/directives` calls it (Invariant 10).

The scratch bucket had **no caller anywhere in the repo** — its only writer was
the test asserting it stays client-side — while its documented purpose (a
loading flag) is served by an `around` hook and a signal, which the same file
already showed 600 lines above. What it is actually for is the hand-off `before`
and `after` cannot do any other way, since a closed-over variable is shared by
two calls in flight. That is Junction's `ctx.locals`, word for word, so it is
now spelled that way.

`optionsQuery` takes `{ query, directives }`. No app in the repo passed the old
key, so nothing outside this package moved.

**Junction's browser client moved with it** — filed as `FJS-290` and then done,
because it was not a rename: `FindParams` also CONTAINED `query`, so the
container was both halves of a split the rest of the framework keeps apart. Its
second argument is now a `QueryDirectives`, the same declaration the bridge
reads. So `page.directives` → `resource.load(query, directives)` →
`client.find(query, directives)` → `ctx.directives` is one object under one name
the whole way down.

## 2026-08-16 — a control has a registry, and a plugin can enter it (FJS-D17)

`controlFor` was a `switch` inside a published package: the table it holds is
the framework's answer to *which control does this column get*, and there was no
way to add to it short of forking Sierra. So a `Json` document, a `String[]`,
money and a rich editor had no home, and the CLAUDE.md line calling the UI
plugin system limited was pointing at exactly this.

`registerControl(name, resolve)` is consulted before the built-in table.
`resolve(rule, { field, model })` answers a control NAME, a whole descriptor, or
null to decline — and the last registration is the first asked, so an app beats
the kit it imported without either of them coordinating. Registering a name
twice replaces the first rather than stacking a second, because a dev server
re-evaluating a module must not leave three copies behind. It hands back its own
undo.

**A resolver may not answer a component**, and that is the ruling rather than an
omission: this module is a leaf that has to run in plain Node — `formFields()`
is asked by a test, a prerender and a snapshot — so the name is the half that
crosses, and `@frontierjs/ui/controls` binds it to something renderable. A
`readOnly` column is not offered to the registry at all: the Data boundary
refuses that write by name, so a control over one is a form that cannot submit.

`defaultControlFor(rule)` is the built-in table with the registry skipped, for a
resolver that extends rather than restates it. `registeredControls()` lists what
is installed in consult order. A resolver that throws is skipped by name and the
rest of the form still renders; an answer that is not a control name is refused
out loud.

`formFieldList(fields, { model })` and `resource.formFields()` thread the model
name down, which is what lets a registration claim `Order.body` rather than
every markdown column in the app.

sierra 962 · `example` verify 37/37, verify:build 37/37, verify:ui 27/27.

## 2026-08-16 — `session`, and `login(token)` / `logout()` are gone (FJS-D20)

Both were token plumbing wearing the names of the operations: `login()` never
signed anybody in — the app was expected to fetch `/auth/login` itself and hand
the token over — and `logout()` never told the server, so the session row stayed
valid until it expired.

`@frontierjs/sierra/junction` now exports `session`, `ready`, `signIn`,
`signUp`, `signOut` and `refresh`. `session` is a plain reactive object on the
same contract as `status` (`$: session.user`), `initJunction` restores it from
the stored token at boot, and `ready` resolves signed in or not — which is what
the navigation guard awaits instead of judging on token PRESENCE, the guess that
let an expired token render a protected page and 401 afterwards.

The wire half is `client.auth` in Junction, so the token, the storage and the
socket have one owner. What stays here is what a wire client cannot know: the
reactive object, the boot restore, and dropping a prefetched payload when the
identity changes — which now hangs off the client's `token` event and therefore
covers every way it can change, including a 401 clearing it.

`session.level` is the server's grading and is `null` unless the app configured
`services: { level }` on the auth plugin. Once it has answered with one, a
signed-out caller is 0 — STRANGER — and before that it stays null rather than
handing an app a number it never agreed to.

Both dogfood apps' `session.js` collapsed onto this: `example`'s is one
re-export line, and `basecamp`'s keeps only what no framework can answer, which
is which workspace everything is scoped to.

## 2026-08-15 — `resource.service.action()` is `resource.service.invoke()` (FJS-D02)

Junction ruled that a custom service method is a method and not an *action*, so
the resource's spelling follows: `orders.service.invoke('pay', 3)`. Same
signature, same transport rule, same hook pipeline — `id` may still be null for
a call about the whole collection, and `call()` is still the explicit WS form.
`DECISIONS.md` § Naming & vocabulary.

## 2026-08-15 — widgets are a SURFACE, and they are served like one

Widgets were built out of `web/src/Embeds/` — a folder inside the SPA's own Vite
root, sharing its config, its port and its release. That is the wrong shape and
it was wrong in every direction at once: the config is a different target, the
tests are host pages rather than routes, and the release is static files on an
origin a stranger's page links to, shipped when the pages embedding it are
ready rather than when the app is.

**`widgets/` is a sub-project at the app root, a peer of `api/` and `web/`**,
carrying the same six folders. Every path in `widgets/config/sierra.config.js`
is relative to it, and `sierra widgets` is run from there. An app may have this
surface and no `web/` at all — `fli new --template widgets-only` is a whole
project whose product is the embeddable scripts.

```
widgets/config/sierra.config.js   target: 'widget'
widgets/src/Embeds/               one component per embeddable script
widgets/test/                     a host page per widget
widgets/deploy/                   serve.js + Dockerfile — the widget origin
widgets/dist/embeds/              the built scripts
```

**`src/widget/serve.js` is the deployment, and the drive now runs it.** A widget
origin needs two things nothing else here needs: CORS, because the host page is
on another origin by definition, and a cache answer per file kind, because the
entry's URL was pasted into somebody's CMS a year ago and cannot change while
the file behind it must. Those were untested, because the fixture served the
bundles from the same origin as the host page — the one arrangement no customer
of a widget ever has. It now serves them through the module that ships, on its
own port, and asserts what a browser gets: `Access-Control-Allow-Origin`, an
entry that is revalidated rather than immutable, and `..` refused. 25 assertions.

The surface is generated by one function, `packages/cli/core/widget-surface.js`,
called by `fli new --widgets` and by `fli make:widget` — two generators writing
one directory is how an app scaffolded one way stops being extendable by the
command that adds the second widget.

## 2026-08-15 — `target: 'widget'` builds something (FJS-057)

It was a config shape: `createSierraViteConfig` accepted the target, returned a
vite config, and the branch's own comment said *"widget builds are handled by a
separate build loop"* — which did not exist. There was no discovery, no entry,
no mount, and a `shadowDOM` CSS plugin keyed on `@unocss-placeholder` that
nothing ever ran.

**A widget is one component, built as one script, mounted on a page this app
does not own.** That last clause decides everything else: it cannot assume a
bundler (so the build emits IIFE), it cannot leak or be leaked into (so it
mounts in a shadow root), and it cannot choose when it runs (so loading before
its host element, after it, or twice are all the same call).

```
src/Embeds/Counter.mesa        → dist/embeds/Counter.js
src/Embeds/LeadForm/index.mesa → dist/embeds/LeadForm.js
                Field.mesa       …a part of LeadForm, not a second widget
```

`sierra widgets` runs the loop — N widgets is N library builds, because a
self-contained IIFE is exactly what a bundler's shared chunks are not. The
config's `widget` branch is what a widget is COMPILED with and what `vite dev`
serves. A widget declares its tag, selector and shadow behavior in
`<script module>`; the generated entry supplies the rest, so a widget author
writes a `.mesa` file and no boilerplate.

**Two ways to be found, one mechanism.** The custom element is the default and
the one to document. A CSS `selector` covers host markup its author cannot edit
— a CMS template, a customer's page, somebody else's tool — and a
MutationObserver covers an element that arrives after the script ran.

Three things were wrong on the way and are now asserted rather than remembered:

- **The entry passed the CSS placeholder through a comparison**, which the
  bundler folded to an empty string before `generateBundle` could swap the
  stylesheet in. Every widget shipped unstyled and every part of it read
  correctly.
- **The runtime held the whole placeholder**, and the runtime is bundled into
  the widget — so the replacement hit it too, the widget compared its
  stylesheet against itself, and dropped it. It holds a prefix now.
- **Discovery was nearly a glob**, which would have shipped a form's four
  components as four half-widgets on no host page.

`test/fixtures/widget-site/verify.mjs` is what found the first two: 21
assertions in real Chrome over a plain host page with hostile CSS — element
upgrade, props from `data-*`, a delegated click inside the shadow root,
isolation in both directions, the selector form, a late-inserted host, one
widget from a script included twice, and no `.css` emitted beside the script.
Negative-controlled: removing the observer fails exactly the four assertions
about it and nothing else. `bun run test:widgets`.

## 2026-08-15 — the URL's search string is on `page`, and it is two things (FJS-083)

Reading it back meant calling `parseQueryParams(window.location.search)` by
hand, so a filtered or paginated list could not be URL-driven without wiring it
per page. What the router DID put on `page.params` was the search params merged
into the path captures — one value with two homes, neither saying which kind it
was, and `?id=99` on `/orders/7/` quietly answered 99 to `page.params.id`.

Two fields now, and the split is the API realm's own over the same table
(`@frontierjs/toolbelt/directives`, which junction's bridge strips by):

    page.query        the filters      — { status: 'active' }
    page.directives   the `$` params   — { limit: 20, orderBy: '-createdAt' }

so a whole URL-driven list is `resource.load(page.query, page.directives)` with
nothing to translate, and it survives a reload, a back button and a pasted link
because the URL is where it lives. Neither half contains a `$`: it is transport
syntax at this boundary exactly as it is at the API's (Invariant 10).

**Breaking, deliberately: `page.params` is PATH captures alone.** Nothing in
this repo read a search param off it — every use is `page.params.id` — and the
README only ever documented the path case.

Both names are in `PAGE_RESERVED`, so a route declaring `query:` in its
frontmatter is warned about by the scanner rather than silently overwritten on
every navigation. They are assigned only when the search actually changed: a
layout outlives a navigation, and a filter bar watching `page.query` would
re-ask the server on every navigation under it if a fresh object arrived each
time. 11 tests in `test/page-query.test.js`; three in `navigation.test.js`
changed, which are the ones that documented the conflation.

## 2026-08-15 — a prefetch asks as the user, and its answer does not outlive them (FJS-041)

`runPrefetch` handed `load()` `window.fetch`; the router hands a navigated
`load()` `sierraFetch`. Two fetch paths for one job, so they disagreed about the
only thing that mattered — the session token — and the answer to the wrong one
was cached. The result was not a leak: the request was refused. It was that the
refusal was then SERVED, so hovering a link could make the page you navigated to
render as signed-out.

It is `sierraFetch` in both now. The deferral in the file's header said the token
was not reachable at module init without a cycle back to `initJunction`; the
token is read per CALL out of localStorage and `fetch/index.js` imports nothing,
so there was no cycle to avoid and never had been.

**Attaching the token is half of it.** A payload is an answer to *what may this
person see*, and a cache keyed only by URL says nothing about who asked.
`invalidatePrefetch()` drops every cached payload — and the per-URL gate with it,
or the URL could never be prefetched again this session — and `sierra/junction`
calls it from `login()`, from `logout()` and from the client's mid-session
`unauthorized`. The component chunks are deliberately kept: a route's JavaScript
is the same file whoever asks for it.

Six tests, three of which fail against the old line. Nothing in this repo
prefetches a protected route, so no browser drive covers it.

## 2026-08-15 — a live store now means the query that filled it (FJS-011)

`load(query)` says what a store holds; every push was applied to it regardless.
So a created row outside the filter appeared in the list, and — the one that
reads as an update rather than as junk — a row a patch had just moved OUT of the
filter stayed in it, updated in place and quietly wrong. There is no removal
event for leaving a filter; that is exactly why the store has to ask.

`matchesQuery(fields, record, query)` in `field-rules.js` is the question, and it
belongs there for the reason everything else in that module does: the file is a
leaf with no client import, so the client's answer can be *compared* against the
server's rather than asserted against a copy of it. The operators are the ones
`parseWhere`/`translateOps` accept and `buildWhere` compiles, in both the
`$`-prefixed wire spelling and the bare Litestone one, and no others. The
expectations are SQL's, not JavaScript's — `col != 'x'` does not match a NULL
column and `NOT IN` does, so `$ne` and `$nin` disagree about a null on purpose.

**Three answers, not two.** `null` is *cannot be decided from this record* — a
`select` that dropped the filtered column, a filter naming a relation, `$search`,
a raw clause — and the store reloads rather than guessing. A matcher forced to
return a boolean has to guess, and guessing wrong is silent, which is the class
of bug this is. A decided `false` still wins over an undecidable key, so a miss
costs no request.

The store itself is Junction's and Junction holds no schema, so `resource()`
takes the decision as `match` and `createResource` supplies it. Passing nothing
is the old behavior exactly. 32 tests here, 8 in junction.

Ordering and paging are the other half and are junction's — see its CHANGES for
`FJS-270`. What reaches this package is one more thing on the resource: **`stale`,
beside `store`**, counting what the live list could not place on its own (a row
that may belong on an earlier page, a gap a removal left behind a full one). It
has a store's `{ get, subscribe }` shape, so `useStore(orders.stale)` bridges it
to a signal unchanged, and `load()` clears it.

## 2026-08-15 — the client schemas missed an imported .lite file (FJS-264)

`build/schema-plugin.js` read `db/schema.lite` and called litestone's `parse`,
which resolves no `import "./other.lite"` — only `parseFile` does. So a schema
split across files reached the browser as a `$defs` table with the imported
models absent.

Nothing failed. Every step after it degrades: `modelNameFor` misses and warns,
`createResource` falls back to a bare `make()`, and `<Form {resource} />` renders
no fields — against an app that builds clean. `fli auth:install` writes exactly
that layout now, so it is the shape apps will have.

An older Litestone with no `parseFile` keeps working for the schemas it could
always handle, and warns **by name** for the one case it cannot. A silent
fallback there is the same bug wearing a version number.

`test/schema-generation.test.js` § *a schema that imports another file*, checked
against a negative control — including that an enum declared in the imported file
lands in `$defs` and resolves as a `$ref`, since a dangling one is a control with
no options.

## 2026-08-15 — one inflection module behind the registry and `createResource` (FJS-192)

Sierra held two of the five copies: `_pluralOf` in `schema-registry.js` and an
inline `endsWith('ies') ? … : endsWith('s')` in `createResource`. The inline one
was the weakest of the five — `statuses` singularized to `statuse`,
`modelNameFor` missed, and the resource degraded to a bare `make()` with a
console warning. Both call `@frontierjs/toolbelt/inflect` now.

**`createResource('people')` resolves `Person` without being told.** The
irregular table travels with the module, so the registry indexes `people`,
`children` and the rest, and `{ model: … }` is back to meaning what it says: a
service named for something other than its model, or a word no rule can reach
(`lenses`/`Lens`). `test/resource-model-name.test.js` moved the irregulars into
the resolves-without-help table and took a misspelling — `companie` — as its
example of a real miss.

## 2026-08-15 — `make()` does not seed a column the caller may not write

A value the caller may not write is not the caller's to seed either. `@system`,
`@computed`, `@generated` and `@from` all reach the browser as `readOnly`, and a
blank seeded for one is a KEY in the payload — which litestone now refuses by
name for a `@system` column. So a form that correctly never showed the field
could not submit at all: the create carried `trackingCode: null` and came back
403 naming a column nobody had touched.

`@version` is the deliberate exception and was never seeded here — `createResource`
remembers the version it read and puts it on the patch itself.

Found by running `example`'s order form the hour `@system` landed, which is the
only place the two halves meet.

## 2026-08-15 — the HMR boundary comes from Mesa now

`src/build/hmr-inject.js` and `src/build/hmr-client.js` are deleted. Both were
ports carrying a "keep in sync" comment, and both are Mesa's: this package
reimplements the PLUGIN — frontmatter stripping, the fence preprocessor, slot
rewriting, auto-imports — which was never an argument about the boundary
(`FJS-D16`). `injectHMR` had been module-private in `mesa-vite/index.js`, which
is the only reason there was a copy at all.

The three fixes this package had made to its copy went UP into Mesa rather than
being thrown away: `canInject` failing closed, `import.meta.hot.invalidate()`
when no instance is registered, and `__setMark` on the new function rather than
the old module's — the last of which meant Mesa's own HMR worked once per page
load and then reported no connected instances.

Both files are located with `findMesaFile`, off the filesystem, for the reason
the compiler already is: a bare `@frontierjs/mesa/vite/hmr` resolves to the
node_modules copy bun leaves for a `workspace:*` dep, which is the last
install's snapshot. **A miss is not fatal** — HMR turns off and edits
full-reload, the same thing `canInject` does for output it cannot wrap — so the
wiring is the half that breaks quietly. `test/hmr-boundary.test.js` boots a real
dev server and asks what only a dev server can answer: did a `.mesa` module come
back wrapped, and does `/@frontierjs/sierra/hmr-client` serve Mesa's client. The
second is asserted on a line that exists only in Mesa's copy, so serving a stale
local file fails rather than passes.

## 2026-08-15 — the control table, and a form's field list derived

`field-rules.js` gains the one place a field becomes a control:

```
controlFor(rule)                 → { control: 'input'|'textarea'|'select'|'checkbox'|'picker'|null, … }
formFieldList(fields, {only, except})  → the field set, in schema order
labelFieldFor(fields)            → which column of a related model a picker SHOWS
```

and the resource hands both out — `resource.formFields()` and
`resource.options(fk)`. `@frontierjs/ui`'s `<Form>` renders from them, which is
how `<Form {leads} />` can be the whole form.

**It lives here rather than in the kit** for the reason the rules do: this module
imports nothing, so the table is readable from a plain Node script and from a
component alike, and the kit does not have to depend on Sierra to render a form.
A UI package contributing a control for a type is an entry in that table rather
than an `{#if}` ladder inside a component.

What the table decides, and what it refuses to: a foreign key is a **picker**
(the one field where a spinner is obviously wrong), an enum is a select carrying
its members, `@markdown` is a textarea — a *declaration*, where "this string
looks long" would have been a guess — and `format: date` is a date input while
`date-time` deliberately is not (`FJS-079`). An array, a `Json` column and a
`readOnly` field come back with `control: null` **and a reason**, because a
field dropped in silence is the failure the whole row exists to end.

`resource.options(fk)` fills a picker with no name written anywhere: the
relation says which model answers, the registry says which service serves it,
and the related model's own fields say which column a person recognizes. That
last crossing needed `serviceNameFor(model)` in `schema-registry.js` — the
plural rules were already there and every call site was spelling
`model.toLowerCase() + 's'`, which is not even the rule the registry uses. One
request per field for the life of the resource; a failure empties the picker and
says so rather than taking the form down.

`buildFieldRules` now carries `readOnly` and `contentMediaType`, which is what
those two answers are read from.

## 2026-08-14 — `node_modules` contains the substring `_module`

Two defects in the Mesa plugin, both of them invisible in this repo and both
fatal for an app that installs the framework rather than resolving it out of the
workspace. Found by containerizing basecamp, which is the first time anything
here has built an app that could not see `packages/`.

**The node_modules allowance named one package.** `FJS-251` fixed the literal
`/node_modules/sierra/` to `@frontierjs/sierra` and stopped there — but
`@frontierjs/ui` ships 64 components as `.mesa` SOURCE and `@frontierjs/email-kit`
ships 22 more, and every one of them went to rolldown untransformed:

```
[PARSE_ERROR] Unexpected JSX expression
  node_modules/@frontierjs/ui/components/display/CopyButton.mesa:1:1
```

The allowance is the SCOPE now. A `.mesa` file has exactly one meaning and
nothing but the Mesa compiler can read it, so the question was never *should
this be compiled*.

**And `id.includes('_module')` decided whether a file was a layout.** The string
`node_modules` contains `_module`. So every installed component read as a
layout, took `rewriteLayoutSlots` instead of `rewriteMesaSlots`, and failed to
compile with

```
'$: __slot_actions = ...' — '__slot_actions' is already declared.
```

— a message about a slot the author never wrote, in a file they did not edit,
naming a variable that appears nowhere in the source. The test is the basename
now. Three call sites had it; all three were the same substring.

The pair is one shape twice: **a path predicate that is true in the workspace
for a different reason than it is true in an install.** The suites cannot see
either, because an app in this repo resolves sierra to `packages/sierra/` and
aliases the ui kit to `packages/ui/` — neither is a node_modules path at all.
`test/node-modules-allowance.test.js` now writes its ids the way an INSTALLED
app produces them, and covers both. — @frontierjs/sierra

## 2026-08-14 — `sierra routes` — the route table as a committed file

The UI realm's snapshot, beside the Data realm's (`litestone access`,
`litestone ddl`) and the API realm's (`junction surface`). `sierra routes
--config config/sierra.config.js` writes `routes.snapshot.md`: every URL with
its file, the layout the scanner resolved, the params, the merged declared meta,
and what each `_module.mesa` wraps. `--check` byte-compares it; `scripts/ci.mjs`
reruns it from the header the file carries. New `sierra` bin, `src/tools/`.

**A route table is a naming convention over a file tree.** A rename moves a URL
somebody already published, a `_module.mesa` one directory up rewraps every page
beneath it, and a page declaring `reset` opts out of the chrome every other page
has — none of which is referred to by name anywhere in the app, so none of it is
greppable and no test fails when it moves.

**On a `static` target `publishes:` leads the file**, in its own section ahead of
the routes, for the reason the access snapshot leads with Unrestricted: it is the
line that turns a check off. The prerender build taps every read `load()` makes
and compares it against that model's `@@gate`, fail-closed; `publishes: N` is the
override, and it lives in one page's frontmatter. Declared on a non-static target
it is inert, and the snapshot says so under its own heading rather than listing it
beside the real ones.

Run it from the app's **web root** — `routesDir` is relative to Vite's root, not
to the config's location (Invariant 3). One config is one target, and the name
carries: `sierra.static.config.js` → `routes.static.snapshot.md`.

## 2026-08-14 — every app installed from npm can build

`FJS-251`. The mesa plugin skips `.mesa` under `node_modules` — another
package's components are that package's problem — with one exception for
Sierra's own `RouterView` and `ChainRenderer`, which ship uncompiled. The
exception named the wrong package:

```js
!id.includes('/node_modules/sierra/')     // the package is @frontierjs/sierra
```

So it never matched, both components went to rolldown untransformed, and the
build died on

```
JSX syntax is disabled and should be enabled via the parser options
  ../node_modules/@frontierjs/sierra/src/components/RouterView.mesa:1:1
```

**Nothing in this repo could see it.** An app here resolves sierra to
`packages/sierra/`, which is not a node_modules path at all, so the skip never
fires and `verify:build` passes. Dev survives too — the transform runs the same
way, so the failure waits for the first *production build a real user runs*.
`virtual-sierra.js` had the scoped name right twenty lines away in a sibling
file, which is the shape of the whole defect: one literal, drifted, unwitnessed.

The name is now a constant (`SIERRA_PKG`) rather than an inlined string, because
inlining is what let it drift.

Reproduced before fixing, against the published 0.1.2: `fli new demo --yes
--auth --source npm`, `bun run build` → exit 1. With the fix → exit 0, four
route chunks, sitemap, speculation rules.

`test/node-modules-allowance.test.js` pins it by driving the real `transform`
with ids shaped the way an **installed** app produces them. That detail is the
test: one written with workspace paths passes against the bug. Checked against a
negative control — restoring the old literal fails it — rather than trusted for
passing.

What this does not close: nothing in CI scaffolds an app and builds it, so the
next defect of this shape is equally invisible. `FJS-241` and
`IDEAS/deploy-plane.md` both ask for that test.

## 2026-08-10 — no signals to declare, so no `externalSignals` to declare them in

`FJS-060`, closed by removing the last thing it applied to.

A module-level signal read bare in a template is only reactive if the CONSUMING
build names it — in another package, by hand — and omitting a name fails in the
worst possible way: the read is hoisted out of the render block and assigned once
at mount. `{connected ? 'ws connected' : 'ws offline'}` said *ws connected* with
the API stopped, and across a reload.

Two thirds of the retirement had already happened: the router's eight signals
became the plain object `page`, junction's two became `status`. **`theme` was the
last one and it was holding the whole bridge up on its own** — one entry, in two
spellings, that nothing in this repo read. It is now `{ value: 'light' | 'dark' }`,
written through `watchProxy` like the other two, and `mesa-plugin.js` passes the
compiler **no map at all**. `externalSignals` still exists in Mesa as an
app-facing escape hatch for a third-party package that does export a signal.

**Breaking:** `theme.get()` → `theme.value`, and a component that reads it needs
`$: theme.value` like `page` and `status`. Zero consumers in this repo.

**The plugin now passes `externalReactivityHints: 'strict'`, and that is the half
worth reading.** The plain-object replacement has the *identical* silent failure
— a member read with no `$:` watch is hoisted static exactly as a missed rewrite
was — and by default it was **quieter than the thing it replaced**: Mesa's path
tier reports an uncovered read only when the file already watches some other path
on the same import. It says nothing about a component that watches nothing, and
that is the shape the `connected` bug had. Strict covers it, existed already, was
opt-in, and nothing anywhere enabled it.

Measured before finishing: 4 warnings over 97 app components, all
`resource.gate.<method>` — a level number the schema fixes, now `var` snapshots,
which is what RULE 13 exists to say. After: **0 over all 218 `.mesa` in the
repo**. Strict costs nothing.

`test/external-signals.test.js` is gone with the map it guarded.
`test/no-module-signals.test.js` replaces it with the stronger property, held in
both directions: `src/` exports no module-level signal, and the plugin declares
none. `signal()` itself stays — `presence(channelId)` returns one from a call,
which no map could ever have described.

## 2026-08-10 — the package declared none of the four things it imports

Publish prep. `package.json` had **no `peerDependencies` at all**, while five
shipped files open with a static `import … from '@frontierjs/mesa/runtime'` —
`router/index.js`, `router/signals.js`, `junction/index.js`, `presence/index.js`,
`islands/loader.js` — and `junction/index.js` also statically imports
`@frontierjs/junction/client`. An installed copy would throw on
`@frontierjs/sierra/router`, which is the main path.

Now declared: **`@frontierjs/mesa` required**, `@frontierjs/junction`,
`@frontierjs/litestone` and `vite` optional. mesa is a **peer, not a
dependency** — two copies of the reactive runtime are two signal graphs, and
nothing at runtime would say so. The three optional ones are genuinely dynamic:
`vite` and `mesa/render-component.js` are `await import`ed inside the build, and
`litestone` is resolved **from the app** on purpose (`schema-plugin.js` says why
in a comment).

The declaration is what makes the block visible rather than silent: sierra now
refuses to install until `@frontierjs/mesa` is published, instead of installing
happily and failing on first import. 833 tests unchanged.

## 2026-08-10 — auto-import recurses, and covers module bindings

`autoImport.components` scanned one directory level and matched only tags, which
made it the weaker half of what it was modeled on. Two changes.

**Directories are scanned recursively**, keyed on the basename. A component's
directory organizes it; its name identifies it — the same split the repo already
makes between a resource file and its accessor. `node_modules`, `dist` and
dot-directories are skipped, because a misconfigured path otherwise walks the
whole dependency graph before it fails.

**`autoImport.modules` is a package → bindings map** — named, aliased, default
and namespace forms. A module binding is not a tag, so it cannot be found the
way a component is: identifier scanning replaces tag scanning for these, over
`<script>` bodies and `{…}` expressions only. Template prose is not code, or
`<p>Use dayjs</p>` would import `dayjs`; neither is a property access, an object
key, a string or a comment. A name the file already binds — an explicit import
or a local declaration — always wins, since injecting over either is a
redeclaration the module will not parse.

Both registries share one namespace, because the injected import is the same
identifier whichever produced it: two sources providing one name is a build
error naming both sides.

`injectAutoImports()` still accepts the old `name → path` map, so a caller
holding one is not silently skipped.

833 tests — including a real Vite build over a nested fixture, since a prepended
import can be syntactically fine and still land in the wrong block, and a
missing injection does NOT fail a build: Mesa compiles a reference to an
undefined name happily. Only what is in the bundle separates the two.

## 2026-08-10 — `@version` follows the store, and a sub-set store cannot be overtaken

The sierra half of `FJS-082`. Junction now refuses a `load()` that has been
overtaken, and this package had two paths carrying the same defect.

`createStore(service).find()` — the independent store for sub-sets — set its
rows unconditionally, so it went wrong exactly the way `resource().load()` did.
It now takes the same stamp-when-issued guard.

The `@version` map was filled from `load()`'s return value, which was wrong in
both directions once ordering matters: a load whose rows the store refused as
stale still left its versions behind, and a WS push — which reaches the store as
an upsert and passes through no call result at all — never updated them, so the
row a second tab patched kept its pre-patch version here and the next patch from
this tab 409'd against a number nobody had read. Versions are now recorded off
the store, which is the one thing that knows what data is current. A `get`,
`create`, `patch` or action result still records on the way out: a form reads a
single record that never enters the list store, which is why the map exists
apart from it.

810 tests; `test:safety` 5/5; `example` `verify` 37/37 and `verify:build` 37/37.

## 2026-08-08 — `action()` can address a collection, and carry a query

`resource.service.action(name, id, data, query)`: `id` may be null for an
action about the whole collection, and the fourth argument travels as the
request's query string. Both were reachable on the server and neither was
expressible here — see junction's note for why. The hook pipeline, and the
deliberate absence of coercion and validation on an action payload, are
unchanged. 809 tests; `test:safety` 5/5.

## 2026-08-06 — a prerendered page is the app, not a fragment of it

809 tests (was 805). Closes `FJS-108`.

A `target: 'static'` page shipped every `@frontierjs/css` class name the app
uses and **not one rule behind them**. A prerendered document is assembled by
`wrapDocument` rather than by Vite's HTML transform, so the stylesheet the same
build emits had no way into it, and the theme — one class on `<body>`, stated in
`index.html` for the SPA — had none either. The SPA built from the same source
looked right, which is why nobody had seen it.

`wrapDocument` now takes `stylesheets` and `bodyClass`:

```js
// sierra.static.config.js
document: { bodyClass: 'app theme-default' },
```

The stylesheets are the CSS assets of that build, discovered rather than
configured, and they are linked BEFORE the page's own scoped `<style>` blocks —
a component's own rules are the more specific statement and must win.

**Read in `writeBundle`, not `generateBundle`.** Vite's CSS plugin emits the
stylesheet in its own `generateBundle`, which runs after Sierra's, so reading the
bundle one hook earlier saw an empty asset list and linked nothing, silently.

Driven end to end by `example/`'s new `verify:public`, which asserts the link,
the body class, and a theme token resolving in a real browser.

## 2026-08-06 — `@version` works from the browser, not just at the boundary

805 tests (was 789). Closes `FJS-105`.

Litestone shipped optimistic concurrency the same day: a patch on a `@version`
model that does not carry the version it read is refused, and one carrying a
version that moved is a 409. `x-version` named the column in the JSON Schema and
**`createResource` read none of it** — so every patch on such a model 400'd until
an app threaded the column by hand. The framework was enforcing a guarantee its
own client could not satisfy.

`createResource` now remembers the version of every record it reads — `get`,
`find`, `load()`, `create`, and each patch response — and puts it on the next
patch. Two details decided the shape:

- **Kept per record, not read off `store`.** A form usually loads one record with
  `get()`, which does not populate the list store at all.
- **`load()` needed its own call.** It goes through `junctionResource` rather than
  `_call`, so it saw none of this — and a list whose rows cannot be patched is the
  same bug wearing a different hat.

A caller-supplied version still wins — that is someone doing their own
concurrency control. With nothing remembered the patch goes up *without* one and
the server refuses, which is better than inventing a number that would silently
win a race. `resource.version(id)` and `.versionField` expose it.

### A 409 could not say which kind of 409 it was

Litestone throws two, and they want opposite words. `VersionConflictError` and
`TransitionConflictError` are races — re-read and re-apply. `TransitionViolationError`
is a domain refusal, and *its own message* is the right thing to show; telling
someone to retry a move that will never be legal is worse than saying nothing.

The flag already existed on the litestone classes and stopped at the boundary.
Junction's `toFrameworkError` now adopts `retryable` and `FrameworkError.toJSON`
serializes it, so both transports land it at `err.data.retryable`.
`isStaleWrite(err)` reads it and `toFieldErrors` returns

> This record changed while you were editing it. Reload to see the current
> version, then try again.

instead of a column name and two integers. A non-retryable 409 keeps its own
message, and a per-field 400 is untouched.

Verified end to end rather than against a mock — a real litestone update behind a
real route, over a real HTTP round-trip, with the browser client's error shape
rebuilt from the response body: 409 retryable → the sentence, 409 non-retryable →
its own message, 400 → the required-version explanation, success → version 1 → 2.

## 2026-08-06 — a prerendered page must prove it is safe to publish

789 tests (was 755), plus `bun run test:safety` — 5 checks against a real
Litestone client. Typecheck clean.

`render: static` emitted HTML at build time. Every model declares who may read
it. **Nothing connected the two**, so a static route whose `load()` read a model
gated at level 4 wrote that data into a public file — then served, CDN-cached
and indexed, with no warning and no way back. Two correct features, combined the
obvious way. `ISSUES.md` FJS-081.

The prerenderer now collects each route's read set and refuses to emit a page
whose data outranks what the route declares:

```
✗  src/public-site/catalog/index.mesa — render: static
   reads `Invoice`, which is @@gate read 4 — level 4 required to read.
   A prerendered page is public: whatever it contains is served to anyone,
   cached by a CDN and indexed, and cannot be recalled.

   Change the route to `render: spa`, move the data into a client:* island,
   or — if this data really is meant to be public — say so in the route:

       publishes: 4
```

### The read set does not come from the render

`IDEAS/static-safety.md` proposed watching the render, on the grounds that "the
prerenderer knows which resources a route touched (it renders them)". **It does
not.** A static route's data comes from `load()` in the `.meta.js` companion,
*before* render, and arrives as a plain `data` prop. Watching the render would
have observed an empty set and passed everything — a green check proving
nothing, which is worse than no check.

It comes from litestone's `$tapQuery` instead, wrapped around the companion.
That also covers the case a build-time analysis structurally cannot see: a
`load()` that imports a Litestone client directly and queries it, which is how a
real app is written.

One thing only running it could settle: **the tap reports the TABLE name
(`product`) and `$defs` is keyed by the MODEL name (`Product`)**. `modelNameFor()`
already owns that resolution, so it resolves through it rather than
lower-casing by hand.

### Fail closed, with a written escape

A route whose reads cannot be *observed* is not a route known to be safe, so it
is refused rather than assumed clean. The only way past is per-route, in the
frontmatter — never a global flag — so publishing gated data is something
somebody wrote down and a reviewer sees in the diff:

```
---
render: static
publishes: 4
---
```

Absent, the bar is 0. `publishes: true` is **refused**: `Number(true)` is 1, so
coercing it would have accepted "level 1" and turned the check off by accident.

### A fail-open hole in the first version of this, found by running it

`importCompanion` swallows an import error and returns null, so a `.meta.js`
that *throws on import* looked identical to a route with no companion and was
waved through as "reads nothing". Found in `example/`, not by reading — the
first `bun run build:public` ran under Node, the companion's db import died on
`bun:sqlite`, and the page was emitted anyway. A companion that exists but could
not be read is now UNKNOWN, which is the case the check exists to refuse.

### Also

- New config key `db` — a module exporting the Litestone client the build taps.
  Every failure to load it returns null rather than throwing, because "cannot
  import db.js" would send the reader at the wrong problem; the route is then
  refused for being unobservable, which is the real one.
- No `.lite` schema means no gates, so the check stands down entirely. A Sierra
  app with no database is unaffected.
- The build prints what it PROVED, not only what it rejected — a rule whose
  passing case is invisible is one people assume is not running.
- **Sharp edge:** the build's `$defs` come from `db/schema.lite`, which can be
  narrower than what the app composes at runtime. In `example/`, auth's `User`
  is appended by `authSchemaFragments()` and so is not in the build's view — a
  static route reading it is refused as *unknown gate* rather than *gate 8*.
  Both refuse; only the wording differs.

Exercised for real in `example/`: `bun run build:public` prerenders `/catalog/`
from the live database and reports `/catalog/ 0 Product(0)`. Point its `load()`
at a gated model and the build exits 1.

## 2026-08-06 — the payload pipeline is on by default, and a thrown value has an unwrapper

755 tests (was 742).

**`coerce`, `blankToNull` and `validate` now default ON** for
`createResource`. Each was opt-in, and each answers something the DOM does that
the schema has already said no to:

- every control hands back a string, including `<input type="number">`, so a
  Float field arrived as `"42"`
- an untouched text box submits `''`, which SQLite does not treat as the NULL a
  nullable column wants — `String? @unique` accepts any number of NULLs and
  rejects a second `''`
- and without the check, the first "no" is a 400 you still have to map

The evidence they were the wrong default is that every app in the repo set all
three: all three resources in `example/`, and eight of the nine in
`packages/basecamp` (the two that did not are read-only). Those flags are now
deleted from both — a flag every app turns on is a default. Off is
`{ validate: false }`, and the test is `!== false` rather than `?? true`, so a
prop threaded through a component that never set it reads as "not stated"
instead of silently disarming the check.

This is also what makes `<Form>` in `@frontierjs/ui` correct with nothing
declared but a resource: the form does not validate, the resource does, and the
form only renders what came back.

**New: `toFieldErrors(err)` in `field-rules.js`, and `resource.fieldErrors(err)`.**
A failed write arrives in one of three shapes, because each hop adds a wrapper:
`err.errors` (ResourceValidationError — the browser said no), `err.data.data`
(a server 400 as the browser client throws it) and `err.data` (the same list
one wrapper shallower). It returns `{ fields, message }` — `fields` keyed for
`<Field errors={…}>`, `message` the form-level line, empty when the failure was
entirely per-field so a form does not say everything twice.

One owner for that translation, in the leaf module, so a form does not need to
know which shape it is unwrapping and there is nowhere for a second copy to
drift. 10 tests.

## 2026-08-04 — compiler errors now fail the transform

742 tests. `mesa-plugin` read `ctx.analysis.warnings` and never
`ctx.analysis.errors`, so a component the compiler had rejected was served
anyway. A settings screen with five `bind:` errors in it — every one correctly
diagnosed as "must be a writable top-level `let`" — rendered, looked right, and
silently collected nothing. The transform now throws with the list.


## 2026-08-04 — the unexported-snippet warning fired on every kit component

742 tests. `warnUnexportedSnippets` measured "top level" by counting block
directives only, so a snippet written inside a component tag —

```svelte
<Table {rows}>{#snippet row(r)}<tr>…</tr>{/snippet}</Table>
```

— read as top level and warned on every build, advising an export that would
have been wrong: that snippet is the component's `row` prop, not something the
route hands up to its layout. Component tags now count as nesting.

The tag scanner skips attribute expressions by brace and quote depth rather
than scanning to the first `>`, because an ordinary handler contains one:
`onclick={() => run(id)}` ends a `[^>]*>` match inside the arrow, and the tag
is then read as never closed — which would have suppressed the warning for
everything after it. Both cases are pinned in `test/warnings.test.js`.

## 2026-08-04 — resource.service.action(): custom actions over HTTP

A resource could not call a custom service action at all. Junction has shipped
the whole mechanism for a while — a non-CRUD function on a service definition is
dispatched as `POST /{service}/{id}` with an `X-Service-Method` header, and the
browser client has `action(name, id, data)` — and Sierra's service proxy simply
never exposed it. `orders.service.action('pay', 3)` was a TypeError.

Worse, the pipeline's `default` branch — which handles any method that is not
CRUD — routed through `proxy.call()`, the *explicit WebSocket* escape hatch. That
is WS-or-nothing by name, and with no socket it recursed inside Junction's client
and never settled. The default branch now goes through `action()`, which applies
the framework's transport rule: the socket when one is connected, HTTP when it is
not. `call` stays on the proxy for callers that want to force the socket.

(The corresponding Junction fixes — `action()` and `restore()` now prefer the
socket, and the HTTP fallback no longer recurses — are in that package's
changelog for the same date.)

`action()` runs the full hook pipeline. Coercion, blank-stripping and validation
are deliberately skipped: those are defined against the model's fields for
create/patch payloads, and an action's body is whatever that action declares.

Found the only way this kind of gap is found — by joining the two ends in a real
app. `@@transitions` was declared in a schema, enforced at the Data boundary and
reaching the browser as `x-transitions`, with nothing anywhere calling any of it.

## 2026-08-04 — the browser says the sentence the schema declared

740 tests (was 729).

`buildFieldRules` carries `title` (Litestone's `@label`) and `x-messages` onto
each rule, and `validateAgainstFields` consults the authored wording for the
keyword that failed before falling back to its generated sentence. The fallback
is built from a new exported `fieldLabel(name, rule)`:

    @label   →  "Customer is required"
    relation →  "customer is required"      ← a foreign key borrows its relation's
                                              name with nothing authored at all
    neither  →  "customerId is required"

The middle case is the common one, and the one where the raw column under a
form label reading "customer" looked most like a bug.

`title` is read off the field's OWN schema rather than the deref'd target —
Litestone titles every enum `$def` with the type name, so `status OrderStatus`
was introducing itself as "OrderStatus". It has been removed from `_CARRIED`
for that reason; two existing tests caught it.

The error object still keys on the real field name, so a form can still find
the control it belongs to.

## 2026-08-04 — a relation key defaults to null, not 0

729 tests (was 724). Reported from a form in `example/`: not picking a customer
answered `500 FOREIGN KEY constraint failed` instead of "customer is required".

`createMakeFromSchema`'s `typeDefaults` gave every `integer` a `0`, so
`orders.make()` produced `customerId: 0`. That is not "no customer" — it is
customer #0, a claim the user never made. It is also the one invented default
nothing downstream can catch: a bad enum value fails validation with the
field's name on it, but `0` is a perfectly good integer, so `coerce()` keeps
it, `validateAgainstFields()` approves it, and the database is the first thing
to object — from the server, after a round trip, as a 500.

The function three lines above already made this argument for enums: *"picking
the first member would invent a choice the user never made — so leave it unset
for the form to fill."* A foreign key is the same case.

`createMakeFromSchema` takes a fourth argument, the FK column names, and
defaults them to null. It cannot be derived from `properties`: a belongsTo is
emitted as a plain integer and `x-relations` is the only place the relation
exists on the client, so `createResource` reads `x-relations[].fields` and
passes them in.

`string: ''` is deliberately unchanged. A required string left blank also
fails, but it fails *informatively* — `@length(3,20)` names the field and the
rule — and an empty text box is what the user actually sees. There is no such
honest empty for a numeric key.

Five tests in `test/make-from-schema.test.js`, one of which pins the crux:
`0` produces no validation error at all, `null` produces "customerId is
required".

Newest first.

## 2026-08-04 — `resource.transitions(row, level)` — the button list, off the schema

Litestone gained `@@transitions`: a state machine declared on the model and
enforced at the Data boundary, with an optional `@gate(N)` per move. It reaches
the browser as `x-transitions` on the model definition, and this is the client
half.

```js
const orders = createResource('orders')

orders.transitions(row, level)
// → [{ name: 'ship',   field: 'status', from: 'paid', to: 'shipped',  gate: null, allowed: true  },
//    { name: 'refund', field: 'status', from: 'paid', to: 'refunded', gate: 5,    allowed: false }]
```

The legal next states for that record, so a view renders exactly the right
controls with no logic of its own. New in `src/junction/field-rules.js` —
`buildTransitions(modelDef)` and `transitionsAt(spec, row, level)` — which stays
a leaf module with no Junction-client import, so both are testable in plain Node
against litestone's own output rather than a copy of it.

Same contract as `canAtLevel()`, and for the same reasons:

- **An affordance, never a boundary.** Litestone re-checks every move and throws
  `TransitionViolationError` / `TransitionGateError` regardless of what the
  client drew.
- **Unknown answers are permissive** — no gate on a move, or no level supplied,
  means `allowed: true`. A missing button is the quieter, worse failure.
- **A gated move the caller can't make is returned with `allowed: false`, not
  dropped.** Rendering it disabled is usually better than making it vanish;
  filter on `allowed` if you disagree.

A resource whose model declares no machine returns `[]` rather than pretending,
matching how `fields` and `relations` already degrade.

`test/resource-transitions.test.js` builds its fixture by running litestone's
parser and `generateJsonSchema` over a `.lite` source rather than hand-writing
the defs, so drift between what litestone emits and what the client reads fails
here instead of in an app. 724 tests green (was 707).

## 2026-08-03 — probing `client:visible` in headless Chrome: a harness trap, not a product bug

Recorded here because it reads exactly like a broken feature and cost a
debugging cycle: a `client:visible` island that never mounts in a headless
verification run, while mounting correctly in a real browser.

**Headless Chrome delivers almost no rendering lifecycle after load.** Under
`--virtual-time-budget` the page gets a frame or two around load and then
effectively none, so an `IntersectionObserver` set up *after* that window never
reports — the callback simply does not run, and the island stays inert.

What does not help:

- `--run-all-compositor-stages-before-draw` — no effect on this.
- awaiting `requestAnimationFrame` — **hangs**; rAF stalls after one or two
  frames.

The working pattern is in `test/fixtures/island-site/verify.mjs`: **scroll
first**, before the observers matter, and do it inside a nested scroll container
so the rest of the page stays where the other assertions need it.

Applies to anything in this repo driving headless Chrome for verification,
`@frontierjs/css`'s suite included.

---

## 2026-08-03 — nested islands: the ancestor's mount is authoritative

A `client:*` component inside another one worked by accident and reported itself
as broken. Mesa's `island()` short-circuits on the client, so a mounted island
renders its nested children directly — live, in its own delegation root, before
their directives fire. The loader raced that instead of deferring to it.

Three fixes in `src/islands/loader.js`:

- **A subsumed island resolves nothing.** The scheduled callback checks
  `open.isConnected` before touching the registry, so a nested island neither
  downloads a chunk nor reaches `mount()` with a detached anchor. That throw was
  being caught and logged as `<Inner> failed to load or mount` — a working
  island announced as broken on every page that nested one.
- **Mounting clears the LIVE range**, not `island.nodes` from scan time. A
  descendant that mounted first has already replaced its own markup, so removing
  the captured list would strand its live nodes beside the ancestor's fresh
  render — two copies, one of them dead.
- **A descendant that got there first is disposed**, releasing its delegation
  root instead of leaking it. (`mount().destroy()` does not dispose effects —
  Mesa's mount owns no reactive root — so that limit is documented, not hidden.)

`findIslands` now links each island to its `parent`, which is the client's only
view of nesting: a marker records a component, not a position in a tree.
`client:static` under a live ancestor warns — the parent renders its children,
so "no JS" cannot be honored — while a `client:static` *parent* never mounts and
therefore does not subsume anything inside it.

Requires the matching Mesa build: the fixture for this uncovered a
double-dispatch bug in Mesa's event delegation (see its CHANGES.md).

Test status: **707 passing, 34 files**, typecheck clean; the browser fixture is
20 → 25 assertions and now builds a nested island end to end.

---

## 2026-07-25 — performance/correctness pass

Baseline was the 2026-07-25 archive. Requires the matching `@frontierjs/mesa`
build (see its CHANGES.md — the async-declaration compiler fix is independent
but was found via this app).

Test status: **505 passing, 25 files.**

---

## 1. Boot navigation ran without guards — `src/router/index.js`

`initRouter()` started the boot `_navigate()` synchronously during
`virtual:sierra` module evaluation. App code registers guards when the root
component mounts, one tick later — by which point the guard loop had already
iterated an empty `_beforeGuards`. `_navigate` then awaits the lazy component
import, which yields long enough for the app to mount, so `_afterHooks` *did*
fire. Net effect: `afterNavigate` saw the boot navigation, `beforeNavigate`
never did.

Consequence: an auth guard protected client-side navigation to a route but not a
direct page load or refresh of it.

Fix: boot navigation is deferred by one `queueMicrotask`. Static imports and the
`mount()` that follows them are the same synchronous turn, so the microtask
lands after guards are registered.

Also: both hook loops now iterate a snapshot (`[..._beforeGuards]`,
`[..._afterHooks]`). Guards may await, and a registration landing during that
await was previously picked up by the in-flight loop.

**New:** `test/boot-guard-order.test.js` — 3 tests.

Note: `activeRoute` is now null for one extra microtask after `initRouter`
returns. `RouterView` already gates on `{#if activeRoute}` and the boot
navigation was always async, so this should be invisible.

## 2. HMR: 3 full page reloads per save → 0

Measured with `smoke-test/probes/trace-order.mjs`. One save of a route file
produced three reloads from three distinct causes:

| cause | fix |
|---|---|
| Vite escalating — no `import.meta.hot.accept` in the chain | `injectHMR` |
| `scanner-plugin.js:162` explicit `full-reload` | conditional invalidation |
| Vite escalating on the rewritten `config/routes.js` | byte-stable manifest |

**`src/build/hmr-inject.js`, `src/build/hmr-client.js` (new)** — ported from
`@frontierjs/mesa-vite`. Declares the HMR boundary Sierra was missing. Wired into
`mesa-plugin.js`, dev only; production output is unchanged (verified: no
`__mesa_register` / `__mesaHMRWrap` in `dist/`). `canInject()` guards both
regexes, so an unexpected compiler output shape falls back to the old reload
behavior rather than emitting broken code.

**`src/build/mesa-plugin.js`** — also tracks which files received a boundary and
suppresses `sierra:hmr` for them. Mesa's accept handler owns those updates;
emitting the custom event too would drive a route remount on top of the in-place
swap.

**`src/scanner/generate-manifest.js`** — removed the generation timestamp and
made `generateManifest` a no-op when bytes are unchanged. The manifest lives
inside the Vite root and is imported by `virtual:sierra`, so rewriting identical
bytes invalidated the whole app on every save.

**`src/build/scanner-plugin.js`** — the rescan still runs on every route save,
but `invalidateVirtualSierra` now fires only when the manifest actually changed.
Add/remove remain unconditional.

Result by edit type: route body **0**, layout body **0**, feature route **0**,
non-route module **0**, route frontmatter **2** (correct — it changes routing
metadata; the second is redundant and could be tightened).

Scope caveat: `__mesa_hot_update` is **not** state-preserving. It removes the
component's DOM and re-invokes the factory with the props captured at mount, so
component-local signals reset. What survives is router state, scroll position,
sibling components, and the rest of the page.

## 3. Sierra's parallel signal system removed

`src/router/signals.js` contained a second signal implementation, justified by a
comment claiming the router could not import `@frontierjs/mesa/runtime` without
a circular dependency. It can: `runtime.js` has zero imports, and `compiler.js`
is a separate entry point only the Vite plugin loads. router → runtime and
component → runtime is a diamond, not a cycle.

`signals.js` is now a thin wrapper over Mesa's `createSignal`. The `$$bridge`
block — 60 generated lines that monkey-patched `.get` on every exported signal —
is deleted from `src/virtual/virtual-sierra.js` (246 → 204 generated lines).

Also removed:

- **`.value`** — the bridge patched `.get` but left the `.value` getter on the
  old closure, so `sig.value` was a silently untracked read; an effect reading it
  never re-ran. In templates the accessor rewrite turned `{s.value}` into
  `s.get().value`, a property lookup on the value object. Same syntax, two
  meanings, no diagnostic.
- **`derived()`** — exported, imported once by `router/index.js`, never called.
  Recomputed k+1 times at creation for k sources and had no unsubscribe path.
  Use Mesa's `createMemo`.

`test/build.test.js` gained two guards asserting the bridge is *not* emitted.

### ⚠ Behavior change: `.subscribe()` coalesces

Subscribers previously fired synchronously on every `set`. Mesa coalesces writes
through `queueMicrotask`, so a subscriber now sees the latest value once per
flush:

```js
s.set(1); s.set(2)   // was [0, 1, 2] — now [0, 2]
```

Nothing inside Sierra uses `.subscribe()` any more, so this is internally safe.
Six tests encoded the old contract and were updated to use `flushSync()` between
writes. **If anything downstream depends on observing intermediate values, this
is where it breaks.**

This is the same mechanism that makes a navigation's eight signal commits produce
one render. Measured at 1 render/navigation both before and after — the bridge
was redundant, not harmful.

## 4. Build-time code no longer imports the client runtime

`src/theme/script.js` (new) holds `buildThemeScript`, a pure string builder.
`theme/index.js` re-exports it for compatibility; `postbuild/inject-theme.js`
imports it directly.

Previously the chain

```
vite.config.js → sierra/build → postbuild/index.js
              → postbuild/inject-theme.js → theme/index.js
              → router/signals.js
```

pulled client runtime code into Node-side config resolution. Harmless only while
`signals.js` had no imports; the moment it imported the Mesa runtime,
`vite build` failed with `Cannot find package '@frontierjs/mesa'` before
compiling anything.

Worth a wider sweep — this is unlikely to be the only build module reaching into
client code.

## 5. Prefetch — dedupe key, cache bounds, delegation

`src/router/prefetch.js`, plus the cache read site in `src/router/index.js`.

**Dedupe was keyed by route id** (`_prefetched.has(node.id)`), so a dynamic route
prefetched exactly once per session — hovering `/blog/alpha/` permanently blocked
`/blog/beta/`. The cache it populated was keyed per-URL, so the gate was coarser
than the thing it gated. Prefetch failures are silent by design, so the only
symptom was navigation feeling slow for every slug after the first.

Now keyed by the full cache key. Chunk imports keep a separate route-id set
(`_prefetchedChunks`) — every `/blog/:slug/` shares one JS chunk, so importing it
once is right, while each slug needs its own `load()`. The old gate conflated
these and deduped the chunk correctly by accident.

**Cache is now bounded and expiring** — 32 entries, FIFO eviction, 30 s TTL.
Previously entries were removed only on consumption, so anything prefetched and
never visited held its full payload for the session, and a route prefetched at
t=0 served ten-minute-old data at t=10min. The router reads through
`_prefetchCacheHas()` / `_prefetchCacheTake()` so expiry is enforced at the
navigation site.

**MutationObserver replaced with event delegation.** The observer watched
`document.body` with `subtree: true` and ran `querySelectorAll('a[prefetch]')`
for every element inserted anywhere in the app — rendering a 1 000-row list meant
1 000 subtree queries, 1 000 attribute writes and up to 2 000 `addEventListener`
calls. Hover and mousedown now need no per-element setup at all; four delegated
listeners cover every link that will ever exist. `visible` and `immediate` still
need element registration, handled by `scanPrefetchLinks()` on boot and after
each navigation commit.

`immediate` mode also gained a concurrency limit (3). Previously a page with 100
bare `prefetch` links scheduled 100 idle callbacks that all timed out together at
2 s and stampeded.

**New:** `test/prefetch-dedupe.test.js` — 10 tests.

## 6. Layouts load per route instead of all at boot

`src/router/index.js`, `src/router/internals.js`, `src/router/prefetch.js`.

`initRouter` used to invoke every factory in the `layouts` map immediately, so
every layout chunk in the app sat on the critical path regardless of which route
was being visited — including for `reset: true` routes that render no layout at
all. The justification was that `resolveChain()` would otherwise see
`component === undefined` on first visit to a layout-using route.

That is a sequencing problem, not a preloading one. `_navigate()` already awaits
the page component before committing signals; it now also awaits
`loadLayoutChain()` for the target route, started in parallel with the component
so the two network requests overlap. The chain is complete before `activeRoute`
is set, so `resolveChain()` never sees a hole, and layouts a session never visits
are never fetched.

`loadLayoutChain()` lives in `internals.js` because `prefetch.js` needs it too
and cannot import from `router/index.js` (which imports `prefetch.js`). Prefetch
now warms the chain as well — without that, a prefetched route would still block
on its layout chunk at navigation, which is the latency prefetch exists to
remove.

A failing layout is reported and skipped rather than aborting the navigation:
a broken layout should not make a route unreachable, and `resolveChain()`
already omits missing entries.

**New:** `test/layout-loading.test.js` — 7 tests.

**Also added:** `_resetInternals()` in `internals.js`. `_fileToComponent`,
`_layoutParents`, `_chainCache` and `_entryCache` are module-scoped for the
module's lifetime, which is fine for a single browser app but means a second
`initRouter()` call in the same process inherits the previous tree's
registrations — `buildLayoutMap`'s `if (!_layoutParents.has(...))` guard makes
that stale rather than merged. Relevant to tests today, and to SSR or a
re-mounted micro-frontend later.

## 7. matchRoute — 6× faster, identical resolutions

`src/router/match.js`. Measured against the smoke test's 24-node tree:
**2.99 µs → 0.50 µs per match** (300 000 matches, 896 ms → 149 ms).

matchRoute runs on every navigation *and* every prefetch, so it is the hottest
pure function in the router. Three sources of waste:

- **The pathname was re-split at every node visited.** `matchPattern` called
  `splitPath(pathname)` itself, so a 24-node tree meant 24 identical splits and
  24 throwaway arrays per match. Now split once in `matchRoute` and threaded
  down.
- **Pattern segments were re-split and re-lowercased per comparison.** Patterns
  are static for the life of the tree, so they are now precomputed once per node
  into `{ dynamic, name }` / `{ dynamic, lower }` and cached in a `WeakMap`. A
  WeakMap rather than a field on the node, because the tree is serialized into
  the manifest and tests build trees by hand.
- **The params object was allocated before the first comparison.**
  `matchPattern` opened with `{ ...inheritedParams }`, so every failed match
  against a deep static route paid for an object. Now allocated only once a
  dynamic segment is actually captured; a purely static match reuses the
  inherited object.

`normalizePath` also gained a fast path. Both callers pre-normalize and
`matchRoute` normalizes again for safety, so the common input is a string that
needs no work — that case now returns immediately instead of running two
`split()` calls that allocate three strings and two arrays.

Equivalence was checked by differential-testing the old and new implementations
over 328 path × option combinations and 270 `normalizePath` cases: identical
throughout, including case-insensitive statics, percent-encoded params, all
three `trailingSlash` modes, catch-all fallthrough and malformed input.

**New:** `test/match-semantics.test.js` — 20 tests locking the observable
behavior so a future optimization has something to fail against.
**New:** `smoke-test/probes/match-bench.mjs` — rerunnable benchmark.

## 8. Devtools — quadratic under traffic bursts

`src/devtools/buffer.js`, `src/devtools/ui.js`, `src/devtools/tabs/requests.js`.

Dev-only, so this is DX rather than shipped performance — but the panel became
unusable under a busy WebSocket connection. 300 requests with 1 200 hooks and
600 queries (2 100 `render()` calls), panel open: **45 262 ms → 132 ms**. Panel
closed: **316 ms → 1.3 ms**.

Four causes:

- **`ui.render()` ran fully on every inbound message.** A burst of 50 messages in
  one tick meant 50 complete panel rebuilds, each clearing `tabContent` and
  re-creating every row. Now coalesced onto one `requestAnimationFrame`.
  `renderNow()` is available for synchronous callers and tests.
- **The pill was rebuilt via `innerHTML` on every message**, including
  status-only updates — reparsing the markup and recreating five elements each
  time. Structure is now built once; only changed text nodes are written.
- **The ring buffer was `push()` + `shift()`**, O(n) per push once full. Now a
  true circular buffer with a write index. This is the part that was
  *algorithmic*: 20 000 pushes took 60 / 420 / 1 581 ms at caps of 200 / 2 000 /
  20 000 before, and a flat ~15 ms after — the old cost scaled with buffer size,
  the new one doesn't.
- **`addHook`/`addQuery` scanned the ring** with `reqs.all().find(...)` to locate
  their request, once per event, with hooks arriving several times per request.
  Now an id → entry index. The ring reports what each push evicted so the index
  stays in sync in O(1).

Also: the requests tab caches its formatted timestamp per entry rather than
calling `toLocaleTimeString()` per row per render (Intl formatting is expensive),
builds into a `DocumentFragment` and swaps once instead of appending row-by-row,
and iterates the ring newest-first via a generator instead of copying and
reversing.

**New:** `test/devtools-perf.test.js` — 13 tests covering ring semantics,
index/eviction consistency and frame coalescing.
**New devDependency:** `happy-dom`, for the DOM the coalescing tests need.

### A note on how this one went

The first version of the id index reconciled itself by calling `reqs.all()` on
every request — which copies the whole ring once full, and made the buffer
*slower* than before (4.6 → 6.3 ms in isolation) while the headline number still
looked like a 300× win. It only showed up because the benchmark measured buffer,
panel-closed and panel-open separately. Worth keeping that decomposition if this
code is touched again: a large aggregate win can hide a regression in a
component of it.

## 9. Junction — boot no longer blocks on the server

`src/junction/index.js`, `src/virtual/virtual-sierra.js`. Verified against the
real `@frontierjs/junction` client (`src/client/index.ts`).

`virtual:sierra` emitted `await initJunction(sierraConfig.junction)` at the top
level of the app entry module, so every importer — including whatever mounts the
app — waited. Nothing rendered until it resolved.

Inside, with a stored token, it awaited the client's `'connect'` event or a
2 000 ms timeout. The real client only emits `'connect'` when the **server**
sends `{ type: 'connected' }`, which it does at the end of its open handler after
`verifySession` and connection registration — so the wait was a full round-trip
plus server-side session verification, not merely a socket open. Every returning
visitor has a stored token, so this was the common path, and an unreachable API
meant a 2 s blank screen.

The justification was that the first `load()` should see `_wsReady === true` and
use WebSocket rather than HTTP. But the client's `_wsCall()` opens with:

```ts
if (!this._wsReady || !this._ws) return this._httpFallback(service, method, id, data, query ?? null)
```

so calls made before the socket is ready already work — they take the HTTP path.
**Blocking first paint bought a transport preference, not correctness.**

`initJunction` is now synchronous and exports `whenReady` for anything that
specifically needs the socket. `virtual:sierra` emits a bare call; no top-level
await remains in the generated module (asserted in the tests).

Two smaller things in the same file:

- The redundant `client.connect()` after `setToken()` is gone. `setToken` opens
  a socket itself when none is open, and `connect()` returns early if
  `readyState < 2` — so it was always a no-op. (Confirmed by test: exactly one
  socket is created.)
- **Debug logging is now opt-in.** `_wrapDebug` was gated on
  `config.debug || import.meta.env?.DEV`, i.e. on for every dev session. It
  wraps all seven service methods and `console.debug`s `{ request }` and
  `{ response }` per call; console-logged objects are retained by devtools, so
  every response payload stayed reachable for the tab's lifetime. Now
  `debug: true`. The wildcard event logger is `debug: 'verbose'`.

**New:** `test/junction-boot.test.js` — 7 tests using fake timers, covering
synchronous return, `whenReady` resolution on connect, the 2 s fallback, and the
single-socket property.

## 10. Cross-package resolution now reads exports maps

`src/virtual/virtual-sierra.js`, `vitest.config.js`.

Reported from a real `bun link` setup in a `repo/packages/*` layout:

```
Failed to resolve import "@frontierjs/junction/client"
  from ".../packages/sierra/src/junction/index.js"
```

Sierra's source lives outside the consuming app, so when Vite follows the link it
transforms Sierra's *real* path — which has no node_modules of its own. Node
resolution can't help from there, so `virtual-sierra.js` resolves
`@frontierjs/*` against sibling packages. That fallback guessed file paths:

```
<pkg>/client.ts   <pkg>/client.js   <pkg>/client/index.ts   <pkg>/client/index.js
```

None match Junction, whose real file is `<pkg>/src/client/index.ts`, declared as
`"./client": "./src/client/index.ts"`. The resolver now reads the target
package's `exports` map — handling bare strings, conditions objects
(browser → import → module → default) and wildcards — and keeps `main` plus the
old path guesses as fallbacks for packages that declare neither.

`vitest.config.js` had the same class of problem: a prefix alias rewrote
`@frontierjs/junction/client` to `<pkg>/client`. It now derives per-subpath
aliases from each sibling package's exports map.

**New:** `test/frontier-resolution.test.js` — 11 tests over the export shapes
the four packages actually use.

### How this was missed

This was written up in the previous revision of this file as a known weakness
that "works today only because Vite's normal node_modules resolution picks it up
after Sierra's hook returns undefined." It was described as latent. It was not:
it fails outright under `bun link`.

The build passed locally only because, earlier in the same session, symlinks had
been added under `sierra/node_modules/@frontierjs/` for an unrelated probe. Those
made both the app build *and* `test/junction-boot.test.js` pass for the wrong
reason. Removing them reproduced the reported error immediately.

The lesson is narrow and worth keeping: **a package's own `node_modules` must
stay empty of its siblings**, or cross-package resolution is never actually
under test. Both apps and the full suite are now verified with
`sierra/node_modules/@frontierjs` absent.

## 11. Junction signals were missing from externalSignals

`src/build/mesa-plugin.js`.

Reported from the fullstack smoke test: the connection badge read "ws connected"
with the API stopped, didn't update when it was killed, and still said connected
after a page reload.

Sierra exports module-level signals, and a bare read of one in a Mesa template
has to be rewritten to `name.get()` or it isn't reactive. That rewrite is driven
by the `externalSignals` map handed to the compiler. It listed the router and
theme signals but not `connected` / `reconnecting` from `sierra/junction`, so:

```
{connected ? 'ws connected' : 'ws offline'}
```

compiled to a bare object reference. A signal object is always truthy, so the
badge was permanently "connected" — and because the expression read nothing
reactive, Mesa hoisted it as static, which is why it never updated and survived
a reload. No error, no warning.

Both specifiers now declare them.

**New:** `test/external-signals.test.js` — 13 tests. Walks `src/` for
`export const x = signal(...)`, parses the `externalSignals` map out of
`mesa-plugin.js`, and asserts they agree in both directions: every exported
signal is declared under both the scoped and bare specifier, and nothing is
declared that isn't exported (`node` is allowed as a documented alias for
`activeRoute`). Verified to fail with the junction entry removed.

### Why this class of bug keeps happening

This is the third instance of the same shape, and worth naming. Reactivity in a
Mesa template depends on a hand-maintained list living in a different package's
build plugin. Nothing at the import site or the use site marks `connected` as a
signal, and nothing checks the list against reality — so a signal added to
Sierra is silently non-reactive in every consuming app until someone notices a
value that never changes.

The test above closes it for signals Sierra itself exports. It does not help a
consuming app that re-exports one through a barrel, or reads one via a namespace
import — both of which silently lose reactivity. (Aliasing is fine; the rewrite
follows the local binding. Reads inside a `<script>` block are never rewritten
at all — only template expressions are.)

The durable fix is a compiler diagnostic: warn when an imported identifier is
read in a template, isn't in `externalSignals`, and isn't provably static. See
`mesa/EXTERNAL_REACTIVITY.md` for the full failure matrix and the options.

## 12. junction state is a plain object — the plain-object pilot

`src/junction/index.js`, `src/build/mesa-plugin.js`.

First module migrated off signals, per `mesa/PLAIN_OBJECT_STATE.md`. Chosen as
the pilot because it is the smallest — two fields — and had a real consumer.

```js
// before
export const connected = signal(false)
export const reconnecting = signal(null)
connected.set(true)                       // in the WS callback

// after
export const status = { connected: false, reconnecting: null }
const _status = watchProxy(status)        // the module's writer handle
_status.connected = true                  // notifies $: status.connected
```

Consumers opt in per file, and the reactivity is visible at the use site:

```svelte
import { status } from '@frontierjs/sierra/junction'
$: (status.connected, status.reconnecting)

<span class="status {status.connected ? 'on' : 'off'}">…</span>
```

**`sierra/junction` is now absent from `externalSignals`** — there is nothing for
the accessor rewrite to do. That is the point of the exercise: the compiler no
longer needs to know anything about this part of Sierra, so it cannot drift out
of sync with it. `test/external-signals.test.js` still passes because both
sides went empty together.

Verified end to end against the real runtime — module writes through its proxy,
component watches paths:

```
initial                    : ws offline
client.on("connect")       : ws connected
client.on("disconnect")    : ws offline
client.on("reconnecting")  : reconnecting… (2)
reconnected                : ws connected
```

### Note on the write side

`status.connected = true` from outside the module would update the object and
notify nobody — RULE 45. The module holds `_status = watchProxy(status)` and
writes through that. `watchProxy` is idempotent and cached per object, so it is
the same proxy instance every component's `$:` resolves to.

This is the one genuinely new discipline the plain-object model asks for, and it
is confined to the module that owns the state.

### Remaining signals

`theme` (1). The router migration follows below.

## 13. router state is one plain `page` object

`src/router/index.js`, `page-fields.js` (new), `internals.js`, both components,
`build/slot-rewrite.js`, `build/scanner-plugin.js`, `build/warnings.js`,
`build/mesa-plugin.js`.

Eight signals — `params`, `activeRoute`, `pendingRoute`, `meta`, `data`,
`loadError`, `pageSlots` and the old `page` descriptor — collapsed into one:

```js
export const page = {
  path: '/', params: {}, meta: {},
  route: null, pending: null, data: null, error: null, slots: {},
}
```

Frontmatter still spreads on top, so `{page.title}` works as before.
`PAGE_RESERVED` names the eight fields the router assigns afterwards, and the
scanner now warns when a route's frontmatter uses one — previously a route
declaring `data:` would have had it silently replaced by the loader result.

**`sierra/router` is gone from `externalSignals`**, as `sierra/junction` already
was. Only `theme` remains. The map the compiler uses to know about Sierra is
nearly empty, which is the point: nothing left to drift.

The commit block writes field by field rather than replacing the object, so a
component watching `page.params` doesn't re-render because `page.data` arrived.

### The write handle is resolved per write, not captured

`watchProxy` is a no-op without a DOM (RULE 19), so a handle taken at module
load in a non-browser environment stays the raw object **forever** — even after
the environment changes, which is exactly what `mesa-render` and the test suite
do via `setRenderEnvironment()`. The router therefore resolves it per write:

```js
const _w = () => watchProxy(page)
```

`watchProxy` caches per object, so this is a WeakMap hit. Found because a slot
test failed while the code looked correct.

### Build-time code must not import the client router

`PAGE_RESERVED` lives in `router/page-fields.js`, a dependency-free module,
because the scanner warning runs in Node while `vite.config.js` is loading.
Importing it from `router/index.js` pulled the Mesa runtime into config
resolution and failed the build with `Cannot find package '@frontierjs/mesa'`.

Same shape as the `theme/script.js` fix earlier in this file — that is twice now,
so it is a pattern rather than an accident. Anything the build pipeline needs
from a client module should be extracted to its own import-free file.

### The diagnostic paid for itself

Migrating the smoke test, the external-reactivity diagnostic caught three reads
I had missed:

```
'page.siteName' is read in the template but no '$: page.siteName' watch covers it
'page.title'    …
'page.path'     …
```

Frontmatter keys are easy to forget precisely because they don't look like state.

## 14. devtools bootstrap bypassed Vite's transform pipeline

`src/build/devtools-plugin.js`.

Reported from a running dev server:

```
Loading module from "http://localhost:3000/@frontierjs/sierra/devtools-module"
was blocked because of a disallowed MIME type ("").
```

`configureServer` served the bootstrap directly with `res.end()`. That skips
Vite's transform pipeline entirely, so the import inside it —

```js
import { initToolbar } from '/@frontierjs/sierra/devtools-module'
```

— was never rewritten. The browser requested that URL literally, a second
middleware passed it through with `next()`, Vite's SPA fallback answered with
`index.html`, and the browser refused to execute HTML as a module.

The plugin already had `resolveId` + `load` serving the same virtual module, so
the middleware was redundant as well as harmful. Removed; the bootstrap now goes
through the pipeline and its import resolves to a real path:

```
/@frontierjs/sierra/devtools-bootstrap → 200 text/javascript
  import { initToolbar } from "/@fs/…/src/devtools/index.js" → 200 text/javascript
```

Pre-existing — the raw `res.end()` and the URL import are both in the original
archive. It surfaced now because the fullstack smoke test is the first app to
run the dev server with devtools enabled.

**Covered by** `smoke-test-fullstack/web/verify-web.mjs`, which now asserts the
bootstrap is injected, serves JavaScript, has its import rewritten, and that the
module behind it loads.

## 15. Client model schemas are generated from the .lite file

`src/build/schema-plugin.js` (new), `src/junction/schema-registry.js` (new),
`src/virtual/virtual-sierra.js`, `src/build/index.js`, `src/junction/resource.js`.

A resource file used to restate its model's field shape so `make()` had
defaults:

```js
const schema = {
  properties: {
    name:   { type: 'string' },
    status: { type: 'string', default: 'new' },
    value:  { type: 'number', default: 0 },
  },
}
createResource('leads', schema, { idField: 'id' })
```

That duplicated `db/schema.lite`. Once Junction started deriving server
validation from the Litestone client's own `$schema`, the hand-written client
copy became the **only** place the two halves of an app could drift — and it
drifts silently, as wrong `make()` defaults rather than an error.

The build now reads the same `.lite` file, runs `generateJsonSchema`, and emits
a `registerSchemas()` call into `virtual:sierra`, which runs before any route
module is evaluated. Resources name a model:

```js
createResource('leads', { model: 'Lead', idField: 'id' })
```

Lookup accepts the model name, the Litestone accessor, or the conventional
plural service name, so `createResource('leads')` resolves `Lead` unaided.
Editing the `.lite` file in dev triggers a full reload — `make()` defaults are
read when a resource module is first evaluated, so an HMR update would not take.

Configured as `schema: './db/schema.lite'` in `sierra.config.js`; omit to
auto-detect, `false` to disable.

**New:** `test/schema-generation.test.js` — 14 tests.

### Two resolution traps, both previously hit in this file

**`createRequire().resolve()` cannot see Litestone.** Its exports map declares
only `import` and `types`, and require-resolution needs a `require` condition —
the same dead fallback found in `virtual-sierra.js` earlier in this document. The
plugin reads the package manifest and follows its exports map by hand instead.

**The package root pulls in `bun:sqlite`.** Importing `@frontierjs/litestone`
resolved fine and then threw `Only URLs with a scheme in: file, data, and node`
— this plugin runs wherever Vite runs, which is usually Node. The parser and
JSON-schema generator have no driver dependency, so they are imported by
subpath. **Litestone gained a `./jsonschema` export** for this; `./parser`
already existed.

The first failure presented as "could not be resolved" when the package had
resolved perfectly well and failed to *load*. The warning now says "could not be
loaded".

### Note on the test fixture

`generateSchemas` tests build their own temp root with a `node_modules` symlink
to Litestone, rather than linking it into `sierra/node_modules`. Sierra's own
tree must stay free of sibling packages or `frontier-resolution.test.js` stops
testing anything — the contamination lesson from §10 applies here too.

---

## 16. `config/vite.config.js` — the conventional layout could never build

*2026-08-03*

`virtual:sierra` emits a literal `import sierraConfig from '<path>'`, and that path
was derived by string-rewriting the resolved Vite config path:

```js
viteConfig.configFile?.replace(/vite\.config\.[jt]s$/, 'config/sierra.config.js')
```

That assumed `vite.config.js` sat at the Vite root. The FrontierJS layout puts
configuration in a dedicated `config/` folder, so the normal case —
`web/config/vite.config.js` beside `web/config/sierra.config.js` — derived
`web/config/config/sierra.config.js`, and every build failed with `Module not
found`. Reproduced against `example/` before the fix; it is a hard failure, not a
warning. The escape hatch (`_configPath`) existed, but nothing that scaffolds an
app set it — `fli project:new` writes exactly this layout and shipped broken.

`resolveSierraConfigPath()` now **looks instead of assuming**: beside the Vite
config, then `config/` beneath it, then `config/` under the Vite root, then the
root — trying `.js`, `.mjs` and `.ts` at each. Both layouts work, `_configPath`
still wins outright, and when nothing exists the fallback names the conventional
location rather than a doubled path nobody wrote.

`example/` now models the whole convention rather than describing it. It was flat —
`index.html`, `config/`, `public/` and `src/` at the package root beside `api/` and
`db/` — which read as if a Sierra app *were* the app. Those four moved under
`web/`, and `vite.config.js` moved into `web/config/`, so the tree is
`db/` + `api/` + `web/` with configuration in `config/`. The UI now finds the
schema the way a real app does, through `../db/schema.lite`, instead of through
the `db/schema.lite` branch that only worked because the tree was flat.

Verified after the move, not assumed: `bun run build` emits the same bundle and
post-build artifacts to `web/dist/client/`, the build resolves the schema at
`../db/schema.lite`, `virtual:sierra` imports `/config/sierra.config.js` with no
doubled segment, and a CDP pass signs in as admin, submits the generated form
(new row reads `42` and a `null` slug) and deletes it — the API agreeing the row
is gone — with 0 console errors.

`test/sierra-config-path.test.js` — 9 tests, including one asserting no resolution
ever contains `config/config`.

---

## 17. The example's sign-in failed silently when the API was down

*2026-08-03* — reported from a real run, not found by a test.

Console showed two of these and nothing else:

```
[Sierra] unhandledrejection … reason: SyntaxError
__x00__virtual:sierra:24
SyntaxError: JSON.parse: unexpected end of data at line 1 column 1
```

`virtual:sierra:24` is the dev overlay's `unhandledrejection` listener — the
reporter, not the cause, which is exactly why the trace was useless. The cause was
`signIn()` in `example/web/src/routes/_module.mesa` doing `await res.json()` with
no check on the response. `/login` is proxied to the API on :3500; with that
process not running, Vite answers **502 with an empty body**, and parsing it threw
inside a promise nobody awaited. Reproduced by stopping the API and clicking sign
in.

Now it checks `res.ok` first and shows `API not reachable on :3500 — run bun run
api` in the header. Verified both ways: API down → the message, no console error,
no rejection; API up → sign-in still returns level 5.

Two notes from the fix itself, both worth knowing:

- **`$:` is for fields of plain objects, not for locals.** Adding the new `let` to
  the `$:` tuple compiled cleanly and threw `$runtime.get(...) is not a function`
  on mount (Mesa RULE 43).
- **A dev-overlay report names the listener, not the throw.** When a
  `PromiseRejectionEvent` points at `virtual:sierra`, look at the exception's own
  stack — Chrome gives the real frame (`_module.mesa:39`), the overlay line never
  will.

---

## Not changed

Still-open findings from the audit, in rough priority order:

Nothing outstanding from the original audit.

Observations made while reading Junction that were **not** acted on, since they
are that package's concern rather than Sierra's:

- **`src/client/index.ts` has zero imports** and no Bun or Node built-ins — it is
  cleanly browser-safe. Worth keeping that way; it is what makes the client
  bundle small.

## A row created offline can be edited offline on a `@version` model (FJS-1299)

A held create now records the row it wrote in the resource's read cache, with `@version` at 1 — the value litestone stamps on every create. A later held patch of that id therefore carries the version, and on `@@sync(field)` the created data as its base, instead of going up with neither and being refused `400` on replay whether or not the create landed. Proved in `test/sync-policies.test.js` for `refuse` and `field`.
