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

- [ ] 1.1 The string mode in `host/emit.js`: a profile field names it, and
  each `emit*` writes `$$out` line bodies under the same walk. `$$out` is an
  array joined once at the root.
- [ ] 1.2 `runtime-server.js`: the one escaper and the attribute serializer
  (boolean attributes, `value`, `checked`, `selected`, `class:` and `style:`
  merged as the DOM path merges them), nothing else.
- [ ] 1.3 The parity check in `packages/mesa/scripts/corpus.mjs`: render each lowering
  component on both paths and compare the HTML, unscoped.
- [ ] 1.4 `render-ssr.test.js` § no attribute the author did not write, run on
  both paths, and the output parsed.
- [ ] 1.5 `renderToHTML` takes `target: 'server'` behind an option, with the
  happy-dom fallback named in the result.

### Phase 2 — Components, snippets and islands

Goal: what Phase 0 ranked as unlowered lowers.
Done when: `example`'s `build:site` prerenders every page with the fallback
count at zero, and `verify:site` passes.

- [ ] 2.1 Components and props, snippets and `{@render}`.
- [ ] 2.2 Island markers, the same comment payload the loader reads, and
  `keepAnchors`.
- [ ] 2.3 `<mesa:element>`, `<mesa:boundary>` (a try/catch writing the
  fallback), `<mesa:head>` (a head buffer `wrapPage` splices) and
  `<mesa:portal>`.
- [ ] 2.4 `{@html}`, per Q2.
- [ ] 2.5 `bind:` writes the initial value; `on:`, `use:`, `{@attach}` and
  transitions are dropped, `bind:this` is null.
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
