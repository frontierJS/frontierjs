# Mesa — package map

**UI substrate.** A `.mesa` component compiler and the signal runtime its output
runs on. A true leaf: **zero workspace dependencies**, and it must stay that way
(Invariant 1). Sierra, jetty, ui and email-kit all sit on top of it.

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
  glow.js              — small syntax highlighter used by the docs/demo

mesa-vite/
  index.js             — the Vite plugin, exported as @frontierjs/mesa/vite
  client.js            — its HMR client, @frontierjs/mesa/vite/client
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

- **A component cannot expose a method.** `export function foo()` in an instance
  script is dropped from the output, so `bind:this` methods (VISION §10.2 /
  RULE 36) do not exist. A component referencing its own exported function from
  its template throws `ReferenceError` on first interaction — invisible to a
  render test, because SSR dispatches no events. Hand the function out through a
  callback prop. `FJS-087`.
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
- **Island markers are comments, not elements.** An element gets foster-parented
  out of `<tbody>` and then matches `>` selectors it should not.
- **The component registry is keyed by ANCHOR, so a component's anchor must be a
  node of its own.** `registerComponentAnchor` / `pushProps` map anchor →
  registry; two components sharing one node means the second registration
  replaces the first and the first goes deaf to prop pushes forever, with a DOM
  that still looks right. `tpl` keeps text entries separate while the emitted
  template is one string, and adjacent text parses as ONE `Text` node — so never
  let a component adopt a neighbouring text node as its anchor (`FJS-110`).
- **A running dev server never re-transforms.** Editing `compiler.js` invalidates
  nothing in a server that is already up — restart it, or the fix "does not work".
  In-repo consumers must import mesa by **relative path**, not `@frontierjs/mesa`:
  `bun install` copies workspace deps into `node_modules/.bun/`, so an importer
  sees a stale snapshot until reinstall.

## Proving a change

`bun run test`, then — because SSR and hydration fail apart — both of
`example`: `bun run verify` and `bun run verify:public`. See the root
`CLAUDE.md` §Running things.
