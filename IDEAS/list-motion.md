---
id: list-motion
status: proposed
dated: 2026-09-23
---

# Idea — a keyed `{#each}` that animates a row it moves

**Status: proposed.** Mesa animates a row appearing (`$.fade`, `$.fly`) and
means to animate one leaving (`__mesa_exit`), but a row that MOVES jumps. Every
reorder does it: a sorted table re-sorting, a live store inserting at the top, and
most visibly `@frontierjs/ui`'s `dndzone`, where the rows displaced by the
placeholder snap from slot to slot instead of sliding out of its way. Svelte
answers this with `animate:flip`, and `svelte-dnd-action`, which `dndzone` was
modeled on, was written expecting it.

## 1. Why this is the runtime's and not an attachment's

FLIP (First, Last, Invert, Play) needs where the element was BEFORE the DOM
changed. An attachment has no hook for that moment: Mesa has no `beforeUpdate`,
a `ResizeObserver` does not fire on a change of position, and by the time
anything outside the reconciler learns that a row moved, the old position is
gone. **The one place that holds both positions is `$$eachBlock`'s keyed
reconcile**, which already decides which blocks move (the LIS pass) and performs
every `insertBefore`. So it is the owner, and a userland FLIP would be a second
implementation built from guesses about when the first one runs.

## 2. The shape — the exit protocol, turned toward moves

Mesa already settled how animation is spelled: there are no `transition:` or
`animate:` directives, and animation is an attachment built by a `$` helper
([`FJS-D132`](../DECISIONS.md#fjs-d132) names them as the `$` namespace). Exit animation crosses from the attachment to
the runtime through one element flag: the cleanup leaves a promise on
`el.__mesa_exit`, and block removal waits on it.

A move is the same shape in the other direction:

```html
{#each rows as row (row.id)}
  <li {@attach $.move({ duration: 180 })}>{row.name}</li>
{/each}
```

- **The helper marks the element** (`el.__mesa_move = { duration, easing }`), and
  marks its parent so an unflagged list pays nothing, not even a scan of its rows.
- **The keyed reconcile, on a flagged parent,** reads the rect of every flagged
  row it is keeping before the first DOM operation, performs the reconcile, reads
  again, and plays each difference as a Web Animations transform from the old
  offset to none. That is two layout reads per update of a flagged list.
- **An interrupted move chains.** The FIRST read goes through
  `getBoundingClientRect`, which includes a running animation's transform, so a
  row caught mid-slide starts its next slide from where it visibly is. The old
  animation is cancelled after that read, never before it.
- **Enter and exit stay with the helpers that own them.** A row that is new or
  leaving is not a move. `dndzone`'s drop is a key change (the placeholder's
  shadow id becomes the real id), so the dropped row ENTERS and the ghost's
  settle animation covers that half.

## 3. What it buys `dndzone`

Rows displaced by the placeholder slide instead of jumping. That is the visible
difference between it and the library it replaced. The index math does not
change: `dndzone` computes slots in collapsed space from one snapshot, and its
`docRectNoTransform` strips a row's own transform when it re-measures mid-drag.
That code was written for Svelte's flip. **Whether `getComputedStyle(el).transform`
reports a WAAPI transform in progress is the assumption it rests on, and it is
to be measured**, not assumed, before `dnd.spec.mjs` gains a `$.move` fixture.

## 4. Why `$.transition` is not the answer

`$.transition(fn)` wraps a change in the View Transitions API, and a
`view-transition-name` per row would animate a reorder with no runtime work at
all. It is the right tool for a page-level change and the wrong one for a list
under a pointer:

- **One transition runs at a time, and a new one skips the running one to its
  end.** A drag calls `onconsider` at every slot it crosses, so it would jump
  rather than chain.
- **The update callback runs asynchronously**, one or more frames after the
  write, while `dndzone` re-measures on the frame after it notifies.
- **What animates is a snapshot, not the live rows**, for the length of the
  transition.
- **Every row needs a unique `view-transition-name`**, which is a document-wide
  namespace the list does not own.

Where the answer is *animate this whole change*, `$.transition` stays the answer.

## 5. Measure first — a keyed row's exit may never play

In `$$eachBlock`, a removed key runs `removeElements(…)` and THEN
`dispose()`. The attachment's cleanup (where `$.fade`'s exit sets `__mesa_exit`)
runs inside the dispose, after the element has already left the DOM. `ifBlock`
collects `__mesa_exit` before removing. Read that way, `{@attach $.fade()}` on an
each row fades in and never fades out. **This is a reading, not a measurement.**
Drive it first. If it holds, it is an `FJS-` row of its own and lands before
`$.move`, since both touch the same function and a list that animates moves but
not exits looks worse than one that animates neither.

## 6. Against the nine questions

| § V | Answer |
| --- | --- |
| origin | No new origin. Only the reconcile knows a move happened; the attachment states only that it wants one animated |
| concept | One helper in an existing family (`$.fade`, `$.slide`, `$.fly`), and one flag in the protocol `__mesa_exit` already established. No directive namespace |
| complexity | The problem's own: FLIP needs the pre-mutation position, and only the reconciler holds it. Cost is two layout reads per update, only for a list that opted in |
| predictability | The exit protocol pointed at moves, so knowing `$.fade` predicts `$.move` |
| derived | An attachment cannot derive it (§ 1). `$.transition` can for a different case (§ 4) |
| owner | `$$eachBlock`'s keyed reconcile, which already owns every move. `dndzone` must not grow a FLIP of its own |
| boundary | An element flag read by one function, the same boundary as `__mesa_exit` |
| failure | Cosmetic, so it warns. `$.move` on an element that is not a keyed row's root does nothing, and says so once through a `[Mesa]` warning, which a drive treats as a failure |
| silence | What must stay true: a kept row that moved starts from its old position. Fails: a spec in mesa's runtime browser drive that reorders a flagged list and reads `getAnimations()` off the moved rows. Until then: `none` |

The adjudication in tension is **familiarity vs. precision**: the shape is taken
from Svelte, and the word is the open question below.

## Open questions

- **What is the helper called?** Svelte's word is `flip`, the name of the
  technique; in plain English it half-fits (a card flip is a rotation), while
  `fade`, `slide` and `fly` each name the motion a reader will see.
  - **A** — `$.move`, and the compiler refuses `animate:flip` by name, pointing
    at `{@attach $.move()}`.
  - **B** — `$.flip`, for the developer who arrives searching for that word.
  - **Recommend A** — § IV's familiarity rule is to take the shape and reject a
    word that half-fits, and to answer the muscle memory with a loud refusal that
    names the equivalent. The refusal is where `flip` gets found.
