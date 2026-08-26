---
id: static-safety
status: partial
dated: 2026-08-06
---

# Idea — Prove a static page is safe to publish

**Status: THE CHECK IS BUILT (2026-08-06). The classifier is not.** `FJS-081` is
closed — `packages/sierra/src/build/static-safety.js`, wired into
`build/prerender.js`, 39 tests plus `bun run test:safety` against a real
Litestone client, exercised in `example/` (`bun run build:public`). See
`packages/sierra/CHANGES.md`.

**One premise in this file was wrong, and it mattered.** §What would have to be
built item 1 says to track resource reads *during prerender*, because "the
prerenderer knows which resources a route touched (it renders them)". It does
not: a static route's data comes from `load()` in the `.meta.js` companion,
before render, and arrives as a plain `data` prop. Nothing is read during render
in any route in this repo, so a render-watcher would have observed an empty set
and passed every page — a green check proving nothing. The read set is collected
from litestone's `$tapQuery` around the companion instead, which also covers a
`load()` that queries a Litestone client directly — the case no build-time
analysis of the render could ever see.

**Two switched-on checks were added on 2026-08-24, in `fli check` rather than
here** — `static-publish-db` (a `target: 'static'` surface wiring no `db:`, so the
tap has no client and every route that loads data is refused until it declares
`publishes:`) and `static-publishes-0` (`publishes: 0` is the DEFAULT bar, so it
raises nothing and its only effect is to turn the two fail-closed branches into
passes — measured by calling `checkRoute` both ways). They do not grade a page;
the build does that. They answer whether the build can.

**Still unbuilt: the classifier** (§The other half, and item 5). The per-route
table it wants is now produced as a by-product — `prerenderRoutes` returns
`safety.rows` and the build prints it — but routes are still hand-annotated
`render: static` rather than sorted into buckets. Do not cite that section as
describing behaviour; see `VERIFYING.md`.

---

## Sibling

`server-only-boundary.md` is the same class one axis over — this file is
authenticated **data** reaching a public artifact, that one is server **code**
reaching a client bundle. Different inputs (models-and-gates vs the import
graph), same shape of answer: compare two things the build already knows and
fail rather than emit. They should share one reporting surface even though they
are two checks, and together with 4.4b they are three answers from one
traversal.

## The hole

Two features exist and nothing connects them.

- Sierra's `static` target prerenders `render: static` routes to HTML at build time
  (`packages/sierra/src/build/prerender.js`), and as of 2026-08-03 those pages are
  interactive via islands.
- Every model declares who may read it (`@@gate`), which columns never leave
  (`@guarded`), and whose rows these are (`@scoped`).

So it is currently possible to mark a route `render: static`, have it read a model
gated at level 4, and **publish authenticated data as a public HTML file** — one
that is then cached by a CDN, indexed, and impossible to recall. Nothing warns. The
build succeeds. The page looks right.

This is the worst class of bug the framework can have: silent, permanent, and
produced by using two shipped features together in the obvious way.

## The idea

Make it a build-time proof rather than a runtime check, because at runtime it is
already too late — the file exists.

The prerenderer knows which resources a route touched (it renders them). The schema
knows their gates. So:

> **A `render: static` route may only read models whose `read` gate is 0.**
> Anything else fails the build, naming the route and the model.

```
$ fli build
✗  web/src/routes/dashboard/index.mesa  —  render: static
   reads `Invoice`, which is @@gate("4") — level 4 required to read.
   A prerendered page is public. Change the route to render: spa,
   or move the data behind an island.
```

The escape hatch is an explicit per-route acknowledgement, not a flag that turns the
check off globally — the point is that publishing gated data becomes a thing someone
*wrote down*, reviewable in a diff, rather than a thing that happened.

## Why this is worth doing

- **It turns one declaration into a guarantee about another.** That is the whole
  thesis, applied to itself. The framework already knows both halves; connecting
  them costs one comparison.
- **No other static-site framework can do it.** Astro, Next, Nuxt and the rest have
  no idea what a page's data is permitted to be, because permissions live in
  handlers on the other side of a fetch. This is a capability that only exists
  downstream of authorization-as-data.
- **It is cheap.** No new grammar, no runtime cost, no new package. It is a check in
  an existing build step.
- **It generalises.** The same comparison covers `@guarded` columns (should never
  appear in prerendered output at all) and `@scoped` models (a page prerendered
  without a viewer is meaningless for scoped data, which is a *correctness* bug
  before it is a security one — the page silently shows one arbitrary tenant's rows,
  or none).

## The other half: classify the route, don't only check it

**Added 2026-08-05.** The check above answers *may this route be static?* The same
two inputs answer the larger question — *what kind of route is this?* — and that one
retires a hand-annotation rather than adding a check.

Today `render: static` is written by a person. It is a claim about data the framework
already knows the answer to, so it is a claim that can be wrong (that is this file's
whole subject) and one nobody can keep current as a schema changes. Sort every route
into three buckets instead, from what is already known at build time:

| Bucket | Condition | Consequence |
| --- | --- | --- |
| **prerenderable** | every model it reads gates at 0, no `@scoped` model, no per-viewer read | emit HTML at build |
| **server-needed** | reads a gated or `@scoped` model outside an island | render per request, or move the read into an island |
| **pure client** | reads no model at build time; all data arrives through `client:*` islands or `createResource` at runtime | ship the shell, hydrate nothing else |

The declaration then becomes *checkable intent* rather than instruction: a route that
says `render: static` and classifies as server-needed fails the build with the reason,
and a route that says nothing gets the classification as its default. Same failure
message, same comparison, one fewer thing to write by hand — and, unlike the check
alone, it produces an artifact worth showing: a per-route table of what each page is
allowed to be, which is also an input to `atlas` (`IDEAS/operational-edge.md`).

**Astro, Next and Nuxt cannot derive this column.** They can see which route calls
which loader; they cannot see what the loader is *permitted* to return, because the
permission lives in a handler behind a fetch. The classification is downstream of
authorization-as-data in exactly the way the check is.

Two cautions, both inherited from above rather than new:

- **Islands flip a route's bucket in the safe direction** and must be excluded from
  the read set — an island fetches at runtime with the viewer's session. The island
  seam already separates the two cleanly.
- **`asSystem()` at build time defeats the classifier**, same as it defeats the
  check. That is the case the per-route acknowledgement exists for; the classifier
  should treat an acknowledged route as *declared*, never re-derive it.

## What would have to be built

1. **Track resource reads during prerender.** The prerenderer composes the route with
   its layout chain and renders through `renderComponent`; the resources touched are
   knowable there, and `createResource` already resolves a model name via
   `modelNameFor()`.
2. **Compare against `buildGate()`** — already implemented, already a leaf module.
3. **Fail with a message that names the fix.** The precedent to follow is the
   `modelNameFor` miss, whose warning was improved specifically to name the override.
4. **A per-route acknowledgement syntax** for the deliberate case (public content
   from a gated model read via `asSystem()` at build time, which is legitimate and
   will happen).
5. **The classifier and its table** (section above) — the same read set and the same
   `buildGate()` comparison, reported per route instead of thrown per violation.
   Worth building second: a check nobody has run is a rule nobody trusts, and the
   table is what makes it legible.

## Open questions

- **Is level 0 the right bar, or should it be "the gate the build ran as"?** A static
  build that reads through `asSystem()` to publish a public product catalogue from a
  gated `Product` model is a real and reasonable pattern. That argues the rule is
  really "the route must declare the level it publishes at," with 0 as the default.
- **Islands complicate it in the right direction.** A `client:*` island fetches at
  runtime with the viewer's session, so gated data inside an island is fine. The
  check must therefore distinguish "read during prerender" from "read by an island"
  — which the island seam already separates cleanly.
- **What about `@guarded` columns reaching the marker?** An island marker carries its
  props **as rendered** (`CLAUDE.md` § Bridge index). If a prerendered island is
  handed a record containing a guarded column, that column is now in the HTML
  comment. Worth probing — this may already be a live defect rather than a
  hypothetical.
- Does this belong in Sierra's build or in a shared checker that `marshal` also uses?
  Both read gates against something; see `IDEAS/compliance-from-the-seed.md`.

## See also

- `IDEAS/compliance-from-the-seed.md` — the same declarations, read for audit
- `IDEAS/operational-edge.md` — `atlas`, which the per-route classification feeds
- `IDEAS/one-mental-model.md` §6 — the target axis the classification is a property of
- `IDEAS/package-map.md` — where a shared gate-reader would live
- `packages/sierra/src/build/prerender.js` — the build step this attaches to
- `packages/sierra/src/junction/field-rules.js` — `buildGate()` / `canAtLevel()`
- `CLAUDE.md` § Bridge index — the island marker's "props as rendered" note, which is
  the third open question above
