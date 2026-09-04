---
id: scope-checking
status: proposed
dated: 2026-09-03
---

# Proposal — resolving identifiers over a compiled command unit

**Prototyped and measured; not built.** Prompted by
[`FJS-726`](../ISSUES.md#fjs-726), and by the four defects the prototype found
on a tree that was otherwise green.

---

## The failure

`swapContainer` in [`commands/deploy/_module.md`](../packages/cli/commands/deploy/_module.md)
built its `docker run` line with `dockerLogArgs(deployConf)`. Its options are
`{ host, container, image, apiPort, dbPath, envFile, build, log }` — **nothing
binds `deployConf`**. Every real `fli deploy` threw `ReferenceError` while
building that line, which is *after* the rename and the stop, so the deploy took
the running app down and never brought it back. `_steps-revert/03-swap` calls the
same function, so the documented way back was broken identically.

Nothing in the tree could see it. **Four things had to be true at once, and each
of them is a rule this repo keeps on purpose:**

- **The parse sweep parses the wrong artefact.** `tests/compiler.test.js`
  compiles every command with an *empty* namespace module — `compileCli(src, '', file)`
  — but the runtime compiles it with the namespace's `_module.md` script prepended
  ([`core/runtime.js`](../packages/cli/core/runtime.js), `Command()` and
  `runOneStep`). The sweep therefore parses a file that never runs.
- **A parse is not a resolve.** `FJS-269` is the same sentence one layer up:
  `fli check` had never executed at all because of a free `resolve`, and its
  suite was green throughout.
- **Every caller reads correctly on its own.** Both call sites destructure a
  `deployConf` of their own, so the mistake is invisible at either end and only
  exists at the join.
- **Only one thing in the repo runs `fli deploy`** — `deployJournalCycle` — and
  it was dying on this line, so the ten assertions past it had never executed.

This is Invariant 15 (*a clean compile is not proof of valid JS*) with the word
*valid* doing more work than it can carry: the output parses, and the identifier
resolves to nothing.

## What it would be

One pass, over **the compiled unit the runtime actually builds**: namespace
module script prepended, prose transformed, fences hoisted. Parse it, walk it,
resolve every identifier reference against real lexical scopes, and report the
names bound nowhere and known to no global.

Two findings fall out of the same pass and both are real:

| finding | what it is |
| --- | --- |
| **free identifier** | a name used and bound nowhere — `FJS-726`'s shape |
| **duplicate declaration** | the namespace module and the command both declare a name; one module, so it is a `SyntaxError` and the command never loads |

## The measurement

A prototype (acorn, ~150 lines, in the scratchpad) over **237 compiled command
units**. It found **four live defects on a green tree** — full suite, `fli check`,
the parse sweep, and CI all passing:

| | command | measured |
| --- | --- | --- |
| free `loadEnv` | `auth:list-users`, `auth:create-user`, `auth:revoke-sessions`, `auth:rotate-key` | `✗ loadEnv is not defined` — and the call was redundant twice over: `bootstrap.js` already loads the project `.env`, and the real `loadEnv` takes a positional path rather than `{ path }` |
| free `resolve` | `make:schema` | `✗ resolve is not defined` — inside `await import(…).catch(…)`, where the throw is evaluating the *argument* and the `catch` never sees it. The imported binding was unused: dead code that broke the command |
| free `readFileSync` | `auth/_module.md`'s `requireAuthInstalled` | latent — the helper is called nowhere, so it is a trap rather than a break |
| duplicate declaration | `db:schema` | `✗ Identifier 'existsSync' has already been declared` — the command could not load at all, and neither could it after that for `resolve` |

Behind the `loadEnv` throw sat a fifth, which only became reachable once the
first was fixed: all four auth commands generate `createClient('<path>', {…})`
with `encryption: { key }`, and the shipped signature is `createClient({ path,
encryptionKey })`. **Two defects stacked in one command is this class's normal
shape** — it is what `FJS-726`/`FJS-727` were — because code nothing has ever run
accumulates faults in layers, and only the outermost is visible.

All five are fixed. The prototype now answers **0 free identifiers and 0 parse
failures across 237 units**, which is the condition a rule needs to be
adoptable: it goes in at zero rather than at a baseline.

## Three things the prototype had to get right, each measured

**1. The unit is the namespace join, not the file.** Resolving the namespace
from the step's own frontmatter title — steps carry titles like `06-swap`, not
`deploy:swap` — makes every `_module.md` helper read as free from every step:
**27 distinct names instead of 0**. The rule has to model what the runtime does:
`mod` comes from the *orchestrator's* namespace and steps inherit it.

**2. A flat "declared anywhere in the module" check would have missed
`deployConf`.** It is a parameter of three *other* functions in the same file
(`resolveDeployConf`, `resolveSide`, `deployPlan`), so a set-membership test —
which is what my first regex heuristic was, and why it reported a false negative
— answers *bound*. **This class needs real scope chains or it needs nothing.**

**3. The globals list is the whole of the false-positive budget.** `zx/globals`
injects ~30 names, and the honest way to build the list is to import it and read
`globalThis`, not to write one down: `loadEnv` *looks* like a zx global, and
asking the runtime is what proved it is not.

## Where it would live

`core/checks.js`'s shape exactly — **one engine, two callers**. Command files are
not only fli's: `core/registry.js` scans `projectRoot/cli/src/routes/`, so an app
can write its own, and an app's command has every one of these hazards with none
of this repo's review. So: a `core/scope.js`, a `fli check` rule over an app's
commands, and the `structure` CI phase running the same function over fli's own.

**The cost is a parser, and that is the only real decision.** `packages/cli`
already ships four runtime dependencies, and acorn is in the tree twice
(`packages/mesa`, `packages/ui`). But `core/checks.js` is deliberately reachable
before install, and a rule that cannot run on a broken tree is worth less than
one that can. Three options, in the order I would try them:

1. **acorn as a `packages/cli` dependency.** ~120 KB, no transitive deps.
   Simplest, and the `advisories` phase already grades what a published package
   pulls in.
2. **Bun-only, in the test suite rather than in `fli check`.** Costs nothing and
   catches everything in *this* repo, and gives an app nothing.
3. **Mesa's own parser.** It has one, and importing it inverts nothing formally
   — but it would make the CLI depend on a UI package to check its own commands,
   which is worse than a dependency on acorn.

## What it cannot answer

Worth stating, because a checker that is believed to cover more than it does is
how the next `FJS-269` survives:

- **A property is not an identifier.** `context.confg` resolves; only bare names
  are graded.
- **Dynamic access.** `global[name]`, `globalThis.x`, anything behind a string.
- **TDZ and hoisting order.** `use before let` is a runtime error a scope walk
  that ignores position will call bound. Deliberate, for now — it is a different
  and much rarer defect.
- **A name bound to the wrong thing.** Two functions with a `deployConf`
  parameter and one of them wrong is exactly what this *does* catch; two
  functions where the value is wrong is not.

## Related

- [`FJS-726`](../ISSUES.md#fjs-726) — the free identifier that broke every deploy.
- `FJS-269` — `fli check` itself, unexecutable for the same reason.
- Invariant 15 — *a clean compile is not proof of valid JS*. This is the next
  question after that one: a clean parse is not proof of a resolvable module.
