---
id: html-over-the-wire
status: idea
dated: 2026-08-12
---

# Idea — HTML over the wire: pre-rendered markup as a push payload

**Status: IDEA. Nothing here is built.** Dated 2026-08-12. Every measurement below
was taken by running the code on that tree, not read off a doc; the one claim that
decides whether this is cheap — **scope-hash parity between the two compilers** —
was verified by compiling the same source through both and comparing. See
`VERIFYING.md`.

---

## Trigger

*HTML over WebSockets: real-time SPAs with barely any JavaScript*
(`en.andros.dev/blog/ef4968f5/`), and behind it Phoenix LiveView, Django LiveView,
Blazor Interactive Server and Livewire 3. The shared claim: **the server sends HTML
already built and the client only places it**, so one rendering engine serves both
sides and there is no API contract to keep.

## Two things wearing one name

The article describes both and does not separate them. The separation is the whole
decision:

| | what travels | who holds state | cost here |
| --- | --- | --- | --- |
| **Fragment push** | a rendered chunk, server-initiated | nobody — it is a broadcast | days |
| **Server-held components** | a diff against a live server-side tree | a process per socket | a second UI realm |

**Only the first is proposed.** The second is refused, and the reasons are recorded
at the bottom of this file so nobody has to re-derive them.

## Where FJS stands — measured

**The transport is finished and needs no change at all.** `app.channel(name).send(event, data)`
already encodes an `{type:'event', event, data}` frame
(`junction/src/transport/channels.ts:136`, `:215`, `:439`), every send goes through
the one owner that survives backpressure (`transport/send-queue.ts`), and the browser
client already re-emits any such frame to a listener
(`junction/src/client/index.ts:751`). A server pushing markup today is one line and
no framework edit:

```js
app.channel('orders').send('fragment', { target: '#order-list', html })
```

Unknown frame *types* are silently dropped by the message handler
(`channels.ts:514-684`), so claiming a new `type` costs a change on both sides;
riding the existing `event` frame costs nothing. That is a ruling to make, not work
to do.

**The renderer exists too.** `renderComponent(source, { target })` compiles a Mesa
component tree and returns HTML (`mesa/src/render-component.js:594`).

**Measured on a 20-row list component, this tree, Bun 1.3.11:**

| target | first call | steady state |
| --- | --- | --- |
| `html` | 46.9ms | **6.4ms** |
| `fragment` | 13.7ms | 11.4ms |

Fast enough for a broadcast, and that is *without* a compile cache — every call
compiles the tree, writes a temp module, dynamic-imports it and unlinks it
(`render-component.js:327`, `:742`).

### The fact that makes this cheap here

Both compilers gave the same source the scope id **`m1di6wpot3s`** — the server
render emitted `class="list m1di6wpot3s"` and the client compiler's CSS record
carried `.list.m1di6wpot3s`. Scope ids are content-addressed (Invariant 12), so
**a fragment rendered on the server matches the CSS the page already loaded, and no
styling need travel with the markup.** In a framework whose server renderer and
client compiler are different programs, that is the expensive part; here it fell
out of a decision already made for build-time dedupe.

## What is actually missing — three things, in cost order

**1. A live-page fragment shape.** `target: 'fragment'` is the *email* shape: it
descopes and inlines every declaration into `style=""`, which flattens custom
properties. Measured: `.item { color: var(--fg) }` rendered as `style="color:"` —
the token is gone and the element is unstyled. `target: 'html'` keeps the scoped
classes, which is right, but prepends a `<style>` block on every render, which would
ship the same rules on every push. The wanted shape is the third: **scoped classes,
no style block, no document wrapper.** A render option, not a compiler rewrite.

**2. A compile cache.** 6.4ms is acceptable for a broadcast and wasteful per event,
and each render touches the filesystem twice for a module that never changes. The
pieces are already there — `target: 'js'` with `noEmit: true` keeps the compiled
modules in memory rather than on disk (`render-component.js:639`).

**3. A client shim, roughly thirty lines.** Listen on the existing `event` frame,
resolve `target`, apply `mode`. No morph library exists in the repo today (grepped:
no `idiomorph`, no `morphdom`, no `outerHTML =`), so the first version is
replace/append/prepend and morphing is the follow-up that buys back scroll position
and focus.

## The rule this needs before it ships

**A rendered string cannot be filtered per subscriber.** The fragment is rendered
server-side from data the server read, so `@@gate` and `@@allow` apply normally at
the Data boundary — that half is free. But a broadcast fans **one** rendered HTML
string out to every socket on the channel, and where `live-queries.md` (4.6) can
withhold a row or strip a `@guarded` column per subscriber, there is nothing to
strip once the row is markup.

So the declaration has to say which of two things a fragment channel is:

- **uniform** — every subscriber is entitled to identical markup, rendered once; or
- **per-socket** — rendered once per subscriber at their own level, which costs
  6.4ms × subscribers and must be opted into knowingly.

Fail closed on the missing answer. This is the same comparison `static-safety.md`
(4.4 / `FJS-081`) makes one axis over — *is this data publishable to this audience*
— and the two should report through one surface rather than two.

## What it must not become

**Not a second UI realm.** The Resource stays the UI-realm noun (Invariants 18–19)
and `createResource` stays how a page gets data. This is a push channel for markup a
server already knows how to render — for the cases where a client-side resource is
overkill: a toast, a badge count, a row appended to a table, an activity feed.
Where a page needs a client-side model of its data, it still has one.

If it starts absorbing forms, it has become the refused thing.

## Effort

`S`. A demo is one or two days — the transport needs nothing and the render exists.
The shippable version is the three items above plus the uniform/per-socket ruling.
Sequence: ruling → render shape → shim → cache. The cache is last because 6.4ms is
already inside budget for the only use this file proposes.

---

## Refused: server-held components (LiveView proper)

Ruled out 2026-08-12 rather than deferred. Recorded here because no `FJS-D##` was
open for it; promote to `DECISIONS.md` if it is ever reopened.

Mesa's server renderer is built to be the opposite of what this needs, deliberately
and in three separate places:

- **The render window is process-global and renders are serial by construction**
  (`mesa/src/render.js:33`). LiveView wants N live component trees, one per socket,
  concurrent.
- **Reactivity is inert on the server** — `$onMount`, `watchProxy` and path watches
  do not run (RULE 19, `render.js:29`). Server-held components need exactly those
  alive.
- **The root is disposed when the render returns.** There is no instance to hold.

On top of that: a second compile target to emit server-bound event handlers, a
static/dynamic template split so a diff sends slots rather than markup, a per-socket
process with reconnect and rehydrate, and shared state before it scales past one
machine. Each is real work; together they are a substrate, not a feature.

The larger cost is not the code. FJS already answers *where does UI state live* —
signals in the browser, data through a Resource, access declared in the seed. A
server-held component tree is a **second answer to the same question**, which means
two form stories, two validation stories and two hazard lists in `CLAUDE.md`. The
framework's claim is one mental model; this would be the first thing to break it.
