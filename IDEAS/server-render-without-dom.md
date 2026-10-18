---
id: server-render-without-dom
status: proposed
dated: 2026-10-16
---

# Idea — a server render that builds no DOM

**Status: PROPOSED.** Dated 2026-10-16. The figures in § 1 were measured that
day by `packages/mesa/bench/cases.mjs` `ssr-100`. They hold for that afternoon
only (`PHILOSOPHY.md` § VII). This paper picks up where `FJS-2993` (closed)
stopped: the per-row template parse is gone, and what remains is happy-dom
itself.

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
| after (one parse per template, cloned) | 2.6 ms at load 5 | 92× at load 5, 124–146× at load 27 |

After the fix, a CPU profile has no parser left in it. The remaining cost is
happy-dom's node model:

- `[connectedToNode]`: the walk happy-dom runs over every subtree inserted into
  a connected container.
- Node and Element construction.
- `MutationRecord`s nobody observes.
- `NamedNodeMap` attribute bookkeeping.

**Rendering into a detached container gave no gain clear of the noise**, so the
cost is the node model and not the attachment.

A prerender pays this once per row on every page. An islands page pays it once
per request.

## 2. The shapes

- **A: a host target whose runtime builds a plain node tree.** Each node is an
  object holding a tag, attributes and children, and the tree is serialized
  once.
  - **Recommended.** The seam already exists. `host/emit.js` lowers `ctx.ir` to
    calls on `$$host`, and `host/targets.js` holds one profile per target
    (`FJS-D699`, `FJS-D1074`). A `server` profile plus a `runtime-server.js` is
    a third target beside `terminal` and `native`, not a new emitter.
  - Reactivity stays as it is, because a server render runs the graph once and
    reads it.
- **B: a string emitter.** Template slots are concatenated directly; this is the
  shape Svelte, Solid and Vue all use on the server.
  - It is the faster shape.
  - It is a second builder beside `compiler.js`'s DOM builder, which `mesa-ir`
    exists to stop being necessary.
  - It writes text in an order a `{#each}` or `{#if}` decides, so it needs a
    second implementation of every block's semantics.
  - Revisit only if A's tree is measured as the cost.
- **C: keep happy-dom and tune it.** This is what `FJS-2993` already did. The
  detached container was the remaining tuning option, and it was measured
  without a clear gain.

## 3. What must stay true

- **The same component gives the same HTML on either path.** A string path that
  disagrees ships a page that differs from what the client builds, and nothing
  reports it. The artifact that catches it is a corpus parity check:
  `scripts/corpus.mjs` already compiles every `.mesa` in the workspace. Phase 1
  makes it render each one on both paths and compare the serialized output.
- **Escaping has one owner.** Text and attribute values are escaped in exactly
  one function of the server runtime. A mistake there is XSS in a public file,
  so it is graded by `test/render-ssr.test.js`. That file's section *no
  attribute the author did not write* runs on both paths.
- **A kind the target cannot lower falls back to happy-dom for that component
  and is NAMED in the render's result.** The result never approximates the
  output. A fallback costs speed and not correctness, so refusing to render
  would be out of proportion (§ IV *ergonomics vs. strictness*). `mesa-ir`'s
  `unlowered` is the existing report, and its kind names what the fallback
  missed.

## 4. Phases

### Phase 0 — Measure the corpus

Goal: know how much of the workspace a server target would lower today.
Done when: `bun run corpus --portability server` prints a tally of what lowers
and what does not, beside the terminal's.

- [ ] 0.1 A `server` profile in `host/targets.js` with no runtime yet: every
  tag, every event inert, `paintsCss: true`. Its only job is to make
  `--portability server` count.
- [ ] 0.2 Read the tally and rank what is unlowered. Components, slots,
  snippets, `<mesa:element>`, boundaries and island markers are the expected
  ones.

### Phase 1 — Static markup over a plain tree

Goal: a component of elements, text, attributes, `{#if}` and `{#each}` renders
without happy-dom.
Done when: `ssr-100` runs on the server target, its ceiling drops below 30×,
and the corpus parity check passes for every component that lowers.

- [ ] 1.1 `runtime-server.js`: `$$host` over a plain node tree and one
  serializer, which is where escaping lives.
- [ ] 1.2 The parity check in `scripts/corpus.mjs`: render each lowering
  component on both paths and compare the HTML, unscoped.
- [ ] 1.3 `render-ssr.test.js` § no attribute the author did not write, run on
  both paths.

### Phase 2 — Components, slots and islands

Goal: what Phase 0 ranked as unlowered lowers.
Done when: `example`'s `build:site` prerenders every page with the fallback
count at zero, and `verify:site` passes.

- [ ] 2.1 Components and props, slots and snippets.
- [ ] 2.2 Island markers and `keepAnchors`, so hydration reads the same
  comments.
- [ ] 2.3 `<mesa:element>` and `<mesa:boundary>`.

### Phase 3 — The default

Goal: `renderToHTML` takes the server target for every component that lowers.
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
- **Q2: `{@html}`.** A raw string has to be inserted into a plain tree as-is
  and serialized unescaped. That is the one place the escaping owner is
  deliberately bypassed, so it needs its own test.
  - **A** — a `raw` node kind in the plain tree, serialized verbatim. Fastest,
    but the client parses the same string through a `<template>`'s
    `innerHTML` (`packages/mesa/src/runtime.js:6107`), which repairs unclosed
    and misnested tags, so a malformed string serializes differently on the
    two paths and § 3's corpus parity check fails on it.
  - **B** — parse the string once with happy-dom's fragment parser into plain
    nodes, then serialize through the one escaping owner. Output matches the
    client's parse, and `{@html}` stops being a bypass; the cost is a parse
    per `{@html}`, not a document.
  - **C** — `{@html}` is a kind the server target does not lower: the
    component falls back to happy-dom and the result names it in `unlowered`,
    as § 3 already provides. No new code; every component using it pays the
    old cost.
  - **Recommend B** — it keeps § 3's "same HTML on either path" without a
    second escaping path, and the window Q1-A installs already carries the
    parser. A's verbatim output disagrees with `runtime.js:6107` on any
    malformed string; C is the fallback if B's parse is measured as the cost.

## See also

- `IDEAS/mesa-ir.md`: the IR, the host emitter, and § 1's *one backend today*.
- `packages/mesa/src/host/emit.js`, `host/targets.js`, `runtime-terminal.js`:
  the seam and the nearest existing target.
- `packages/mesa/docs/STATIC_RENDERING.md`: what a server render runs, and the
  globals table.
- `ISSUES.md` § Closed, `FJS-2993`: the parse half and its measurements.
