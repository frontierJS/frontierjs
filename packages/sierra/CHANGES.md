# Changes — @frontierjs/sierra

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

## 2026-08-29 — `record()` takes options, and honours `detailQuery`

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
of them built and exited 0. What closes them is `tests/fixtures/layout-island/`
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
exactly once; every import after that resolves to a partially-initialised
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
found nothing. `example/site/`'s catalogue read *0 products, prerendered*.

The dev server is a Node process. So the loader runs there, at
`/__sierra/static-data` (`build/static-data-plugin.js`), and the browser gets
JSON. `example`'s catalogue now reads *12 products* in dev, and the page's own
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

`dev: { staticData: false }` is the way back to the old behaviour. Default true,
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
A failed TLA module re-imports as a partially-initialised namespace instead of
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

`tests/live-filter.test.js` keeps the SEAM, which is the half only this side can
answer, plus one line asserting the re-export IS the toolbelt function rather
than a copy made here to fix an import. Its 31 behavioural cases are in
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
view is what this screen READ; a draft is in neither. `tests/resource-record.test.js`
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
every product page missing: a catalogue invisible to the crawler it was
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
chunk per island and nothing else. So the theme module kept `normalise({})`:
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

All three survived because `tests/static-paths.test.js` restates what the plugin
does — scan, import, build the message by hand — so every assertion passed
against a function nothing called. `tests/scanner-plugin.test.js` calls
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
says `path: ['colour']`. `toFieldErrors` read the first only, so every entry
from the second fell to the form-level message — a banner, away from the box it
is about, with `<Form>` unable to mark it invalid.

That is the wrong half to lose. Litestone carries every rule a browser cannot
pre-check, because the check needs a query or a stored row: a value set, a
`@@transitions` move, a soft-deleted `@unique`. The rules sierra CAN check
itself are the ones that never reach this function.

`_fieldOf` reads `field` first, then `path` — joined when nested, since no form
field is named `address.city` and saying so beats reporting none. An empty path
stays a whole-payload failure. 5 cases in `tests/field-errors-writer.test.js`,
built against the real class rather than a literal.

Found in a real browser: `example` refusing a value-set save through
`resource.save()`, with the message arriving and the field gone.



## 2026-08-22 — a `@values` column renders from its set

1039 tests, 0 fail. 12 in `tests/value-sets.test.js`.

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

1026 tests, 0 fail. 21 new across `tests/label-field.test.js` and
`tests/resource-no-client.test.js`.

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
never initialises and the page is blank behind one MIME-type line.

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
no read answers is a rule a view can recognise. Nothing else was needed and that
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
place, so `_hooks` is reassigned. Toolbelt's licence is purity, and this was the
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

Two neighbours keep the word and are not a lapse. Junction's `/manifest` is a
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
(`tests/resource-directives.test.js`, was `resource-params.test.js`).

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
serves. A widget declares its tag, selector and shadow behaviour in
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

`tests/fixtures/widget-site/verify.mjs` is what found the first two: 21
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
time. 11 tests in `tests/page-query.test.js`; three in `navigation.test.js`
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
is the old behaviour exactly. 32 tests here, 8 in junction.

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

`tests/schema-generation.test.js` § *a schema that imports another file*, checked
against a negative control — including that an enum declared in the imported file
lands in `$defs` and resolves as a `$ref`, since a dangling one is a control with
no options.

## 2026-08-15 — one inflection module behind the registry and `createResource` (FJS-192)

Sierra held two of the five copies: `_pluralOf` in `schema-registry.js` and an
inline `endsWith('ies') ? … : endsWith('s')` in `createResource`. The inline one
was the weakest of the five — `statuses` singularised to `statuse`,
`modelNameFor` missed, and the resource degraded to a bare `make()` with a
console warning. Both call `@frontierjs/toolbelt/inflect` now.

**`createResource('people')` resolves `Person` without being told.** The
irregular table travels with the module, so the registry indexes `people`,
`children` and the rest, and `{ model: … }` is back to meaning what it says: a
service named for something other than its model, or a word no rule can reach
(`lenses`/`Lens`). `tests/resource-model-name.test.js` moved the irregulars into
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
wiring is the half that breaks quietly. `tests/hmr-boundary.test.js` boots a real
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
and the related model's own fields say which column a person recognises. That
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
workspace. Found by containerising basecamp, which is the first time anything
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
`tests/node-modules-allowance.test.js` now writes its ids the way an INSTALLED
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

`tests/node-modules-allowance.test.js` pins it by driving the real `transform`
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

`tests/external-signals.test.js` is gone with the map it guarded.
`tests/no-module-signals.test.js` replaces it with the stronger property, held in
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
made it the weaker half of what it was modelled on. Two changes.

**Directories are scanned recursively**, keyed on the basename. A component's
directory organises it; its name identifies it — the same split the repo already
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
everything after it. Both cases are pinned in `tests/warnings.test.js`.

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

Five tests in `tests/make-from-schema.test.js`, one of which pins the crux:
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

`tests/resource-transitions.test.js` builds its fixture by running litestone's
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

The working pattern is in `tests/fixtures/island-site/verify.mjs`: **scroll
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
so "no JS" cannot be honoured — while a `client:static` *parent* never mounts and
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

**New:** `tests/boot-guard-order.test.js` — 3 tests.

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
behaviour rather than emitting broken code.

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

`tests/build.test.js` gained two guards asserting the bridge is *not* emitted.

### ⚠ Behaviour change: `.subscribe()` coalesces

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

**New:** `tests/prefetch-dedupe.test.js` — 10 tests.

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

**New:** `tests/layout-loading.test.js` — 7 tests.

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
  WeakMap rather than a field on the node, because the tree is serialised into
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

**New:** `tests/match-semantics.test.js` — 20 tests locking the observable
behaviour so a future optimisation has something to fail against.
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

**New:** `tests/devtools-perf.test.js` — 13 tests covering ring semantics,
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

**New:** `tests/junction-boot.test.js` — 7 tests using fake timers, covering
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

**New:** `tests/frontier-resolution.test.js` — 11 tests over the export shapes
the four packages actually use.

### How this was missed

This was written up in the previous revision of this file as a known weakness
that "works today only because Vite's normal node_modules resolution picks it up
after Sierra's hook returns undefined." It was described as latent. It was not:
it fails outright under `bun link`.

The build passed locally only because, earlier in the same session, symlinks had
been added under `sierra/node_modules/@frontierjs/` for an unrelated probe. Those
made both the app build *and* `tests/junction-boot.test.js` pass for the wrong
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

**New:** `tests/external-signals.test.js` — 13 tests. Walks `src/` for
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
of sync with it. `tests/external-signals.test.js` still passes because both
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

**New:** `tests/schema-generation.test.js` — 14 tests.

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

`tests/sierra-config-path.test.js` — 9 tests, including one asserting no resolution
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
