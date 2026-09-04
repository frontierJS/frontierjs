---
id: server-only-boundary
status: proposed
dated: 2026-08-06
---

# Idea — Put the server/client boundary in the filename

**Status: IDEA. Nothing here is built.** Dated 2026-08-06. Verified the same
day: `packages/sierra/src` contains no `.server.` convention, no `serverOnly`,
and no `"use server"`/`"use client"` handling of any kind. See `VERIFYING.md`.

---

## Trigger

SvelteKit's `.server.ts` suffix and `$lib/server/`. RSC's `"use client"` /
`"use server"`. Both do the same thing: **encode the boundary in the file
itself**, so an illegal import is a build error instead of a runtime leak.

## Where FJS stands

FJS's boundary is a **directory** — `db/` + `api/` + `web/` at the app root
(Invariant 3) — and it is enforced by exactly one thing: Vite's root is `web/`,
so that is what gets bundled.

Nothing stops this:

```js
// web/src/routes/orders/index.mesa
import { sys } from '../../../api/db.ts'    // ← compiles, bundles, ships
```

and nothing stops the smaller, likelier version — a shared helper in `web/` that
imports one constant from `api/`, dragging the module graph behind it. The
failure is a credential or a `asSystem()` client in a browser bundle, and it is
silent: the build succeeds and the page works.

**A directory convention is a thing you have to still be following.** A filename
survives a refactor, a copy-paste, a file move and a new contributor.

## What FJS already has, and why it is not this

`FJS-081` is the same class one axis over: a `render: static` route that reads a
model at `@@gate("4")` is prerendered with that data baked in and published as a
public HTML file. `build/prerender.js` is 352 lines and contains no occurrence
of *gate*, *auth* or *level*.

The distinction is worth stating because it decides whether one mechanism can
cover both:

| | leaks | detectable from |
| --- | --- | --- |
| `FJS-081` | authenticated **data** into a public artifact | the models a route reads + their gates |
| this | server **code** into a client bundle | the import graph |

Different inputs, same shape of answer: **compare two things the build already
knows and fail rather than emit.** They should be one reporting surface even if
they are two checks.

## The idea

Take SvelteKit's mechanism nearly verbatim, because it is the right one and
inventing a fourth spelling helps nobody:

- **`*.server.ts` / `*.server.js` / `*.server.mesa`** may not be imported from
  any module reachable from a client entry. The Vite plugin already walks that
  graph.
- **`web/src/lib/server/**`** — a whole directory with the same rule, for the
  case where suffixing every file is noise.
- The error names the chain, not just the file:

```
✗ web/src/routes/orders/index.mesa
    imports  web/src/lib/session.js
    imports  api/db.server.ts        ← server-only

  A server-only module cannot reach a client bundle. Move the value behind a
  service call, or move the helper into api/.
```

**The escape hatch is that there is no escape hatch**, and that is deliberate —
this is the honest exception to FJS's usual "every guarantee gets a narrow
hatch". A per-file override here would be exactly the too-broad hatch that
repeals the guarantee everywhere (`FJS-005` is the repo's own cautionary tale).
If a value is needed on the client, the answer is to send it through the API
realm, which is what the realm is for.

## Why the FJS version can be better than SvelteKit's

SvelteKit's boundary is about *code*. FJS knows more than that, and the stronger
version is available for free once the graph walk exists:

> **The compiler already knows which models a route touches, and the schema
> knows their gates.**

So the same pass that rejects a server-only import can classify each route as
*prerenderable* / *server-needed* / *pure client* (`overview.md` 4.4b) and
report the data leak (`FJS-081`) — three answers from one traversal. No other
static framework can derive the middle column, because in every other one the
permissions live behind a fetch.

That is the reason to do this in FJS's idiom rather than just adopting
`.server.ts` and stopping.

## What is genuinely lost

`.server.ts` is a **convention the framework enforces**, not a fact derived from
the code — which makes it the odd one out in a repo whose whole argument is that
facts should be declared once, in the seed, and derived from there. The honest
defense is that "this module must not ship" is not a property of the data; it is
an intent about a file, and a filename is the cheapest true place to put an
intent about a file.

Worth stating plainly rather than pretending it fits the thesis.

## What would have to be built

1. A resolver rule in `sierra/src/build` that fails the transform on a
   server-only import, with the chain in the message.
2. The same rule for `renderComponent` at prerender time, where the module *is*
   legitimately loaded server-side — so the check is per-entry, not global.
3. `$lib/server`-equivalent directory handling. Sierra has no `$lib`; the path
   convention needs a decision.
4. A test that a violation fails the build. Nothing else in the repo asserts a
   build *failure*, so this is the first one.

## Relationship to the other files

- `static-safety.md` / `FJS-081` — the data axis of the same question; share a
  reporting surface.
- `form-actions.md` — needs "module scope that does not ship" to exist, which is
  this. Design them together.
- `overview.md` 4.4b — route classification, the third answer from the same
  traversal.
