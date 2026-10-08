---
id: in-app-guide
status: proposed
dated: 2026-10-06
---

# Idea — the in-app guide: *I need to set up a new server*, answered with the screen that does it

**Status: IDEA. Nothing built.** Dated 2026-10-06. Prompted by a browser tool
that turns plain English into SQL with no model and no API call, and by asking
whether basecamp's surface is closed enough to do the same for *where do I go to
do X*. What § *What the tree has* says was read off the tree that day, with a path
named. Do not cite this file as describing behavior; see `VERIFYING.md`.

## The question

Can a box in the corner of a running app take *I need to set up a new server* and
answer with the right screen, the right action, or a choice between two? Only if
the set of things the app can do is finite and already written down. In basecamp
it is both.

**This is the intent recognizer's `you can do this` and `exists` verdicts, served
live to the person using the app** (`intent-recognizer.md` § *Six verdicts*). That
record resolves a request against the seed to price a CHANGE. This one resolves it
against the surface to find a MOVE that already exists. Same lookup, other end.

**No framework noun is coined.** *Guide* is this file's working title. What the
box is called is the app's decision, as it is for the recognizer's intake.

## What the tree has

- **A ⌘K palette with a hand-written catalog.** About 60 entries in
  `packages/basecamp/web/src/routes/_module.mesa`, grouped Navigate / Create /
  Servers / Workspace, each one a `label`, a `sub` and a `goto`. *Provision a
  machine* and *Import a machine* are there. Matching is on the label, so *set up
  a new server* finds neither.
- **The palette's only grade is `isSystemAdmin`.** Everyone else is offered every
  Create entry, *Provision a machine* included, whatever their standing.
- **A graded catalog that is already derived.** `@frontierjs/mcp` builds its tool
  list from each service's `svc.describe()` and grades it per standing
  (`projectTools(shapes, views, level)` in `packages/mcp/src/plugin.ts`). In
  basecamp that is 152–286 tools across four standings (`app-cli.md`).
- **A route table.** 58 route `.mesa` files under `web/src/routes/`, and
  `routes.snapshot.md` maps a URL to a file.
- **A setup sequence.** `/onboarding/` holds *the six setup checks*, the closest
  thing the app has to a goal of several steps.

## Three tiers, cheapest first

1. **Match intent without a model.** Each catalog entry carries verbs and nouns,
   plus a small synonym table (*set up / spin up / add / create* → Create;
   *server / machine / box / VM / host* → the Server group). Score the entries;
   when two come close, ask one question: *provision a new machine from a
   provider, or import one you already have?* That one question is most of what
   makes it feel like a guide. Deterministic and testable, and it runs offline.
2. **Derive the catalog instead of writing it.** Build the entries from the route
   table, `describe()` and the model `@label`, and grade them by the standing MCP
   already computes. Then the palette, the guide and the MCP tools are one list
   that cannot drift, and the guide never points at a move the gate would refuse.
   **This tier comes first in build order.** Tier 1 on a hand-written list is a
   third copy.
3. **A model, only when tier 1 misses.** Send the query and the caller's graded
   catalog to a model. The answer is chosen off that menu, a route plus prefilled
   params; the model never types a path. It navigates, and any write it suggests
   asks for confirmation. Run 2 of the intent recognizer found a cheap model
   reliable at choosing off a numbered menu and unreliable at composing, which is
   the split this tier needs (`intent-recognizer.md`, preamble).

## Where it gets hard

**Goals of several steps.** *Set up a new server* really means provision → enroll
Outpost → attach a network → deploy. A search lands on step one and stops. What
would lift it above a palette is *step 2 of 4, you are here*, and that needs a
declared sequence. Onboarding's checks are the one the app has. Naming that thing
coins a noun, so it waits for `decision-rules`.

**The screen index.** Answering *which screen shows X* needs the index
`intent-recognizer.md` § *Where the lookup is thin* says is missing: what each
`.mesa` file reads and renders. Tiers 1 and 2 do not need it, because they answer
with routes and moves. A guide that answers *where is the column for Y* does.

## Open questions

- **Where do intent words live?** On the route (an export in its
  `<script module>`), on the service method, or in one table beside the palette.
  Wherever they live, they should be beside the thing they describe.
  - **A** — on the route, an export in its `<script module>`.
  - **B** — on the service method, read through `svc.describe()`.
  - **C** — one table beside the palette.
  - **D** — on whichever thing the catalog entry derives from: a Navigate
    entry's words on its route, a Create or act entry's on its service method.
  - **Recommend D** — tier 2 builds entries from both routes and methods, so
    each half's words sit on the thing they describe, and the method's words
    reach the MCP tool list through `describe()` at no cost. C is the
    hand-written third copy tier 2 exists to remove.
- **Is a miss logged?** Logging every unmatched query is free, and it is the only
  corpus that says what people actually type. It decides whether tier 3 is worth
  building at all.
  - **A** — yes, as a log line through `$.log`.
  - **B** — yes, as a row in a model the app's box owns, with the query, the
    caller's standing and the nearest entries offered.
  - **C** — no.
  - **Recommend B** — the corpus is read by counting and grouping, which a
    rotated log does not support, and an unmatched query is the workaround
    measuring the road (*paved road vs. the workaround*). The row is the app's,
    so whether a query typed by a person is kept is the app's call too.
- **Framework or app?** The derived catalog (tier 2) is framework-shaped, a
  lookup over artifacts the build already produces. The box in the corner is an
  app's own screen, the same split `intent-recognizer.md` § *What this is and is
  not* draws, with `FJS-D14` as the ruling.
  - **A** — all framework: the graded catalog and a guide component in `ui`.
  - **B** — split: the graded catalog is framework, beside `projectTools` in
    `@frontierjs/mcp`, and the box, its synonyms and its miss log are the app's.
  - **C** — all app.
  - **Recommend B** — the graded move list already has one owner, the one that
    grades MCP tools per standing, and the palette reading the same list is what
    keeps the guide from offering a move the gate refuses. The box is a screen
    and its words are the app's. `FJS-D14` rules the box half (an app built on
    the framework is not a gap in it) and says nothing about the catalog, and its
    orion half has since been amended by `FJS-D269`.

## See also

`intent-recognizer.md` (the same lookup, pricing a change) · `app-cli.md` (the
terminal client derived from the same agent surface) · `agent-surface.md` ·
`packages/ui/components/overlay/CommandPalette.mesa` (the box it would extend)
