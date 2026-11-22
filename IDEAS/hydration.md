---
id: hydration
status: proposed
dated: 2026-11-14
---

# Idea — Hydration, and what a server-only region is

**Status: PROPOSED. Q1–Q10 all ruled (§ 6); Phase 0 done 2026-11-17;
Phases 1–4 built 2026-11-20/21, uncommitted; every step closed.** Calls marked *(main)
unconfirmed* were made during the build-out the owner handed over, and wait
on the owner. This is the guiding paper for hydration and server components
in Mesa and Sierra. Hydration is the direction (`FJS-D2172`); VISION RULE 20
now names it as the planned replacement for islands-replace, and still says
nothing hydrates today.

The design sketch this paper builds on is `IDEAS/one-mental-model.md` § 5, *The
target set's missing member*. Read it there; it is not restated here.

---

## 1. Where it stands

Verified in code 2026-11-14.

- **A server render is HTML and nothing else** (`packages/mesa/docs/VISION.md`
  RULE 20). No reactive graph is serialized, and no client adopts server DOM.
- **Islands are replaced, not adopted.** Mesa writes comment markers around a
  `client:*` call site (`runtime-server.js`), and Sierra's
  `src/islands/loader.js` clears the range and runs a fresh `mount()` with the
  island's props and nothing else. Async data is the loader's to fetch again.
- **The anchors adoption would need are stripped.** The happy-dom path keeps
  them only under `keepAnchors` (`render.js`). The string mode (`target:
  'server'`, `FJS-D1634`), which is the default path (`FJS-D1648`), writes no
  anchors and refuses `keepAnchors` by name. So the path most pages render on
  cannot feed hydration today.
- **The runtime carries a reservation:** `pop()` in `runtime.js` is a no-op
  marked for SSR hydration.
- **Two source comments in `render.js` still say hydration lands in "v1.1".**
  No ruling puts it on a roadmap.

## 2. Why it comes up: correctness, not speed

`one-mental-model.md` § 5 weighs hydration as a render-performance win and
rates it off-balance for this repo. That holds for performance. The reason to
reopen it is **`FJS-4313`**: an island reads `$context` as `undefined`, and a
store shared by two islands starts from its client default while a neighbor
not yet mounted still shows the server's value. Since `FJS-4313` closed, the
`$context` half warns once per island and key; the store half is still
unreported, because nothing on the client can tell a module default from a
server value. It was
found against `ryansolid/solid-server-component-benchmarks`, whose `store-sc`
case shares a cart through context from one client root, a shape islands
cannot express.

The second cost is visible: a prerendered island re-renders on mount, and an
island over `{#await}` data fetches what the server already awaited
(`FJS-D1647`).

### Driven 2026-11-17 (0.1)

A static Sierra build (`target: 'static'`) of one route. The route provides
`$context.theme = 'dark'` and sets `cart.count = 3` on a module store. Under it
are `Reader` (`client:load`, reads the context), `CartA` (`client:load`) and
`CartB` (`client:visible`, inside a scroller); both carts write `$: cart`.
Vite split `cart.js` into one shared chunk. Observed in Chrome:

| Moment | `Reader` | `CartA` | `CartB` |
| --- | --- | --- | --- |
| Server HTML | `theme: dark` | `A: 3` | `B: 3` |
| After load | `theme: undefined`, one warning naming `<Reader>` and `$context.theme` | `A: 0` | `B: 3` (not mounted) |
| Click A | | `A: 1` | `B: 3` |
| B scrolled in and mounted | | `A: 1` | `B: 1` |
| Click B, then click A | | `A: 2`, then `A: 3` | `B: 2`, then `B: 3` |

- **Both halves reproduce.** The context reads `undefined`. The store starts
  from its client default, so `A: 1` and `B: 3` sit on one screen, and no
  message reports it.
- **Once both islands mount, the store is shared.** One module instance lives
  in one shared chunk, and a write in either island reaches the other. So the
  store defect is about the starting value, not about the islands being
  isolated from each other. Q4's store snapshot is the whole fix for it.
- **The `$context` half cannot be fixed by a payload.** The route that
  provides the value is not a component on the client at all. Only one tree
  (Q2) gives `Reader` an ancestor.

### Measured on `example/site/` 2026-11-17 (0.2)

A static build of `example/site/` into a scratch directory, served without
the API on 8110. Each island page was driven in Chrome, with the window
scrolled to the bottom so `client:visible` islands fire. A recorder injected
ahead of the page counted fetches, and the nodes each mount removed and
added, whole subtrees included.

| Page | Islands | Island JS, gzip | Nodes replaced | Calls on mount |
| --- | --- | --- | --- | --- |
| `/catalog/` | `CatalogList` load, `LiveStock` visible | 34.6 KB | 49 → 51 | 1 |
| `/pricing/` | `LivePlans` load | 33.0 KB | 6 → 7 | 1 |
| `/products/explorer-tee/` | `LivePrices` load, `BuyBox` load | 37.5 KB | 24 → 26 | 2, identical |
| `/account/` | `Account` load | 37.0 KB | 6 → 15 | 0 |
| `/cart/` | `Basket` load | 38.8 KB | 7 → 10 | 1 |

- **No call re-asks for what the server already awaited.** `LivePrices`,
  `LivePlans` and `LiveStock` exist to fetch numbers fresher than the build,
  and `Basket` reads a browser-held cart. No island on this site renders
  `{#await}` data. Q4's serialized values would save **zero** requests here.
  The refetch cost in § 2 is real for an `{#await}` island and absent from
  this app.
- **The product page's two identical POSTs are deliberate.** `BuyBox.mesa`
  says why: coupling the two islands would let a failed buy box stop a price
  correction. One tree would make deduping them possible, not required.
- **The re-render is small.** The largest is 49 nodes on `/catalog/`. The
  time to the last mutation was 60–375 ms and varied run to run. It includes
  each island's "could not reach the shop" update after the refused fetch, so
  it is not the re-render's cost and is not a baseline.
- **Most island bytes are shared, not per island.** The loader plus runtime
  chunk is 16.7 KB gzip and the Junction client 13.0 KB, on every island page.
  Each island's own chunk is 1.2–5.7 KB. Hydration adopts DOM rather than
  shrinking these. Only the per-edge form (Q2 C) cuts bytes, and only from the
  part that is per island.

On this app the case for hydration is the `FJS-4313` correctness half, not
cost. That matches § 2's framing.

## 3. "Server component" names two things

They need separate names, because one is inferred and the other is declared.

| | **Inert** region | **Server-only** region |
| --- | --- | --- |
| Means | ships no code because nothing in it reacts | must never ship, because it reads a secret or the database |
| Why it matters | bytes and hydration work | a credential in a browser bundle |
| Known from | the compiler's reactive-edge walk (`child()` / `sibling()`) | the import graph |
| Failure if wrong | wasted bytes | a silent leak |
| Paper | this one | `IDEAS/server-only-boundary.md` |

**The inert set is derived, never declared.** The compiler already knows every
node it will touch, so a keyword marking a region inert would be a second
origin for a fact the compiler holds. **The server-only set is declared, and it
uses `server-only-boundary.md`'s filename rule.** This paper adds no new
keyword for it.

## 4. Prior art

- **Astro islands** mount each island as its own root. To share state, Astro
  recommends a framework-agnostic store module such as nanostores
  ([docs](https://docs.astro.build/en/recipes/sharing-state-islands/)). That is
  where Mesa is today, with the same `FJS-4313` ceiling.
- **React Server Components** are one client tree, and server components are
  holes in it, serialized as a payload the client reconciles
  ([docs](https://react.dev/reference/rsc/server-components)). Context reaches
  every client component because there is one owner tree.
- **Svelte 5 and Solid** hydrate the whole app against markers the server
  writes ([Svelte `hydrate`](https://svelte.dev/docs/svelte/imperative-component-api#hydrate),
  [Solid `hydrate`](https://docs.solidjs.com/reference/rendering/hydrate)).
- **Qwik** resumes instead of hydrating: it serializes the reactive graph into
  the page and replays nothing
  ([docs](https://qwik.dev/docs/concepts/resumable/)).
- **Marko 6** compiles to fine-grained reactive edges and ships code only for
  them, which is closest to the per-edge form in `one-mental-model.md` § 5.

### Marker protocols, read 2026-11-17 (0.3)

Read from source at svelte@5.57.3, solid-js@1.9.19 with dom-expressions@0.40.14,
and @marko/runtime-tags@6.4.16. Every sample below is real server output from
one test component per framework: a static heading, two text bindings, an
`if` and a list.

| | Svelte 5 | Solid 1.9 | Marko 6 |
| --- | --- | --- | --- |
| Server writes | `<!--[-->` … `<!--]-->` per block, `<!--[N-->` for an `if` branch | `data-hk="00"` on each template root, `<!--$-->` … `<!--/-->` per insert slot | `<!--M_$1 #text/0-->` after each live node, keyed by scope and accessor |
| Client finds a node by | a cursor walking real siblings in compiled order | key for template roots, cursor inside a template | key: one TreeWalker pass, then `scope[accessor] = marker.previousSibling` |
| Adjacent text | merged, set as one string | kept apart by the slot comments | kept apart by a bare `<!>` |
| Static subtree | no marker, but the cursor still steps through it | no marker inside a template, a `data-hk` on its own root | nothing at all |
| State | none by default; experimental `hydratable(key, fn)` writes one devalue script | seroval script per resource, keyed by hydration id | one script of per-scope fields the client reads, handlers by module id |
| Mismatch | warn, then replace the whole root (`render.js`), or just the block for an `if`/`await` | dev throws; prod silently makes a fresh node | no check found |

Samples, trimmed:

```html
<!-- Svelte -->  <p>Hello 1 and 2</p> <!--[0--><b>yes</b><!--]-->
<!-- Solid -->   <p>Hello <!--$-->1<!--/--> and <!--$-->X<!--/--></p>
<!-- Marko -->   <p>Hello <!>1<!--M_$1 #text/0--> and <!>2<!--M_$1 #text/1--></p>
```

**Marko 6 is the shape `FJS-D2173` names:** one marker per live binding,
looked up by key, and nothing for an inert region. A cursor (Svelte) needs a
clean sibling count through every static region, which is the opposite of
shipping nothing for one. What Mesa would take from each:

- **From Marko:** a comment after each live node, keyed per binding. The key
  is the binding's source offset, not a variable name from the client's
  traversal, for the reason the Plan's preamble gives. Also `<!>` between adjacent text nodes, and a
  fresh `Text` where a text binding rendered empty. Nothing is written for a
  binding the client never re-evaluates.
- **From Svelte:** the state transport. `hydratable` writes one script with
  promise placeholders and a CSP nonce or hash, which is `FJS-D2175`'s
  settled values.
- **Whole page first fits the same markers.** One root walks every marker
  once and builds one owner tree. Narrowing to per-edge later filters that
  walk by region and adds no marker.

A keyed lookup makes a missing marker detectable per binding, which a cursor
cannot. That makes the replaced range a choice Q6 did not face: § 6 Q7.

### State and the flag, read 2026-11-19

Read for Q8–Q10, from docs and from source at svelte@5.58.0, solid-js@2.0.0,
nuxt@3.17.5, @marko/compiler@5.39.10 and vue@3.5.13.

- **Isolation is built into each framework's own state channel, and module
  state is covered by documentation alone.** SvelteKit tells authors not to
  keep request data in shared variables and to use context instead
  ([docs](https://svelte.dev/docs/kit/state-management)). Svelte 5's
  `hydratable()` scopes its values to the render with `AsyncLocalStorage` and
  throws outside one. Nuxt's `useState` lives on the per-request app, and a
  module-level `ref` is a documented leak
  ([docs](https://nuxt.com/docs/3.x/getting-started/state-management)).
  Pinia makes an instance per app. Angular warns that a `useValue` provider
  lasts across requests ([docs](https://angular.dev/guide/ssr)).
- **One framework detects a write.** solid-js@2.0.0 `dist/server.dev.js`
  warns `[SERVER_WRITE]` when any signal or store setter runs during a server
  render. The write has no effect there, and its diagnostics entry says it
  "will throw".
- **What gets serialized is mostly opt-in per key.** Nuxt serializes only
  `useState` and `useAsyncData` values, Svelte only `hydratable(key, fn)`, and
  Angular only explicit `StateKey`s. Pinia and Qwik serialize automatically.
  React's taint API inverts this: an author opts a value out, and the docs warn
  that a clone escapes it. No framework refuses by a schema field annotation,
  so refusing a store that holds a field like `@guarded` would be new.
- **The flag is spelled `hydratable` where it exists.** Solid's compiler takes
  `generate: 'dom' | 'ssr'` and `hydratable: boolean`, and Svelte 4 took
  `hydratable: true`. Svelte 5 removed the option ("Svelte components are
  always hydratable now") and chooses at the client entry, `hydrate()` beside
  `mount()`, as Vue's `createSSRApp` and Preact's `hydrate()` do. Marko 5 makes
  it an output target: `output: "hydrate"`.

**What this means here.** Sierra renders at build time only (`spa`, `static`,
`widget`), with pages one after another in one process (`prerender.js`). So a
leak is between pages, not between users, and `FJS-1659` already records the
shared module state as a hazard. More important, the route's own script runs
on the client under one tree. A store the route writes, such as `cart.count = 3`
in the 0.1 page, is written again in the browser, with no snapshot needed,
**provided the route's `load()` data is in the page**. That data is what
`FJS-081` already gate-checks as public, and Phase 2 had no step putting it
there. Step 2.5a now does.

## 5. The cheaper fix, priced first

Before hydration comes the option one level simpler: **keep islands-replace,
and serialize what an island needs into its marker payload.** That means the
`$context` values provided above it and the server value of each store it
reads.

- **What it fixes:** `$context` stops reading `undefined`, and a store starts
  from the server's value instead of the client default.
- **What it does not fix:** two islands each receive their own copy of a
  context value, so a write in one is not seen by the other unless the value
  is a module store both import. The re-render on mount and the refetch stay.
- **What it costs:** a serializer for context values (functions and signals
  are not data), and a second state transport that hydration would later
  replace.

## 6. Open questions

Every question is answered. The questions with their options and arguments
moved verbatim to `docs/plan-done.md` § IDEAS/hydration.md, and each ruling is
in `DECISIONS.md`:

| Q | Asked | Ruling |
| --- | --- | --- |
| Q1 | Does Mesa hydrate at all? | `FJS-D2172`: yes, as the direction |
| Q2 | At what granularity? | `FJS-D2173`: whole page first, per-edge as the target |
| Q3 | What do `client:*` directives become? | `FJS-D2174`: timing inside one tree |
| Q4 | How does server state reach the client? | `FJS-D2175`: settled values into the page |
| Q5 | Which server path writes the markers? | `FJS-D2176`: the string mode, behind a flag |
| Q6 | What does a mismatch do? | `FJS-D2177`: fail closed and replace |
| Q7 | How much does a mismatch replace? | `FJS-D2260`: the smallest enclosing block |
| Q8 | Do stores get their own snapshot? | `FJS-D2284`: no, re-derived from `load()` data |
| Q9 | What guards a store leaking between pages? | `FJS-D2285`: a carry-over warning |
| Q10 | What is the flag called? | `FJS-D2286`: `hydratable: true` |

## 7. What must stay true, and what proves it

- **Adopted DOM and the compiled walk agree.** No test asserts it yet. It
  needs a drive that renders on the server, adopts in Chrome, writes a signal,
  and checks the node it should have reached.
- **An inert region ships no code.** No test asserts it yet. It needs a check
  that diffs the compiler's live set against the bundle.
- **A server-only import fails the build.** No test asserts it yet;
  `server-only-boundary.md` owns it.

Until these exist, the answer to "what fails if this breaks" is **none**.

---

## Plan

Phases 1–4 build Q2 A, which is whole-page adoption behind the Q5 flag.
Narrowing to per-edge (Q2 C) and making the flag the default are written once
Phase 2's drive is green. Neither is ruled yet.

**The two walks the key must agree across.** The server's string mode is
written from the IR (`src/host/emit.js` over `src/ir.js`). The client's DOM
builder in `src/compiler.js` walks the AST itself and emits `child()` and
`sibling()` traversals, and `IDEAS/mesa-ir.md` does not move it onto the IR.
So a binding's key cannot be a counter local to either walk. It must be
something both already hold: the binding's source offset in the `.mesa` file.
Step 1.1 proves the two agree before anything is built on them.

### Phase 0 — Groundwork

Goal: the facts the questions turn on, measured rather than read.
Done when: `FJS-4313` is driven in a browser, the costs in § 2 are measured on
`example/site/`, and Q1–Q4 are ruled.

- [x] 0.1 Drive `FJS-4313`: a provider above an island and a store shared by
  two islands, both halves observed in Chrome — 2026-11-17, § 2 *Driven*. The
  fixture was a throwaway in a gitignored `.cache/` directory. Phase 2's drive
  (§ 7, first bullet) is this page with the assertions inverted.
- [x] 0.2 Measure today's cost on `example/site/`: re-render on mount, refetch
  count, island bytes — 2026-11-17, § 2 *Measured*: zero redundant refetches,
  re-render ≤ 49 nodes, and island bytes mostly shared runtime
- [x] 0.3 Read the marker protocols of Svelte 5, Solid and Marko 6 for one
  keyed by reactive edge — 2026-11-17, § 4 *Marker protocols*: Marko 6's
  keyed-per-binding shape fits
- [x] 0.4 Owner rules Q1–Q6 — ruled 2026-11-15, `FJS-D2172`–`FJS-D2177`
- [x] 0.5 Amend RULE 20 in mesa's `docs/VISION.md` to name hydration as the
  planned replacement for islands-replace (`FJS-D2172`) — 2026-11-14, one
  commit after the rulings

**Done 2026-11-17.** Both halves of `FJS-4313` reproduce in Chrome. Only one
tree fixes the `$context` half, and a store snapshot fixes the store half.
`example/site/` makes no redundant refetch, so the case there is correctness.
Marko 6's keyed-per-binding markers are the shape to borrow. Q7 followed from
the read (`FJS-D2260`).

### Phase 1 — Markers on the server

Goal: under the Q5 flag, the string mode writes a keyed marker for every live
binding and a boundary for every block, and default output does not change.
Done when: mesa's `bun run test` is green with a corpus test asserting the
server's key set equals the client's for every corpus file, the flagged output
parses (Invariant 15), and the unflagged output is byte-identical to before.

- [x] 1.1 The binding key: one exported function names a live binding by its
  source offset, and both `src/host/emit.js` and `src/compiler.js` call it.
  That makes it one owner (Invariant 4), not two walks reconciled. The IR
  carries only the formatted `loc` today, so it must expose the raw offset. A
  corpus test compiles every file both ways and asserts the two key sets are
  equal, including a snippet rendered twice in one instance. It lands before
  any marker is written. — 2026-11-20: `bindingKey`/`liveBinding` in
  `src/compiler.js`, liveness from the existing `writtenOnce`;
  `test/binding-keys.test.js` agrees on every corpus file. *(main)
  unconfirmed:* the key is base 36 of the offset; one key per Text run (a
  comment or snippet between texts joins them, `textRuns()` in `ir.js`); the
  `{#await}` pending branch records no key (`FJS-D1647`); one marker per live
  element, keyed by the element's start offset.
- [x] 1.2 The flag: a render option on `renderComponent` and `renderToHTML`,
  and its Sierra config key, named by Q10. A corpus test pins the unflagged output byte-identical. —
  2026-11-20: mesa half only; the Sierra key moves to 2.5. `bun run corpus --
  --diff` against a HEAD worktree: 1942/1942 identical, and the server path
  1942/1942. *(main) unconfirmed:* a flagged compile stamps the factory, and
  `renderToHTML({ hydratable: true })` refuses an unstamped one by name (a
  runtime `$$host.hydratable` check would have changed unflagged output).
- [x] 1.3 Binding markers: a comment after each live node, carrying the
  instance id and the binding key. Write `<!>` between adjacent text nodes, and
  an empty marker where a text binding rendered nothing, as Marko's `%` op
  does. A binding that reads no signal writes nothing. — 2026-11-20:
  `<!--m ID KEY-->`, `empty` for an empty run; every spelling lives in
  `runtime-server.js`; `test/hydration-markers.test.js` asserts on the parsed
  page. *(main) unconfirmed:* `<!>` goes after anything that could end in
  text.
- [x] 1.4 Instance ids, derived from structure: the parent's id, the call
  site's source offset, and the `{#each}` row key where there is one. A render
  order counter is the rejected form. One block that renders a different number
  of components would shift every later id, and `FJS-D2260`'s one-block
  replacement would cascade to the page. That happens on every phone visit
  with a viewport branch. The instance marker also carries the component's
  content-addressed scope id (Invariant 12). A page prerendered against an
  older bundle then fails closed under `FJS-D2177`, instead of matching an
  offset to a different binding. — 2026-11-20: `<!--i ID SCOPE-->`, root `0`,
  a call site `parent.<offset36>`, a row `parent[<key>]`. *(main)
  unconfirmed:* a `{@render}` call site is a call site, so a snippet rendered
  twice gets two ids and binding keys stay pure offsets; the id travels on
  `$$out.$$hid`, not a new argument.
- [x] 1.5 Block boundaries: `{#if}` writes its branch index, as Svelte's
  `<!--[N-->` does. `{#each}` writes a boundary per row with the row's key, and
  `{#await}` writes which state it settled in. These are the ranges `FJS-D2260`
  re-renders. — 2026-11-20: `<!--[ ID KEY N-->` … `<!--] ID KEY-->` (N = -1
  for no branch), `<!--r ROWID-->` per row, `then`/`catch` for an await.

**Built 2026-11-20.** Mesa's `bun run test` passed with 2810 tests. The
portability corpus showed 0 differences between the two paths, and unflagged
output is byte-identical to HEAD on both paths.

### Phase 2 — Adopt on the client

Goal: one client root adopts a flagged page, so `$context` and stores work
across what used to be island boundaries.
Done when: the 0.1 page, committed as a Sierra fixture with its assertions
inverted, passes in Chrome. That means `theme: dark` after adoption, both
carts showing the server's value, and a write reaching both. This is § 7's
first bullet.

- [x] 2.0 What Phase 1 left: an element the client reaches only by a handler,
  `bind:`, `{@attach}` or `bind:this` writes a marker under its element key,
  with key-set parity for those, for blocks and for instance call sites.
  *(main) unconfirmed:* a flagged `renderComponent` whose tree holds a file
  the string mode refuses is refused by name instead of falling back to
  happy-dom with no markers (`FJS-D2177`, fail closed). — 2026-11-20:
  `hydrationSite()` gives block and call-site parity in
  `test/binding-keys.test.js`; the refusal lives in `compileTreeOnTarget`.
- [x] 2.1 `hydrate(target, Component)` in `runtime.js`: one TreeWalker pass
  collects markers into an instance-to-key-to-node map, then the component
  runs once over it. `pop()`'s reservation is either used here or cut. —
  2026-11-20: `hydrate()` and `claim()` in `runtime.js`; the marker spelling
  has one owner, `src/hydration-protocol.js`, which the server writes and the
  client reads through. *(main) unconfirmed:* `pop()` stays a no-op, since
  cutting it moves all 1942 corpus outputs; a child's claim travels on the
  call-site anchor comment, because a module slot was cleared by a block
  adopted in between.
- [x] 2.2 The DOM builder, under the flag: a binding's node comes from the map
  by key instead of from a traversal, and `template()` clones nothing for an
  adopted region. The unflagged client output stays byte-identical. —
  2026-11-20: `_adoptRoots` in `compiler.js` rewrites the root and every
  `makeBlock` callback; only the hydrate fixtures move in the corpus diff.
  *(main) unconfirmed:* a text written once in a block body adopts onto a
  throwaway node, because the server already wrote its value (refusing it
  re-rendered every `{#await}`); an unkeyed root goes through `$$h.root()`,
  which refuses by name, never `null`.
- [x] 2.3 Blocks adopt their server branch by boundary: the `{#if}` index, the
  `{#each}` rows by key, and the `{#await}` state. — 2026-11-20: `hydIf`,
  `hydEach` and `hydAwait`; the browser drive proves the branch and row nodes
  are the server's. *(main) unconfirmed:* rows are compared as a whole id
  list, and any difference re-renders that `{#each}`; adopted nodes move
  through a fragment and back.
- [x] 2.4 Mismatch per `FJS-D2260`: a missing marker or a wrong branch
  re-renders the smallest enclosing block, falls back to the page, and names
  the binding in the dev overlay. A test forces each kind. — 2026-11-20:
  `test/hydrate.test.js` has a row for each kind; a stale scope id fails
  closed. Mesa has no dev overlay hook, so the warning is a dev-only
  `console.warn`.
- [x] 2.5 Sierra: a flagged static page hydrates from the route root instead
  of running the islands loader. Unflagged pages keep islands-replace. —
  2026-11-20: a top-level `hydratable` key in `build/index.js` reaches only
  the static server compile and the hydrate bundle, so the SPA and dev
  compiles are untouched. `mesa.hydratable`, and `hydratable` on a non-static
  target, are refused by name. One Vite build makes one entry per distinct
  `composeWrapper` output, and the island-site build is byte-identical to
  before. *(main) confirmed by the owner 2026-11-21 (`FJS-D2289`), over a comment range,
  SvelteKit's `app.html` and Astro's island style being the precedent:* the target is `<div data-sierra-root>`, made
  `display: contents` by a `<style id="sierra-root">` written only on
  flagged pages (no inline `style=`, because of CSP); a render or slot site is
  bounded by `<!--[ … ]-->` and its content adopted by site key, which is what
  makes a layout adopt.
- [x] 2.5a The route's `load()` data goes into the page, so the route component
  can run on the client. It is the data `FJS-081` already checks against each
  model's `@@gate`, so it adds no new path into public HTML. Found
  2026-11-19 (§ 4 *State and the flag*). — 2026-11-20:
  `<script type="application/json" data-sierra-data>`, written in `writePage`
  after the verdict, with `<` and U+2028/2029 escaped. *(main) unconfirmed:*
  `data` is stored once; the route travels as a `{ id, path, meta }` stub.
  *Owner ruled 2026-11-21, Dates only (`FJS-D2290`):* a Date travels as its ISO string with
  its key path (a list of keys) in a `datePaths` list beside `data`, `staticPage`
  and `state`, written only when the page holds one, and the client entry
  turns each back into a Date before the route runs; any other value that
  does not round-trip through JSON (a Map, a function, a cycle) is refused by
  key path. `test:hydrate` proves a `load()` Date reaches the route as a Date.
- [x] 2.6 The drive: the 0.1 page committed under `packages/sierra/test/fixtures/`
  with its assertions inverted, run by Sierra's `verify` path. — 2026-11-20:
  `packages/sierra/test/fixtures/hydrate-site/`, run by `bun run
  test:hydrate`. All 11 checks pass in Chrome, through a `_module.mesa`
  layout: `theme: dark`, both carts at 3, writes reaching both ways, the
  server's nodes kept, and no console warning.

**Built 2026-11-20.** Mesa's `bun run test` passed with 2828 tests and
Sierra's with 2553. `FJS-4515` counts the corpus blocks that still re-render
rather than adopt (a ratchet at 76), and `FJS-4516` is a layout gap found on
the way, not specific to hydration. A `client:*` directive inside a flagged
tree is stripped and hydrates eagerly, which is Phase 4's to fix.

### Phase 3 — Server state into the page

Goal: what the server already settled reaches the client without a second
fetch (`FJS-D2175`, with stores re-derived rather than snapshotted per
`FJS-D2284`).
Done when: a flagged page with an `{#await}` region makes no request for that
value on load, and a store the route writes from `load()` data shows the
server's value in both components before either is written.

- [x] 3.1 Settled `{#await}` and `$async` values go into the page's one
  `<script type="application/json" data-sierra-data>` block beside 2.5a's
  `load()` data, keyed by instance id and binding key (an `$async` const's key
  carries a `$` prefix so it cannot meet an `{#await}` key). A JSON block is
  never executed, so it needs no CSP nonce or hash. A value that does not
  serialize is refused by key path. An adopted `{#await}` tracks a dependency
  thunk of the expression's reads, so `load(id)` loads once more when `id`
  changes; a read it cannot separate from a call falls back to evaluating,
  with a dev warning. Done 2026-11-20. *(main) unconfirmed:* the JSON block
  rather than a trailing script; an `$async` with `[]` deps is not seeded.
  Under the flag a `<mesa:boundary>` is a keyed block: the server waits on its
  states and brackets the branch it wrote, and `hydBoundary` adopts the
  content (`FJS-4517`, closed 2026-11-22).
- [~] 3.2 Store snapshots — dropped: `FJS-D2284` (Q8 A). The client re-runs
  the route over 2.5a's `load()` data, and a store it cannot re-derive is a
  mismatch handled by `FJS-D2260`.
- [x] 3.3 The drive gains the `{#await}` case, counting requests the way 0.2
  did, and a store the route writes from `load()` data, read by two components.
  Done 2026-11-20: `test:hydrate` asserts no request for the `{#await}` value
  on load. Leak check: `FJS-081`'s read recorder already grades `{#await}`
  reads, and a flagged page carrying state with no db wired is refused as
  unobservable -- the rule an unflagged page that reads data already meets,
  so not a new call.
- [x] 3.4 Carry-over warning (`FJS-D2285`, Q9 B): in a flagged render, a
  watched module store that starts a page holding a value an earlier page
  wrote is warned about, naming the store and both pages. A test renders two
  pages in one process to force it. Done 2026-11-20: `$$host.store` snapshots
  each store at page start, `watched()` warns once per page, and Sierra names
  pages by URL path. *(main) unconfirmed:* a build `console.warn`, not a
  failure; a store `JSON.stringify` refuses is never reported.

**Built 2026-11-20.** Mesa's `bun run test` passed with 2838 tests and
Sierra's with 2558, `test:hydrate` and island-site both green, and the corpus
moved only hydrate fixtures.

### Phase 4 — `client:*` as timing

Goal: inside the one tree, a `client:*` subtree attaches its bindings on its
trigger (`FJS-D2174`).
Done when: island-site's directive assertions (idle, visible, media, a
never-matching query fetches nothing) pass on a flagged build.

- [x] 4.1 A `client:*` subtree is adopted for structure on page load, and its
  bindings and handlers attach when its trigger fires. Done 2026-11-21:
  `hydIsland` keeps the server nodes, holds the parent's pushes and binds
  (`islandPush`/`islandBind`, so unflagged bundles carry none of it) and
  attaches on the trigger; the server bounds a flagged `client:*` site with
  `[`/`]` so a mismatch at attach re-renders that range (`FJS-D2260`).
  *(main) unconfirmed:* `schedule` moved into Mesa's runtime as its one
  owner, Sierra re-exports it; a nested `client:*` keeps its own trigger;
  `client:static` adopts and never attaches; a fresh render (nothing to
  adopt) loads at once. Found: `FJS-4518` (`bind:this` on a deferred child
  is empty), and a missing `m` marker inside a deferred subtree goes
  undetected.
- [x] 4.2 A chunk is still fetched only on its trigger, so island-site's
  resource-timing assertions still hold. Done 2026-11-21: the compiler splits
  a `client:*` import into `() => import()` when nothing else names it, and
  island-site passes flagged (`vite.hydrate.config.js`, `verify.mjs
  --hydratable`) and unflagged. *(main) unconfirmed:* the flagged probe
  stands `requestIdleCallback` in with `setTimeout`, since headless Chrome
  gave no idle periods after load; product timing is unchanged.
- [x] 4.3 The islands guide and `STATIC_RENDERING.md` § Status describe the
  flagged path, and RULE 20 says what it covers. Done 2026-11-21, both
  guides (mesa and sierra).

**Built 2026-11-21.** Mesa's `bun run test` passed with 2845 tests and
Sierra's with 2558 (byte gate lower), corpus moved only hydrate fixtures,
portability 0 differ, island-site flagged and unflagged green.
