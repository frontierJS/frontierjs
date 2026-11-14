# Errors and warnings

The compiler collects two lists. An **error** means the output is wrong and must
not ship. A **warning** means the build succeeds and the code probably does
something other than what you meant. Both reach the `warning` callback and
`ctx.analysis.errors` / `ctx.analysis.warnings` (see [compiler](compiler.md)). The
Vite plugin turns an error into the browser overlay and prints a warning in the
terminal.

Some mistakes are caught earlier, while parsing. Those throw at once, and the
message carries `File.mesa:line:column`. They are marked *throws* below.

The messages here are shortened. Each one names the thing you wrote.

## Errors

### Reactivity

| You wrote | The message says | Fix |
|---|---|---|
| `const a = b`, `const b = a` through reactive state | `Circular dependency: a → b → a` | Break the loop. One of the two should be a `let` you assign |
| Assigning to a derived `const` | `'d' is a derived 'const' … cannot be assigned` | Assign the state it reads, or declare it `let` |
| Assigning to an `export const` prop | `'x' is declared export const — a read-only prop` | Declare it `export let` |
| `$:` inside a function, block or callback (*throws*) | `'$:' is top-level only (RULE 1)` | Move it to the top level of `<script>` |
| `$: if (...)`, `$: for (...)` | `'$: if ...' is not a valid Mesa reactive form` | Wrap it: `$: { if (...) { ... } }` |
| `$: { a }`, a block that only reads | `'$: { n }' does nothing` | Drop the braces, or add a handler: `$: n, () => { ... }` |
| A top-level `$context` use inside a function | `Context provides and consumes must be at the top level` | Move it to the top level of `<script>`. Use `context.use` and `context.provide` from the runtime inside functions |
| `$async.x` where `x` is not an awaited top-level `const` or an `async function` | `` `$async.n` names no async state `` | Declare `const x = await …` at the top level |

### Props and bindings

| You wrote | The message says | Fix |
|---|---|---|
| `bind:x` on something that is not a top-level `let` | `'x' must be a writable top-level let` | Bind a `let`. For a derived value use `$: name = expr` |
| `bind:value` on a `var` | `cannot two-way bind: var v is outside the reactive graph` | Declare it `let` |
| `bind:this` on a `const` or other non-`let` | `'el' must be a top-level let variable` | Declare `let el = null` |
| `bind:group` on a non-`let` | `'g' must be a top-level let variable` | Declare it with `let` at the top level |
| `bind:value\|mask` with no pattern | `bind:value\|mask requires a pattern argument` | `bind:value\|mask({"99/99/9999"})={value}` |
| `export default`, `export *` or `export { … }` in an instance script | `an instance <script> exports only props … and methods` | Use `export let`, `export const`, `export var` or `export function`. Put module exports in `<script module>` |
| `<slot foo="x" />` | `<slot> takes no attributes` | Only `name` is allowed. To pass a value out, use `{@render children?.(value)}` |

### Events

| You wrote | The message says | Fix |
|---|---|---|
| `on:click={fn}` or `@click={fn}` (*throws*) | `'on:click' is not an event spelling Mesa compiles` | Write `onclick={fn}` |
| `once`, `passive` or `capture` on a component | `a component has no listener of its own to set it on` | Put it on the element inside the component |

### Builtins and names

| You wrote | The message says | Fix |
|---|---|---|
| `$.mounted(...)` twice | `$.mounted() may only be called once per component` | Use `Promise.all` inside one call |
| `const { x } = $`, `const d = $` (*throws*) | `'$' cannot be destructured` | Reach through it: `$.onMount` |
| A declaration named `$`, `$$x` or `__anchor` (*throws*) | `'$$x' cannot be declared` | Rename it. The `$$` prefix and the three `__` names are the compiler's |
| `$` inside `<script module>` (*throws*) | `'$.inspect' is not available in <script module>` | Import from `@frontierjs/mesa/runtime` |
| `$.after` or `$.every` inside a function (*throws*) | `is declared at the top level of <script>` | Declare it at the top level and gate it with `when` and `key` |

### Markup

| You wrote | The message says | Fix |
|---|---|---|
| `<mesa:frobnicate>` | `is not a Mesa element. Known: boundary, mounted, element, window, document, body, portal, head` | Use one of the listed names |
| `<icons.Star />` | `a namespaced component name must be capitalized` | `<Icons.Star />` |
| `<li>` or `<p>` left unclosed, an unclosed `{#each}` (*throws*) | `</ul> closes nothing here — <li> is still open` | Close every non-void element. `<br>` and `<span />` are fine |
| `{@attach f}` in text content | `{@attach} is an element directive` | Put it inside an element's tag |
| A repeated `let` name (*throws*) | `<script> does not parse` | Rename one |

## Warnings

| What you did | The message says | Fix |
|---|---|---|
| `setTimeout` or `setInterval` in a script | `A raw timer is not on Mesa's clock` | `$.after`, `$.every`, or `await $.sleep(ms)`. A `clear*` call is quiet |
| A `const` that reads state, and nothing reads it | `'log' never runs` | Write `var log = …` to run at mount, or delete it |
| Reading `user.age` from an imported object with no watch on it | `no '$: user.age' watch covers it` | Add `$: user.age`, or copy it into a `var` if it never changes |
| `$: user.name` beside `$: user` | `'$: user.name' is redundant` | Remove the narrower watch |
| `const v = h.value` where `h` came from a call | `is read once, when the component is set up` | `$: v = h.value` to follow it, or destructure at the call |
| Reading `s.x` off `import * as s` | `namespace imports are not rewritten` | `import { x } from './s.js'` |
| A signal read from an import not listed in `externalSignals` | `is read in the template but is not declared in externalSignals` | Add the name to the `externalSignals` entry |
| `<mesa:boundary>` that reads no async value and has no `failed` snippet | `neither waits nor catches` | Read the awaited value inside it, or add `{#snippet failed(error, reset)}` |
| The same boundary snippet defined twice | `snippet 'x' is already defined by another boundary` | Define it once, outside all boundaries |
| `<mesa:mounted>` with no `$.mounted` call or `mount=` | `requires a $.mounted(fn) call or mount={expr}` | Add one |
| `<mesa:mounted mount={false}>` | `statically false. Template omitted` | Remove the element or the dead branch |
| `<style>` or `<script>` inside a block | `must be at the top level … DROPPED` | Move it to the top level of the component |
| `{@foo …}`, an unknown template tag | `Unknown template tag … dropped` | Known tags are `{@render}`, `{@html}`, `{@const}`. `{@attach}` goes in an element's tag |
| `const { a, ...rest } = obj` | `Rest element in destructuring is not expanded` | The line runs as plain JavaScript. Destructure the keys you need |
| A computed key in a destructuring | `cannot be statically expanded` | Read it as `source[key]` |
| A call on an imported function's result in the template | `compiles to a static value` (with `externalReactivityHints: 'strict'`) | Hold the call in a `const` and read the member of that |

A warning never fails the build. The Vite plugin also writes each one into the
compiled module as a `// ⚠ Mesa:` comment.

## Runtime warnings

A `[Mesa]` console message is a render the framework survived but corrupted. For
example, `onCleanup() called with no owning scope` means the callback will never
run. A drive treats any `[Mesa]` warning as an error. See
[Testing](../misc/testing.md).

---

Spec: [VISION.md § 20](../../VISION.md#20-compiler-rules-and-errors) · RULE 53
