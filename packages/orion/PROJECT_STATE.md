# Project state — @frontierjs/orion

**Phase 1 of `IDEAS/orion-port.md` is done · private, unpublished.**

## What is real

- The kernel, lifted from `mockup/api-engine` with its history: the compiler,
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

## What is not

- **Anything the host supplies.** No `.lite` models, no litestone-backed store,
  no Caravan queue, no Junction plugin, no services, no screens. The queue and
  store the engine runs on are the in-memory ones.
- **Triggers other than the registry.** The event bus, the cron scheduler, the
  HTTP router and the activator are still in `mockup/`; cron is replaced by
  `toolbelt/cron` and Caravan rather than ported, and the rest are rewired in
  phase 4.
- **A host.** Nothing installs orion yet, so no drive runs it.
