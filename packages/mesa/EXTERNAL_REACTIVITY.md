# External reactivity in Mesa

**Status:** option 1 (compiler diagnostic) shipped. Options 2–4 still open.
**See also:** `PLAIN_OBJECT_STATE.md` — a fifth option that removes the problem
rather than detecting it: external state as plain objects, reactivity opt-in via
`$:` path watching. Verified feasible.
**Symptom:** an imported signal reads as a plain object — permanently truthy,
never updates, no error.

---

## The mechanism

Inside a component, Mesa knows what's reactive because it compiled the
declaration. `let x` is a signal, `const y` is a memo, `var z` is neither. A
template expression reading `x` is rewritten to track it.

An **imported** identifier is opaque. The compiler sees `connected` and has no
way to know whether it's a signal, a string, or a function — it never compiled
the module it came from.

So the consuming build passes a list:

```js
// sierra/src/build/mesa-plugin.js
externalSignals: {
  '@frontierjs/sierra/router':   ['activeRoute', 'params', 'page', …],
  '@frontierjs/sierra/junction': ['connected', 'reconnecting'],
}
```

Anything on that list is rewritten from `connected` to `connected.get()` in
template expressions. Anything not on it is left alone.

**The list is hand-maintained, lives in a different package from the signals it
describes, and nothing validates it.**

---

## What works and what doesn't

Verified against the current compiler, with `externalSignals: { '…/junction':
['connected'] }`:

| Form | Emitted | Reactive |
|---|---|---|
| `{connected ? 'on' : 'off'}` | `connected.get() ? …` | ✅ |
| `import { connected as isOn }` → `{isOn}` | `isOn.get()` | ✅ |
| `{connected.foo}` | `connected.get().foo` | ✅ |
| `import * as j` → `{j.connected}` | `j.connected` | ❌ |
| re-exported via a local barrel | `connected` | ❌ |
| a name not on the list, same module | `reconnecting` | ❌ |
| **any read inside `<script>`** | `connected` | ❌ |

Two of those are worth stating plainly because they're easy to assume wrong:

- **Aliasing is fine.** The rewrite follows the local binding, not the exported
  name.
- **Script blocks are never rewritten.** `const label = connected ? 'on' : 'off'`
  in a `<script>` reads the signal *object*. Only template expressions are
  rewritten. In a script you must call `.get()` yourself.

---

## Why it's silent

A missed rewrite doesn't produce a broken read — it produces a **static** one.
The expression reads nothing reactive, so Mesa hoists it out of the render
block entirely:

```js
// missed — assigned once, at mount
el0.nodeValue = `${connected ? 'ws connected' : 'ws offline'}`;

// caught — re-evaluated whenever the signal changes
$runtime.render((__prev) => {
  var __a = `${connected.get() ? 'ws connected' : 'ws offline'}`;
  if (__prev.a !== __a) $runtime.set_text(el1, __prev.a = __a);
});
```

A signal object is always truthy, so the common shape —
`{sig ? 'yes' : 'no'}` — renders the true branch forever. It looks like working
code that happens to be stuck.

Grep for `nodeValue =` or `set_attribute(` **outside** a `$runtime.render(...)`
callback to spot these in compiled output.

---

## What it has actually cost

Three instances, all found by running an app rather than by any test:

**`connected` / `reconnecting` were never on the list.** The fullstack smoke
test's badge read "ws connected" with the API stopped, didn't change when it was
killed, and survived a page reload.

**`.value` had three meanings.** Sierra's old signal wrapper exposed both
`.get()` and `.value`. The virtual-module bridge patched `.get` and left
`.value` on the original closure, so `.value` was an untracked read in a script —
and in a template the accessor rewrite turned `{s.value}` into `s.get().value`,
a property lookup on the value object. Same syntax, two behaviours, no
diagnostic. (Removed; signals are Mesa signals now.)

**It isn't verifiable by reading.** Writing
`{countRender('x', page.path)}` for the perf harness, I could not tell whether
it was reactive without running the compiler and reading the output. If
determining liveness requires compiling, that cost lands on every reader.

---

## Options

**1. Compiler diagnostic — SHIPPED.** Warns when a template reads an imported
identifier that `externalSignals` doesn't cover.

Scoped to the high-confidence case: the name comes from a module the map **does**
describe, but the entry omits it. When the module isn't described at all it stays
quiet, because a signal and a constant are indistinguishable at that point — so
this does not catch barrels. It does catch namespace imports, where the member is
a known signal but the access isn't rewritten.

Suppressed for callee position (`{fn(x)}`), event handlers (`on:click={h}`) and
directives, all of which legitimately read imported functions as values.
Measured at **0 false positives across 36 real components** in the two smoke
tests; without the event-handler exclusion it fired on `on:click={toggleTheme}`,
which would have been enough noise to justify turning it off.

`mesa/external-reactivity.test.js` — 16 tests.

**2. Provider-declared signals.** Move the declaration from the consumer's build
config to the producing package — a `package.json` field, or a marker export the
plugin reads:

```json
{ "mesa": { "signals": { "./junction": ["connected", "reconnecting"] } } }
```

Drift becomes structurally impossible, and Mesa stops needing to know anything
about Sierra specifically. Doesn't help barrels or namespace imports, and needs
every publishing package to adopt it.

**3. Naming convention.** Signals get a sigil — `$connected`, as Svelte does for
stores. The compiler rewrites by name pattern, no list at all.

Simplest to implement and fully local: you can see reactivity at the use site,
which is the actual complaint. It's a breaking API change across every package,
and it's a second reactivity notation alongside `let`/`const`/`var`.

**4. Runtime detection.** Rewrite *every* imported identifier read in a template
to something like `$runtime.read(x)`, which returns `x.get()` if `x` looks like
a signal and `x` otherwise.

No list, no convention, no diagnostic — and it handles barrels and namespace
imports, which nothing else does. Costs a function call and a branch per read,
and makes "is this reactive?" a runtime property rather than a compile-time one.

---

## A view

**1 is shipped; 2 is the natural follow-on.** They're complementary and neither
is breaking. 1 turns a silent failure into a loud one, which is the actual
problem. 2 would remove the drift that makes 1 necessary — and would also let 1
widen, because once packages declare their own signals, a read from an
undescribed module becomes suspicious rather than merely unknown.

The gap 1 leaves is the barrel: re-export a signal through a local module and
nothing can tell. That needs 2 or 4.

3 is the cleanest end state and the most expensive to get to. Worth deciding
before the API surface grows further, because the cost only goes up.

4 is tempting for barrels but trades a compile-time property for a runtime one,
which cuts against what makes the `let`/`const`/`var` design good.

Interim, and cheap: `sierra/tests/external-signals.test.js` walks `src/` for
`export const x = signal(...)`, parses the map out of `mesa-plugin.js`, and
asserts they agree in both directions. That closes drift for signals Sierra
itself exports. It does nothing for consuming apps.
