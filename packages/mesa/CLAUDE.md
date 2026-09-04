# Mesa — package map

**UI substrate.** A `.mesa` component compiler and the signal runtime its output
runs on. A true leaf: **no framework-package dependency, ever** — the one thing
it may import is `@frontierjs/utils`, which is substrate below the graph rather
than a member of it (`FJS-D26`). Sierra, jetty, ui and email-kit all sit on top
of it.

Run tests with **`bun run test`** — vitest, then the two gating **browser
drives**, which need Chrome on PATH or `$FJS_CHROME`. `bun test` reports ~35 failures
that are runner artifacts, not defects.

`test:browser` is the two that gate, `test:browser:runtime` and
`test:browser:vite` one each; `serve:runtime` / `serve:vite` start one and stay
up, for looking at a fixture in a real browser.

**`test:browser:repl` is manual and NEEDS THE NETWORK.** The REPL loads
nineteen things from the internet, so it is in neither `test` nor CI: run it by
hand when `example/` is touched. No network is a named skip that exits 0, and
`FJS_REQUIRE_NETWORK=1` makes that skip a failure. `FJS-326` is the offline
work.

---

## Layout

```
src/
  compiler.js          — the compiler. ~290 KB, one file: parse → analyze → emit
  runtime.js           — the signal runtime the emitted code calls. ~174 KB
  render-component.js  — renderComponent(): a component → HTML, at build time
  render.js            — SSR / static-site rendering entry
  compiler-md.js       — Markdown + frontmatter compiler (the .md path)
  css-inliner.js       — scoped-style extraction and inlining

mesa-vite/
  index.js             — the Vite plugin, exported as @frontierjs/mesa/vite
  client.js            — the HMR client, @frontierjs/mesa/vite/client
  swap.js              — the DOM swap it performs, @frontierjs/mesa/vite/swap.
                         jetty imports this one: no import.meta, no imports
  client-source.js     — client.js + swap.js joined, for a plugin serving the
                         client at a virtual id
  inspect-client.js    — click-to-source, as a string for a plugin to serve.
                         Sierra serves this same source at an id of its own
  hmr.js               — the HMR boundary, @frontierjs/mesa/vite/hmr
  devtools.html        — the /__mesa/devtools panel it serves

docs/VISION.md         — the language: rules 1–40ish, numbered. Cite by rule
docs/SSR_SPEC.md       — server-render contract. No open items

test/browser/
  drive.mjs            — Chrome over CDP + the spec runner. SHARED: @frontierjs/ui
                         reads it by relative path
  probes.js            — the in-page DOM half (waitVisible, matchedRules, …)
  runtime/             — the language in a real browser (server · page · fixtures · specs)
  vite/                — the plugin in a real dev server (app · specs)
  repl/                — example/index.html itself. Manual: needs the network
```

**The Vite plugin is a subpath, not a package.** A `package.json` of its own
would put it below the `packages/*` glob — uninstalled, so nothing imports it
and nothing can test it. It also could not
find its own compiler: the resolver hunted `@mesa/compiler` and
`node_modules/mesa/`, one never published and the other someone else's package
on npm. The compiler is now a sibling and reached by relative path, which is
also the rule for every in-repo consumer of mesa (`bun install` copies workspace
deps, so a package-name import serves a stale snapshot). `vite` is an optional
peer — mesa stays a leaf.

**The file EXTENSION decides the language.** A `.mesa` file with frontmatter is
Mesa, not Markdown — `compiler-md.js` is only for `.md` (FJS-106).

---

## What bites here

**`$` is the door, and it is emitted in two halves.** The instance-independent
members — the five animation helpers and the four lifecycle functions — are a
module-scope `$$shared`; the per-instance `$` is `Object.create($$shared)` with
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
  transplanted at runtime, wrapped in a `keyBlock` so a changed tag rebuilds. A
  **tag selector** in a scoped `<style>` cannot match it — the scoper runs on the
  parsed template, where the tag is still `mesa-dynamic-element`. Match on a
  class. Unknown `mesa:*` names are an error listing the ones that exist; they
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
- **`<slot>` takes no attribute but `name`.** A slot carries content IN and
  never a value out; there is no `let:` to read one with. Refused at compile
  time (VISION RULE 35b, `FJS-304`). A hole the child must PARAMETERISE is a
  snippet prop — `export let children` + `{@render children?.(value)}` — which
  §9.6 no longer calls legacy, because for that job it is the only form.
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
  OUTPUT, and a `.replace()` whose pattern stops matching is silent — failing
  closed keeps a file on the full-reload path instead of shipping half a
  boundary. **`__setMark` goes on the NEW function**, the one handed to
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
  into MV3 content scripts, and those are classic scripts (`FJS-030`).
- **A Vite plugin test runs in Node, not happy-dom.** This package's vitest
  environment is happy-dom, whose global `URL` makes
  `fileURLToPath(new URL('./devtools.html', import.meta.url))` throw *must be of
  scheme file* — against a path that is perfectly fine in a real dev server. Put
  `// @vitest-environment node` at the top of the file. The four plugin suites
  are `vite-plugin` (hooks), `vite-devtools` (the route, against both copies of
  it), `vite-compiler-resolution` (a stub compiler is the point there, nowhere
  else) and `vite-server`, which starts a real dev server in middleware mode —
  the only one that can see a hook that is never REACHED.
- **`css` on the compiler is a DESTINATION, not a switch.** Truthy inlines the
  scoped rules as `$$runtime.addStyles(id, …)`; falsy extracts them onto
  `ctx.css.result` and emits nothing, so a caller that does not place them has
  silently dropped every style. Both Vite plugins inline. The Vite plugin's own
  `css: false` therefore means *drop the block*, and says so (`FJS-291`).
- **The compiler is resolved ONCE per module instance**, not per plugin. Two
  plugins in one Vite config share whichever compiler was asked for first, so a
  second instance's `compilerPath` is ignored in silence.
- **A running dev server never re-transforms.** Editing `compiler.js` invalidates
  nothing in a server that is already up — restart it, or the fix "does not work".
  In-repo consumers must import mesa by **relative path**, not `@frontierjs/mesa`:
  `bun install` copies workspace deps into `node_modules/.bun/`, so an importer
  sees a stale snapshot until reinstall.

## The contexts in this package

**Two, and they are not the same kind of thing** (`FJS-D03`). Neither is a
request context — nothing here executes on behalf of a caller.

**Compile context** — `get_context()` / `use_context()` in `compiler.js`, an
ambient module-level singleton (`_current_context`).

| | |
| --- | --- |
| Created per | **compilation** |
| Lives until | that compile finishes; `use_context` restores the previous one |
| Carries | `setters`, `accessors`, `script`, `proxyFireFns` — the state one compile accumulates |
| Is NOT | anything a component or an app sees. It exists only while source is becoming JavaScript |

Same word as the API realm's request context, unrelated concept. Reaching for
`ctx` in this package gets you compiler state.

**`$context`** — the runtime tree context, `_contextStack` in `runtime.js`.

| | |
| --- | --- |
| Created per | **component subtree**. `$context.key = expr` provides a reactive getter; descendants read it with `contextRead('key')` |
| Lives until | that component's frame unwinds — and the stack is truncated on error, because a dead frame left on it makes every component mounted afterwards inherit the dead one's provides |
| Scoped by | the component TREE, not by a call. It is React-context-shaped, not request-shaped |
| Reaches | content a block creates LATER, but only because each block captures the stack and reinstates it (`captureContext`, `FJS-311`). The stack itself is setup-time state, so an `{#if}` that flips, an `{#each}` row that arrives or a portal would otherwise instantiate its content with the provider already popped — which broke every compound component behind a conditional. **A new block kind that builds content after setup needs the same wrap** |
| Reads as | `undefined` outside a provider, and every fallback is silent — `@frontierjs/ui`'s controls are written so that an absent form context means *what the control does standing alone* |

`$context.form` is the one the kit uses: `Form.mesa` provides
`{ errors, submitting, disabled, fields, submitted }` and nine controls resolve
their own label, constraints and server error from it.

---

## The browser drives

**`test/browser/` is where this package is run rather than described** — three
drives over one harness, shared with `@frontierjs/ui` (`drive.mjs`,
`probes.js`) and read by relative path because mesa is the leaf. `runtime/` and
`vite/` gate; `repl/` is manual and needs the network. What bites:

- **A spec exports `run(t)`, not a suite.** vitest excludes `test/browser/**`
  for that reason; without the exclusion it collects eleven files and fails
  each one with *no test suite found*.
- **A fixture is a component**, because a slot cannot be expressed as a props
  object. Props reach it as JSON.
- **A spec that PASSES can still be the point, and it can also be lying about
  where to look.** `chained-derived` was written for a shape that misbehaved in
  a real screen (`FJS-512`) and passed here, so it was kept as the list of
  causes ruled out. It passed because a component-ROOT template has its
  whitespace collapsed and the real screen's blocks were one branch down, where
  it survives — the fixture reproduced the markup and not the position. Say in
  the header what a green spec pins; and when a spec cannot reproduce a real
  failure, suspect the frame around the shape before the shape.
- **Input goes through the pipeline** (`t.press`, `t.type`, `t.clickAt`). A
  dispatched `KeyboardEvent` moves no focus, types no character and dismisses
  no `[popover]`.
- **`t.eventually(expr, expected, label, ms?)`** for anything a state change
  produces — mesa flushes on a microtask. `ms` is for a round trip that is not
  one: a Vite update is **seconds**.
- **`t.allow(re)`** declares a page error the spec is provoking. Everything
  else still fails the run, including any `[Mesa]` console warning — the
  framework reports a render it survived but corrupted that way.
- **Two writes to one file within tens of milliseconds are ONE watch event.**
  Measured at 23ms apart: the second edit fired no `change` and arrived only
  when a later edit flushed it — which looks exactly like broken HMR. The Vite
  drive's `edit()` holds until the file has settled, so a spec never has to
  know; anything else touching files does.
- **The Vite drive edits a COPY** in a temp directory. An edit is what an HMR
  update is, and a drive that writes to the tree leaves it dirty when it
  crashes.
- **`each-unkeyed.spec.mjs` is the DEFAULT `{#each}` key written down** — the
  index, and the trade it makes: an unkeyed list can never collide, and a row
  that moves is rebound in place rather than moved, so its DOM state stays with
  the position. `each.spec.mjs` is the keyed half, where a reordered row must
  be the same NODE moved. Keying by the item was the default until `FJS-325`,
  and a duplicate value corrupted the reconciler beyond recovery.
- **No backticks in a probe's own comments.** Everything handed to
  `t.evaluate` is a template literal, so one backtick inside a comment in it
  ends the string and the spec fails to PARSE — which reads as the drive being
  broken rather than the spec. It has bitten twice.
- **A relay between two pages needs `browser.newPage(url, ready)`** — a second
  target with its own `evaluate`/`navigate`/`close`, whose errors land in the
  same array. `BroadcastChannel` is cross-document by definition, so one tab
  posting and listening proves nothing.
- **A drive over a page it does not own installs its probes with
  `bootstrap`** — a script CDP runs before anything else in every document.
  The REPL has nowhere to put one, and reaching for a probe that is not there
  reads as the page being broken.
- **Nothing the REPL defines is reachable from page scope** — it is one module
  script, so `encodeState` and the editor view are both invisible. Drive the
  buttons instead. `copyShareLink` writes the hash with `replaceState` BEFORE
  it touches the clipboard, which is what makes the share round trip assertable
  without a clipboard permission.
- **Wait on what CHANGED, not on the status word.** `#pvlbl` already says
  *running* before a click that loads another example, so an `eventually` on it
  returns at once and the assertion afterwards reads the example being
  replaced. Twice, in two specs.

## Proving a change

`bun run test` — which now includes the two gating browser drives — then,
because SSR and hydration fail apart, both of `example`: `bun run verify` and
`bun run verify:public`. See the root `CLAUDE.md` §Running things.
