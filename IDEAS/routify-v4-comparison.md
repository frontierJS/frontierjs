---
id: routify-v4-comparison
status: assessment
dated: 2026-09-07
---

# Idea — Routify v4 read against Sierra: four features, two surfaces

**Status: ASSESSMENT. UNBUILT, and nothing here is a commitment.** Dated
2026-09-07. Every Sierra claim was read off `packages/sierra/src/` and
`packages/junction/src/client/` on that date and is cited by file; the Routify
half is the proposal as it arrived and was never run. Do not cite this file as
behavior — `VERIFYING.md`.

**`packages/sierra/CLAUDE.md` § *What bites here* is the origin for the Sierra
half and this file is not.** What is written here that is not written there is
the comparison and the surface instrument below; where the two disagree, the map
wins and this record is stale.

---

## Trigger

A v4 proposal for **Routify** — a Svelte file-tree router, v3 being what the
author's legacy apps run — arrived asking to be reviewed against Sierra. Four
features:

1. **Compiler-driven data fetching.** Each component pairs with a context file
   (`Header.tsx` → `Header.context.ts`). The compiler scans the active component
   tree, extracts every `runParallel` export into one top-level `Promise.all`,
   and schedules `runSync` exports parent-to-child.
2. **SSR skip via XXHash3.** Hash the resolved payload; if it equals the last
   render's hash, skip template compilation and serve the cached markup
   fragment.
3. **Component-level SSG invalidation.** `POST /api/ssg/invalidate` with
   `{ identifiers: ["ProductCatalog/Card:1024", "GlobalFooter"] }`, recompiling
   only those static components on a CMS webhook.
4. **State sync over REST**, cookies avoided for header bloat and the 4 KB
   limit, with monotonic per-mutation `version: N` and the server discarding
   late-arriving packets.

---

## The finding

**The four are not one proposal. They are two, and they belong to two
surfaces.** Invariant 3's split — `web/` is an SPA console, `site/` is a
prerendered origin — is what makes each feature answerable, and the proposal
treats one app as one thing.

| Feature | On `web/` (SPA console) | On `site/` (prerendered) |
| --- | --- | --- |
| `runParallel` tree batch | the request cost is real, but the active tree is not statically decidable | `load()` runs at BUILD time; nobody is waiting |
| `runSync` parent-to-child | serializes what Sierra already runs in parallel | moot, build-time |
| XXHash3 render skip | no per-request SSR to skip | no per-request SSR to skip |
| SSG invalidation | not applicable | **the real question** |
| REST sync + sequence ids | `@version` is the answer; sequence ids solve the wrong problem | defensible — one writer, and that writer is nobody |
| avoid cookies | costs OAuth, which is a browser redirect | correct — cross-origin bucket |

**The sharp version.** `runParallel` earns its keep only where there is a
request to pay for — `web/` — and `web/` is exactly where the active tree is not
knowable at compile time (`{#if}`, a dynamic component). The tree that *is*
knowable is the file tree, which is the surface where the waterfall costs
nothing. The feature wants to live where it cannot be computed.

---

## Where Sierra already has an answer

**The companion file is the same convention.** `Page.mesa` → `Page.meta.js`,
classified in `scanner/classify.js` and mapped in `scanner/build-tree.js`; a
layout gets `_module.meta.js`. The difference is scope: Sierra extracts from the
**route table** alone, and a layout companion carries `meta`, not `load`.

**Parallel is already the default, and top-down is the regression.**
`router/index.js` loads the layout chain and the page component together, the
comment reading *they're independent*. `runSync`'s parent-before-child ordering
reintroduces the waterfall the proposal opens by naming.

**Prop drilling dissolves in the store, not in the compiler.** `createResource`
is module-level, so a nested component imports it directly; under it,
`junction/src/client/nodes.ts` keys a `NodeRegistry` by **model + id**, not by
service and not by component, so two components ten levels apart reading order
`1024` hold one node. This is the cheaper cut and it should be priced before any
compiler pass: after a per-row store, how much drilling is left?

**There is no per-request SSR to skip.** Sierra's targets are `spa`, `static`,
`widget` and the extension surface. `static` emits HTML and CSS and no script
at all — `islands/loader.js` is the whole interactivity story, not an
optimization on a working one — and Mesa has no hydration, so an island
*replaces* prerendered markup rather than adopting it. The proposal's §2 targets
a render mode neither framework has.

**Caching rendered output is `static-safety.js`'s hazard with none of its
guard.** A `render: static` route's reads are tapped around the *companion*
(`$tapQuery`, resolved through `modelNameFor`, `include:` expanded through
`client.$relations`) and graded against `@@gate`, **fail-closed**, with
per-route `publishes: N` the only escape. A markup cache keyed on `dataHash`
alone has no principal in the key and will serve one caller's row to another.
Anything not in the hashed payload — standing, locale, theme, flag, clock — is
a silent wrong answer.

**Static staleness is answered at read time.** `example`'s `verify:site` asserts
that a price moved in the database after the build leaves the baked number
readable while an **island corrects the cell**; the `@@fts` search box falls back
and says so with the network off. No webhook, no recompile, no cache coherence.

**The HTML is already revalidated.** `site/serve.js` answers
`public, max-age=0, must-revalidate` for HTML and `immutable` for a hashed
asset. So an invalidation endpoint is not solving staleness at the edge — the
CDN already asks — it is a **build trigger**, and conflating the two is how one
endpoint ends up owning two problems.

**Identifiers reaching a compile step are the `fillPath` bug.** `getStaticPaths`
params were joined onto `outDir` where `join` resolves `..` normally, so a slug
of `../../../../etc/cron.d/evil` wrote an HTML file outside the output directory
on the build machine, and `''` collapsed onto the parent page and overwrote it
with the build exiting 0 and printing a tick (`build/prerender.js`). A CMS
webhook supplying `"ProductCatalog/Card:1024"` is the same shape: the
identifier must be looked up in a table the build emitted, never parsed into a
path or a module id.

**A monotonic sequence orders one client's own packets and nothing else.** The
two-writer case — the actual client/server inconsistency — is `@version`:
Litestone refuses a patch that does not carry the revision that was read, the
409 carries both, and `resource.conflict(err)` answers
`{ model, field, expected, actual }` for a *reload vs overwrite* prompt.
Two defects were paid for here and are worth handing over: **a push must not
move the remembered version** (`FJS-341` — a WS push arrived as an upsert, so a
screen holding a draft sent a revision nobody there had read and won the race
optimistic locking exists to lose; measured in basecamp, the other person's
write erased, guard in place, no error), and **a patch carries what changed
against the row this screen read** (`FJS-809` — sending the whole record makes a
PATCH a PUT; the baseline is `_read`, one entry per fetched row, capped at 200,
a miss sending the whole record so the failure mode is the old behavior).

**The submitted-mutation overlay is the shape the sequence id was reaching
for.** `Node._overlays` is a Map of *intents* — a partial, or `null` for a
removal — folded over the synced truth in submit order, **keyed by the mutation
and not by the row**, because another writer patching the same row moves the
truth underneath and must not clear an intent nobody has answered for. The node
holds the synced truth alone; a draft and an optimistic value live elsewhere,
which is what `FJS-341` cost to learn.

**The socket already declines to open for a stranger.** `junction/index.js`
opens on a token the constructor adopted, and in cookie mode waits for the
session restore and returns when `session.user` is absent — the comment reads
*opening a socket for every anonymous visitor to a public page is a cost the
Bearer path never pays*. So *WebSocket by default* is a `web/` claim with a
`site/` exception already ruled, and the proposal's instinct there is right.

**On `site/` the credential argument is right and on `web/` it inverts.** A
storefront is its own origin: `example/site/src/api.js` is a build-time
constant because a static page has no server to ask, every island call is a real
preflight, and `verify:account` asserts a shopper's session living on the
**storefront's** origin. On `web/`, dropping cookies costs OAuth, whose callback
is a browser redirect that can only return a session as a cookie — and
`cookieAuth` must be declared on both sides or the app is silently signed out
(`FJS-787`).

---

## Where Sierra has nothing

Recorded because a comparison that only scores the other side is worthless.

- **Island props are baked into the marker**, as JSON inside an HTML comment.
  So on `site/` the drilling complaint has teeth that it does not have on
  `web/`: the build has to serialize a seed down the tree, and the node registry
  cannot reach it because there is no client store at build time. Two different
  problems wearing one name, and only one of them is solved here.
- **No per-request SSR at all.** Not a gap by accident — `FJS-543` is why a
  static route's companion never enters the browser graph — but it does mean a
  third render mode is unanswered rather than refused.
- **No incremental static rebuild.** The prerender is whole-build;
  `prune-unreachable.js` decides what may publish. The island-corrects-the-cell
  answer is cheaper for a price, and says nothing about a page whose *prose*
  changed.

---

## If Sierra is restructured, what to take

1. **Nothing about the compiler pass.** The route table is the decidable tree
   and Sierra already extracts from it.
2. **The surface question as a review instrument.** Every one of the four
   features scored differently on `web/` and `site/`, and two of them are
   correct on one and wrong on the other. *Which surface, and does the other
   surface pay for it?* is the question that separated them, and it is worth
   asking of anything proposed for Sierra.
3. **The invalidation endpoint only if it is named a build trigger**, and only
   with identifiers resolved through a table the build emitted.
4. **Baked island props as a real open problem** on `site/`, which is the one
   place the proposal found something this repo has not argued.

## What to refuse

- **A markup cache keyed on data alone.** It is `FJS-081`'s class — two correct
  features combined the obvious way publishing private data — with the tap and
  the fail-closed branch removed.
- **Sequence ids as concurrency control.** They are ordering, and ordering is
  not the bug.

---

## See also

- `IDEAS/prior-art.md` — the same kind of record for whole projects
- `IDEAS/static-safety.md` — the proposal behind `build/static-safety.js`
- `packages/sierra/CLAUDE.md` § *What bites here* — the live version of most of
  the Sierra claims above
