# Mesa — package map

**UI substrate.** A `.mesa` component compiler and the signal runtime its output
runs on. A true leaf: **no framework-package dependency, ever** — the one thing
it may import is `@frontierjs/toolbelt`, which is substrate below the graph rather
than a member of it (`FJS-D26`). Sierra, jetty, ui and email-kit all sit on top
of it.

Run tests with **`bun run test`** — vitest, then the five gating **browser
drives**, which need Chrome on PATH or `$FJS_CHROME`, then the **terminal drive**
(`test:terminal`), which needs no Chrome and no TTY. `bun test` reports ~35 failures
that are runner artifacts, not defects.

`test:browser` is the five, `test:browser:runtime`, `test:browser:vite`,
`test:browser:repl`, `test:browser:kit` and `test:browser:drive` one each;
`serve:runtime` / `serve:vite` start one and stay up, for looking at a fixture
in a real browser.

**The REPL drive is `repl/`, in `test` and offline.** Its third-party code is
`example/vendor/` — committed bundles of acorn, the unified chain and CodeMirror,
plus lz-string — and `index.html`'s importmap names them, so the page that ships
is the page tested. `bun example/build-vendor.mjs` rewrites the directory when a
devDependency moves; one `Bun.build` with splitting, because a second copy of
`@codemirror/state` fails on an `instanceof` that no message explains.

**`test` ends with `bench/run.mjs --gate`** — bytes and DOM mutations, and a
rise in either fails it (`FJS-D532`); heap kept after five create/clear cycles
over 5% of one 1k-row mount fails it too, and that one fails open, never
falsely (`FJS-3550`). The timed `bun run bench` is by hand: run
it when a change touches `{#each}`, the flush or anything that writes the DOM. A
time never fails it; it is printed as a ratio to the hand-written floor measured
in the same browser.

**`bench/cases.mjs` is the timed tier that needs no browser** — a compile, a
server render and a signal fan-out, each beside hand-written code, and each
checking its work happened so a broken case cannot read as fast. CI's `perf`
phase runs it against the base ref (`node scripts/bench-ab.mjs --only mesa` from
the root) and never fails on a time; a case that throws fails it.

---

## Where things are

`docs/layout.md` is the file-by-file map; read it when a change touches a file
this list does not name. The owners that matter on most turns:

- `src/compiler.js` is the compiler, one file: parse → analyze → emit · `src/ir.js` is `lower(ctx)`, the target-free tree every compile builds · `src/runtime.js` is the signal runtime the emitted code calls.
- Host targets: `src/host/emit.js` emits `ctx.ir` as `$$host` calls for every profile in `src/host/targets.js`; `src/terminal/tags.js` and `src/native/tags.js` are what each target paints; `src/runtime-terminal.js` (over `@opentui/core`) and `src/runtime-native.js` (Lynx, the one file that names it) are their runtimes; `src/native/{css,sheet,tokens,values}.js` lower a stylesheet for a phone.
- Server half: `src/render.js` (SSR entry), `src/render-component.js`, `src/compiler-md.js` (`.md` only), `src/css-inliner.js`, `src/optional-peer.js` (`missingPeer`).
- `src/drive.js` is Chrome over CDP, published — every in-repo drive and an app's drive import it, and `PAGE_AUDIT` there is what a rendered page owes (`FJS-D836`) · `src/browser/` is the browser kit (`host.js` answers per host; `persisted.js` on `subscribe()`) · `src/keys.js` is the one attachment a tab and a terminal both run.
- `mesa-vite/index.js` is the Vite plugin; `client.js` + `swap.js` joined by `client-source.js`; `hmr.js` the boundary Sierra shares · `scripts/corpus.mjs`, `scripts/host-tree.js`, `scripts/tui.mjs` · `bench/run.mjs` + `bench/baseline.json`.
- `docs/VISION.md` is the language (cite by RULE); `docs/STATIC_RENDERING.md` is server rendering.

## What bites here

The dozen that bite most; the full catalog is `docs/hazards.md`, read it before
touching the compiler's `$` emission, attributes, the flush, slots, the Vite
plugin or HMR. What bites in `test/browser/` is `docs/browser-drives.md`.

- **A running dev server never re-transforms**, and an in-repo consumer imports mesa by **relative path** — `bun install` copies workspace deps, so `@frontierjs/mesa` serves a stale snapshot until reinstall.
- **The Vite plugin is a subpath, not a package**, and `vite`, happy-dom, css-tree and the six markdown packages are optional peers reached by `await import()`; a static `import` of one from anything a client build reaches breaks every client-only install (`test/optional-peers.test.js`).
- **The file EXTENSION decides the language** — `.mesa` with frontmatter is Mesa, `compiler-md.js` is `.md` only (`FJS-106`).
- **`$` is emitted in two halves** — module-scope `$$shared` plus a per-instance `Object.create($$shared)` that carries only what the sniff found in use; `$context`, `$.inspect` and `$.mounted` are rewritten on the AST before parse, `$async` is assigned as a property, and a colliding local, a bare `$onMount` or a copied `$` THROW rather than warn.
- **An ARIA `false` is written, not removed, for exactly four states** (`aria-expanded`, `-selected`, `-checked`, `-pressed`); `null` always removes.
- **`set_attribute` is the one owner of an attribute, and turning a control OFF resets the PROPERTY too** — happy-dom keeps no dirty flag, so only `test/browser/runtime/dirty-props` can see it.
- **A dev build stamps `data-fjs-loc` in the TEMPLATE** — compile with `loc: false` before comparing output to a literal.
- **`{#each}` takes an array, iterable or array-like and refuses a number or plain object by name** (`eachItems()`); `{@attach}` runs when the element MOUNTS and never on the server.
- **The flush settles derivations OUTSIDE-IN, one DOM depth at a time**, and a new `_flush` tier inherits that; draining the derived layer first threw from inside `{#if}` (`FJS-303`).
- **A slot is a snippet with no arguments and nothing past the parser knows slots exist** (`lowerSlots`, `FJS-D668`); `<slot>` takes no attribute but `name`, and a slot made only of comments is not content.
- **The component registry is keyed by ANCHOR**, so a component never adopts a neighboring text node as its anchor (`FJS-110`); island markers are comments, not elements.
- **HMR fails closed by injecting NO accept** — ask `canInject` first, `__setMark` goes on the NEW function, and the client is TWO files a plugin must serve joined (`client-source.js`).
- **`css` on the compiler is a DESTINATION, not a switch** — falsy extracts onto `ctx.css.result` and a caller that does not place them has dropped every style.
- **A Vite plugin test runs in Node, not happy-dom** (`// @vitest-environment node`), and a script importing `@opentui/core` from OUTSIDE `packages/mesa` gets a SECOND copy that fails `instanceof` inside the engine — run the terminal drive from `packages/mesa`.

---

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

`bun run test` — which includes the five gating browser drives — then,
because SSR and hydration fail apart, both of `example`: `bun run verify` and
`bun run verify:site`. See `docs/TESTING.md`.

<!-- layout-named: the file names fli done grades a new module against, kept here because done.js reads this file by path. The map itself is docs/layout.md.
baseline.json browser.d.ts build-vendor.mjs cases.mjs client.js client-source.js clock.js 
compiler.js compiler-md.js corpus.mjs css-inliner.js css.js data.js datetime.js devtools.html drive.js 
emit.js entities.js hmr.js host.js host-tree.js hotkey.js index.html index.js inspect-client.js 
ir.js keys.js media.js optional-peer.js package.json persisted.js portability.js prefix.js 
render-component.js render.js result.js run.mjs runtime.js runtime-native.js 
runtime-terminal.js sheet.js STATIC_RENDERING.md swap.js tab.js tags.js targets.js tokens.js 
tui.mjs values.js VISION.md window-binds.js 
-->
