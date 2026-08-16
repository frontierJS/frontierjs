# Mesa — package map

**UI substrate.** A `.mesa` component compiler and the signal runtime its output
runs on. A true leaf: **no framework-package dependency, ever** — the one thing
it may import is `@frontierjs/utils`, which is substrate below the graph rather
than a member of it (`FJS-D26`). Sierra, jetty, ui and email-kit all sit on top
of it.

Run tests with **`bun run test` — the runner is vitest.** `bun test` reports
~35 failures that are runner artifacts, not defects.

---

## Layout

```
src/
  compiler.js          — the compiler. ~290 KB, one file: parse → analyse → emit
  runtime.js           — the signal runtime the emitted code calls. ~174 KB
  render-component.js  — renderComponent(): a component → HTML, at build time
  render.js            — SSR / static-site rendering entry
  compiler-md.js       — Markdown + frontmatter compiler (the .md path)
  css-inliner.js       — scoped-style extraction and inlining

mesa-vite/
  index.js             — the Vite plugin, exported as @frontierjs/mesa/vite
  client.js            — the HMR client, @frontierjs/mesa/vite/client
  hmr.js               — the HMR boundary, @frontierjs/mesa/vite/hmr
  devtools.html        — the /__mesa/devtools panel it serves

runtime.js             — root re-export; what everything imports
docs/VISION.md         — the language: rules 1–40ish, numbered. Cite by rule
docs/SSR_SPEC.md       — server-render contract. No open items
```

**The Vite plugin is a subpath, not a package.** It had its own `package.json`
until 2026-08-10 and was therefore invisible to the `packages/*` glob —
uninstalled, so nothing imported it and nothing could test it. It also could not
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

- **An instance `<script>` has exactly two export forms** — `export let` (a
  prop) and `export function` (a method on what `bind:this` hands the parent,
  VISION §10.2 / RULE 36). Anything else is refused by name. `export function`
  used to be deleted from the output while every reference to it survived, so a
  component calling its own exported function threw `ReferenceError` on first
  interaction — which no render test can see, because SSR dispatches no events.
- **`bind:this` on a COMPONENT is the exported interface; on an ELEMENT it is
  the node.** The component form reads props through the child's own signals, so
  `ref.count` is live and `ref.count = 2` writes it. It used to hand over the
  anchor comment, silently.
- **`<mesa:element this={tag}>` is compiled under a placeholder tag** and
  transplanted at runtime, wrapped in a `keyBlock` so a changed tag rebuilds. A
  **tag selector** in a scoped `<style>` cannot match it — the scoper runs on the
  parsed template, where the tag is still `mesa-dynamic-element`. Match on a
  class. Unknown `mesa:*` names are an error listing the ones that exist; they
  used to emit nothing, which made a typo and a missing feature the same event.
- **`{#each}` takes an array, an iterable or an array-like — and refuses a
  number or a plain object by name.** `eachItems()` in `runtime.js` is the one
  definition; `{#each}` and `{#virtual each}` share it. It used to call `.map()`
  on whatever arrived, so `{#each { length: 6 }}` — a fixed-size grid, which is
  what the kit's `DatePicker` builds its calendar from — died as `array.map is
  not a function`, naming no block and no expression. That component had
  therefore never rendered at all while compiling perfectly (`FJS-147`).
- **`{@attach}` does not run on the server.** No mount, no attachment — the
  same rule that already keeps `$onMount` and `watchProxy` off the SSR path.
  Running it handed the function a happy-dom element, which has no
  `el.animate`, so one animating attachment threw and took the whole render
  down (`FJS-146`). Guard is `!_isClient` in `attach()`/`applyAttachments()`.
- **`{@attach}` runs when the element MOUNTS, not when it is built** (VISION
  §10.6, enforced since `FJS-114`). It used to run on a detached node, where
  `el.animate(..., { fill: 'forwards' })` returns an animation that never starts
  — so every kit overlay painted at keyframe 0 and the command palette was an
  invisible full-screen backdrop that ate every click. An already-connected
  element still attaches synchronously; a detached one is deferred one
  microtask, the same queue `$onMount` uses.
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
  scoped rules as `$runtime.addStyles(id, …)`; falsy extracts them onto
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

## Proving a change

`bun run test`, then — because SSR and hydration fail apart — both of
`example`: `bun run verify` and `bun run verify:public`. See the root
`CLAUDE.md` §Running things.
