# Idea — `fli doctor`: the landmine catalogue as a runnable check

**Status: IDEA. Nothing here is built.** Dated 2026-08-04. No diagnostic command
exists in `packages/cli/commands/`. Do not cite this file as describing behavior —
see `VERIFYING.md`.

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

| Check | Failure it prevents |
| --- | --- |
| a raw route registered with `:id` | registers as a literal segment and **404s silently forever** |
| `ctx.params` referenced in a *service* context | always `undefined` — role checks silently pass for everyone |
| `createResource('x')` whose name resolves to no model | degrades to a bare `make()`; the form quietly has no field rules |
| a service defined without `model:` | no `gateAuth`, no `autoValidate`, no derived anything |
| `@encrypted` on a `Json` field | round-trips as `"[object Object]"`; nothing throws |
| a schema declaring `@@gate` with no custom `getLevel` | the shipped resolver grades every junction/auth session at `VISITOR(1)` |
| a model name that is not PascalCase singular | three resolvers disagree; one of them silently opens |
| `render: static` on a route that read gated data | publishes authenticated data as a public file — see `IDEAS/static-safety.md` |
| a client expecting realtime on a service with no `channel:` | no events, no error, a store that never updates |
| a `String? @unique` form field with `blankToNull` off | second empty submission fails a constraint nobody wrote |
| a package root with a fifth markdown file | invariant 17 |
| a typecheck baseline raised rather than lowered | invariant 14 |

The list is not the design — **the design is that the list is executable and grows.**
Every future landmine should arrive as a check plus a line in `CLAUDE.md`, not as a
line alone. That is the actual behavioural change being proposed.

## Why this is worth more here than in another framework

- **The corpus exists and is unusually good.** Most projects would have to invent the
  rules. Here they are already written, already justified, and already carry the
  failure mode and the fix.
- **The failures are derivation failures, and only this framework has them.** A
  naming slip that disables authorization, a missing `model:` that removes every
  derived behaviour, a `@@gate` whose resolver rejects the sessions the app actually
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
fli doctor              # check the app in the working directory
fli doctor --fix        # apply the mechanical repairs (`:id` → `{id}`)
fli doctor --json       # for CI and for agents
```

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

> **A linter owns generic JavaScript correctness. `fli doctor` owns everything derived
> from the seed. Neither reimplements the other, and the VS Code extension surfaces
> both rather than implementing either.**

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
   baseline can ratchet the way typecheck already does.

Steps 1 and 3 are the whole first version. This is `M` at most, and the first four
rules are an afternoon.

## Open questions

- **Where does it live?** `fli` is the natural home and the markdown command format
  suits a rule catalogue unusually well — each rule is a document with the failure,
  the fix, and the check together, which is what the CLAUDE.md entries already are.
  Against that: rules need to be importable by CI and by editors, which argues for a
  library with a `fli` front end.
- **Does it overlap `atlas`?** Both read `project:map --json`. Probably the same
  substrate, different question — atlas asks *what is this app*, doctor asks *what is
  wrong with it*.
- **Static analysis has limits.** `ctx.params` in a service is findable by text;
  proving a `render: static` route reads gated data needs the prerenderer
  (`IDEAS/static-safety.md`). Some checks are build-time, not scan-time, and the
  registry should not pretend otherwise.
- **Does the framework check itself?** Several hazards are about this repo, not about
  apps — the workspace-copy trap, the runner heterogeneity, baseline ratchets. Those
  may want a separate `fli doctor --workspace`, or they may belong in CI directly.
- **Severity model.** A silent-authorization failure and a fifth markdown file are
  not the same thing. Two levels minimum; resist inventing five.

## See also

- `CLAUDE.md` § Live hazards and § Invariants — the corpus this executes
- `IDEAS/testing-and-ci.md` — the mechanism to run it in; gap A
- `IDEAS/static-safety.md` — one check that must be build-time rather than scan-time
- `IDEAS/agent-surface.md` — the same "make it hard to get wrong" argument, one layer
  down
- `IDEAS/tooling-decisions.md` — the linter that has to be told where its edge is, and
  the rest of the tooling this project has never chosen
- `IDEAS/overview.md` — where this sits in the ranking
