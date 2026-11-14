# Every rule

The language spec numbers its rules. Each row is a one-line summary and a link to
the section of [VISION.md](../../VISION.md) that states it in full.

| Rule | Summary | Section |
|---|---|---|
| 1 | `$:` is top-level only. A nested one is a compile error | [4.8](../../VISION.md#48-compile-errors) |
| 1b | An instance script runs in source order. A declaration is pulled up only when something already emitted needs it | [2](../../VISION.md#2-top-level-variable-semantics) |
| 2 | A `const` that reads reactive variables is derived | [2.2](../../VISION.md#22-const--derived--static) |
| 3 | Every reactive variable used in a template is wired automatically | [2](../../VISION.md#2-top-level-variable-semantics) |
| 4 | Scoped variables are never tracked, but can read and write top-level state | [2](../../VISION.md#2-top-level-variable-semantics) |
| 5 | All Mesa source and compiler output is valid JavaScript | [1](../../VISION.md#1-design-philosophy) |
| 6 | Path watching uses optional-chaining semantics: `?.` is soft, none is hard | [4.1](../../VISION.md#41-watches--making-inert-state-observable) |
| 7 | In a watch with a handler, the handler is last and outside the parentheses | [4.2](../../VISION.md#42-effects-with-explicit-dependencies---deps-handler) |
| 8 | Shared state is plain JavaScript. A `$:` path makes it reactive per component | [5](../../VISION.md#5-shared-state--plain-javascript-modules) |
| 9 | Store files cannot import component files. Not checked by the compiler | [5](../../VISION.md#5-shared-state--plain-javascript-modules) |
| 10 | A circular reactive store import is an error | [5](../../VISION.md#5-shared-state--plain-javascript-modules) |
| 11 | Static paths become targeted accessors. Dynamic paths become runtime effects | [14](../../VISION.md#14-dynamic-paths-and-runtime-effects) |
| 12 | A template path is an ordinary expression. A nullish value renders empty | [14](../../VISION.md#14-dynamic-paths-and-runtime-effects) |
| 13 | `var` reads without subscribing and writes without notifying | [6](../../VISION.md#6-var-in-the-component--non-reactive-sampling) |
| 13a | `bind:` on a `var` is a compile error that names `oninput` | [3.4](../../VISION.md#34-bind-validity) |
| 14 | A `let` initializer is a snapshot. Use `$: name = expr` to keep deriving | [2.1](../../VISION.md#21-let--mutable-reactive-state) |
| 14a | A writable derived override is temporary. A dependency change wins back | [4.5](../../VISION.md#45-writable-derived---name--expr) |
| 14b | `$: (a, b)` is a multi-path watch. `$: { }` is an auto-tracked block effect | [4.4](../../VISION.md#44-ordered-watch-groups) |
| 15 | Components are ES modules, so top-level `await` is valid | [13.1](../../VISION.md#131-top-level-await) |
| 16 | `$async.x` exists for a top-level `const x = await …` and a top-level `async function x()` | [13.2](../../VISION.md#132-async-state-object) |
| 17 | A non-`const` reactive variable can be assigned any time. Last write wins | [13.3](../../VISION.md#133-optimistic-updates) |
| 18 | Builtins are reached through `$`, with no import | [17](../../VISION.md#17-built-in-functions-the--door) |
| 18a | `$` cannot be destructured, aliased or shadowed | [17](../../VISION.md#17-built-in-functions-the--door) |
| 18b | `$` does not exist in `<script module>` | [11](../../VISION.md#11-module-script--script-module) |
| 18c | `$props`, `$attributes`, `$slots`, `$context` and `$async` have a canonical bare spelling | [17](../../VISION.md#17-built-in-functions-the--door) |
| 18d | Four prefixes: `$`, `$:`, `$$` and `__`. The whole `$$` prefix and the three `__` names are reserved | [17](../../VISION.md#17-built-in-functions-the--door) |
| 18e | `$class` and `$dom` are protocol names, never authored | [17](../../VISION.md#17-built-in-functions-the--door) |
| 19 | On a server, signals are synchronous, `$.onMount` does nothing and `$context` is per instance | [19.3](../../VISION.md#193-ssr-notes) |
| 20 | There is no hydration. An island is a fresh `mount()` into a marked range | [19.3](../../VISION.md#193-ssr-notes) |
| 21 | The compiler targets `@frontierjs/mesa/runtime` | [1](../../VISION.md#compiled-output-strategy) |
| 22 | `bind:` is valid only on `export let` props | [3.4](../../VISION.md#34-bind-validity) |
| 22a | On an element, `bind:` is `value`, `checked`, `files`, `group` and `this` | [10.1](../../VISION.md#101-two-way-binding--bindvalue) |
| 23 | One event spelling, `onclick={fn}`, with modifiers piped on | [8.2](../../VISION.md#82-component-events) |
| 24 | `bind:group` needs a top-level `let` | [10.3](../../VISION.md#103-group-binding--bindgroup) |
| 25 | `$context` provides and consumes are top-level in the script | [7.1](../../VISION.md#71-providing-context) |
| 25a | A `const` consumer tracks the provider. A `let` initializes at mount. A `var` snapshots | [7.4](../../VISION.md#74-instance-isolation-vs-stores) |
| 25b | `$context.<key>` is a compile step, so script-only. `context.use` and `context.provide` work anywhere | [7.4](../../VISION.md#74-instance-isolation-vs-stores) |
| 26 | `client:*` is stripped by the compiler. `islands: true` marks it in a server render | [18.6](../../VISION.md#186-client-directives) |
| 27 | `{#key expr}` destroys and recreates its content when `expr` changes | [9.4](../../VISION.md#94-key-block--key-expr) |
| 28 | `{#snippet}` defines a template fragment. `{@render}` mounts it | [9.5](../../VISION.md#95-snippets--snippet--render) |
| 29 | Snippets close over outer reactive variables. Arguments are plain values | [9.5](../../VISION.md#95-snippets--snippet--render) |
| 29b | Every non-void element closes explicitly. HTML's optional end tags are a parse error | [10](../../VISION.md#10-template-element-directives) |
| 30 | `<script module>` runs once at module load, shared by all instances | [11](../../VISION.md#11-module-script--script-module) |
| 31 | `class="…"` on a component is forwarded to the child's class prop | [10.8](../../VISION.md#108-class-prop-passthrough) |
| 31a | `$class` is a protocol name. Use `{class}` or `bind:class` on the child element | [10.8](../../VISION.md#108-class-prop-passthrough) |
| 31b | `bind:class` on an element is a compile error. `{class}` is the merging form | [10.8](../../VISION.md#108-class-prop-passthrough) |
| 32 | `bind:class` and `{class}` on an element wire the parent's class through | [10.8](../../VISION.md#108-class-prop-passthrough) |
| 33 | `{@html expr}` injects raw HTML. Use it on trusted content only | [10.7](../../VISION.md#107-raw-html--html) |
| 34 | `{#virtual each}` takes `height` and `viewport`. Variable row height is not supported | [9.7](../../VISION.md#97-virtual-list--virtual-each) |
| 35 | Snippet props are `export let`. `<slot />` is the preferred way to receive content | [9.6](../../VISION.md#96-slots--slot-) |
| 35a | `children` with `{@render children?.(value)}` is the form for content the child parameterizes | [9.6](../../VISION.md#96-slots--slot-) |
| 35b | `<slot>` takes no attribute but `name` | [9.6](../../VISION.md#96-slots--slot-) |
| 36 | `bind:this` on a component exposes exported props and functions, never a DOM node | [10.2](../../VISION.md#102-element-reference--bindthis) |
| 37 | `$.mounted(fn)` appears once per component | [12.6](../../VISION.md#126-mesaboundary-and-mesamounted) |
| 37a | `$.mounted(fn)` is wired by name: `const ready = $.mounted(fn)` | [12.6](../../VISION.md#126-mesaboundary-and-mesamounted) |
| 38 | `<mesa:mounted>` gates the whole component template | [12.6](../../VISION.md#126-mesaboundary-and-mesamounted) |
| 39 | `onerror` on `<mesa:mounted>` runs on rejection, apart from the `failed` snippet | [12.6](../../VISION.md#126-mesaboundary-and-mesamounted) |
| 40 | `<mesa:boundary>` and `<mesa:mounted>` resolve snippets in one order: local, global, blank | [12.6](../../VISION.md#126-mesaboundary-and-mesamounted) |
| 41 | `bind:value\|mask` needs a pattern argument in `{ }` | [10.1](../../VISION.md#101-two-way-binding--bindvalue) |
| 42 | `$.inspect` is dev-only, stripped when `debug` is `false`, and top-level only | [17](../../VISION.md#17-built-in-functions-the--door) |
| 43 | Replacing a value notifies. Mutating one does not, unless a `$:` path covers it | [4.0](../../VISION.md#40-what--is-for) |
| 44 | Every `let` and `const` in the component is reactive. An import is inert until a `$:` names it | [4.0](../../VISION.md#40-what--is-for) |
| 45 | A watch fires only for writes through the proxy Mesa made | [4.1](../../VISION.md#41-watches--making-inert-state-observable) |
| 46 | A watch covers its path and everything beneath it | [4.1](../../VISION.md#41-watches--making-inert-state-observable) |
| 47 | Watches belong to the object, shared across components | [4.1](../../VISION.md#41-watches--making-inert-state-observable) |
| 48 | `delete obj.key` notifies like `obj.key = undefined` | [4.1](../../VISION.md#41-watches--making-inert-state-observable) |
| 49 | `Date`, `Map`, `Set`, `RegExp`, `Promise`, typed arrays and `Error` pass through the proxy untouched | [4.1](../../VISION.md#41-watches--making-inert-state-observable) |
| 50 | A `$: { }` block whose statements are all bare reads is a compile error | [4.8](../../VISION.md#48-compile-errors) |
| 51 | Reactive logic does not belong in `.js` modules | [5](../../VISION.md#5-shared-state--plain-javascript-modules) |
| 52 | In a `$: { }` block the handler is an inline function | [4.2](../../VISION.md#42-effects-with-explicit-dependencies---deps-handler) |
| 53 | The compiler reports and the build decides | [4.8](../../VISION.md#48-compile-errors) |
| 54 | `createRoot` gives ownership without tracking | [5](../../VISION.md#lifetime-boundaries--createroot) |
| 55 | Scoped CSS applies to the selector's subject. Cross a boundary with `:global(...)` | [5](../../VISION.md#css-scoping--the-class-goes-on-the-subject) |
| 56 | An instance script exports `export let`, `export const`, `export var` and `export function`, and nothing else | [3.5](../../VISION.md#35-what-an-instance-script-exports) |
| 57 | `<mesa:element this={expr}>` takes a non-empty tag name. A new tag rebuilds the element | [12.5](../../VISION.md#125-mesaelement) |
| 58 | An unknown `mesa:` name is a compile error | [12.5](../../VISION.md#125-mesaelement) |
| 59 | `prev` holds a reference. A mutated object gives the same reference for both | [4.2](../../VISION.md#42-effects-with-explicit-dependencies---deps-handler) |
| 60 | Auto-tracked effects run on mount and cannot be deferred | [4.3](../../VISION.md#43-effects-with-automatic-dependencies---expr-and---block-) |
| 61 | Everything that builds DOM runs before user effects in a flush | [4.7](../../VISION.md#47-timing-and-phase) |
| 62 | An auto-tracked effect's first run is during setup, before the template exists | [4.7](../../VISION.md#47-timing-and-phase) |
| 63 | In a `.md` file, `{…}` in prose is a bare path. Anything else is literal text | [18.4](../../VISION.md#184--in-prose-is-a-path) |
| 64 | A call to an imported function re-runs when the component's import watches fire | [4.1](../../VISION.md#41-watches--making-inert-state-observable) |
| 65 | `$.after` and `$.every` are top-level declarations. `$.sleep` works anywhere | [17](../../VISION.md#after-and-every--declared-timers) |
| 66 | `setTimeout` and `setInterval` in a script are a compile warning | [17](../../VISION.md#after-and-every--declared-timers) |

The numbers are citation keys and are never reused, so `18d` can sit before `18c`
in the spec. Page footers in this guide cite them.

---

Spec: [VISION.md § 22](../../VISION.md#22-complete-rules-reference)
