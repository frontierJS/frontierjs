---
id: declared-method-contract
status: proposed
dated: 2026-09-12
---

# Idea — A custom method's contract declared in the seed, its body left in TypeScript

**Status: PROPOSED. Nothing here is built.** Dated 2026-09-12. The evidence rows
were read off the tree that day; the syntax below is a sketch to argue over, not
a grammar. Not owed before alpha. Do not cite as behavior (`VERIFYING.md`).

---

## Trigger

*`.mesa` is the UI language and `.lite` is the Data language — would a perfect
language for the API realm be any better than JavaScript?*

**Mostly no.** A language earns its place where a compiler has to KNOW something
the host language hides, and has several readers for it: a `.lite` policy compiles
to SQL and to JS and drives migrations; a `.mesa` template compiles to DOM, SSR and
email. The API realm splits three ways, and only one of the three has that shape.

| Part | Today | A language would buy |
| --- | --- | --- |
| CRUD services | derived from the seed | nothing — there is no code to replace |
| A custom method's BODY — pricing, billing, payroll | imperative TypeScript | nothing, and it would cost Wasp's bill: a DSL for business logic is a general-purpose language rebuilt |
| A custom method's CONTRACT — who may call it, which rows it reaches, which moves it makes, what it enqueues and announces | implicit in the body | **everything below** |

`FJS-D266` keeps `.lite` and `.mesa` as languages; this record does not propose a
third one. It proposes that the contract move into the one that exists.

---

## The finding

**Every hole below is one fact: a tool cannot see inside a function.**

| Symptom | Where | What it lacks |
| --- | --- | --- |
| A shopper marks any invoice paid | `FJS-1087` — a custom method's floor checks presence, and the body writes through `asSystem()` before reading anything as the caller | which rows the method may reach, stated where the boundary can enforce it |
| Tools the MCP projection cannot grade | `packages/mcp` — the `ungraded` verdict, *nothing in the seed says* | the method's standing, readable without running it |
| `provision` and `destroy` refused every caller, owners included | `packages/basecamp/api/src/core/capabilities.ts`, a hand-kept list the schema outgrew | a derivation from declared moves |
| A service calling a queue operator verb | `fli check`'s `queue-operator-verb`, a scan over source text | declared effects, rather than a guess at them |

Junction already accepts `methods: [{ method, input, gate }]`
(`packages/junction/src/core/service.ts`), so a method's gate and argument schema
are half-declared today — in TypeScript, where the seed's readers cannot reach them.

---

## Prior art

**Ash — an action is a declaration with an implementation attached.** The action's
arguments, its policy and its changes are declared; the code that does the work is
a module the declaration names. This is that shape, minus Ash's host language.
`prior-art.md` covers Ash in depth.

**`@@transitions` — the same move, already made once here.** A state move is
declared in the seed with its gate, and the boundary refuses an undeclared move.
This record extends that from *a move a column may make* to *what a method may do*.

---

## The proposal

### 1. The contract in `.lite`

```
model Invoice {
  …
  method settle(amount: Int @money) @gate(5)
    reads    self
    moves    status: open -> paid
    enqueues ReceiptEmail
}
```

`self` means the row the call names, read AS THE CALLER — so the row policy runs
before the body, which is the half `FJS-1087` is missing. The argument list is the
schema junction's `input` holds today.

### 2. The body stays TypeScript

```ts
settle: async (ctx, { amount }) => { … }
```

Nothing about writing business logic changes.

### 3. The declaration is enforced, or it is a comment

The body is handed a client scoped to what the method declared. Reaching an
undeclared row, making an undeclared move or enqueuing an undeclared job throws
at the Data boundary. **Without this the declaration drifts from the body and
every derivation below is a confident wrong answer.** It is feasible because
litestone owns the operation pipeline (`FJS-D267`), so the scope is one more
input to it rather than a check each verb restates.

### 4. What derives from it

- the MCP tool list with no `ungraded` row for a declared method
- `fli test:access --from <ref>` over methods, not only models
- generated conformance for methods (`kernel-and-projections.md` §3)
- `capabilities.ts`-shaped lists, derived rather than kept

---

## What this is not

- **Not a language for the API realm.** The body is TypeScript and stays so.
- **Not required for a CRUD service**, which has no body to declare.
- **Not an escape from `asSystem()`.** A method that genuinely needs the system
  client declares it, and the declaration is what an access diff reports.

---

## Decision rules — `PHILOSOPHY.md` § V

Answered before writing.

1. **Another origin of truth?** It removes one — the gate and input in `service.ts` move into the seed. The risk is the body as a second origin, which §3 answers.
2. **Enlarges the concept budget?** Adds *method* as a seed block; a developer already holds the idea, since junction has custom methods.
3. **Problem's complexity or ours?** The problem's — who may do what to which row is the domain.
4. **Reduces predictability?** Increases it: a method's reach is readable without its body.
5. **Derived instead of restated?** The capability lists and the MCP grades become derived.
6. **Exactly one owner?** The contract the seed's; the body the service file's.
7. **Boundary explicit?** The declared scope is the boundary, and the Data boundary enforces it.
8. **Failure proportional?** An over-tight declaration refuses loudly; an over-broad one (`reads anything`) is the quiet failure, which §9 has to catch.
9. **Wrong without anything saying so?** Yes — a declaration broad enough to cover every body passes enforcement and grades nothing. A `fli check` rule reporting declarations that reach every row is the artefact.

**Adjudication:** *Doctrine vs. discovery* — `FJS-1087` and `capabilities.ts` are the
code saying the contract belongs in the seed. **Tier:** Assessment.

---

## Open questions

- **Is `method` the word?** Junction says *custom method*; Ash says *action*; `@@transitions` says *move*. Run `decision-rules` on the noun before any grammar.
- **How coarse may a scope be?** `self`, a relation from `self`, a model, or a named `@@scope` — and which of those is too broad to grade.
- **Does `announces` need declaring**, or is it derived from `moves` and `FJS-D267`'s write event?
- **Sequencing.** After `kernel-and-projections.md` §1, since §3 here is a pipeline input.

---

## See also

- `kernel-and-projections.md` — §1 the pipeline, §3 generated conformance
- `agent-surface.md` — the MCP projection this would make fully graded
- `prior-art.md` — Ash
