# Changes — @frontierjs/orion

## 2026-09-14 — a flow expression can be written as text

`src/engine/expression/text.ts`. `compileExpression('$.trigger.body.amount > 100
&& $.lead.data.tier == \'gold\'')` parses with the parser a `.lite` policy is
parsed with (`FJS-D271`) and hands back the `Expression` the resolver already
runs. Until now the engine had no text form at all, while the UI mockup assumed
one.

**The halves split where the rulings split them.** A path, a call and a lambda
(`FJS-D284`–`FJS-D286`) compile to the engine's own nodes — `ref`, `fn`, `map`,
`filter`, `reduce`, `cond` — and run on its function table. A comparison, `&&`,
`||` and `!` compile to one new `predicate` node holding the parsed tree, which
`@frontierjs/toolbelt/predicate` answers in SQLite's three-valued logic, so an
edge condition and a row policy written the same way agree. `null` is unknown
and is falsy, so an edge whose condition is unknown does not fire.

**A filled value is a FIELD, never a literal.** The language spells `IS NULL` as
`x == null`, so a resolved value that happened to be null read as the author
having written one and turned `$.a > 1` into a presence test answering true. The
same branch answers every non-`==` operator that way for a real policy, which is
[`FJS-1152`](../../ISSUES.md#fjs-1152), filed while fixing this.

**The engine may import `@frontierjs/toolbelt` and nothing else.** `FJS-D26`
licenses it — pure functions below the dependency graph — and
`tests/engine-boundary.test.ts` now says so, with a framework package, a
third-party package and an escape as its negative controls.

## 2026-09-14 — the engine lifted out of the mockup

Phase 1 of `IDEAS/orion-port.md`, first half. The modules the plan keeps moved
from `mockup/api-engine/src/` to `src/engine/` with `git mv`: types, compiler,
expression, executor, runtime, cache, plugins, the built-in nodes, the code
worker pool and the trigger registry. The package is a workspace member now,
private, with `bun run test` and `bun run typecheck`.

**The nodes no longer import the modules later phases delete.** They took
`KVStore`, `WaitRegistry` and `AIProviderRegistry` as concrete classes over the
mockup's own SQLite and vendor code; `src/engine/ports.ts` states what they
need as interfaces, and the node suite runs against in-memory fakes of those.
The suite had been failing its setup under bun, because it opened a `sql.js`
database that was never installed, so 25 of its 55 tests ran; all 55 run now.
The OpenAI-shaped test became a stubbed provider, since vendor adapters are the
host's (`FJS-D153`).

**Typecheck found the expression type wrong, not the tests.** A pipe step after
the first may omit the operand the flowing value fills — the resolver always
handled it, and seven tests exercised it — but `Expression` required `args` and
`over`, so it is `PipeStep` now. `JSONSchema` gained the fields the built-in
descriptors already carried (`description`, `enum`, `default`, `format`), and
`NodeContext.fetch` is the call a node makes rather than bun's `fetch` object,
which also carries `preconnect`. A test compiling a flow with
`{ source, target }` edges now writes `{ from, to }`; it refused an unknown node
type before the edges mattered, so it passed either way.

`tests/engine-boundary.test.ts` is the enforcer for the engine rule: every import
under `src/engine/` is relative and stays inside it, or a Node builtin. It grades
itself on a synthetic source naming a framework package, a third-party package
and an escape.

Not carried: the event bus suite (20) and the cron, router and activator parts of
the triggers suite (45), which stay with their modules in `mockup/` until phase 4
replaces them. 349 engine tests and 3 boundary tests.
