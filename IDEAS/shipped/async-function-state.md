---
id: async-function-state
status: shipped
dated: 2026-10-05
---

# Proposal — `$async` on an async function, so a write outside `<Form>` stops hand-rolling busy and error

**Status: SHIPPED 2026-10-05**, with the three open questions ruled (`FJS-D582`,
`FJS-D583`, `FJS-D584`). The behavior is `packages/mesa/docs/VISION.md` § 13.2 and
RULE 16, which win over this file; what follows is the argument as proposed, and it
still says `fetching` where the ruling renamed it `pending`. The counts were read off
the `.mesa` corpus (`example`, `packages/basecamp`, `../fjs-prototypes`) with `rg` on
the date above. They are regex counts, so read them as sizes rather than totals.

**What building it found.** No `.mesa` file in the repo or the prototypes reads
`$async` at all, so the rename moved docs, the REPL examples and the editor hovers and
nothing else. And every field of the state was invisible to the template's
static/reactive split: an attribute or a text node reading only `$async` was written
once, so `disabled={$async.cities.fetching}` — VISION's own example — never moved. The
const form had that defect since it existed.

## Trigger

A write that is not a form submit looks the same in every app:

```js
let busy = false, error = ''
async function remove(id) {
  busy = true; error = ''
  try { await users.service.remove(id); goto('/users/') }
  catch (e) { error = e.message }
  finally { busy = false }
}
```

The corpus has about 212 `<flag> = true` assignments (`busy`, `saving`, `deleting`,
`sending`…) and 63 `catch (e) { x = e.message }`. A sample of the call sites shows
remove, deploy, punch-in, send and download. These are buttons, not forms. Two apps have
already written the helper themselves: `async function run(fn)` in
`../fjs-prototypes/portal/web/src/routes/account/index.mesa` and in
`transit/web/src/routes/reset/index.mesa`. When the same workaround keeps appearing in
the same place, it measures a gap in the paved road (*Paved road vs. the workaround*,
`PHILOSOPHY.md` § IV).

## Where FJS stands

- **Reads have it.** `const x = await f(dep)` gets `$async.x.{loading, fetching, error,
  status}` (`packages/mesa/docs/VISION.md` § 13.2). **RULE 16** limits that to an
  `await`-initialized top-level `const`.
- **Form submits have it.** `<Form>` owns `status: 'idle' | 'pending' | 'saving' |
  'saved' | 'error'` and `submitting`
  (`packages/ui/components/forms/Form.mesa:159`, `:167`).
- **Any other write has nothing**, so the flag pair gets written by hand.

## The idea

Widen RULE 16 rather than coin a noun: **a top-level `async function` whose `$async.<name>`
is read gets the same state object a derived `const` does.**

```js
async function remove(id) {
  await users.service.remove(id)
  goto('/users/')
}
```
```mesa
<Button onclick={() => remove(user.id)} disabled={$async.remove.fetching}>Delete</Button>
{#if $async.remove.error}<Alert tone="danger">{$async.remove.error.message}</Alert>{/if}
```

- **Same shape, same fields.** `fetching` is true while any call is in flight. `error`
  is the last call's rejection and clears when the next call starts. `status` is
  `'idle' | 'pending' | 'success' | 'error'`, where `'idle'` is the one value a
  function adds because it may never have run. `loading` stays as "the first call in
  flight", which keeps the object identical across both forms.
- **Generated only when read.** The compiler already finds every `$async.<name>`
  reference. A function nobody reads `$async` of compiles exactly as it does today.
- **The call still returns its promise and still rejects.** The state records the
  rejection and does not swallow it, so a caller that `await`s keeps its control flow.
- **The noun is not "action".** That word is orion's (`ARCHITECT.md`, `FJS-D385`), and a
  custom service method is a Method. This proposal adds no noun.

## The nine

1. **Origin.** It removes one: the hand-kept `busy`/`error` pair, a second copy of "is
   this call in flight", goes away.
2. **Concept.** No new noun. `$async` already exists, and this extends where it applies.
3. **Complexity.** The problem's own. A write has a lifecycle, and `<Form>` already
   pays for one.
4. **Predictability.** It improves. Today `$async` exists on `await` consts only, and
   readers ask why a function does not get it.
5. **Derived.** The state is derived from the call. The handwritten version restates it.
6. **Owner.** The mesa compiler's existing `$$async` container (`compiler.js`, the
   `$$async container` emit). There is no runtime helper beside it.
7. **Boundary.** `$async.<name>` is a named reserved global, and the compiler tests
   cover it where they cover the const form. Per Invariant 15, those tests parse the
   output.
8. **Failure.** Reading `$async.f` where `f` is neither an awaited const nor an async
   function should be a **compile error** that names both forms. **Today nothing
   refuses it.** Probed 2026-10-05: `{$async.n.error}` over a plain `let n` compiles
   with no warning to a bare `$async.n.error` and fails only at runtime. RULE 16 is
   unenforced, and that is filed as its own defect. This proposal needs the refusal
   whether or not it lands.
9. **Silence.** Must stay true: a rejection is both recorded and rethrown. Artefact: a
   compiler test that asserts both. An unread function's output is byte-identical to
   today's, and the corpus snapshot shows that.

**Adjudication in tension:** *Paved road vs. the workaround*, as cited above. The road
changes; no config flag is added.

**Tier:** Assessment until built. Building it changes `VISION.md` § 13.2 and RULE 16 (Map).

## Open questions

1. ~~**An unhandled rejection from an `onclick`.**~~ **Answered 2026-10-05 (`FJS-D582`): B — when `$async.f.error` is read in the template, the generated wrapper treats the rejection as handled.** If the template's error branch is the
   handler, the rethrow still reaches `unhandledrejection`.
   - **A** — rethrow anyway. The console noise is honest and an error boundary catches it.
   - **B** — when `$async.f.error` is read in the template, the generated wrapper treats
     the rejection as handled.
   - **Recommend B** — reading the error is the handling, and the template is where the
     compiler can see that.
2. ~~**`fetching` reads wrong on a write.**~~ **Answered 2026-10-05 (`FJS-D583`): A — rename it to `pending` for both forms, with every caller moved, which the evolution policy allows.** Decide alongside this proposal, not after it.
   - **A** — rename it to `pending` for both forms, with every caller moved, which the
     evolution policy allows.
   - **B** — keep `fetching` on both forms.
   - **Recommend A** — one object read the same way for a load and a write, and the
     name says what a write is doing.
3. ~~**Overlapping calls**~~ **Answered 2026-10-05 (`FJS-D584`): A — take no position: `disabled={$async.f.pending}` is the caller's guard.** (a double click).
   - **A** — take no position: `disabled={$async.f.pending}` is the caller's guard.
   - **B** — the wrapper drops or queues a call made while one is in flight.
   - **Recommend A** — a drop-or-queue policy would be a second proposal.
