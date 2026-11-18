---
id: hydration
status: proposed
dated: 2026-11-14
---

# Idea — Hydration, and what a server-only region is

**Status: PROPOSED. Q1–Q6 ruled 2026-11-15 (`FJS-D2172`–`FJS-D2177`); nothing
built; Phase 0 done 2026-11-17; Phase 1 is not yet written.** This is the guiding paper for hydration and server components
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

- **From Marko:** a comment after each live node, keyed by the compiler's own
  per-binding name, which Mesa already has because it emits `child()` and
  `sibling()` per binding. Also `<!>` between adjacent text nodes, and a
  fresh `Text` where a text binding rendered empty. Nothing is written for a
  binding the client never re-evaluates.
- **From Svelte:** the state transport. `hydratable` writes one script with
  promise placeholders and a CSP nonce or hash, which is `FJS-D2175`'s
  settled values.
- **Whole page first fits the same markers.** One root walks every marker
  once and builds one owner tree. Narrowing to per-edge later filters that
  walk by region and adds no marker.

A keyed lookup makes a missing marker detectable per binding, which a cursor
cannot. That raises a question `FJS-D2177` settled at root level: whether a
mismatch replaces the whole page, which is the one root under Q2 A, or only
the block holding the missing binding, as Svelte does for an `if` or `await`.
This is flagged for the owner, not decided here.

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

- ~~**Q1 — Does Mesa hydrate at all?**~~ **Answered 2026-11-15 (`FJS-D2172`): B — Yes, as the direction. Amend RULE 20 now to say hydration is the planned replacement for islands-replace, and build it in phases. - **Recommend B as the direction, with A's guide note kept until Phase 2 lands.** Building § 5 means building a state transport that B then throws away. The guide note already covers the common case.**
  - **A** — No. Keep RULE 20. Fix `FJS-4313` with § 5's payload, and document
    "pass what an island needs as props".
  - **B** — Yes, as the direction. Amend RULE 20 now to say hydration is the
    planned replacement for islands-replace, and build it in phases.
  - **Recommend B as the direction, with A's guide note kept until Phase 2
    lands.** Building § 5 means building a state transport that B then throws
    away. The guide note already covers the common case.
- ~~**Q2 — At what granularity does the client adopt?**~~ **Answered 2026-11-15 (`FJS-D2173`): A first, with C as the design target.**
  - **A** — Whole page: one client root adopts the server's DOM.
  - **B** — Per component.
  - **C** — Per reactive edge: attach each binding to its node and ship
    nothing for the rest.
  - **Recommend A first, with C as the design target.** A is the order
    `one-mental-model.md` § 5 already wrote, and it is what gives one owner
    tree, which fixes `$context`. Key the marker protocol by reactive edge from
    the start, so C is a narrowing of A rather than a new protocol. Skip B,
    because it adds a noun and forecloses C.
- ~~**Q3 — What do `client:*` directives become?**~~ **Answered 2026-11-15 (`FJS-D2174`): B — They stay as timing: inside the one tree, a subtree's bindings attach on `idle`, `visible` or `media`.**
  - **A** — They are cut once hydration lands.
  - **B** — They stay as timing: inside the one tree, a subtree's bindings
    attach on `idle`, `visible` or `media`.
  - **Recommend B.** The timing is the part authors chose on purpose. The
    "own root per island" part is what goes.
- ~~**Q4 — How does server state reach the client?**~~ **Answered 2026-11-15 (`FJS-D2175`): B — Serialize settled `{#await}` and `$async` values and store snapshots into the page.**
  - **A** — Refetch, as today.
  - **B** — Serialize settled `{#await}` and `$async` values and store
    snapshots into the page.
  - **C** — Serialize the reactive graph, as Qwik does.
  - **Recommend B.** The server already awaits every `{#await}`
    (`FJS-D1647`), so the value exists. It is the same value the loader would
    fetch, so it is not a second origin. C adds a serializer for closures that
    nothing else needs.
- ~~**Q5 — Which server path writes the anchors?**~~ **Answered 2026-11-15 (`FJS-D2176`): A — The string mode (`FJS-D1634`) writes them, behind a flag, so default output stays byte-identical.**
  - **A** — The string mode (`FJS-D1634`) writes them, behind a flag, so
    default output stays byte-identical.
  - **B** — A second anchor-writing emitter beside the string mode.
  - **Recommend A** — a second emitter beside `FJS-D1634`'s would break
    Invariant 4.
- ~~**Q6 — What happens when the DOM and the compiled walk disagree?**~~ **Answered 2026-11-15 (`FJS-D2177`): A — Fail closed: abort adoption for that root, replace as today, and report it through the dev overlay.**
  - **A** — Fail closed: abort adoption for that root, replace as today, and
    report it through the dev overlay.
  - **B** — Adopt what matches and bind the rest by best guess.
  - **Recommend A** — binding to the wrong node is silent and costly, so the
    code must never guess.

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

Phases past 0 are written once Q1–Q4 are ruled.

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
