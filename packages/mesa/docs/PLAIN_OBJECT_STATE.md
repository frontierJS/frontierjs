# Plain objects instead of Sierra signals

**Question:** can external state be plain objects, made reactive by opt-in
`$:` path watching (§4.1), instead of signals declared in `externalSignals`?

**Answer:** yes. The mechanism exists and works today. It needs one shape
constraint, and it removes the entire class of bug that `externalSignals`
creates. Everything below was verified against the current runtime.

---

## What works, verified

The compiler already emits the right thing. For `$: cart.total` + `{cart.total}`:

```js
const $$proxy_cart = $runtime.watchProxy(cart);
const [$$watch_cart_total] = $runtime.watchPath(cart, 'total');
$runtime.createEffect(() => { $$watch_cart_total(); });
var __a = `${$$proxy_cart.total}`;
```

Behaviour, measured:

| | re-renders |
|---|---|
| write through the proxy | ✅ |
| write on the raw object | ❌ |
| unwatched path (`cart.items.push`) when only `.total` is watched | ❌ (correct — surgical) |
| second component watching a different path | ✅ independently |
| watcher registered *after* a write | ✅ sees current value |

`watchProxy` caches by root object, so **every component and the writer share one
proxy instance**. A write through it fires exactly the paths that are watched,
and nothing else.

---

## The one shape constraint

**Export the raw object. Writers take their own proxy. Never export the proxy.**

```js
// sierra/router/state.js — plain JS, no Mesa import
export const page = { path: '/', params: {}, data: null, error: null }
```

```js
// sierra/router/index.js — the writer
import { watchProxy } from '@frontierjs/mesa/runtime'
import { page } from './state.js'

const _page = watchProxy(page)          // same instance components get
_page.path = '/leads/'                   // fires watchers on .path only
```

```svelte
<!-- a component -->
<script>
  import { page } from '@frontierjs/sierra/router'
  $: page.path
</script>
<p>{page.path}</p>
```

~~Exporting the proxy **does not work**.~~ **FIXED** — `watchProxy` is now
idempotent and `watchPath` normalizes a proxy argument to its root, so both
shapes work:

```js
export const page = watchProxy(_page)   // exporting the proxy: fine
export const page = _page               // exporting raw, writer proxies: fine
```

Previously `watchProxy(alreadyProxy)` built a second layer, and `watchPath` then
keyed the signal by the proxy while the inner set trap fired signals keyed by
the raw object. They never met and nothing re-rendered, silently.

---

## What Sierra becomes

Eleven exported signals collapse into three plain objects:

```js
// router/state.js
export const page = {
  path: '/', params: {}, meta: {}, route: null,
  data: null, error: null, pending: null, slots: {},
}

// junction/state.js
export const junction = { connected: false, reconnecting: null }

// theme/state.js
export const ui = { theme: 'light' }
```

Consumers opt in per file:

```svelte
$: page.path            // just the path
$: (page.data, page.error)   // both
$: junction.connected
$: page                 // whole object — any change
```

Deletions this enables:

- **`externalSignals` entirely.** The compiler no longer needs to know anything
  about Sierra. That map, its drift, and `sierra/tests/external-signals.test.js`
  all go away.
- **`router/signals.js`** — already a thin wrapper; becomes nothing.
- The `.get()` call convention at every read site.

---

## What gets better, concretely

**Reactivity becomes visible at the use site.** `$: page.path` is in the file
you're reading. Today, whether `{page.path}` is live depends on a list in
another package's build plugin. That was my answer when you asked how hard
`.mesa` files are to reason about, and this removes the specific complaint.

**Updates get surgical.** Today `params.set({...})` allocates a new object and
invalidates every consumer of `params`. Under path watching, a component that
declared `$: page.params.id` doesn't re-render when `page.params.q` changes.
That's a real reduction in work per navigation, not just tidier syntax.

**The producing module stays plain JavaScript.** `state.js` has no Mesa import
at all. Only the writer does.

---

## What gets worse, honestly

**A raw write silently does nothing.** If any code path mutates `page.path`
without going through `watchProxy`, no watcher fires. This is a new silent
failure — but it's localised to the *producing* package, where one module owns
all writes, instead of being spread across every consuming app. That's a much
smaller surface.

~~**Forgetting `$:` is still a silent failure.**~~ **Partly closed** — the
compiler now reports it. Two levels:

- **default** — the file already watches something on that import, so the intent
  is clearly reactive and an uncovered path is an oversight. 0 false positives
  across 36 real components.
- **`externalReactivityHints: 'strict'`** — any uncovered member read on an
  imported object. Opt-in, because a plain config object and a mutable store are
  indistinguishable. This is the mode to turn on *during* the migration: it lists
  every read that will need a `$:`.

The path tier defers to `externalSignals`, so it stays quiet for names that are
still signals. That means you can enable strict mode before migrating anything
and it will only report reads that are genuinely inert today.

**`$:` gets more load.** It already has six documented modes, and
`../PROJECT_STATE.md` flags `$: (a, b)` vs `$: { (a, b) }` as unresolved. This
makes `$:` the *only* way to consume framework state, so that ambiguity stops
being academic.

**Path watching is a no-op on the server.** `watchProxy` returns the object
unchanged when `!_isBrowser` (Rule 19). Fine for a client router; needs thought
before SSR.

**A watch declared anywhere applies to everyone.** The registry is keyed by the
watched object and lives for the process, so watches are a property of the
object rather than of the declaring component (RULE 47). If one component
declares `$: page`, every other component's reads of `page.*` are covered by
that watch and re-render on any write to `page` — including components that
declared nothing. A finer watch declared elsewhere works the same way: it
becomes the nearest cover for other components' reads beneath it.

This cuts against "reactivity becomes visible at the use site" above, and it is
worth being honest that the property is not fully bought. It is always
fail-safe — the failure mode is an extra render, never a stale one — and it
follows from `$: page` meaning "this object is deeply reactive", which is a
statement about the object. Accepted for now; revisit if over-rendering shows up
in practice. The fix, if it is ever needed, is to scope the registry per
component instance rather than per object.

**No null-able top-level values.** `data` can't be a bare export that's
sometimes null — it has to be a field on a container. In practice that's an
improvement (one `page` object rather than eight loose signals), but it is an
API change for every consumer.

---

## On the global registry idea

A registry in the root `App.mesa` — declare once which imported objects are
reactive — would work, but I'd argue against it. It reintroduces exactly the
problem `externalSignals` has: a list, maintained by hand, physically distant
from both the declaration and the use. It moves drift from package scope to app
scope rather than removing it.

`$:` per file is more verbose and strictly better: it can't drift, because it
sits next to the code that depends on it.

The one thing a registry buys is not repeating `$: page.path` in twenty
components. If that's the real motivation, the cheaper answer is a shared
layout that watches once and passes values down as props — which is normal
component design rather than new machinery.

---

## Recommendation

Do it, in this order:

1. ~~Guard `watchProxy` against double-proxying.~~ **Done.**
2. ~~Extend the diagnostic to cover `x.y` reads with no matching `$:`.~~
   **Done** — default and `strict` tiers.
3. **Migrate one Sierra module** — `junction` is the smallest, two fields — and
   run it against the fullstack smoke test.
4. **Then the router**, which is the real work: eight signals into one `page`
   object, and every consuming template gains a `$:` line.
5. **Delete `externalSignals`** once nothing depends on it.

Steps 1 and 2 are done and stand on their own regardless of whether the rest
happens. Step 3 is the next decision.

To see what the migration would involve, turn strict mode on before changing
anything — it reports nothing today (every current read is a declared signal),
and will start reporting exactly as each module is converted.
