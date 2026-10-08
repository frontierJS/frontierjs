---
id: sierra-scope
status: proposed
dated: 2026-10-08
---

# Idea — Sierra's edge: what it owns, and what it hosts as a battery

**Status: PROPOSED — RULED 2026-10-08, PARTLY BUILT.** Dated 2026-10-08; every
count in § 1–2 was measured on the working tree that day, with a path named. All
five questions are ruled (`FJS-D649` to `FJS-D653`), each as recommended, and
§ 3 is the build. Items 1, 3 and 4 are built (sierra `CHANGES.md`, 2026-10-08);
2, 5 and 6 are not. It is
[`litestone-scope.md`](litestone-scope.md) and [`junction-scope.md`](junction-scope.md)
asked of the UI realm, and the answer is shaped differently: sierra hosts few
batteries and they are small. **Its finding is that the realm's own noun lives
in a directory named for another package**, and that two of its axes import
each other.

## The question this answers

*What may sierra grow into, so that "done" is a state the package can reach?*

A page of one application, in a browser, has three axes, and each has a known
end in the prior art:

- **Navigation**: which screen an address names and how a person moves between
  them — the scanner, the route table, the router, guards, `page.*`, prefetch,
  scroll, and the `fetch` a `load()` is handed (file-system routing as Next,
  SvelteKit and Remix have it).
- **Build**: what a surface becomes on disk — the Vite config, the Mesa plugin,
  the `@` alias, the targets, the prerender and its publish proof, islands, the
  widget runtime, and what a build writes after itself (Vite's plugin model;
  Astro's islands).
- **Resource**: how a screen binds to a service — `createResource`, the field
  rules, the schema registry, the session, the list, the live store, and the
  offline pieces `FJS-D297` gives sierra (TanStack Query, Ember Data, Relay;
  Replicache for the queue).

The axis is *Navigation*, not *Route*, because `ARCHITECT.md` § 2 rules
**Route** as a handler outside junction's pipeline.

What hosts the three is `createSierraViteConfig` at build time and
`virtual:sierra`'s boot at run time. The theme switch is held by ruling rather
than by axis (`FJS-D453`: css owns the vocabulary, sierra owns the switch), as
`FJS-D640` holds junction's scheduler.

A feature on one of the three is sierra's. A feature on none of them answers a
different question.

## 1. What is in `src/`

22,571 lines in all.

| Directory | Lines | Axis | Outside files naming the subpath (not sierra) |
| --- | --- | --- | --- |
| `junction/` | 8,385 | **Resource** — `resource.js` 2,924, `field-rules.js` 2,204 | `./junction`: 145 — example 73, basecamp 52, orion 9, cli 4, jetty 4, notifications 1, ui 1 |
| `build/` | 6,662 | Build | `./build`: 10 — cli 4, example 3, basecamp, jetty, website |
| `router/` | 2,419 | Navigation | `./router`: 72 — basecamp 38, example 20, orion 6, cli 4, website |
| `postbuild/` | 1,516 | Build (§ 2.5 splits it) | none by import; run from the Vite build |
| `scanner/` | 1,299 | Navigation | none; reached through `build/` |
| `devtools/` + `build/devtools-plugin.js` | 840 + 85 | **none** | `devtools:` in one config — example's `web/` |
| `widget/` | 403 + 168 | Build (the runtime) + **none** (`serve.js`) | `./widget/serve`: cli, example |
| `virtual/` | 470 | the host | none; it is the boot |
| `tools/` | 413 | Build — the `sierra` bin | `sierra widgets` in fli's generated Dockerfile; example's `package.json` |
| `islands/` | 357 | Build | none; reached through the island bundle |
| `serve/` + `site/` | 318 + 198 | **none** — a surface's origin | `./site/serve`: 8 — example 5, website 2 (site-kit's bin), cli |
| `theme/` | 306 | the host, by ruling | `./theme`: 3 |
| `presence/` | 251 | **none** — Announcement's browser half | one app: `fjs-prototypes/notion`'s `Roster.mesa` |
| `fetch/` | 202 | Navigation | none; the router and `virtual:sierra` |
| `analytics/` | 160 | **none** — a vendor's script tag | **0 of the 25 `sierra.config.js` files** in this repo and `fjs-prototypes` |
| `components/` | 113 | Navigation | none; reached through codegen |

Mesa's three hits on `./router` are comments in `render-component.js`, and
jetty's four on `./junction` are comments naming the file jetty FORKED (§ 2.7);
neither is an import. **The dependency direction is clean**: nothing in sierra imports orion
(the one hit is an error string in `scanner/walk.js`), and no package below
sierra imports it.

What the table shows:

- **The batteries are about 2,800 lines**, the static origins included, against
  junction's 8,381. Sierra has not grown by hosting whatever an app needed next.
- **The largest axis is the one with no name of its own.** Resource is 37% of
  `src/`, and the directory, the subpath and every one of 145 callers spell it
  `junction`.
- **The Resource has a second implementation.** Jetty carries its own
  `createResource`, 945 lines under `packages/jetty/src/resources/`, ported
  from sierra's and already drifted into a defect (§ 2.7).
- **One battery is ruled to gain a consumer.** `FJS-D608` wires
  `sierra/analytics` into site-kit, so its zero users is a ruled consumer that
  has not landed, not an abandoned module.

## 2. The tangled ones

**2.1 — The Resource lives under the API realm's package name.** `ARCHITECT.md`
§ 1 names three nouns, one per realm, and the UI's is **Resource**. In sierra
it is `src/junction/`, reached as `@frontierjs/sierra/junction`, and every
`createResource` in the tree is imported through that spelling. A reader who
knows the triad looks for `resource/` and finds the API realm's package name
instead. `FJS-D297` has already ruled that the offline pieces are not a package of
their own: the queue and its replay are sierra's, because nothing heading for
the default is severable. That argument was about offline. Whether the
Resource as a whole is a package is a different question, and it is Q2's.

**2.2 — Resource imports Navigation.** `junction/index.js` imports
`beforeNavigate`, `goto` and `invalidatePrefetch`; `junction/list.js` imports
`page` and `goto`, because a list answers only while its route is on screen.
Navigation does not import Resource: `router/` reaches `fetch/`, which imports
toolbelt alone, and `virtual:sierra` configures the token on it at boot. The
direction is one way, and nothing states it, so the next import can make it
two.

**2.3 — The field rules have no subpath.** `field-rules.js` (2,204 lines,
importing no client) is the Schema → UI projection: `controlFor`,
`formFieldList` and `buildFieldRules` in the bridge index. Build reads it
(`static-safety.js`, `schema-plugin.js` through the registry), and ui's browser
fixtures import it as `@frontierjs/sierra/field-rules`, a path `exports` does
not name. `packages/ui/test/browser/server.mjs:109` maps it by hand. The
README's claim that ui *reaches it through the resource rather than importing
sierra* holds for ui's runtime and not for its tests.

**2.4 — Two copies of "is this file inside the root".** Sierra's
`serve/served-path.js:69` and junction's `transport/static.ts:293` are the same
line (`path === dir || path.startsWith(dir + sep)`), and each found the
symlink-out-of-root hole by itself — sierra's layout map records its own two
copies having *a hole in each* before `serve/` existed. Neither can import the
other: junction may not import sierra (Invariant 1), and sierra's static
servers run with no junction. Outpost's `static.js` validates paths in an
upload, which is a neighboring question rather than a third copy. Toolbelt
cannot hold `realpath`, since it imports no `node:` module.

**2.5 — The main entry mixes the build with the browser.** `src/index.js`
re-exports the router and the theme beside `createSierraViteConfig`, so one
entry names both Node build code and browser runtime code. It is the same item
`FJS-D635` and `FJS-D639` fixed by moving batteries to subpaths. The website's
samples write `import { createResource } from '@frontierjs/sierra'`
(`website/site/content/routes/pitch.meta.js:55`, four times in
`content/data/showroom2.js`), which the entry has never exported (`FJS-2023`).

**2.6 — Postbuild is two things.** Half of it is what a build owes its own
output, derived from the route table or the build's hashes: the 404 move,
`_redirects`, the theme script, the manifest grade, the offline shell. The
other half is a site's: `sitemap`, `llms.txt`, markdown pages, speculation
rules, deferred scripts and robots. `FJS-D608` already rules how the second
half grows — *a Sierra owner is earned by a second consumer*, and a new site
gap starts as site-kit code — so this half needs no new ruling, only the edge
test's classification.

**2.7 — Jetty forked the Resource.** `packages/jetty/src/resources/store.js`
says *Ported from `@frontierjs/sierra/junction/resource.js`'s createStore
(Sierra v0.1.0)*, and `resource.js` says its API *mirrors sierra's exactly*.
The transport differs (`harbor.request('service:call', …)` in place of
`client.service(name)`), and so does the push wiring. The rest is a copy, and it
has drifted in both directions. `ResourceHookError` was carried across. The
patch baseline was not (`FJS-809`): jetty's `upsert` sends the whole record as a
patch (`resource.js:335`), so a column the screen never showed overwrites a
concurrent write — the lost update sierra closed (`FJS-2024`). By the rule
`IDEAS/overview.md` 5.11 set for shared code, *extract when two copies drifting
would be a defect*, this pair has already drifted into one. The fork exists because sierra's Resource
reaches its transport through `getClient()` and, through `list.js` and
`index.js`, the router (§ 2.2), so jetty could not take it whole.
`IDEAS/overview.md` 5.5 (*jetty becomes `extension`; de-forks the hand-copies*)
is the roadmap row that names the work.

## 3. What the recommendations below would build

Items 1, 3, 4 and 6 are about a day. Item 2 is a mechanical sweep, and item 5
is its own piece of work:

1. **The edge test** — `packages/sierra/test/edge.test.js`, junction's shape.
   Every directory under `src/` is classified (Navigation, Build, Resource, the
   host, or a battery). No axis file imports a battery. Resource may import
   Navigation and the reverse fails. The main entry re-exports no battery and
   nothing from `build/`. Every battery has a subpath. **Built.** § 1 was wrong
   on one file: `build/index.js` imported `build/devtools-plugin.js`, so a
   battery was inside the Build axis. The plugin moved to `devtools/plugin.js`
   and the install is the test's one allow row, because `devtools:` is a key
   in the config the build reads.
2. **The rename** (Q2) — `src/junction/` → `src/resource/` and
   `./junction` → `./resource`, every caller moving in the same change: 145
   files across example, basecamp, orion, cli's scaffolds, jetty,
   notifications and ui, plus `virtual-sierra.js`'s codegen strings and the
   docs. **Built.** `virtual-sierra.js` also held a hand copy of `exports`,
   twice, which had already drifted (`router` named `index.js` where
   `exports` names `entry.js`); it now reads `exports`.
3. **`./field-rules`** (Q4 **A**) — added to `exports`; ui's test server loses
   its hand mapping. **Built** — the map reads the path from sierra's
   `exports`.
4. **The main entry** — the router and the theme only. `createSierraViteConfig`
   is `./build`'s. **Built**; `VERSION` went with it.
5. **Jetty de-forked** (Q2 **B**) — jetty hands sierra's Resource a
   client-shaped object over its relay and deletes `store.js` and
   `resource.js`. Its own work, after the rename, and measured by jetty's
   bundle with the router in it.
6. **Path vectors** (Q5 **C**) — one vector set for *which file does this URL
   name, and is it inside the root*, read by sierra's and junction's tests.

## Open questions

- ~~**What is sierra's edge?**~~ **Answered 2026-10-08 (`FJS-D649`): A — The batteries stay in sierra behind a seam, as `FJS-D635` and `FJS-D639` ruled. Nothing in an axis directory imports one, a test fails if anything does, and every battery is reached by its subpath. A new `sierra.config.js` key, `page.` field, subpath or `src/` directory names its axis, or it is a battery.**
  Sierra owns what is true about a page of one application in a browser: which
  screen an address names, what a surface becomes on disk, and how a screen
  binds to a service. Analytics tags, presence, devtools, a surface's static
  origin and a site's postbuild extras are batteries.
  - **A** — The batteries stay in sierra behind a seam, as `FJS-D635` and
    `FJS-D639` ruled. Nothing in an axis directory imports one, a test fails
    if anything does, and every battery is reached by its subpath. A new
    `sierra.config.js` key, `page.` field, subpath or `src/` directory names
    its axis, or it is a battery.
  - **B** — Each battery moves to its own package.
  - **C** — Admit them and widen the edge to name them.
  - **Recommend A** — § 1 measured every battery as already outside the
    axes. A costs one test and one entry trim, and B stays open with nothing
    to untangle first. C is what makes "done" unreachable.
- ~~**Where does the Resource live, and what is it called?**~~ **Answered 2026-10-08 (`FJS-D650`): B — A, and then jetty de-forks onto it: jetty registers a client-shaped object over its relay, the way `connectApp()` already makes a Resource over another app, and its `store.js` and `resource.js` go.**
  § 2.1 and § 2.7: the UI realm's noun, 37% of sierra, spelled `junction`
  everywhere, and forked once.
  - **A** — Rename in place: `src/resource/`, `@frontierjs/sierra/resource`,
    every caller in the same change, nothing kept for the old spelling. Jetty's
    fork stays.
  - **B** — A, and then jetty de-forks onto it: jetty registers a
    client-shaped object over its relay, the way `connectApp()` already makes a
    Resource over another app, and its `store.js` and `resource.js` go.
  - **C** — Its own package, `@frontierjs/resource`, above junction, which
    sierra and jetty both peer. It extracts the Resource, not offline alone,
    so `FJS-D297`'s objection to *a package spanning realms* does not apply.
    It has to cut § 2.2's import of the router first, and it adds a package.
  - **D** — Leave it.
  - **Recommend B** — the rename is a mechanical sweep, and the fork has
    already cost a lost-update defect, which is the drift the second copy was
    always going to produce. B reaches one implementation without a new
    package, and the cost it has to measure is the router riding into jetty's
    bundle. If that cost is real, C is the next move, with nothing to undo.
    D fails *one name* (§ II) every time a reader looks for the Resource, and
    *one owner* every time sierra's copy is fixed and jetty's is not.
- ~~**Which way may Navigation and Resource import?**~~ **Answered 2026-10-08 (`FJS-D651`): B — State it. Resource may import Navigation and never the reverse, and the edge test holds the direction.**
  § 2.2: Resource → Navigation today, three names, never stated.
  - **A** — Cut it. The list's route binding and the prefetch invalidation
    are handed in at boot, and the two axes are independent.
  - **B** — State it. Resource may import Navigation and never the reverse,
    and the edge test holds the direction.
  - **Recommend B** — a list answering only while its route is on screen
    *is* a Navigation fact, and cutting it adds a seam before anything has
    measured a cost, the reason `FJS-D640` refused its **C**. Jetty under Q2's
    **B** is the measurement: if the router is weight jetty cannot carry,
    **A** is owed, and Q2's **C** needs it anyway.
- ~~**Who owns the field rules' import path?**~~ **Answered 2026-10-08 (`FJS-D652`): A — `@frontierjs/sierra/field-rules`, the path ui's fixtures already write, added to `exports`.**
  § 2.3: a 2,204-line leaf read by Build and by ui, with no subpath.
  - **A** — `@frontierjs/sierra/field-rules`, the path ui's fixtures already
    write, added to `exports`.
  - **B** — Toolbelt.
  - **Recommend A** — the leaf is already a leaf, and A makes the path that is
    already written a real one. B misreads toolbelt's license: `FJS-D26`
    admits *facts with many possible answers that must have one*, and the field
    rules are a projection of one schema, not a shared fact.
- ~~**What owns *is this file inside the root*?**~~ **Answered 2026-10-08 (`FJS-D653`): C — Keep both copies, with one vector set of URLs and verdicts that both packages' tests read (`FJS-D631`'s *vectors*).**
  § 2.4: two copies, each of which found the same hole alone.
  - **A** — A toolbelt subpath for the string half (decode, refuse `..` and
    NUL, the prefix test), with `realpath` left to each caller.
  - **B** — Sierra's static origins move to outpost or cli, the Release side,
    and the copy count stays two.
  - **C** — Keep both copies, with one vector set of URLs and verdicts that
    both packages' tests read (`FJS-D631`'s *vectors*).
  - **Recommend C** — the two copies drifted on cases, not on code, and a
    vector set is the one origin for the cases without an import that
    Invariant 1 or toolbelt's no-`node:` rule would refuse. A is worth it
    only if a third server appears. B relocates the copy without removing it.

## The nine, for the edge

1. **Origin.** One sentence, in one ruling. The edge test's classification is
   the same ruling read by a machine. Q5's vectors are one origin for the
   containment cases.
2. **Concept.** No new noun. *Resource* is `ARCHITECT.md` § 1's, *battery* is
   ordinary English (`FJS-D394`), and *Navigation* and *Build* name axes in
   plain words rather than coining terms. Navigation sidesteps Route, which is
   ruled.
3. **Complexity.** The problem's own: a UI meta-framework accretes what a
   screen needed next, and the adjudication is *batteries vs. smallness*. The
   rename is *preservation vs. evolution*: nobody outside this repo depends on
   `./junction`.
4. **Predictability.** Better. The triad's third noun is findable by its name,
   behaves the same in an extension as in a page once the fork is gone, and a
   feature's home is decided by one question.
5. **Derived.** The edge test reads the tree, not a list. The postbuild split
   derives from `FJS-D608` rather than restating it.
6. **Owner.** § IV already owns the rule and this applies it. The field rules
   and the theme switch keep the owners the bridge index names. Jetty's
   Resource is a second implementation beside the owner, and Q2's **B**
   removes it. Q5 is the one
   place two owners stand side by side, and Invariant 1 forbids collapsing
   them, so the vectors are the owner of the cases.
7. **Boundary.** Subpaths make the edge visible to a caller, and the main
   entry stops naming the build.
8. **Failure.** A wrong-way import fails the suite: it is a structural change,
   never an accident worth a warning. A renamed subpath fails at resolve,
   naming the path, which is the pre-alpha rate.
9. **Silence.** What must stay true: no axis imports a battery, Navigation
   imports no Resource, and the main entry names no build code.
   `test/edge.test.js` grades all three. The containment cases are graded by
   the vectors once they exist; until then also `none`, and the two copies can
   drift unseen.

**Tier:** Assessment until ruled; each ruling is Register. The sentence that
states the edge belongs in `packages/sierra/CLAUDE.md`, as junction's does.
