# Project state — @frontierjs/orion

**Phases 1 to 5 of `IDEAS/orion-port.md` are done and phase 6 is built but not browser-proved · private, unpublished.**

## What is real

- The kernel, lifted from the mockup's engine with its history: the compiler,
  the expression evaluator, the executor, the stage scheduler, the plugin
  registry, the built-in nodes, the code worker pool and the trigger registry.
- Their suites, on `bun test`, and typecheck clean against the workspace base
  config with no baseline.
- The engine boundary, enforced: `src/engine/` imports nothing outside itself
  but `@frontierjs/toolbelt`.
- The text form of a flow expression (`FJS-D271`, `FJS-D284`-`FJS-D287`):
  `compileExpression` parses it with the parser `.lite` policies are parsed
  with, values compile to the engine's nodes, and a condition is answered by the
  predicate kit in three-valued logic.
- The data layer: `db/orion.lite`, graded by litestone's gate ladder and field
  protection checks plus a real-principal test per access rule, each of which
  fails when its rule is removed; and `LitestoneExecutionStore`, one statement
  per stage and one transaction at the end, measured at 10, 100 and 1,000
  nodes in `IDEAS/orion-port.md` § Data. Only the owner edits a flow
  (`FJS-D289`), each rule failing its test when removed.
- Execution on Caravan: `src/runner.ts` starts a run as one job dispatched as
  the flow's owner, resumes a wait by its key exactly once, expires a wait past
  its deadline, re-dispatches a lost run, and schedules a flow's cron triggers
  from its row. A worker process SIGKILLed mid-stage is replaced by another that
  finishes the run without re-running the finished stages.
- Triggers and actions, installed by `orion()` into a Junction app: model,
  cron and webhook triggers (async and sync) with one activation owner; the
  resume route; model and service nodes as the owner, typed at compile time;
  `http.request` through `FlowCredential` and orion's conduit; `ai` through the
  app's models; the key-value store on `KvEntry`; and the four day-one limits.
- The services: `flows` (versions, activation, a manual run, a dry run, export
  and import, the layout), `runs` (steps, cancelling a waiting run, metrics) and
  `flowCredentials`, with transport parity over all three; `SYSADMIN(7)` on a
  code node where a flow is saved; named events from the app's own code.

- Tenancy (`FJS-D294`): every entry point names a tenant, under `strategy database`
  and `strategy row`, proved through the plugin with every landing paired against
  the other tenant.
- Screens under `web/`, mounted into `example/` at `/automations/` by one file:
  flows, a flow, runs, a run, credentials. They build; no drive has run them.

## What is not

- **A browser drive of the screens**, and the canvas. The screens edit a
  definition as JSON; `mockup/ui/` is the specification for the rest.
- **Cancelling a run that is queued or running** ([`FJS-1157`](../../ISSUES.md#fjs-1157)).
- **A drive.** Nothing installs orion into `example/` yet, so no drive runs it.
