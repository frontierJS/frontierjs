# Timing and the flush

You need this page when code reads the DOM right after changing state, when a
`$:` effect sees something you did not expect, or when a statement above a
declaration behaves differently than you assumed.

```mesa
<script>
  let messages = ['hello']
  let list

  function add(text) {
    messages = [...messages, text]
    // Still the OLD DOM here: the write has not been flushed yet.
    const wasAtBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 4
    $.tick(() => {
      if (wasAtBottom) list.scrollTop = list.scrollHeight
    })
  }
</script>

<ul bind:this={list} style="height: 8rem; overflow: auto">
  {#each messages as message}
    <li>{message}</li>
  {/each}
</ul>
<button onclick={() => add('another message')}>Send</button>
```

## Writes coalesce into one flush

Every write in the same tick (event handlers, timers, promise callbacks)
accumulates into a single flush on the next microtask. Nothing updates in the
middle of your function:

- Code after a write still reads the previous DOM. That is your "before update"
  window, and it lasts for the rest of the handler.
- `$.tick()` returns a promise that resolves after the DOM has updated, and
  `$.tick(fn)` runs `fn` then. Use it to read the result of a change you just
  made.
- `flushSync()` from `@frontierjs/mesa/runtime` forces the flush now. It is for
  mounting and tests, not for components.

## Effects run after the DOM is built

Within one flush, everything that builds the DOM runs before user effects. A
`$:` effect therefore sees the DOM as it is after the change it reacts to:

```js
$: items, () => { count = el.childNodes.length }   // sees the new children
```

The exception is the first run. An auto-tracked effect (`$: expression` with no
dependency list) runs once during setup, before the template exists, so it
cannot read an element yet. Only its updates are ordered after the DOM. An
effect with an explicit dependency (`$: dep, handler`) has no first run at all.

## A script runs in the order it is written

An instance `<script>` runs top to bottom, like plain JavaScript. A statement
above a declaration runs above it:

```js
let a = 1
a = 5
let b = a      // 5
```

The one departure is a declaration that something already emitted needs: a
class used by a `const` written above it, or a memo that another memo reads, is
moved up just far enough to satisfy that. Nothing else moves.

## How the flush decides what to run

If you know build systems, the flush is a small one. A signal (`let`) is an
input, a `const` is a task that caches its result, and a render or a `$:` effect
is a task nobody reads, so it runs last.

- **Dirty bit with early cutoff.** A write marks the nodes that read it dirty. A
  `const` recomputes and compares the new value with the old (`Object.is`). An
  equal value wakes nobody downstream.
- **Outside in, one DOM depth at a time.** Derivations settle first, starting at
  the shallowest block and working inward, then DOM builds, then effects. A
  block that is about to be removed by an outer block is removed before its own
  derivations run, so a `const` inside `{#if user}` never sees `user` become
  `null`.
- **Dependencies are dynamic.** A node learns what it reads by reading it, and
  re-subscribes on every run. A branch that does not run reads nothing and
  subscribes to nothing.

## What bites

- **Do not read the DOM after a write and expect the new state.** Wrap the read
  in `$.tick()`.
- **A `$:` block is not woken by its own writes.** State a block changes is not
  a trigger for that same block.
- **`$.tick` is not `flushSync`.** `tick` waits for the flush that is already
  scheduled. It never forces one.

---

Spec: [VISION.md § 4.7](../../VISION.md#47-timing-and-phase) and [§ 2](../../VISION.md#2-top-level-variable-semantics) · RULE 61 · RULE 62 · RULE 1b
