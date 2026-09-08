---
id: app-atlas
status: shipped
dated: 2026-09-07
---

# Idea — the app atlas: everything this app answers, in one reading

**Status: SHIPPED.** All three stages landed 2026-09-07. `src/core/app-model.ts`
now holds every walk over a built app that a register renders — `describeSurface`,
`describeJobs`, `describeNotifications` and their types, moved verbatim out of
the three tools — and composes `describeAppModel(app)` over those and
`describePrincipalRealm`. The three tools render and nothing else: `surface.ts`
273 → 203 lines, `jobs-snapshot.ts` 215 → 174, `notifications-snapshot.ts`
190 → 150. **Proven by byte compare rather than argued**: all seven committed
registers across `example` and `basecamp` regenerate identically under `--check`,
junction's 2,328 tests pass and its typecheck is clean.

Stage 3 is `junction atlas` (`packages/junction/tools/atlas.ts`), which boots an
app once and prints `describeAppModel` as JSON, and `fli app:atlas`
(`packages/cli/commands/app/atlas.md`), which renders it. The entry is read off
the committed `surface.snapshot.md`'s own header rather than probed —
`packages/cli/core/app-entry.js` — the same line the `snapshots` phase reruns.
Run against both apps in this repo. Probed against the tree 2026-09-07
(`VERIFYING.md`). Prompted by
reading the Stacks `Action` class, which puts an operation's route, validation,
authorization, retry policy and API contract on one object. The conclusion there
was that FrontierJS should not have an Action — every field it carries already has
an owner here, and `authorize(request)` on the object is Invariant 6 refused by
name. **What the comparison did surface is that the answers are correct and
uncomposable.**

## What exists, measured

**Five** commands write a register each, not three — an earlier draft of this
record missed two of them:

| Register | Written by | Answers |
| --- | --- | --- |
| `surface.snapshot.md` | `junction surface` | the methods each service serves, its custom methods, the hook chain in order, every path the router mounted |
| `principal.snapshot.md` | `junction principal` | who a caller becomes — the resolver, the claims it builds |
| `jobs.snapshot.md` | `junction jobs` | what runs when nobody asked — jobs, crons, plugin timers |
| `notifications.snapshot.md` | `junction notifications` | what this app can tell somebody |
| `errors.snapshot.md` | `junction errors` | the error boundary |

Four of the five read a **built app** rather than scanning source, for the same
stated reason: an option key and a method look identical in a file, `apiPrefix`
moves every route, a plugin mounts paths nobody wrote, and a job registers itself
by being autoloaded. `packages/junction/src/plugins/manifest/` is 263 lines and
already emits `{ path, kind: 'service' | 'raw', methods, … }`, so the shape is
not hypothetical.

**And the reading is already shared.** `tools/app-module.ts` exports `loadApp`,
and `surface`, `principal`, `jobs` and `notifications` all import it —
`errors-snapshot.ts` is the one that does not, because it needs no built app. Its
header already makes this record's argument, one layer down: *two copies of how
do you load an app is how one tool snapshots an app the other never sees.* What
is **not** shared is the walk over the loaded app: each tool builds its own shape
from it, and each runs as its own spawned process, so `example` boots four times
to write four files.

**`exports.snapshot.md` is not one of these and does not belong in the set.** It
answers what a published package offers an installer, which is a different
question with a different audience — an earlier framing of this idea listed it as
a fourth register and was wrong.

## The argument is `FJS-D223`, one scope down

That ruling settled `ws:map` and `ws:atlas` into one command: **one model, three
presentations, chosen by `--as`** — because `core/repo-atlas.js` reads no files at
all, which is why the split was never two things. The three registers above are
the same situation one scope down: one reading of one built app, rendered three
ways, and nothing renders the fourth way that answers a question people actually
ask — *what can this app do, how is each of those reached, and what graded it.*

Today that question costs opening three files and joining them by hand. A service
method and the job that calls it are one operation reached two ways, and no
artefact says so.

**The example that is worth reading before building this is the one that goes
right.** `example/api/src/jobs/sweep-abandoned.job.ts` calls
`app.service('orders').call('cancel', …)` rather than the database, and says why
in a comment: *then the gate, the policies and the envelope are the same ones
every other caller gets.* That is the correct choice, made by hand, in a file
nothing grades. Of 19 job files across `example` and `basecamp`, 6 call a service
and 13 carry their own logic — so **which of those 13 reach the Data boundary at
what standing is not written down anywhere**, and it is exactly the column this
view would carry.

## What shipped is narrower on the grading axis, and why

Two things in this record overclaim, and building it is what showed them.

**A per-service *what graded it* column cannot say anything.** `gateAuth` is a
DERIVED around hook that `createBaseService` installs unconditionally
(`packages/junction/src/core/service.ts`, `markDerived(gateAuthAround(…))`), so
every service in both apps here carries it — 38 of 38 in `example`. A column
whose only possible value is *fine* is the fail-open check § III names, one tier
up. It was written, measured, and removed; the report says why in place of it.

**Which service a job calls is not in the model, and cannot be.** The paragraph
above about 19 job files is the column this view was supposed to carry, and it is
in the job's SOURCE — a scan, which is the thing this view exists instead of
(`FJS-254`). The report states the gap rather than leaving it to be discovered.

What the view does carry on that axis is real and varies: **the raw routes**,
21 in `basecamp` and 28 in `example`, each running below the pipeline with no
`gateAuth`, no `autoValidate` and no envelope. That is the answerable half of
*what graded it*, and it is answerable precisely because it is a fact about the
built app rather than about a file.

## No new noun

The obvious spelling is an `Operation` — one row per invocable thing, spanning a
service method, a raw route, a job, a cron and a notification. **That is a sixth
cross-cutting noun beside the five realm nouns, and § III's concept economy is
the reason not to coin it.** The realm nouns each name a thing a developer
writes; this names a thing a tool *computes*, and a computed cross-section does
not need a name — it needs a page.

So it is a **view**, and it takes the name that already exists: `fli ws:atlas`
aimed at an app rather than at the workspace.

## The nine questions

1. **Another origin?** No, on one condition: it renders from the same reading the
   three registers render from. A fourth reader with its own view of a built app
   is a fourth origin and the idea fails.
2. **Concept budget?** Nothing coined — see above. A view, under a name in use.
3. **Complexity ours or the problem's?** The problem's. An app really does have
   operations reachable five ways.
4. **Predictability?** Up, and the gain is specific: *how is this reached*
   becomes answerable per operation instead of per register. (Answered
   `who may run this` when written; see § What shipped is narrower — the
   grading half is answerable for raw routes and not for services or jobs.)
5. **Derived or restated?** Derived entirely. A hand-written row here is the
   feature failing.
6. **One owner?** junction owns the reading (it already does, three times over);
   the cli owns the rendering (it already does, for the workspace).
7. **Boundary explicit?** Named, typed by the manifest's own types, and gated the
   way its inputs are.
8. **Failure proportional?** It is a read. The worst case is a stale page, which
   is what the `snapshots` phase exists for.
9. **Wrong without anything saying so?** **This decides the design.** Rendered
   from the shared reading, its inputs already fail CI when stale and it inherits
   that. Re-reading the app itself would need a gate of its own, and a view that
   silently disagrees with the three registers beside it is worse than no view.

**§ IV:** *batteries vs. smallness* governs, and it passes — a rendering is
severable by construction. Nothing else is in tension.
**§ VII tier:** Assessment. This is a proposal to build, not a settled question,
so it carries a status and is not cited as behavior.

## Open

Both closed 2026-09-07, by probing rather than by argument. They are recorded
under Settled below.

## Settled

- **`fli app:atlas`** is the command. Not a fifth `--as` on the junction tools
  and not a plate inside `ws:atlas`, because the subject is one app rather than
  the workspace, and the workspace atlas already has an owner and a scope.
- ~~**A raw route carries a standing.**~~ **Struck 2026-09-07 — building it
  refused this.** The model carries a raw route's method, path and `kind` and
  nothing about what graded it, because a raw route grades its own caller INSIDE
  its handler and that is source, not a fact about the built app. So `raw` is
  exactly the unknown cell this bullet denied, and `fli app:atlas --ungraded`
  answers the question it can — *which operations reach HTTP below the pipeline*
  — and says plainly that each one grades its own caller or nothing does.
- **The registers become renderings of one model**, staged rather than at once.
  The argument is below.
- **`errors` is not in the model, and the reason is not an asymmetry.** Probed
  2026-09-07: `errors-snapshot.ts` exports one function, `renderErrorsSnapshot()`,
  which **takes no argument** — no `--app` flag, no walk over anything. Its inputs
  are junction's own error classes plus a hardcoded status list, and it writes
  `packages/junction/errors.snapshot.md`: one file, in the framework, identical
  for every app that installs it. The other four are per-app files under the
  app's `api/`. So there is nothing to fold and no symmetry that was ever
  available — recording it as a *stated asymmetry* would send a reader looking
  for one. If junction's error boundary wants a reader it belongs to `ws:atlas`'s
  junction plate.
- **`fli app:atlas` shells out to a NEW junction command, `junction atlas`, which
  emits the model as JSON.** Neither of the two options first written here. The
  cli cannot import the model: `packages/cli` declares no junction dependency and
  cannot gain one — junction is Bun-only and `fli` runs under plain node — and
  the cli's own copy would be a different junction than the one that built the
  app, which is version skew a byte compare cannot see. Shelling out to the four
  existing tools undoes stage 2: four spawns, four boots, and four rendered
  markdown files to re-parse, which recovers a cross-register join by matching
  names — the guess `app-model.ts` exists to refuse. `junction atlas --app <m>`
  is one boot, one walk and structured output, so the join survives the wire;
  it is `FJS-D223`'s third presentation applied one scope down, and the ownership
  line question 6 already drew — junction reads, the cli renders — holds
  unchanged. It writes no committed file: the four registers are already gated,
  and a fifth derived from them would be a second origin.

## One model, or a fifth walk

The choice is narrower than it first looks, because `loadApp` already settled the
loading half. What is in question is the **walk**: one traversal of the loaded app
producing one model that every register renders, against `fli app:atlas` doing a
traversal of its own beside four that already exist.

**For one model.** A fact is computed once, so a new register costs a rendering
rather than a reader — which is `FJS-D223`'s ruling and `loadApp`'s own reason,
both already made in this codebase. It is also the only option that makes the
**cross-cutting columns possible at all**: *this job calls this service method*,
or *this raw route's standing against that service's gate*, cannot be recovered
from four independent walks except by matching strings, and a join by string is a
guess. It boots once instead of four times, which the `snapshots` CI phase pays
per app.

**Against it.** Four gated snapshots change shape in one commit, and a wrong
model turns all four red together where today they fail independently. The four
registers also have genuinely different reasons to exist — `jobs.snapshot.md`
argues that a schedule which stops being registered is *nothing happening*, which
is indistinguishable from nothing needing to happen — so one module would serve
four arguments, and that is a coherence risk rather than a mechanical one.

**For a fifth walk.** Purely additive. Nothing gated moves, it ships in a day, and
it can be deleted if nobody opens it.

**Against it, decisively.** A fifth walk is a fifth origin, which is the failure
question one already named: two traversals of one app can disagree, and the ways
they disagree are exactly the ways a source scan disagrees with a built app — a
plugin registering on a timer, a job autoloaded under a condition. It also cannot
answer the cross-cutting questions, which are the reason to build the thing.

**So: one model, extracted in stages, and the staging is what makes it safe.**
`checkSnapshot` already byte-compares a regenerated snapshot against the committed
one, and the `snapshots` phase already reruns every generator with `--check`. **A
refactor that changes no bytes is therefore provable rather than argued** — which
is not true of most refactors and is true of this one. Take `surface` and
`principal` first, since both answer *who may call what* and overlap most; prove
the renderings are byte-identical; then `jobs` and `notifications`. `fli
app:atlas` arrives last, as a rendering rather than a reader.
