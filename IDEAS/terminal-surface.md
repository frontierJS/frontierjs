---
id: terminal-surface
status: proposed
dated: 2026-08-17
---

# Idea — the terminal surface: how `fli` presents, and whether FJS builds TUIs

**Status: IDEA. Nothing here is built.** Dated 2026-08-17. Written after sizing
`packages/cli`'s output layer against Cargo, Rails, clack and `gh`, and after
measuring how much of `@frontierjs/mesa` could reach a terminal. Do not cite this
file as describing behavior — see `VERIFYING.md`.

Two questions live here because the second one decides how much of the first is
worth building. **How should the framework's output look** is answerable today and
cheap. **Should FJS render TUIs** is a V2 question whose answer changes whether the
first one needs a design system or a print function.

---

## 1. What is there today

`packages/cli/core/color.js` is a 49-line zero-dependency ANSI shim, written to keep
zx off the read-only paths — measured at ~85ms of a ~200ms invocation, which is a
good trade and not the thing in question. What is in question is its **API**: it
exports `chalk.red`, `chalk.dim`, `chalk.hex('#f5a623')`, deliberately
chalk-compatible so call sites read the same after the swap. Compatibility was the
right call for the swap and it inherited chalk's vocabulary along with it.

So a call site says *red*. Nothing can retheme, nothing adapts to a light terminal,
and the one accent color in the CLI is a hex literal inside a renderer —
`core/prose.js:33` paints inline code `#f5a623`, which is the only place that
decision exists.

**This repo has already ruled against color-named vocabulary once.** Invariant 13:
style with a tone (`danger`) and a treatment (`outlined`), never a color. The
argument that produced it — a color name is a fact about one rendering and a tone
is a fact about the message — does not stop at the browser.

**The second half is worse and is not about color at all.** Booting basecamp in dev
prints four prefix vocabularies in nine lines:

```
[env warn] AUTH_SECRET looks like a placeholder      bracket tag
03:04:34.182 INFO [basecamp:deploy-engine] ...       timestamp + level + scope
➜  app v1.0.0 {"url":"http://0.0.0.0:8120",...}      vite arrow, then a JSON blob
[Sierra] 37 model(s) from .../schema.lite — User,…   bracket again, different shape
```

Four packages, four answers, and Invariant 4 says one owner per translation. The
translation nobody owns is *an event becomes a line*.

---

## 2. Two audiences wearing one coat

The four lines above are not one inconsistency. They are two formats that were never
distinguished, so each package guessed:

- **Command output** — a human watching `fli make:widget` finish. Transient, read
  once, never grepped. Wants no timestamp, no level, and a verb column.
- **Runtime log** — a stream from a running app, tailed in production, filtered by
  scope. Wants a timestamp, a level, a scope, and `--log-format json` so a collector
  does not parse prose.

`fli` produces the first. Sierra's boot banner, litestone's model summary and
basecamp's engine registrations are the second, printed as if they were the first.
Naming the two is most of the fix; the formats then follow from the audience rather
than from whoever wrote the line.

---

## 3. The tone vocabulary

One table, semantic names, three backends:

```
tone.danger  tone.warn  tone.ok  tone.info  tone.muted  tone.accent
part.path    part.code  part.value  part.command  part.count
```

The **backends** are what make this more than a rename. The same table resolves to
ANSI (16 / 256 / truecolor, degrading by `TERM`), to terminal cell attributes for a
full-screen renderer, and to the custom properties `@frontierjs/css` already ships
as eleven `theme-*` blocks. One semantic vocabulary across web, terminal output and
terminal UI is the FJS-shaped version of this; three hardcoded palettes is what
every other framework has.

Home: `@frontierjs/toolbelt/tty`. A formatter is pure and depends on nothing, so
`FJS-D26` holds and litestone and mesa may import it — which they must, since two of
the four inconsistent lines above come from litestone and sierra.

`core/color.js` becomes a thin re-export rather than a deletion, so no call site
changes on the day the table lands.

---

## 4. Prior art, and what each is for

**Cargo** is the one to copy for anything that acts. A right-aligned twelve-column
verb, bold and green, dim detail after it, and a whole build scans as one column:

```
      Created  widgets/src/Embeds/PriceTag.mesa
      Skipped  widgets/index.html (exists)
     Compiled  3 widgets in 412ms
```

**Rails generators** invented that column (`create` / `exist` / `identical` /
`force`) and `fli make:*` has the same job, so the verb set is worth taking whole
rather than reinvented.

**rustc**, and `miette` behind it, is the one to copy for anything that judges — a
code, a `file:line:col`, the source line, a caret under the span, a `help:`. `fli
check` runs eleven rules whose whole value is that each is silent when broken; a
bullet list is the weakest rendering of a finding.

**`gh`** is the one to copy for the machine escape hatch: every reporting command
takes `--json <fields>`, so nobody scrapes the pretty output. `ws:map`, `check` and
`release:check` already hold structured data and print prose over it.

**`@clack/prompts`** is the modern interactive shape — a vertical `│` gutter tying
the steps together, a glyph per state, a spinner that resolves into a line. It is
also the trap: see §7.

**Charm** (`lipgloss`, `log`, `bubbletea`) is the only real design system for a
terminal — adaptive color against the terminal's own background, styles that
compose, structured logs with aligned key/value. Wrong language, right vocabulary.

---

## 5. What a TUI would cost, measured

The interesting question is not whether an FJS app could ship a TUI. It is whether
**Mesa** could render one, because if it cannot then a TUI is a bolt-on with its own
component model and the one-mental-model claim gets a footnote.

Measured 2026-08-17 against `packages/mesa/src/runtime.js` (4,959 lines):

| Region | Lines | DOM references |
| --- | --- | --- |
| reactive core — signals, effects, memos, context, lifetime | 1–760 | **2** |
| everything else — fragments, binds, events, delegation, portals, transitions | 760+ | **99** |

The reactive core is portable and is the genuinely hard, genuinely finished part.
The rest is not a renderer that happens to target the DOM — **it is DOM-shaped by
construction**, and the compiler is why. `compiler.js` emits a template as an HTML
*string*, parsed once by `htmlToFragment()`, cloned per instance, then walked by
`refer(root, path)` to reach the nodes each binding owns (`compiler.js:1211`,
`:6880`). That is the dom-expressions strategy Solid uses, and it is fast for the
same reason it is unportable: the browser's own parser is doing the tree
construction.

`render-component.js` is not a counter-example. Server rendering emits HTML too, and
so does `email-kit`'s `target: 'email'` — **every Mesa target that exists produces
markup**, so nothing in the tree is evidence that a non-markup target is cheap.

The consequence: a terminal target is either a fake-DOM shim beneath 99 call sites,
or a **second compiler backend** emitting a cell tree instead of an HTML string. The
second is the real one. It is bounded work against a compiler that already has a
target concept, and it is not small.

---

## 6. Buy the engine

What a TUI needs that Mesa has no opinion about, and that is routinely
underestimated:

- a cell buffer with diffing, so a repaint touches changed cells only
- layout — flexbox via yoga, or a hand-written one
- input parsing: escape sequences, the kitty keyboard protocol, mouse, bracketed
  paste
- **grapheme width** — emoji, CJK, combining marks, zero-width joiners. This alone
  is weeks, and getting it wrong corrupts every frame after the first wide character
- alt screen, cursor save/restore, `SIGWINCH`, clean teardown on crash
- focus order and a focus ring

None of it is where FJS differentiates. The differentiator is one `.mesa` file, one
signal graph and one tone vocabulary reaching a third surface — not a better
terminal buffer.

**Ink** is the practical JS default and is mature (Prisma, Gatsby, Claude Code). Its
cost is exact and not small here: it brings React, so a repo whose thesis is one
mental model would ship two component models. **OpenTUI** is the more interesting
shape because it separates the paint and layout engine from the component model and
ships several framework renderers — which is precisely the seam a Mesa backend would
plug into — but it is young, and its specifics want verifying before anything is
bet on them. **Ratatui** and **Bubble Tea** are the architectures to read regardless
of what gets imported.

---

## 7. The trap in the middle

Prompts are where this goes wrong. A clack-style gutter with a spinner is a third of
a TUI: it repaints, it owns the cursor, it must restore on `SIGINT`. Built
incrementally inside a CLI it becomes a private half-renderer that nobody owns and
that breaks in the terminals nobody tested.

So prompts are a fork in the road, not a feature: either they run on the TUI stack,
or they stay line-oriented and dumb. Growing one into the other is the outcome to
refuse explicitly, because it is the default outcome.

---

## 8. Sequencing

1. **The tone table, now.** Cheap, follows from Invariant 13, and is the input every
   later step consumes. Designed with the backend seam from the start, since
   retrofitting one after call sites exist is the expensive version.
2. **Name the two audiences and give each one owner.** Command output and runtime
   log, one formatter each, every package calling them.
3. **The verb column and the diagnostic renderer.** `fli make:*` and `fli check` are
   the two consumers that already exist.
4. **`--json` on every reporting command.**
5. **TUI: not before core leaves alpha.** `FJS-D14` parked `oracle` and `orion` on
   exactly this reasoning — an interesting build that is not a gap in the framework.
   What is owed before then is only the decision in §9, so that steps 1–4 do not
   foreclose it.

---

## 9. The open question

**Does a TUI reuse `.mesa`, or is it a separate authoring model?** Filed as
`ISSUES.md` `FJS-D38`, because the two answers are different projects and neither is
obviously right:

- **Reuse.** A second compiler backend and a cell-tree runtime over a bought engine.
  Expensive, and the only version that keeps the one-mental-model claim intact when
  someone asks what a Resource is on a terminal.
- **Separate.** Ink, or a thin wrapper over one. Cheap, available now, and it makes
  the framework's answer to *how do I build a terminal app* be *use React*.

The measurement in §5 is the input either way: it says the reuse answer costs a
compiler backend rather than a renderer, which is more than it looked like before
anyone counted.

---

## See also

- `CLAUDE.md` Invariant 13 — tone and treatment, never a color; the argument this
  extends past the browser
- `CLAUDE.md` Invariant 4 — one owner per translation; *an event becomes a line* has
  none
- `DECISIONS.md` `FJS-D37` — what of the above is ruled
- `ISSUES.md` `FJS-D38` — the open question in §9
- `IDEAS/command-surface.md` — the other half of the CLI: authoring, distribution
  and what oclif solves that `fli` does not
- `IDEAS/diagnostics.md` — `fli doctor`, the largest future consumer of §4's
  diagnostic renderer
- `IDEAS/one-mental-model.md` 5, 6 — naming Mesa's target set, and one target axis in
  Sierra; a terminal target is the next question after both
- `IDEAS/overview.md` 5.21, 5.22 — where this sits in the ranking
