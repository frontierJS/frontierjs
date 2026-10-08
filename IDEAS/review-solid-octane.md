---
id: review-solid-octane
status: proposed
dated: 2026-09-23
---

# Idea — Solid 2 and Octane read against Mesa: nine pillars, two questions

**An outside comparison of two renderers, used as an instrument on a third.** Alec
Larson set Solid 2 against Octane on nine developer-experience pillars
([scorecard](https://gist.github.com/aleclarson/0f4266d63fd83c7a5ea5512441bbea0c),
[pillars](https://gist.github.com/aleclarson/64308585a36fe65692149b9cd2f59475)), and
the thread that followed between the two frameworks' authors narrowed it to two
questions ([summary](https://gist.github.com/aleclarson/829c10aa7d287944ef75e1c2a90bef06)):
**what does a read mean in the source**, and **what does the runtime still know**.
Mesa is the answer neither side argued — Svelte's — and the pillars grade it.

## The two questions

| | Solid 2 | Octane | Mesa |
| --- | --- | --- | --- |
| What a read means | A read establishes a dependency | Two tiers. Local `useState` state is ordinary arithmetic and the component reruns; shared state is `signal$` / `derived$`, read as `x$.get()`, with the `$` suffix required on anything live | Ordinary, in both tiers. `let` / `const` / `var` carry the intent and the compiler finds the dependencies (VISION §2) |
| What the runtime knows | The live graph | Local tier: source-linked evidence. Signal tier: a graph whose nodes carry a stable identity from their source position | A live graph — `_deps` and `_subs` on every node in `runtime.js` |

Octane's tiers are from its own documentation
([signals](https://octanejs.dev/docs/signals), read 2026-09-23), not from the
thread, which argued the local tier alone.

**Mesa keeps Octane's local-tier source for all state and Solid's runtime, and pays
for each.** Octane's author's objection to Solid — that whether a read is live
depends on context the source does not show — lands on Mesa at the import boundary:
a member read with no `$:` watch is hoisted static and never updates, with nothing
said (`docs/EXTERNAL_REACTIVITY.md`, three shipped instances). Octane answers the
same objection for its shared tier with a sigil, `$` on every live name, which is
option 3 in that document and the one Mesa did not take. Solid's author's argument —
the live graph answers *why did this update* — is available to Mesa and unclaimed:
`__dev` records signals and an update log, and no edge, no pending state, no cause
(`FJS-1324`).

## The nine pillars

| Pillar | Mesa | On what |
| --- | --- | --- |
| State architecture freedom | **Mixed** | Shared state is plain JS with no store API (§5). Derived state has no home outside a component — see *Open questions* |
| Reactive reasoning | Good | Declared intent per keyword; `$: deps, handler`. Weak at the import boundary above |
| Derived state | Strong | A `const` re-derives by itself; a derived `const` is lazy, so a side effect in its initializer may never run (`FJS-D212`) |
| Async | Good in a component | `const x = await f(dep)` re-runs, aborts the previous call, and publishes `$async.x`. Whether a downstream `const` stays colorless while `x` is pending is unmeasured; `derived-suspense.md` is the boundary half |
| Component authoring | Strong | Svelte 4 parity is the stated target (VISION §1) |
| Escape hatches | Good | `var`, `{@attach}`, `<mesa:mounted>`, `bind:this`, `createRoot` |
| Ecosystem | Weak | Its own language, no React compatibility; the stack is supplied instead |
| Tooling | Middling | Source maps, click-to-source, the language server, `$.inspect`, a signal panel. No causal view |
| Architectural scaling | Strongest | The pillar's ideal — domain → reactive layer → UI — is `schema.lite` → the Resource → `.mesa`, as a layout rather than a discipline |

## Reactivity in `<script module>` — what option B costs

### What happens today

**The module block is copied through as text and never parsed as Mesa**
(`compiler.js`, the `root` xNode that writes `moduleScript.split('\n')`). Measured
2026-09-23 against the current compiler:

```html
<script module>
  let count = 0
  export function bump() { count++ }
</script>
<script>
  const twice = count * 2
</script>
<p>{count} {twice}</p>
```

compiles to a plain module-scope `let count = 0` and one `nodeValue = …` assigned
at mount. `bump()` moves nothing on screen, and nothing warns. It is the
static-hoist failure `EXTERNAL_REACTIVITY.md` describes, reached from inside the
file rather than across an import.

How an IMPORTED name is read today, measured the same day:

| In the importing component | Emitted |
| --- | --- |
| `{canEdit()}` in the template | inside `$$runtime.render(…)`. **Reactive**: a call runs in the render effect, so any signal the function reads is tracked |
| `{sel.id}` in the template | `nodeValue =` once. Static |
| `const ok = canEdit()` in the instance script | computed once. Static |

### Half 1 — reactivity inside one file

**A module-scope `let` is a signal and a `const` that reaches one re-derives,
shared by every instance of the component.** Most of it exists:

- **The runtime needs nothing.** `track()` and `trackDerived()` work at module
  scope; `createMemo` is lazy and needs no owner.
- **Classification is reusable.** `analyzeScript(raw, ast)` takes any script, so
  the module block's `let` / `const` / `var` classify by the instance rules.
- **The read rewrite is map-driven.** `rewriteExpr(expr, accessorMap, setterMap)`
  rewrites whatever its maps name, so adding the module's names to the instance
  maps reaches the instance script and the template with no new pass.

What is new:

- Emit the module block from its AST instead of as text, with its source map.
- Rewrite writes inside module-block functions, so `count++` there becomes
  `set()`. `rewriteAssignments` is the owner.
- Emit module-scope signals without `__block`, under names that cannot collide
  with instance ones (`moduleScopeNames` already guards the other direction).
- Refuse `$:` and a top-level `await` in a module block by name for V1, rather
  than letting either fall back to plain JavaScript.
- A `test/browser/runtime/` spec: two instances of one component share the
  signal, and a write from a module-block function repaints both.

**Sized at a day or two.** The risk is emission from the AST, not the reactivity.

### Half 2 — across files

**Pillar 1 needs this half, and it is a design question, not a work item.** A
page writes `import { canEdit } from './Doc.mesa'`, and the compiler compiling
the page cannot see that `canEdit` is a signal — the import boundary
`EXTERNAL_REACTIVITY.md` settled for Sierra by exporting no signal at all.
The three answers are the second open question below.

### Hazards either way

- **One process, every render.** A module-scope signal is shared by every render
  in a process. A static prerender is one build and safe; a per-request server
  render would share one user's state with the next. Making the scope reactive
  invites putting per-user state in it, so the rule must be stated where the
  feature is. **Octane solves this rather than stating it**: a module-level
  `signal$` resolves to document-local state in the browser and request-local
  state on the server, keyed by the declaration's source identity, and a server
  read or write outside a request owner is refused. The same shape is open to
  Mesa: a declaration key can be derived the way scope ids already are
  (Invariant 12), and a server read with no request owner would be refused by
  name instead of forbidden by a sentence. It needs a request owner on Mesa's
  server render, which does not exist today.
- **Every existing module block changes meaning.** A module-block `let` that is
  plain today becomes a signal. No back-compat is owed (pre-alpha), but every
  Resource file in `example/`, `basecamp` and the prototypes compiles differently,
  so the suites and the drives are the check. A `const` that reaches nothing
  movable stays static, and `export const orders = createResource(…)` is that
  case.
- **HMR** re-runs the module and mints new signals, so an instance still holding
  the old ones reads a graph nothing writes. Whether the instance swap
  (`mesa-vite/swap.js`) carries that is unmeasured; the vite drive is where to
  prove it.

## Open questions

- **`FJS-D371` — Does RULE 51 stand: must derived state live in a component?**
  VISION RULE 51 says reactive logic does not belong in a `.js` module — a store
  holds state and the functions that write it, and deriving happens in a component
  or at the write site. The pillar it meets is the one the comparison weights
  heaviest: a derivation chain that belongs to the domain (selection → permissions
  → command availability) has no home outside a component. **Measured 2026-09-23**:
  a `const` in `<script module>` compiles to plain module-scope JavaScript and is
  computed once, so the Resource file — the one place outside a component the
  layout already provides — cannot derive either. The road is being kept: `example/`
  and `basecamp` write no `createMemo` or `createEffect` in a `.js` module, and
  the framework's own (`sierra/src/resource/list.js`, `router/signals.js`,
  `ui/dnd.js`, jetty's `mesa-bridge.js`) create signals as sources rather than
  derive.
  - **A** — RULE 51 stands. A derivation shared by two components is computed at
    the write site; the chain above is written as a function of the store and
    called in each component.
  - **B** — `<script module>` gets the instance script's semantics: a top-level
    `let` is a signal and a `const` that reaches one re-derives, once per module
    rather than per instance. RULE 51 narrows to plain `.js` files.
  - **C** — RULE 51 is withdrawn: `createMemo` in a `.js` module is blessed and
    documented as the way to share a derivation.
  - **Recommend B** — it is the same three keywords with the same meaning one
    scope out, so it teaches nothing new, and it puts domain derivation in the
    file the layout already assigns to the domain (Invariant 18). A leaves the
    heaviest-weighted pillar mixed by rule. C opens a second spelling of
    derivation (`createMemo` beside `const`), which is the concept cost RULE 51
    exists to refuse. The cost of B is that module-scope reactivity needs an owner
    and never disposes, which `createRoot` (RULE 54) already names. B is Half 1
    above; Half 2 is the question below.

- **If B: how does a module-block signal cross an import?** Only open if
  `FJS-D371` rules B. The measured table under *What happens today* is the input:
  a call in a template is already tracked, while a bare read and an instance
  `const` are not.
  - **A** — An exported reactive value is emitted as an accessor function, and an
    importer writes `canEdit()`. The template already tracks it; RULE 2 grows one
    case: a `const` calling an import from a `.mesa` file can move. It costs a
    name spelled `x` in its own file and `x()` everywhere else.
  - **B** — The compiler reads the imported `.mesa` file's module block and learns
    which exports are signals: the `externalSignals` map, derived instead of
    written, which retires the drift that map was criticized for. It needs the
    Vite plugin to hand the compiler a resolver. A barrel re-export is blind to
    it, so a re-exported `.mesa` name needs a warning.
  - **C** — An exported reactive value is refused by name; only functions
    export. Half 1 is then the whole feature, and pillar 1 stays mixed across
    files.
  - **Recommend A** — fewest moving parts: no cross-file analysis, and the
    tracked call is what the template already does. Move to B if the `()`
    proves a real cost in `example/`, which is a measurement rather than an
    argument.
