---
id: server-render-without-dom
status: proposed
dated: 2026-10-16
---

# Idea — a server render that builds no DOM

**Status: RULED** (`FJS-D1634`, 2026-10-29): the server render is `target:
'server'`, an output mode of the one host emitter that writes the template as
string pushes. Dated 2026-10-16. The figures in § 1 were measured by
`packages/mesa/bench/cases.mjs` `ssr-100`, each on the day named, and hold for
that afternoon only (`PHILOSOPHY.md` § VII). This paper picks up where
`FJS-2993` (closed) stopped: the per-row template parse is gone, and what
remains is happy-dom itself.

---

## 1. What a server render costs now

`renderToHTML` (`packages/mesa/src/render.js`) installs a happy-dom window and
runs the component's DOM output inside it, then serializes the container.
`IDEAS/mesa-ir.md` § 1 states the consequence: **SSR is not a second backend, it
is a host that imitates a browser.** `target: 'email'` and `'fragment'` render
through the same path.

Measured on a 100-row table:

| | per render | vs. a string join |
| --- | --- | --- |
| before `FJS-2993` (a fresh parse per row) | 4.4 ms | 180–265× under load |
| after (one parse per template, cloned), 2026-10-16 | 2.6 ms at load 5 | 92× at load 5, 124–146× at load 27 |
| detached container, 2026-10-29 | 1.3 ms quiet (2.3 ms attached, same box) | ~55× |

A CPU profile has no parser left in it. On 2026-10-29, 90% of the render was
happy-dom's node model: `connectedToNode` 23%, `cloneNode` 22%, `insertBefore`
17%. Rendering into a detached container (`render.js`, 2026-10-29) removed the
connected-tree walk and halved the render; the 2026-10-16 reading that it gave
no gain was taken under load and was noise. What stays is node construction,
`MutationRecord`s nobody observes and `NamedNodeMap` bookkeeping. The string
floor is 24 µs, so the remaining cost is still the node model.

A prerender pays this once per row on every page. An islands page pays it once
per request.

## 2. The shapes

- **A: a host target whose runtime builds a plain node tree.** Each node is an
  object holding a tag, attributes and children, and the tree is serialized
  once. The seam exists: `host/emit.js` lowers `ctx.ir` to calls on `$$host`,
  and `host/targets.js` holds one profile per target (`FJS-D699`,
  `FJS-D1074`). Reactivity stays as it is. Its floor is the graph: one render
  effect per binding and one block per `{#if}` and `{#each}`, ~0.6 µs per node
  run (`signal-fanout`), on a render that runs the graph once and reads it.
- **B: a string emitter.** Template slots are concatenated directly; this is
  the shape Svelte 5 (`$$payload.out +=`), Solid (`ssr` strings), Vue
  (`compiler-ssr` `_push`) and Marko all use on the server. **Ruled
  (`FJS-D1634`), against this paper's earlier recommendation of A**, on the
  three conditions `decision-rules` set:
  - **One walker.** B is an output mode of `host/emit.js`, reading the same
    `ctx.ir` walk, `spacesIn`, `preEdges`, `hostOffenses` and `hostDropped`. A
    line body says `$$out.push(…)` where the host mode says `$$host.…`; `{#if}`
    is a JS `if`, `{#each}` a `for`, a component a call taking `$$out`, a
    snippet a function pushing to it. No render effects, no blocks, no
    `$$host`. A second file walking the IR would be a second builder beside
    `compiler.js`'s, which `mesa-ir` exists to stop being necessary.
  - **The name is `server`.** `target: 'html'` in `render-component.js` already
    names the output wrapper (`'html' | 'email' | 'fragment' | 'js'`).
  - **Parity before default** — § 3, built in Phase 1 before `renderToHTML`
    takes the mode.
- **C: keep happy-dom and tune it.** This is what `FJS-2993` and the detached
  container already did. Nothing is left to tune under the node model.

## 3. What must stay true

- **The same component gives the same HTML on either path.** A string path that
  disagrees ships a page that differs from what the client builds, and nothing
  reports it. The artifact that catches it is a corpus parity check:
  `packages/mesa/scripts/corpus.mjs` already compiles every `.mesa` in the workspace. Phase 1
  makes it render each one on both paths and compare the serialized output.
  Whitespace follows the DOM builder's rule, not the terminal's, since parity
  is against the DOM path.
- **Escaping has one owner.** Text and attribute values are escaped in exactly
  one function of `runtime-server.js`. A mistake there is XSS in a public file,
  so it is graded by `test/render-ssr.test.js`. That file's section *no
  attribute the author did not write* runs on both paths.
- **The emitter's output is parsed** (Invariant 15), as every compiler test
  does.
- **A kind the mode cannot lower falls back to happy-dom for that component
  and is NAMED in the render's result.** The result never approximates the
  output. A fallback costs speed and not correctness, so refusing to render
  would be out of proportion (§ IV *ergonomics vs. strictness*). `mesa-ir`'s
  `unlowered` is the existing report, and its kind names what the fallback
  missed.

## 4. Phases

### Phase 0 — Measure the corpus

Goal: know how much of the workspace a server target would lower today.
Done when: `bun run corpus -- --portability server` prints a tally of what
lowers and what does not, beside the terminal's.

- [x] 0.1 A `server` profile in `host/targets.js` with no runtime yet: every
  tag, every event, `paintsCss: true`. Its only job is to make
  `--portability server` count.
- [x] 0.2 Read the tally and rank what is unlowered. Components, snippets,
  `<mesa:element>`, boundaries, island markers and the directives a server
  drops (`on:`, `use:`, `{@attach}`, `transition:`) are the expected ones; a
  dropped directive is a lowering, not a refusal, so the profile learns to
  pass them.

### Phase 1 — Static markup as strings

Goal: a component of elements, text, attributes, `{#if}`, `{#each}` and
`{#key}` renders as string pushes without happy-dom.
Done when: `ssr-100` runs on the server mode, its ceiling drops below 10×,
and the corpus parity check passes for every component that lowers.

- [x] 1.1 The string mode in `host/emit.js`: a profile field names it, and
  each `emit*` writes `$$out` line bodies under the same walk. `$$out` is an
  array joined once at the root. Built 2026-10-29: `mode: 'string'` on the
  `server` profile; the root is `const $$out = __anchor` and a caller passes
  the array. Static runs and `${}` holes flush as one push; a static-only
  element is serialized at compile time, a live one calls `$$host.attrs`.
  Snippets and `{@render}` landed with it (a snippet is `(__anchor,
  ...params) => {…}`), so 2.1's remainder is components and props. `on:`,
  `use:`, `{@attach}`, `bind:` and `ref` are dropped lines until 2.5;
  `{@html}`, a component, `<mesa:element>` and a portal refuse by name
  (`<Row> at Counter.mesa:2:1 has no server lowering`). `test/server-emit.test.js`
  parses the output, grades the escaper and compares 16 attribute
  arrangements, `{#if}`/`{#each}`/`{#key}`, `<pre>` and snippets byte for
  byte against the happy-dom path. A 100-row keyed table renders in
  0.2–0.4 ms, 5–9× a hand join and ~85× under the DOM path, so Phase 1's
  ceiling is met once 1.3 confirms it across the corpus.
- [x] 1.2 `runtime-server.js`: the one escaper and the attribute serializer
  (boolean attributes, `value`, `checked`, `selected`, `class:` and `style:`
  merged as the DOM path merges them), nothing else. Built with 1.1. The
  rules parity forced, each one a happy-dom behavior: text escapes `& < >`
  and nbsp, an attribute only `& "`; attributes serialize in insertion order,
  so the compiler writes the template's statics first (class last, then the
  scope class), then live pieces in source order with once-written ones
  ahead of reactive ones in a run (`writtenOnce`, the compiler's own
  `_isReactive`); a `class:` or `style:` reserves its slot at first write
  and tokens compose in application order; a live `value` reaches only an
  `<input>`; a `javascript:` URL is dropped. Known non-parities, each a
  happy-dom behavior the string path does not imitate: its CSS validator
  drops a `style:` whose value is not valid CSS; its CSSOM re-serializes a
  style a directive touched (`margin: 0` as `margin: 0px`, `flex: 1` as
  three longhands); and a live `value` on `<output>` replaces the text.
- [x] 1.3 The parity check in `packages/mesa/scripts/corpus.mjs`: render each lowering
  component on both paths and compare the HTML, unscoped. The harness is
  `test/server-emit.test.js`'s `both()`: compile twice (`css: false`), render
  once through `renderToHTML` and once through `Comp(out, props)`, compare raw.
  Built 2026-10-29 as the second half of `--portability server` (no new
  flag; the tally and the grade are one lowering run): every file the tally
  says lowers is compiled on both paths with its imports rebound (a `.mesa`
  compiles on the fly, a stylesheet is an empty module, an alias the
  workspace cannot resolve binds to a stub that answers everything with
  itself), rendered with no props and compared against `renderToHTML`'s
  output, which is trimmed. Three classes are set aside and listed, never
  failed (`FJS-D1640`): a file that throws on both paths, one whose two DOM
  renders differ from each other (a minted id), and one differing only in
  a `style` attribute's text — the attribute itself is still graded. Found
  and fixed on the way: the tally counted a component, `{@html}`,
  `<mesa:portal>` and `<mesa:element>` as lowering while the emitter
  refused them, so `hostOffenses` names them for a string-mode profile and
  the tally fell from 677 to 364; a literal `style` is the DOM path's first
  write after the template (FJS-D1464), so it serializes after the scope
  class and ahead of every live piece; the scope class sits after the
  statics when no class is authored; a live `value` is a property on a
  text-like `<input>`, `<textarea>` and `<select>` and an attribute on every
  other tag, a checkbox, radio, hidden or button input included; a class a
  live write, a toggle or the scope touched is a token list with each token
  once; an each body loses whitespace-only text at its edges
  (`trimEmptyNodes`) where an if branch keeps it; a handler a spread
  carries is not an attribute. One DOM-path wart went rather than being
  imitated: a static class with a trailing space under a scope stamped
  `y z  scope`, the empty token the split left (`compiler.js`, the element's
  class set). Each rule is a row of `server-emit.test.js`'s parity table.
- [x] 1.4 `render-ssr.test.js` § no attribute the author did not write, run on
  both paths, and the output parsed.
  Built 2026-10-29. Each case compiles its source twice (`build`, `buildServer`),
  parses the string-mode module with acorn before importing it (Invariant 15),
  renders both and compares the attribute NAMES per element as the parser reads
  them (`attributesOf`), not as substrings — and the two strings byte for byte.
  The authored lists are written out: `form[action] input[type name]`, the
  relative `formaction` kept, and the live `value` on a text input absent on
  both paths because it is the element's property.
- [x] 1.5 `renderToHTML` takes `target: 'server'` behind an option, with the
  happy-dom fallback named in the result.
  Built 2026-10-29. `renderToHTML(Comp, props, { target: 'server' })` runs the
  component onto an array with no window and no `initRenderer()`, trimmed as
  the DOM serializer trims; any other `target` is refused by name. The fallback
  lives where the compile does: `renderComponent({ compileOptions: { target:
  'server' } })` compiles the string mode, and a file the mode refuses — the
  compiler's throw, now carrying `err.refused`, or `ctx.targetRefusal` on a
  file whose `<script module>` keeps its data half — is compiled again for the
  DOM and listed in the result's `unlowered: [{ file, refused }]`, `[]` when
  every file lowered. A unit records the mode it was ACTUALLY compiled in and
  the executor runs it that way, so a fallen-back file never meets `$$out`.
  A top-level `target: 'server'` on `renderComponent` is refused by name, since
  that slot is the output wrapper (`FJS-D1634`). Only the string mode falls
  back; a host target's module is never run through here. Phase exit measured
  by `bun bench/cases.mjs`: `ssr-100-server` 1,311 µs at 6.78× its floor beside
  `ssr-100`'s 14,350 µs at 319×, so the string path is 11× the DOM path on the
  same table; the new case's ceiling is 10×. A fallen-back child under a
  server-mode parent would be called with `$$out` as its anchor, so once
  components lowered (2.1) one refusal took the whole tree back.

### Phase 2 — Components, snippets and islands

Goal: what Phase 0 ranked as unlowered lowers.
Done when: `example`'s `build:site` prerenders every page with the fallback
count at zero, and `verify:site` passes.

- [x] 2.1 Components and props; snippets and `{@render}` landed in 1.1. The
  fallback from 1.5 must propagate: one refusal anywhere in a tree takes the
  whole tree to the DOM, with a `render-ssr.test.js` case for a server-mode
  entry importing a refused file, or the parent calls a DOM child with
  `$$out` as its anchor.
  Built 2026-10-29: `emitComponent` calls `Child($$out, props)` once, the
  props object built as on the DOM path (spreads first, a written prop and
  its content fallback, a content snippet under `$$runtime.content`); nothing
  is registered or pushed after the call, and `bind:` is its initial value
  flowing down. The propagation is whole-tree, not per importer: the other
  direction fails the same way (a DOM parent calls a string child with a
  comment, and a content snippet crosses modes with its parent), so
  `compileTreeOnTarget` in `render-component.js` recompiles the entire tree
  for the DOM when the first pass names any refusal, keeping that pass's
  `unlowered`. An island (`client:*` under `islands`) is the one component
  still refused, by name, until 2.2; without `islands` it renders inline as
  the DOM path does, and the IR now carries `island` on the node and
  `islands` on the root for that. The corpus parity pass compiles a `.mesa`
  imported from a string-path module for the string path (a Bun resolve
  namespace; `Bun.resolveSync` inside a resolve hook re-enters the resolver
  and loses the answer, and a namespaced module's `import.meta.url` is
  rewritten to the file's), and a lowering file whose child refuses is a
  fourth set-aside (`childRefused`, `FJS-D1640` amended). The pass then
  found three `style` rules the serializer lacked, all happy-dom's CSSOM: a
  `style:` that writes nothing creates no attribute, a spread's `style` is
  `cssText` (re-serialized, replacing every directive before it, an empty
  one kept), and a `style=""` is dropped only by a directive that runs after
  it. Corpus at close: 594 lowering, 456 same, 0 differ, 0 threw on one path,
  37 `childRefused` (every one `<mesa:boundary>` in `ChainRenderer.mesa` or
  `{@html}` in `CodeInput.mesa`, 2.3 and 2.4).
- [x] 2.2 Island markers, the same comment payload the loader reads, and
  `keepAnchors`.
  Built 2026-10-29: `islandPayload` and the marker names moved to
  `runtime-server.js`, which `runtime.js` imports, so one owner writes the
  payload for both paths; `$$host.island($$out, Comp, props, meta)` pushes
  the open marker, calls the child, pushes the close. The IR's `island` is
  `{ directive, media? }` and the emitter writes the DOM path's meta
  (`component`, `directive`, `media`) under `islands`; without the flag the
  call is inline, as before. `keepAnchors` with `target: 'server'` is refused
  by name: the mode writes no anchor comments, and honoring the flag by
  writing nothing would read as the anchors being there. Island markers are
  not anchors and both paths always write them. Proof: every case of
  `render-ssr.test.js` § islands now renders on both paths and asserts the
  bytes agree (payload escapes, dropped and retyped props, nesting, a table
  row), plus a `bothTree` parity case in `server-emit.test.js`. Corpus:
  596 lowering, 457 same, 0 differ, 38 `childRefused` (boundary, `{@html}`).
- [x] 2.3 `<mesa:element>`, `<mesa:boundary>`, `<mesa:head>` (a head buffer
  `wrapPage` splices) and `<mesa:portal>`.
  Built 2026-10-29: the IR gains `boundary` (`states`, the `$$async_` objects
  the body reads per `boundaryWatchSet`; `pending` / `failed`, the snippet
  each branch calls, local first then the component's global one) and `head`
  (`styles`, each `<style>` child's raw text; `children`). A dynamic element
  is `{ const $$tag = $$host.dynamicTag(expr); … }` with every attribute
  live, children and the close tag under `!$$host.VOID.has($$tag)`; the
  refused-tag list moved to `runtime-server.js` and the DOM path's
  `dynamicElement` reads it there. A boundary is the DOM path's
  `boundaryBlock` on a server, not the try/catch this step first named: an
  error wins, a loading state writes `pending`, content otherwise, and
  nothing is caught (`FJS-D377`) so a throw fails both renders alike. A head
  writes into `$$host.head($$out)`, a buffer on the render's array, and
  `_renderString` hands it to `wrapPage` as the new `head` option; the DOM
  path appends to happy-dom's `document.head`, which nothing reads, so the
  body bytes agree and only the page under `full` differs. A portal builds
  its children into a buffer nothing reads, as the DOM path builds them into
  a detached body: a throw or a child's side effect agrees, the markup is
  absent on both. Found on the way: the DOM path put a `<mesa:element>` ahead
  of the whitespace preceding it inside a block, because its label was
  satisfied by the text node the two whitespace runs merged into once the
  placeholder was gone (`FJS-512`'s shape); it now owns an anchor comment as
  every block does. A new corpus set-aside, `boundNode` (`FJS-D1640`
  amended): a tree with a `bind:this` whose script writes on the node under
  happy-dom (DropdownMenu's `aria-expanded` from a `$:`), which the string
  mode cannot hand it (2.5). Corpus: 645 lowering, 496 same, 0 differ, 4
  `boundNode`, 26 `childRefused` (every one `{@html}` in CodeInput, 2.4).
- [ ] 2.4 `{@html}`, per Q2.
- [ ] 2.5 `bind:` writes the initial value; `on:`, `use:`, `{@attach}` and
  transitions are dropped, `bind:this` is null. 1.1 drops all of them
  (a `dep` line keeps the expression evaluated); the initial value is what
  remains.
- [ ] 2.6 `{#await}`, per Q3.

### Phase 3 — The default

Goal: `renderToHTML` takes the server mode for every component that lowers.
Done when: `email-kit` and `site-kit` builds are byte-identical to the
happy-dom path, or each difference is a ruling.

- [ ] 3.1 Switch the default, keeping the fallback.
- [ ] 3.2 Decide whether happy-dom stays a required peer for the server half.
  That depends on Q1.

## 5. Open questions

- **Q1: the script half still reads browser globals.** A component's
  `<script>` runs on the server, and `docs/STATIC_RENDERING.md` § *What a
  browser global answers* records that it reads `window.innerWidth`,
  `matchMedia` and the others and gets answers. `FJS-D214` made that silence
  deliberate. Options:
  - **A**: install happy-dom's window as globals only, which costs one window
    per process and no nodes.
  - **B**: a small stub of the globals that are read.
  - **Recommend A**: the measured cost is nodes, not the window, and B is a
    second answer to a question `FJS-D214` settled.
- **Q2: `{@html}`.** A raw string has to be pushed as-is. That is the one
  place the escaping owner is deliberately bypassed, so it needs its own test.
  - **A** — push the string verbatim. Fastest, but the client parses the same
    string through a `<template>`'s `innerHTML`
    (`packages/mesa/src/runtime.js:6107`), which repairs unclosed and misnested
    tags, so a malformed string serializes differently on the two paths and
    § 3's corpus parity check fails on it.
  - **B** — parse the string once with happy-dom's fragment parser and push its
    serialization. Output matches the client's parse, and `{@html}` stops
    being a bypass; the cost is a parse per `{@html}`, not a document, and the
    window Q1-A installs already carries the parser.
  - **C** — `{@html}` is a kind the mode does not lower: the component falls
    back to happy-dom and the result names it in `unlowered`, as § 3 already
    provides. No new code; every component using it pays the old cost.
  - **Recommend B** — it keeps § 3's "same HTML on either path" without a
    second escaping path. A's verbatim output disagrees with `runtime.js:6107`
    on any malformed string; C is the fallback if B's parse is measured as the
    cost.
- **Q3: `{#await}`.** The DOM path renders the pending branch and
  `flushSync` serializes before the promise settles.
  - **A** — write the pending branch. Parity with the DOM path as it is.
  - **B** — await the promise and write the resolved branch; `renderToHTML` is
    already async. What Svelte 5 and Solid's streaming do, and what a prerender
    fetching at build wants.
  - **C** — fall back to happy-dom, named in `unlowered`.
  - **Recommend A** — § 3 is parity against the DOM path, and B changes what a
    page shows on both paths, which is its own ruling once a site asks for it.

## See also

- `IDEAS/mesa-ir.md`: the IR, the host emitter, and § 1's *one backend today*.
- `packages/mesa/src/host/emit.js`, `host/targets.js`, `runtime-terminal.js`:
  the seam and the nearest existing target.
- `packages/mesa/docs/STATIC_RENDERING.md`: what a server render runs, and the
  globals table.
- `ISSUES.md` § Closed, `FJS-2993`: the parse half and its measurements.
