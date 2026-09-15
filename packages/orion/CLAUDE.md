# @frontierjs/orion — the inside view

Automations for a FrontierJS app: flows of triggers, conditions and actions, run
by an engine installed into the app (`FJS-D269`). Being ported from `mockup/`;
the plan, module by module, and the rulings it rests on are
`IDEAS/orion-port.md`. `README.md` is the intent.

## Layout

| Path | What it owns |
| --- | --- |
| `src/engine/types/` | the primitives — `Flow`, `NodeDefinition`, `Edge`, `Expression`, `PipeStep`, `ExecutionPlan` |
| `src/engine/compiler/` | a flow → an `ExecutionPlan`: stages, an O(1) routing table, and every author-time refusal |
| `src/engine/expression/` | the flow expression language: `index.ts` is the evaluator and its function table, `text.ts` parses the text form with `@frontierjs/toolbelt/predicate` and compiles it |
| `src/engine/executor/` | one node: resolve its config, run it with retry, timeout and cache |
| `src/engine/runtime/` | the stage loop (`Scheduler`), the run context, and the queue and store INTERFACES with in-memory implementations |
| `src/engine/plugins/` | the node-type registry and the built-in descriptors |
| `src/engine/nodes/` | the built-in node implementations, and the worker pool behind `data.code` |
| `src/engine/triggers/registry.ts` | which flow answers which trigger |
| `src/engine/ports.ts` | what the nodes need from the host — the key-value store, the wait registry, the AI adapters |
| `tests/engine/` | the engine's suites, one directory per module |
| `tests/engine-boundary.test.ts` | the rule that `src/engine/` imports nothing outside itself but `@frontierjs/toolbelt` |
| `mockup/api-engine/` | the modules later phases replace, kept as the reference they port from — not a member, and its imports of lifted modules no longer resolve |

## What bites here

- **`src/engine/` imports nothing but itself, Node builtins and
  `@frontierjs/toolbelt`**, and `tests/engine-boundary.test.ts` fails the suite
  otherwise. The kit is the one package `FJS-D26` licenses everybody to import;
  a framework package is what the rule is against. A host capability
  reaches the engine as an interface in `ports.ts` or `runtime/`, supplied at
  construction. The reason is cost, not taste: a Junction service in the
  executor's loop is roughly twice a direct litestone write per checkpoint
  (`IDEAS/operational-edge.md` § durable workflows).
- **A pipe step after the first omits the operand the flowing value fills.**
  `{ type: "fn", name: "lower" }` is `lower($)`, and a `map` with no `over` maps
  over `$` — which is why `PipeStep` is its own type, and why the compiler's
  walks read a step as the `Expression` it extends and skip absent branches.
- **The worker pool is not a sandbox.** `vm` inside a worker thread keeps a
  script's scope apart and nothing else; an author reaches the process. The
  `data.code` node is gated at `SYSADMIN(7)` for that reason (`FJS-D272`,
  `FJS-D279`), and the gate is the host's to enforce — nothing in the engine
  does.
- **`workspaceId` is still threaded through the store port.** Tenancy becomes
  `@@tenant` on the host's models in phase 2; until then the node passes it
  through unchanged.
- **A value filled into a condition is a FIELD, never a literal.** The language
  spells `IS NULL` as `x == null`, so a resolved value that is null reads as the
  author having written one and turns `$.a > 1` into a presence test
  (`FJS-1152`). `answerPredicate` binds every hole into a record for that reason.
- **The in-memory queue and store are for the suites.** A crash loses every
  queued run. Caravan and the litestone-backed store replace them in phases 2
  and 3.

## Proving a change

`bun run test` from this directory, then `bun run typecheck`. No drive yet: the
engine has no host until phase 4 installs it into `example/`.
