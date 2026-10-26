# mesa — what bites here

The full hazard catalog for `@frontierjs/mesa`, moved out of `CLAUDE.md`. The dozen that bite most often stay there; this is every one, verbatim. What bites in `test/browser/` is `browser-drives.md`.

**`$` is the door, and it is emitted in two halves.** The instance-independent
members — the five animation helpers, the four lifecycle functions, `measure`,
`viewport` and `focus` — are a module-scope `$$shared`, the last three read off the target's
runtime (`$$host` on a host target); the per-instance `$` is `Object.create($$shared)` with
only `option`, `slots`, `props`, `attributes`, `emit`, `context`, `mounted`,
`inspect` and `async` assigned on top, and each of those only when the sniff
found it in use. So a component that reaches for nothing emits neither.

**Most of the door needs no compiler support and four members do.** `$props`
is a property read and compiles to one — `$$props`, the emitted local the bare
spelling aliases. `$context`, `$.inspect` and `$.mounted`
are rewritten to their bare spelling BEFORE the script is parsed — on the AST,
so a `'$context'` inside a string is not caught — because each is compiled
rather than read and would otherwise be a member access that quietly does
nothing. `$async` is the fourth and is NOT in that rewrite: it is the only one
reachable from a template, which no script-side pass sees, so it is assigned as
an ordinary property instead — beside its own declaration in `module.code`,
because `module.head` has already run by then.

**Three names are refused and they are not the same refusal.** A declaration
colliding with an injected local (`BUILTIN_LOCALS`) throws because the output
would not parse; a bare `$onMount` throws because that spelling is retired (the five data members are not — `FJS-D135`); `$`
used as anything but a member object throws because a copy is not what the
compiler follows. All three THROW rather than pushing to `analysis.errors`,
which the call site downgrades to warnings — a module that does not parse is not
a warning.

**An ARIA `false` is written, not removed — for exactly four states.**
`aria-expanded`, `aria-selected`, `aria-checked` and `aria-pressed` default to
**undefined** rather than false, so absent says *not expandable / not
selectable / not checkable / not a toggle* while `"false"` says *it is, and it
currently is not*. Removing it announces a different KIND of control in the one
state that matters. Only those four: the rest either default to false already
(absent and `"false"` agree) or take a string, where `aria-label={false}` must
remove the label rather than name the element "false". `null` always removes,
which is what the `x || null` idiom through `@frontierjs/ui` is for.

**An attribute has ONE owner and turning a control OFF is a property, not an
attribute.** `set_attribute` is that owner; `bindAttribute` is it inside an
effect and nothing more. They were two implementations that agreed on
everything but what a falsy value means — and the compiler picks between them
per attribute, so a component was correct or broken depending on whether the
value was static, with nothing in the component able to see either. The rule
they now share: `el.checked` and `el.value` stop reflecting their attribute the
moment anything writes the property (the DOM's dirty flag), so `null`/`false`
must reset the property as well as remove the attribute. Otherwise a control
goes on and never off — `<Switch bind:checked>` and `<Checkbox>` both were
one-way for their whole lives. **happy-dom keeps no dirty flag**, so no vitest
suite here can reach it; `test/browser/runtime/dirty-props` is the assertion,
and it flips twice because a one-shot recovery passes a single round trip.

**A dev build stamps `data-fjs-loc` on every template element.** It is what
click-to-source reads (`mesa-vite/inspect-client.js`), it is dev-only, and it is
in the TEMPLATE — so an assertion comparing a compiled template string against a
literal has to compile with `loc: false`, not merely with `dev: true`. `loc`
defaults to whatever `dev` is, and the path in it is relative to `locRoot`.
The same switch sets `__fjsPlaced` on each component's anchor comment, the
line that placed it — the inspector's only way from a package layout's own
chrome back to the app file (`FJS-3332`). It also records a `.md` module's
`frontmatter` (runtime `recorded`), and an element whose whole text is one field
read (`{item.name}`) is restamped at runtime with that value's content line
(`stampFrom`, `FJS-D1231`); a copy that changed the key keeps the template's.

- **An instance `<script>` has exactly two export forms** — `export let` (a
  prop) and `export function` (a method on what `bind:this` hands the parent,
  VISION §10.2 / RULE 36). Anything else is refused by name. `export function`
  used to be deleted from the output while every reference to it survived, so a
  component calling its own exported function threw `ReferenceError` on first
  interaction — which no render test can see, because SSR dispatches no events.
- **`$attributes` is a live view, and the prop push carries the WHOLE object
  because of it.** `restProps` returns a Proxy over a signal, not a copy: a copy
  taken at init froze every forwarded dynamic attribute at its mount value while
  the component's own children — the same expression — tracked (`FJS-612`). Two
  things hold it up and both read as redundant. The sync effect pushes
  `allProps` rather than the reactive half, because an attribute the child did
  not declare has no signal to be written twice into and would otherwise be lost
  the first time anything else on the element moved; and the rest object is
  rebuilt **wholesale** on each push rather than merged, because a merge can
  never remove a key, so a spread that stops carrying one would leave it on the
  element for ever. The sink lives in the prop registry under a SYMBOL, so
  anything walking that registry for accessors — `componentApi` — must skip
  non-string keys.
- **`bind:this` on a COMPONENT is the exported interface; on an ELEMENT it is
  the node.** The component form reads props through the child's own signals, so
  `ref.count` is live and `ref.count = 2` writes it. Handing over the anchor
  comment instead fails silently.
- **`<mesa:element this={tag}>` is compiled under a placeholder tag** and
  transplanted at runtime, wrapped in a `keyBlock` so a changed tag rebuilds.
  The scope class rides on the placeholder and is copied across, so a scoped
  `h2 { }` does match the transplanted `<h2>`. Unknown `mesa:*` names are an error listing the ones that exist; they
  used to emit nothing, which made a typo and a missing feature the same event.
- **`{#each}` takes an array, an iterable or an array-like — and refuses a
  number or a plain object by name.** `eachItems()` in `runtime.js` is the one
  definition; `{#each}` and `{#virtual each}` share it. Calling `.map()` on
  whatever arrives means `{#each { length: 6 }}` — a fixed-size grid, which is
  what the kit's `DatePicker` builds its calendar from — died as `array.map is
  not a function`, naming no block and no expression. That component had
  therefore never rendered at all while compiling perfectly (`FJS-147`).
- **`{@attach}` does not run on the server.** No mount, no attachment — the
  same rule that already keeps `$.onMount` and `watchProxy` off the SSR path.
  Running it handed the function a happy-dom element, which has no
  `el.animate`, so one animating attachment threw and took the whole render
  down (`FJS-146`). Guard is `!_isClient` in `attach()`/`applyAttachments()`.
- **`{@attach}` runs when the element MOUNTS, not when it is built** (VISION
  §10.6, enforced since `FJS-114`). Running it on a detached node instead is where
  `el.animate(..., { fill: 'forwards' })` returns an animation that never starts
  — so every kit overlay painted at keyframe 0 and the command palette was an
  invisible full-screen backdrop that ate every click. An already-connected
  element still attaches synchronously; a detached one is deferred one
  microtask, the same queue `$.onMount` uses.
- **The flush settles derivations OUTSIDE-IN, and that ordering is load-bearing.**
  One DOM-depth at a time, shallowest first, skipping anything whose owning
  block is already queued. Draining the whole derived layer to quiescence first
  — which is what it used to do, so that renders read derivations that had
  stopped moving — let a memo inside `{#if a[i]}` recompute before the guard
  tore it down, so `{@const d = a[i][j]}` read `undefined[j]` and threw from
  inside a handler (`FJS-303`). **A new tier in `_flush` inherits this**: only a
  DOM-building node disposes anything, so only its depth counts, and only its
  pendingness holds a derivation back. Do not reach for "is anything pending" —
  that costs a redundant effect run and a glitch-freedom test says so.
- **Devtools read the live graph, so a new signal shape must carry `_src`.**
  `__dev.graph()` walks `_deps`/`_subs` off `read._src` (set in `createSignal`
  and `createMemo`, the only two places an edge is made); a reader without it
  is invisible to the panel and nothing says so. The one fact not on an edge —
  what DID wake a node — is `_cause`, stamped by `_notify` only while `_devOn`.
  `runtime/specs/devtools-cause` reads a chain back (`FJS-1324`).
- **A slot is a snippet with no arguments, and nothing past the parser knows
  slots exist** (`FJS-D668`). `lowerSlots` in `compiler.js` rewrites `slot=`
  and unslotted content to `{#snippet name()}` / `{#snippet children()}` and
  `<slot>` to `{@render}`, before `lower()` or the DOM builder reads the tree,
  so every target and both runtimes see snippets only — a new target needs no
  slot code. Content snippets are wrapped in `$$runtime.content()`, which is how
  `unclaimedContent` tells dropped content from a function prop and how
  `restProps` keeps it off `$attributes`. A prop written beside content of its
  name is the override (`contentFallback`). A component takes `(__anchor, __props)`
  and nothing else (`FJS-3149`).
- **`<slot>` takes no attribute but `name`.** A slot carries content IN and
  never a value out; there is no `let:` to read one with. Refused at compile
  time (VISION RULE 35b, `FJS-304`). A hole the child must PARAMETERIZE is a
  snippet prop — `export let children` + `{@render children?.(value)}`.
- **Scoped styles do not reach into child components** — use `:global(...)`. The
  selector *subject* carries the hash (`button` → `button.mHASH`).
- **A dynamic `class` merges, it never replaces** — everything routes through
  `bindClassPassthrough`. Do not reintroduce a bare `set_attribute(el,'class')`.
- **Output must be reproducible** (Invariant 12): scope ids are
  content-addressed, which is what lets a static build dedupe CSS across the two
  compilers it runs.
- **A clean compile is not proof of valid JS** (Invariant 15). Parse the output.
- **A slot made only of comments is not content.** Comments are dropped from the
  output unless `preserveComments` is on, so such a block rendered nothing and
  still made `$slots.default` true — and a component that branches on the answer
  turned itself off because somebody wrote a comment inside it. `<Form>`
  generating its field list when nobody passed controls is the case that found
  it: one HTML comment and every field silently vanished.
- **Island markers are comments, not elements.** An element gets foster-parented
  out of `<tbody>` and then matches `>` selectors it should not.
- **The component registry is keyed by ANCHOR, so a component's anchor must be a
  node of its own.** `registerComponentAnchor` / `pushProps` map anchor →
  registry; two components sharing one node means the second registration
  replaces the first and the first goes deaf to prop pushes forever, with a DOM
  that still looks right. `tpl` keeps text entries separate while the emitted
  template is one string, and adjacent text parses as ONE `Text` node — so never
  let a component adopt a neighbouring text node as its anchor (`FJS-110`).
- **The HMR boundary is exported, because it has two callers.**
  `mesa-vite/hmr.js` (`@frontierjs/mesa/vite/hmr`) and `mesa-vite/client.js`
  (`@frontierjs/mesa/vite/client`) are Sierra's too — it reimplements the PLUGIN
  and never the boundary (`FJS-D16`), and `injectHMR` being private here is why
  it had copied one. `injectHMR(js, id, root, clientId)` takes the client id,
  since each plugin serves the client at a virtual id of its own. **Ask
  `canInject` first**: the two patterns it tests are shapes of the compiler's
  OUTPUT, and a `.replace()` whose pattern stops matching is silent. **Failing
  closed is injecting NO accept**: an injected one makes the module self-accept,
  so Vite escalates nothing and a boundary that cannot swap swallows every edit
  instead of falling back to a reload (`FJS-865`). The CLIENT is asked the same
  question before a boundary is injected, since a stub client behind a live
  accept is that same silence. **`__setMark` goes on the NEW function**, the one
  handed to
  `__mesa_hot_update`; setting it on the old module's leaves the new
  `__hmrMark` undefined, so the first update registers `hmrMark: undefined` and
  the second drops the entry as stale — HMR worked once per page load and then
  said *no registered instances*. `test/vite-hmr.test.js` pins all of it against
  real compiled output.
- **The client is TWO files, and a plugin must serve them joined.** A virtual
  id resolves no relative import, so handing Vite `client.js` alone is a 200
  that dies in the browser and puts every component back on the full-reload
  path. `client-source.js` is the one owner of that join and fails closed. The
  split exists because jetty performs the same swap (`FJS-259`) — which is also
  why `swap.js` carries **no `import.meta` and no imports**: jetty bundles it
  into MV3 content scripts, and those are classic scripts (`FJS-030`). **The
  registry the client keeps is swept on the way in and on every update**, not
  only by the swap: a swap runs when that one file is edited, so a route
  navigated away from left its marker, anchor, props and block retained for the
  life of the tab (`FJS-875`).
- **A Vite plugin test runs in Node, not happy-dom.** This package's vitest
  environment is happy-dom, whose global `URL` makes
  `fileURLToPath(new URL('./devtools.html', import.meta.url))` throw *must be of
  scheme file* — against a path that is perfectly fine in a real dev server. Put
  `// @vitest-environment node` at the top of the file. The plugin suites are
  `vite-plugin` (hooks), `vite-devtools` (the route, against both copies of it,
  and neither of them in a build), `vite-compiler-resolution` (a stub compiler
  is the point there and in the two below, nowhere else), `vite-hmr-failclosed`
  (the boundary REFUSING — the shape `canInject` rejects, and a client that
  cannot be assembled), and the two that start a real dev server in middleware
  mode, `vite-server` and `vite-server-failclosed` — the only ones that can see
  a hook that is never REACHED, or ask Vite what it concluded about a module it
  served.
- **`css` on the compiler is a DESTINATION, not a switch.** Truthy inlines the
  scoped rules as `$$runtime.addStyles(id, …)`; falsy extracts them onto
  `ctx.css.result` and emits nothing, so a caller that does not place them has
  silently dropped every style. Both Vite plugins inline. The Vite plugin's own
  `css: false` therefore means *drop the block*, and says so (`FJS-291`).
- **The compiler is resolved once per PLUGIN INSTANCE.** Two plugins in one
  Vite config — the ordinary case (`FJS-D16`) — each keep the compiler they
  asked for. A memo at module scope handed the second whichever compiler
  resolved first and dropped its `compilerPath` in silence (`FJS-880`).
- **A script importing `@opentui/core` from OUTSIDE `packages/mesa` gets a
  SECOND copy**, auto-installed by bun from its cache, and two copies fail
  `instanceof BaseRenderable` inside the engine's `remove()` as `remove expects
  a renderable child object` — which reads as the runtime being broken. Run
  the terminal drive, and any probe of the engine, from `packages/mesa`.
- **A running dev server never re-transforms.** Editing `compiler.js` invalidates
  nothing in a server that is already up — restart it, or the fix "does not work".
  In-repo consumers must import mesa by **relative path**, not `@frontierjs/mesa`:
  `bun install` copies workspace deps into `node_modules/.bun/`, so an importer
  sees a stale snapshot until reinstall.
