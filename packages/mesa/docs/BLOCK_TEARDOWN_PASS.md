# Block teardown pass — 2026-08-01

Follow-up to [`REACTIVITY_PASS.md`](./REACTIVITY_PASS.md) §6, which fixed four
teardown bugs in `{#if}`, `{:then}` and `{#each}` and predicted more of the same
in the block types it had not audited. This pass tested that prediction and
finished the block layer.

Everything below was reproduced with running code before it was changed, and
each fix was re-verified against the failing repro.

---

## State

_As of this pass. Superseded 2026-08-01: `email-kit.test.js` is now
`describe.skip`, so the suite reads **869 pass / 0 fail / 27 skipped**. See
`../PROJECT_STATE.md`._

`npx vitest run` → **841 pass / 27 fail**. The 27 are `email-kit.test.js`, which
needs `@frontierjs/mesa-email` and its `/tmp/mesa` fixtures; unchanged from
before this pass, do not chase them.

Sierra downstream check: `cd ../sierra && npx vitest run` → **521/521**.

Tests added: **+16** in `runtime.test.js` §18c, **+6** in a new
`block-teardown-compiled.test.js`. Seven of the 16 fail against the pre-fix
runtime; the other nine are guards for shapes that already worked.

---

## Two failure shapes, not four bugs

Every teardown bug in this layer — the four from the previous pass and the three
here — is one of two shapes. Naming them is most of the value of this pass.

**1. Range escape.** A block records its content's first and last DOM nodes and
removes that range later. Inner blocks insert their content *before their own
anchor*, so whenever that anchor is the outer range's first node, everything the
inner block renders lands ahead of `first` and survives removal. The old content
stays on screen and the new content is appended beside it — permanent
duplication, growing per swap.

The cure is a marker comment the outer block creates and owns, placed before the
content, with removal walking live siblings from the marker to a stop node the
block also owns. Nothing inside the branch can move or remove either end.

**2. No owner.** Content built without an owner node parents its effects to
whatever `_owner` happens to be — an effect node (which never disposes its own
children on re-run, deliberately: see the comment in `_makeNode._run`), or
`null` inside a microtask. Those effects are then unreachable by any disposal
path: they keep re-running on every write to anything they read, rendering into
DOM that was detached long ago, one more stranded set per swap.

The cure is a per-branch owner node parented to the enclosing effect, disposed
with `_disposeNode(node, true)` on the next swap so re-runs cannot accumulate.

---

## What was fixed

| Block | Shape | Was |
|---|---|---|
| `keyBlock` | range escape | `{#key}` around a resolved `{#await}` left the old content and appended the new — `resolved:Xresolved:X` |
| `awaitBlock` | range escape | re-swapping a branch that *starts* with a resolved nested `{#await}` left the old branch behind |
| `boundaryBlock` | range escape **and** no owner | the swapped-out `{:pending}` branch kept re-rendering into detached DOM forever |
| `$$eachBlock` | range escape | a row whose only content is an `{#await}` (and the `{:else}` block, same shape) survived removal, clearing and reordering |

`_removeRange(from, stop)` and `_guardRange(dom)` in `runtime.js` are the two
helpers; `ifBlock` now uses the shared `_removeRange` instead of its own copy.

`{#each}` rows keep first/last bounds rather than a marker walk, because rows
interleave and each needs its own bounds. `_guardRange` prepends an owned marker
only when a row's first node is a comment — the only case that can be an inner
block's anchor — so ordinary rows pay nothing.

---

## Corrections to the handoff that motivated this pass

Both were stated as live bugs; testing says otherwise.

**`{#key}` duplication is NOT reachable from a real component.** It reproduces
against the runtime API in five lines, and it is a genuine defect, but every
`{#key}`/`{#each}` body that starts with a block directive compiles to a
fragment with a *leading placeholder comment* (`template('<><>', 1)`), and that
placeholder keeps the recorded range valid by accident. A compiled repro —
`{#key k}{#await p}…{/await}{/key}`, mount, change the key — renders correctly
on the unfixed runtime. The fix still matters: correctness rested on an
unstated emission detail that nothing tests or documents. That is what
`block-teardown-compiled.test.js` now pins.

**`mountedBlock` has no teardown bug.** It was described as "3 pointers, zero
owner management". It has neither: it is a thin wrapper that hands its blocks to
`awaitBlock`, so it inherited the previous pass's owner fix. Both shapes it was
suspected of — pending effects surviving resolution, and the mount promise
resolving after the block is removed — passed before this pass and are now
guarded.

**The prediction was still right, just not where it pointed.** Two block types
it did not name — `awaitBlock` and `$$eachBlock` — had the range-escape shape,
and the one user-visible leak was `boundaryBlock`'s missing owner rather than any
pointer.

---

## The coverage argument, updated

Teardown coverage was the stated reason these survived. It now looks like this:

| | tests touching disposal, before | added this pass |
|---|---|---|
| `ifBlock` | 3 | — (already covered) |
| `eachBlock` | 2 | 4 |
| `awaitBlock` | 0 | 2 |
| `keyBlock` | 0 | 4 |
| `boundaryBlock` | 0 | 4 |
| `mountedBlock` | 0 | 2 |

Plus 6 compiled-and-mounted cases spanning all of them.

Every block type now has a "remove it while something inside is mid-flight"
case, which is the condition all seven bugs needed.

---

## Still open

Unchanged from `REACTIVITY_PASS.md` — the five design/surface items there, none
with a known reproduction. Nothing in the block layer is known-broken after this
pass.

One thing noticed and deliberately not changed: `boundaryBlock` rebuilds its
`{:pending}` branch on every state change while still loading, rather than
leaving the mounted one alone. That is wasted work and it discards any DOM state
in the pending branch (an in-flight animation, a focused input). It is no longer
a *leak* — each rebuild disposes the last — so it is a behaviour question, not a
bug, and changing it would change what `fetching` → `loading` transitions look
like.

---

## Working notes

- **The compiled shape decides whether a runtime bug is real.** Half of this
  pass was reproducing runtime-level failures and then finding they could not be
  reached through the compiler. Compile the component and mount it before
  calling anything user-visible.
- `block-teardown-compiled.test.js` has both harnesses: a temp-`.mjs` +
  `import()` one for ordinary components, and a `new Function(...)` one for
  `<mesa:boundary>`, whose top-level `await` compiles to a call to an undeclared
  name that only a Function parameter can supply.
- `mount(label, ...)` inserts its anchor *after* `label`, as a sibling — assert
  against the wrapper, not against `label`.
- Event handlers need `mount()`; delegation roots are registered there, so a
  hand-built component call never dispatches a click.
