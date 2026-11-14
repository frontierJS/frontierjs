# Lifetimes — `createRoot`

You need this page when you are writing code that starts and ends a span of
reactive work outside a component: rendering a page to a string, swapping one
preview for another, or a test harness that builds and tears down components.
Inside a component the framework owns the lifetime and you never call it.

```js
import { createRoot, flushSync } from '@frontierjs/mesa/runtime'

const html = createRoot((dispose) => {
  Component(anchor, props, null)   // effects created here belong to this root
  flushSync()
  const out = container.innerHTML
  dispose()                        // every effect created above is gone
  return out
})
```

`createRoot(fn)` calls `fn` with a `dispose` function and returns whatever `fn`
returns. Everything created inside (effects, memos, cleanups, child components)
belongs to the root and ends when you call `dispose()`.

## Ownership without tracking

The root subscribes to nothing, so it can never re-run. That is the reason to
use it instead of `createEffect`, which looks like a substitute and is not. An
effect subscribes to whatever its body reads. A component that reads a store and
then writes it during setup (a hit counter, a "seen" registry) would notify the
very effect that is running it:

```js
const Page = (anchor) => {
  const n = hits()      // an enclosing createEffect subscribes to hits
  setHits(n + 1)        // and this write wakes it again
  anchor.before(el('hit ' + n))
}
```

Scaffolded with `createEffect`, that component ran 101 times for one page and
reported a cycle error that was really your scaffolding. In a `createRoot` it
runs once.

## What already uses it

- `mount()` wraps the component in a root, and `destroy()` disposes it. For an
  app you never need `createRoot` yourself.
- `renderToHTML` renders inside a root and disposes it the moment the HTML is
  serialized. Without that, every page of a static build would leave its effects
  subscribed to module-level state, and each later write would re-run all of
  them against DOM that was discarded pages ago.

Reach for `createRoot` when you own a span that has a beginning and an end and
neither `mount()` nor the renderer covers it.

## What bites

- **It is not a way to do reactive work outside a component.** Shared state is a
  plain module and its logic belongs in components. `createRoot` is for owning a
  lifetime, not for deriving values.
- **Forget `dispose()` and the work lives forever.** Nothing else reaches it.
- **Read the root's result before disposing.** After `dispose()` the effects are
  gone, so the DOM no longer updates.

---

Spec: [VISION.md § 5](../../VISION.md#5-shared-state--plain-javascript-modules) · RULE 54 · [README § Owning a lifetime](../../../README.md#owning-a-lifetime--createroot)
