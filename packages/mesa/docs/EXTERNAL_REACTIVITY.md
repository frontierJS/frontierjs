# External reactivity in Mesa

**Status: settled by option 5, 2026-08-10.** Sierra exports no module-level
signal and passes Mesa no `externalSignals` map at all — its state is the plain
objects `page`, `status` and `theme`, made reactive per component with a `$:`
path watch (`PLAIN_OBJECT_STATE.md`, `FJS-060`). Options 2–4 below are therefore
**not open questions any more, they are alternatives that were not taken**; they
are kept because the reasoning is what makes the choice legible, and because
`externalSignals` still exists as an app-facing escape hatch for a third-party
package that does export a signal.

**Two things the migration nearly got wrong**, both now handled:

- **It moved the silent failure rather than removing it.** A plain-object read
  with no `$:` watch is hoisted out of the render block exactly as a missed
  signal rewrite was — assigned once at mount, never updated, no error. The
  syntax changed; the failure did not.
- **And the replacement was QUIETER than what it replaced.** Option 1's
  diagnostic fires whenever the map describes the module. The path-watch tier's
  default confidence fires only when the file already watches some other path on
  the same import — which says nothing about a component that watches nothing at
  all, and that is the shape that shipped the `connected` bug. `strict` closes
  it, and Sierra's plugin now passes it. Measured over 218 real components in
  the FrontierJS repo: 4 warnings before the migration was finished, all on a
  schema-fixed gate level, 0 after.

**Symptom (historical):** an imported signal reads as a plain object —
permanently truthy, never updates, no error.

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

## What was chosen

**5, with 1 kept as its guard rail.** A framework that exports no module-level
signal has nothing to declare, so 2's drift, 3's breaking rename and 4's runtime
cost all become questions nobody has to answer. `page`, `status` and `theme` are
plain objects; a component states the paths it depends on, which is the same
`let`/`const`/`var` decision made at the use site rather than at the declaration.

**The barrel gap goes with it.** 1 could never see a signal re-exported through a
local module. There is no signal to re-export.

What 5 costs, and it is not nothing: the failure mode survives the change — a
member read with no watch is still hoisted static — so option 1's diagnostic
had to grow a second tier and Sierra had to opt into its strict setting. A
migration that had stopped at "the map is empty" would have shipped a quieter
bug than the one it set out to fix.

2, 3 and 4 stay written down because a package outside this repo can still export
a signal, and `externalSignals` is still the answer for it.

The drift test that guarded the map is gone with the map.
`sierra/tests/no-module-signals.test.js` replaced it and asserts the stronger
thing: `src/` exports none, and the plugin declares none.
