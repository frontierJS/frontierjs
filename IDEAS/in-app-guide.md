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

---

## The journey — wave 6 of the vocabulary atlas

**Ruled 2026-10-09 as [`FJS-D693`](../DECISIONS.md#fjs-d693): A, with *Checklist* reserved for its first reader, and Route (i).** The owner asked whether a journey is a wizard and whether it is a Pipeline; the ruling records why it is neither.

*Added 2026-10-09. The atlas's thin-area card says the UI realm stops at the
Frame tier and at Foley's low-level tasks, that "user journey" appears in zero
files and onboarding in 16, and asks: "decide whether a journey is a UI-side
Flow before naming it". § Where it gets hard above parks the same question.
Counts are `rg` over `IDEAS/`, the root registers, `packages/*/src`,
`packages/*/docs` and `../fjs-prototypes` on this date.*

### The check: "journey" is five things, and four have an owner

| What the word covers | Instance in the tree | Owner today | Built? |
| --- | --- | --- | --- |
| **moving between pages** | sierra's router: `src/routes/`, `_module.mesa` layouts, `beforeNavigate` / `afterNavigate`, prefetch, `isActive`; auth's allow-listed `returnTo` after sign-in | sierra, auth | yes |
| **a row's progress** | `<Steps steps={orders.fields.status.enum…} currentStep={order.status}>` in `example`'s order and subscription screens | `@@transitions` / the status enum, rendered by `@frontierjs/ui`'s `Steps` | yes |
| **a setup checklist** | basecamp `/onboarding/`: six checks, each a count `infra.onboarding` reads fresh. **No model, by ruling** (`docs/SCREENS.md`, 2026-08-25): a stored `done` is a second answer that goes stale when the server it recorded is deleted | a service method returning a projection | yes |
| **a wizard** | ELA's `/intake/`: five panes, `let step`, a hand-written `order` array, `<Steps>`, one submit. SSTime folded its reference's six-step wizard into one form (`MissedShift.mesa`); basecamp folded the mock's `CreateProjectWizard` into one page | screen-local state. `FJS-D390`: no statechart until a screen's booleans cause a defect | ad hoc |
| **a goal across pages** | *set up a server* = provision → enroll Outpost → attach a network → deploy (§ Where it gets hard) | none | no |

The first four are already a Projection or a screen's own state. Only the fifth
is unbuilt, and it is the one that would need a declared order.

**Is a journey a UI-side Flow? No.** A Flow is *a declared sequence of steps a
Run executes* (`FJS-D634`), and a Run is a record of the execution. A person
walking a goal leaves no execution record worth keeping: every step's
completion is already in the data. Basecamp's onboarding ruling is this
argument made from the other side. A Run row per person per journey would be
the stored `done` that ruling refused. The word fits loosely. The construct
does not.

### What it found

- **The off-ladder exits are restated twice.** `example`'s order screen and its
  subscription screen each filter `cancelled`/`refunded` out of the enum by hand
  to draw the main path. The schema never says which states are exits, so the
  two screens can disagree and nothing would notice. That is a missing
  declaration on `@@transitions`, not a missing noun, and it is not proposed
  here.
- **ELA's intake wizard commits through three service calls.** A client, then a
  property, then a task, each a separate `create` from the browser. If the
  third call fails, a lead row is left behind with no request. A wizard that
  writes several models should commit through one service method, so the
  commit is one Call. This is an app defect in `fjs-prototypes/ela`, not a
  framework gap.
- **Two UI words have no row, and each is spelled twice.** `Page` and `Layout`
  are `open` in `VOCABULARY.md`. Sierra means the route file and its
  `_module.mesa` wrapper. css means the Page tier (Screen, Pane) and the Layout
  tier (Stack, Cluster). `FJS-D382` already says *a page, a layout and a Button*
  are all Components whose kind is said by their parent, so the sierra sense is
  the one the register already leans on. The tier rows keep their qualifier.
- **Route is blessed for the API, and sierra uses it 333 times.** The register
  defines Route as junction's raw handler (`FJS-D391`), while sierra's
  directory, `page.route` and *the route table* all mean a URL bound to a page.
  This is the same shape as Origin and Domain (`FJS-D678`): two senses that are
  both live.

### Words that must not be coined

- **Journey** is UX research's word for a narrative of a person's experience
  across touchpoints: a map someone draws, not a construct software runs.
  "user journey" appears in zero files here, and `journey.mesa` on the website
  draws a request path. Refuse it, and say which of the five things is meant.
- **Workflow** is refused (`FJS-D634`). **Flow** is ruled for the Automation
  realm. IFML (OMG, 2015) calls an edge between two views a *navigation flow*,
  which would be a third sense of the word.
- **Tour** and **walkthrough** name a product feature (an overlay that points
  at controls). That belongs to an app, under `FJS-D14`, the same way the guide
  box does.

Prior art: Rosenfeld & Morville divide navigation into embedded systems
(global, local, contextual) and supplemental ones (sitemap, index, *guide*).
This file's guide is the last of those, and nothing here asks for a framework
noun for the others: sierra's route table is the sitemap.

### Options

- **A — no noun.** Each of the five keeps its owner. `Page` and `Layout` get
  rows with sierra's senses: *a Component under `src/routes/` that sierra
  renders at a URL* and *a `_module.mesa` that wraps every page beneath it*.
  *Journey* is refused. The goal across pages waits for tier 2 of this file,
  and its declared order is spelled when that is built.
- **B — a journey is a UI-side Flow.** A `<name>.flow.js` lists steps, each a
  page plus a check over the data, and progress is derived from the checks.
  The cost is that Flow's row widens to *executed by a Run or walked by a
  person*. That gives the word two senses, or else it puts a Run row behind
  every person's progress, which is the stored answer basecamp refused.
- **C — coin Checklist.** It means a declared, ordered list of checks over the
  data, each naming the page that satisfies it, with progress always derived
  and never stored. It covers onboarding and the guide's *step 2 of 4*, and it
  takes no word from Automation. The cost is that the corpus has one instance,
  basecamp's six checks, and those are already a service method that works.
- **Recommend A.** Four of the five have an owner, so a noun would name
  nothing new (*the nine*: amend rather than add). B gives a ruled word a
  second sense to save a row. C is the right shape coined one instance early.
  Take C once tier 2 of this file is built and a second app writes an
  onboarding: by then two instances can say whether a check is a count, a
  predicate or a `can()`.

**Open for the owner: Route.** Either (i) qualify it the way `FJS-D678` did
Origin and Domain, so a bare Route is junction's and sierra's is a *page route*
wherever the two could meet, with no checker; or (ii) re-scope the blessed row
to *a URL bound to a handler, on either side*, so that the API's raw route and
sierra's page route are two kinds of one thing. **Recommend (i).** The two
share a URL and nothing else: one is outside the pipeline with no gate, and the
other renders a Component. (ii) would make the row say less than it does now.

### The nine, answered before the first edit

1. **Origin.** No second origin. A writes no declaration, and each instance
   above already has its owner.
2. **Concept.** No noun is added. `Page` and `Layout` are rows for words
   already in use.
3. **Complexity.** None is added.
4. **Predictability.** A row's progress and a checklist are both derived from
   data. The wizard is the one case with hand-held state, and `FJS-D390`
   already rules on it.
5. **Derived.** One restatement was found (the off-ladder filter, twice). It is
   recorded above and not fixed here.
6. **Owner.** Navigation belongs to sierra's router. Progress belongs to
   `@@transitions` through `x-transitions`. A checklist belongs to the app's
   service. The guide's catalog belongs to `projectTools` (§ Framework or app,
   B).
7. **Boundary.** Not touched.
8. **Failure.** The intake's three-call commit leaves an orphan row when it
   fails partway. That is the app's to fix: one service method makes it one
   Call.
9. **Silence.** What must stay true: journey progress is never stored beside
   the data that already answers it. What fails when it stops: **none**. No
   check reads for a `done` or `step` column.

**Adjudication:** *doctrine vs. discovery*. The conversions had already
answered the question: two of three collapsed their wizards, and basecamp
refused the stored step. *Familiarity vs. precision* refuses *journey*.
**Tier:** a ruling is Register (`DECISIONS.md` and the two rows), and this
paper is Assessment.

## See also

`intent-recognizer.md` (the same lookup, pricing a change) · `app-cli.md` (the
terminal client derived from the same agent surface) · `agent-surface.md` ·
`packages/ui/components/overlay/CommandPalette.mesa` (the box it would extend)
