---
id: hydration
status: proposed
dated: 2026-11-14
---

# Idea — Hydration, and what a server-only region is

**Status: PROPOSED. Q1–Q6 ruled 2026-11-15 (`FJS-D2172`–`FJS-D2177`); nothing
built; 0.5 next.** This is the guiding paper for hydration and server components
in Mesa and Sierra. Hydration is the direction (`FJS-D2172`), but until 0.5
lands **VISION RULE 20 still reads: there is no hydration.** The `VISION.md`
edit lands in the same commit as the rulings.

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
not yet mounted still shows the server's value. Neither is reported. It was
found against `ryansolid/solid-server-component-benchmarks`, whose `store-sc`
case shares a cart through context from one client root, a shape islands
cannot express.

The second cost is visible: a prerendered island re-renders on mount, and an
island over `{#await}` data fetches what the server already awaited
(`FJS-D1647`).

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

- [ ] 0.1 Drive `FJS-4313`: a provider above an island and a store shared by
  two islands, both halves observed in Chrome
- [ ] 0.2 Measure today's cost on `example/site/`: re-render on mount, refetch
  count, island bytes
- [ ] 0.3 Read the marker protocols of Svelte 5, Solid and Marko 6 for one
  keyed by reactive edge
- [x] 0.4 Owner rules Q1–Q6 — ruled 2026-11-15, `FJS-D2172`–`FJS-D2177`
- [ ] 0.5 Amend RULE 20 in mesa's `docs/VISION.md` to name hydration as the
  planned replacement for islands-replace (`FJS-D2172`), committed with the
  rulings
