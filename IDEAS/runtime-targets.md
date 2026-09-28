---
id: runtime-targets
status: proposed
dated: 2026-09-27
---

# Idea — a native runtime beneath the seed, not a translator over the TS

**Status: PROPOSED. Nothing here is built, and nothing should be until core
leaves alpha (`FJS-D14`).** Dated 2026-09-27. Do not cite this file as behavior —
see `VERIFYING.md`. Ranked low in `overview.md` on purpose: the payoff is real
and the moment is wrong.

**The question:** a team reported handing a whole backend to a model to write
in Rust — a language nobody on the team reads — and getting speed, size and
memory gains large enough to move from shared servers to a Raspberry Pi. FJS
wants the same end state without giving up the window: `.lite`, `.mesa` and
TS/JS stay what a person reads and edits. Is that a TS→Rust translation layer,
or a new meta-language the way `.lite` and `.mesa` already are?

---

## The claim

**Neither. The meta-language already exists and most of an FJS app is written
in it.** What an author writes is `.lite` (models, gates, row policies,
transitions, encryption, tenancy), `.mesa` (every screen), and a file tree
(every route). None of those carry JavaScript semantics; each is a declaration
a compiler consumes, and `mesa-ir.md` already prices `.mesa` as one template
tree with a backend per device. The imperative residue — hooks, custom methods,
jobs, notifications — is the only part with a language problem, and Invariant 6
has been shrinking it since the first ruling: access is declared in the schema,
never in a hook.

So the runtime is the swappable part and the source files are the stable part.
A native junction is one more backend under the same seed, the move
`FJS-D305` already made one level down — litestone runs the same codebase over
`bun:sqlite` on a server and over SQLite's wasm in a browser worker, through two
seams (`#sql-engine`, `#host`) and nothing else.

## Why a TS→Rust translator is the wrong layer

General TS to Rust means solving garbage collection, closures over live
objects, prototype dynamism and `any`, and nobody does it whole-program. The
tools that work — AssemblyScript, Static Hermes, Porffor — all do the same
thing first: shrink the input to a typed subset. A translator is only cheap
when the input was already constrained, which restates the question as *how
much of an FJS app is unconstrained TS*, and the answer above is *the residue*.

## Why not a new meta-language for the residue

A fourth language is a parser, a language server, docs, a test corpus and zero
training data for the model that would write most of it. A **TS subset** for
the residue — typed, no dynamic `this`, `ctx` a closed API — buys nearly all of
the value at a fraction of the cost, and the author still reads TS. Concept
budget (`PHILOSOPHY.md` § V) charges a language the same as a noun.

## What it would be

1. **A closed hook surface.** A hook is `(ctx) => result` over an enumerable
   API: `ctx.query`, `ctx.directives`, `ctx.system`, `ctx.transients`, `db.*`,
   `ctx.enqueue`, `$.log`, `$.config`. If that list is finite and typed
   (`ServiceTypes` is most of it already), a native runtime has two honest
   options for the residue and both fit a Pi: compile the subset, or embed a
   small JS engine (QuickJS, Boa) for hooks only. Hooks are the cold path; the
   hot path — SQL, HTTP, WS, gates, the result envelope, the audit trail — is
   native.
2. **The bridge owners as the port list.** Invariant 4 says one owner per
   translation and § Bridge index names them. A port re-implements each owner
   once; a codebase that had leaked a second copy beside each owner would port
   each twice. The count of owners is the size of the job, which is why the
   discipline is worth keeping before anyone ports anything.
3. **Bun as a seam, not a fact.** Junction is Bun-only by ruling
   (`FJS-D222`), reaching `Bun.serve` or `bun:sqlite` in ten files. A native
   target turns each into a seam of the `#host` shape. Nothing to build now;
   the sentence is here so the next Bun-specific reach is made knowing it is
   one more line on that list.

## What to do now, which is cheap

- **Keep the residue shrinking.** Every rule moved from a hook into `.lite` is
  a line no second runtime has to execute as JS. This is already the direction
  of `declared-semantics.md`, `declared-method-contract.md` and
  `declared-interaction.md`; this file adds a second reason to prefer them.
- **Measure before believing the talk.** The reported gains were against shared
  Node hosting with a garbage collector; Bun over SQLite already takes a large
  share of that. Run the example app on a Pi and record memory and p99 before
  anyone prices a port. If the gap is small, this file closes as *measured,
  not needed*.
- **Do not build it pre-alpha.** Two runtimes means every feature twice and a
  conformance suite to prove they agree, which is `XL` and reopens every
  bridge-owner ruling at once.

## The nine, answered

- **Origin** — none added; the seed stays the one origin and a second runtime
  reads it. A translator WOULD add one (the generated Rust becomes a place the
  truth is restated).
- **Concept budget** — zero new nouns; "target" is already `FJS-D38`'s word.
  A new meta-language would charge one and is refused on that ground.
- **Complexity** — the problem's. Every framework that ships a native runtime
  (Encore's Rust core, `operational-edge.md`) has the same residue problem.
- **Predictability** — improves if built as a backend under the seed; a
  developer who knows how `.mesa` gets a backend predicts how junction gets one.
- **Derived** — yes, entirely: the runtime is derived from the seed, which is
  the whole point.
- **Owner** — the existing bridge owners; a port adds nothing beside them.
- **Boundary** — the closed hook API is the boundary and it is NOT yet
  explicit; § *What it would be* 1 is the owed half.
- **Failure mode** — a conformance suite is the only proportional one; a
  second runtime that disagrees silently is a 200 with different rows.
- **Silence** — today nothing enforces that the hook surface stays closed.
  **Artefact: `none`**, recorded as such. The measurement in § *What to do now*
  is the first artefact worth having.

**Tier:** Assessment (`PHILOSOPHY.md` § VII) — an argument, dated, cited as
nothing.

## See also

`mesa-ir.md` · `bun-natives.md` · `operational-edge.md` § Runtime ·
`fjs-os.md` · `FJS-D14` · `FJS-D38` · `FJS-D222` · `FJS-D305`
