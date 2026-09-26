---
id: mesa-ir
status: proposed
dated: 2026-09-25
---

# Idea — Mesa's intermediate representation: one template tree, a backend per device

**Status: PROPOSED. Nothing here is built.** Dated 2026-09-25. The counts in § 1
were measured that day and are true for an afternoon (`PHILOSOPHY.md` § VII). Do
not cite this file as behavior. See `VERIFYING.md`.

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

0. **Nothing before core leaves alpha**, on `FJS-D14`'s reasoning, which
   `FJS-D37` § 6 and `FJS-D38` both inherit. What this paper settles now is where
   the seam goes, so no compiler change made in the meantime forecloses it.
1. **Extract the IR with the DOM backend as its only consumer.** The check is
   exact, because Invariant 12 makes compiler output reproducible: every `.mesa`
   file in the workspace (461 on the day this was written) compiles
   **byte-identically** before and after, and Invariant 15's parse-the-output
   tests still pass. A difference is either a bug or a change to be named.
2. **The portability report** (§ 3), per target, as a report rather than a
   refusal until a target exists. It runs over the corpus from step 1 and says
   how much of `example/` and `packages/ui` would lower to a terminal today.
3. **The terminal backend**, the first non-markup consumer. `FJS-D37` bought the
   engine, and `terminal-surface.md` is its paper.
4. **Native**, after offline-first exists. `one-mental-model.md` § *The target
   set's missing member* already argues that mobile is refused until then,
   because store review, eviction and background execution make offline-first a
   prerequisite. The IR does not change that argument.

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
   the portability report in step 2. **Until step 1 runs, `none`**: this is a
   proposal and grades nothing.

**§ IV:** *coherence vs. convention*, the same adjudication `FJS-D38` turned on.
Every platform's convention is its own component model or its own language, and
the codegen-to-Swift reading of the question is that convention arriving
through the back door. **§ VII tier:** Assessment. The ruling this would amend,
if any, is `FJS-D38`'s *the runtime is not derived*, and only once step 1 is
built.

---

## Open questions

- **Does the IR carry raw HTML tag names, or only the abstract vocabulary?**
  - **A** — raw tags plus a per-target lowering table. Every existing component
    compiles, and portability is whatever the table covers.
  - **B** — abstract vocabulary only, with raw tags as a web-only escape node.
    Cleaner, but every raw `<div>` in the corpus becomes an escape.
  - **Recommend A.** The portability report makes the gap visible without
    rewriting 461 files first, and B can be reached later by shrinking the table.
- **Does step 1 run before the terminal backend exists?**
  - **A** — yes, as a refactor graded by the byte-identical corpus.
  - **B** — no. Extract the IR in the same piece of work as the first non-DOM
    backend, so the seam is placed by a real second consumer rather than a guess.
  - **Recommend B.** An IR with one consumer is a guess about where the second
    one needs the cut (`cut-one-level-simpler`). The byte-identical check is just
    as available when the terminal backend starts.
- **Is a handler's event name a DOM event or a Gesture?** `on:click` and
  `onclick` both appear today (104 and 112 uses across `packages/ui` and `example/web`). A terminal has
  no click, but it has an activation. Whether `FJS-D385`'s Gesture becomes a
  small closed set the IR carries, with `click` lowering to `activate`, is owed
  before a second backend, not before step 1.

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
