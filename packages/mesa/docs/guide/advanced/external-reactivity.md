# External reactivity

You need this page when a component reads state that lives outside it (an
imported object, a store module, a value from another package) and the screen
does not update, with no error.

The module is plain JavaScript that writes through a proxy:

```js
// room.js
import { watchProxy } from '@frontierjs/mesa/runtime'

export const room = { name: 'Lobby', members: [] }
const live = watchProxy(room)           // one shared proxy per object

export function rename(name) {
  live.name = name                      // notifies every `$: room.name`
}
```

The component names the paths it depends on:

```mesa
<script>
  import { room, rename } from './room.js'

  $: room.name
  $: room.members
</script>

<h1>{room.name}</h1>
<p>{room.members.length} here</p>
<button onclick={() => rename('Lounge')}>Rename</button>
```

## The rule

An imported identifier is opaque: the compiler never compiled the module, so it
cannot know the value changes. You tell it, per component, with a `$:` path
watch. That is the same `let` / `const` / `var` choice you make for local state,
made at the place you use the value.

- **`$: room.name`** watches a path. The template and any `const` that reads it
  update.
- **`var name = room.name`** is a deliberate snapshot of data nothing writes.
- **A bare read with no watch** is the failure case, below.

## Writes must go through the proxy

`watchProxy(obj)` is cached per object, so every component and your module share
one proxy, and a write through it fires exactly the paths that are watched.
Exporting the raw object or the proxy both work. A module that mutates the raw
object fires nothing, silently.

A watch also reaches only a component that reads through the proxy. A component
with no `$:` on the import reads the raw object and is never updated, no matter
who else watches it.

## The failure you will hit

A read with no watch is not a broken read. It is a static one. The compiler
hoists the expression out of the render block, assigns it once at mount, and
never touches it again. It looks like working code that is stuck.

The compiler warns when it can see this:

```
'room.name' is read in the template but no '$: room.name' watch covers it.
Imported objects are inert — the read compiles to a static value and will not
update when 'room' mutates. Add '$: room.name' to the script block, or read it
once into a `var` and render that if it never changes while this component
lives.
```

By default the warning fires when the same file already watches another path on
that import. A component that watches nothing on the import gets no warning
unless the build passes `externalReactivityHints: 'strict'`, which grades every
uncovered member read. Turn it on in an app where all shared state is plain
objects. The warning is about a browser that re-renders, so a static build can
filter it out.

## Imported signals

If a third-party package exports a Mesa signal (an object you read with
`.get()`), list it in the compiler's `externalSignals` option:

```js
{ externalSignals: { './ws.js': ['connected'] } }
```

Then `{connected ? 'on' : 'off'}` in a template is rewritten to `.get()` and
tracks. Only template expressions are rewritten. In `<script>` you call
`.get()` yourself. A namespace import (`j.connected`), a re-export through a
barrel file, and a name left off the list are not rewritten and fail silently.

## On the server

Path watching is inert during a server render. `watchProxy` returns the object
unchanged, so `{room.name}` reads the current value and is simply not reactive,
which is all a one-shot render needs.

---

Spec: [EXTERNAL_REACTIVITY.md](../../EXTERNAL_REACTIVITY.md) · [VISION.md § 5](../../VISION.md#5-shared-state--plain-javascript-modules) · RULE 8 · RULE 45 · RULE 47
