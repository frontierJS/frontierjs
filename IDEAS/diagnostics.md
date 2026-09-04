---
id: diagnostics
status: shipped
dated: 2026-08-04
---

# Idea — `fli doctor`: the landmine catalogue as a runnable check

**Status: PART SHIPPED 2026-08-24, under a different name.** Ruled `FJS-D133`:
the rules live in **`fli check`**'s registry, not in a second command — `fli
doctor` already exists and means *can this machine run fli*. The registry, the
two severities, `--list`, `--json` with a non-zero exit and the named allowance
were already there; what shipped is nine rules, the ones that read source:
`raw-route-param`, `ctx-params`, `set-auth-discarded`, `call-header-declared`,
`service-model`, `resource-model-miss`, `service-module-db`,
`scheduler-dispatch`, `gate-unreachable` — **plus `--fix`**, for the three where
the rewrite is the whole fix.
**Three rows below were killed by measuring them** and are struck through: two
had been FIXED since this file was written, one was ruled the intended state.
**The ratchet shipped too** — `check-baseline.json`, one number per rule id,
`--update` unable to raise and `--adopt` the verb that can — and so did the
build-time half, in the only form it can take here: two rules that ask whether
Sierra's publish proof is **switched on**, never whether it passes. **All four
steps of § What would have to be built are done.** What is left in this file is
argument, and one row that wants re-measuring. Everything below is the original argument, kept because it is the
argument — read the table as a backlog, not as behavior, and see
`VERIFYING.md`.

---

## The observation

`CLAUDE.md` § Live hazards is not a documentation problem. It is a **corpus of
mechanically detectable failures**, written down because each one cost somebody days
and none of them announced itself.

Read the list as a spec rather than as prose and a pattern appears: almost every
entry is a property of an app's source that a script could check in seconds. They
were found by hand, one at a time, over weeks — and every one of them will be found
again, by every person who builds an app on this, unless something checks.

The framework's most expensive recurring weakness is silent failure. This is the
proposal to turn that corpus into an asset.

## What it would check

Drawn directly from hazards and invariants that already exist. Each is a rule with a
known failure mode, not a heuristic:

The five marked **shipped** are in `packages/cli/core/checks.js`, with a pair of
tests each in `tests/checks.test.js`.

| Check | Failure it prevents |
| --- | --- |
| a raw route registered with `:id` — **shipped** | registers as a literal segment and **404s silently forever** |
| `ctx.params` referenced in a *service* context — **shipped** | always `undefined` — role checks silently pass for everyone |
| `createResource('x')` whose name resolves to no model — **shipped** as `resource-model-miss`, reported only where the model plainly exists | degrades to a bare `make()`; the form quietly has no field rules |
| a service that resolves to no model — **shipped**, and sharper: a service with no `model:` whose NAME derives to one is correct, so what is reported is the miss | no `gateAuth`, no `autoValidate`, no derived anything |
| ~~`@encrypted` on a `Json` field~~ — **measured 2026-08-24 and false**: Json, Boolean, DateTime and String all round-trip; `Int`, `Float` and an array THROW at the write, which is loud and belongs to the thing that raises it | ~~round-trips as `"[object Object]"`~~ |
| ~~a schema declaring `@@gate` with no custom `getLevel`~~ — the resolver was fixed 2026-08-04 and grades a verified session USER(4); an app with plain signed-in authority is correct with no `getLevel` at all. **What shipped instead is the true remainder**, `gate-unreachable`: a gate at 5+ where nothing can grade a caller past 4 | a role STRING is never interpreted, so ADMINISTRATOR is unreachable without a standing column |
| a model name that is not PascalCase singular | three resolvers disagree; one of them silently opens |
| `render: static` on a route that read gated data — **the check is SIERRA's and shipped 2026-08-06** (`FJS-081`); what `fli check` adds is whether it is switched on: `static-publish-db` and `static-publishes-0` | publishes authenticated data as a public file — see `IDEAS/static-safety.md` |
| ~~a client expecting realtime on a service with no `channel:`~~ — **ruled against**, `DECISIONS.md` § API design: with no `publishDefault` that is the intended state and a report on it "would fire on nearly every service in every app, which is how a warning gets trained out". Junction reports the fall-through case itself, at boot | — |
| a `String? @unique` form field with `blankToNull` off — **needs re-measuring**: `createResource` blank-strips by default now, so the trap is narrower than this row | second empty submission fails a constraint nobody wrote |
| a per-call header set in `web/` and never declared in `api/`'s `http.callHeaders` — **shipped** | works over HTTP, dropped the moment the socket connects |
| a discarded `db.$setAuth(user)` — **shipped** | scopes nothing; every write after it is anonymous and every row policy compares against a null principal |
| the module `db` client inside a service — **shipped** as `service-module-db` | no principal: `auth()` is null, every row policy matches nothing, a write belongs to nobody |
| `app.scheduler` dispatching into the queue — **shipped** as `scheduler-dispatch` | a clock with none of the queue's durability, fired once per replica (`FJS-D36`) |
| a package root with a fifth markdown file | invariant 17 |
| a typecheck baseline raised rather than lowered | invariant 14 |

The list is not the design — **the design is that the list is executable and grows.**
Every future landmine should arrive as a check plus a line in `CLAUDE.md`, not as a
line alone. That is the actual behavioral change being proposed.

## Why this is worth more here than in another framework

- **The corpus exists and is unusually good.** Most projects would have to invent the
  rules. Here they are already written, already justified, and already carry the
  failure mode and the fix.
- **The failures are derivation failures, and only this framework has them.** A
  naming slip that disables authorization, a missing `model:` that removes every
  derived behavior, a `@@gate` whose resolver rejects the sessions the app actually
  produces — no other framework can check for these, because no other framework has
  them. This is the inverse of the usual linter argument: the checks are *not*
  portable, which is exactly why they are valuable.
- **It is the best possible artifact for an agent writing FJS code.** An LLM will
  write `:id`, will call `createService` without `model:`, will read `ctx.params`.
  `IDEAS/slices.md` already argues that a Gate on a Model is harder for an agent to
  get wrong than a check in a handler; this is the same argument applied to
  everything that is *not* expressible in the schema.
- **It compounds with CI.** `IDEAS/testing-and-ci.md` gap A is the mechanism; this is
  the highest-value thing to run in it. Together they mean a class of bug that has
  cost this project the most time is caught permanently, on every commit, in every
  app.

## Shape

```
fli check               # check the app in the working directory
fli check --fix         # apply the mechanical repairs (`:id` → `{id}`)
fli check --json        # for CI and for agents
```

All three ship (`FJS-D133` for the name). What the `--fix` line above does not
say, and the implementation had to decide, is **which rules may carry one**: only
where the rewrite is the WHOLE fix. `const scoped = db.$setAuth(u)` would satisfy
`set-auth-discarded` and leave every write below it going through the unscoped
client — a green check over the bug, which is worse than no fix at all.

Output should name the fix, not just the fault — the precedent is the `modelNameFor`
warning, which was improved specifically to say what to do about it.

Checks are **rules with identities**, so an app can acknowledge one deliberately
(`doctor.ignore`) and so a check can be cited by name in a message. A framework that
cannot be told "yes, I meant that" gets switched off entirely.

## The boundary with a linter — settle it before either is built

Added 2026-08-12. The repo has no linter today (`IDEAS/tooling-decisions.md` §1), and
when one arrives the risk is not the tool, it is the overlap: `:id` in a raw route,
`ctx.params` in a service context and a service missing `model:` all **look** like lint
rules, so somebody will write four of the checks above a second time in a place that
feels natural.

> **A linter owns generic JavaScript correctness. `fli check` owns everything derived
> from the seed. Neither reimplements the other, and the VS Code extension surfaces
> both rather than implementing either.**

(`fli check` rather than `fli doctor` since `FJS-D133` — the command exists and
means *can this machine run fli*. The boundary is unchanged.)

The line is not arbitrary. Doctor's inputs are `parseFile()`, the service registry and
`project:map --json`, and almost every check above is **cross-file** — *does this
resource name resolve to a model* cannot be answered from the file it appears in, which
is the one thing a lint rule sees. And the two file types where FJS's real mistakes live,
`.lite` and `.mesa`, are not JavaScript, so no linter reaches them without a bespoke
plugin that would duplicate the compiler this repo already ships.

Two registries that disagree is the shape Invariant 4 exists to prevent, and it is
cheaper to state the sentence now than to unpick it later.

## What would have to be built

1. **A rule registry** — id, severity, a predicate over some input, a message naming
   the fix. Small; everything else is rules.
2. **Inputs the rules read.** Mostly things that exist: `parseFile()` for the schema,
   the service registry, `project:map --json` for the app model, the route table.
   Source-text scanning is the fallback and should be the minority.
3. **The first ten rules**, taken verbatim from § Live hazards.
4. **A CI mode** — `--json`, non-zero exit, and a stable rule-id surface so a
   baseline can ratchet the way typecheck already does. **Done.**
   `check-baseline.json` at the app root; its PRESENCE is the declaration, so an
   app's own `bun run check` gets the ratchet with no flag to remember. The one
   thing this line did not anticipate: a rule that SKIPPED reports 0 findings,
   which is what a fixed rule reports, so its ceiling is held rather than
   ratcheted — typecheck has no equivalent, because a package is always checked.

Steps 1 and 3 are the whole first version. This is `M` at most, and the first four
rules are an afternoon.

**Shipped 2026-08-24 and it was an afternoon, twice.** Steps 1 and 2 were already
`core/checks.js`; step 3 is nine rules rather than ten, because three of the ten
did not survive being measured. Step 4 is done, baseline included, `--fix`
shipped beside it, and the build-time half landed as two switched-on rules.

## Open questions

- ~~**Where does it live?**~~ **Answered — `FJS-D133`.** A library with a `fli`
  front end, which is what `core/checks.js` already was: two callers, one of them
  `scripts/ci.mjs`. The command is `fli check`, not a new one.
- **Does it overlap `atlas`?** Both read `project:map --json`. Probably the same
  substrate, different question — atlas asks *what is this app*, doctor asks *what is
  wrong with it*.
- ~~**Static analysis has limits.**~~ **Answered, and the answer generalises.**
  Proving a `render: static` route reads gated data needs the prerenderer, and
  that check is Sierra's. But *is the proof switched on* is decidable from text,
  and it is where this class actually fails: a static surface wiring no `db:`
  can observe nothing, and `publishes: 0` is the default bar, so it raises
  nothing and silences the two fail-closed branches. **The build owns the
  verdict; `fli check` owns the wiring.** That is the rule for the next one of
  these — the registry does not pretend to reach a build, and it does not
  concede the whole question either.
- **Does the framework check itself?** Several hazards are about this repo, not about
  apps — the workspace-copy trap, the runner heterogeneity, baseline ratchets. Those
  may want a separate `fli doctor --workspace`, or they may belong in CI directly.
- ~~**Severity model.**~~ **Answered: two, `error` and `warn`**, and the resisting
  held. What carries the nuance instead is the MESSAGE — every finding names the
  failure and the fix — and, since 2026-08-24, whether a finding carries an
  `edit` at all: *this one is a spelling* and *this one is a decision* is a
  sharper distinction than a third severity would have been.

## See also

- `CLAUDE.md` § Live hazards and § Invariants — the corpus this executes
- `IDEAS/testing-and-ci.md` — the mechanism to run it in; gap A
- `IDEAS/static-safety.md` — one check that must be build-time rather than scan-time
- `IDEAS/agent-surface.md` — the same "make it hard to get wrong" argument, one layer
  down
- `IDEAS/tooling-decisions.md` — the linter that has to be told where its edge is, and
  the rest of the tooling this project has never chosen
- `IDEAS/overview.md` — where this sits in the ranking
