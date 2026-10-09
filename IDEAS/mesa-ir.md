---
id: mesa-ir
status: proposed
dated: 2026-09-25
---

# Idea — Mesa's intermediate representation: one template tree, a backend per device

**Status: IN PROGRESS — § 6 steps 1 and 3 have a first slice in the tree
(2026-10-09); the rest is proposed.** Dated 2026-09-25. The counts in § 1 were
measured that day and are true for an afternoon (`PHILOSOPHY.md` § VII). Cite
`packages/mesa/src/ir.js`, `terminal/emit.js`, `runtime-terminal.js` and
`test/terminal/` for what is built; nothing else here is behavior. See
`VERIFYING.md`.

**The question:** can all frontend code be written as `.mesa`, compiled to a
neutral tree, and handed to a backend that converts it into whatever each device
runs natively?

**The half already ruled.** `FJS-D38` settled the authoring side: `.mesa` is the
model for every interface, and a new surface is a compiler backend plus a runtime,
never a second component model. It also named the half it does not provide:
*there is no renderer abstraction, so each target restates the emit, and the first
non-markup target builds that seam or proves it unnecessary.* This paper is about
that seam: what it is, where in the compiler it sits, and what it costs.

---

## 1. What the tree has

**The DOM enters the compiler at one point, and that point is late.** The count
below uses the DOM calls a backend would have to replace (`document.*`, the
`appendChild` / `insertBefore` / `setAttribute` / `addEventListener` /
`textContent` / `classList` family, `htmlToFragment`, `refer(`). It is not the
pattern `FJS-D38` counted, so the numbers differ from that ruling's 2 and 99. Both
counts show the same shape.

| `compiler.js` section | Lines | DOM calls |
| --- | ---: | ---: |
| 3. Parser | 720 | 0 |
| 4. Analyzer | 1,571 | 0 |
| 5. CSS | 379 | 0 |
| 6. Builder (`buildBlock`) | 1,108 | 12 |
| 7. Parts (`{#if}`, `{#each}`, components, props) | 1,600 | 0 |
| 8. Emitter | 2,013 | 17 |
| 9. Pipeline | 1,050 | 1 |

| `runtime.js` | DOM calls |
| --- | ---: |
| reactive core (lines 1–760) | 3 |
| everything after it | 191 |

The parser and the analyzer (about 2,300 lines) are already target-free. The parts
make no DOM calls themselves, but the code they emit calls runtime block helpers,
and the runtime past its core is DOM throughout. **So one side of the compiler is
already neutral. What is missing is a boundary object between that side and the
side that is not.**

**Three things in the tree look like the IR, and none of them is.**

- **`xNode`** (compiler § 2, labeled *xNODE IR*) is a code writer: a
  dependency-resolved tree of JavaScript text fragments. It describes the output
  program, not the interface. Because of its label, it is the first thing a
  reader will try to reuse for this, and the wrong one.
- **The parse tree** (`{ type: 'node', name, attributes, body }`, plus `text`,
  `exp`, `if`, `each`, `await`, `key`, `slot`, `snippet`, `fragment`) is the
  closest candidate. It is still not a boundary: `buildBlock` walks it and writes
  the HTML template string and the binding JavaScript in the same pass, and the
  analysis a backend needs (which signals each expression reads, which
  identifiers are reactive) lives on a mutable `ctx`, not in the tree.
- **SSR and email are not second backends.** `render.js` installs happy-dom and
  runs the DOM output inside it, and `target: 'email'` renders through the same
  path. **There is exactly one backend today.** Every other target is a host
  that imitates a browser.

---

## 2. What the IR would be

**It covers the template half only.** The `<script>` half is JavaScript that
reads and writes signals, and every backend runs it unchanged. That is what
`FJS-D38` means by *the same signal graph*, and it decides the native question
in § 5.

The IR is the output of parse plus analysis, lowered into a tree that
serializes and is the same for every target:

| Node | Carries |
| --- | --- |
| element | a tag or a kit component name, static attributes, and the source span |
| binding | an expression id, the signals it reads (the analyzer already computes `watchDeps`), and where it lands: a text slot, an attribute, or a prop |
| handler | the gesture and the expression id. `FJS-D385` names a UI event a *Gesture*, which is the right word for a tree that is not a DOM |
| control flow | `if`, `each` (with its key), `await`, `key`, `snippet` / `render` |
| component | the instance, its props as bindings, its slots as subtrees |
| style | the scope id (content-addressed, Invariant 12) and the scoped rules |

**The first consumer would be the DOM backend: today's builder and emitter,
reading the IR instead of the parse tree plus `ctx`.** That is what makes the
seam checkable. See § 6.

---

## 3. The hard part is the vocabulary, not the tree

**An IR that carries `<div class="card">` is a DOM tree with extra steps.**
`div` means nothing to SwiftUI, Compose or a terminal cell grid. A backend given
raw HTML has to interpret HTML, and a backend given raw CSS has to implement
CSS. That is the whole of what makes a "write once, run natively" project
expensive, and a tree format solves none of it.

**What ports is what is already abstract**, and `IDEAS/ui-ontology.md` § 2 has
already laid it out in CAMELEON's four levels:

- **Abstract UI**: the Resource, `controlFor` / `displayFor`, and Interaction
  tasks (`FJS-D384`, `FJS-D387`). "Edit a date" has a native control on every
  platform, while `<input type="date">` has one on only one.
- **Concrete UI**: the kit's components and css's Container tiers. `<Form>`,
  `<Field>` and a `.card` are nouns a backend can map.
- **Style**: Invariant 13 already requires a tone and a treatment, never a color.
  `danger` + `outlined` can be lowered to an ANSI attribute, a SwiftUI modifier
  or a Compose theme slot. `#e5484d` cannot. **Invariant 13 was written for the
  browser, and it is what makes styling portable at all.**

**This gives a portability grade that needs no new concept:** a component is as
portable as the lowest node in its tree. One written against the kit and css
vocabulary lowers everywhere a backend maps those terms. One written with raw tags
and hand-written CSS is web-only, and the compiler can say which node made it so
(for example, `<table> at Orders.mesa:14 has no terminal lowering`). That report
is the enforcement artifact for § 7's ninth question.

---

## 4. Prior art, and what each one is evidence of

| System | Shape | Evidence of |
| --- | --- | --- |
| **Svelte Native** over NativeScript | a fake DOM over native views, so the compiler is unchanged | shape A works and ships. It is also the shape Mesa's own SSR already takes with happy-dom |
| **Solid `solid-js/universal`**, **Vue `createRenderer`**, React's reconciler | a runtime interface of about ten node operations (create, insert, set property, remove) | shape B. The cost is the web fast path: template cloning goes away unless the DOM backend keeps its own emit |
| **React Native Fabric**, **Lynx** (ByteDance, 2025) | JavaScript drives a shadow tree, native code owns the views. Lynx takes web-like markup and CSS | a JS engine plus native views is the proven answer to *where does the script run on a phone* |
| **Flutter** | owns every pixel and uses no platform widgets | the alternative to native views. Not this framework's shape, since it abandons the platform's controls |
| **CAMELEON / UsiXML** (2003 onward) | an abstract UI in XML, reified per device | **the warning.** Model-based UI tried exactly this question and mostly failed in practice: the common vocabulary was too small, and per-device fixes leaked back into the abstract model. The lesson is that the abstract layer must stay small and real, with a per-target escape |
| **OpenTUI** | a paint and layout engine separated from the component model | the terminal engine `FJS-D37` bought is a backend of this kind (`terminal-surface.md` § 6) |

Lynx and OpenTUI specifics are to be verified before anything depends on them.

---

## 5. Three shapes, priced

**A — a host shim per platform.** Keep the one DOM backend and give each device a
DOM-shaped facade over its native views, the way SSR already does with happy-dom.
This is the cheapest shape, and it proves the IR unnecessary **where the device
really is a browser**: `desktop/` wraps a system webview and `extension/` is
Chrome, so neither needs an IR at all. Everywhere else it fails on style: a DOM
facade over UIKit has to implement CSS layout, which is Svelte Native's long
tail.

**B — a runtime node-ops interface.** The compiler emits `ops.insert(...)`
instead of a template string plus `refer()` paths, and each target supplies the
ops. This makes the runtime shared, which `FJS-D38` wanted. It also removes
template cloning, the reason the DOM output is fast, unless the DOM backend keeps
its own emit. Once it does, this becomes shape C.

**C — a compile-time IR with one emitter per backend.** The front half of the
compiler lowers to the IR (§ 2). The DOM emitter is today's builder and emitter.
A terminal emitter writes calls into a cell-tree runtime over the bought engine.
A native emitter writes calls into a native-view runtime. Each backend's runtime
is restated, the price `FJS-D38` already accepted. The reactive core (runtime
lines 1–760, 3 DOM calls) is shared by all of them.

**Recommend C.** A is the right answer for the surfaces that already run in a
browser, and those need nothing new. B collapses into C the first time the web
refuses to give up template cloning. C is the only shape where adding a backend
touches nothing an existing backend reads.

**On native specifically, the answer is a runtime, not code generation.**
Emitting SwiftUI or Compose source looks like the purest version of "converted
into the device's native language". But the `<script>` half is JavaScript and
the signal graph lives in it, so generating Swift would mean translating
arbitrary JavaScript, and that is a second authoring model arriving by accident,
which `FJS-D38` names as its one silent failure. Native is a JavaScript engine
running the shared script and core, driving platform views through a native
backend's runtime: Fabric's and Lynx's shape, emitted from Mesa's IR.

---

## 6. Sequencing, and what proves each step

**Started 2026-10-09.** `FJS-D689` scheduled it as the mobile plan's third
rung, and `FJS-D545` makes steps 1 and 3 one piece of work: the IR is cut
with the terminal backend as its second consumer, not ahead of it.

1. **Extract the IR, with the terminal backend reading it from the first
   commit.** The DOM backend moves onto it one node kind at a time, and each
   move is graded **byte-identically** over the whole corpus, which Invariant 12
   makes exact. `bun run corpus -- --save before` / `--diff before` in
   `packages/mesa` is that grade. It found 507 files and 1,014 compiles (prod
   and dev), 0 refused and 0 invalid JS, identical run to run. A moved byte is
   either a bug or a change to be named.
   *First slice landed 2026-10-09:* `src/ir.js` lowers every compile into
   `ctx.ir` (element, text with split parts, binding, handler, `if`, `each`;
   everything else `unlowered` and named). Two DOM-path owners moved into the
   seam and the corpus stayed identical: `parseEachHeader` / `eachFrame`
   (shared with `makeEachBlock`) and `buildHead` (the target-free head
   declarations, split out of `buildRuntime`). The DOM emitter itself still
   reads the parse tree; it moves one node kind at a time from here, each move
   graded by the corpus.
   *Slot routing moved 2026-10-09:* `routeSlots(node, preserveComments)` in
   `compiler.js` is the one answer to which slot each child of a component
   call fills. `makeComponent` builds a block per entry and `lowerComponent`
   lowers one, so the two targets cannot disagree. It touches no node, which
   is what lets `lower` run first. The corpus stayed identical. Two DOM
   defects went with the second copy (`FJS-2168`). Props are still
   classified twice. The IR's copy is the stricter one (an attribute it
   cannot place is a directive, and the terminal refuses it), so the two can
   differ only toward a refusal.
   *Props moved 2026-10-09:* `componentAttributes(node)`, beside
   `routeSlots`, is the one answer to what each attribute on a component call
   is (`prop`, `spread`, `bind`, `bind-this`, `island` or `refused` with its
   message). `makeComponent` builds from it and `lowerComponent` lowers it,
   and a refused attribute is reported by both targets in the same words and
   passes nothing on either. The corpus stayed identical. Five shapes the DOM
   path dropped or passed under a name no child reads went with the second
   copy (`FJS-2169`). No component-call double is left between the two
   targets; the value of each prop is still lowered per target, which is
   lowering rather than classifying.
2. **The portability report** (§ 3), per target, as a report rather than a
   refusal until a target exists. It runs over the same corpus and says how much
   of `example/` and `packages/ui` would lower to a terminal today.
   *First report 2026-10-09:* `bun run corpus -- --portability terminal` in
   `packages/mesa`. `terminalOffenses(ir)` in `src/terminal/emit.js` is the one
   list of what the terminal refuses: the emitter throws its head and the report
   tallies all of it. Of 508 files, 104 lower today (20%): `packages/ui` 0 of
   135, `example/web` 26 of 69, `packages/basecamp` 24 of 114. A component tag
   is in 264 files and is the only blocker in 128; a dynamic attribute is in
   141. Lowering greedily, the order is component (+128, to 46%), `<output>`
   (+40), dynamic attribute (+29), `on:submit` (+18), `<slot>` (+11), then
   spreads, `style:`, `{@render}`, `{#snippet}` and `bind:`. The component
   figure is an upper bound, because the report counts a tag as lowered
   without following its import to the child's file, and `packages/ui` lowers
   nothing yet. The events outside the table, which `FJS-D692`'s closed set is
   read from, are `submit` (28 files), `change` (8), `close` and `cancel` (4),
   then pointer and wheel events in one file each.
   *Second report 2026-10-09, after components lowered (step 3):* the report
   follows each component tag through its import to the child's file
   (`scripts/portability.js`, counting pinned by `test/portability.test.js`),
   so a file lowers only when every component it calls does. 125 of 510 lower
   (25%); 42 more pass on their own and are held by a child. `packages/ui` is
   still 0 of 135, so everything importing the kit is held. A tag with no
   import (Sierra's `autoImport`) is its own shape, in 31 files. Greedily:
   dynamic attribute (+23, to 29%), spread (+7), `style:` (+18), `{@render}`
   (+7), `bind:` (+5), `<mesa:portal>`, `<mesa:window>`, `class:`. A dynamic
   attribute is in 177 files, and alone unlocks only 23 because the kit files
   that carry it carry three or four other shapes too.
   *Third report 2026-10-09, after dynamic attributes lowered:* 149 of 511
   (29%), as predicted. `packages/ui` is 1 of 135. Greedily next: spread
   (+7), `style:` (+18), `{@render}` (+3), `bind:` (+5), `<mesa:portal>`,
   `<mesa:window>`, `class:`. The two widest shapes unlock nothing alone:
   `{#snippet}` (99 files) and `bind:` on a component (93).
   *Fourth report 2026-10-09, after spreads lowered:* 160 of 513 (31%), +9 as
   predicted; `packages/ui` is 7 of 135. A component spread unlocked no file
   alone (it always sits beside an element spread or a `bind:`). Greedily
   next: `style:` (+18), `{@render}` (+7), `bind:` (+5), `<mesa:portal>`
   (+6), `<mesa:window>` (+7), `class:` (+5).
3. **The terminal backend**: an emitter from the IR to a runtime over the
   bought engine (§ 8). The first slice is a fixture with static elements, a
   text binding, a handler, `{#if}` and `{#each}`, mounted in the engine's
   headless renderer and asserted by its captured frame after typed keys.
   *First slice landed 2026-10-09:* `compile(src, { target: 'terminal' })`
   runs `src/terminal/emit.js` over `ctx.ir` and the output imports
   `@frontierjs/mesa/runtime/terminal.js` (`src/runtime-terminal.js`, over
   `@opentui/core` — `FJS-D698`, `FJS-D699`). `src/terminal/tags.js` is the
   per-target table (`FJS-D700`, `FJS-D692`): a tag or event not in it, any
   directive (`bind:`, `class:`, spreads, `{@attach}`), a dynamic attribute
   and every `unlowered` node is refused as `X at File.mesa:L:C has no
   terminal lowering`. Proved by `bun run test:terminal` in `packages/mesa`:
   `specs/runtime.spec.mjs` drives `$$tui` directly and `specs/counter.spec.mjs`
   compiles the fixture and asserts the frame after Tab and Enter. Not in the
   slice, refused by name until a later one: dynamic attributes, `bind:`,
   `{#await}`, `{#key}`, snippets, scoped styles. The refusal shape is what
   step 2 collects.
   *Second slice 2026-10-09, components and `<slot>`:* the IR lowers
   `<Child …>` to a `component` node (props, routed slots, and everything else
   kept as a directive to refuse) and `<slot>` to a `slot` node with its
   fallback. The terminal calls the child at a marker, which the child's own
   `append(__anchor, …)` lands before, and pushes the whole props object when
   any prop is live, the same two calls the DOM path makes. `<output>` joined
   the tag table. Proved by `specs/component.spec.mjs` (a prop push, a callback
   prop, default and named slots, fallbacks, a component inside `{#if}`).
   Still refused: `bind:`, spreads, `on:` and `{@attach}` on a component,
   `{#snippet}` children, and the dynamic `<component this>`.
   *Third slice 2026-10-09, dynamic attributes:* a live attribute is a static
   one that moves. `$$tui.set_attribute` is the one owner of both: `element()`
   routes its static attributes through it, and a live one reaches it from a
   guarded render effect, the shape a text binding has. `null` and `false`
   remove the attribute, as on the DOM path. Three names mean something on a
   terminal: `value` and `placeholder` on an input, and `disabled`, which
   takes a control out of the Tab order and out of activation. Every other
   name is kept and paints nothing, as a static `class` already did, and as
   the scoped CSS it would select is already handed back unpainted. The
   engine emits `input` when an input's value is written, which a browser's
   program write never does, so that write is muted. Proved by
   `specs/attributes.spec.mjs`. Breaking the mute fails 4 of its 6
   assertions, and leaving a disabled button focusable fails 2.
   *Fourth slice 2026-10-09, spreads:* on a component, a spread is merged
   under the written props with `Object.assign`, the DOM path's object, and
   pushed whole. On an element, `$$tui.spread` is the twin of
   `spreadAttributes`: a value goes to `set_attribute`, a function under
   `on<event>` to that event's handler, and a key the object stops carrying
   is removed. The handler is wired once per event through a slot the spread
   rewrites, because the engine cannot take a listener off a node, so a
   replaced object would stack a second handler. A key with no terminal
   meaning is inert, never refused: a spread's keys are data, so no compile
   can refuse one, and a throw at runtime would take a render down over a kit
   forwarding `onmouseenter`. Proved by `specs/spread.spec.mjs` and
   `specs/spread-element.spec.mjs`. Stacking the handler fails 2 of 6, and
   keeping a dropped key fails 2 of 6; merging the spread over the written
   props fails 2 of 4.
   *The nine for slice 4 and the props move, answered late:* (1) one fewer
   origin. (2) none new. (3) the problem's. (4) an attribute that reaches no
   child now says so, as `on:` and `class:` already did. (5) both targets
   derive from `componentAttributes`. (6) it sits beside `routeSlots`, the
   other half of the same call, and `$$tui.spread` is `spreadAttributes`'s
   twin. (7) exported, its kinds documented. (8) a refused attribute is a
   warning, the tier its siblings already had, and an inert spread key is
   *ergonomics vs. strictness* again. (9) must stay true: both targets read
   one attribute the same way, and a spread key acts as its written spelling.
   What fails: the corpus diff, `terminal-emit.test.js` (identical warnings
   from both targets) and the two spread specs. That an inert key paints
   nothing is asserted by nothing (`none`). Tier: Assessment.
   *The nine, answered late, after both cuts were green:* (1) origin: one
   fewer, since slot routing has one owner. (2) concept: none new. (3)
   complexity: the problem's. (4) predictability: a live attribute now acts as
   its static spelling does. (5) derived: yes, `lowerComponent` reads
   `routeSlots`. (6) owner: `routeSlots` sits beside `blockSlotTarget`, which
   already owned half of it, and `set_attribute` is the terminal's twin of the
   DOM's `set_attribute`. (7) boundary: `routeSlots` is exported and named.
   (8) failure: an attribute with no terminal meaning is inert rather than
   refused. *Ergonomics vs. strictness* decides it. The cost of an ignored
   `class` is a style on a target that paints no CSS anyway, while refusing it
   would refuse most of the corpus. (9) must stay true: the DOM output is
   unchanged by the routing move, and a live attribute behaves as its static
   spelling does. What fails: the corpus diff, `block-slot-routing.test.js`
   and `attributes.spec.mjs`. That an inert name paints nothing is asserted by
   nothing (`none`). Tier: Assessment.
4. **Native**, after offline-first exists. `one-mental-model.md` § *The target
   set's missing member* already argues that mobile is refused until then,
   because store review, eviction and background execution make offline-first a
   prerequisite. The IR does not change that argument. *Narrowed 2026-10-09 by
   [`FJS-D689`](../DECISIONS.md#fjs-d689): offline-first gates store release only.*

---

## 7. The nine questions (`decision-rules`)

Answered before any code, for the proposal as written.

1. **Another origin?** No. The IR is derived from the `.mesa` source on every
   compile and is never written by hand or committed.
2. **Concept budget?** One noun, *the IR*, internal to the compiler. An author
   never writes or reads it. The portability grade reuses existing words
   (Interaction task, Container tier, tone, treatment).
3. **Whose complexity?** The problem's. There is more than one device.
4. **Predictability?** Better. "Will this component run on X" gets a
   compiler-stated answer instead of a try-it answer.
5. **Derived?** Yes, and it moves one restatement: `FJS-D38`'s per-target emit
   stays, while the front half stops being tangled with the DOM half.
6. **One owner, and an existing one?** `packages/mesa/src/compiler.js`.
   Lowering is a stage of the one compiler, not a new package. Mesa stays the
   leaf (Invariant 1 is untouched).
7. **Boundary explicit?** Yes, and that is what the IR is for: a named, typed
   tree between analysis and emission, where today there is a mutable `ctx`
   shared by both.
8. **Failure proportional?** The portability grade is a report until a target
   exists and becomes a refusal per target once one does. A web-only component
   is never wrong on the web.
9. **Wrong without anything saying so?** *What must stay true:* the DOM output
   is unchanged by the extraction, and a node with no lowering is named rather
   than dropped. *What fails:* the byte-identical corpus compile in step 1, and
   the portability report in step 2. *Since 2026-10-09, answered late and
   named as late:* the corpus diff is `bun run corpus -- --diff before` in
   `packages/mesa` against the saved baseline; the terminal frame is
   `test/terminal/run.mjs`, in that package's `test` script; a node with no
   lowering is a named refusal pinned by `test/terminal-emit.test.js`. The
   report of step 2 is still `none`.

**§ IV:** *coherence vs. convention*, the same adjudication `FJS-D38` turned on.
Every platform's convention is its own component model or its own language, and
the codegen-to-Swift reading of the question is that convention arriving
through the back door. **§ VII tier:** Assessment. The ruling this would amend,
if any, is `FJS-D38`'s *the runtime is not derived*, and only once step 1 is
built.

---

## 8. The engine, measured 2026-10-09

`FJS-D37` § 5 ruled that a TUI buys its engine and named no engine. **OpenTUI's
core (`@opentui/core` 0.5.17) was run on this machine under Bun 1.4.2**, in a
scratch directory and not in the tree. It is a Zig cell renderer reached over
Bun FFI, with yoga layout and a Node build beside the Bun one, and its React and
Solid bindings are separate packages that Mesa would not import.

- **The node operations a Mesa runtime needs are all there**: `add`,
  `insertBefore`, `remove` and `destroyRecursively` on every renderable;
  property setters that repaint (`text.content = …`); `focus` / `blur`; and
  events on an input (`input`, `enter`). That is the same list `{#if}` and
  `{#each}` already call on the DOM.
- **It ships a headless renderer** (`@opentui/core/testing`):
  `createTestRenderer({ width, height })` with `captureCharFrame()` and mock
  keys (`typeText`, `pressEnter`, `pressTab`). A terminal spec therefore needs
  no TTY and no Chrome, and it asserts the frame a person would see.
- **A box with a title, a text and an input, typed into and submitted,** painted
  correctly at each step, and an `insertBefore` followed by a `remove` repainted
  correctly. Renderer boot took 12 ms and the whole script 41 ms.

Ink was not measured, because it is React, and the paper's question is whether
Mesa reaches a terminal without a second component model.

---

## Open questions

- ~~**Which engine does the terminal runtime drive?**~~ **Answered 2026-10-09 (`FJS-D698`): A — OpenTUI's core alone, pinned to an exact version while it is 0.x, and never its React or Solid binding.**
  - **A** — OpenTUI's core alone, pinned to an exact version while it is 0.x,
    and never its React or Solid binding.
  - **B** — Ink. Mature, but it ships React under the runtime.
  - **C** — write the cell buffer, layout and input ourselves. `FJS-D37` § 5
    refuses this by name.
  - **Recommend A** — § 8 measured it doing every operation the runtime needs.
    Its core is a renderer with no component model, which is the seam a Mesa
    backend plugs into. *Batteries vs. smallness*: it is severable as an
    optional peer behind one runtime file, and the IR and the emitter never name
    it, the same rule `FJS-D690` sets for Lynx. *What must stay true:* a
    terminal fixture paints the frame it should. *What fails:* the headless
    frame specs from step 3. A missing install fails through `missingPeer`.
- ~~**Where do the terminal emitter and its runtime live?**~~ **Answered 2026-10-09 (`FJS-D699`): A — in `@frontierjs/mesa`: the emitter is a stage of `compiler.js` selected by a target option, the runtime is a sibling of `runtime.js` exported at a subpath, and the engine is an optional peer, as happy-dom already is.**
  - **A** — in `@frontierjs/mesa`: the emitter is a stage of `compiler.js`
    selected by a target option, the runtime is a sibling of `runtime.js`
    exported at a subpath, and the engine is an optional peer, as happy-dom
    already is.
  - **B** — a new package, `@frontierjs/mesa-terminal`, that imports the
    compiler's IR and holds the emitter and runtime.
  - **Recommend A** — § 7's sixth answer already places lowering inside the one
    compiler, and B would make the IR a published interface before it has two
    consumers. Mesa stays the leaf, since an optional peer is not a framework
    dependency. The `cli/` surface (Invariant 3) is where an app would run the
    output, and that is a separate question for after the first slice.

- ~~**Does the IR carry raw HTML tag names, or only the abstract vocabulary?**~~ **Answered 2026-10-09 (`FJS-D700`): A — raw tags plus a per-target lowering table. Every existing component compiles, and portability is whatever the table covers.**
  - **A** — raw tags plus a per-target lowering table. Every existing component
    compiles, and portability is whatever the table covers.
  - **B** — abstract vocabulary only, with raw tags as a web-only escape node.
    Cleaner, but every raw `<div>` in the corpus becomes an escape.
  - **Recommend A** — the portability report makes the gap visible without
    rewriting 461 files first, and B can be reached later by shrinking the table.
- ~~**Does step 1 run before the terminal backend exists?**~~ **Answered 2026-09-29 (`FJS-D545`): B — no. Extract the IR in the same piece of work as the first non-DOM backend, so the seam is placed by a real second consumer rather than a guess.**
  - **A** — yes, as a refactor graded by the byte-identical corpus.
  - **B** — no. Extract the IR in the same piece of work as the first non-DOM
    backend, so the seam is placed by a real second consumer rather than a guess.
  - **Recommend B** — an IR with one consumer is a guess about where the second
    one needs the cut (`cut-one-level-simpler`). The byte-identical check is just
    as available when the terminal backend starts.
- **Is a handler's event name a DOM event or a Gesture?** *Ruled 2026-10-09,
  [`FJS-D692`](../DECISIONS.md#fjs-d692): A, then B read off the terminal's table
  and the phone's.* `on:click` and
  `onclick` both appear today (104 and 112 uses across `packages/ui` and `example/web`). A terminal has
  no click, but it has an activation. Whether `FJS-D385`'s Gesture becomes a
  small closed set the IR carries, with `click` lowering to `activate`, is owed
  before a second backend, not before step 1.
  - **A** — DOM event names pass through the IR, and each non-DOM backend lowers
    them through its own table (`click` → activation), as the first question's A
    does for tags.
  - **B** — a small closed set of Gestures the IR carries (`activate`, `input`,
    `focus`, `dismiss`); the compiler lowers `on:click` to `activate`, and a DOM
    name outside the set is a web-only escape.
  - **C** — authors write Gestures in source (`on:activate`), and DOM names are
    the escape.
  - **Recommend A** — then B once the terminal backend's table shows which names
    it lowers and which it cannot. Under `FJS-D545` the IR is cut with that
    backend, so the closed set should be read off its table rather than guessed
    before it, and A matches the tag answer. C rewrites 216 handlers to
    anticipate a set nobody has measured.

---

## See also

- `DECISIONS.md` `FJS-D38`: the ruling this paper serves, and the gap it names
- `DECISIONS.md` `FJS-D37`: the terminal engine is bought and the build is deferred
- `IDEAS/terminal-surface.md` §§ 5, 6, 9: the first consumer, and the measurement
  that priced it
- `IDEAS/ui-ontology.md` § 2: the CAMELEON levels this paper's vocabulary rests on
- `IDEAS/one-mental-model.md`: the target axis, and why mobile waits for
  offline-first
- `packages/mesa/src/compiler.js` §§ 2–9: the parser, analyzer, builder and
  emitter measured in § 1
- `packages/mesa/src/render.js`: SSR as a happy-dom host, shape A already in the
  tree
