# Idea — Prove a static page is safe to publish

**Status: IDEA. Nothing here is built.** Dated 2026-08-04. The prerenderer performs
no authorization check of any kind. Do not cite this file as describing behavior —
see `VERIFYING.md`.

---

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
- `IDEAS/package-map.md` — where a shared gate-reader would live
- `packages/sierra/src/build/prerender.js` — the build step this attaches to
- `packages/sierra/src/junction/field-rules.js` — `buildGate()` / `canAtLevel()`
- `CLAUDE.md` § Bridge index — the island marker's "props as rendered" note, which is
  the third open question above
